import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import { AddressInfo } from 'node:net';
import { EventJournal } from '../storage/db.js';
import { FleetControl, type FleetEvent } from './fleet-control.js';
import { createControlPlane } from './control-plane.js';
import type { TmuxTransport, ExecResult } from '../driver/types.js';
import type { FastifyInstance } from 'fastify';

/**
 * A controllable fake tmux transport: each agent has a "screen" string we set
 * between ticks to simulate terminal output. load-buffer/paste-buffer record the
 * exact bytes injected so we can assert the control-plane dispatched goals.
 *
 * Key scheme: a pane is identified by `${host}|${pane}` throughout, matching how
 * FleetControl calls capturePane(host, pane) and the injector calls
 * execWithStdin(host, ...) + exec(host, `paste-buffer -t ${pane}`).
 */
class FakeFleetTransport implements TmuxTransport {
  private screens = new Map<string, string>();
  injected: Array<{ agentId: string; payload: string }> = [];
  private pending: string | null = null;

  setScreen(host: string, pane: string, text: string): void {
    this.screens.set(`${host}|${pane}`, text);
  }

  private getScreen(host: string, pane: string): string {
    return this.screens.get(`${host}|${pane}`) ?? '';
  }

  exec(host: string, command: string): Promise<ExecResult> {
    const m = command.match(/^tmux paste-buffer -t (.+)$/);
    if (m) {
      const pane = m[1]!;
      const cur = this.getScreen(host, pane);
      this.screens.set(`${host}|${pane}`, cur + (this.pending ?? '') + '\n');
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    }
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  }

  execWithStdin(host: string, command: string, input: string): Promise<ExecResult> {
    if (command.trim() === 'tmux load-buffer -') {
      this.pending = input;
      // recover agent id from the host passed by the injector
      this.injected.push({ agentId: host, payload: input });
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    }
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  }

  capturePane(host: string, target: string): Promise<string> {
    return Promise.resolve(this.getScreen(host, target));
  }
}

function makeFleet(transport: FakeFleetTransport, now: () => number) {
  const journal = new EventJournal(); // :memory:
  return new FleetControl(
    transport,
    journal,
    {
      'agent-1': { host: 'agent-1', pane: '0.0' },
      'agent-2': { host: 'agent-2', pane: '0.0' },
    },
    {
      stuckAfterMs: 1000,
      maxRestartsPerWindow: 3,
      restartWindowMs: 60 * 60 * 1000,
      slots: 7,
      now,
    },
  );
}

let clock = 1_000_000;
let fleet: FleetControl;
let transport: FakeFleetTransport;
let base: string;

