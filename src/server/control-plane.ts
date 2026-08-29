/**
 * Control-plane HTTP/WebSocket server for the agent fleet.
 *
 * Wires a `FleetControl` orchestrator behind a Fastify app:
 *
 *   GET  /health                 -> { ok: true, agents, tasks }
 *   GET  /agents                 -> per-agent views (state, stuck, breaker)
 *   GET  /agents/:id             -> single agent view
 *   GET  /tasks                  -> queue snapshot (priority-ordered)
 *   POST /tasks                  -> enqueue a goal  { agentId, prompt, priority? }
 *   POST /agents/:id/goal        -> inject a goal immediately (bypasses queue)
 *                                    body { prompt, options? }  -> DispatchResult
 *   GET  /journal/audit?limit=50 -> recent audit_log rows
 *   WS   /stream                 -> live feed of FleetEvent JSON messages
 *
 * Fully testable: pass a FleetControl that uses an in-memory journal + mock
 * transport; listen on port 0; the test drives tick()/pump() and connects a WS
 * client. No real SSH/tmux required.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import websocketPlugin, { type SocketStream } from '@fastify/websocket';
import { FleetControl, type FleetEvent } from './fleet-control.js';

/** Minimal structural type for the ws connection we use. */
interface WsLike {
  readonly OPEN: number;
  readyState: number;
  send(data: string): void;
  on(event: 'close' | 'error', cb: () => void): void;
}

export interface ControlPlaneOptions {
  /** Poll interval for the live snapshot loop (ms). 0 = don't auto-start. */
  pollIntervalMs?: number;
}

export async function createControlPlane(
  fleet: FleetControl,
  opts: ControlPlaneOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(websocketPlugin);

  const subscribers = new Set<WsLike>();
  const sseClients = new Set<(chunk: string) => void>();

  function broadcast(e: FleetEvent): void {
    const msg = JSON.stringify(e);
    for (const ws of subscribers) {
      try {
        if (ws.readyState === 1) ws.send(msg);
      } catch {
        /* drop dead sockets silently */
      }
    }
    for (const send of sseClients) {
      try {
        send(`data: ${msg}\n\n`);
      } catch {
        /* drop dead streams silently */
      }
    }
  }

  // Fan out fleet events to connected WS subscribers.
  fleet.on('snapshot', (e: FleetEvent) => broadcast(e));
  fleet.on('task', (e: FleetEvent) => broadcast(e));
  fleet.on('guardian', (e: FleetEvent) => broadcast(e));

  app.get('/health', () => ({
    ok: true,
    agents: fleet.agentViews().map((a) => a.agentId),
    tasks: fleet.engine.snapshot().length,
  }));

  app.get('/agents', () => ({ agents: fleet.agentViews() }));

  app.get<{ Params: { id: string } }>('/agents/:id', (req, reply) => {
    const view = fleet.agentViews().find((a) => a.agentId === req.params.id);
    if (!view) return reply.code(404).send({ error: 'unknown agent', agentId: req.params.id });
    return view;
  });

  app.get('/tasks', () => ({ tasks: fleet.engine.snapshot() }));

  app.post<{ Body: { agentId?: string; prompt?: string; priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL' } }>(
    '/tasks',
    async (req, reply) => {
      const { agentId, prompt, priority } = req.body ?? {};
      if (!agentId || !prompt) {
        return reply.code(400).send({ error: 'agentId and prompt are required' });
      }
      const taskId = fleet.enqueueGoal(agentId, prompt, priority ?? 'NORMAL');
      return reply.code(201).send({ taskId });
    },
  );

  app.post<{ Params: { id: string }; Body: { prompt?: string } }>(
    '/agents/:id/goal',
    async (req, reply) => {
      const { prompt } = req.body ?? {};
      if (!prompt) return reply.code(400).send({ error: 'prompt is required' });
      try {
        const res = await fleet.injectGoal(req.params.id, prompt);
        if (!res.ok) {
          const protectedMsg = /protected/.test(res.error ?? '');
          return reply.code(protectedMsg ? 403 : 404).send({ error: res.error ?? 'inject failed' });
        }
        return reply.code(200).send(res);
      } catch (err) {
        return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.get<{ Querystring: { limit?: string } }>('/journal/audit', (req) => {
    const limit = Math.min(Number.parseInt(req.query.limit ?? '50', 10) || 50, 500);
    return { audit: fleet.recentAudit(limit) };
  });

  app.get('/stream', { websocket: true }, (connection: SocketStream) => {
    const socket = connection.socket as WsLike;
    subscribers.add(socket);
    socket.on('close', () => subscribers.delete(socket));
    socket.on('error', () => subscribers.delete(socket));
  });

  // Server-Sent Events variant of /stream (no WebSocket upgrade needed).
  app.get('/stream/sse', async (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const send = (chunk: string) => {
      try {
        reply.raw.write(chunk);
      } catch {
        /* socket closed */
      }
    };
    // Push the current snapshot immediately so a fresh client is not blank.
    send(`data: ${JSON.stringify({ type: 'snapshot-batch', agents: fleet.agentViews(), tasks: fleet.engine.snapshot() })}\n\n`);
    sseClients.add(send);
    req.raw.on('close', () => sseClients.delete(send));
  });

  if (opts.pollIntervalMs && opts.pollIntervalMs > 0) {
    fleet.start(opts.pollIntervalMs);
  }

  return app;
}
