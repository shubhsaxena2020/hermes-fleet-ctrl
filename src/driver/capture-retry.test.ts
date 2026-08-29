import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TmuxPool } from './tmux-pool.js';
import type { HostConfig } from './types.js';

/**
 * Phase B (BACKLOG B10): the poller's capturePane retry/backoff path. On a
 * transient capture failure it retries up to `captureRetries` times with
 * exponential backoff (base * 2^try + jitter), then throws if still failing.
 *
 * We reuse the same mocked `ssh2` transport as tmux-pool.test.ts so no real
 * network is touched. Failures are injected by making the host's `exec` reject
 * for `capture-pane` commands; backoff delays are captured via an injected
 * `delayFn`.
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
  class FakeClient extends MiniEmitter {
    connectAttempts = 0;
    constructor() {
      super();
      registry.connections.push(this);
    }
    connect(): void {
      this.connectAttempts += 1;
    }
    end(): void {}
    exec(command: string, cb: (err: Error | null, stream: any) => void): any {
      const stream = { stderr: new MiniEmitter(), write: () => true, end: () => {} };
      cb(null, stream);
      return stream;
    }
  }
  return { Client: FakeClient };
});

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const hostCfg = (id: string): HostConfig => ({ id, host: `${id}.local`, username: 'fleet', privateKey: 'k' });

class MiniEmitter {
  private map = new Map<string, ((...a: any[]) => void)[]>();
  on(): MiniEmitter {
    return this;
  }
  emit(): boolean {
    return true;
  }
}
// A fake ssh2 stream: when 'data'/'close' listeners are attached we immediately
// fire them with empty output / exit code 0, so runCommand resolves with ''.
class FakeStream {
  stderr: MiniEmitter = new MiniEmitter();
  on(ev: string, fn: (...a: any[]) => void): void {
    if (ev === 'data') fn('');
    else if (ev === 'close') fn(0);
  }
  write(): boolean {
    return true;
  }
  end(): void {
    /* noop */
  }
}
function fakeStream(): FakeStream {
  return new FakeStream();
}

type FakeClientLike = {
  connectAttempts: number;
  exec: (command: string, cb: (err: Error | null, stream: any) => void) => any;
  emit: (ev: string, ...args: any[]) => boolean;
};
const client0 = (): FakeClientLike => registry.connections[0] as FakeClientLike;

function makePool(over: Record<string, unknown> = {}) {
  const delays: number[] = [];
  const delayFn = vi.fn((ms: number) => {
    delays.push(ms);
    return Promise.resolve();
  });
  const pool = new TmuxPool({ commandTimeoutMs: 0, ...over, delayFn });
  pool.addHost(hostCfg('agent-1'));
  return { pool, delays, delayFn };
}

/** A capture command that resolves successfully (empty screen). */
function successExec(command: string, cb: (err: Error | null, stream: FakeStream) => void): FakeStream {
  const stream = fakeStream();
  cb(null, stream);
  return stream;
}

describe('Poller capturePane retry/backoff (B10)', () => {
  beforeEach(() => {
    registry.connections.length = 0;
    vi.clearAllMocks();
  });

  it('succeeds on the first attempt (no backoff delays) when capture works', async () => {
    const { pool, delays } = makePool();
    const client = client0();
    client.emit('ready');
    await flush();
    client.exec = successExec;

    const out = await pool.capturePane('agent-1', '0.0');
    expect(out).toBe('');
    expect(delays).toHaveLength(0); // no retries needed
  });

  it('retries with escalating backoff after transient capture failures, then succeeds', async () => {
    const { pool, delays } = makePool({ captureRetries: 3, captureBaseBackoffMs: 100, commandTimeoutMs: 0 });
    const client = client0();
    client.emit('ready');
    await flush();

    let calls = 0;
    // Make the first 2 capture attempts fail, the 3rd succeed.
    client.exec = (command: string, cb: (err: Error | null, stream: any) => void) => {
      calls += 1;
      if (command.includes('capture-pane') && calls < 3) {
        throw new Error('capture failed (transient)');
      }
      const stream = fakeStream();
      cb(null, stream);
      return stream;
    };

    const out = await pool.capturePane('agent-1', '0.0');
    expect(out).toBe('');
    // Two retries => backoff schedule base*2^0, base*2^1, each plus jitter(0..100).
    expect(delays).toHaveLength(2);
    expect(delays[0]).toBeGreaterThanOrEqual(100);
    expect(delays[0]).toBeLessThan(200);
    expect(delays[1]).toBeGreaterThanOrEqual(200);
    expect(delays[1]).toBeLessThan(300);
    expect(calls).toBe(3);
  });

  it('throws after exhausting captureRetries (all transient failures)', async () => {
    const { pool, delays } = makePool({ captureRetries: 3, captureBaseBackoffMs: 100, commandTimeoutMs: 0 });
    const client = client0();
    client.emit('ready');
    await flush();

    client.exec = (command: string) => {
      if (command.includes('capture-pane')) throw new Error('capture failed (transient)');
      const stream = fakeStream();
      return stream;
    };

    await expect(pool.capturePane('agent-1', '0.0')).rejects.toThrow(/capture failed/);
    // 3 attempts => 2 backoff delays (each base*2^i + jitter 0..100) before the final failing attempt.
    expect(delays).toHaveLength(2);
    expect(delays[0]).toBeGreaterThanOrEqual(100);
    expect(delays[0]).toBeLessThan(200);
    expect(delays[1]).toBeGreaterThanOrEqual(200);
    expect(delays[1]).toBeLessThan(300);
  });
});
