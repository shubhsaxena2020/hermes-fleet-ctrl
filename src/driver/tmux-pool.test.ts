import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TmuxPool } from './tmux-pool.js';
import type { HostConfig } from './types.js';

/**
 * Fully mocked `ssh2` so we never touch a real network. All fake classes are
 * defined INSIDE the `vi.mock` factory below (the factory is hoisted, so it may
 * not reference any top-level variable). The fake client records connect
 * attempts and lets the test drive `ready`/`close`/exec-stream events. We share
 * the live instance list via `vi.hoisted`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

type Handler = (...args: any[]) => void;

const registry = vi.hoisted(() => ({ connections: [] as any[] }));

vi.mock('ssh2', () => {
  class MiniEmitter {
    private map = new Map<string, Handler[]>();
    on(ev: string, fn: Handler): MiniEmitter {
      const list = this.map.get(ev) ?? [];
      list.push(fn);
      this.map.set(ev, list);
      return this;
    }
    emit(ev: string, arg?: unknown, arg2?: unknown): boolean {
      for (const fn of this.map.get(ev) ?? []) fn(arg, arg2);
      return true;
    }
  }

  // Plain emitter for stderr (avoids infinite recursion from nesting FakeStream).
  class FakeStderr extends MiniEmitter {}

  class FakeStream extends MiniEmitter {
    stderr: FakeStderr;
    constructor() {
      super();
      this.stderr = new FakeStderr();
    }
    write(): boolean {
      return true;
    }
    end(): void {
      /* noop */
    }
  }

  class FakeClient extends MiniEmitter {
    connectAttempts = 0;
    lastCommand = '';
    currentStream: FakeStream | null = null;
    constructor() {
      super();
      registry.connections.push(this);
    }
    connect(): void {
      this.connectAttempts += 1;
    }
    end(): void {
      /* noop */
    }
    exec(command: string, cb: (err: Error | null, stream: FakeStream) => void): FakeStream {
      this.lastCommand = command;
      const stream = new FakeStream();
      this.currentStream = stream;
      cb(null, stream);
      return stream;
    }
  }

  return { Client: FakeClient, __connections: registry.connections };
});

type FakeClientLike = {
  connectAttempts: number;
  lastCommand: string;
  currentStream: {
    emit: (ev: string, ...args: any[]) => boolean;
    stderr: { emit: (ev: string, ...args: any[]) => boolean };
  } | null;
  emit: (ev: string, ...args: any[]) => boolean;
};

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const hostCfg = (id: string): HostConfig => ({
  id,
  host: `${id}.local`,
  username: 'fleet',
  privateKey: 'dummy-key',
});

const NO_TIMEOUT = { commandTimeoutMs: 0 } as const;

const client0 = (): FakeClientLike => registry.connections[0] as FakeClientLike;

describe('TmuxPool — connection lifecycle', () => {
  beforeEach(() => {
    registry.connections.length = 0;
  });

  it('connects to a registered host and reports ready', async () => {
    const pool = new TmuxPool(NO_TIMEOUT);
    pool.addHost(hostCfg('agent-1'));
    const client = client0();
    expect(client.connectAttempts).toBe(1);
    client.emit('ready');
    await flush();
    expect(pool.state('agent-1')).toBe('ready');
  });

  it('does not create a second connection when addHost is called twice', () => {
    const pool = new TmuxPool(NO_TIMEOUT);
    pool.addHost(hostCfg('dup'));
    pool.addHost(hostCfg('dup'));
    expect(registry.connections.length).toBe(1);
  });

  it('rejects operations for an unknown host', async () => {
    const pool = new TmuxPool(NO_TIMEOUT);
    await expect(pool.listSessions('nope')).rejects.toThrow(/unknown host/);
  });
});

