import { describe, it, expect } from 'vitest';
import { validateConfig, defaultConfig, type DaemonConfig } from './schema.js';

describe('config schema validation (T12)', () => {
  it('accepts a well-formed config', () => {
    const cfg: DaemonConfig = {
      ...defaultConfig(),
      agents: { 'agent-1': { host: 'h1', pane: '0.0' } },
    };
    const r = validateConfig(cfg);
    expect(r.ok).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it('rejects empty/negative numerics with precise errors', () => {
    const r = validateConfig({
      stuckAfterMs: 0,
      maxRestartsPerWindow: -1,
      restartWindowMs: 'x',
      pollIntervalMs: 1000,
      slots: 7,
      agents: { 'agent-1': { host: 'h1', pane: '0.0' } },
    });
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('stuckAfterMs must be a positive integer (ms)');
    expect(r.errors).toContain('maxRestartsPerWindow must be a positive integer');
    expect(r.errors).toContain('restartWindowMs must be a positive integer (ms)');
  });

  it('rejects a missing/empty agents record', () => {
    expect(validateConfig({ ...defaultConfig(), agents: {} }).errors).toContain('agents must contain at least one agent');
    expect(validateConfig({ ...defaultConfig() }).errors.some((e) => e.includes('agents'))).toBe(true);
  });

  it('rejects malformed per-agent host/pane', () => {
    const r = validateConfig({
      ...defaultConfig(),
      agents: { 'agent-1': { host: '', pane: '0.0' }, 'agent-2': { host: 'h2', pane: '' } },
    });
    expect(r.errors).toContain('agents.agent-1.host must be a non-empty string');
    expect(r.errors).toContain('agents.agent-2.pane must be a non-empty string');
  });

  it('rejects non-array protectedIds', () => {
    const r = validateConfig({ ...defaultConfig(), agents: { a: { host: 'h', pane: '0' } }, protectedIds: 'window0' as unknown as string[] });
    expect(r.errors).toContain('protectedIds must be an array of strings');
  });

  it('defaultConfig() is itself valid', () => {
    // (default has no agents, so add one)
    expect(validateConfig({ ...defaultConfig(), agents: { a: { host: 'h', pane: '0' } } }).ok).toBe(true);
  });
});
