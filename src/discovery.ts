/**
 * Agent discovery for the local tmux fleet.
 *
 * Parses `tmux list-panes -a` on the hermes-main socket and maps panes to agent
 * IDs. A pane is "a hermes agent" when its start command contains the `hermes`
 * binary (the worker-wrapper.sh workers, or the main hermes chat in window 0).
 *
 * Safety: discovery is strictly read-only. It also tags which panes are
 * PROTECTED (the main session — window 0 — and anything the caller marks) so the
 * daemon never dispatches a goal or a nudge into a pane it shouldn't touch.
 */

import { localRun } from './driver/local-tmux.js';
import type { LocalTmuxOptions } from './driver/local-tmux.js';

export interface DiscoveredAgent {
  agentId: string;
  /** tmux pane target, e.g. 'hermes-main:1.3' */
  target: string;
  /** tmux session name, e.g. 'hermes-main' */
  session: string;
  windowIndex: number;
  paneIndex: number;
  /** Raw start command of the pane (for debugging / labelling). */
  startCommand: string;
  /** True for panes that must never be auto-nudged or dispatched into. */
  protected: boolean;
}

export interface DiscoverOptions extends LocalTmuxOptions {
  /** Pane targets (e.g. 'hermes-main:0.0') that are always protected. */
  protectedPanes?: string[];
  /**
   * Regex (as string) matched against the pane start command to decide if it is
   * a hermes agent. Defaults to detecting the `hermes` binary. Set to '' to keep
   * all discovered panes (useful for monitoring scratch/reserve panes too).
   */
  agentPattern?: string;
}

const LIST_FMT = '#{session_name}:#{window_index}.#{pane_index}\t#{session_name}\t#{window_index}\t#{pane_index}\t#{pane_start_command}';

function isHermesPane(startCommand: string, pattern: string): boolean {
  if (pattern === '') return true;
  try {
    return new RegExp(pattern).test(startCommand);
  } catch {
    return /hermes/.test(startCommand);
  }
}

function deriveAgentId(startCommand: string, session: string, windowIndex: number, paneIndex: number): string {
  // worker-wrapper.sh '<name>' ...  -> use the name
  const wm = startCommand.match(/worker-wrapper\.sh\s+'?([^'\s]+)'?/);
  if (wm) return wm[1]!;
  // main hermes chat -> 'main'
  if (/hermes\s+chat/.test(startCommand) || /hermes/.test(startCommand)) {
    return `${session}-w${windowIndex}.${paneIndex}`;
  }
  return `${session}-${windowIndex}.${paneIndex}`;
}

export async function discoverAgents(opts: DiscoverOptions): Promise<DiscoveredAgent[]> {
  const res = await localRun(opts, ['list-panes', '-a', '-F', LIST_FMT]);
  if (res.code !== 0) return [];
  const pattern = opts.agentPattern ?? 'hermes';
  const protectedSet = new Set(opts.protectedPanes ?? []);
  const out: DiscoveredAgent[] = [];
  for (const raw of res.stdout.split('\n')) {
    if (!raw.trim()) continue;
    const [target, session, wi, pi, ...rest] = raw.split('\t');
    const startCommand = rest.join('\t');
    if (!isHermesPane(startCommand, pattern)) continue;
    const windowIndex = Number.parseInt(wi ?? '0', 10) || 0;
    const paneIndex = Number.parseInt(pi ?? '0', 10) || 0;
    const agentId = deriveAgentId(startCommand, session ?? 'hermes-main', windowIndex, paneIndex);
    const isProtected = protectedSet.has(target ?? '') || windowIndex === 0;
    out.push({
      agentId,
      target: target ?? `${session}:${windowIndex}.${paneIndex}`,
      session: session ?? 'hermes-main',
      windowIndex,
      paneIndex,
      startCommand,
      protected: isProtected,
    });
  }
  return out;
}
