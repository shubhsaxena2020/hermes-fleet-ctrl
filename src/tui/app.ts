/**
 * TUI control-plane dashboard for the agent fleet.
 *
 * A live, keyboard-driven view of every agent's state, the task queue, the audit trail, and circuit-breaker status — plus an input line to dispatch goals to a selected agent. Built on `blessed` for the real terminal, but the entire model and rendering are pure and TTY-free so they can be unit-tested headlessly.
 *
 * Usage:
 *   const tui = new FleetTui(fleet);
 *   tui.mount();           // attaches a blessed screen and starts the live loop
 *
 * The blessed layer is intentionally thin: all state lives in `TuiModel`, and `renderLines(model)` produces the exact text the screen shows. Tests exercise the model + renderLines + input parsing without spawning a terminal.
 */

import * as blessed from 'blessed';
import type { FleetControl, AgentView, FleetEvent } from '../server/fleet-control.js';

export interface TuiModel {
  agents: AgentView[];
  tasks: Array<{ taskId: string; state: string; priority: string; leasedTo: number | undefined }>;
  audit: Array<{ actor: string; action: string; detail: string | null }>;
  selected: number;
  input: string;
  lastEvent: string;
}

export interface TuiOptions {
  /** When false, mount() throws (so tests never open a real terminal). */
  allowBlessed?: boolean;
}

const STATE_GLYPH: Record<string, string> = {
  ACTIVE_THINKING: '🧠',
  RUNNING_COMMAND: '⚙',
  WAITING_USER_INPUT: '❓',
  ERROR_PROMPT: '✗',
  IDLE: '·',
};

/** Parse the bottom input line: "agentId: prompt" or just "prompt" (uses selection). */
export function parseGoalInput(text: string, selectedAgentId: string | undefined): { agentId: string; prompt: string } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const colon = trimmed.indexOf(':');
  if (colon > 0 && colon < 40) {
    const maybeId = trimmed.slice(0, colon).trim();
    const prompt = trimmed.slice(colon + 1).trim();
    if (prompt) return { agentId: maybeId, prompt };
  }
  if (!selectedAgentId) return null;
  return { agentId: selectedAgentId, prompt: trimmed };
}

/** Compose the dashboard text (no blessed dependency). Pure + testable. */
export function renderLines(model: TuiModel): string[] {
  const lines: string[] = [];
  lines.push('HERMES FLEET CONTROL  —  agents: ' + model.agents.length + '   tasks: ' + model.tasks.length);
  lines.push('─'.repeat(60));
  if (model.agents.length === 0) {
    lines.push('📭 No agents registered. Configure hosts in config.json or via environment.');
  } else {
    // Walk agents in original order to preserve selection markers and add visual separation
    let lastGroup: 'live' | 'stale' | 'breaker' | 'protected' | null = null;
    model.agents.forEach((a, i) => {
      const isStale = a.stuck && !(a.breakerOpen || a.breakerState === 'open');
      const isBreaker = a.breakerOpen || a.breakerState === 'open';
      const isProtected = a.protected && !(a.breakerOpen || a.breakerState === 'open');
      const group: 'live' | 'stale' | 'breaker' | 'protected' =
        isBreaker ? 'breaker' :
        isProtected ? 'protected' :
        isStale ? 'stale' :
        'live';

      // Insert a section header when the group changes
      if (group !== lastGroup) {
        switch (group) {
          case 'live': lines.push('🟢 LIVE AGENTS'); break;
          case 'stale': lines.push('🟡 STALE AGENTS (no new output)'); break;
          case 'breaker': lines.push('🔴 BREAKER OPEN (unwatched)'); break;
          case 'protected': lines.push('⚪ PROTECTED AGENTS'); break;
        }
        lines.push('');
        lastGroup = group;
      }

      const sel = i === model.selected ? '▶' : ' ';
      const glyph = STATE_GLYPH[a.state] ?? '?';
      const lastTs = a.lastNormalized ? Date.parse(a.lastNormalized) : 0;
      const heartbeatAge = lastTs > 0 ? Math.max(0, Date.now() - lastTs) : 0;
      const hbStr = heartbeatAge > 5000 ? ` (${Math.round(heartbeatAge / 1000)}s ago)` : '';
      lines.push(`${sel} ${i}. ${a.agentId}  ${glyph} ${a.state}${hbStr}  (restarts ${a.restartsInWindow})`);
    });
  }
  lines.push('─'.repeat(60));
  lines.push('TASKS  (top 8):');
  model.tasks.slice(0, 8).forEach((t) => {
    const priorityIcon = t.priority === 'CRITICAL' ? '🔴' : t.priority === 'HIGH' ? '🟠' : t.priority === 'NORMAL' ? '🟡' : '⚪';
    lines.push(`  ${priorityIcon} ${t.state.padEnd(9)} ${t.priority.padEnd(8)} ${t.taskId}${t.leasedTo !== undefined ? ` @slot${t.leasedTo}` : ''}`);
  });
  lines.push('─'.repeat(60));
  lines.push('AUDIT  (last 5):');
  model.audit.slice(0, 5).forEach((r) => {
    const time = new Date((r as { ts?: number }).ts || Date.now()).toLocaleTimeString();
    const detail = (r.detail ?? '').slice(0, 50);
    lines.push(`  [${time}] ${r.actor}:${r.action} ${detail}`);
  });
  lines.push('─'.repeat(60));
  lines.push('> ' + model.input + '_');
  lines.push('(type "agentId: goal" + Enter to dispatch; ↑/↓ select; r=reset breaker)');
  return lines;
}

