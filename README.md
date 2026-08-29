# hermes-fleet-ctrl — Hermes Fleet Commander

A real-time **TUI + WebSocket/SSE control plane** for the fleet of **local
tmux-backed Hermes Agent sessions** on this VPS. It replaces the ad-hoc SSH scripts
and manual `tmux attach` inspection that were used to build/manage the dashboard,
and is the permanent tool for monitoring, dispatching goals to, and auto-recovering
the 7+ concurrent Hermes Agent sessions.

On this host the agents live as panes inside one tmux server:

```
socket: /home/ubuntu/.hermes/tmux/hermes-main.sock
session: hermes-main
  window 0      : the main hermes chat  (PROTECTED — never auto-touched)
  window 1.0–1.5: worker-wrapper.sh agent-1 … agent-6 (the fleet)
  window 2.0–2.2: scratch / reserve panes
```

## What it does

- **Discovers** the live fleet by parsing `tmux list-panes` (zero config).
- **Monitors** each pane: captures the screen, classifies state (Hermes-TUI aware),
  and journals an append-only snapshot + audit trail to SQLite (WAL).
- **Dispatches** goals to a worker pane via `tmux load-buffer -` + `paste-buffer`
  (never `send-keys` / Ctrl-C), verified by a receipt token.
- **Recovers** a wedged agent: the watchdog flags STUCK after inactivity and, when
  enabled, gently nudges the pane — but a **circuit breaker caps nudges to 3/hour/
  pane** so it never amplifies a failure into a nag loop. Each worker is already
  supervised by `worker-wrapper.sh` (`while true; hermes chat; done`), so the
  daemon's "recover" is a nudge, not a spawn/kill (which would fight the supervisor).

### Circuit breaker auto-close rule

When the per-pane restart budget (3 per rolling hour) is exhausted, the breaker
**opens** and the pane is declared unwatched (still captured/monitored, just never
re-nudged). It **auto-closes only when BOTH** hold: (1) the rolling restart window
has fully drained (no restart timestamps remain inside the window), **and** (2) a
fresh activity heartbeat has arrived since the trip, proving the pane is actually
alive. Until then the pane stays unwatched but is never re-nudged — so a wedged agent
cannot be hammer-looped and a silent pane is not falsely cleared. The open/closed
transition is written to the durable breaker-event journal and is reconstructable
after a process restart (replay the journal). A human can also clear it explicitly
(`r` in the TUI, or an operator reset).
- **Serves** a control plane: REST + WebSocket + SSE of live `FleetEvent`s, plus a
  blessed TUI dashboard.

## Architecture

```
┌────────────┐   capture   ┌─────────────────┐  classify  ┌──────────────┐
│ LocalTmux  │ ──────────► │ FleetControl    │ ─────────► │ ANSI parser  │
│ (tmux -S)  │            │ orchestrator    │            │ (Hermes-TUI) │
└────────────┘            │                 │            └──────────────┘
        ▲                  │ ticks: snapshot │                  │
        │ load-buffer/     │ + guardian eval │                  ▼
        │ paste-buffer     │                 │            ┌──────────────┐
   GoalInjector           │ emits FleetEvent│            │ EventJournal │
        ▲                  │                 │            │ (SQLite WAL) │
        │ enqueueGoal      │  TaskEngine     │            └──────────────┘
   TaskEngine  ───────────┘ (priority/lease) └──►  Guardian (STUCK + breaker)
        │
   discovery (list-panes → agents; window 0 protected)
```

