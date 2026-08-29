/**
 * ANSI terminal stream normalizer & agent state classifier.
 *
 * Used by the remote tmux telemetry engine to turn a raw `capture-pane -e`
 * buffer (full of color codes / cursor moves / spinner frames) into:
 *   - clean text (`normalizeAnsi`)
 *   - a structured classification of what the agent in that pane is doing
 *     (`classifyPane`) via the `AgentState` enum.
 */

/** High-level state of an agent pane at a point in time. */
export enum AgentState {
  ACTIVE_THINKING = 'ACTIVE_THINKING',
  RUNNING_COMMAND = 'RUNNING_COMMAND',
  WAITING_USER_INPUT = 'WAITING_USER_INPUT',
  ERROR_PROMPT = 'ERROR_PROMPT',
  IDLE = 'IDLE',
}

/** Braille spinner frames used by many TUIs. */
const BRAILLE_SPINNERS = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
// ASCII spinner glyphs. Tested ONLY when a line *starts* with one (spinners are
// drawn at the beginning of a line), so we don't false-trigger on '/' in URLs or
// '-' in wrapped text or '|' in tables/pipes. The glyph may be the last char on
// the line (e.g. "Running... |") so we allow a trailing space/tab OR end-of-line.
const ASCII_SPINNER_RE = /^\s*[|/-\\](?=[ \t]|$)/;

const ERROR_PATTERNS: RegExp[] = [
  /\berror\b/i,
  /\bfatal\b/i,
  /traceback \(most recent call last\)/i,
  /\bexception\b/i,
  /\bfailed\b/i,
  /\berr!/i,
  /command not found/i,
  /exit status [1-9]/i,
  /[✗×]/,
  /permission denied/i,
  /\bcannot\b/i,
  /\bundefined\b/i,
  /\bnull reference\b/i,
];

const TOOL_RUNNING_PATTERNS: RegExp[] = [
  /⏵\s*running/i,
  /▶\s*running/i,
  /\brunning\b[:\s].*(command|test|build|task)/i,
  /\bnpm (run|install|ci|test|build)\b/i,
  /\bpip install\b/i,
  /\bpytest\b/i,
  // pytest/textual live progress: "collected 42 items", "test_foo.py ..", "42 passed"
  /\bcollected \d+ (items?|tests?)\b/i,
  /^\s*\S+\.py\s+\.+/m,
  /\b\d+ (passed|failed|skipped)\b/i,
  // generic progress bars / pass-fail marks
  /\d+%\|/,
  /[✓✔]\s*pass/i,
  /\bcargo (build|test|run|check)\b/i,
  /\bgo (test|build|run)\b/i,
  /\bmake\b/i,
  /\btsc\b/i,
  /\bdocker (build|run|compose)\b/i,
  /\bbun (run|install)\b/i,
  /\bpnpm (run|install|test)\b/i,
];

const THINKING_PATTERNS: RegExp[] = [
  /\bthinking\b/i,
  /\breasoning\b/i,
  /\banalyz/i,
  /🧠/,
  /⠿/,
];

/**
 * The Hermes Agent TUI chrome. A live agent renders a footer like
 *   "⚕ hy3 · 0% · 🗜️ 3 · ⊙ goal 0/20 · 2h 1m · ⚠ YOLO"
 * followed by a status line. Presence of this chrome means the agent is at its
 * resting command bar (ready to receive a goal) rather than crashed. We treat it
 * as IDLE-equivalent for classification *when no stronger signal is present*, so
 * a healthy agent is not mislabeled ERROR_PROMPT just because an earlier line in
 * its scrollback contained the word "error".
 */
const HERMES_TUI_PATTERNS: RegExp[] = [
  /⚕\s.*hy3/,
  /⊙\s*goal/,
  /🗜️/,
  /msg=interrupt/,
  /\/queue · \/bg · \/steer/,
];

/** Affordances that mean the agent is parked at an interactive prompt. */
const WAIT_PATTERNS: RegExp[] = [
  /[?]/, // any question mark on the last line = interactive prompt (errors checked first)
  /\([Yy]\/[Nn]\)/,
  /\[[Yy]\/[Nn]\]/,
  /\[y\/n\]/,
  /press (enter|any key|return)/i,
  /do you want to (proceed|continue|confirm)/i,
  /continue\?/i,
  /enter your/i,
  /(proceed|confirm|accept)\?/i,
];

/** A fresh, idle shell prompt at the end of the screen. */
const IDLE_PROMPT_PATTERNS: RegExp[] = [
  /\$\s*$/,
  /#\s*$/,
  /* eslint-disable no-control-regex */
  /%(?:\s|\x1b|$)/,
  /* eslint-enable no-control-regex */
  /❯\s*$/,
  /└─\s*$/,
  /›\s*$/,
];

