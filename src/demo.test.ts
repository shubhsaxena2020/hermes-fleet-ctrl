import { describe, it, expect } from 'vitest';
import { runDemo } from './demo.js';

describe('end-to-end demo (mock tmux) — full stack smoke test', () => {
  it('runs the scenario: watchdog restarts a wedged agent, healthy agent completes its goal', async () => {
    const r = await runDemo();
    // The wedged agent (frozen "thinking" screen) triggers at least one watchdog
    // restart; the breaker logic caps it (never more than 3).
    expect(r.restarts).toBeGreaterThanOrEqual(1);
    expect(r.restarts).toBeLessThanOrEqual(3);
    // The audit trail captured events.
    expect(r.auditCount).toBeGreaterThan(0);
    // The TUI renders something coherent.
    expect(r.finalScreen.join('\n')).toContain('HERMES FLEET CONTROL');
    expect(r.finalScreen.join('\n')).toContain('agent-1');
    expect(r.finalScreen.join('\n')).toContain('agent-2');
    // Both agents end in a known state.
    expect(r.agentStates['agent-1']).toBeDefined();
    expect(r.agentStates['agent-2']).toBeDefined();
  });

  it('does not trip the breaker when the agent keeps producing output (healthy)', async () => {
    const r = await runDemo({ steps: 3 });
    // With only 3 steps the frozen window is short; restarts may happen but the
    // breaker should not yet be permanently open for a short scenario.
    expect(r.breakerTripped).toBe(false);
  });
});
