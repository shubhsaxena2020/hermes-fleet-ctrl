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

  it('a heartbeat alone does NOT recover the breaker until the window drains (issue #1)', () => {
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

    // A heartbeat arrives, but inside the window: breaker must STAY open and the
    // pane must NOT be restarted (it is unwatched but protected from re-nagging).
    clock += 30 * 60 * 1000;
    g.activity('p', clock);
    expect(g.status('p')).toBe('BREAKER_OPEN');
    expect(g.evaluate('p')).toBe('none');
    expect(restarts).toBe(3);

    // Once the window drains AND a heartbeat has arrived, the breaker auto-closes.
    clock += 30 * 60 * 1000 + 1000;
    expect(g.status('p')).toBe('OK');
    expect(g.evaluate('p')).toBe('none');
  });
});

describe('Guardian — circuit breaker auto-close (issue #1 regression)', () => {
  // Wedge a pane exactly 3 times then trip the breaker.
  function trip(g: Guardian, clock: { v: number }): void {
    for (let i = 0; i < 3; i++) {
      clock.v += 2000;
      g.evaluate('p');
    }
    clock.v += 2000;
    expect(g.evaluate('p')).toBe('breaker_tripped');
    expect(g.status('p')).toBe('BREAKER_OPEN');
  }

  it('does NOT auto-close when the window is NOT drained, even with a fresh heartbeat', () => {
    const clock = { v: 1_000_000 };
    const g = new Guardian({
      stuckAfterMs: 1000,
      maxRestartsPerWindow: 3,
      windowMs: 60 * 60 * 1000,
      now: () => clock.v,
    });
    g.register('p');
    trip(g, clock);

    // Half the window later a heartbeat proves the pane is alive...
    clock.v += 30 * 60 * 1000; // 30 min — window NOT drained (3 restarts still inside 1h)
    g.activity('p', clock.v);

    // ...but the breaker must STAY OPEN until the window fully drains.
    expect(g.status('p')).toBe('BREAKER_OPEN');
  });

  it('does NOT auto-close when the window has drained but NO heartbeat arrived', () => {
    const clock = { v: 1_000_000 };
    const g = new Guardian({
      stuckAfterMs: 1000,
      maxRestartsPerWindow: 3,
      windowMs: 60 * 60 * 1000,
      now: () => clock.v,
    });
    g.register('p');
    trip(g, clock);

    // Advance past the full 1h window: restart timestamps prune away...
    clock.v += 60 * 60 * 1000 + 1000;
    expect(g.restartCount('p')).toBe(0);

    // ...but with no heartbeat to prove liveness, the breaker stays open.
    expect(g.status('p')).toBe('BREAKER_OPEN');
  });

  it('auto-closes ONLY when the window has drained AND a fresh heartbeat proves liveness', () => {
    const clock = { v: 1_000_000 };
    const g = new Guardian({
      stuckAfterMs: 1000,
      maxRestartsPerWindow: 3,
      windowMs: 60 * 60 * 1000,
      now: () => clock.v,
    });
    g.register('p');
    trip(g, clock);

    // Window drains.
    clock.v += 60 * 60 * 1000 + 1000;
    expect(g.restartCount('p')).toBe(0);

    // Fresh heartbeat proves the pane is alive.
    g.activity('p', clock.v);

    // Both conditions met -> breaker auto-closes.
    expect(g.status('p')).toBe('OK');
    // and a healthy, recently-active pane is not restarted.
    expect(g.evaluate('p')).toBe('none');
    });
    });

    describe('Guardian — idempotent heartbeat reopen (T5)', () => {
    function tripWith(g: Guardian, clock: { v: number }): void {
      for (let i = 0; i < 3; i++) {
        clock.v += 2000;
        g.evaluate('p');
      }
      clock.v += 2000;
      g.evaluate('p'); // trips -> onTransition(open)
    }

    it('emits exactly one transition per state change via onTransition', () => {
      const clock = { v: 1_000_000 };
      const transitions: string[] = [];
      const g = new Guardian({
        stuckAfterMs: 1000,
        maxRestartsPerWindow: 3,
        windowMs: 60 * 60 * 1000,
        now: () => clock.v,
        onTransition: (e) => transitions.push(`${e.from}->${e.to}:${e.reason}`),
      });
      g.register('p');
      tripWith(g, clock);
      expect(transitions).toEqual(['closed->open:restart_budget_exhausted']);

      // Window drains + heartbeat -> exactly one auto-close transition.
      clock.v += 60 * 60 * 1000 + 1000;
      g.activity('p', clock.v);
      g.status('p');
      expect(transitions).toEqual([
        'closed->open:restart_budget_exhausted',
        'open->closed:auto_close_window_drained_heartbeat',
      ]);
    });

    it('a duplicate heartbeat does NOT double-transition (idempotent reopen)', () => {
      const clock = { v: 1_000_000 };
      const transitions: string[] = [];
      const g = new Guardian({
        stuckAfterMs: 1000,
        maxRestartsPerWindow: 3,
        windowMs: 60 * 60 * 1000,
        now: () => clock.v,
        onTransition: (e) => transitions.push(`${e.from}->${e.to}`),
      });
      g.register('p');
      tripWith(g, clock);

      // Window drains.
      clock.v += 60 * 60 * 1000 + 1000;

      // Multiple heartbeats arrive (e.g. several snapshots) — only one reopen.
      g.activity('p', clock.v);
      g.activity('p', clock.v);
      g.activity('p', clock.v);
      g.status('p'); // open -> closed (consumes the single heartbeat flag)
      g.status('p'); // already closed -> no transition

      // Calling status() again with no new heartbeat must NOT reopen (no-op path).
      g.status('p');
      expect(transitions).toEqual(['closed->open', 'open->closed']);
    });

    it('operator reset only fires when actually open, and is idempotent', () => {
      const clock = { v: 1_000_000 };
      const transitions: string[] = [];
      const g = new Guardian({
        stuckAfterMs: 1000,
        maxRestartsPerWindow: 3,
        windowMs: 60 * 60 * 1000,
        now: () => clock.v,
        onTransition: (e) => transitions.push(`${e.from}->${e.to}:${e.reason}`),
      });
      g.register('p');
      // Reset on a closed breaker is a no-op (no transition).
      g.resetBreaker('p');
      expect(transitions).toHaveLength(0);

      tripWith(g, clock);
      expect(transitions).toEqual(['closed->open:restart_budget_exhausted']);
      // Double reset emits exactly one transition (idempotent).
      g.resetBreaker('p');
      g.resetBreaker('p');
      expect(transitions).toEqual([
        'closed->open:restart_budget_exhausted',
        'open->closed:operator_reset',
      ]);
    });
    });
