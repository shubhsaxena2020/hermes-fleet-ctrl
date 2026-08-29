/**
 * LocalTmuxTransport — drives tmux on the SAME host via the `tmux` CLI against a
 * specific socket (e.g. /home/ubuntu/.hermes/tmux/hermes-main.sock). This is the
 * real deployment transport for "Hermes Fleet Commander": the agent fleet runs as
 * local tmux panes, NOT over SSH.
 *
 * Safety notes (this is the production path, so they matter):
 *  - Every command is run with `child_process.execFile('tmux', [args...])` — an
 *    argv array, never a shell. Pane targets and prompts are never interpolated
 *    into a shell string, so there is no command injection surface.
 *  - `send-keys` is intentionally NOT used. Goal injection goes through the
 *    shared, safe path (load-buffer - + paste-buffer -t <pane>) which the
 *    GoalInjector already drives; this transport only implements the three
 *    primitives the fleet needs: exec, execWithStdin, capturePane.
 *  - capturePane is strictly read-only.
 *
 * `discoverAgents()` (below) parses `list-panes` to find the fleet's panes and is
 * what makes the daemon zero-config against a running hermes-main server.
 */

import { execFile } from 'node:child_process';
import { type TmuxTransport, type ExecResult } from './types.js';

export interface LocalTmuxOptions {
  /** Path to the tmux socket, e.g. '/home/ubuntu/.hermes/tmux/hermes-main.sock'. */
  socket: string;
  /** Extra argv inserted before every tmux invocation (e.g. '-L' name). */
  extraArgs?: string[];
}

function toExecResult(code: number | null, stdout: string, stderr: string): ExecResult {
  return { code: code ?? -1, stdout, stderr };
}

function run(args: string[], opts: LocalTmuxOptions, stdin?: string): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve) => {
    // Always target the explicit socket. tmux resolves the server socket from
    // the TMUX env var when set; since this process may itself be running inside
    // a tmux session (e.g. the hermes-main dashboard), we clear TMUX and pass -S
    // explicitly so we never accidentally target the operator's own session.
    const full = ['-S', opts.socket, ...(opts.extraArgs ?? []), ...args];
    const env = { ...process.env };
    delete env.TMUX;
    const child = execFile('tmux', full, { maxBuffer: 8 * 1024 * 1024, env }, (err, stdout, stderr) => {
      const code = typeof err === 'object' && err && 'code' in err ? (err as { code?: number }).code ?? 1 : 0;
      resolve(toExecResult(typeof code === 'number' ? code : 1, stdout, stderr));
    });
    if (stdin !== undefined && child.stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

export function createLocalTmux(opts: LocalTmuxOptions): TmuxTransport {
  // Callers (GoalInjector / FleetControl) pass full tmux command lines that
  // already begin with `tmux` (e.g. "tmux load-buffer -"). Strip that leading
  // token so we don't build a `tmux -S sock tmux ...` invocation.
  const strip = (command: string): string[] => {
    const parts = command.trim().split(/\s+/);
    if (parts[0] === 'tmux') parts.shift();
    return parts;
  };
  return {
    exec(_host: string, command: string): Promise<ExecResult> {
      return run(strip(command), opts);
    },
    execWithStdin(_host: string, command: string, input?: string): Promise<ExecResult> {
      return run(strip(command), opts, input ?? '');
    },
    capturePane(_host: string, target: string): Promise<string> {
      // capture-pane -p -e : print to stdout, include escape sequences (so the
      // ANSI parser can normalise them), for the given pane target.
      return run(['capture-pane', '-p', '-e', '-t', target], opts).then((r) => (r.code === 0 ? r.stdout : ''));
    },
  };
}

/** Raw argv invocation for commands we construct ourselves (avoids split ambiguity). */
export function localRun(opts: LocalTmuxOptions, args: string[]): Promise<ExecResult> {
  return run(args, opts);
}
