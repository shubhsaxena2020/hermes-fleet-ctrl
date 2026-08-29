# Research note — multi-instance coordination

**Status:** investigation only. No code change. This documents the behavior and
the gap if two `hermes-fleet-ctrl` daemons ever watch the same fleet.

## Why this matters

The daemon is currently designed as a **single permanent control plane** for one
VPS's `hermes-main` session (see `real-fleet.ts` + `daemon/fleet-ctrl.service`).
Two daemons would both poll the same tmux panes, both run the Guardian, and both
write to the same SQLite `journal.db`. That is uncharted territory today.

## What is shared / what is not

- **Shared state:** the metrics/breaker/audit SQLite file (`FLEET_JOURNAL`).
  Opened with `journal_mode = WAL` and `busy_timeout = 5000` (`storage/db.ts`),
  so concurrent *reads/writes* from two processes are serialized at the SQLite
  level — writes won't corrupt, but there is **no application-level coordination**.
- **Per-process state:** the Guardian in-memory breaker state (`guardian.ts`
  `Map<paneKey, PaneState>`), the task engine lease table, and the WS/SSE
  subscriber set. These are private to each process.

## Observed behavior if two run against one fleet (reasoned, not yet tested)

1. **Double nudges.** Both Guardians independently count restarts in their own
   memory. Each has its own `maxRestartsPerWindow` budget, so the *effective*
   nudge rate doubles (6/hr instead of 3/hr) before either trips — they do not
   share the rolling window.
2. **Split-brain breaker.** Daemon A may trip its breaker while Daemon B still
   sees the pane as OK (it never received A's `open` transition in memory). B
   keeps monitoring/nudging a pane A considers unwatchable.
3. **Durable state is the only tie-breaker.** `reconstructBreakerState()` rebuilds
   breaker open/closed *from the event log*, so both daemons would eventually
   *read* the same `open` record — but only after one of them wrote it, and only
   for display/alerting, not for live gating (live gating uses in-memory state).
4. **Task engine is not externally visible.** `POST /tasks` on daemon A is unseen
   by B; goal dispatch is not de-duplicated across instances.

## Recommendation

- **Keep it single-instance** (current design). The systemd unit is a user
  service; running two is an operator error, not a supported topology.
- If HA ever becomes a requirement, the minimal honest path is a **leader
  election** gate (e.g. a `lease` row in the shared SQLite with a heartbeat TTL)
  so only the leader runs `tick()`/Guardian; followers stay read-only (they can
  still serve `/api/*` GETs and the WS/SSE feed). That avoids split-brain without
  a second datastore.
- **Do not** just scale the process count — the in-memory Guardian + task engine
  would diverge as described above.

## Test gap

There is no multi-instance integration test yet (the mock-fleet harness and
`real-daemon` test both assume one daemon). Adding one would require either a
shared-SQLite fixture with two `FleetControl` instances, or an injected
coordination interface on `Guardian` — both are future work, not part of this
backlog item.
