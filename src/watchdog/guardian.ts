/**
 * Watchdog / heartbeat / circuit-breaker engine ("the Guardian").
 *
 * Watches agent panes for inactivity and decides when a pane is STUCK and
 * whether it may be auto-restarted. The Guardian never performs restarts itself —
 * it calls an injected `restart(paneKey)` callback (the caller wires that to a
 * safe tmux respawn / goal re-inject). This keeps the policy engine pure and
 * trivially testable.
 *
 * Guardrails
 * ----------
 *   - STUCK: a pane with no activity for `stuckAfterMs` is flagged STUCK.
 *   - Restart budget: at most `maxRestartsPerWindow` restarts per pane within any
 *     rolling `windowMs` (default 3 per hour). Exceeding the budget trips the
 *     circuit breaker for that pane.
 *   - Circuit breaker: once tripped, the pane is declared PERMANENTLY_STUCK and
 *     no further restarts are attempted until the breaker is manually reset
 *     (or the window fully drains and the operator clears it). This prevents
 *     restart loops from hammering a wedged agent.
 */

export type PaneStatus = 'OK' | 'STUCK' | 'BREAKER_OPEN';

export interface GuardianOptions {
  /** Inactivity duration (ms) before a pane is considered STUCK. */
  stuckAfterMs: number;
  /** Max restarts allowed per pane within `windowMs`. */
  maxRestartsPerWindow?: number;
  /** Rolling window for the restart budget (default 1 hour). */
  windowMs?: number;
  /** Injectable clock (ms). Defaults to Date.now. */
  now?: () => number;
  /** Called when the Guardian decides a pane should be restarted. */
  restart?: (paneKey: string) => void | Promise<void>;
}

interface PaneState {
  key: string;
  lastActivity: number;
  restarts: number[]; // timestamps of restarts within the window
  breakerOpen: boolean;
  /** When the breaker tripped (for the auto-close gate). */
  breakerTrippedAt: number;
  /** A fresh activity heartbeat arrived since the breaker tripped. */
  hadHeartbeatSinceTrip: boolean;
}

export class Guardian {
  private readonly stuckAfterMs: number;
  private readonly maxRestarts: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly restart: ((paneKey: string) => void | Promise<void>) | undefined;
  private readonly panes = new Map<string, PaneState>();

  constructor(opts: GuardianOptions) {
    if (opts.stuckAfterMs <= 0) throw new Error('stuckAfterMs must be > 0');
    this.stuckAfterMs = opts.stuckAfterMs;
    this.maxRestarts = opts.maxRestartsPerWindow ?? 3;
    this.windowMs = opts.windowMs ?? 60 * 60 * 1000;
    this.now = opts.now ?? Date.now;
    this.restart = opts.restart;
  }

  /** Register (or re-register) a pane. Starts in OK with current time as activity. */
  register(paneKey: string): void {
    const existing = this.panes.get(paneKey);
    if (existing) {
      existing.lastActivity = this.now();
      return;
    }
    this.panes.set(paneKey, {
      key: paneKey,
      lastActivity: this.now(),
      restarts: [],
      breakerOpen: false,
      breakerTrippedAt: 0,
      hadHeartbeatSinceTrip: false,
    });
  }

  /** Record activity for a pane (e.g. a fresh terminal snapshot arrived). */
  activity(paneKey: string, at?: number): void {
    const p = this.panes.get(paneKey);
    if (!p) {
      this.register(paneKey);
      return;
    }
    p.lastActivity = at ?? this.now();
    // A heartbeat while the breaker is OPEN records liveness but does NOT by
    // itself recover the pane. The breaker may only auto-close once the rolling
    // restart window has fully drained AND a fresh heartbeat proves liveness
    // (see status()). This prevents a single stray keystroke from instantly
    // un-protecting a pane that is still inside its cooldown window.
    if (p.breakerOpen) p.hadHeartbeatSinceTrip = true;
  }

  /** Drop a pane from monitoring (agent retired). */
  unregister(paneKey: string): void {
    this.panes.delete(paneKey);
  }

  private pruneWindow(p: PaneState, now: number): void {
    const cutoff = now - this.windowMs;
    p.restarts = p.restarts.filter((t) => t > cutoff);
  }

  /** Current status of a pane. */
  status(paneKey: string): PaneStatus {
    const p = this.panes.get(paneKey);
    if (!p) return 'OK';
    if (p.breakerOpen) {
      // Auto-close gate (issue #1): the breaker may only recover once BOTH
      // conditions hold — (a) the rolling restart window has fully drained
      // (no restart timestamps remain inside windowMs) and (b) a fresh activity
      // heartbeat has arrived since the trip, proving the pane is actually alive.
      // Until then the pane stays unwatched but is never re-nudged, so a wedged
      // agent cannot be hammer-looped and a silent pane is not falsely cleared.
      this.pruneWindow(p, this.now());
      if (p.restarts.length === 0 && p.hadHeartbeatSinceTrip) {
        p.breakerOpen = false;
        p.hadHeartbeatSinceTrip = false;
        p.lastActivity = this.now();
        return 'OK';
      }
      return 'BREAKER_OPEN';
    }
    const idle = this.now() - p.lastActivity;
    return idle >= this.stuckAfterMs ? 'STUCK' : 'OK';
  }

  /**
   * Evaluate one pane. If STUCK and the restart budget allows, perform (and count)
   * a restart and refresh activity. If the budget is exhausted, trip the circuit
   * breaker (PERMANENTLY_STUCK) and suppress further restarts. Returns the action
   * taken: 'none' | 'restarted' | 'breaker_tripped'.
   */
  evaluate(paneKey: string): 'none' | 'restarted' | 'breaker_tripped' {
    const p = this.panes.get(paneKey);
    if (!p) return 'none';
    const now = this.now();
    this.pruneWindow(p, now);

    if (p.breakerOpen) return 'none'; // already tripped; do nothing
    if (now - p.lastActivity < this.stuckAfterMs) return 'none'; // not stuck

    // Stuck. Do we have budget?
    if (p.restarts.length >= this.maxRestarts) {
      p.breakerOpen = true;
      p.breakerTrippedAt = now;
      p.hadHeartbeatSinceTrip = false;
      return 'breaker_tripped';
    }

    p.restarts.push(now);
    p.lastActivity = now; // assume the restart re-animates the pane
    if (this.restart) void Promise.resolve(this.restart(paneKey));
    return 'restarted';
  }

  /** Restart counts within the current rolling window (for inspection / TUI). */
  restartCount(paneKey: string): number {
    const p = this.panes.get(paneKey);
    if (!p) return 0;
    this.pruneWindow(p, this.now());
    return p.restarts.length;
  }

  /** Manually clear a tripped breaker (operator intervention). */
  resetBreaker(paneKey: string): void {
    const p = this.panes.get(paneKey);
    if (p) {
      p.breakerOpen = false;
      p.hadHeartbeatSinceTrip = false;
      p.restarts = [];
      p.lastActivity = this.now();
    }
  }
}
