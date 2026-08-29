/**
 * Remote tmux telemetry engine — SSH connection pool + tmux scraper driver.
 *
 * Responsibilities:
 *   - Maintain a pool of SSH connections (one per fleet host), key-based auth.
 *   - Auto-reconnect with exponential backoff on dropped connections.
 *   - Run `tmux` commands over each connection to enumerate sessions/panes and
 *     capture raw ANSI screen buffers (non-blocking: `capture-pane -p` streams
 *     to stdout, and our reader never blocks the event loop).
 *
 * The `ssh2` Client is imported at module top so tests can `vi.mock('ssh2')`
 * and drive fake streams deterministically.
 */

import { existsSync, readFileSync } from 'node:fs';
import { Client, type ClientChannel } from 'ssh2';
import type {
  ConnectionState,
  DelayFn,
  ExecResult,
  HostConfig,
  PaneInfo,
  TmuxPoolOptions,
  TmuxSession,
} from './types.js';

const DEFAULT_BASE_BACKOFF_MS = 500;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;

interface CaptureOptions {
  /** Start line (tmux `-S`, negative = from bottom). */
  start?: number;
  /** End line (tmux `-E`). */
  end?: number;
}

/** A single managed SSH connection to one fleet host. */
class HostConnection {
  readonly id: string;
  state: ConnectionState = 'idle';
  lastError: Error | null = null;

  private client: Client;
  private sshConfig: Record<string, unknown>;
  private retryCount = 0;
  private reconnecting = false;
  private disconnected = false;
  private waiters: Array<{ resolve: (c: Client) => void; reject: (e: Error) => void }> = [];

  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxRetries: number;
  private readonly delayFn: DelayFn;

  constructor(
    cfg: HostConfig,
    resolveKey: (pk: string | Buffer) => Buffer,
    opts: {
      baseBackoffMs: number;
      maxBackoffMs: number;
      maxRetries: number;
      delayFn: DelayFn;
    },
  ) {
    this.id = cfg.id;
    this.baseBackoffMs = opts.baseBackoffMs;
    this.maxBackoffMs = opts.maxBackoffMs;
    this.maxRetries = opts.maxRetries;
    this.delayFn = opts.delayFn;

    const sshConfig: Record<string, unknown> = {
      host: cfg.host,
      port: cfg.port ?? 22,
      username: cfg.username,
      privateKey: resolveKey(cfg.privateKey),
      readyTimeout: 20_000,
      keepaliveInterval: 15_000,
    };
    if (cfg.passphrase !== undefined) {
      sshConfig.passphrase = cfg.passphrase;
    }
    this.sshConfig = sshConfig;

    this.client = new Client();
    this.client.on('ready', () => this.handleReady());
    this.client.on('error', (err: Error) => {
      this.lastError = err;
    });
    this.client.on('close', () => this.handleClose());

    this.state = 'connecting';
    this.client.connect(this.sshConfig);
  }

  get rawClient(): Client {
    return this.client;
  }

  /** Resolve once the connection is ready, or reject if permanently disconnected. */
  waitReady(): Promise<Client> {
    if (this.disconnected) {
      return Promise.reject(new Error(`host ${this.id} is disconnected`));
    }
    if (this.state === 'ready') {
      return Promise.resolve(this.client);
    }
    return new Promise<Client>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  private handleReady(): void {
    this.state = 'ready';
    this.retryCount = 0;
    this.reconnecting = false;
    this.lastError = null;
    const pending = this.waiters;
    this.waiters = [];
    for (const w of pending) {
      w.resolve(this.client);
    }
  }

  private handleClose(): void {
    if (this.disconnected) return;
    this.scheduleReconnect();
  }

  private rejectWaiters(err: Error): void {
    const pending = this.waiters;
    this.waiters = [];
    for (const w of pending) {
      w.reject(err);
    }
  }

  private scheduleReconnect(): void {
    if (this.disconnected || this.reconnecting) return;
    this.reconnecting = true;
    this.state = 'reconnecting';

    if (this.maxRetries !== Infinity && this.retryCount >= this.maxRetries) {
      this.reconnecting = false;
      this.disconnected = true;
      this.state = 'disconnected';
      this.rejectWaiters(new Error(`host ${this.id}: max reconnect attempts (${this.maxRetries}) exceeded`));
      return;
    }

    const ms = Math.min(this.maxBackoffMs, this.baseBackoffMs * 2 ** this.retryCount);
    this.retryCount += 1;

    void this.delayFn(ms).then(() => {
      if (this.disconnected) return;
      this.state = 'connecting';
      this.reconnecting = false;
      this.client.connect(this.sshConfig);
    });
  }

  /** Permanently stop this connection and reject any pending waiters. */
  disconnect(): void {
    if (this.disconnected) return;
    this.disconnected = true;
    this.state = 'disconnected';
    this.client.end();
    this.rejectWaiters(new Error(`host ${this.id} disconnected`));
  }
}

export class TmuxPool {
  private hosts = new Map<string, HostConnection>();
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxRetries: number;
  private readonly commandTimeoutMs: number;
  private readonly delayFn: DelayFn;

  constructor(options: TmuxPoolOptions = {}) {
    this.baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.maxRetries = options.maxRetries ?? Infinity;
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.delayFn = options.delayFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  }

  /** Register a host. If already registered, the existing connection is returned. */
  addHost(cfg: HostConfig): void {
    if (this.hosts.has(cfg.id)) return;
    const hc = new HostConnection(cfg, (pk) => this.resolveKey(pk), {
      baseBackoffMs: this.baseBackoffMs,
      maxBackoffMs: this.maxBackoffMs,
      maxRetries: this.maxRetries,
      delayFn: this.delayFn,
    });
    this.hosts.set(cfg.id, hc);
  }

