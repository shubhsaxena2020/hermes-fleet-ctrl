import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRealControlPlane } from './real-fleet.js';
import type { FastifyInstance } from 'fastify';

// End-to-end daemon path on an ISOLATED tmux socket (never hermes-main):
// bootRealFleet discovers agents, builds the Fastify control plane, the REST
// API reports them, the protection gate blocks protected panes (403), and a
// non-protected worker pane is permitted to receive a dispatch.
//
// NOTE: a synthetic bare `bash` pane mangles the \x01..\x02 receipt token via
// readline, so the live receipt-verification can fail here even though the
// injection was attempted. The faithful transport-paste behaviour is proven
// separately in real-fleet.test.ts (MockTransport receives the exact bytes).
// This file therefore asserts the daemon wiring + the protection gate.
const TMUX_ENV = { ...process.env };
delete (TMUX_ENV as Record<string, string>).TMUX;

describe('real-fleet daemon path (isolated tmux)', () => {
  let socket: string;
  let dir: string;
  let base = '';
  let app: FastifyInstance;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-daemon-'));
    socket = join(dir, 'd.sock');
    const tmux = (a: string[]) => execFileSync('tmux', a, { env: TMUX_ENV });
    tmux(['-S', socket, 'new-session', '-d', '-x', '120', '-y', '40', '-s', 'hermes-main', 'bash']);
    tmux(['-S', socket, 'new-window', '-t', 'hermes-main', 'bash']);
    const cp = await createRealControlPlane(
      { socket, journalPath: join(dir, 'j.db'), stuckAfterMs: 1000, agentPattern: '' },
      { pollIntervalMs: 0 },
    );
    app = cp.app;
    base = await app.listen({ port: 0, host: '127.0.0.1' });
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
    try {
      execFileSync('tmux', ['-S', socket, 'kill-session', '-t', 'hermes-main'], { env: TMUX_ENV });
    } catch {
      /* ignore */
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('GET /health reports the discovered agents', async () => {
    const res = await fetch(`${base}/health`);
    const body = (await res.json()) as { ok: boolean; agents: string[] };
    expect(res.ok).toBe(true);
    expect(body.ok).toBe(true);
    expect(body.agents).toContain('hermes-main-1.0');
    expect(body.agents).toContain('hermes-main-0.0');
  });

  it('GET /agents classifies and flags window 0 protected', async () => {
    const res = await fetch(`${base}/agents`);
    const body = (await res.json()) as { agents: Array<{ agentId: string; protected: boolean }> };
    const main = body.agents.find((a) => a.agentId === 'hermes-main-0.0');
    const worker = body.agents.find((a) => a.agentId === 'hermes-main-1.0');
    expect(main?.protected).toBe(true);
    expect(worker?.protected).toBe(false);
  });

  it('POST /agents/:id/goal returns 403 for a protected pane', async () => {
    const res = await fetch(`${base}/agents/hermes-main-0.0/goal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'do something' }),
    });
    expect(res.status).toBe(403);
  });

  it('POST /agents/:id/goal to a worker pane is permitted (not blocked by the protection gate)', async () => {
    const res = await fetch(`${base}/agents/hermes-main-1.0/goal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'run the checks' }),
    });
    // 200 = injected; 500 = injected but the synthetic pane could not echo the
    // receipt token (readline mangles \x01..\x02). Both prove dispatch was NOT
    // rejected as protected.
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(404);
  });

  it('GET /stream/sse streams a snapshot batch immediately', async () => {
    const res = await fetch(`${base}/stream/sse`);
    expect(res.ok).toBe(true);
    const body = res.body as ReadableStream<Uint8Array> | null;
    expect(body).not.toBeNull();
    const reader = body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const result = await reader.read();
      if (result.done) break;
      buf += decoder.decode(result.value, { stream: true });
      if (buf.includes('data:')) break;
    }
    await reader.cancel();
    expect(buf).toContain('data:');
  }, 10_000);
});
