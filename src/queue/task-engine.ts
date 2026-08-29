/**
 * Priority task queue & atomic lease allocator for the fleet control plane.
 *
 * Responsibilities:
 *   - Hold a queue of goal-tasks with priority levels (LOW < NORMAL < HIGH < CRITICAL).
 *   - Enforce dependency chains: a task is only runnable once all its deps are COMPLETED.
 *   - Atomically lease the best runnable task to an available agent slot. The lease
 *     decision runs inside a single-flight async mutex, so concurrent `acquire()`
 *     calls from many slots can NEVER double-assign the same task.
 *   - Enforce a global slot cap: at most `slots` tasks may be leased at once.
 *   - Reclaim leases that exceed their execution timeout.
 *
 * State machine (per task): PENDING -> LEASED -> (COMPLETED | FAILED | TIMED_OUT).
 * Transitions are also appended to the EventJournal (audit_log) for durability.
 */

import { EventJournal, type PriorityLevel } from '../storage/db.js';

export type TaskState = 'PENDING' | 'LEASED' | 'COMPLETED' | 'FAILED' | 'TIMED_OUT';

export interface TaskSpec {
  taskId: string;
  goal: string;
  priority: PriorityLevel;
  /** TaskIds that must COMPLETE before this task becomes runnable. */
  dependsOn?: string[];
  /** Execution timeout in ms (0 / undefined = no timeout). */
  timeoutMs?: number;
}

interface Task extends TaskSpec {
  state: TaskState;
  seq: number; // enqueue order, for FIFO tie-break
  leasedTo: number | undefined;
  leasedAt: number | undefined;
  deadline: number | null;
}

export interface Lease {
  taskId: string;
  slot: number;
  leasedAt: number;
  deadline: number | null;
}

export interface TaskEngineOptions {
  slots: number;
  journal?: EventJournal | null;
  /** Injectable clock (ms). Defaults to Date.now. */
  now?: () => number;
  /** Enable an automatic background reaper that reclaims timed-out leases. */
  autoReap?: boolean;
  /** Reaper poll interval ms (only used when autoReap is true). */
  reapIntervalMs?: number;
}

const PRIORITY_RANK: Record<PriorityLevel, number> = {
  LOW: 0,
  NORMAL: 1,
  HIGH: 2,
  CRITICAL: 3,
};

export class TaskEngine {
  private readonly slots: number;
  private readonly journal: EventJournal | null;
  private readonly now: () => number;
  private readonly tasks = new Map<string, Task>();
  private seqCounter = 0;
  private leaseCount = 0;
  private reapTimer: ReturnType<typeof setTimeout> | null = null;

  // Single-flight async mutex: serializes every state-mutating operation so that
  // concurrent acquire()/complete() calls cannot interleave mid-decision.
  private mutexChain: Promise<unknown> = Promise.resolve();

  constructor(opts: TaskEngineOptions) {
    if (!Number.isInteger(opts.slots) || opts.slots < 1) {
      throw new Error('TaskEngine.slots must be a positive integer');
    }
    this.slots = opts.slots;
    this.journal = opts.journal ?? null;
    this.now = opts.now ?? Date.now;
    if (opts.autoReap) {
      this.reapTimer = setInterval(() => {
        void this.expireLeases();
      }, opts.reapIntervalMs ?? 1000);
      // Don't keep the process alive just for the reaper.
      if (typeof this.reapTimer.unref === 'function') this.reapTimer.unref();
    }
  }

  private withLock<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.mutexChain.then(() => Promise.resolve().then(fn), () => Promise.resolve().then(fn));
    // Ensure the chain always settles so a rejected fn doesn't poison future ops.
    this.mutexChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Enqueue one task. Returns false if the id already exists. */
  enqueue(spec: TaskSpec): boolean {
    if (this.tasks.has(spec.taskId)) return false;
    const task: Task = {
      ...spec,
      dependsOn: spec.dependsOn ?? [],
      state: 'PENDING',
      seq: this.seqCounter++,
      leasedTo: undefined,
      leasedAt: undefined,
      deadline: null,
    };
    this.tasks.set(spec.taskId, task);
    this.journal?.insertAudit({ actor: 'scheduler', action: 'enqueue', target: spec.taskId, detail: spec.priority });
    return true;
  }

