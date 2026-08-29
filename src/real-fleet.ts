/**
 * Real-fleet assembly for "Hermes Fleet Commander".
 *
 * Wires the LOCAL tmux transport + discovery into the FleetControl orchestrator
 * and the Fastify control plane, for deployment against the live hermes-main
 * session on this VPS.
 *
 * Safety model (the daemon is the permanent tool, so this is the contract):
 *  - DISPATCH is safe: goals go to panes via load-buffer + paste-buffer (the
 *    GoalInjector), never send-keys / Ctrl-C.
 *  - WINDOW 0 (the main hermes chat) and any caller-marked pane are PROTECTED:
 *    they are monitored and classified, but never auto-nudged and never accept a
 *    dispatched goal. `POST /agents/:id/goal` for a protected pane returns 403.
 *  - "AUTO-RECOVER" is a nudge only. Each worker is already supervised by
 *    worker-wrapper.sh (while-true restart loop), so the daemon must NOT spawn or
 *    kill processes — that would fight the supervisor. When the Guardian flags a
 *    pane STUCK and the restart budget allows, the daemon pastes a gentle
 *    "still there? continue" nudge into the pane. The 3/hr circuit breaker stops
 *    the daemon from nag-spamming a genuinely wedged agent.
 */

import { EventJournal } from './storage/db.js';
import { FleetControl } from './server/fleet-control.js';
import { createControlPlane } from './server/control-plane.js';
import { createLocalTmux, type LocalTmuxOptions } from './driver/local-tmux.js';
import { discoverAgents, type DiscoveredAgent, type DiscoverOptions } from './discovery.js';
import type { FastifyInstance } from 'fastify';

export interface RealFleetConfig {
  socket: string;
  /** Default STUCK threshold (ms). A pane with no new output for this long -> STUCK. */
  stuckAfterMs?: number;
  /** Max auto-nudges per rolling window per pane. */
  maxRestartsPerWindow?: number;
  /** Rolling window length (ms) for the nudge budget. */
  restartWindowMs?: number;
  /** Panes (tmux targets) that must never be nudged/dispatched. Window 0 is always protected. */
  protectedPanes?: string[];
  /** Extra tmux argv (e.g. '-L' name). */
  extraTmuxArgs?: string[];
  /** Regex (string) to detect hermes panes in list-panes. '' = all panes. */
  agentPattern?: string;
  /** nudge text pasted when a pane is flagged STUCK (safe, no control chars). */
  nudgeText?: string;
  /** When false (default), never paste a nudge — monitoring/dispatch only. */
  allowNudge?: boolean;
  journalPath?: string;
  now?: () => number;
}

export interface RealFleet {
  fleet: FleetControl;
  journal: EventJournal;
  discovered: DiscoveredAgent[];
  protectedIds: Set<string>;
  transport: ReturnType<typeof createLocalTmux>;
}

const DEFAULT_NUDGE = 'Are you still working? If you are stuck or waiting, please continue or report the blocker.';

export async function bootRealFleet(config: RealFleetConfig): Promise<RealFleet> {
  const tmuxOpts: LocalTmuxOptions = { socket: config.socket };
  if (config.extraTmuxArgs) tmuxOpts.extraArgs = config.extraTmuxArgs;

  const discoverOpts: DiscoverOptions = { socket: config.socket };
  if (config.extraTmuxArgs) discoverOpts.extraArgs = config.extraTmuxArgs;
  if (config.protectedPanes) discoverOpts.protectedPanes = config.protectedPanes;
  if (config.agentPattern !== undefined) discoverOpts.agentPattern = config.agentPattern;
  const discovered = await discoverAgents(discoverOpts);

  const agents: Record<string, { host: string; pane: string }> = {};
  const protectedIds = new Set<string>();
  for (const a of discovered) {
    agents[a.agentId] = { host: a.session, pane: a.target };
    if (a.protected) protectedIds.add(a.agentId);
  }

  const journal = new EventJournal(config.journalPath ? { path: config.journalPath } : {});
  const transport = createLocalTmux(tmuxOpts);

  const fleetOptions: {
    stuckAfterMs: number;
    slots: number;
    maxRestartsPerWindow: number;
    restartWindowMs: number;
    allowNudge: boolean;
    nudgeText: string;
    protectedIds: Set<string>;
    now?: () => number;
  } = {
    stuckAfterMs: config.stuckAfterMs ?? 10 * 60 * 1000,
    slots: Math.max(1, discovered.length),
    maxRestartsPerWindow: config.maxRestartsPerWindow ?? 3,
    restartWindowMs: config.restartWindowMs ?? 60 * 60 * 1000,
    allowNudge: config.allowNudge ?? false,
    nudgeText: config.nudgeText ?? DEFAULT_NUDGE,
    protectedIds,
  };
  if (config.now) fleetOptions.now = config.now;

  const fleet = new FleetControl(transport, journal, agents, fleetOptions);

  return { fleet, journal, discovered, protectedIds, transport };
}

export async function createRealControlPlane(
  config: RealFleetConfig,
  opts: { pollIntervalMs?: number } = {},
): Promise<{ app: FastifyInstance; fleet: FleetControl; real: RealFleet }> {
  const real = await bootRealFleet(config);
  const app = await createControlPlane(real.fleet, opts);
  return { app, fleet: real.fleet, real };
}
