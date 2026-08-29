import { describe, it, expect } from 'vitest';
import { EventJournal } from './storage/db.js';
import { FleetControl } from './server/fleet-control.js';
import type { TmuxTransport, ExecResult } from './driver/types.js';

class MockTransport implements TmuxTransport {
  injected: string[] = [];
  private screen = '$ ';
  private pending = '';
  exec(_h: string, command: string): Promise<ExecResult> {
    const m = command.match(/^tmux paste-buffer -t (.+)$/);
    if (m) this.screen += this.pending; // paste-buffer writes the buffered bytes
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  }
  execWithStdin(_h: string, _command: string, input?: string): Promise<ExecResult> {
    if (input) {
      this.injected.push(input);
      this.pending = input; // load-buffer stages bytes for the next paste
    }
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  }
  capturePane(_h: string, _t: string): Promise<string> {
    return Promise.resolve(this.screen);
  }
}

function build(protectedIds: Set<string>) {
  const journal = new EventJournal();
  const transport = new MockTransport();
  const fleet = new FleetControl(
    transport,
    journal,
    {
      'agent-1': { host: 'hermes-main', pane: 'hermes-main:1.0' },
      'hermes-main-w0.0': { host: 'hermes-main', pane: 'hermes-main:0.0' },
    },
    { stuckAfterMs: 1000, slots: 2, protectedIds },
  );
  return { fleet, transport };
}

describe('FleetControl — protected-pane safety', () => {
  it('refuses to inject a goal into a protected pane', async () => {
    const { fleet, transport } = build(new Set(['hermes-main-w0.0']));
    const res = await fleet.injectGoal('hermes-main-w0.0', 'do something');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/protected/);
    expect(transport.injected.length).toBe(0); // nothing was pasted
  });

  it('refuses to enqueue a goal for a protected pane (throws)', () => {
    const { fleet } = build(new Set(['hermes-main-w0.0']));
    expect(() => fleet.enqueueGoal('hermes-main-w0.0', 'x')).toThrow(/protected/);
  });

  it('allows dispatch to a non-protected worker pane', async () => {
    const { fleet, transport } = build(new Set(['hermes-main-w0.0']));
    const res = await fleet.injectGoal('agent-1', 'run the tests');
    expect(res.ok).toBe(true);
    expect(transport.injected.length).toBe(1);
  });

  it('isProtected reflects the protected set', () => {
    const { fleet } = build(new Set(['hermes-main-w0.0']));
    expect(fleet.isProtected('hermes-main-w0.0')).toBe(true);
    expect(fleet.isProtected('agent-1')).toBe(false);
  });
});
