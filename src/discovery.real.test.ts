import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { discoverAgents } from './discovery.js';

const REAL_SOCKET = '/home/ubuntu/.hermes/tmux/hermes-main.sock';

// This test talks to the REAL running hermes-main tmux server (read-only
// list-panes). It is safe: it never writes, never sends keys, never kills.
// It is skipped automatically when the socket is absent (e.g. in CI).
const describeReal = existsSync(REAL_SOCKET) ? describe : describe.skip;

describeReal('discovery against the real hermes-main tmux server (read-only)', () => {
  it('finds the worker agents and protects window 0 (the main session)', async () => {
    const agents = await discoverAgents({ socket: REAL_SOCKET });
    // We expect the 6 worker agents (agent-1..agent-6) to be discovered.
    const ids = agents.map((a) => a.agentId).sort();
    for (const n of ['agent-1', 'agent-2', 'agent-3', 'agent-4', 'agent-5', 'agent-6']) {
      expect(ids, `expected discovered agents: ${ids.join(', ')}`).toContain(n);
    }
    // Window 0 (main hermes chat) must be flagged protected and never become a
    // dispatch target.
    const main = agents.filter((a) => a.windowIndex === 0);
    expect(main.length).toBeGreaterThan(0);
    expect(main.every((a) => a.protected)).toBe(true);
    // Worker panes (window 1) are NOT protected by default.
    const workers = agents.filter((a) => a.windowIndex === 1);
    expect(workers.length).toBe(6);
    expect(workers.every((a) => !a.protected)).toBe(true);
    // Every discovered agent has a usable target + session.
    expect(agents.every((a) => a.target && a.session)).toBe(true);
  }, 15_000);
});