describe('Control-plane integration (real Fastify + FleetControl, mock tmux)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    transport = new FakeFleetTransport();
    // agent-1 is actively thinking; agent-2 idle
    transport.setScreen('agent-1', '0.0', 'thinking about the task…');
    transport.setScreen('agent-2', '0.0', '$ ');
    fleet = makeFleet(transport, () => clock);
    app = await createControlPlane(fleet, { pollIntervalMs: 0 });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address() as AddressInfo;
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health reports agents and task count', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; agents: string[]; tasks: number };
    expect(body.ok).toBe(true);
    expect(body.agents.sort()).toEqual(['agent-1', 'agent-2']);
    expect(body.tasks).toBe(0);
  });

  it('GET /agents returns classified states after a tick', async () => {
    transport.setScreen('agent-1', '0.0', '⠿ reasoning about the diff…'); // thinking spinner
    clock += 10;
    await fleet.tick();
    const res = await fetch(`${base}/agents`);
    const body = (await res.json()) as { agents: Array<{ agentId: string; state: string }> };
    const a1 = body.agents.find((a) => a.agentId === 'agent-1');
    const a2 = body.agents.find((a) => a.agentId === 'agent-2');
    expect(a1?.state).toBe('ACTIVE_THINKING');
    expect(a2?.state).toBe('IDLE');
  });

  it('POST /tasks enqueues a goal; GET /tasks shows it; pump() dispatches it via inject', async () => {
    const res = await fetch(`${base}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'agent-1', prompt: 'deploy the canary', priority: 'HIGH' }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { taskId: string };
    expect(created.taskId).toBeTruthy();

    const listRes = await fetch(`${base}/tasks`);
    const list = (await listRes.json()) as { tasks: Array<{ taskId: string; state: string }> };
    expect(list.tasks.some((t) => t.taskId === created.taskId)).toBe(true);

    // Pump: the goal should be injected into agent-1's pane (load-buffer + paste).
    const dispatched = await fleet.pump();
    expect(dispatched).toBe(1);
    const inject = transport.injected.find((i) => i.agentId === 'agent-1');
    expect(inject).toBeTruthy();
    expect(inject!.payload).toContain('deploy the canary');

    // Task is now COMPLETED in the engine.
    const list2 = (await (await fetch(`${base}/tasks`)).json()) as {
      tasks: Array<{ taskId: string; state: string }>;
    };
    expect(list2.tasks.find((t) => t.taskId === created.taskId)?.state).toBe('COMPLETED');
  });

  it('POST /agents/:id/goal injects immediately', async () => {
    const res = await fetch(`${base}/agents/agent-2/goal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'run the tests' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(transport.injected.some((i) => i.agentId === 'agent-2' && i.payload.includes('run the tests'))).toBe(true);
  });

  it('GET /journal/audit returns append-only audit rows', async () => {
    const res = await fetch(`${base}/journal/audit?limit=10`);
    const body = (await res.json()) as { audit: Array<{ action: string }> };
    expect(body.audit.length).toBeGreaterThan(0);
    expect(body.audit.some((r) => r.action === 'enqueue_goal')).toBe(true);
  });

  it('WS /stream pushes FleetEvent snapshots to subscribers', async () => {
    const events: FleetEvent[] = [];
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`${base.replace('http', 'ws')}/stream`);
      ws.on('open', () => {
        // trigger a tick so a snapshot is broadcast
        void fleet.tick().then(() => {
          setTimeout(() => {
            ws.close();
            resolve();
          }, 50);
        });
      });
      ws.on('message', (data: Buffer) => {
        events.push(JSON.parse(data.toString()) as FleetEvent);
      });
      ws.on('error', reject);
    });
    expect(events.some((e) => e.type === 'snapshot')).toBe(true);
  });

  it('SSE /stream/sse delivers breaker open transitions live (T8)', async () => {
    const frames: FleetEvent[] = [];
    const res = await fetch(`${base}/stream/sse`);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const tickOnce = () => {
      clock += 2000;
      void fleet.tick();
    };

    // Trip the breaker on agent-1 (re-freeze the wedged screen each cycle).
    fleet.guardian.resetBreaker('agent-1');
    transport.setScreen('agent-1', '0.0', '⠿ wedged for SSE');
    const collect = async () => {
      for (let i = 0; i < 6; i++) {
        tickOnce();
        transport.setScreen('agent-1', '0.0', '⠿ wedged for SSE');
        // read any available chunks without blocking long
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        for (const line of buf.split('\n')) {
          const m = line.match(/^data: (.+)$/);
          if (m) frames.push(JSON.parse(m[1]!) as FleetEvent);
        }
        buf = buf.split('\n').pop() ?? '';
      }
    };
    await collect();
    await reader.cancel();

    // The live SSE feed must have carried the breaker_tripped transition.
    expect(frames.some((e) => e.type === 'guardian' && e.action === 'breaker_tripped')).toBe(true);
  });

  it('ticks detect STUCK then drive the guardian restart budget + breaker (circuit-breaker path)', async () => {
    // Freeze agent-1's screen while it is in a "thinking" (active) state so it
    // never produces new output; advance time past stuckAfterMs each tick.
    // We re-freeze after each tick because the auto-restart nudge would otherwise
    // mutate the pane (a real restart re-animates the agent; here we want to prove
    // the budget/breaker logic, so we keep the pane wedged).
    fleet.guardian.resetBreaker('agent-1');
    transport.setScreen('agent-1', '0.0', '⠿ stuck half-way through');
    const restarts: FleetEvent[] = [];
    fleet.on('guardian', (e: FleetEvent) => restarts.push(e));

    for (let i = 0; i < 5; i++) {
      clock += 2000; // exceed stuckAfterMs each cycle
      await fleet.tick(); // screen unchanged -> not "alive" -> STUCK
      transport.setScreen('agent-1', '0.0', '⠿ stuck half-way through');
    }
    const tripped = restarts.find((e) => e.type === 'guardian' && e.action === 'breaker_tripped');
    expect(tripped).toBeTruthy();
    // Exactly 3 restarts then the breaker; never a 4th.
    const restarted = restarts.filter((e) => e.type === 'guardian' && e.action === 'restarted');
    expect(restarted.length).toBe(3);
    expect(fleet.agentViews().find((a) => a.agentId === 'agent-1')?.breakerOpen).toBe(true);
  });
});

