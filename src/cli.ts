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
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRealControlPlane } from './real-fleet.js';
import type { RealFleetConfig } from './real-fleet.js';

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}
function envBool(name: string): boolean {
  return process.env[name] === '1' || process.env[name]?.toLowerCase() === 'true';
}

async function main(): Promise<void> {
  const socket = process.env.FLEET_SOCKET ?? '/home/ubuntu/.hermes/tmux/hermes-main.sock';
  const port = envInt('FLEET_PORT', 8787);
  const host = process.env.FLEET_HOST ?? '127.0.0.1';
  const journalPath = process.env.FLEET_JOURNAL ?? '/home/ubuntu/.hermes/fleet-ctrl/journal.db';
  const pollMs = envInt('FLEET_POLL_MS', 5000);
  const stuckMs = envInt('FLEET_STUCK_MS', 10 * 60 * 1000);
  const allowNudge = envBool('FLEET_ALLOW_NUDGE');
  const protectedPanes = (process.env.FLEET_PROTECTED ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const agentPattern = process.env.FLEET_AGENT_PATTERN; // undefined => default 'hermes'

  mkdirSync(dirname(journalPath), { recursive: true });

  const config: RealFleetConfig = {
    socket,
    journalPath,
    stuckAfterMs: stuckMs,
    allowNudge,
  };
  if (protectedPanes.length) config.protectedPanes = protectedPanes;
  if (agentPattern !== undefined) config.agentPattern = agentPattern;

  const { app, fleet, real } = await createRealControlPlane(config, { pollIntervalMs: pollMs });

  const banner = [
    '╔══════════════════════════════════════════════════════════════╗',
    '║         HERMES FLEET COMMANDER — control-plane daemon         ║',
    '╠══════════════════════════════════════════════════════════════╣',
    `║ socket         : ${socket.padEnd(44)}║`,
    `║ bind           : ${`${host}:${port}`.padEnd(44)}║`,
    `║ poll interval  : ${`${pollMs}ms`.padEnd(44)}║`,
    `║ STUCK after    : ${`${Math.round(stuckMs / 1000)}s`.padEnd(44)}║`,
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
