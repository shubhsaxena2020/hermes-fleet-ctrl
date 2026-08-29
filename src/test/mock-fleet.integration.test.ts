import { describe, it, expect } from 'vitest';
import { EventJournal } from '../storage/db.js';
import { FleetControl } from '../server/fleet-control.js';
import { AgentState } from '../parser/ansi-parser.js';
import type { TmuxTransport, ExecResult } from '../driver/types.js';

/**
 * Mock-fleet integration harness (T15). A controllable fake tmux transport:
 * each agent has a "screen" string we mutate between ticks to simulate terminal
 * output. A change in the screen is treated as a fresh heartbeat; an unchanged
 * screen means the agent is wedged (no new output) and drives STUCK -> restarts
 * -> breaker open. Runs fully deterministically against a :memory: journal.
 *
 * Key scheme: a pane is `${host}|${pane}`, matching how FleetControl calls
 * capturePane(host, pane) and the injector calls paste-buffer -t ${pane}.
 */
class MockTmuxTransport implements TmuxTransport {
  private screens = new Map<string, string>();
  injected: Array<{ agentId: string; payload: string }> = [];
  private pending: string | null = null;

  setScreen(host: string, pane: string, text: string): void {
    this.screens.set(`${host}|${pane}`, text);
  }
  private getScreen(host: string, pane: string): string {
    return this.screens.get(`${host}|${pane}`) ?? '';
  }
  exec(host: string, command: string): Promise<ExecResult> {
    const m = command.match(/^tmux paste-buffer -t (.+)$/);
    if (m) {
      const pane = m[1]!;
      this.screens.set(`${host}|${pane}`, this.getScreen(host, pane) + '\n');
    }
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  }
  execWithStdin(host: string, command: string, input?: string): Promise<ExecResult> {
    if (command.trim() === 'tmux load-buffer -') {
      this.pending = input ?? null;
      this.injected.push({ agentId: host, payload: input ?? '' });
    }
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  }
  capturePane(host: string, target: string): Promise<string> {
    return Promise.resolve(this.getScreen(host, target));
  }
}

function makeFleet(now: () => number): { fleet: FleetControl; transport: MockTmuxTransport } {
  const transport = new MockTmuxTransport();
  const journal = new EventJournal(); // :memory:
  const fleet = new FleetControl(
    transport,
    journal,
    {
      'agent-1': { host: 'agent-1', pane: '0.0' },
      'agent-2': { host: 'agent-2', pane: '0.0' },
    },
    { stuckAfterMs: 1000, maxRestartsPerWindow: 3, restartWindowMs: 60 * 60 * 1000, slots: 7, now },
  );
  return { fleet, transport };
}

/** Keep an agent wedged (no new output) and advance time until its breaker trips. */
async function tripBreaker(fleet: FleetControl, clock: { t: number }, transport: MockTmuxTransport, host: string): Promise<void> {
  transport.setScreen(host, '0.0', '⠿ wedged'); // freeze on a non-IDLE (active) screen
  fleet.guardian.resetBreaker(host);
  for (let i = 0; i < 8; i++) {
    clock.t += 2000; // exceed stuckAfterMs each cycle; screen stays frozen -> STUCK
    await fleet.tick();
    transport.setScreen(host, '0.0', '⠿ wedged');
    if (fleet.agentViews().find((v) => v.agentId === host)!.breakerState === 'open') return;
  }
  throw new Error(`breaker did not trip for ${host}`);
}

