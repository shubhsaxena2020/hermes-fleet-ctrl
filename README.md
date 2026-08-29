# hermes-fleet-ctrl

A TUI control plane for a fleet of remote, **tmux-backed agent sessions over SSH**.

It owns a pool of SSH hosts, drives their tmux sessions, classifies each agent's
live terminal state, journals everything to an append-only SQLite store, schedules
goals through a priority lease queue, safely injects instructions into panes, and
runs a watchdog that auto-restarts wedged agents — but a **circuit breaker caps
restarts to 3/hour/pane** so it never amplifies a failure into a restart loop.

## Architecture

```
┌────────────┐   capture   ┌─────────────────┐  classify  ┌──────────────┐
│ TmuxPool   │ ──────────► │ FleetControl    │ ─────────► │ ANSI parser  │
│ (ssh2)     │            │ orchestrator    │            │ (state)     │
└────────────┘            │                 │            └──────────────┘
        ▲                  │ ticks: snapshot │                  │
        │ load-buffer/     │ + guardian eval │                  ▼
        │ paste-buffer     │                 │            ┌──────────────┐
   GoalInjector           │ emits FleetEvent│            │ EventJournal │
        ▲                  │                 │            │ (SQLite WAL) │
        │ enqueueGoal      │  TaskEngine     │            └──────────────┘
   TaskEngine  ───────────┘ (priority/lease) └──►  Guardian (STUCK + breaker)
```

| Layer | File | Responsibility |
|-------|------|----------------|
| SSH + tmux driver | `src/driver/tmux-pool.ts` | pool of resilient ssh2 connections, tmux capture/parse, backoff reconnect |
| ANSI normalizer + state machine | `src/parser/ansi-parser.ts` | strip CSI/OSC, classify pane → `IDLE / ACTIVE_THINKING / RUNNING_COMMAND / WAITING_USER_INPUT / ERROR_PROMPT` |
| Append-only journal | `src/storage/db.ts` | 5 SQLite tables (sessions, tasks, snapshots, heartbeats, audit), WAL on-disk |
| Priority task queue + lease allocator | `src/queue/task-engine.ts` | per-slot atomic leasing, dependency chains, timeouts, FIFO-tie priority |
| Safe goal injector | `src/driver/goal-injector.ts` | writes goals via `tmux load-buffer -` + `paste-buffer` (never `send-keys`/Ctrl-C), verifies receipt |
| Watchdog | `src/watchdog/guardian.ts` | STUCK detection + 3/hr/pane restart cap + circuit breaker |
| Orchestrator | `src/server/fleet-control.ts` | wires all of the above; `tick()` + `pump()` + typed `FleetEvent`s |
| Control-plane API | `src/server/control-plane.ts` | Fastify REST + WebSocket `/stream` of live events |
| TUI | `src/tui/app.ts` | blessed dashboard; pure `renderLines()` model, headless-testable |
| CLI assembly | `src/index.ts` | `bootFleet()` + `start()` (TUI when TTY, else server) |
| E2E demo | `src/demo.ts` | mock-tmux scenario, no real SSH |

## Safety properties

- **Goals are injected, never keystroked.** `GoalInjector` uses `tmux
  load-buffer -` (stdin) → `tmux paste-buffer -t <pane>`. No `send-keys`, no
  Ctrl-C, no synthetic Enter. Receipt is verified by polling `capture-pane` for
  an embedded unique token; it retries then fails loudly (`GoalInjectError`).
- **Restart loops are bounded.** The Guardian trips a permanent circuit breaker
  after 3 restarts in any rolling hour per pane. A live pane (real new output)
  recovers the breaker; an operator can also reset it via the TUI (`r`) or
  `fleet.guardian.resetBreaker(id)`.
- **Nothing is mutated on disk except the journal.** The journal is strictly
  append-only; snapshots are immutable history.

## Run it

```bash
pnpm install
pnpm run build        # tsc -p tsconfig.json
pnpm run lint         # eslint (type-aware)
pnpm run test         # vitest (60 tests, 10 files)
pnpm run typecheck    # tsc --noEmit
```

Programmatic:

```ts
import { bootFleet, start } from './src/index.js';

const { fleet, close } = await start(
  {
    agents: [{ agentId: 'agent-1', host: 'agent-1', pane: '0.0' }],
    hosts: [{ id: 'agent-1', host: '10.0.0.5', username: 'ubuntu', privateKey: '...' }],
    stuckAfterMs: 10 * 60 * 1000, // 10 min idle => STUCK
  },
  { mode: 'server', port: 8787 }, // omit mode: attached TTY => blessed TUI
);
```

- `mode: 'server'` (default when not a TTY) exposes:
  - `GET /health`, `GET /agents`, `GET /agents/:id`
  - `GET /tasks`, `POST /tasks` (enqueue a goal), `POST /agents/:id/goal` (inject now)
  - `GET /journal/audit`, `WS /stream` (live `FleetEvent`s)
- `mode: 'tui'` (auto when `stdout.isTTY`) shows the live dashboard; type
  `agentId: <goal>` + Enter to dispatch, ↑/↓ to select, `r` to reset a breaker.

Headless smoke test (no SSH): `pnpm exec vitest run src/demo.test.ts`.

## Test invariants

- `tmux-pool`: connection lifecycle, backoff reconnect, tmux parsing, capture.
- `ansi-parser`: 30-fixture classification (>95% accurate), SGR/cursor stripping.
- `storage/db`: all 5 tables, WAL on-disk only, >1000 appends/sec.
- `task-engine`: priority + dependency gating, timeout reclaim, **no double-assignment
  under 10-parallel / 7-slot leasing**, slot-cap refusal, journal integration.
- `goal-injector`: exact byte transmission (mock tmux daemon), load-buffer+paste-buffer
  only (no send-keys/C-c), token receipt, retry→`GoalInjectError`, `UNKNOWN_HOST`.
- `guardian`: STUCK after threshold, restart+activity refresh, **3/hr cap then breaker**,
  window roll, live-pane recovery.
- `control-plane`: real Fastify server — classified states, task→pump→inject, immediate
  inject, audit, WS fan-out, STUCK→breaker path.
- `tui`: render model, input parse, dispatch, selection/breaker reset, mount guard.
- `demo`: full-stack scenario with mock tmux.
