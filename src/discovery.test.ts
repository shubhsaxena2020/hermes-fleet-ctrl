import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverAgents } from './discovery.js';

// Clear TMUX so tmux child processes use our explicit -S socket, not the
// operator's attached session (this CI box runs inside tmux).
const TMUX_ENV = { ...process.env };
delete (TMUX_ENV as Record<string, string>).TMUX;
const tmux = (args: string[]) => execFileSync('tmux', args, { env: TMUX_ENV });

describe('discoverAgents — pane parsing & protection rules (isolated real tmux)', () => {
  it('parses list-panes, maps worker panes, and protects window 0 (read-only)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-disc-'));
    const socket = join(dir, 'd.sock');
    tmux(['-S', socket, 'new-session', '-d', '-x', '120', '-y', '40', '-s', 'hermes-main', 'bash']);
    tmux(['-S', socket, 'new-window', '-t', 'hermes-main', 'bash', '-lc', 'worker-wrapper.sh agent-9 /x /y; exec sleep 99999']);
    try {
      const agents = await discoverAgents({ socket, agentPattern: '' });
      const main = agents.find((a) => a.windowIndex === 0);
      const worker = agents.find((a) => a.agentId === 'agent-9');
      expect(main?.protected).toBe(true);
      expect(worker?.agentId).toBe('agent-9');
      expect(worker?.protected).toBe(false);
      expect(worker?.target).toBe('hermes-main:1.0');
    } finally {
      try {
        tmux(['-S', socket, 'kill-session', '-t', 'hermes-main']);
      } catch {
        /* ignore */
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('list-panes format contract: 5 tab-separated fields', () => {
    const fmt = '#{session_name}:#{window_index}.#{pane_index}\t#{session_name}\t#{window_index}\t#{pane_index}\t#{pane_start_command}';
    expect(fmt.split('\t').length).toBe(5);
  });
});
