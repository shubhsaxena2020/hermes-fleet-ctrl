import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventJournal } from './db.js';

/**
 * Phase B (BACKLOG B7): the metrics-history store must survive a process
 * restart. We prove this by writing samples with one EventJournal instance,
 * closing it, then reopening the SAME on-disk file with a fresh instance and
 * reading the samples back. WAL + synchronous=NORMAL make the writes durable
 * across the close/reopen boundary.
 */

describe('Metrics-history store survives restart (B7)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-metrics-'));
  const dbPath = join(dir, 'journal.db');

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists and reloads metrics samples across a close/reopen cycle', () => {
    expect(existsSync(dbPath)).toBe(false);

    // Session 1: write samples, then fully close.
    const w = new EventJournal({ path: dbPath });
    for (let i = 0; i < 25; i++) {
      w.insertMetricsSample({
        agent_id: 'agent-1',
        captured_at: 1_000_000 + i,
        queue_depth: i,
        heartbeat_age_ms: i * 10,
        restart_count: 0,
        poll_latency_ms: 1,
      });
    }
    expect(w.recentMetrics('agent-1', 100).length).toBe(25);
    w.close();

    // Session 2: brand-new instance on the same file.
    const r = new EventJournal({ path: dbPath });
    const samples = r.recentMetrics('agent-1', 100);
    expect(samples.length).toBe(25);
    expect(samples[0]?.captured_at).toBe(1_000_000 + 24); // newest first
    expect(samples[samples.length - 1]?.captured_at).toBe(1_000_000); // oldest last
    r.close();

    // And the file genuinely exists on disk (durable, not :memory:).
    expect(existsSync(dbPath)).toBe(true);
  });

  it('persists breaker + audit events across restart (durable state of record)', () => {
    const p = join(dir, 'journal2.db');
    const w = new EventJournal({ path: p });
    w.insertBreakerEvent({ agent_id: 'agent-2', kind: 'open', reason: 'restart_budget_exhausted', at: 42 });
    w.insertAudit({ actor: 'guardian', action: 'breaker_tripped', target: 'agent-2', detail: 'x' });
    w.close();

    const r = new EventJournal({ path: p });
    expect(r.reconstructBreakerState('agent-2')).toBe('open');
    expect(r.recentBreakerEvents('agent-2').length).toBe(1);
    const auditRows = r.raw.prepare('SELECT action FROM audit_log WHERE target = ?').all('agent-2') as Array<{ action: string }>;
    expect(auditRows.some((e) => e.action === 'breaker_tripped')).toBe(true);
    r.close();
  });
});