| Layer | File | Responsibility |
|-------|------|----------------|
| Local tmux driver | `src/driver/local-tmux.ts` | `tmux -S <sock>` via `execFile` (no shell); capture / load-buffer / paste-buffer |
| Fleet discovery | `src/discovery.ts` | parse `list-panes`; map panes→agents; protect window 0 / listed panes |
| ANSI normalizer + state machine | `src/parser/ansi-parser.ts` | strip CSI/OSC; classify → `IDLE / ACTIVE_THINKING / RUNNING_COMMAND / WAITING_USER_INPUT / ERROR_PROMPT`; Hermes-TUI aware |
| Append-only journal | `src/storage/db.ts` | SQLite tables (sessions, tasks, snapshots, audit); WAL on-disk only |
| Priority task queue + lease allocator | `src/queue/task-engine.ts` | per-slot atomic leasing, dependency chains, timeouts |
| Safe goal injector | `src/driver/goal-injector.ts` | `load-buffer -` + `paste-buffer` (never `send-keys`/Ctrl-C), receipt-verified |
| Watchdog | `src/watchdog/guardian.ts` | STUCK detection + 3/hr/pane nudge cap + circuit breaker |
| Orchestrator | `src/server/fleet-control.ts` | wires all engines; `tick()` + `pump()` + typed `FleetEvent`s; protected-pane refusals |
| Control-plane API | `src/server/control-plane.ts` | Fastify REST + WebSocket `/stream` + SSE `/stream/sse` |
| Real-fleet assembly | `src/real-fleet.ts` | `bootRealFleet()` / `createRealControlPlane()` — the production path |
| Daemon entry | `src/cli.ts` | boots the real control plane against hermes-main; safety banner; signal handling |
| TUI | `src/tui/app.ts` | blessed dashboard; pure `renderLines()` model, headless-testable |
| SSH driver (legacy/remote) | `src/driver/tmux-pool.ts` | pool of resilient ssh2 connections for remote fleets |
| E2E demo | `src/demo.ts` | mock-tmux scenario, no real tmux |

## Safety contract (the daemon is the permanent tool — this is the deal)

- **Observation is read-only.** `tick()` only runs `capture-pane`. The daemon never
  sends keystrokes, never kills panes, never respawns processes.
- **Window 0 (main hermes) and any listed protected pane are NEVER auto-written.**
  They are monitored and classified, but the watchdog refuses to nudge them, and
  `POST /agents/:id/goal` for a protected pane returns `403`.
- **Dispatch is operator-initiated and safe.** A goal goes to a worker pane via
  load-buffer + paste-buffer, never raw keystrokes. Goals to protected panes are
  rejected outright.
- **Auto-recover is a nudge, off by default.** `FLEET_ALLOW_NUDGE=1` enables gentle
  STUCK nudges (paste-buffer only); the 3/hr circuit breaker stops nag-spam. The
  default is monitoring-only — the daemon records STUCK events and lets the existing
  `worker-wrapper.sh` supervisor or a human decide.
- **Nothing is mutated on disk except the journal** (strictly append-only).

## Deploy it (this VPS)

```bash
cd /home/ubuntu/projects/hermes-fleet-ctrl
pnpm install
pnpm run build          # emits dist/cli.js
pnpm run test           # 125 tests, 20 files
```

Run the daemon (monitoring-only by default; binds to localhost):

```bash
pnpm run daemon         # = build && node dist/cli.js
# or directly with env overrides:
FLEET_PORT=8787 FLEET_ALLOW_NUDGE=0 node dist/cli.js
```

As a persistent systemd **user** service (survives logout with `loginctl enable-linger`):

```bash
mkdir -p ~/.config/systemd/user
cp daemon/fleet-ctrl.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now fleet-ctrl
journalctl --user -u fleet-ctrl -f
```

### Env (all optional)

| Var | Default | Meaning |
|-----|---------|---------|
| `FLEET_SOCKET` | `/home/ubuntu/.hermes/tmux/hermes-main.sock` | tmux socket |
| `FLEET_PORT` | `8787` | HTTP/WS/SSE port |
| `FLEET_HOST` | `127.0.0.1` | bind host (local only) |
| `FLEET_JOURNAL` | `/home/ubuntu/.hermes/fleet-ctrl/journal.db` | SQLite path |
| `FLEET_POLL_MS` | `5000` | poll interval |
| `FLEET_STUCK_MS` | `600000` | idle ⇒ STUCK threshold (10 min) |
| `FLEET_ALLOW_NUDGE` | `0` | `1` to enable safe STUCK nudges |
| `FLEET_PROTECTED` | _(none)_ | extra comma-separated pane targets to protect |
| `FLEET_AGENT_PATTERN` | `hermes` | regex to detect hermes panes in `list-panes` |

**Circuit-breaker knobs** (validated by the config schema, T12 — see `src/config/schema.ts`):

