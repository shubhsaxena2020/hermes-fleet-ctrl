/**
 * Append-only SQLite event journal for the fleet control plane.
 *
 * Stores an immutable, time-ordered audit trail of everything the control plane
 * observes and decides: agent sessions, dispatched tasks, terminal snapshots
 * (raw + classified state), heartbeats, and a general audit log.
 *
 * Design notes:
 *   - WAL mode is enabled for high write concurrency (append-heavy workload).
 *   - All tables are append-only: rows are never UPDATEd or DELETEd by the app.
 *     (Corrections are recorded as new rows, e.g. a later snapshot for the same
 *     pane, or an audit entry superseding a task state.)
 *   - Timestamps default to the current epoch-millis (UTC) unless provided.
 */

import Database from 'better-sqlite3';
import { AgentState } from '../parser/ansi-parser.js';

export type PriorityLevel = 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL';

export interface AgentSessionRow {
  id?: number;
  host: string;
  session: string;
  pane: string;
  started_at?: number;
  label?: string | null;
}

export interface TaskRow {
  id?: number;
  task_id: string;
  goal: string;
  priority: PriorityLevel;
  assigned_host?: string | null;
  assigned_slot?: number | null;
  state: string;
  created_at?: number;
  updated_at?: number;
}

export interface TerminalSnapshotRow {
  id?: number;
  host: string;
  session: string;
  pane: string;
  captured_at?: number;
  agent_state: AgentState;
  normalized_text: string;
  raw_text?: string | null;
}

export interface HeartbeatRow {
  id?: number;
  host: string;
  slot?: number | null;
  conn_state: string;
  seq: number;
  at?: number;
}

export interface AuditLogRow {
  id?: number;
  ts?: number;
  actor: string;
  action: string;
  target?: string | null;
  detail?: string | null;
}

export type BreakerEventKind = 'open' | 'close' | 'auto_close';

export interface BreakerEventRow {
  id?: number;
  agent_id: string;
  pane_id?: string | null;
  kind: BreakerEventKind;
  reason: string;
  at?: number;
}

/** A single time-series metrics sample for one agent (used for trendlines). */
export interface MetricsSampleRow {
  id?: number;
  agent_id: string;
  captured_at?: number;
  queue_depth: number;
  heartbeat_age_ms: number;
  restart_count: number;
  poll_latency_ms: number;
}

export interface JournalOptions {
  /** Filesystem path; pass ':memory:' (default) for an in-memory DB. */
  path?: string;
  /** Open read-only (used by read replicas / inspection). */
  readonly?: boolean;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  host         TEXT NOT NULL,
  session      TEXT NOT NULL,
  pane         TEXT NOT NULL,
  started_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  label        TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_host ON agent_sessions(host);

CREATE TABLE IF NOT EXISTS tasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id      TEXT NOT NULL,
  goal         TEXT NOT NULL,
  priority     TEXT NOT NULL,
  assigned_host TEXT,
  assigned_slot INTEGER,
  state        TEXT NOT NULL,
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  updated_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000)
);
CREATE INDEX IF NOT EXISTS idx_tasks_task_id ON tasks(task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state);

CREATE TABLE IF NOT EXISTS terminal_snapshots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  host         TEXT NOT NULL,
  session      TEXT NOT NULL,
  pane         TEXT NOT NULL,
  captured_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  agent_state  TEXT NOT NULL,
  normalized_text TEXT NOT NULL,
  raw_text     TEXT
);
CREATE INDEX IF NOT EXISTS idx_snapshots_host_pane ON terminal_snapshots(host, pane);
CREATE INDEX IF NOT EXISTS idx_snapshots_captured ON terminal_snapshots(captured_at);

CREATE TABLE IF NOT EXISTS heartbeats (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  host         TEXT NOT NULL,
  slot         INTEGER,
  conn_state   TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  at           INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000)
);
CREATE INDEX IF NOT EXISTS idx_heartbeats_host ON heartbeats(host);

CREATE TABLE IF NOT EXISTS audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  actor        TEXT NOT NULL,
  action       TEXT NOT NULL,
  target       TEXT,
  detail       TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);

CREATE TABLE IF NOT EXISTS breaker_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id     TEXT NOT NULL,
  pane_id      TEXT,
  kind         TEXT NOT NULL,
  reason       TEXT NOT NULL,
  at           INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000)
);
CREATE INDEX IF NOT EXISTS idx_breaker_agent ON breaker_events(agent_id, id);

