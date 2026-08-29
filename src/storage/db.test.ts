import { describe, it, expect, afterEach } from 'vitest';
import { EventJournal, type TerminalSnapshotRow } from './db.js';
import { AgentState } from '../parser/ansi-parser.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const journals: EventJournal[] = [];
const tmpFiles: string[] = [];
function makeJournal(path?: string): EventJournal {
  const j = new EventJournal(path ? { path } : { path: ':memory:' });
  journals.push(j);
  return j;
}
function makeTempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-db-')); // dir, not file
  const file = join(dir, 'journal.sqlite3');
  tmpFiles.push(dir);
  return file;
}
afterEach(() => {
  for (const j of journals) j.close();
  journals.length = 0;
  for (const d of tmpFiles) rmSync(d, { recursive: true, force: true });
  tmpFiles.length = 0;
});

describe('EventJournal — schema & WAL', () => {
  it('creates all five append-only tables', () => {
    const j = makeJournal();
    for (const t of ['agent_sessions', 'tasks', 'terminal_snapshots', 'heartbeats', 'audit_log']) {
      const row = j.raw.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(t);
      expect(row, `table ${t} missing`).toBeTruthy();
      expect(j.count(t as never)).toBe(0);
    }
  });

  it('enables WAL mode on an on-disk database', () => {
    const file = makeTempDb();
    const j = makeJournal(file);
    expect(j.isWal()).toBe(true);
    const mode = j.raw.pragma('journal_mode', { simple: true });
    expect(mode).toBe('wal');
  });
});

describe('EventJournal — typed appends', () => {
  it('inserts an agent session and reads it back', () => {
    const j = makeJournal();
    const id = j.insertAgentSession({ host: 'h1', session: 's0', pane: '0.0', label: 'agent-1' });
    expect(id).toBeGreaterThan(0);
    const row = j.raw.prepare('SELECT * FROM agent_sessions WHERE id=?').get(id) as { host: string; label: string };
    expect(row.host).toBe('h1');
    expect(row.label).toBe('agent-1');
  });

  it('inserts a task with default created/updated timestamps', () => {
    const j = makeJournal();
    const id = j.insertTask({ task_id: 'T-1', goal: 'fix bug', priority: 'HIGH', state: 'queued' });
    const row = j.raw.prepare('SELECT * FROM tasks WHERE id=?').get(id) as {
      task_id: string;
      priority: string;
      created_at: number;
      updated_at: number;
    };
    expect(row.task_id).toBe('T-1');
    expect(row.priority).toBe('HIGH');
    expect(row.created_at).toBeGreaterThan(0);
    expect(row.updated_at).toBeGreaterThan(0);
  });

  it('inserts a terminal snapshot capturing AgentState', () => {
    const j = makeJournal();
    const id = j.insertSnapshot({
      host: 'h1',
      session: 's0',
      pane: '0.0',
      agent_state: AgentState.RUNNING_COMMAND,
      normalized_text: 'npm test',
      raw_text: '\x1b[32mnpm test\x1b[0m',
    });
    const row = j.raw.prepare('SELECT * FROM terminal_snapshots WHERE id=?').get(id) as {
      agent_state: string;
      normalized_text: string;
      raw_text: string | null;
    };
    expect(row.agent_state).toBe('RUNNING_COMMAND');
    expect(row.normalized_text).toBe('npm test');
    expect(row.raw_text).toContain('npm test');
  });

  it('inserts heartbeats and audit entries', () => {
    const j = makeJournal();
    expect(j.insertHeartbeat({ host: 'h1', slot: 2, conn_state: 'ready', seq: 7 })).toBeGreaterThan(0);
    expect(j.count('heartbeats')).toBe(1);
    expect(j.insertAudit({ actor: 'scheduler', action: 'dispatch', target: 'T-1', detail: 'assigned h1' })).toBeGreaterThan(0);
    expect(j.count('audit_log')).toBe(1);
  });

  it('keeps an immutable append-only trail (old snapshots retained)', () => {
    const j = makeJournal();
    j.insertSnapshot({ host: 'h1', session: 's0', pane: '0.0', agent_state: AgentState.ACTIVE_THINKING, normalized_text: 'thinking' });
    j.insertSnapshot({ host: 'h1', session: 's0', pane: '0.0', agent_state: AgentState.RUNNING_COMMAND, normalized_text: 'running' });
    // both snapshots are preserved (no UPDATE-in-place); newest wins by id when read back.
    expect(j.count('terminal_snapshots')).toBe(2);
    const latest = j.raw
      .prepare('SELECT agent_state FROM terminal_snapshots WHERE host=? ORDER BY id DESC LIMIT 1')
      .get('h1') as { agent_state: string };
    expect(latest.agent_state).toBe('RUNNING_COMMAND');
  });
});

