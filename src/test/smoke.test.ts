import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import { AddressInfo } from 'node:net';
import { EventJournal } from '../storage/db.js';
import { FleetControl, type FleetEvent } from '../server/fleet-control.js';
import { createControlPlane } from '../server/control-plane.js';
import type { TmuxTransport, ExecResult } from '../driver/types.js';
import type { FastifyInstance } from 'fastify';

/**
 * Mock-fleet transport for the smoke pass (T16): deterministic, no real tmux.
 * Key scheme: `${host}|${pane}` matches FleetControl's capturePane calls.
 */
class MockTmuxTransport implements TmuxTransport {
  private screens = new Map<string, string>();
  setScreen(h: string, p: string, t: string): void { this.screens.set(h + '|' + p, t); }
  private get(h: string, p: string): string { return this.screens.get(h + '|' + p) ?? ''; }
  exec(h: string, c: string): Promise<ExecResult> {
    const m = c.match(/^tmux paste-buffer -t (.+)$/);
    if (m) { const pane = m[1]!; this.screens.set(h + '|' + pane, this.get(h, pane) + '\n'); }
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  }
  execWithStdin(h: string, c: string, i?: string): Promise<ExecResult> { void h; void c; void i; return Promise.resolve({ code: 0, stdout: '', stderr: '' }); }
  capturePane(h: string, t: string): Promise<string> { return Promise.resolve(this.get(h, t)); }
}

function makeFleet(now: () => number): { fleet: FleetControl; transport: MockTmuxTransport } {
  const transport = new MockTmuxTransport();
  const journal = new EventJournal();
  const fleet = new FleetControl(
    transport,
    journal,
    { 'agent-1': { host: 'agent-1', pane: '0.0' }, 'agent-2': { host: 'agent-2', pane: '0.0' } },
    { stuckAfterMs: 1000, maxRestartsPerWindow: 3, restartWindowMs: 60 * 60 * 1000, slots: 7, now },
  );
  return { fleet, transport };
}

describe('Smoke pass — UI / API / event feed consistency (T16)', () => {
  let app: FastifyInstance;
  let base: string;
  let fleet: FleetControl;
  let transport: MockTmuxTransport;
  let clock = 1_000_000;

  beforeAll(async () => {
    const built = makeFleet(() => clock);
    fleet = built.fleet;
    transport = built.transport;
    transport.setScreen('agent-1', '0.0', '⠿ idle');
    transport.setScreen('agent-2', '0.0', '$ ');
    app = await createControlPlane(fleet, { pollIntervalMs: 0 });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address() as AddressInfo;
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => { await app.close(); });

  it('counts are consistent across /api/fleet and /agents and the live feed', async () => {
    clock += 10;
    await fleet.tick();
    transport.setScreen('agent-1', '0.0', '⠿ working ' + clock);
    clock += 10;
    await fleet.tick();

    const summary = (await (await fetch(`${base}/api/fleet`)).json()) as { ok: boolean; total: number; agents: Array<{ agentId: string }> };
    const agents = (await (await fetch(`${base}/agents`)).json()) as { agents: Array<{ agentId: string }> };
    const health = (await (await fetch(`${base}/health`)).json()) as { ok: boolean; agents: string[] };

    expect(summary.ok).toBe(true);
    expect(summary.total).toBe(2);
    expect(agents.agents.map((a) => a.agentId).sort()).toEqual(['agent-1', 'agent-2']);
    expect(health.agents.sort()).toEqual(['agent-1', 'agent-2']);
    expect(new Set([summary.total, agents.agents.length, health.agents.length]).size).toBe(1);

    // Live feed carries a snapshot event referencing both agents (no stale rows).
    const events: FleetEvent[] = [];
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`${base.replace('http', 'ws')}/stream`);
      ws.on('open', () => { void fleet.tick().then(() => setTimeout(() => { ws.close(); resolve(); }, 50)); });
      ws.on('message', (d: Buffer) => events.push(JSON.parse(d.toString()) as FleetEvent));
      ws.on('error', reject);
    });
    const snaps = events.filter((e) => e.type === 'snapshot');
    expect(snaps.length).toBeGreaterThan(0);
    const seen = new Set(snaps.map((e) => (e as { agentId: string }).agentId));
    expect(seen.has('agent-1')).toBe(true);
    expect(seen.has('agent-2')).toBe(true);
  });

  it('no stale entries after a simulated restart: breaker trip + drain clears cleanly (T16)', async () => {
    // Trip agent-1, then drain + heartbeat to auto-close; summary must reflect closed.
    transport.setScreen('agent-1', '0.0', '⠿ thinking');
    await fleet.tick();
    fleet.guardian.resetBreaker('agent-1');
    transport.setScreen('agent-1', '0.0', '⠿ wedged');
    for (let i = 0; i < 8; i++) {
      clock += 2000;
      await fleet.tick();
      transport.setScreen('agent-1', '0.0', '⠿ wedged');
      if (fleet.agentViews().find((v) => v.agentId === 'agent-1')!.breakerState === 'open') break;
    }
    // Drain + recover.
    clock += 60 * 60 * 1000 + 1000;
    transport.setScreen('agent-1', '0.0', '⠿ recovered output');
    await fleet.tick();

    const summary = (await (await fetch(`${base}/api/fleet`)).json()) as { byStatus: { breakerOpen: number } };
    expect(summary.byStatus.breakerOpen).toBe(0);
    expect(fleet.agentViews().find((v) => v.agentId === 'agent-1')!.breakerState).toBe('closed');
  });
});
