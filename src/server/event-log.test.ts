import { describe, it, expect } from 'vitest';
import { EventJournal } from '../storage/db.js';
import { FleetControl } from '../server/fleet-control.js';
import type { TmuxTransport, ExecResult } from '../driver/types.js';

/** Controllable fake tmux transport matching FleetControl's key scheme. */
class FakeFleetTransport implements TmuxTransport {
  private screens = new Map<string, string>();
  private pending: string | null = null;

  setScreen(host: string, pane: string, text: string): void {
    this.screens.set(`${host}|${pane}`, text);
  }
  private getScreen(host: string, pane: string): string {
    return this.screens.get(`${host}|${pane}`) ?? '';
  }
  exec(host: string, command: string): Promise<ExecResult> {
    const m = command.match(/^tmux paste-buffer -t (.+)$/);
    if (m) {
      const pane = m[1]!;
      this.screens.set(`${host}|${pane}`, this.getScreen(host, pane) + '\n');
    }
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  }
  execWithStdin(_host: string, command: string, input?: string): Promise<ExecResult> {
    if (command.trim() === 'tmux load-buffer -') this.pending = input ?? null;
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  }
  capturePane(host: string, target: string): Promise<string> {
    return Promise.resolve(this.getScreen(host, target));
  }
}

function makeFleet() {
  const journal = new EventJournal(); // :memory:
  return new FleetControl(
    new FakeFleetTransport(),
    journal,
    {
      'agent-1': { host: 'agent-1', pane: '0.0' },
      'agent-2': { host: 'agent-2', pane: '0.0' },
    },
    {
      stuckAfterMs: 1000,
      maxRestartsPerWindow: 3,
      restartWindowMs: 60 * 60 * 1000,
      slots: 7,
      now: () => Date.now(),
    },
  );
}

describe('Event-log (T14) — structured, filterable, exportable', () => {
  it('returns structured operator actions with stable fields', () => {
    const fleet = makeFleet();
    fleet.enqueueGoal('agent-1', 'echo hello');

    const log = fleet.recentAudit(5);
    expect(log.length).toBeGreaterThan(0);
    expect(log.some((e) => e.action === 'enqueue_goal')).toBe(true);
    log.forEach((e) => {
      expect(e).toHaveProperty('ts');
      expect(e).toHaveProperty('actor');
      expect(e).toHaveProperty('action');
      expect(e).toHaveProperty('target');
      expect(e).toHaveProperty('detail');
    });
  });

  it('returns empty array when no actions', () => {
    const fleet = makeFleet();
    expect(fleet.recentAudit(5)).toEqual([]);
  });

  it('filters by agent (matches target OR actor)', () => {
    const fleet = makeFleet();
    fleet.enqueueGoal('agent-1', 'first action for agent-1');
    fleet.enqueueGoal('agent-2', 'first action for agent-2');
    fleet.enqueueGoal('agent-1', 'second action for agent-1');

    const only1 = fleet.recentAudit(50, { agent: 'agent-1' });
    expect(only1.length).toBe(2);
    expect(only1.every((e) => e.target === 'agent-1')).toBe(true);

    const only2 = fleet.recentAudit(50, { agent: 'agent-2' });
    expect(only2.length).toBe(1);
    expect(only2[0]?.target).toBe('agent-2');
  });

  it('filters by event type', () => {
    const fleet = makeFleet();
    fleet.enqueueGoal('agent-1', 'a goal');
    fleet.enqueueGoal('agent-2', 'another goal');

    const enqueues = fleet.recentAudit(50, { type: 'enqueue_goal' });
    expect(enqueues.length).toBe(2);
    expect(enqueues.every((e) => e.action === 'enqueue_goal')).toBe(true);

    const missing = fleet.recentAudit(50, { type: 'no-such-action' });
    expect(missing).toEqual([]);
  });

  it('combines agent + type filters (AND)', () => {
    const fleet = makeFleet();
    fleet.enqueueGoal('agent-1', 'goal one');
    fleet.enqueueGoal('agent-2', 'goal two');

    const both = fleet.recentAudit(50, { agent: 'agent-1', type: 'enqueue_goal' });
    expect(both.length).toBe(1);
    expect(both[0]?.target).toBe('agent-1');
    expect(both[0]?.action).toBe('enqueue_goal');
  });

  it('caps the result to the limit', () => {
    const fleet = makeFleet();
    for (let i = 0; i < 20; i++) fleet.enqueueGoal('agent-1', `goal #${i}`);
    expect(fleet.recentAudit(3).length).toBe(3);
    expect(fleet.recentAudit(500).length).toBe(20);
  });

  it('exports sanitized NDJSON (one JSON object per line)', () => {
    const fleet = makeFleet();
    fleet.enqueueGoal('agent-1', 'export me');

    const ndjson = fleet.exportAuditLog(10);
    const lines = ndjson.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    const parsed = lines.map((l) => JSON.parse(l) as { ts: number; actor: string; action: string; target: string | null });
    expect(parsed.every((o) => typeof o.ts === 'number' && typeof o.actor === 'string')).toBe(true);
    // Sanitized: every line is a self-contained JSON object (no internal state leaked).
    expect(parsed.some((o) => o.action === 'enqueue_goal' && o.target === 'agent-1')).toBe(true);
  });
});
