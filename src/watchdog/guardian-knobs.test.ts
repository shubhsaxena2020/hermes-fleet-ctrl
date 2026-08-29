import { describe, it, expect } from 'vitest';
import { Guardian } from './guardian.js';
import type { TmuxTransport } from '../driver/types.js';
import { FleetControl } from '../server/fleet-control.js';
import { EventJournal } from '../storage/db.js';

/**
 * Phase B (BACKLOG B5/B6): prove the circuit-breaker knobs actually take
 * effect end-to-end — i.e. that a custom `maxRestartsPerWindow` / `windowMs`
 * (the values FLEET_MAX_RESTARTS / FLEET_RESTART_WINDOW_MS feed into) change
 * Guardian behavior, and that auto-close respects a custom short window.
 *
 * These are deliberately distinct from guardian.test.ts (which uses the
 * defaults 3 / 1h). Here we drive non-default budgets through the real
 * FleetControl wiring so the knob -> Guardian path is covered.
 */

class FakeFleetTransport implements TmuxTransport {
  private screens = new Map<string, string>();
  setScreen(host: string, pane: string, text: string): void {
    this.screens.set(`${host}|${pane}`, text);
  }
  exec(): Promise<{ code: number; stdout: string; stderr: string }> {
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  }
  execWithStdin(): Promise<{ code: number; stdout: string; stderr: string }> {
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  }
  capturePane(host: string, target: string): Promise<string> {
    return Promise.resolve(this.screens.get(`${host}|${target}`) ?? '');
  }
}

describe('Breaker knobs -> Guardian behavior (B5)', () => {
  it('honors a custom small restart budget (exhausts earlier than default 3)', () => {
    let clock = 1_000_000;
    const g = new Guardian({ stuckAfterMs: 1000, maxRestartsPerWindow: 1, windowMs: 60 * 60 * 1000, now: () => clock, restart: () => {} });
    g.register('p');
    // 1st stuck -> restart; 2nd -> budget exhausted (max=1)
    clock += 2000;
    expect(g.evaluate('p')).toBe('restarted');
    clock += 2000;
    expect(g.evaluate('p')).toBe('breaker_tripped');
    expect(g.status('p')).toBe('BREAKER_OPEN');
    expect(g.restartCount('p')).toBe(1);
  });

  it('a higher budget permits more restarts before tripping', () => {
    let clock = 1_000_000;
    const g = new Guardian({ stuckAfterMs: 1000, maxRestartsPerWindow: 5, windowMs: 60 * 60 * 1000, now: () => clock, restart: () => {} });
    g.register('p');
    for (let i = 0; i < 5; i++) {
      clock += 2000;
      expect(g.evaluate('p')).toBe('restarted');
    }
    clock += 2000;
    expect(g.evaluate('p')).toBe('breaker_tripped');
    expect(g.restartCount('p')).toBe(5);
  });

  it('propagates a custom budget end-to-end through FleetControl.tick()', async () => {
    // A constant non-IDLE screen (RUNNING_COMMAND) is treated as "not alive",
    // so the Guardian accumulates inactivity and eventually trips the breaker.
    // This exercises the real FleetControl -> Guardian wiring with a custom
    // maxRestartsPerWindow (2), proving the knob is not just a unit default.
    let clock = 1_000_000;
    const screen = '⏵ Running: npm test'; // classifies as RUNNING_COMMAND (not IDLE)
    const transport = new FakeFleetTransport();
    transport.setScreen('agent-1', '0.0', screen);

    const journal = new EventJournal();
    const fleet = new FleetControl(
      transport,
      journal,
      { 'agent-1': { host: 'agent-1', pane: '0.0' } },
      { stuckAfterMs: 1000, slots: 1, maxRestartsPerWindow: 2, restartWindowMs: 60 * 60 * 1000, now: () => clock },
    );

    // Drive several poll cycles with the clock advancing past stuckAfterMs each
    // time. With max=2 the breaker should trip after exactly 2 restarts.
    for (let i = 0; i < 4; i++) {
      clock += 2000;
      await fleet.tick();
    }

    const view = fleet.agentViews().find((v) => v.agentId === 'agent-1')!;
    expect(view.breakerOpen).toBe(true);
    expect(view.restartsInWindow).toBe(2);

    // Durable breaker event recorded (open).
    const events = fleet.recentBreakerEvents('agent-1');
    expect(events.some((e) => e.kind === 'open')).toBe(true);
  });
});

describe('Auto-close respects a custom short window (B6 / FLEET_RESTART_WINDOW_MS)', () => {
  it('auto-closes once a short custom window drains + heartbeat (not the default 1h)', () => {
    let clock = 1_000_000;
    const g = new Guardian({
      stuckAfterMs: 1000,
      maxRestartsPerWindow: 3,
      windowMs: 10_000, // custom short window (e.g. FLEET_RESTART_WINDOW_MS=10000)
      now: () => clock,
      restart: () => {},
    });
    g.register('p');
    for (let i = 0; i < 3; i++) {
      clock += 2000;
      g.evaluate('p');
    }
    clock += 2000;
    g.evaluate('p'); // trip
    expect(g.status('p')).toBe('BREAKER_OPEN');

    // Advance past the CUSTOM 10s window (not 1h) — restarts prune.
    clock += 10_000 + 500;
    g.activity('p', clock);
    expect(g.status('p')).toBe('OK'); // auto-closed on the short window
  });

  it('does NOT auto-close before the custom short window drains, even with heartbeat', () => {
    let clock = 1_000_000;
    const g = new Guardian({
      stuckAfterMs: 1000,
      maxRestartsPerWindow: 3,
      windowMs: 10_000,
      now: () => clock,
      restart: () => {},
    });
    g.register('p');
    for (let i = 0; i < 3; i++) {
      clock += 2000;
      g.evaluate('p');
    }
    clock += 2000;
    g.evaluate('p');
    expect(g.status('p')).toBe('BREAKER_OPEN');

    // Only half the custom window passes + heartbeat => still open.
    clock += 5_000;
    g.activity('p', clock);
    expect(g.status('p')).toBe('BREAKER_OPEN');
  });
});
