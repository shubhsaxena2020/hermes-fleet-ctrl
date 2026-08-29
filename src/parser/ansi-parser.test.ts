import { describe, it, expect } from 'vitest';
import { AgentState, classifyPane, normalizeAnsi } from './ansi-parser.js';

/** A realistic, hand-crafted terminal snapshot with its expected agent state. */
interface Fixture {
  name: string;
  raw: string;
  expected: AgentState;
}

// A few escapes reused below to make snapshots realistic:
const C = (s: string) => `\x1b[32m${s}\x1b[0m`; // green
const CLR = '\x1b[2J\x1b[H'; // clear screen + home
const CUR = '\x1b[3;1H'; // cursor move

const FIXTURES: Fixture[] = [
  {
    name: 'idle-bare-shell',
    raw: 'user@host:~$ ',
    expected: AgentState.IDLE,
  },
  {
    name: 'idle-blessed-prompt',
    raw: '❯ ',
    expected: AgentState.IDLE,
  },
  {
    name: 'idle-blank-screen',
    raw: '                                          \n                                          ',
    expected: AgentState.IDLE,
  },
  {
    name: 'idle-after-command',
    raw: '$ cat notes.txt\nhello world\n$ ',
    expected: AgentState.IDLE,
  },
  {
    name: 'idle-finished-output-no-prompt',
    raw: '$ ls\nsrc  dist  node_modules\n',
    expected: AgentState.IDLE,
  },
  {
    name: 'thinking-claude-spinner',
    raw: '⠋ Thinking…',
    expected: AgentState.ACTIVE_THINKING,
  },
  {
    name: 'thinking-analyzing',
    raw: '● Analyzing the request and planning tool calls…',
    expected: AgentState.ACTIVE_THINKING,
  },
  {
    name: 'thinking-ascii-spinner',
    raw: '| Running analysis...',
    expected: AgentState.ACTIVE_THINKING,
  },
  {
    name: 'thinking-brain',
    raw: '🧠 reasoning about the plan and next steps',
    expected: AgentState.ACTIVE_THINKING,
  },
  {
    name: 'running-npm-test',
    raw: '⏵ Running: npm test',
    expected: AgentState.RUNNING_COMMAND,
  },
  {
    name: 'running-pytest-live',
    raw: 'collected 42 items\n\ntest_foo.py .. test_bar.py .',
    expected: AgentState.RUNNING_COMMAND,
  },
  {
    name: 'running-cargo-build',
    raw: '● Running command: cargo build --release',
    expected: AgentState.RUNNING_COMMAND,
  },
  {
    name: 'running-docker-compose',
    raw: '● Running: docker compose up -d',
    expected: AgentState.RUNNING_COMMAND,
  },
  {
    name: 'running-make',
    raw: '$ make all\ncc -c src/foo.c\ncc -c src/bar.c\n',
    expected: AgentState.RUNNING_COMMAND,
  },
  {
    name: 'wait-yes-no',
    raw: 'Do you want to proceed? (Y/n)',
    expected: AgentState.WAITING_USER_INPUT,
  },
  {
    name: 'wait-bracket-yes-no',
    raw: 'Overwrite file? [y/n] ',
    expected: AgentState.WAITING_USER_INPUT,
  },
  {
    name: 'wait-press-enter',
    raw: 'Build complete. Press Enter to continue',
    expected: AgentState.WAITING_USER_INPUT,
  },
  {
    name: 'wait-confirm-prompt',
    raw: 'Confirm changes? └─ ',
    expected: AgentState.WAITING_USER_INPUT,
  },
  {
    name: 'wait-continue',
    raw: 'Continue? ❯ ',
    expected: AgentState.WAITING_USER_INPUT,
  },
  {
    name: 'error-python-traceback',
    raw:
      'Traceback (most recent call last):\n  File "x.py", line 3, in <module>\nValueError: bad value',
    expected: AgentState.ERROR_PROMPT,
  },
  {
    name: 'error-enoent',
    raw: 'Error: ENOENT, no such file or directory\n❯ Proceed?',
    expected: AgentState.ERROR_PROMPT,
  },
  {
    name: 'error-npm-404',
    raw: 'npm error code E404\nnpm ERR! 404 Not Found - GET https://registry/npm/x',
    expected: AgentState.ERROR_PROMPT,
  },
  {
    name: 'error-build-failed',
    raw: '× Build failed\n  > 1 error',
    expected: AgentState.ERROR_PROMPT,
  },
  {
    name: 'error-command-not-found',
    raw: 'command not found: foobar',
    expected: AgentState.ERROR_PROMPT,
  },
  {
    name: 'error-not-git',
    raw: 'fatal: not a git repository (or any of the parent directories): .git',
    expected: AgentState.ERROR_PROMPT,
  },
  // --- ANSI-laden variants (prove normalizeAnsi doesn't change classification) ---
  {
    name: 'ansi-thinking-colored',
    raw: `${CLR}${CUR}${C('⠙ Reasoning about the diff…')}`,
    expected: AgentState.ACTIVE_THINKING,
  },
  {
    name: 'ansi-running-colored',
    raw: `${CLR}⏵ Running: ${C('pnpm run build')}\nwebpack compiling…`,
    expected: AgentState.RUNNING_COMMAND,
  },
  {
    name: 'ansi-error-colored',
    raw: `${CLR}${C('Error: connection refused')}\n  at Client.connect`,
    expected: AgentState.ERROR_PROMPT,
  },
  {
    name: 'ansi-wait-colored',
    raw: `Deploy now? ${C('(Y/n)')} `,
    expected: AgentState.WAITING_USER_INPUT,
  },
  {
    name: 'ansi-idle-colored',
    raw: `${CLR}${C('user@host:~$ ')}`,
    expected: AgentState.IDLE,
  },
];

describe('normalizeAnsi', () => {
  it('strips SGR color codes but keeps text', () => {
    expect(normalizeAnsi('\x1b[32mgreen\x1b[0m')).toBe('green');
  });
  it('strips clear-screen and cursor-move sequences', () => {
    expect(normalizeAnsi('\x1b[2J\x1b[H\x1b[3;1Hhi')).toBe('hi');
  });
  it('collapses carriage returns to newlines', () => {
    expect(normalizeAnsi('a\r\nb\r')).toBe('a\nb');
  });
  it('keeps printable spinner frames and unicode', () => {
    expect(normalizeAnsi('⠋ Thinking…')).toBe('⠋ Thinking…');
  });
});

describe('classifyPane — fixture classification accuracy', () => {
  it(`classifies ${FIXTURES.length} realistic snapshots with >95% accuracy`, () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(20);

    const mismatches: Array<{ name: string; expected: string; got: string }> = [];
    for (const f of FIXTURES) {
      const { state } = classifyPane(f.raw);
      if (state !== f.expected) {
        mismatches.push({ name: f.name, expected: f.expected, got: state });
      }
    }

    const accuracy = (FIXTURES.length - mismatches.length) / FIXTURES.length;
    if (mismatches.length > 0) {
      // surface details if the gate trips
      // eslint-disable-next-line no-console
      console.error('MISMATCHES:', JSON.stringify(mismatches, null, 2));
    }
    expect(accuracy, `classification accuracy ${accuracy} < 0.95`).toBeGreaterThanOrEqual(0.95);
  });

  it('reports every distinct state at least once across the fixture set', () => {
    const seen = new Set(FIXTURES.map((f) => classifyPane(f.raw).state));
    for (const st of Object.values(AgentState)) {
      expect(seen.has(st), `state ${st} not exercised by fixtures`).toBe(true);
    }
  });
});
