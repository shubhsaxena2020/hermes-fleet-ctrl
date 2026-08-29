/**
 * hermes-fleet-ctrl — entry point.
 *
 * Boots the full control plane: a TmuxPool (or mock transport), an append-only
 * EventJournal, the FleetControl orchestrator, and either the blessed TUI (when
 * attached to a TTY) or the Fastify + WebSocket control-plane server (default,
 * or via `MODE=server`).
 *
 * The assembly is factored into `bootFleet(config)` so it can be unit-tested and
 * so callers (TUI, server, tests) share one wiring path.
 */

import { EventJournal } from './storage/db.js';
import { TmuxPool } from './driver/tmux-pool.js';
import { FleetControl } from './server/fleet-control.js';
import { createControlPlane } from './server/control-plane.js';
import { FleetTui } from './tui/app.js';
import type { TmuxTransport } from './driver/types.js';
import type { HostConfig } from './driver/types.js';

export const APP_NAME = 'hermes-fleet-ctrl' as const;
export const APP_VERSION = '0.1.0' as const;

export interface AgentSpec {
  agentId: string;
  host: string;
  pane: string;
}

export interface BootConfig {
  agents: AgentSpec[];
  hosts?: HostConfig[];
  /** Provide a transport directly (tests / mock). Overrides `hosts`. */
  transport?: TmuxTransport;
  journalPath?: string;
  stuckAfterMs?: number;
  slots?: number;
  maxRestartsPerWindow?: number;
  restartWindowMs?: number;
  now?: () => number;
}

/** Assemble the full fleet stack. Pure-ish: no sockets/terminals opened here. */
export function bootFleet(config: BootConfig): { fleet: FleetControl; journal: EventJournal; transport: TmuxTransport } {
  const journal = new EventJournal(config.journalPath ? { path: config.journalPath } : {});
  let transport: TmuxTransport;
  if (config.transport) {
    transport = config.transport;
  } else if (config.hosts && config.hosts.length > 0) {
    const pool = new TmuxPool();
    for (const h of config.hosts) pool.addHost(h);
    transport = pool;
  } else {
    throw new Error('bootFleet requires either config.transport or config.hosts');
  }

  const agents: Record<string, { host: string; pane: string }> = {};
  for (const a of config.agents) agents[a.agentId] = { host: a.host, pane: a.pane };

  const fleetOpts: {
    stuckAfterMs: number;
    slots: number;
    maxRestartsPerWindow: number;
    restartWindowMs: number;
    now?: () => number;
  } = {
    stuckAfterMs: config.stuckAfterMs ?? 10 * 60 * 1000,
    slots: config.slots ?? 7,
    maxRestartsPerWindow: config.maxRestartsPerWindow ?? 3,
    restartWindowMs: config.restartWindowMs ?? 60 * 60 * 1000,
  };
  if (config.now) fleetOpts.now = config.now;

  const fleet = new FleetControl(transport, journal, agents, fleetOpts);
  return { fleet, journal, transport };
}

export interface StartOptions {
  mode?: 'tui' | 'server';
  port?: number;
  pollIntervalMs?: number;
}

/** Start the control plane in the requested mode (opens sockets / terminal). */
export async function start(config: BootConfig, opts: StartOptions = {}): Promise<{ fleet: FleetControl; close: () => void }> {
  const { fleet } = bootFleet(config);
  const mode = opts.mode ?? (process.stdout.isTTY ? 'tui' : 'server');

  if (mode === 'tui') {
    const tui = new FleetTui(fleet);
    tui.bind();
    tui.mount();
    return {
      fleet,
      close: () => {
        fleet.stop();
      },
    };
  }

  const app = await createControlPlane(fleet, { pollIntervalMs: opts.pollIntervalMs ?? 5000 });
  await app.listen({ port: opts.port ?? 8787, host: '0.0.0.0' });
  // eslint-disable-next-line no-console
  console.info(`[${APP_NAME}] control-plane listening on :${opts.port ?? 8787}`);
  return {
    fleet,
    close: () => {
      void app.close();
      fleet.stop();
    },
  };
}

export function main(): void {
  // eslint-disable-next-line no-console
  console.info(`[${APP_NAME}] v${APP_VERSION}`);
  // In a real deployment this would parse a config file / env and call start().
  // The library entry points (bootFleet/start) are the programmatic API.
}

// Run only when executed directly (NodeNext ESM equivalent of require.main === module).
const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main();
}
