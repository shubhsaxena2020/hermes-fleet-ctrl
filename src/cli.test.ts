import { describe, it, expect } from 'vitest';
import { resolveFleetConfig, DEFAULTS, type ResolvedFleetConfig } from './cli.js';

// `resolveFleetConfig` is a pure mapping of `process.env` -> config, so we can
// drive it deterministically without booting the daemon or a tmux socket.

function withEnv(vars: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(vars)) {
    if (v !== undefined) env[k] = v;
  }
  return env;
}

describe('cli env parsing (FLEET_* knobs)', () => {
  it('applies documented defaults when no env is set', () => {
    const c = resolveFleetConfig(withEnv({}));
    expect(c.socket).toBe(DEFAULTS.socket);
    expect(c.journalPath).toBe(DEFAULTS.journalPath);
    expect(c.stuckAfterMs).toBe(DEFAULTS.stuckMs);
    expect(c.maxRestartsPerWindow).toBe(DEFAULTS.maxRestartsPerWindow);
    expect(c.restartWindowMs).toBe(DEFAULTS.restartWindowMs);
    expect(c.allowNudge).toBe(false);
    expect(c.protectedPanes).toBeUndefined();
    expect(c.agentPattern).toBeUndefined();
  });

  it('reads FLEET_MAX_RESTARTS and FLEET_RESTART_WINDOW_MS', () => {
    const c = resolveFleetConfig(
      withEnv({ FLEET_MAX_RESTARTS: '7', FLEET_RESTART_WINDOW_MS: '1800000' }),
    );
    expect(c.maxRestartsPerWindow).toBe(7);
    expect(c.restartWindowMs).toBe(1_800_000);
  });

  it('falls back to defaults on non-numeric / empty values', () => {
    const c = resolveFleetConfig(
      withEnv({ FLEET_MAX_RESTARTS: 'not-a-number', FLEET_RESTART_WINDOW_MS: '' }),
    );
    expect(c.maxRestartsPerWindow).toBe(DEFAULTS.maxRestartsPerWindow);
    expect(c.restartWindowMs).toBe(DEFAULTS.restartWindowMs);
  });

  it('parses FLEET_ALLOW_NUDGE, FLEET_PROTECTED and FLEET_AGENT_PATTERN', () => {
    const c: ResolvedFleetConfig = resolveFleetConfig(
      withEnv({
        FLEET_ALLOW_NUDGE: '1',
        FLEET_PROTECTED: 'hermes-main-0.0, hermes-main-2.1',
        FLEET_AGENT_PATTERN: 'worker',
      }),
    );
    expect(c.allowNudge).toBe(true);
    expect(c.protectedPanes).toEqual(['hermes-main-0.0', 'hermes-main-2.1']);
    expect(c.agentPattern).toBe('worker');
  });

  it('does not set protectedPanes/agentPattern when env is absent', () => {
    const c = resolveFleetConfig(withEnv({}));
    expect(c.protectedPanes).toBeUndefined();
    expect(c.agentPattern).toBeUndefined();
  });
});
