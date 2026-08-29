import { describe, it, expect } from 'vitest';
import { GoalInjector } from './goal-injector.js';
import type { TmuxTransport, ExecResult } from './types.js';

/**
 * A faithful in-process mock of a tmux server for a single host. It parses the
 * exact `load-buffer -` stdin, `paste-buffer -t <pane>` target, and `capture-pane`
 * requests our injector issues, and maintains a per-pane "screen" so receipt
 * verification behaves like real tmux.
 */
class MockTmuxDaemon implements TmuxTransport {
  /** pane -> accumulated screen text */
  private screens = new Map<string, string>();
  /** recorded (command, input) pairs for assertions */
  readonly calls: Array<{ command: string; input?: string }> = [];

  constructor(initial: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(initial)) this.screens.set(k, v);
  }

  private screen(pane: string): string {
    let s = this.screens.get(pane);
    if (s === undefined) {
      s = '';
      this.screens.set(pane, s);
    }
    return s;
  }

  exec(hostId: string, command: string): Promise<ExecResult> {
    this.calls.push({ command });
    // parse `tmux paste-buffer -t <pane>` -> append the current buffer + newline
    const pb = command.match(/^tmux paste-buffer -t (.+)$/);
    if (pb) {
      const pane = pb[1]!;
      const buf = this.pendingBuffer ?? '';
      const s = this.screen(pane);
      this.screens.set(pane, s + buf + '\n');
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    }
    if (command.startsWith('tmux capture-pane')) {
      // capture-pane -p -e -t <pane> -S -50 -E -1  -> return screen
      const t = command.match(/-t\s+(\S+)/);
      const pane = t?.[1] ?? hostId;
      return Promise.resolve({ code: 0, stdout: this.screen(pane), stderr: '' });
    }
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  }

  private pendingBuffer: string | null = null;

  execWithStdin(hostId: string, command: string, input: string): Promise<ExecResult> {
    this.calls.push({ command, input });
    // `tmux load-buffer -` -> store the exact stdin as the pending buffer
    if (command.trim() === 'tmux load-buffer -') {
      this.pendingBuffer = input;
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    }
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  }

  capturePane(hostId: string, target: string): Promise<string> {
    return Promise.resolve(this.screen(target));
  }
}

describe('GoalInjector — exact, safe transmission (mock tmux daemon)', () => {
  it('uses load-buffer + paste-buffer (never send-keys / C-c) and transmits bytes verbatim', async () => {
    const daemon = new MockTmuxDaemon();
    const inj = new GoalInjector(daemon);

    const prompt = 'Refactor src/queue/task-engine.ts: add a priority comparator. Cost < $0.50? Use "quotes" & weird $chars';
    const res = await inj.dispatchGoal('agent-1', prompt, { target: 'agent-1:0.0', verifyDelayMs: 0 });

    expect(res.ok).toBe(true);

    // Inspect the exact commands the daemon saw.
    const loadCall = daemon.calls.find((c) => c.command === 'tmux load-buffer -');
    const pasteCall = daemon.calls.find((c) => c.command.startsWith('tmux paste-buffer'));
    expect(loadCall, 'expected a load-buffer - call').toBeTruthy();
    expect(pasteCall?.command).toBe('tmux paste-buffer -t agent-1:0.0');

    // NO raw keystroke injection, NO Ctrl-C.
    const allCommands = daemon.calls.map((c) => c.command).join('\n');
    expect(allCommands).not.toContain('send-keys');
    expect(allCommands).not.toContain('C-c');
    expect(allCommands).not.toContain('Enter');

    // The exact bytes the agent received == the prompt + token + newline.
    const transmitted = loadCall!.input!;
    expect(transmitted.startsWith(prompt + '\n')).toBe(true);
    expect(transmitted.endsWith('\n')).toBe(true);

    // The pane screen contains the verbatim prompt (special chars intact) + token.
    const screen = daemon.screen('agent-1:0.0');
    expect(screen).toContain(prompt);
    expect(screen).toContain('$0.50');
    expect(screen).toContain('"quotes"');
    expect(res.transmitted).toBe(transmitted);
  });

  it('verifies receipt via the embedded token and returns ok only when present', async () => {
    const daemon = new MockTmuxDaemon();
    const inj = new GoalInjector(daemon);
    const res = await inj.dispatchGoal('a', 'do the thing', { target: 'a:0.0', verifyDelayMs: 0 });
    expect(res.ok).toBe(true);
    // The token (between \x01...\x02) must have landed on the pane.
    /* eslint-disable no-control-regex */
    const screen = daemon.screen('a:0.0');
    expect(screen).toMatch(/\x01HERMES-GOAL:.*\x02/);
    /* eslint-enable no-control-regex */
  });

  it('respects noSubmit (does not append trailing newline)', async () => {
    const daemon = new MockTmuxDaemon();
    const inj = new GoalInjector(daemon);
    const res = await inj.dispatchGoal('a', 'partial', { target: 'a:0.0', noSubmit: true, verifyDelayMs: 0 });
    expect(res.transmitted.endsWith('\n')).toBe(false);
    expect(daemon.screen('a:0.0').endsWith('partial\n')).toBe(false);
  });

  it('retries and then throws GoalInjectError when receipt never appears', async () => {
    // A daemon that "loses" the paste (never appends to screen) simulates a pane
    // that is not accepting input (e.g. stuck in an editor). Receipt must fail.
    const daemon: TmuxTransport = {
      exec(_h: string, command: string): Promise<ExecResult> {
        if (command.startsWith('tmux paste-buffer')) return Promise.resolve({ code: 0, stdout: '', stderr: '' });
        if (command.startsWith('tmux capture-pane')) return Promise.resolve({ code: 0, stdout: '', stderr: '' });
        return Promise.resolve({ code: 0, stdout: '', stderr: '' });
      },
      execWithStdin(): Promise<ExecResult> {
        return Promise.resolve({ code: 0, stdout: '', stderr: '' });
      },
      capturePane(): Promise<string> {
        return Promise.resolve('');
      },
    };
    const inj = new GoalInjector(daemon);
    await expect(inj.dispatchGoal('a', 'hi', { target: 'a:0.0', verifyDelayMs: 0, maxAttempts: 2 })).rejects.toMatchObject({
      name: 'GoalInjectError',
      code: 'VERIFY_FAILED',
    });
  });

  it('propagates UNKNOWN_HOST when the transport rejects', async () => {
    const daemon: TmuxTransport = {
      exec(): Promise<ExecResult> {
        return Promise.resolve({ code: 0, stdout: '', stderr: '' });
      },
      execWithStdin(): Promise<ExecResult> {
        throw new Error('unknown host: a');
      },
      capturePane(): Promise<string> {
        return Promise.resolve('');
      },
    };
    const inj = new GoalInjector(daemon);
    await expect(inj.dispatchGoal('a', 'hi')).rejects.toMatchObject({
      name: 'GoalInjectError',
      code: 'UNKNOWN_HOST',
    });
  });
});