export class FleetTui {
  private readonly fleet: FleetControl;
  private readonly allowBlessed: boolean;
  private model: TuiModel = { agents: [], tasks: [], audit: [], selected: 0, input: '', lastEvent: '' };
  private screen: unknown = undefined;

  constructor(fleet: FleetControl, opts: TuiOptions = {}) {
    this.fleet = fleet;
    this.allowBlessed = opts.allowBlessed ?? true;
  }

  /** Build the initial model from the fleet's current state. */
  sync(): TuiModel {
    this.model = {
      agents: this.fleet.agentViews(),
      tasks: this.fleet.engine.snapshot(),
      audit: this.fleet.recentAudit(3).map((r) => ({ actor: r.actor, action: r.action, detail: r.detail })),
      selected: Math.min(this.model.selected, Math.max(0, this.fleet.agentViews().length - 1)),
      input: this.model.input,
      lastEvent: this.model.lastEvent,
    };
    return this.model;
  }

  get current(): TuiModel {
    return this.model;
  }

  /** Subscribe to fleet events and keep the model fresh. Call once. */
  bind(): void {
    const onEvent = (e: FleetEvent) => {
      this.model.lastEvent = `${e.type}:${'agentId' in e ? e.agentId : 'taskId' in e ? e.taskId : ''}`;
      this.sync();
      this.refresh();
    };
    this.fleet.on('snapshot', onEvent);
    this.fleet.on('task', onEvent);
    this.fleet.on('guardian', onEvent);
  }

  /** Dispatch the current input line (parsed) to the fleet. Returns the result. */
  dispatchInput(): { agentId: string; prompt: string } | null {
    const sel = this.model.agents[this.model.selected]?.agentId;
    const parsed = parseGoalInput(this.model.input, sel);
    if (!parsed) return null;
    this.fleet.enqueueGoal(parsed.agentId, parsed.prompt);
    this.model.input = '';
    this.sync();
    this.refresh();
    return parsed;
  }

  /** Operator resets the circuit breaker for the selected agent. */
  resetSelectedBreaker(): void {
    const sel = this.model.agents[this.model.selected]?.agentId;
    if (sel) {
      this.fleet.guardian.resetBreaker(sel);
      this.sync();
      this.refresh();
    }
  }

  moveSelection(delta: number): void {
    const n = this.model.agents.length;
    if (n === 0) return;
    this.model.selected = (this.model.selected + delta + n) % n;
    this.refresh();
  }

  setInput(text: string): void {
    this.model.input = text;
    this.refresh();
  }

  // --- blessed layer (only used in a real terminal) ---

  private refresh(): void {
    if (this.screen && typeof (this.screen as { setContent?: (s: string) => void }).setContent === 'function') {
      (this.screen as { setContent: (s: string) => void }).setContent(renderLines(this.model).join('\n'));
      if (typeof (this.screen as { render?: () => void }).render === 'function') {
        (this.screen as { render: () => void }).render();
      }
    }
  }

  /** Attach a blessed screen and start the live loop. Requires a TTY. */
  mount(): void {
    if (!this.allowBlessed) {
      throw new Error('blessed mount disabled in this context (set allowBlessed: true)');
    }
    const screen = blessed.screen({ smartCSR: true, title: 'Hermes Fleet Control' });
    const box = blessed.box({
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      scrollbar: { ch: ' ' },
    });
    screen.append(box);
    this.screen = box;

    this.bind();
    this.sync();
    this.refresh();

    screen.key(['escape', 'C-c'], () => process.exit(0));
    screen.key(['up'], () => this.moveSelection(-1));
    screen.key(['down'], () => this.moveSelection(1));
    screen.key(['r'], () => this.resetSelectedBreaker());
    screen.key(['enter'], () => this.dispatchInput());
    screen.key(['C-c'], () => process.exit(0));

    // Editable input: capture printable keys into the model.
    screen.on('keypress', (_ch: string, key: { name?: string; full?: string }) => {
      if (!key || key.name === 'enter' || key.name === 'up' || key.name === 'down') return;
      if (key.name === 'backspace') {
        this.model.input = this.model.input.slice(0, -1);
      } else if (key.full && key.full.length === 1) {
        this.model.input += key.full;
      } else if (key.name === 'space') {
        this.model.input += ' ';
      }
      this.refresh();
    });

    screen.render();
  }
}