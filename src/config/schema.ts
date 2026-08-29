/**
 * Daemon configuration schema + validation (T12).
 *
 * Keeps config validation as a pure, dependency-free function so the daemon
 * fails fast with a precise error list instead of throwing deep inside boot.
 * A typed `DaemonConfig` is the single source of truth for the CLI/defaults.
 */

export interface AgentHostConfig {
  host: string;
  pane: string;
  /** Optional human label for the dashboard. */
  label?: string;
}

export interface DaemonConfig {
  /** How long a pane may be silent before it is STUCK (ms). */
  stuckAfterMs: number;
  /** Restart budget per rolling window. */
  maxRestartsPerWindow: number;
  /** Rolling window for the restart budget (ms). */
  restartWindowMs: number;
  /** Poll interval for the fleet loop (ms). */
  pollIntervalMs: number;
  /** Concurrency slots for the goal-dispatched task engine. */
  slots: number;
  /** Agents to monitor (id -> connection). */
  agents: Record<string, AgentHostConfig>;
  /** Agent IDs that must never be nudged or dispatched into. */
  protectedIds?: string[];
  /** Enable gentle "continue" nudges on STUCK (operator override). */
  allowNudge?: boolean;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

const isPositiveInt = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

/**
 * Validate a daemon config. Returns every problem found (not just the first) so
 * the operator gets a complete picture. Pure — no I/O, no throwing.
 */
export function validateConfig(cfg: unknown): ValidationResult {
  const errors: string[] = [];
  if (typeof cfg !== 'object' || cfg === null) {
    return { ok: false, errors: ['config must be an object'] };
  }
  const c = cfg as Partial<DaemonConfig>;

  if (!isPositiveInt(c.stuckAfterMs)) errors.push('stuckAfterMs must be a positive integer (ms)');
  if (!isPositiveInt(c.maxRestartsPerWindow)) errors.push('maxRestartsPerWindow must be a positive integer');
  if (!isPositiveInt(c.restartWindowMs)) errors.push('restartWindowMs must be a positive integer (ms)');
  if (!isPositiveInt(c.pollIntervalMs)) errors.push('pollIntervalMs must be a positive integer (ms)');
  if (!isPositiveInt(c.slots)) errors.push('slots must be a positive integer');

  if (typeof c.agents !== 'object' || c.agents === null || Array.isArray(c.agents)) {
    errors.push('agents must be a non-empty record of agentId -> { host, pane }');
  } else if (Object.keys(c.agents).length === 0) {
    errors.push('agents must contain at least one agent');
  } else {
    for (const [id, a] of Object.entries(c.agents)) {
      if (typeof a?.host !== 'string' || a.host.length === 0) {
        errors.push(`agents.${id}.host must be a non-empty string`);
      }
      if (typeof a?.pane !== 'string' || a.pane.length === 0) {
        errors.push(`agents.${id}.pane must be a non-empty string`);
      }
    }
  }

  if (c.protectedIds !== undefined && (!Array.isArray(c.protectedIds) || !c.protectedIds.every((x) => typeof x === 'string'))) {
    errors.push('protectedIds must be an array of strings');
  }

  return { ok: errors.length === 0, errors };
}

/** A default config for local/demo runs (not for production — production loads a file). */
export function defaultConfig(): DaemonConfig {
  return {
    stuckAfterMs: 1000,
    maxRestartsPerWindow: 3,
    restartWindowMs: 60 * 60 * 1000,
    pollIntervalMs: 2000,
    slots: 7,
    agents: {},
    protectedIds: [],
    allowNudge: false,
  };
}
