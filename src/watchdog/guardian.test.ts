import { describe, it, expect } from 'vitest';
import { Guardian } from './guardian.js';

describe('Guardian — inactivity, STUCK, restart budget & circuit breaker', () => {
  it('flags a pane STUCK only after stuckAfterMs of inactivity', () => {
    let clock = 1_000_000;
    const g = new Guardian({ stuckAfterMs: 5 * 60 * 1000, now: () => clock });
    g.register('agent-1:0.0');
    expect(g.status('agent-1:0.0')).toBe('OK');

    clock += 4 * 60 * 1000; // 4 min idle
    expect(g.status('agent-1:0.0')).toBe('OK');

    clock += 60 * 1000; // 5 min idle -> stuck
    expect(g.status('agent-1:0.0')).toBe('STUCK');
  });

  it('restarts a stuck pane and refreshes activity (recovers to OK)', () => {
    let clock = 1_000_000;
    let restarts = 0;
    const g = new Guardian({
      stuckAfterMs: 1000,
      now: () => clock,
      restart: () => {
        restarts += 1;
      },
    });
    g.register('p');
    clock += 2000; // stuck
    expect(g.evaluate('p')).toBe('restarted');
    expect(restarts).toBe(1);
    expect(g.status('p')).toBe('OK'); // activity refreshed by the restart
  });

  it('caps automatic restarts to max 3 per hour, then trips the breaker', () => {
    let clock = 1_000_000;
    const events: string[] = [];
    const g = new Guardian({
      stuckAfterMs: 1000,
      maxRestartsPerWindow: 3,
      windowMs: 60 * 60 * 1000, // 1h window
      now: () => clock,
      restart: (k) => {
        events.push(`restart:${k}`);
      },
    });
    g.register('p');

    // 1st stuck -> restart; then "activity" never comes back (we keep advancing
    // past stuckAfterMs before each evaluate to simulate a wedged pane).
    clock += 2000;
    expect(g.evaluate('p')).toBe('restarted');
    expect(g.restartCount('p')).toBe(1);

    clock += 2000;
    expect(g.evaluate('p')).toBe('restarted');
    expect(g.restartCount('p')).toBe(2);

    clock += 2000;
    expect(g.evaluate('p')).toBe('restarted');
    expect(g.restartCount('p')).toBe(3);

    // 4th attempt: budget exhausted -> breaker trips, NO restart.
    clock += 2000;
    expect(g.evaluate('p')).toBe('breaker_tripped');
    expect(g.status('p')).toBe('BREAKER_OPEN');
    expect(events.length).toBe(3); // exactly 3 restarts, never a 4th

    // Subsequent evaluates while breaker open must NOT restart (loop suppressed).
    clock += 2000;
    expect(g.evaluate('p')).toBe('none');
    clock += 2000;
    expect(g.evaluate('p')).toBe('none');
    expect(events.length).toBe(3);
  });

  it('rolls the window so restarts are allowed again after an hour', () => {
    let clock = 1_000_000;
    const g = new Guardian({
      stuckAfterMs: 1000,
      maxRestartsPerWindow: 3,
      windowMs: 60 * 60 * 1000,
      now: () => clock,
    });
    g.register('p');
    for (let i = 0; i < 3; i++) {
      clock += 2000;
      expect(g.evaluate('p')).toBe('restarted');
    }
    clock += 2000;
    expect(g.evaluate('p')).toBe('breaker_tripped');

    // Advance past the 1h window: old restarts prune, but breaker stays open
    // until explicitly reset (operator intervention required).
    clock += 60 * 60 * 1000 + 1000;
    expect(g.status('p')).toBe('BREAKER_OPEN');

    g.resetBreaker('p');
    expect(g.status('p')).toBe('OK');
    expect(g.restartCount('p')).toBe(0);
    // fresh budget available again
    clock += 2000;
    expect(g.evaluate('p')).toBe('restarted');
  });

  it('real activity recovers the breaker (a live pane is never restarted)', () => {
    let clock = 1_000_000;
    let restarts = 0;
    const g = new Guardian({
      stuckAfterMs: 1000,
      maxRestartsPerWindow: 3,
      windowMs: 60 * 60 * 1000,
      now: () => clock,
      restart: () => {
        restarts += 1;
      },
    });
    g.register('p');
    // wedge it 3x then break
    for (let i = 0; i < 3; i++) {
      clock += 2000;
      g.evaluate('p');
    }
    clock += 2000;
    g.evaluate('p'); // trips
    expect(g.status('p')).toBe('BREAKER_OPEN');

    // Now the pane actually shows life (e.g. a snapshot arrives) -> breaker closes.
    g.activity('p', clock);
    expect(g.status('p')).toBe('OK');
    // and a healthy, recently-active pane must NOT be restarted
    expect(g.evaluate('p')).toBe('none');
    expect(restarts).toBe(3);
  });
});
