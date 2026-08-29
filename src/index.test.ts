import { describe, it, expect, afterAll } from 'vitest';
import { AddressInfo } from 'node:net';
import { bootFleet, type BootConfig } from './index.js';
import { createControlPlane } from './server/control-plane.js';
import type { FastifyInstance } from 'fastify';
import type { TmuxTransport, ExecResult } from './driver/types.js';

class FakeTransport implements TmuxTransport {
  setScreen(host: string, pane: string, text: string): void {
    this.screens.set(`${host}|${pane}`, text);
  }
  private screens = new Map<string, string>();
  exec(_h: string, _c: string): Promise<ExecResult> {
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  }
  execWithStdin(_h: string, _c: string): Promise<ExecResult> {
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  }
  capturePane(host: string, target: string): Promise<string> {
    return Promise.resolve(this.screens.get(`${host}|${target}`) ?? '');
  }
}

describe('bootFleet — full-stack assembly', () => {
  it('wires transport + journal + FleetControl and a live server boots + answers', async () => {
    const transport = new FakeTransport();
    transport.setScreen('agent-1', '0.0', '$ ');
    const config: BootConfig = {
      agents: [{ agentId: 'agent-1', host: 'agent-1', pane: '0.0' }],
      transport,
    };
    const { fleet, journal } = bootFleet(config);
    expect(fleet.agentViews().map((a) => a.agentId)).toEqual(['agent-1']);

    const app: FastifyInstance = await createControlPlane(fleet, { pollIntervalMs: 0 });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address() as AddressInfo;
    const base = `http://127.0.0.1:${addr.port}`;

    const res = await fetch(`${base}/health`);
    const body = (await res.json()) as { ok: boolean; agents: string[] };
    expect(body.ok).toBe(true);
    expect(body.agents).toEqual(['agent-1']);

    // enqueue a goal through the assembled fleet; it should land in the engine.
    const id = fleet.enqueueGoal('agent-1', 'hello');
    expect(fleet.engine.snapshot().some((t) => t.taskId === id)).toBe(true);

    await app.close();
    journal.close();
  });

  it('throws without a transport or hosts (fail-fast wiring)', () => {
    expect(() => bootFleet({ agents: [] })).toThrow(/requires either config.transport or config.hosts/);
  });

  afterAll(() => {
    /* app closed in-test */
  });
});
