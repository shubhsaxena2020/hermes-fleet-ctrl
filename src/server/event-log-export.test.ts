import { describe, it, expect } from 'vitest';
import { EventJournal } from '../storage/db.js';
import { FleetControl } from '../server/fleet-control.js';
import type { TmuxTransport } from '../driver/types.js';

/**
 * Phase B (BACKLOG B9): deepen coverage of the TUI/operator event-log export
 * path (exportAuditLog -> NDJSON). event-log.test.ts covers the happy path and
 * basic shape; here we cover the empty case, filtered export, and strict
 * JSON validity / sanitization of every emitted line.
 */
class FakeFleetTransport implements TmuxTransport {
  private screens = new Map<string, string>();
  setScreen(host: string, pane: string, text: string): void {
    this.screens.set(`${host}|${pane}`, text);
  }
  exec(): Promise<{ code: number; stdout: string; stderr: string }> {
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  }
  execWithStdin(): Promise<{ code: number; stdout: string; stderr: string }> {
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  }
  capturePane(host: string, target: string): Promise<string> {
    return Promise.resolve(this.screens.get(`${host}|${target}`) ?? '');
  }
}

function makeFleet() {
  const journal = new EventJournal();
  return new FleetControl(
    new FakeFleetTransport(),
    journal,
    { 'agent-1': { host: 'agent-1', pane: '0.0' }, 'agent-2': { host: 'agent-2', pane: '0.0' } },
    { stuckAfterMs: 1000, slots: 1, now: () => Date.now() },
  );
}

function parseNdjson(ndjson: string): Array<Record<string, unknown>> {
  const lines = ndjson.split('\n').filter((l) => l.length > 0);
  return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('Event-log NDJSON export (B9)', () => {
  it('returns an empty string when there is nothing to export', () => {
    const fleet = makeFleet();
    expect(fleet.exportAuditLog(50)).toBe('');
  });

  it('emits one valid JSON object per line, each with the stable public fields', () => {
    const fleet = makeFleet();
    fleet.enqueueGoal('agent-1', 'first');
    fleet.enqueueGoal('agent-2', 'second');
    fleet.enqueueGoal('agent-1', 'third');

    const rows = parseNdjson(fleet.exportAuditLog(50));
    expect(rows.length).toBe(3);
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(['action', 'actor', 'detail', 'target', 'ts']);
      expect(typeof r.ts).toBe('number');
      expect(typeof r.actor).toBe('string');
      expect(typeof r.action).toBe('string');
    }
  });

  it('sanitizes: never leaks internal-only fields (e.g. id, raw_text)', () => {
    const fleet = makeFleet();
    fleet.enqueueGoal('agent-1', 'secret-detail-ok');
    const rows = parseNdjson(fleet.exportAuditLog(10));
    const flat = JSON.stringify(rows);
    expect(flat).not.toContain('"id"');
    expect(flat).not.toContain('raw_text');
    expect(flat).toContain('agent-1'); // target is exposed (operator-relevant)
  });

  it('honors the limit (caps exported lines)', () => {
    const fleet = makeFleet();
    for (let i = 0; i < 20; i++) fleet.enqueueGoal('agent-1', `goal #${i}`);
    const rows = parseNdjson(fleet.exportAuditLog(3));
    expect(rows.length).toBe(3);
  });

  it('export can be filtered by agent (agent=...), matching the recentAudit filter', () => {
    const fleet = makeFleet();
    fleet.enqueueGoal('agent-1', 'a1');
    fleet.enqueueGoal('agent-2', 'a2');
    fleet.enqueueGoal('agent-1', 'a1 again');

    const only1 = parseNdjson(fleet.exportAuditLog(50, { agent: 'agent-1' }));
    expect(only1.length).toBe(2);
    expect(only1.every((r) => r.target === 'agent-1')).toBe(true);

    const only2 = parseNdjson(fleet.exportAuditLog(50, { agent: 'agent-2' }));
    expect(only2.length).toBe(1);
    expect(only2[0]?.target).toBe('agent-2');
  });
});