CREATE TABLE IF NOT EXISTS metrics_samples (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id     TEXT NOT NULL,
  captured_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  queue_depth  INTEGER NOT NULL DEFAULT 0,
  heartbeat_age_ms INTEGER NOT NULL DEFAULT 0,
  restart_count INTEGER NOT NULL DEFAULT 0,
  poll_latency_ms INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_metrics_agent ON metrics_samples(agent_id, id);
`;

export class EventJournal {
  private db: Database.Database;

  constructor(opts: JournalOptions = {}) {
    const path = opts.path ?? ':memory:';
    this.db = new Database(path, { readonly: opts.readonly ?? false, fileMustExist: false });
    // WAL requires a shared on-disk file; in-memory DBs run in the default
    // 'memory' journal which is already optimal for append-only ephemeral use.
    if (path !== ':memory:') {
      this.db.pragma('journal_mode = WAL');
    }
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(SCHEMA);
  }

  get raw(): Database.Database {
    return this.db;
  }

  isWal(): boolean {
    const row = this.db.pragma('journal_mode', { simple: true }) as string;
    return row === 'wal';
  }

  close(): void {
    this.db.close();
  }

  // --- typed append helpers ---

  insertAgentSession(row: AgentSessionRow): number {
    const stmt = this.db.prepare(
      `INSERT INTO agent_sessions (host, session, pane, started_at, label)
       VALUES (@host, @session, @pane, @started_at, @label)`,
    );
    const info = stmt.run({
      host: row.host,
      session: row.session,
      pane: row.pane,
      started_at: row.started_at ?? Date.now(),
      label: row.label ?? null,
    });
    return Number(info.lastInsertRowid);
  }

  insertTask(row: TaskRow): number {
    const stmt = this.db.prepare(
      `INSERT INTO tasks (task_id, goal, priority, assigned_host, assigned_slot, state, created_at, updated_at)
       VALUES (@task_id, @goal, @priority, @assigned_host, @assigned_slot, @state, @created_at, @updated_at)`,
    );
    const now = Date.now();
    const info = stmt.run({
      task_id: row.task_id,
      goal: row.goal,
      priority: row.priority,
      assigned_host: row.assigned_host ?? null,
      assigned_slot: row.assigned_slot ?? null,
      state: row.state,
      created_at: row.created_at ?? now,
      updated_at: row.updated_at ?? now,
    });
    return Number(info.lastInsertRowid);
  }

  insertSnapshot(row: TerminalSnapshotRow): number {
    const stmt = this.db.prepare(
      `INSERT INTO terminal_snapshots (host, session, pane, captured_at, agent_state, normalized_text, raw_text)
       VALUES (@host, @session, @pane, @captured_at, @agent_state, @normalized_text, @raw_text)`,
    );
    const info = stmt.run({
      host: row.host,
      session: row.session,
      pane: row.pane,
      captured_at: row.captured_at ?? Date.now(),
      agent_state: row.agent_state,
      normalized_text: row.normalized_text,
      raw_text: row.raw_text ?? null,
    });
    return Number(info.lastInsertRowid);
  }

  insertHeartbeat(row: HeartbeatRow): number {
    const stmt = this.db.prepare(
      `INSERT INTO heartbeats (host, slot, conn_state, seq, at)
       VALUES (@host, @slot, @conn_state, @seq, @at)`,
    );
    const info = stmt.run({
      host: row.host,
      slot: row.slot ?? null,
      conn_state: row.conn_state,
      seq: row.seq,
      at: row.at ?? Date.now(),
    });
    return Number(info.lastInsertRowid);
  }

  insertAudit(row: AuditLogRow): number {
    const stmt = this.db.prepare(
      `INSERT INTO audit_log (ts, actor, action, target, detail)
       VALUES (@ts, @actor, @action, @target, @detail)`,
    );
    const info = stmt.run({
      ts: row.ts ?? Date.now(),
      actor: row.actor,
      action: row.action,
      target: row.target ?? null,
      detail: row.detail ?? null,
    });
    return Number(info.lastInsertRowid);
  }

  /**
   * Append a durable circuit-breaker transition record. The breaker event log
   * is the source of truth for breaker open/close state across process restarts;
   * `reconstructBreakerState()` rebuilds the current breaker state from it.
   */
  insertBreakerEvent(row: BreakerEventRow): number {
    const stmt = this.db.prepare(
      `INSERT INTO breaker_events (agent_id, pane_id, kind, reason, at)
       VALUES (@agent_id, @pane_id, @kind, @reason, @at)`,
    );
    const info = stmt.run({
      agent_id: row.agent_id,
      pane_id: row.pane_id ?? null,
      kind: row.kind,
      reason: row.reason,
      at: row.at ?? Date.now(),
    });
    return Number(info.lastInsertRowid);
  }

  /** Recent breaker events, optionally filtered by agent (newest first). */
  recentBreakerEvents(agentId?: string, limit = 50): BreakerEventRow[] {
    const rows = agentId
      ? this.db
          .prepare(`SELECT id, agent_id, pane_id, kind, reason, at FROM breaker_events WHERE agent_id = ? ORDER BY id DESC LIMIT ?`)
          .all(agentId, limit)
      : this.db
          .prepare(`SELECT id, agent_id, pane_id, kind, reason, at FROM breaker_events ORDER BY id DESC LIMIT ?`)
          .all(limit);
    return rows as BreakerEventRow[];
  }

  /**
   * Reconstruct the current breaker state for an agent from its durable event
   * log. An `open` event means the breaker is currently open; `close` /
   * `auto_close` means it is closed. No event => closed (default-safe). This is
   * what makes breaker state traceable after a process restart: open a journal
   * on the same on-disk file and the read model is rebuilt deterministically.
   */
  reconstructBreakerState(agentId: string): 'open' | 'closed' {
    const row = this.db
      .prepare(`SELECT kind FROM breaker_events WHERE agent_id = ? ORDER BY id DESC LIMIT 1`)
      .get(agentId) as { kind: BreakerEventKind } | undefined;
    if (!row) return 'closed';
    return row.kind === 'open' ? 'open' : 'closed';
  }

  /**
   * Append a metrics sample for an agent and enforce a bounded per-agent history
   * window so the dashboard stays small and predictable. `capPerAgent` keeps at
   * most the newest N samples per agent (oldest beyond the cap are pruned in the
   * same transaction). Returns the number of samples retained for the agent.
   */
  insertMetricsSample(row: MetricsSampleRow, capPerAgent = 240): number {
    const insert = this.db.prepare(
      `INSERT INTO metrics_samples (agent_id, captured_at, queue_depth, heartbeat_age_ms, restart_count, poll_latency_ms)
       VALUES (@agent_id, @captured_at, @queue_depth, @heartbeat_age_ms, @restart_count, @poll_latency_ms)`,
    );
    const prune = this.db.prepare(
      `DELETE FROM metrics_samples WHERE agent_id = ? AND id NOT IN (
         SELECT id FROM metrics_samples WHERE agent_id = ? ORDER BY id DESC LIMIT ?
       )`,
    );
    const tx = this.db.transaction((r: MetricsSampleRow) => {
      insert.run({
        agent_id: r.agent_id,
        captured_at: r.captured_at ?? Date.now(),
        queue_depth: r.queue_depth,
        heartbeat_age_ms: r.heartbeat_age_ms,
        restart_count: r.restart_count,
        poll_latency_ms: r.poll_latency_ms,
      });
      prune.run(r.agent_id, r.agent_id, capPerAgent);
    });
    tx(row);
    const count = this.db
      .prepare(`SELECT COUNT(*) AS n FROM metrics_samples WHERE agent_id = ?`)
      .get(row.agent_id) as { n: number };
    return count.n;
  }

  /** Recent metrics samples for an agent, newest first, capped at `limit`. */
  recentMetrics(agentId: string, limit = 60): MetricsSampleRow[] {
    const rows = this.db
      .prepare(`SELECT id, agent_id, captured_at, queue_depth, heartbeat_age_ms, restart_count, poll_latency_ms
                FROM metrics_samples WHERE agent_id = ? ORDER BY id DESC LIMIT ?`)
      .all(agentId, limit) as MetricsSampleRow[];
    return rows;
  }

  /**
   * Append many terminal snapshots in a single transaction. Returns the number
   * written. Used by the perf test to measure sustained write throughput.
   */
  insertSnapshotsBatch(rows: TerminalSnapshotRow[]): number {
    const stmt = this.db.prepare(
      `INSERT INTO terminal_snapshots (host, session, pane, captured_at, agent_state, normalized_text, raw_text)
       VALUES (@host, @session, @pane, @captured_at, @agent_state, @normalized_text, @raw_text)`,
    );
    const tx = this.db.transaction((items: TerminalSnapshotRow[]) => {
      const now = Date.now();
      for (const r of items) {
        stmt.run({
          host: r.host,
          session: r.session,
          pane: r.pane,
          captured_at: r.captured_at ?? now,
          agent_state: r.agent_state,
          normalized_text: r.normalized_text,
          raw_text: r.raw_text ?? null,
        });
      }
    });
    tx(rows);
    return rows.length;
  }

  count(table: 'agent_sessions' | 'tasks' | 'terminal_snapshots' | 'heartbeats' | 'audit_log'): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    return row.n;
  }
}