  /** Current lifecycle state of a host connection. */
  state(hostId: string): ConnectionState {
    return this.hosts.get(hostId)?.state ?? 'disconnected';
  }

  /** List tmux sessions on a host. */
  async listSessions(hostId: string): Promise<TmuxSession[]> {
    const out = await this.exec(hostId, "tmux list-sessions -F '#{session_name}'");
    return parseSessions(out.stdout, hostId);
  }

  /** List every pane (all sessions) on a host with live status. */
  async listPanes(hostId: string): Promise<PaneInfo[]> {
    const fmt =
      '#{session_name}\t#{window_index}\t#{pane_index}\t#{pane_title}\t#{pane_pid}' +
      '\t#{pane_width}\t#{pane_height}\t#{pane_current_command}\t#{pane_active}';
    const out = await this.exec(hostId, `tmux list-panes -a -F '${fmt}'`);
    return parsePanes(out.stdout, hostId);
  }

  /** Capture the raw ANSI screen buffer of a pane (non-blocking over stdout). */
  async capturePane(hostId: string, target: string, opts: CaptureOptions = {}): Promise<string> {
    const parts = ['tmux', 'capture-pane', '-p', '-e', '-t', target];
    if (opts.start !== undefined) parts.push('-S', String(opts.start));
    if (opts.end !== undefined) parts.push('-E', String(opts.end));
    const out = await this.exec(hostId, parts.join(' '));
    return out.stdout;
  }

  /**
   * Run an arbitrary tmux command that reads its payload from stdin
   * (e.g. `tmux load-buffer -`). Returns combined stdout. Used by the goal
   * injector for safe, exact payload transmission.
   */
  async execWithStdin(hostId: string, command: string, input: string): Promise<ExecResult> {
    const hc = this.hosts.get(hostId);
    if (!hc) return Promise.reject(new Error(`unknown host: ${hostId}`));
    return hc.waitReady().then((client) => this.runCommand(client, command, input));
  }

  /** Disconnect a single host (or all if hostId omitted) and stop reconnecting. */
  disconnect(hostId?: string): void {
    if (hostId === undefined) {
      for (const hc of this.hosts.values()) hc.disconnect();
      return;
    }
    this.hosts.get(hostId)?.disconnect();
  }

  // ---- internals ----

  private resolveKey(pk: string | Buffer): Buffer {
    if (Buffer.isBuffer(pk)) return pk;
    if (existsSync(pk)) return readFileSync(pk);
    return Buffer.from(pk, 'utf8');
  }

  private withConnection<T>(hostId: string, fn: (client: Client) => Promise<T>): Promise<T> {
    const hc = this.hosts.get(hostId);
    if (!hc) return Promise.reject(new Error(`unknown host: ${hostId}`));
    return hc.waitReady().then(fn);
  }

  private exec(hostId: string, command: string): Promise<ExecResult> {
    return this.withConnection(hostId, (client) => this.runCommand(client, command));
  }

  private runCommand(client: Client, command: string, input?: string): Promise<ExecResult> {
    return new Promise<ExecResult>((resolve, reject) => {
      let settled = false;
      const timer =
        this.commandTimeoutMs > 0
          ? setTimeout(() => {
              if (!settled) {
                settled = true;
                reject(new Error(`command timed out after ${this.commandTimeoutMs}ms: ${command}`));
              }
            }, this.commandTimeoutMs)
          : undefined;

      client.exec(command, (err: Error | undefined, stream: ClientChannel) => {
        if (err) {
          if (timer) clearTimeout(timer);
          if (!settled) {
            settled = true;
            reject(err);
          }
          return;
        }
        let stdout = '';
        let stderr = '';
        stream.on('data', (d: Buffer | string) => {
          stdout += typeof d === 'string' ? d : d.toString('utf8');
        });
        stream.stderr.on('data', (d: Buffer | string) => {
          stderr += typeof d === 'string' ? d : d.toString('utf8');
        });
        stream.on('close', (code: number | null) => {
          if (timer) clearTimeout(timer);
          if (!settled) {
            settled = true;
            if (code !== null && code !== 0) {
              const detail = stderr.trim() || stdout.trim();
              reject(new Error(`tmux exited with code ${code}: ${detail}`));
            } else {
              resolve({ code: code ?? 0, stdout, stderr });
            }
          }
        });
        // If the command reads from stdin (e.g. `tmux load-buffer -`), pipe it.
        if (input !== undefined) {
          stream.end(Buffer.from(input, 'utf8'));
        }
      });
    });
  }
}

// ---- parsers ----

function parseSessions(out: string, host: string): TmuxSession[] {
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((name) => ({ host, name }));
}

function toInt(v: string | undefined, fallback: number): number {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

function parsePanes(out: string, host: string): PaneInfo[] {
  const panes: PaneInfo[] = [];
  for (const rawLine of out.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const f = line.split('\t');
    if (f.length < 9) continue;
    const active = (f[8] ?? '').trim() === '1' || (f[8] ?? '').trim().toLowerCase() === 'true';
    panes.push({
      host,
      session: f[0] ?? '',
      window: toInt(f[1], 0),
      pane: toInt(f[2], 0),
      title: f[3] ?? '',
      pid: toInt(f[4], 0),
      width: toInt(f[5], 0),
      height: toInt(f[6], 0),
      currentCommand: f[7] ?? '',
      active,
    });
  }
  return panes;
}
