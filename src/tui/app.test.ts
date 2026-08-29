import { describe, it, expect } from 'vitest';
import { EventJournal } from '../storage/db.js';
import { FleetControl } from '../server/fleet-control.js';
import { FleetTui, parseGoalInput, renderLines } from './app.js';
import type { TmuxTransport, ExecResult } from '../driver/types.js';

class FakeTransport implements TmuxTransport {
  private screens = new Map<string, string>();
  setScreen(host: string, pane: string, text: string) {
    this.screens.set(`${host}|${pane}`, text);
  }
  private get(host: string, pane: string) {
    return this.screens.get(`${host}|${pane}`) ?? '';
  }
  exec(host: string, command: string): Promise<ExecResult> {
    const m = command.match(/^tmux paste-buffer -t (.+)$/);
    if (m) {
      const pane = m[1]!;
      this.screens.set(`${host}|${pane}`, this.get(host, pane) + '\n');
    }
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  }
  execWithStdin(_host: string, _command: string): Promise<ExecResult> {
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  }
  capturePane(host: string, target: string): Promise<string> {
    return Promise.resolve(this.get(host, target));
  }
}

function buildFleet(clock: { t: number }) {
  const journal = new EventJournal();
  const transport = new FakeTransport();
  transport.setScreen('agent-1', '0.0', '⠿ working');
  transport.setScreen('agent-2', '0.0', '$ ');
  const fleet = new FleetControl(
    transport,
    journal,
    { 'agent-1': { host: 'agent-1', pane: '0.0' }, 'agent-2': { host: 'agent-2', pane: '0.0' } },
    { stuckAfterMs: 1000, slots: 7, now: () => clock.t },
  );
  return { fleet, transport };
}

describe('TUI (headless) — renderLines, input parsing, dispatch', () => {
  it('renderLines reflects the live fleet model', () => {
    const { fleet } = buildFleet({ t: 1_000_000 });
    const tui = new FleetTui(fleet);
    tui.sync();
    const lines = renderLines(tui.current);
    const text = lines.join('\n');
    expect(text).toContain('agent-1');
    expect(text).toContain('agent-2');
    expect(text).toContain('HERMES FLEET CONTROL');
    expect(text).toContain('TASKS');
    expect(text).toContain('AUDIT');
    // selected marker on the first agent by default
    expect(lines.some((l) => l.includes('▶ 0. agent-1'))).toBe(true);
  });

  it('parseGoalInput handles "agentId: prompt" and bare prompt (uses selection)', () => {
    expect(parseGoalInput('agent-2: deploy now', 'agent-1')).toEqual({ agentId: 'agent-2', prompt: 'deploy now' });
    expect(parseGoalInput('just do it', 'agent-1')).toEqual({ agentId: 'agent-1', prompt: 'just do it' });
    expect(parseGoalInput('   ', 'agent-1')).toBeNull();
    expect(parseGoalInput('no agent selected', undefined)).toBeNull();
  });

  it('dispatchInput enqueues a goal parsed from the input line', () => {
    const { fleet } = buildFleet({ t: 1_000_000 });
    const tui = new FleetTui(fleet);
    tui.sync();
    tui.setInput('agent-2: run the suite');
    const parsed = tui.dispatchInput();
    expect(parsed).toEqual({ agentId: 'agent-2', prompt: 'run the suite' });
    // The goal is now in the queue.
    const queued = fleet.engine.snapshot().some((t) => t.state === 'PENDING');
    expect(queued).toBe(true);
    // Input cleared after dispatch.
    expect(tui.current.input).toBe('');
  });

  it('moveSelection cycles and stays in range; resetSelectedBreaker clears a tripped breaker', () => {
    const clock = { t: 1_000_000 };
    const { fleet } = buildFleet(clock);
    const tui = new FleetTui(fleet);
    tui.sync();
    tui.moveSelection(1);
    expect(tui.current.selected).toBe(1);
    tui.moveSelection(1); // wraps to 0 (2 agents)
    expect(tui.current.selected).toBe(0);
    // Trip agent-1's breaker: advance time so it stays STUCK and exhaust the
    // 3/hr restart budget. Each evaluate that restarts refreshes lastActivity,
    // so we bump the clock forward again before the next evaluate.
    for (let i = 0; i < 4; i++) {
      clock.t += 2000;
      fleet.guardian.evaluate('agent-1');
    }
    tui.sync();
    expect(tui.current.agents.find((a) => a.agentId === 'agent-1')?.breakerOpen).toBe(true);
    tui.moveSelection(0);
    tui.resetSelectedBreaker();
    expect(tui.current.agents.find((a) => a.agentId === 'agent-1')?.breakerOpen).toBe(false);
  });

  it('mount() refuses to open a real terminal when allowBlessed is false', () => {
    const { fleet } = buildFleet({ t: 1_000_000 });
    const tui = new FleetTui(fleet, { allowBlessed: false });
    expect(() => tui.mount()).toThrow(/blessed mount disabled/);
  });
});
