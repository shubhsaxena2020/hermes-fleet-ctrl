/**
 * Hermes goal injector — safely write high-level instructions into target tmux
 * panes without ever simulating raw keystrokes or sending Ctrl-C.
 *
 * Safety model
 * ------------
 * We never pipe the prompt through `send-keys` token-by-token (which mangles
 * special characters and can trigger shell history expansion). Instead we use
 * the tmux buffer pipeline:
 *
 *   1. `tmux load-buffer -`          — stream the exact prompt bytes into a tmux
 *                                      buffer via stdin (no shell interpretation).
 *   2. `tmux paste-buffer -t <pane>` — paste those exact bytes into the pane as
 *                                      if typed, then a trailing newline submits it.
 *
 * A unique "receipt token" is embedded in the injected text; after pasting we
 * `capture-pane` and confirm the token (and the prompt body) actually appears on
 * screen, so we know the agent received the goal. If verification fails we retry
 * up to `maxAttempts` and then surface a typed error.
 *
 * The pane is never interrupted: no `C-c`, no `send-keys C-c`, no killing. If the
 * pane is busy we simply report it could not be injected (caller decides).
 */

import type { TmuxTransport } from './types.js';

export interface DispatchOptions {
  /** tmux target pane, e.g. "agent-0:0.0" or "%3". Defaults to the agent's active pane. */
  target?: string;
  /** Per-attempt receipt-verification wait (ms). */
  verifyDelayMs?: number;
  /** Max injection attempts before giving up. */
  maxAttempts?: number;
  /** When true, do NOT append the trailing newline that submits the command. */
  noSubmit?: boolean;
  /** Override the receipt-token prefix (advanced). */
  tokenPrefix?: string;
}

export interface DispatchResult {
  ok: boolean;
  target: string;
  /** The exact bytes that were pasted (prompt + token + newline). */
  transmitted: string;
  attempts: number;
  error?: string;
}

export class GoalInjectError extends Error {
  constructor(
    message: string,
    readonly code: 'UNKNOWN_HOST' | 'VERIFY_FAILED' | 'TRANSPORT_ERROR',
  ) {
    super(message);
    this.name = 'GoalInjectError';
  }
}

const DEFAULT_TOKEN_PREFIX = '\x01HERMES-GOAL:';

function makeToken(prefix: string): string {
  // A short, shell-safe, unique-enough token to locate the paste on screen.
  const rnd = Math.random().toString(36).slice(2, 10);
  const ts = Date.now().toString(36);
  return `${prefix}${ts}-${rnd}\x02`;
}

export class GoalInjector {
  private readonly transport: TmuxTransport;
  private readonly tokenPrefix: string;

  constructor(transport: TmuxTransport, opts: { tokenPrefix?: string } = {}) {
    this.transport = transport;
    this.tokenPrefix = opts.tokenPrefix ?? DEFAULT_TOKEN_PREFIX;
  }

  /**
   * Inject `prompt` into the agent's pane and verify receipt.
   *
   * `agentId` is the host id known to the transport; `target` selects the pane
   * (defaults to the agent's active pane).
   */
  async dispatchGoal(
    agentId: string,
    prompt: string,
    options: DispatchOptions = {},
  ): Promise<DispatchResult> {
    const target = options.target ?? agentId;
    const verifyDelayMs = options.verifyDelayMs ?? 50;
    const maxAttempts = options.maxAttempts ?? 3;
    const token = makeToken(this.tokenPrefix);

    // Build the exact payload. Embed the token on its own line so we can find it
    // in the captured pane even if the prompt wraps. We preserve the caller's
    // prompt verbatim (no transformation) and add the token + optional newline.
    const body = prompt.endsWith('\n') ? prompt.slice(0, -1) : prompt;
    const submit = options.noSubmit ? '' : '\n';
    const transmitted = `${body}\n${token}${submit}`;

    let lastErr: string | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.transport.execWithStdin(agentId, 'tmux load-buffer -', transmitted);
        await this.transport.exec(agentId, `tmux paste-buffer -t ${target}`);

        if (verifyDelayMs > 0) await new Promise((r) => setTimeout(r, verifyDelayMs));
        const screen = await this.transport.capturePane(agentId, target, { start: -50, end: -1 });
        const received = screen.includes(token) && screen.includes(body);
        if (received) {
          return { ok: true, target, transmitted, attempts: attempt };
        }
        lastErr = 'receipt token not found on pane after paste';
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
        if (lastErr.includes('unknown host')) {
          throw new GoalInjectError(lastErr, 'UNKNOWN_HOST');
        }
      }
    }
    throw new GoalInjectError(
      `goal injection failed after ${maxAttempts} attempts: ${lastErr}`,
      'VERIFY_FAILED',
    );
  }
}