export interface ClassificationSignals {
  hasError: boolean;
  hasWait: boolean;
  hasSpinner: boolean;
  hasThinking: boolean;
  hasToolRunning: boolean;
  hasHermesTui: boolean;
  trailingIdlePrompt: boolean;
  lastLine: string;
}

export interface PaneClassification {
  state: AgentState;
  normalized: string;
  signals: ClassificationSignals;
}

/** Remove all ANSI/escape sequences, preserving printable text and line breaks. */
/* eslint-disable no-control-regex */
export function normalizeAnsi(input: string): string {
  let s = input;
  // OSC sequences: ESC ] ... (BEL or ST)
  s = s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
  // CSI sequences: ESC [ ... final byte
  s = s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
  // charset / mode escapes: ESC ( ) * B 0 etc., and ESC = > c
  s = s.replace(/\x1b[()*][0-9A-Z]/g, '');
  s = s.replace(/\x1b[=>]/g, '');
  // any other lone ESC not consumed above
  s = s.replace(/\x1b[^\x1b]/g, '');
  // carriage returns -> drop (keep newlines)
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '');
  // trailing whitespace per line (tmux pads wrapped lines)
  s = s
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n');
  return s;
}
/* eslint-enable no-control-regex */

function detectSignals(text: string): ClassificationSignals {
  const brailleSpinner = [...BRAILLE_SPINNERS].some((c) => text.includes(c));
  const asciiSpinner = text.split('\n').some((l) => ASCII_SPINNER_RE.test(l));
  const hasSpinner = brailleSpinner || asciiSpinner;
  const hasThinking = THINKING_PATTERNS.some((re) => re.test(text));
  const hasToolRunning = TOOL_RUNNING_PATTERNS.some((re) => re.test(text));
  const hasHermesTui = HERMES_TUI_PATTERNS.some((re) => re.test(text));

  // Weak error words ("error", "failed", "cannot") are extremely common in agent
  // scrollback and must NOT override the live Hermes TUI state. Only STRONG error
  // signatures (traceback, exception, fatal, exit status, permission denied,
  // command not found) count when the agent is at its resting command bar.
  const STRONG_ERROR_PATTERNS: RegExp[] = [
    /traceback \(most recent call last\)/i,
    /\bexception\b/i,
    /\bfatal\b/i,
    /exit status [1-9]/i,
    /permission denied/i,
    /command not found/i,
    /[✗×]/,
  ];
  const weakError = ERROR_PATTERNS.some((re) => re.test(text));
  const strongError = STRONG_ERROR_PATTERNS.some((re) => re.test(text));
  const hasError = strongError || (weakError && !hasHermesTui);

  const lines = text.split('\n').map((l) => l.trim());
  const lastLine = lines.filter((l) => l.length > 0).at(-1) ?? '';
  const hasWait = WAIT_PATTERNS.some((re) => re.test(lastLine));
  const trailingIdlePrompt = IDLE_PROMPT_PATTERNS.some((re) => re.test(lastLine));

  return { hasError, hasWait, hasSpinner, hasThinking, hasToolRunning, hasHermesTui, trailingIdlePrompt, lastLine };
}

/**
 * Classify an agent pane from its raw tmux screen buffer.
 *
 * Precedence (most salient first):
 *   1. ERROR_PROMPT  — an error signature is present (agent is in a failure/decision state)
 *   2. WAITING_USER_INPUT — parked at an interactive prompt (no error)
 *   3. RUNNING_COMMAND — a tool/command is executing
 *   4. ACTIVE_THINKING — agent is reasoning / spinner animating
 *   5. IDLE — nothing happening (idle shell prompt or blank)
 */
export function classifyPane(raw: string): PaneClassification {
  const normalized = normalizeAnsi(raw);
  const signals = detectSignals(normalized);

  let state: AgentState;
  if (signals.hasError) {
    state = AgentState.ERROR_PROMPT;
  } else if (signals.hasWait) {
    state = AgentState.WAITING_USER_INPUT;
  } else if (signals.hasToolRunning) {
    state = AgentState.RUNNING_COMMAND;
  } else if (signals.hasSpinner || signals.hasThinking) {
    state = AgentState.ACTIVE_THINKING;
  } else if (signals.trailingIdlePrompt) {
    state = AgentState.IDLE;
  } else if (signals.hasHermesTui) {
    // The Hermes command bar is visible but no work signal is present -> the
    // agent is at its resting prompt, ready for a goal (not crashed).
    state = AgentState.IDLE;
  } else {
    // No clear activity; treat as idle (e.g., blank screen or finished output).
    state = AgentState.IDLE;
  }

  return { state, normalized, signals };
}