describe('Mock-fleet integration tests (T15)', () => {
  it('scenario 1: normal operation — idle agents, no alerts, no breaker trips', async () => {
    const clock = { t: 1_000_000 };
    const { fleet, transport } = makeFleet(() => clock.t);
    transport.setScreen('agent-1', '0.0', '$ ');
    transport.setScreen('agent-2', '0.0', '$ ');

    const alerts: unknown[] = [];
    const guardian: unknown[] = [];
    fleet.on('alert', (e) => alerts.push(e));
    fleet.on('guardian', (e) => guardian.push(e));

    clock.t += 3000;
    await fleet.tick();
    await fleet.tick();

    const views = fleet.agentViews();
    expect(views.find((v) => v.agentId === 'agent-1')!.state).toBe(AgentState.IDLE);
    expect(views.find((v) => v.agentId === 'agent-2')!.state).toBe(AgentState.IDLE);
    expect(views.every((a) => a.breakerState === 'closed')).toBe(true);
    expect(alerts).toEqual([]);
    expect(guardian).toEqual([]);
  });

  it('scenario 2: missed heartbeats → STUCK → restart budget exhausted → breaker open', async () => {
    const clock = { t: 1_000_000 };
    const { fleet, transport } = makeFleet(() => clock.t);
    transport.setScreen('agent-1', '0.0', '⠿ thinking');
    transport.setScreen('agent-2', '0.0', '$ ');
    await fleet.tick(); // baseline so agent-1 is alive initially

    const restarted: string[] = [];
    const tripped: string[] = [];
    fleet.on('guardian', (e: { type: string; action: string }) => {
      if (e.type === 'guardian' && e.action === 'restarted') restarted.push(e.action);
      if (e.type === 'guardian' && e.action === 'breaker_tripped') tripped.push(e.action);
    });

    await tripBreaker(fleet, clock, transport, 'agent-1');

    // Exactly 3 restarts, then the breaker trips (never a 4th restart).
    expect(restarted.length).toBe(3);
    expect(tripped.length).toBe(1);

    const v1 = fleet.agentViews().find((v) => v.agentId === 'agent-1')!;
    expect(v1.breakerState).toBe('open');
    const v2 = fleet.agentViews().find((v) => v.agentId === 'agent-2')!;
    expect(v2.state).toBe(AgentState.IDLE);
    expect(v2.breakerState).toBe('closed');
  });

  it('scenario 3: breaker open → auto-close after window drain + fresh heartbeat', async () => {
    const clock = { t: 1_000_000 };
    const { fleet, transport } = makeFleet(() => clock.t);
    transport.setScreen('agent-1', '0.0', '⠿ thinking');
    transport.setScreen('agent-2', '0.0', '$ ');
    await fleet.tick();

    await tripBreaker(fleet, clock, transport, 'agent-1');
    expect(fleet.agentViews().find((v) => v.agentId === 'agent-1')!.breakerState).toBe('open');

    // Drain the 1h restart window, then produce a fresh heartbeat by changing the screen.
    clock.t += 60 * 60 * 1000 + 1000;
    transport.setScreen('agent-1', '0.0', '⠿ alive again with new output');
    await fleet.tick();

    const v1 = fleet.agentViews().find((v) => v.agentId === 'agent-1')!;
    expect(v1.breakerState).toBe('closed');
    expect(fleet.recentBreakerEvents('agent-1').some((e) => e.kind === 'auto_close')).toBe(true);
  });

  it('scenario 4: restart recovery — breaker stays open within the window, re-evaluates live agent after drain', async () => {
    const clock = { t: 1_000_000 };
    const { fleet, transport } = makeFleet(() => clock.t);
    transport.setScreen('agent-1', '0.0', '⠿ thinking');
    transport.setScreen('agent-2', '0.0', '$ ');
    await fleet.tick();

    await tripBreaker(fleet, clock, transport, 'agent-1');
    expect(fleet.agentViews().find((v) => v.agentId === 'agent-1')!.breakerState).toBe('open');

    // A restart that produces new output does NOT auto-clear while the window is live.
    clock.t += 1000;
    transport.setScreen('agent-1', '0.0', '⠿ new output after restart');
    await fleet.tick();
    expect(fleet.agentViews().find((v) => v.agentId === 'agent-1')!.breakerState).toBe('open');

    // Drain the window; the agent is now alive and the breaker auto-closes.
    clock.t += 60 * 60 * 1000;
    transport.setScreen('agent-1', '0.0', '⠿ still alive');
    await fleet.tick();
    const v1 = fleet.agentViews().find((v) => v.agentId === 'agent-1')!;
    expect(v1.breakerState).toBe('closed');
    expect([AgentState.IDLE, AgentState.ACTIVE_THINKING, AgentState.RUNNING_COMMAND]).toContain(v1.state);
  });

  it('scenario 5: history replay — metrics samples, audit log, and durable breaker events are retained', async () => {
    const clock = { t: 1_000_000 };
    const { fleet, transport } = makeFleet(() => clock.t);
    transport.setScreen('agent-1', '0.0', '⠿ thinking');
    transport.setScreen('agent-2', '0.0', '$ ');

    await fleet.tick();
    fleet.enqueueGoal('agent-1', 'do something');
    for (let i = 0; i < 5; i++) {
      clock.t += 1000;
      transport.setScreen('agent-1', '0.0', `⠿ thinking ${clock.t}`);
      await fleet.tick();
    }

    // Trip then auto-close to leave durable open + auto_close events.
    await tripBreaker(fleet, clock, transport, 'agent-1');
    expect(fleet.agentViews().find((v) => v.agentId === 'agent-1')!.breakerState).toBe('open');
    clock.t += 60 * 60 * 1000 + 1000;
    transport.setScreen('agent-1', '0.0', '⠿ recovered');
    await fleet.tick();
    expect(fleet.agentViews().find((v) => v.agentId === 'agent-1')!.breakerState).toBe('closed');

    // Metrics history retained with stable fields.
    const metrics = fleet.recentMetrics('agent-1', 10);
    expect(metrics.length).toBeGreaterThan(0);
    metrics.forEach((m) => {
      expect(m).toHaveProperty('agent_id', 'agent-1');
      expect(m).toHaveProperty('captured_at');
      expect(m).toHaveProperty('queue_depth');
      expect(m).toHaveProperty('heartbeat_age_ms');
      expect(m).toHaveProperty('restart_count');
      expect(m).toHaveProperty('poll_latency_ms');
    });

    // Audit log retains the enqueue_goal action.
    const audit = fleet.recentAudit(10);
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.some((e) => e.action === 'enqueue_goal')).toBe(true);

    // Durable breaker events retain open + auto_close (replayable after restart).
    const events = fleet.recentBreakerEvents('agent-1', 10);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('open');
    expect(kinds).toContain('auto_close');
  });
});
