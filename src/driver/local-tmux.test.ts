import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createLocalTmux, localRun } from './local-tmux.js';

// Clear TMUX so tmux child processes use our explicit -S socket, not the
// operator's attached session (this box runs inside tmux).
const TMUX_ENV = { ...process.env };
delete (TMUX_ENV as Record<string, string>).TMUX;
const tmux = (args: string[]) => execFileSync('tmux', args, { env: TMUX_ENV });

// Real, isolated tmux test: spins up a throwaway socket + session (never the
// hermes-main server) to prove the local transport's capture/load-buffer/
// paste-buffer path is correct and shell-injection-safe.
describe('LocalTmuxTransport (isolated real tmux)', () => {
  let socket: string;
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-tmux-'));
    socket = join(dir, 'test.sock');
    // Explicit size so capture-pane has a non-zero pane on a headless box.
    tmux(['-S', socket, 'new-session', '-d', '-x', '120', '-y', '40', '-s', 't', 'bash']);
    tmux(['-S', socket, 'send-keys', '-t', 't', 'echo hi', 'Enter']);
  });

  afterAll(() => {
    try {
      tmux(['-S', socket, 'kill-session', '-t', 't']);
    } catch {
      /* ignore */
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('capturePane returns the pane screen', async () => {
    const tmux = createLocalTmux({ socket });
    const out = await tmux.capturePane('x', 't');
    expect(out).toContain('hi');
  });

  it('load-buffer + paste-buffer delivers exact bytes without send-keys', async () => {
    const tmux = createLocalTmux({ socket });
    const prompt = 'HERMES: do the thing $0.50 & "quotes" ok';
    const r = await tmux.execWithStdin('x', 'tmux load-buffer -', prompt + '\n');
    expect(r.code).toBe(0);
    await tmux.exec('x', 'tmux paste-buffer -t t');
    const screen = await tmux.capturePane('x', 't');
    expect(screen).toContain(prompt);
  });

  it('execFile usage means a malicious pane target is not interpreted by a shell', async () => {
    const r = await localRun({ socket }, ['display-message', '-p', '#{session_name}']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('t');
    // A semicolon/space in an argv token is passed verbatim, not executed.
    const r2 = await localRun({ socket }, ['display-message', '-p', 'a; rm -rf /']);
    expect(r2.code).toBe(0);
    expect(r2.stdout.trim()).toBe('a; rm -rf /');
  });
});
