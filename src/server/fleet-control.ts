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
import { evaluateAlerts } from '../alerting/rules.js';
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
  /**
   * When true, the default restart action pastes a gentle "continue" nudge into
   * the pane via load-buffer + paste-buffer (never send-keys / kill). When false
   * (the production default for this VPS), restarts are observed+audited only and
   * the daemon never writes to a pane unless an operator dispatches a goal.
   */
  allowNudge?: boolean;
  /** Text pasted on a STUCK nudge. */
  nudgeText?: string;
  /** Agent IDs that must never be nudged or have goals dispatched into them. */
  protectedIds?: Set<string>;
}

export interface AgentView {
  agentId: string;
  state: AgentState;
  lastNormalized: string;
  stuck: boolean;
  breakerOpen: boolean;
  /** Durable breaker state reconstructed from the event log ('open' | 'closed'). */
  breakerState: 'open' | 'closed';
  restartsInWindow: number;
  /** True if this pane is protected (never auto-nudged / never accepts dispatch). */
  protected: boolean;
}

export type FleetEvent =
  | { type: 'snapshot'; ts: number; agentId: string; state: AgentState; normalized: string; changed: boolean }
  | { type: 'task'; ts: number; action: 'enqueue' | 'lease' | 'complete' | 'fail' | 'timeout'; taskId: string }
  | { type: 'guardian'; ts: number; agentId: string; action: 'restarted' | 'breaker_tripped' | 'breaker_autoclose' }
  | { type: 'alert'; ts: number; agentId: string; severity: 'info' | 'warning' | 'critical'; ruleId: string; message: string }
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
  private readonly protectedIds: Set<string>;
  private readonly lastNormalized = new Map<string, string>();
  private readonly lastState = new Map<string, AgentState>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly lastHeartbeatAt = new Map<string, number>();

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
    this.protectedIds = opts.protectedIds ?? new Set<string>();
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
      onTransition: (e) => {
        // Make every breaker transition durable AND live-broadcast it.
        this.journal.insertBreakerEvent({
          agent_id: e.agentId,
          pane_id: this.agents.get(e.agentId)?.pane ?? null,
          kind: e.to === 'open' ? 'open' : 'auto_close',
          reason: e.reason,
          at: e.at,
        });
        this.publish({
          type: 'guardian',
          ts: e.at,
          agentId: e.agentId,
          action: e.to === 'open' ? 'breaker_tripped' : 'breaker_autoclose',
        });
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
      if (alive) {
        this.guardian.activity(agentId);
        this.lastHeartbeatAt.set(agentId, now);
      }

      const action = this.guardian.evaluate(agentId);
      if (action === 'restarted') {
        this.publish({ type: 'guardian', ts: now, agentId, action: 'restarted' });
      } else if (action === 'breaker_tripped') {
        this.journal.insertAudit({ actor: 'guardian', action: 'breaker_tripped', target: agentId, detail: 'restart budget exhausted' });
        this.publish({ type: 'guardian', ts: now, agentId, action: 'breaker_tripped' });
      }

      this.publish({ type: 'snapshot', ts: now, agentId, state, normalized, changed });

      // Record a bounded metrics sample for trendlines (T6). Captured every poll
      // cycle; the journal prunes beyond the per-agent cap so history stays small.
      const lastHb = this.lastHeartbeatAt.get(agentId) ?? now;
      this.journal.insertMetricsSample({
        agent_id: agentId,
        captured_at: now,
        queue_depth: this.engine.snapshot().length,
        heartbeat_age_ms: Math.max(0, now - lastHb),
        restart_count: this.guardian.restartCount(agentId),
        poll_latency_ms: 0,
      });

      // Evaluate the data-driven alert policy (T9) against this agent snapshot and
      // publish every firing rule as a live alert event. Pure + inspectable; the
      // policy lives in src/alerting/rules.ts, not here.
      const alerts = evaluateAlerts({
        agentId,
        state,
        stuck: this.guardian.status(agentId) === 'STUCK',
        breakerOpen: this.guardian.status(agentId) === 'BREAKER_OPEN',
        breakerState: this.journal.reconstructBreakerState(agentId),
        restartsInWindow: this.guardian.restartCount(agentId),
        protected: this.protectedIds.has(agentId),
        heartbeatAgeMs: Math.max(0, now - lastHb),
      });
      for (const a of alerts) {
        this.publish({ type: 'alert', ts: now, agentId, severity: a.severity, ruleId: a.ruleId, message: a.message });
      }
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
    if (this.protectedIds.has(agentId)) {
      throw new Error(`agent ${agentId} is protected; dispatch is not allowed`);
    }
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
    if (!cfg) {
      return { ok: false, target: agentId, transmitted: '', attempts: 0, error: `unknown agent: ${agentId}` };
    }
    if (this.protectedIds.has(agentId)) {
      return { ok: false, target: agentId, transmitted: '', attempts: 0, error: `agent ${agentId} is protected; dispatch is not allowed` };
    }
    this.journal.insertAudit({ actor: 'user', action: 'inject_goal', target: agentId, detail: prompt.slice(0, 80) });
    return this.injector.dispatchGoal(agentId, prompt, { target: cfg.pane });
  }

  private async handleRestart(agentId: string): Promise<void> {
    this.journal.insertAudit({ actor: 'guardian', action: 'restart', target: agentId, detail: 'STUCK detected' });
    // A protected pane (window 0 / main session / operator-marked) is never
    // auto-touched, even when STUCK. Observe + audit only.
    if (this.protectedIds.has(agentId)) {
      this.journal.insertAudit({ actor: 'guardian', action: 'restart-skipped', target: agentId, detail: 'protected pane' });
      return;
    }
    try {
      if (this.opts.restartAction) {
        await this.opts.restartAction(agentId);
      } else if (this.opts.allowNudge) {
        const cfg = this.agents.get(agentId);
        if (cfg) {
          await this.injector.dispatchGoal(agentId, this.opts.nudgeText ?? 'Are you still there? Please continue the last task.', {
            target: cfg.pane,
          });
        }
      } else {
        // Monitoring-only mode: the daemon records the STUCK event and lets the
        // operator (or the existing worker-wrapper.sh supervisor) decide. No write.
        this.journal.insertAudit({ actor: 'guardian', action: 'restart-observed', target: agentId, detail: 'nudge disabled' });
      }
    } catch {
      /* restart is best-effort; swallow to avoid crashing the loop */
    }
  }

  /** True if an agent pane is protected (must never be nudged/dispatched into). */
  isProtected(agentId: string): boolean {
    return this.protectedIds.has(agentId);
  }

  /** Recent audit-log rows (newest first), for inspection / TUI / export. */
  recentAudit(
    limit = 50,
    filter: { agent?: string | undefined; type?: string | undefined } = {},
  ): Array<{ ts: number; actor: string; action: string; target: string | null; detail: string | null }> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.agent != null && filter.agent.length > 0) {
      clauses.push('(target = ? OR actor = ?)');
      params.push(filter.agent, filter.agent);
    }
    if (filter.type != null && filter.type.length > 0) {
      clauses.push('action = ?');
      params.push(filter.type);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    params.push(Math.min(Math.max(limit, 1), 500));
    const rows = this.journal.raw
      .prepare(`SELECT ts, actor, action, target, detail FROM audit_log${where} ORDER BY id DESC LIMIT ?`)
      .all(...params) as Array<{ ts: number; actor: string; action: string; target: string | null; detail: string | null }>;
    return rows;
  }

  /**
   * Render the recent audit log as sanitized NDJSON for operator export (T14).
   * Each line is a stable JSON object with no internal-only fields leaked.
   */
  exportAuditLog(limit = 50, filter: { agent?: string | undefined; type?: string | undefined } = {}): string {
    const rows = this.recentAudit(limit, filter);
    return rows
      .map((r) => JSON.stringify({ ts: r.ts, actor: r.actor, action: r.action, target: r.target, detail: r.detail ?? null }))
      .join('\n');
  }

  /** Current per-agent view (state, stuck, breaker, durable breaker state). */
  agentViews(): AgentView[] {
    return [...this.agents.keys()].map((agentId) => ({
      agentId,
      state: this.lastState.get(agentId) ?? AgentState.IDLE,
      lastNormalized: this.lastNormalized.get(agentId) ?? '',
      stuck: this.guardian.status(agentId) === 'STUCK',
      breakerOpen: this.guardian.status(agentId) === 'BREAKER_OPEN',
      breakerState: this.journal.reconstructBreakerState(agentId),
      restartsInWindow: this.guardian.restartCount(agentId),
      protected: this.protectedIds.has(agentId),
    }));
  }

  /** Bounded metrics history for an agent (newest first). */
  recentMetrics(agentId: string, limit = 60) {
    return this.journal.recentMetrics(agentId, limit);
  }

  /** Recent durable breaker events (newest first). */
  recentBreakerEvents(agentId?: string, limit = 50) {
    return this.journal.recentBreakerEvents(agentId, limit);
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
