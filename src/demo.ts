/**
 * Self-contained end-to-end demo of the fleet control plane.
 *
 * Boots the FULL stack (FleetControl + EventJournal + TUI model) against an
 * in-process mock tmux transport — no real SSH/tmux required — and replays a
 * short scenario:
 *   - agent-1 starts THINKING, then freezes (simulating a wedged agent)
 *   - the watchdog declares it STUCK and auto-restarts it (the nudge re-animates)
 *   - agent-2 stays healthy and completes a dispatched goal
 *
 * Deterministic (injectable clock) and headless: it renders the TUI model to a
 * string and returns a structured summary, so it doubles as a smoke test.
 */

import { EventJournal } from './storage/db.js';
import { FleetControl } from './server/fleet-control.js';
import { renderLines } from './tui/app.js';
import type { FleetEvent } from './server/fleet-control.js';
import type { TmuxTransport, ExecResult } from './driver/types.js';

class DemoTransport implements TmuxTransport {
  private screens = new Map<string, string>();
  setScreen(host: string, pane: string, text: string): void {
    this.screens.set(`${host}|${pane}`, text);
  }
  get(host: string, pane: string): string {
    return this.screens.get(`${host}|${pane}`) ?? '';
  }
  append(host: string, pane: string, text: string): void {
    this.setScreen(host, pane, this.get(host, pane) + text);
  }
  exec(_host: string, command: string): Promise<ExecResult> {
    const m = command.match(/^tmux paste-buffer -t (.+)$/);
    if (m) {
      const [h, p] = m[1]!.split('|');
      this.append(h!, p!, '\n[restart-nudge] resume\n');
    }
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  }
  execWithStdin(_host: string, command: string): Promise<ExecResult> {
    const m = command.match(/^tmux load-buffer -$/);
    if (m) {
      // The goal is delivered over stdin; we just acknowledge receipt.
    }
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  }
  capturePane(host: string, target: string): Promise<string> {
    return Promise.resolve(this.get(host, target));
  }
}

export interface DemoResult {
  finalScreen: string[];
  auditCount: number;
  restarts: number;
  breakerTripped: boolean;
  agentStates: Record<string, string>;
}

export async function runDemo(opts: { steps?: number } = {}): Promise<DemoResult> {
  const steps = opts.steps ?? 6;
  let clock = 1_000_000;
  const journal = new EventJournal();
  const transport = new DemoTransport();
  transport.setScreen('agent-1', 'agent-1|0.0', '⠿ thinking');
  transport.setScreen('agent-2', 'agent-2|0.0', '$ ');

  const fleet = new FleetControl(
    transport,
    journal,
    {
      'agent-1': { host: 'agent-1', pane: 'agent-1|0.0' },
      'agent-2': { host: 'agent-2', pane: 'agent-2|0.0' },
    },
    { stuckAfterMs: 1000, restartWindowMs: 10_000, now: () => clock },
  );

  // Dispatch a goal to the healthy agent.
  fleet.enqueueGoal('agent-2', 'summarize the logs');

  let restarts = 0;
  fleet.on('guardian', (e: FleetEvent) => {
    if (e.type === 'guardian' && e.action === 'restarted') restarts += 1;
  });

  for (let i = 0; i < steps; i++) {
    if (i === 1) {
      // agent-1 wedges: screen frozen while "thinking" -> becomes STUCK.
      transport.setScreen('agent-1', 'agent-1|0.0', '⠿ thinking');
    } else if (i > 1 && i < 4) {
      // stay frozen (the restart nudge re-animates it, then it freezes again to
      // show the budget/breaker in action)
      transport.setScreen('agent-1', 'agent-1|0.0', '⠿ thinking');
    } else if (i >= 4) {
      // agent-1 recovers with real output after the breaker/restart cycle.
      transport.append('agent-1', 'agent-1|0.0', 'done.\n$ ');
    }
    // agent-2 makes progress each cycle (keeps it alive/healthy).
    transport.append('agent-2', 'agent-2|0.0', `> ${i}\n`);
    clock += 1500;
    await fleet.tick();
    // pump queued goals (agent-2 will receive its summary task).
    await fleet.pump();
  }

  const states: Record<string, string> = {};
  for (const a of fleet.agentViews()) states[a.agentId] = a.state;

  return {
    finalScreen: renderLines({
      agents: fleet.agentViews(),
      tasks: fleet.engine.snapshot(),
      audit: fleet.recentAudit(3).map((r) => ({ actor: r.actor, action: r.action, detail: r.detail })),
      selected: 0,
      input: '',
      lastEvent: '',
    }),
    auditCount: fleet.recentAudit(500).length,
    restarts,
    breakerTripped: fleet.agentViews().some((a) => a.breakerOpen),
    agentStates: states,
  };
}
