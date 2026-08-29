import { describe, it, expect } from 'vitest';
import { evaluateAlerts, DEFAULT_ALERT_RULES, validateAlertRules, type AlertInput } from './rules.js';

function make(over: Partial<AlertInput> = {}): AlertInput {
  return {
    agentId: 'agent-1',
    state: 'ACTIVE_THINKING',
    stuck: false,
    breakerOpen: false,
    breakerState: 'closed',
    restartsInWindow: 0,
    protected: false,
    heartbeatAgeMs: 0,
    ...over,
  };
}

describe('alert rules as data (T9)', () => {
  it('fires the breaker-open rule as critical when the breaker is open', () => {
    const alerts = evaluateAlerts(make({ breakerOpen: true, breakerState: 'open' }));
    const crit = alerts.find((a) => a.ruleId === 'breaker-open');
    expect(crit).toBeTruthy();
    expect(crit?.severity).toBe('critical');
    expect(crit?.message).toContain('agent-1');
  });

  it('fires the stuck rule as warning (but not when breaker already open)', () => {
    const alerts = evaluateAlerts(make({ stuck: true }));
    expect(alerts.find((a) => a.ruleId === 'stuck')).toBeTruthy();
    // When the breaker is also open, the stuck rule must NOT fire (open is the dominant state).
    const both = evaluateAlerts(make({ stuck: true, breakerOpen: true, breakerState: 'open' }));
    expect(both.find((a) => a.ruleId === 'stuck')).toBeUndefined();
    expect(both.find((a) => a.ruleId === 'breaker-open')).toBeTruthy();
  });

  it('fires the stale-heartbeat info rule past the threshold', () => {
    const alerts = evaluateAlerts(make({ heartbeatAgeMs: 6 * 60 * 1000 }));
    expect(alerts.find((a) => a.ruleId === 'heartbeat-stale')).toBeTruthy();
  });

  it('healthy agent fires nothing', () => {
    expect(evaluateAlerts(make({}))).toHaveLength(0);
  });

  it('is data-driven: a custom rule set changes behavior without touching call sites', () => {
    const custom = [
      { id: 'always', severity: 'info' as const, title: 'Always', when: () => true, message: 'hi {{agentId}}' },
    ];
    const alerts = evaluateAlerts(make({}), custom);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.ruleId).toBe('always');
  });

  it('default rule set is non-empty', () => {
    expect(DEFAULT_ALERT_RULES.length).toBeGreaterThan(0);
  });

  describe('alert rule schema validation (B8)', () => {
    it('accepts the shipped DEFAULT_ALERT_RULES', () => {
      const r = validateAlertRules(DEFAULT_ALERT_RULES);
      expect(r.ok).toBe(true);
      expect(r.errors).toHaveLength(0);
    });

    it('accepts a well-formed custom rule set', () => {
      const r = validateAlertRules([
        { id: 'x', severity: 'info', title: 'T', message: 'm {{agentId}}', when: () => false },
      ]);
      expect(r.ok).toBe(true);
    });

    it('rejects a non-array rule set', () => {
      const r = validateAlertRules({ id: 'x' });
      expect(r.ok).toBe(false);
      expect(r.errors).toContain('alert rules must be an array');
    });

    it('rejects a rule with missing fields and an unknown severity', () => {
      const r = validateAlertRules([
        { id: '', severity: 'fatal', title: '', message: 5, when: 'nope' },
      ]);
      expect(r.ok).toBe(false);
      expect(r.errors).toContain('rules[0].id must be a non-empty string');
      expect(r.errors).toContain('rules[0].severity must be one of: info | warning | critical');
      expect(r.errors).toContain('rules[0].title must be a non-empty string');
      expect(r.errors).toContain('rules[0].message must be a string');
      expect(r.errors).toContain('rules[0].when must be a function');
    });

    it('rejects a null element in the rule list', () => {
      const r = validateAlertRules([null]);
      expect(r.ok).toBe(false);
      expect(r.errors).toContain('rules[0] must be an object');
    });

    it('collects every problem, not just the first', () => {
      const r = validateAlertRules([
        { id: '', severity: 'info', title: 't', message: 'm', when: () => true },
        { id: 'ok', severity: 'warning', title: 'T', message: 'm', when: () => false },
      ]);
      expect(r.ok).toBe(false);
      expect(r.errors).toContain('rules[0].id must be a non-empty string');
      expect(r.errors.length).toBe(1); // only the one bad field
    });
  });
});
