/**
 * FleetControl — the orchestration brain that wires every engine together:
 *
 *   TmuxTransport ──► capture panes ──► ANSI parser (classify state)
 *        │                                     │
 *        ├──────────────► GoalInjector ◄────────┘   (send goals safely)
 *        │                                     │
 *        └──► EventJournal  (append-only audit)    │
 *                                              │
 *   TaskEngine  (priority queue + leases) ──► pump() ──► injectGoal()
 *        │
 *   Guardian  (inactivity / STUCK / restart budget / circuit breaker)
 *        │
 *   EventEmitter  ──► WebSocket subscribers (live control-plane stream)
 *
 * The class is transport-agnostic: pass any `TmuxTransport` (a real `TmuxPool`
 * over SSH, or a mock for tests). All timers are injectable so tests are
 * deterministic — you drive the loop with `tick()` / `pump()` directly.
 */

import { EventEmitter } from 'node:events';
import { classifyPane, AgentState } from '../parser/ansi-parser.js';
import { EventJournal, type PriorityLevel } from '../storage/db.js';
import { TaskEngine } from '../queue/task-engine.js';
import { GoalInjector, type DispatchResult } from '../driver/goal-injector.js';
import { Guardian } from '../watchdog/guardian.js';
import type { TmuxTransport } from '../driver/types.js';

export interface AgentConfig {
  host: string;
  /** tmux target pane, e.g. "agent-0:0.0". */
  pane: string;
}

export interface FleetControlOptions {
  stuckAfterMs: number;
  maxRestartsPerWindow?: number;
  restartWindowMs?: number;
  /** Slots for the task engine (concurrent goal dispatches). */
  slots?: number;
  /** Injected clock (ms). */
  now?: () => number;
  /** Optional operator restart hook (defaults to a safe nudge re-inject). */
  restartAction?: (agentId: string) => void | Promise<void>;
}

export interface AgentView {
  agentId: string;
  state: AgentState;
  lastNormalized: string;
  stuck: boolean;
  breakerOpen: boolean;
  restartsInWindow: number;
}

export type FleetEvent =
  | { type: 'snapshot'; ts: number; agentId: string; state: AgentState; normalized: string; changed: boolean }
  | { type: 'task'; ts: number; action: 'enqueue' | 'lease' | 'complete' | 'fail' | 'timeout'; taskId: string }
  | { type: 'guardian'; ts: number; agentId: string; action: 'restarted' | 'breaker_tripped' }
  | { type: 'audit'; ts: number; actor: string; action: string; detail: string };

/** Goal string format stored on tasks: "agentId\tprompt". */
function encodeGoal(agentId: string, prompt: string): string {
  return `${agentId}\t${prompt}`;
}
function decodeGoal(goal: string): { agentId: string; prompt: string } {
  const tab = goal.indexOf('\t');
  if (tab < 0) return { agentId: goal, prompt: '' };
  return { agentId: goal.slice(0, tab), prompt: goal.slice(tab + 1) };
}

export class FleetControl extends EventEmitter {
  readonly injector: GoalInjector;
  readonly guardian: Guardian;
  readonly engine: TaskEngine;

