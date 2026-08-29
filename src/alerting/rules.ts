/**
 * Alert rules as *data* (T9).
 *
 * Alerts are no longer scattered through imperative code; they are a list of
 * declarative rules evaluated against a per-agent status snapshot. This makes the
 * alerting policy inspectable, testable, and editable without touching call sites.
 *
 * A rule has:
 *   - id: stable identifier
 *   - when: a pure predicate over an AlertInput snapshot
 *   - severity: 'info' | 'warning' | 'critical'
 *   - title: short human label
 *   - message: template rendered from the snapshot (supports {{agentId}} etc.)
 *
 * `evaluateAlerts(input, rules)` returns every rule currently firing, so callers
 * can de-dupe / throttle / push however they like.
 */

export type AlertSeverity = 'info' | 'warning' | 'critical';

/** The minimal per-agent facts an alert rule can reason about. */
export interface AlertInput {
  agentId: string;
  state: string;
  stuck: boolean;
  breakerOpen: boolean;
  breakerState: 'open' | 'closed';
  restartsInWindow: number;
  protected: boolean;
  heartbeatAgeMs: number;
}

export interface AlertRule {
  id: string;
  severity: AlertSeverity;
  title: string;
  /** Pure predicate; return true when this rule should fire. */
  when: (input: AlertInput) => boolean;
  /** Message template; {{agentId}} and {{...fields}} are interpolated. */
  message: string;
}

export interface FiredAlert {
  ruleId: string;
  severity: AlertSeverity;
  title: string;
  agentId: string;
  message: string;
}

function render(template: string, input: AlertInput): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => {
    const v = (input as unknown as Record<string, unknown>)[key];
    if (v === undefined) return '';
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    return String(v);
  });
}

/** Default alert policy: reproduces the prior hardcoded behavior as data. */
export const DEFAULT_ALERT_RULES: AlertRule[] = [
  {
    id: 'breaker-open',
    severity: 'critical',
    title: 'Circuit breaker open',
    when: (i) => i.breakerOpen || i.breakerState === 'open',
    message: 'Circuit breaker OPEN for {{agentId}} — pane unwatched after restart budget exhausted.',
  },
  {
    id: 'stuck',
    severity: 'warning',
    title: 'Agent stuck',
    when: (i) => i.stuck && !(i.breakerOpen || i.breakerState === 'open'),
    message: 'Agent {{agentId}} appears STUCK (no new output beyond stuckAfterMs).',
  },
  {
    id: 'heartbeat-stale',
    severity: 'info',
    title: 'Heartbeat stale',
    when: (i) => !i.stuck && !i.breakerOpen && i.heartbeatAgeMs > 5 * 60 * 1000,
    message: 'Agent {{agentId}} heartbeat is {{heartbeatAgeMs}}ms old.',
  },
];

/** Evaluate all rules against one agent snapshot; returns the currently-firing alerts. */
export function evaluateAlerts(input: AlertInput, rules: AlertRule[] = DEFAULT_ALERT_RULES): FiredAlert[] {
  const fired: FiredAlert[] = [];
  for (const rule of rules) {
    if (rule.when(input)) {
      fired.push({
        ruleId: rule.id,
        severity: rule.severity,
        title: rule.title,
        agentId: input.agentId,
        message: render(rule.message, input),
      });
    }
  }
  return fired;
}

const SEVERITIES: AlertSeverity[] = ['info', 'warning', 'critical'];

/**
 * Validate a list of alert rules (data-driven policy). Returns every problem
 * found so an operator editing the rule set gets a complete picture rather than
 * a cryptic failure at eval time. Used to fail fast when loading a custom rule
 * file in production.
 */
export function validateAlertRules(rules: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!Array.isArray(rules)) {
    return { ok: false, errors: ['alert rules must be an array'] };
  }
  rules.forEach((r, i) => {
    const where = `rules[${i}]`;
    if (typeof r !== 'object' || r === null) {
      errors.push(`${where} must be an object`);
      return;
    }
    const rule = r as Partial<AlertRule>;
    if (typeof rule.id !== 'string' || rule.id.length === 0) errors.push(`${where}.id must be a non-empty string`);
    if (typeof rule.severity !== 'string' || !SEVERITIES.includes(rule.severity)) {
      errors.push(`${where}.severity must be one of: info | warning | critical`);
    }
    if (typeof rule.title !== 'string' || rule.title.length === 0) errors.push(`${where}.title must be a non-empty string`);
    if (typeof rule.message !== 'string') errors.push(`${where}.message must be a string`);
    if (typeof rule.when !== 'function') errors.push(`${where}.when must be a function`);
  });
  return { ok: errors.length === 0, errors };
}