describe('TmuxPool — resilient auto-reconnect (exponential backoff)', () => {
  beforeEach(() => {
    registry.connections.length = 0;
  });

  it('reconnects with escalating backoff after transient drops, then recovers', async () => {
    const delays: number[] = [];
    const delayFn = vi.fn((ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    });
    const pool = new TmuxPool({
      ...NO_TIMEOUT,
      delayFn,
      baseBackoffMs: 500,
      maxBackoffMs: 30_000,
      maxRetries: Infinity,
    });
    pool.addHost(hostCfg('agent-1'));
    const client = client0();

    client.emit('ready');
    await flush();
    expect(pool.state('agent-1')).toBe('ready');

    client.emit('close');
    await flush();
    client.emit('close');
    await flush();
    client.emit('close');
    await flush();
    client.emit('ready');
    await flush();

    expect(delays).toEqual([500, 1000, 2000]);
    expect(pool.state('agent-1')).toBe('ready');
  });

  it('gives up permanently after maxRetries and rejects further work', async () => {
    const delays: number[] = [];
    const delayFn = vi.fn((ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    });
    const pool = new TmuxPool({
      ...NO_TIMEOUT,
      delayFn,
      baseBackoffMs: 500,
      maxBackoffMs: 30_000,
      maxRetries: 2,
    });
    pool.addHost(hostCfg('h'));
    const client = client0();

    client.emit('ready');
    client.emit('close');
    await flush();
    client.emit('close');
    await flush();
    client.emit('close'); // 3rd drop exceeds maxRetries(2)
    await flush();

    expect(delays).toEqual([500, 1000]);
    expect(pool.state('h')).toBe('disconnected');
    await expect(pool.listSessions('h')).rejects.toThrow(/disconnected/);
  });

  it('serves a queued command after a drop+recover cycle', async () => {
    const delayFn = vi.fn((_ms: number) => Promise.resolve());
    const pool = new TmuxPool({ ...NO_TIMEOUT, delayFn });
    pool.addHost(hostCfg('agent-1'));
    const client = client0();

    client.emit('ready');
    await flush();

    client.emit('close');
    await flush();
    client.emit('ready');
    await flush();

    const p = pool.listSessions('agent-1');
    await flush(); // let exec run before pushing stream data
    client.currentStream?.emit('data', Buffer.from('a\nb\n'));
    client.currentStream?.emit('close', 0);
    const sessions = await p;
    expect(sessions.map((s) => s.name)).toEqual(['a', 'b']);
  });
});

describe('TmuxPool — tmux parsing & capture', () => {
  beforeEach(() => {
    registry.connections.length = 0;
  });

  function readyPool(): Promise<{ pool: TmuxPool; client: FakeClientLike }> {
    const pool = new TmuxPool(NO_TIMEOUT);
    pool.addHost(hostCfg('agent-1'));
    const client = client0();
    client.emit('ready');
    return flush().then(() => ({ pool, client }));
  }

  it('parses `tmux list-sessions` output', async () => {
    const { pool, client } = await readyPool();
    const p = pool.listSessions('agent-1');
    await flush(); // let exec run so lastCommand + currentStream are set
    expect(client.lastCommand).toContain('tmux list-sessions');
    client.currentStream?.emit('data', Buffer.from('agent-0\nagent-1\n'));
    client.currentStream?.emit('close', 0);
    const sessions = await p;
    expect(sessions).toEqual([
      { host: 'agent-1', name: 'agent-0' },
      { host: 'agent-1', name: 'agent-1' },
    ]);
  });

  it('parses `tmux list-panes -a` tab-separated output into structured panes', async () => {
    const { pool, client } = await readyPool();
    const p = pool.listPanes('agent-1');
    await flush();
    expect(client.lastCommand).toContain('tmux list-panes -a');
    const line =
      'agent-0\t0\t0\tshell\t1234\t80\t24\tbash\t1\n' +
      'agent-0\t0\t1\tvim\t5678\t80\t24\tnvim\t0\n';
    client.currentStream?.emit('data', Buffer.from(line));
    client.currentStream?.emit('close', 0);
    const panes = await p;
    expect(panes).toHaveLength(2);
    expect(panes[0]).toMatchObject({
      host: 'agent-1',
      session: 'agent-0',
      window: 0,
      pane: 0,
      title: 'shell',
      pid: 1234,
      width: 80,
      height: 24,
      currentCommand: 'bash',
      active: true,
    });
    expect(panes[1]?.active).toBe(false);
    expect(panes[1]?.currentCommand).toBe('nvim');
  });

  it('captures raw ANSI screen buffer non-blocking (returns the literal terminal output)', async () => {
    const { pool, client } = await readyPool();
    const p = pool.capturePane('agent-1', 'agent-0:0.0');
    await flush();
    expect(client.lastCommand).toContain('capture-pane -p -e -t agent-0:0.0');
    const ansi = '\x1b[32mhello\x1b[0m\r\nprompt$ ';
    client.currentStream?.emit('data', Buffer.from(ansi));
    client.currentStream?.emit('close', 0);
    const buf = await p;
    expect(buf).toBe(ansi);
  });

  it('supports capturePane start/end line ranges', async () => {
    const { pool, client } = await readyPool();
    const p = pool.capturePane('agent-1', 'agent-0:0.0', { start: -50, end: -1 });
    await flush();
    expect(client.lastCommand).toContain('-S -50');
    expect(client.lastCommand).toContain('-E -1');
    client.currentStream?.emit('data', Buffer.from('tail'));
    client.currentStream?.emit('close', 0);
    expect(await p).toBe('tail');
  });

  it('rejects when tmux exits non-zero and surfaces stderr', async () => {
    const { pool, client } = await readyPool();
    const p = pool.listSessions('agent-1');
    await flush();
    client.currentStream?.stderr.emit('data', Buffer.from('error: no server running'));
    client.currentStream?.emit('close', 1);
    await expect(p).rejects.toThrow(/exited with code 1/);
    await expect(p).rejects.toThrow(/no server running/);
  });
});
