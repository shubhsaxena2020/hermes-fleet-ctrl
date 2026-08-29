/**
 * Shared types for the remote tmux telemetry engine.
 *
 * These describe the inputs (per-host SSH config) and the structured outputs we
 * derive from raw `tmux` command output.
 */

/** SSH connection details for a single fleet host. Key-based auth only. */
export interface HostConfig {
  /** Unique logical id used as the pool key (e.g. "agent-1"). */
  id: string;
  host: string;
  port?: number;
  username: string;
  /** Private key contents or a path. Resolved to a Buffer by the pool. */
  privateKey: string | Buffer;
  /** Passphrase for an encrypted key (optional). */
  passphrase?: string;
  /** Optional known_hosts strictness; defaults to 'accept-new' behaviour. */
  strictHostKeyChecking?: boolean;
}

/** Connection lifecycle state for a managed host connection. */
export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'ready'
  | 'reconnecting'
  | 'disconnected';

/** A tmux session on a remote host. */
export interface TmuxSession {
  host: string;
  name: string;
}

/** A single tmux pane with its live status. */
export interface PaneInfo {
  host: string;
  session: string;
  window: number;
  pane: number;
  title: string;
  pid: number;
  width: number;
  height: number;
  currentCommand: string;
  active: boolean;
}

/** Raw result of an executed tmux command over SSH. */
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Minimal transport the goal injector needs. Implemented by `TmuxPool` over SSH,
 * but swappable in tests for a faithful in-process mock tmux daemon so we can
 * assert exact command transmission without a real host.
 */
export interface TmuxTransport {
  /** Run a tmux command; resolve with combined stdout (code 0). */
  exec(hostId: string, command: string): Promise<ExecResult>;
  /** Run a tmux command that reads its payload from stdin (e.g. load-buffer -). */
  execWithStdin(hostId: string, command: string, input: string): Promise<ExecResult>;
  /** Capture the current screen content of a pane (used for receipt verify). */
  capturePane(hostId: string, target: string, opts?: { start?: number; end?: number }): Promise<string>;
}

/** Injectable scheduler used for reconnect backoff (testable without real timers). */
export type DelayFn = (ms: number) => Promise<void>;

/** Options tuning pool-wide behaviour. */
export interface TmuxPoolOptions {
  /** Initial backoff after a dropped connection. Exponential from here. */
  baseBackoffMs?: number;
  /** Upper bound for a single backoff wait. */
  maxBackoffMs?: number;
  /** Max reconnect attempts before giving up permanently (default: unlimited). */
  maxRetries?: number;
  /** Per-command exec timeout. */
  commandTimeoutMs?: number;
  /** Scheduler for backoff; defaults to a real setTimeout-based delay. */
  delayFn?: DelayFn;
}
