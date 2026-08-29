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