  private readonly transport: TmuxTransport;
  private readonly journal: EventJournal;
  private readonly agents: Map<string, AgentConfig>;
  private readonly opts: FleetControlOptions;
  private readonly lastNormalized = new Map<string, string>();
  private readonly lastState = new Map<string, AgentState>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    transport: TmuxTransport,
    journal: EventJournal,
    agents: Record<string, AgentConfig>,
    opts: FleetControlOptions,
  ) {
    super();
    this.transport = transport;
    this.journal = journal;
    this.agents = new Map(Object.entries(agents));
    this.opts = opts;
    const now = opts.now ?? Date.now;

    this.injector = new GoalInjector(transport);
    this.guardian = new Guardian({
      stuckAfterMs: opts.stuckAfterMs,
      maxRestartsPerWindow: opts.maxRestartsPerWindow ?? 3,
      windowMs: opts.restartWindowMs ?? 60 * 60 * 1000,
      now,
      restart: (key) => {
        void this.handleRestart(key);
      },
    });
    this.engine = new TaskEngine({ slots: opts.slots ?? 7, now });

    for (const [id, cfg] of this.agents) {
      this.guardian.register(id);
      this.lastState.set(id, AgentState.IDLE);
      this.journal.insertAgentSession({ host: cfg.host, session: id, pane: cfg.pane });
    }
  }

  /** One poll cycle: capture → classify → journal → guardian → emit. */
  async tick(): Promise<void> {
    const now = this.opts.now ? this.opts.now() : Date.now();
    for (const [agentId, cfg] of this.agents) {
      let raw = '';
      try {
        raw = await this.transport.capturePane(cfg.host, cfg.pane, { start: -200, end: -1 });
      } catch {
        raw = '';
      }
      const { state, normalized } = classifyPane(raw);
      const prev = this.lastNormalized.get(agentId) ?? '';
      const changed = normalized !== prev;
      this.lastNormalized.set(agentId, normalized);
      this.lastState.set(agentId, state);
      this.journal.insertSnapshot({
        host: cfg.host,
        session: agentId,
        pane: cfg.pane,
        agent_state: state,
        normalized_text: normalized,
        raw_text: raw,
      });

      // "Alive" = screen produced NEW output, OR the agent is at a clean IDLE
      // resting prompt (waiting for a goal). A frozen ACTIVE pane (unchanged
      // thinking/running screen) does NOT refresh the guardian timer, so a wedged
      // agent that stopped producing output is eventually declared STUCK.
      const alive = changed || state === AgentState.IDLE;
      if (alive) this.guardian.activity(agentId);

      const action = this.guardian.evaluate(agentId);
      if (action === 'restarted') {
        this.publish({ type: 'guardian', ts: now, agentId, action: 'restarted' });
      } else if (action === 'breaker_tripped') {
        this.journal.insertAudit({ actor: 'guardian', action: 'breaker_tripped', target: agentId, detail: 'restart budget exhausted' });
        this.publish({ type: 'guardian', ts: now, agentId, action: 'breaker_tripped' });
      }

      this.publish({ type: 'snapshot', ts: now, agentId, state, normalized, changed });
    }
  }

  /** Lease ready tasks and dispatch each goal into its agent's pane. */
  async pump(): Promise<number> {
    let dispatched = 0;
    const slots = this.opts.slots ?? 7;
    for (let slot = 0; slot < slots; slot++) {
      const lease = await this.engine.acquire(slot);
      if (!lease) break;
      const { agentId, prompt } = decodeGoal(lease.goal);
      const cfg = this.agents.get(agentId);
      this.publish({ type: 'task', ts: Date.now(), action: 'lease', taskId: lease.taskId });
      if (!cfg) {
        await this.engine.complete(lease.taskId, 'FAILED');
        this.publish({ type: 'task', ts: Date.now(), action: 'fail', taskId: lease.taskId });
        continue;
      }
      try {
        const res: DispatchResult = await this.injector.dispatchGoal(agentId, prompt, {
          target: cfg.pane,
        });
        if (res.ok) {
          await this.engine.complete(lease.taskId, 'COMPLETED');
          this.publish({ type: 'task', ts: Date.now(), action: 'complete', taskId: lease.taskId });
        } else {
          await this.engine.complete(lease.taskId, 'FAILED');
          this.publish({ type: 'task', ts: Date.now(), action: 'fail', taskId: lease.taskId });
        }
        dispatched += 1;
      } catch {
        await this.engine.complete(lease.taskId, 'FAILED');
        this.publish({ type: 'task', ts: Date.now(), action: 'fail', taskId: lease.taskId });
      }
    }
    return dispatched;
  }

  /** Enqueue a goal for an agent (becomes a prioritized, dependency-ordered task). */
  enqueueGoal(agentId: string, prompt: string, priority: PriorityLevel = 'NORMAL', taskId?: string): string {
    const id = taskId ?? `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.engine.enqueue({
      taskId: id,
      goal: encodeGoal(agentId, prompt),
      priority,
      timeoutMs: 0,
    });
    this.journal.insertAudit({ actor: 'user', action: 'enqueue_goal', target: agentId, detail: prompt.slice(0, 80) });
    this.publish({ type: 'task', ts: Date.now(), action: 'enqueue', taskId: id });
    return id;
  }

  /** Inject a goal into a pane immediately (bypasses the queue). */
  async injectGoal(agentId: string, prompt: string): Promise<DispatchResult> {
    const cfg = this.agents.get(agentId);
    if (!cfg) throw new Error(`unknown agent: ${agentId}`);
    this.journal.insertAudit({ actor: 'user', action: 'inject_goal', target: agentId, detail: prompt.slice(0, 80) });
    return this.injector.dispatchGoal(agentId, prompt, { target: cfg.pane });
  }

  private async handleRestart(agentId: string): Promise<void> {
    this.journal.insertAudit({ actor: 'guardian', action: 'restart', target: agentId, detail: 'STUCK -> re-inject nudge' });
    try {
      if (this.opts.restartAction) {
        await this.opts.restartAction(agentId);
      } else {
        const cfg = this.agents.get(agentId);
        if (cfg) {
          await this.injector.dispatchGoal(agentId, 'Are you still there? Please continue the last task.', {
            target: cfg.pane,
          });
        }
      }
    } catch {
      /* restart is best-effort; swallow to avoid crashing the loop */
    }
  }

  /** Recent audit-log rows (newest first), for inspection / TUI. */
  recentAudit(limit = 50): Array<{ ts: number; actor: string; action: string; target: string | null; detail: string | null }> {
    const rows = this.journal.raw
      .prepare(`SELECT ts, actor, action, target, detail FROM audit_log ORDER BY id DESC LIMIT ?`)
      .all(limit) as Array<{ ts: number; actor: string; action: string; target: string | null; detail: string | null }>;
    return rows;
  }

  /** Current per-agent view (state, stuck, breaker). */
  agentViews(): AgentView[] {
    return [...this.agents.keys()].map((agentId) => ({
      agentId,
      state: this.lastState.get(agentId) ?? AgentState.IDLE,
      lastNormalized: this.lastNormalized.get(agentId) ?? '',
      stuck: this.guardian.status(agentId) === 'STUCK',
      breakerOpen: this.guardian.status(agentId) === 'BREAKER_OPEN',
      restartsInWindow: this.guardian.restartCount(agentId),
    }));
  }

  /** Begin the poll loop on a fixed interval (real timers). */
  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    // Don't keep the process alive solely for this timer.
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Type-safe publish of a fleet event to all subscribers. */
  publish(e: FleetEvent): void {
    super.emit(e.type, e);
  }
}