describe('Control-plane — defined REST status API (T7)', () => {
  let app2: FastifyInstance;
  let base2: string;

  beforeAll(async () => {
    // Spin up a dedicated server for the existing module-level `fleet` (the first
    // describe's server is closed in its own afterAll).
    app2 = await createControlPlane(fleet, { pollIntervalMs: 0 });
    await app2.listen({ port: 0, host: '127.0.0.1' });
    const addr = app2.server.address() as AddressInfo;
    base2 = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await app2.close();
  });

  it('GET /api/fleet returns a stable summary shape', async () => {
    const res = await fetch(`${base2}/api/fleet`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      generatedAt: number;
      total: number;
      byStatus: { ok: number; stuck: number; breakerOpen: number; protected: number };
      agents: Array<{ agentId: string; breakerState: 'open' | 'closed' }>;
    };
    expect(body.ok).toBe(true);
    expect(body.total).toBe(2);
    expect(body.byStatus).toBeDefined();
    // breakerState is now part of the per-agent detail shape.
    expect(body.agents[0]?.breakerState).toBeDefined();
  });

  it('GET /api/agents/:id returns 404 for unknown agent', async () => {
    const res = await fetch(`${base2}/api/agents/nope`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('unknown agent');
  });

  it('GET /api/agents/:id/history returns bounded metrics history', async () => {
    clock += 10;
    await fleet.tick(); // produces a metrics sample
    const res = await fetch(`${base2}/api/agents/agent-1/history?limit=10`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agentId: string; history: Array<{ agent_id: string }> };
    expect(body.agentId).toBe('agent-1');
    expect(Array.isArray(body.history)).toBe(true);
    expect(body.history.length).toBeGreaterThan(0);
  });

  it('GET /api/events returns durable breaker events', async () => {
    const res = await fetch(`${base2}/api/events?limit=50`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: Array<{ kind: string; agent_id: string }> };
    // agent-1 was tripped in the previous test, so at least one open event exists.
    expect(body.events.some((e) => e.kind === 'open' && e.agent_id === 'agent-1')).toBe(true);
  });

  it('empty-fleet endpoints still return valid shapes (no agents)', async () => {
    const empty = new FleetControl(new FakeFleetTransport(), new EventJournal(), {}, { stuckAfterMs: 1000, now: () => clock });
    const appEmpty = await createControlPlane(empty, { pollIntervalMs: 0 });
    await appEmpty.listen({ port: 0, host: '127.0.0.1' });
    const addr = appEmpty.server.address() as AddressInfo;
    const b3 = `http://127.0.0.1:${addr.port}`;
    const fleetRes = await fetch(`${b3}/api/fleet`);
    const fb = (await fleetRes.json()) as { total: number; byStatus: Record<string, number> };
    expect(fb.total).toBe(0);
    expect(fb.byStatus.breakerOpen).toBe(0);
    const evRes = await fetch(`${b3}/api/events`);
    const eb = (await evRes.json()) as { events: unknown[] };
    expect(eb.events).toEqual([]);
    await appEmpty.close();
  });

  it('data-driven alerts fire as live events when a breaker opens (T9)', async () => {
    const alerts: Array<{ agentId: string; severity: string; ruleId: string }> = [];
    fleet.on('alert', (e: FleetEvent) => {
      if (e.type === 'alert') alerts.push({ agentId: e.agentId, severity: e.severity, ruleId: e.ruleId });
    });
    fleet.guardian.resetBreaker('agent-1');
    transport.setScreen('agent-1', '0.0', '⠿ wedged for alert test');
    for (let i = 0; i < 5; i++) {
      clock += 2000;
      await fleet.tick();
      transport.setScreen('agent-1', '0.0', '⠿ wedged for alert test');
    }
    expect(alerts.some((a) => a.agentId === 'agent-1' && a.ruleId === 'breaker-open' && a.severity === 'critical')).toBe(true);
  });
});