  /** True if all dependencies are COMPLETED (empty deps => true). */
  private depsSatisfied(task: Task): boolean {
    for (const dep of task.dependsOn ?? []) {
      const d = this.tasks.get(dep);
      if (!d || d.state !== 'COMPLETED') return false;
    }
    return true;
  }

  private pickRunnable(): Task | null {
    let best: Task | null = null;
    for (const t of this.tasks.values()) {
      if (t.state !== 'PENDING') continue;
      if (!this.depsSatisfied(t)) continue;
      if (!best) {
        best = t;
        continue;
      }
      const rank = PRIORITY_RANK[t.priority] - PRIORITY_RANK[best.priority];
      if (rank > 0 || (rank === 0 && t.seq < best.seq)) best = t;
    }
    return best;
  }

  /**
   * Atomically lease the best runnable task to `slot`. Returns the lease, or null
   * if the slot is already occupied, the engine is at capacity, or nothing is
   * runnable. Two concurrent acquire() calls can never receive the same task.
   */
  acquire(slot: number): Promise<Lease | null> {
    return this.withLock(() => {
      // A slot may hold at most one lease at a time.
      for (const t of this.tasks.values()) {
        if (t.state === 'LEASED' && t.leasedTo === slot) return null;
      }
      if (this.leaseCount >= this.slots) return null;
      const task = this.pickRunnable();
      if (!task) return null;

      const leasedAt = this.now();
      task.state = 'LEASED';
      task.leasedTo = slot;
      task.leasedAt = leasedAt;
      task.deadline = task.timeoutMs && task.timeoutMs > 0 ? leasedAt + task.timeoutMs : null;
      this.leaseCount += 1;
      this.journal?.insertAudit({ actor: 'scheduler', action: 'lease', target: task.taskId, detail: `slot=${slot}` });
      const lease: Lease = {
        taskId: task.taskId,
        slot,
        leasedAt,
        deadline: task.deadline ?? null,
      };
      return lease;
    });
  }

  /** Mark a leased task COMPLETED (or FAILED) and free its slot. */
  complete(taskId: string, outcome: 'COMPLETED' | 'FAILED' = 'COMPLETED'): Promise<boolean> {
    return this.withLock(() => {
      const task = this.tasks.get(taskId);
      if (!task || task.state !== 'LEASED') return false;
      task.state = outcome;
      this.leaseCount = Math.max(0, this.leaseCount - 1);
      task.leasedTo = undefined;
      this.journal?.insertAudit({ actor: 'worker', action: outcome.toLowerCase(), target: taskId });
      return true;
    });
  }

  /**
   * Reclaim leases that have exceeded their execution timeout. Returns the taskIds
   * that were reclaimed (moved back to PENDING so they can be re-leased).
   */
  expireLeases(): Promise<string[]> {
    return this.withLock(() => {
      const now = this.now();
      const expired: string[] = [];
      for (const t of this.tasks.values()) {
        if (t.state !== 'LEASED') continue;
        if (t.deadline != null && now >= t.deadline) {
          t.state = 'PENDING';
          t.leasedTo = undefined;
          this.leaseCount = Math.max(0, this.leaseCount - 1);
          expired.push(t.taskId);
          this.journal?.insertAudit({ actor: 'scheduler', action: 'timeout', target: t.taskId });
        }
      }
      return expired;
    });
  }

  /** Number of tasks currently leased (occupied slots). */
  activeCount(): number {
    return this.leaseCount;
  }

  /** Snapshot of task states (for inspection / TUI). */
  snapshot(): Array<{ taskId: string; state: TaskState; priority: PriorityLevel; leasedTo: number | undefined }> {
    return [...this.tasks.values()].map((t) => ({
      taskId: t.taskId,
      state: t.state,
      priority: t.priority,
      leasedTo: t.leasedTo,
    }));
  }

  close(): void {
    if (this.reapTimer) {
      clearInterval(this.reapTimer);
      this.reapTimer = null;
    }
  }
}
