#!/usr/bin/env node
/**
 * Hermes Fleet Commander — daemon entry point (the permanent tool).
 *
 * Boots the real local-tmux control plane against the live hermes-main session
 * on this VPS and serves the REST + WebSocket + SSE API. SAFETY BY DEFAULT:
 *   - observation/dispatch only; the daemon never writes to a pane unless an
 *     operator explicitly dispatches a goal (POST /tasks or /agents/:id/goal)
 *     or enables --allow-nudge.
 *   - window 0 (the main hermes chat) and any listed protected pane are NEVER
 *     auto-touched. Goals to protected panes are rejected with 403.
 *
 * Env (all optional, sensible defaults for this VPS):
 *   FLEET_SOCKET       tmux socket            (default /home/ubuntu/.hermes/tmux/hermes-main.sock)
 *   FLEET_PORT         HTTP/WS/SSE port       (default 8787)
 *   FLEET_HOST         bind host              (default 127.0.0.1 — local only)
 *   FLEET_JOURNAL      sqlite path            (default /home/ubuntu/.hermes/fleet-ctrl/journal.db)
 *   FLEET_POLL_MS      poll interval          (default 5000)
 *   FLEET_STUCK_MS     STUCK threshold        (default 600000 = 10 min)
 *   FLEET_ALLOW_NUDGE  1 to enable safe nudges (default 0 — monitoring only)
 *   FLEET_PROTECTED    comma list of pane targets to protect (added to window 0)
 *   FLEET_AGENT_PATTERN regex to detect hermes panes (default 'hermes')
 *   FLEET_MAX_RESTARTS        nudge budget per rolling window (default 3)
 *   FLEET_RESTART_WINDOW_MS   rolling window for the nudge budget / auto-close (default 3600000 = 1h)
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRealControlPlane } from './real-fleet.js';
import type { RealFleetConfig } from './real-fleet.js';

function envInt(name: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const v = env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}
function envBool(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return env[name] === '1' || env[name]?.toLowerCase() === 'true';
}

export const DEFAULTS = {
  socket: '/home/ubuntu/.hermes/tmux/hermes-main.sock',
  port: 8787,
  host: '127.0.0.1',
  journalPath: '/home/ubuntu/.hermes/fleet-ctrl/journal.db',
  pollMs: 5000,
  stuckMs: 10 * 60 * 1000,
  maxRestartsPerWindow: 3,
  restartWindowMs: 60 * 60 * 1000,
} as const;

/**
 * Resolve the daemon config from `process.env` + defaults. Pure-ish (no I/O);
 * extracted so the env wiring can be unit-tested without booting the daemon.
 */
export interface ResolvedFleetConfig extends RealFleetConfig {
  socket: string;
  journalPath: string;
  stuckAfterMs: number;
  maxRestartsPerWindow: number;
  restartWindowMs: number;
}

export function resolveFleetConfig(env: NodeJS.ProcessEnv = process.env): ResolvedFleetConfig {
  const socket = env.FLEET_SOCKET ?? DEFAULTS.socket;
  const journalPath = env.FLEET_JOURNAL ?? DEFAULTS.journalPath;
  const protectedPanes = (env.FLEET_PROTECTED ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const agentPattern = env.FLEET_AGENT_PATTERN; // undefined => default 'hermes'

  const config: ResolvedFleetConfig = {
    socket,
    journalPath,
    stuckAfterMs: envInt('FLEET_STUCK_MS', DEFAULTS.stuckMs, env),
    allowNudge: envBool('FLEET_ALLOW_NUDGE', env),
    maxRestartsPerWindow: envInt('FLEET_MAX_RESTARTS', DEFAULTS.maxRestartsPerWindow, env),
    restartWindowMs: envInt('FLEET_RESTART_WINDOW_MS', DEFAULTS.restartWindowMs, env),
  };
  if (protectedPanes.length) config.protectedPanes = protectedPanes;
  if (agentPattern !== undefined) config.agentPattern = agentPattern;
  return config;
}

async function main(): Promise<void> {
  const port = envInt('FLEET_PORT', DEFAULTS.port);
  const host = process.env.FLEET_HOST ?? DEFAULTS.host;
  const pollMs = envInt('FLEET_POLL_MS', DEFAULTS.pollMs);
  const config = resolveFleetConfig();
  const { socket, journalPath, stuckAfterMs, maxRestartsPerWindow, restartWindowMs, allowNudge } = config;

  mkdirSync(dirname(journalPath), { recursive: true });

  const { app, fleet, real } = await createRealControlPlane(config, { pollIntervalMs: pollMs });

  const banner = [
    '╔══════════════════════════════════════════════════════════════╗',
    '║         HERMES FLEET COMMANDER — control-plane daemon         ║',
    '╠══════════════════════════════════════════════════════════════╣',
    `║ socket         : ${socket.padEnd(44)}║`,
    `║ bind           : ${`${host}:${port}`.padEnd(44)}║`,
    `║ poll interval  : ${`${pollMs}ms`.padEnd(44)}║`,
    `║ STUCK after    : ${`${Math.round(stuckAfterMs / 1000)}s`.padEnd(44)}║`,
    `║ restart budget : ${`${maxRestartsPerWindow} / ${Math.round(restartWindowMs / 1000)}s`.padEnd(44)}║`,
    `║ auto-nudge     : ${(allowNudge ? 'ENABLED (safe paste-buffer)' : 'DISABLED (monitor only)').padEnd(44)}║`,
    `║ discovered     : ${`${real.discovered.length} panes`.padEnd(44)}║`,
    `║ protected      : ${(real.protectedIds.size + ' (incl. window 0)').padEnd(44)}║`,
    '║                                                              ║',
    '║ SAFETY: window 0 + protected panes are NEVER auto-written.    ║',
    '║ Dispatch a goal only via POST /tasks (operator action).       ║',
    '╚══════════════════════════════════════════════════════════════╝',
  ].join('\n');
  // eslint-disable-next-line no-console
  console.log(banner);

  await app.listen({ port, host });
  // eslint-disable-next-line no-console
  console.log(`Fleet control plane listening on http://${host}:${port}`);
  // eslint-disable-next-line no-console
  console.log(`  REST  : /agents /tasks /journal/audit  |  WS: /stream  |  SSE: /stream/sse`);

  const shutdown = () => {
    // eslint-disable-next-line no-console
    console.log('\nShutting down fleet commander...');
    fleet.stop();
    void app.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fleet commander failed to start:', err);
  process.exit(1);
});
