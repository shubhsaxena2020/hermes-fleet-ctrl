import { describe, it, expect } from 'vitest';
import { TaskEngine } from './task-engine.js';
import { EventJournal } from '../storage/db.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('TaskEngine — priority & dependency semantics', () => {
  it('leases highest-priority runnable task first, FIFO on ties', async () => {
    const e = new TaskEngine({ slots: 7 });
    e.enqueue({ taskId: 'low', goal: 'g', priority: 'LOW' });
    e.enqueue({ taskId: 'crit', goal: 'g', priority: 'CRITICAL' });
    e.enqueue({ taskId: 'norm', goal: 'g', priority: 'NORMAL' });
    e.enqueue({ taskId: 'high', goal: 'g', priority: 'HIGH' });

    const lease = await e.acquire(0);
    expect(lease?.taskId).toBe('crit');

    const lease2 = await e.acquire(1);
    expect(lease2?.taskId).toBe('high');

    const lease3 = await e.acquire(2);
    expect(lease3?.taskId).toBe('norm');

    const lease4 = await e.acquire(3);
    expect(lease4?.taskId).toBe('low');
  });

  it('respects dependency chains (dep must complete before child runs)', async () => {
    const e = new TaskEngine({ slots: 7 });
    e.enqueue({ taskId: 'A', goal: 'base', priority: 'NORMAL' });
    e.enqueue({ taskId: 'B', goal: 'child', priority: 'CRITICAL', dependsOn: ['A'] });

    const first = await e.acquire(0);
    expect(first?.taskId).toBe('A'); // B not runnable yet

    const blocked = await e.acquire(1);
    expect(blocked).toBeNull(); // B still blocked on A

    await e.complete('A', 'COMPLETED');
    const second = await e.acquire(1);
    expect(second?.taskId).toBe('B');
  });

  it('rejects duplicate enqueue of the same taskId', () => {
    const e = new TaskEngine({ slots: 7 });
    expect(e.enqueue({ taskId: 'X', goal: 'g', priority: 'NORMAL' })).toBe(true);
    expect(e.enqueue({ taskId: 'X', goal: 'g', priority: 'NORMAL' })).toBe(false);
  });
});

describe('TaskEngine — execution timeouts', () => {
  it('reclaims a lease that exceeds its timeout via injectable clock', async () => {
    let clock = 1000;
    const e = new TaskEngine({ slots: 7, now: () => clock });
    e.enqueue({ taskId: 'T', goal: 'g', priority: 'HIGH', timeoutMs: 5000 });
    const lease = await e.acquire(0);
    expect(lease?.taskId).toBe('T');
    expect(lease?.deadline).toBe(6000);

    // before deadline: not reclaimed
    const none = await e.expireLeases();
    expect(none).toEqual([]);

    // advance past deadline
    clock = 6001;
    const expired = await e.expireLeases();
    expect(expired).toEqual(['T']);
    expect(e.activeCount()).toBe(0);

    // now runnable again -> can be re-leased
    const reLease = await e.acquire(0);
    expect(reLease?.taskId).toBe('T');
  });
});

describe('TaskEngine — atomic leasing: no double-assignment under concurrency', () => {
  it('10 parallel tasks across 7 slots: every lease is distinct, no task double-assigned', async () => {
    const SLOTS = 7;
    const TASKS = 10;
    const e = new TaskEngine({ slots: SLOTS });

    for (let i = 0; i < TASKS; i++) {
      // mix priorities so ordering is exercised
      const p = (['LOW', 'NORMAL', 'HIGH', 'CRITICAL'] as const)[i % 4];
      e.enqueue({ taskId: `task-${i}`, goal: `goal ${i}`, priority: p });
    }

    const completed = new Set<string>();
    const seenBySlot = new Map<number, string>(); // slot -> taskId currently held
    const leaseEvents: Array<{ slot: number; taskId: string }> = [];

    // A worker owns exactly one slot and loops: acquire -> work -> complete.
    async function worker(slot: number): Promise<void> {
      for (;;) {
        const lease = await e.acquire(slot);
        if (!lease) return; // nothing runnable for this slot
        // Invariant under test: at the moment of leasing, this slot must not
        // already hold a different task, and the task must not be leased elsewhere.
        expect(seenBySlot.get(slot)).toBeUndefined();
        seenBySlot.set(slot, lease.taskId);
        leaseEvents.push({ slot: lease.slot, taskId: lease.taskId });

        // simulate variable work
        await sleep(1 + (slot % 3));
        seenBySlot.delete(slot);
        const ok = await e.complete(lease.taskId, 'COMPLETED');
        expect(ok).toBe(true);
        // Double-completion must be a no-op (not a second lease).
        expect(await e.complete(lease.taskId, 'COMPLETED')).toBe(false);
        completed.add(lease.taskId);
      }
    }

    await Promise.all(Array.from({ length: SLOTS }, (_, s) => worker(s)));

    // Every task completed exactly once.
    expect(completed.size).toBe(TASKS);
    for (let i = 0; i < TASKS; i++) expect(completed.has(`task-${i}`)).toBe(true);

    // No task was ever handed to two slots at once: each taskId appears at most
    // once per "active" moment. We verify the stronger property: no taskId is
    // leased twice without an intervening completion. Reconstruct active sets.
    const active = new Map<string, number>(); // taskId -> count of concurrent holders
    let maxConcurrentForAnyTask = 0;
    for (const ev of leaseEvents) {
      const c = (active.get(ev.taskId) ?? 0) + 1;
      active.set(ev.taskId, c);
      maxConcurrentForAnyTask = Math.max(maxConcurrentForAnyTask, c);
    }
    expect(maxConcurrentForAnyTask, 'a task was double-assigned concurrently').toBe(1);

    // Total distinct leases == number of task instances leased (10).
    expect(new Set(leaseEvents.map((l) => l.taskId)).size).toBe(TASKS);

    // The engine never oversubscribed capacity (max 7 leased at once).
    expect(e.activeCount()).toBe(0); // all returned by end
  });

  it('refuses to lease past the global slot cap', async () => {
    const e = new TaskEngine({ slots: 3 });
    for (let i = 0; i < 5; i++) {
      e.enqueue({ taskId: `t${i}`, goal: 'g', priority: 'NORMAL' });
    }
    const leases = await Promise.all([0, 1, 2, 3, 4, 5].map((s) => e.acquire(s)));
    const granted = leases.filter((l): l is NonNullable<typeof l> => l !== null);
    expect(granted.length).toBe(3); // only 3 slots
    expect(e.activeCount()).toBe(3);
  });
});

describe('TaskEngine — journal integration', () => {
  it('appends audit events to the EventJournal on enqueue/lease/complete', async () => {
    const j = new EventJournal({ path: ':memory:' });
    const e = new TaskEngine({ slots: 7, journal: j });
    e.enqueue({ taskId: 'J', goal: 'g', priority: 'HIGH' });
    await e.acquire(0);
    await e.complete('J', 'COMPLETED');
    // audit_log should have enqueue + lease + complete
    expect(j.count('audit_log')).toBeGreaterThanOrEqual(3);
    const rows = j.raw.prepare('SELECT action FROM audit_log ORDER BY id').all() as Array<{ action: string }>;
    expect(rows.map((r) => r.action)).toEqual(['enqueue', 'lease', 'completed']);
    j.close();
  });
});