describe('EventJournal — write throughput (>1000 events/sec)', () => {
  it('sustains >1000 snapshot appends per second (batched, on-disk WAL)', () => {
    const file = makeTempDb();
    const j = makeJournal(file);
    const N = 5000;
    const rows: TerminalSnapshotRow[] = Array.from({ length: N }, (_, i) => ({
      host: `h${i % 8}`,
      session: 's0',
      pane: '0.0',
      agent_state: AgentState.IDLE,
      normalized_text: `snapshot-${i}`,
    }));
    const start = Date.now();
    const written = j.insertSnapshotsBatch(rows);
    const elapsedMs = Date.now() - start;
    const perSec = (written / elapsedMs) * 1000;
    expect(written).toBe(N);
    expect(perSec, `throughput ${perSec.toFixed(0)}/s < 1000/s`).toBeGreaterThan(1000);
  });
});

describe('EventJournal — durable circuit-breaker event record (T4)', () => {
  it('records open/close/auto_close transitions and reconstructs current state', () => {
    const j = makeJournal();
    expect(j.reconstructBreakerState('agent-1')).toBe('closed'); // default-safe
    j.insertBreakerEvent({ agent_id: 'agent-1', pane_id: '1.0', kind: 'open', reason: 'restart_budget_exhausted', at: 1000 });
    expect(j.reconstructBreakerState('agent-1')).toBe('open');
    j.insertBreakerEvent({ agent_id: 'agent-1', pane_id: '1.0', kind: 'auto_close', reason: 'auto_close_window_drained_heartbeat', at: 2000 });
    expect(j.reconstructBreakerState('agent-1')).toBe('closed');
    const recent = j.recentBreakerEvents('agent-1', 10);
    expect(recent).toHaveLength(2);
    expect(recent[0]?.kind).toBe('auto_close'); // newest first
  });

  it('replay survives a process restart (new journal on the same on-disk file)', () => {
    const file = makeTempDb();
    const writer = makeJournal(file);
    writer.insertBreakerEvent({ agent_id: 'agent-9', pane_id: '1.5', kind: 'open', reason: 'restart_budget_exhausted', at: 5000 });
    writer.insertBreakerEvent({ agent_id: 'agent-9', pane_id: '1.5', kind: 'auto_close', reason: 'auto_close_window_drained_heartbeat', at: 9000 });
    writer.close(); // "process exits"

    // A fresh journal opens the SAME file and rebuilds the read model.
    const reader = makeJournal(file);
    expect(reader.reconstructBreakerState('agent-9')).toBe('closed');
    const events = reader.recentBreakerEvents('agent-9');
    expect(events).toHaveLength(2);
    expect(events[1]?.kind).toBe('open'); // oldest first in array order
    // And a brand-new open after restart is appended, flipping state to open.
    reader.insertBreakerEvent({ agent_id: 'agent-9', pane_id: '1.5', kind: 'open', reason: 'restart_budget_exhausted', at: 12000 });
    expect(reader.reconstructBreakerState('agent-9')).toBe('open');
  });
});

describe('EventJournal — metrics history store (T6)', () => {
  it('keeps a bounded per-agent ring buffer of samples', () => {
    const j = makeJournal();
    const cap = 5;
    for (let i = 0; i < 20; i++) {
      const retained = j.insertMetricsSample(
        { agent_id: 'agent-3', queue_depth: i, heartbeat_age_ms: i * 10, restart_count: 0, poll_latency_ms: 1 },
        cap,
      );
      expect(retained).toBeLessThanOrEqual(cap);
    }
    const recent = j.recentMetrics('agent-3', 100);
    expect(recent).toHaveLength(cap); // strictly bounded
    // newest first; the newest sample reflects the last insert (queue_depth 19)
    expect(recent[0]?.queue_depth).toBe(19);
  });

  it('isolates history per agent', () => {
    const j = makeJournal();
    j.insertMetricsSample({ agent_id: 'a', queue_depth: 1, heartbeat_age_ms: 0, restart_count: 0, poll_latency_ms: 0 }, 240);
    j.insertMetricsSample({ agent_id: 'b', queue_depth: 2, heartbeat_age_ms: 0, restart_count: 0, poll_latency_ms: 0 }, 240);
    expect(j.recentMetrics('a')).toHaveLength(1);
    expect(j.recentMetrics('b')[0]?.queue_depth).toBe(2);
  });
});