| Field | Default | Meaning |
|-------|---------|---------|
| `stuckAfterMs` | `600000` (env `FLEET_STUCK_MS`) | idle ⇒ STUCK threshold (ms) |
| `maxRestartsPerWindow` | `3` | nudge budget per rolling window (breaker opens when exhausted) |
| `restartWindowMs` | `3600000` (1h) | rolling window for the restart budget; also the auto-close drain window |
| `pollIntervalMs` | `2000` | fleet poll loop interval (ms) |
| `slots` | `7` | goal-dispatch concurrency slots |

`restartWindowMs` doubles as the breaker **auto-close** drain window: the breaker only
re-closes once this window has fully drained AND a fresh heartbeat has arrived (see the
auto-close rule above). Invalid config fails fast at startup with the exact offending field.

## Control-plane API

- `GET /health` → `{ ok, agents, tasks }`
- `GET /agents` → `{ agents: AgentView[] }` (state, stuck, breakerOpen, restartsInWindow, protected)
- `GET /agents/:id` → single agent view
- `GET /tasks` → queued/leased tasks
- `POST /tasks` `{ agentId, prompt, priority? }` → enqueue a goal (priority lease queue)
- `POST /agents/:id/goal` `{ prompt }` → inject a goal now (403 if protected)
- `GET /journal/audit?limit=` → recent audit rows
- `WS /stream` → live `FleetEvent`s (snapshot / task / guardian / audit)
- `GET /stream/sse` → same events as Server-Sent Events
- `GET /api/fleet` → stable summary `{ ok, generatedAt, total, byStatus, agents[] }` (T7)
- `GET /api/agents/:id` → per-agent detail (state, breakerState, history depth) (T7)
- `GET /api/agents/:id/history?limit=` → bounded metrics-history samples (trendlines) (T6)
- `GET /api/events?limit=&agent=` → durable breaker open/close/auto-close events (T4/T5)
- `GET /api/event-log?limit=&agent=&type=` → structured operator audit log (T14)
- `GET /api/event-log/export.ndjson?limit=&agent=&type=` → sanitized NDJSON export (attachment) (T14)

A `curl` example to dispatch a goal to agent-3:

```bash
curl -s -X POST localhost:8787/agents/agent-3/goal \
  -H 'content-type: application/json' \
  -d '{"prompt":"Summarize the open PRs in rag-service and report blockers."}'
```

## Test invariants (125 tests, 20 files)

- `local-tmux`: real isolated tmux — capture, load-buffer+paste-buffer delivery,
  **shell-injection-safe** argv (no `execFile` shell), `-S` socket isolation.
- `discovery` (+ `.real` against the live hermes-main, read-only): pane parsing,
  worker mapping, **window 0 protected**, worker panes dispatchable.
- `ansi-parser`: 30-fixture classification (>95%), **Hermes-TUI awareness** (resting
  agent = IDLE, not ERROR_PROMPT; real traceback still flags), SGR/cursor stripping.
- `storage/db`: tables, WAL on-disk only.
- `task-engine`: priority + dependency gating, timeout reclaim, no double-assignment
  under 10-parallel / 7-slot leasing.
- `goal-injector`: exact byte transmission, load-buffer+paste-buffer only, token
  receipt, retry→`GoalInjectError`, `UNKNOWN_HOST`.
- `guardian`: STUCK after threshold, 3/hr cap then breaker, live-pane recovery,
  **breaker auto-close only after window drain + fresh heartbeat** (issue #1).
- `fleet-control`: **protected-pane refusals** (inject returns ok:false, enqueue
  throws), classified states, task→pump→inject, WS fan-out, STUCK→breaker path,
  **no duplicate `breaker_tripped` broadcast**.
- `control-plane`: real Fastify server incl. SSE, 403 for protected dispatch,
  `/api/fleet` + `/api/agents/:id/history` + `/api/events` + `/api/event-log` filters.
- `tui`: render model, input parse, dispatch, selection/breaker reset, mount guard,
  **grouped live/stale/breaker/protected sections + heartbeat-age suffix**.
- `demo`: full-stack scenario with mock tmux.
- `test/mock-fleet.integration`: deterministic mock-fleet harness covering normal
  operation, missed-heartbeat→breaker, auto-close, restart recovery, history replay.
- `test/smoke`: UI/API/event-feed count consistency + no-stale-entries-after-restart.
