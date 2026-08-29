# Changelog

All notable changes to hermes-fleet-ctrl are documented here. Releases are
tagged `vX.Y.Z` on GitHub; each release has a matching GitHub Release.

## [v0.3.4] — 2026-08-29

Phase C of BACKLOG.md: observability & docs.

- **C11** (Grafana): `deploy/grafana/dashboards/fleet-ctrl.json` — dashboard
  mirroring the rag-service style, wired to the daemon's REST/JSON path via the
  Infinity datasource (no Prometheus exporter exists yet). Covers fleet summary,
  agents-by-status, heartbeat age, restart-count budget, queue depth, poll
  latency, and durable breaker events. `deploy/grafana/README.md` documents the
  one required plugin + import steps.
- **C12** (README): test-surface section updated to 151 tests / 25 files, mapping
  the new Phase B test files.
- **C13** (examples): `examples/` with a minimal watchdog env file (incl.
  `FLEET_MAX_RESTARTS` / `FLEET_RESTART_WINDOW_MS`), a systemd user unit using
  `EnvironmentFile`, and a copy-paste README.

The dashboard JSON is JSON-validated and its selectors match the daemon's real
response shapes; it is not rendered in a live Grafana within CI.

## [v0.3.3] — 2026-08-29

Phase B of BACKLOG.md: coverage & hardening (130 → 151 tests).

- **B5/B6** (guardian-knobs): prove the restart-budget knobs
  (`FLEET_MAX_RESTARTS` / `FLEET_RESTART_WINDOW_MS`) actually change Guardian
  behavior — custom budget exhausts earlier/later than the default 3, and
  auto-close honors a custom short window. End-to-end breach driven through
  `FleetControl.tick()` at a configured budget with a durable `open` event.
- **B7** (metrics-persistence): metrics + breaker/audit events survive a
  close/reopen cycle on a real on-disk SQLite file (WAL durability).
- **B8** (alert rules): new `validateAlertRules()` pure validator; covers happy
  path + negatives (non-array, missing fields, unknown severity, null element).
- **B9** (event-log export): NDJSON export empty / limit / filtered /
  sanitized (no internal fields leaked).
- **B10** (poller retry): `capturePane` retry/backoff with injected transient
  failures — escalating backoff (+ jitter), exhaust-then-throw.

CI (Phase A) gates every push/PR on Node 20/22.

## [v0.3.2-ci] — 2026-08-29

Phase A of BACKLOG.md: CI, plus a latent defect it exposed.

- **CI**: Added `.github/workflows/ci.yml` running `typecheck`, `lint`,
  `test`, `build` on a Node 20/22 matrix on push + PR.
  - No secrets / credentials (`permissions: contents: read`) — repo's
    no-secret posture preserved.
  - Installs `tmux` in-job (the real-daemon / discovery.real / local-tmux
    integration tests drive a real tmux server on an isolated socket).
  - Node 18 excluded (package.json pins `engines.node >= 20`; native module
    prebuilds are 20+ only).
- **Fix**: `src/cli.ts` no longer runs `main()` on import. Previously
  importing `./cli.js` (e.g. from `cli.test.ts`) spawned the control-plane
  daemon inside the test process and called `process.exit(1)` when no socket
  was present. Guarded with the `import.meta.url` entry-point check. This
  latent bug only surfaced because CI's `ubuntu-latest` has no tmux/socket —
  exactly the kind of gap CI is for.
- Tests: 130 passed.

## [v0.3.1] — 2026-08-29

- Exposed circuit-breaker restart budget as env knobs:
  - `FLEET_MAX_RESTARTS` → `maxRestartsPerWindow` (default 3)
  - `FLEET_RESTART_WINDOW_MS` → `restartWindowMs` (default 3600000 = 1h)
- Extracted pure `resolveFleetConfig(env)` for testability.
- Startup banner prints the effective restart budget.
- Tests: 130 passed (+5 in `src/cli.test.ts`).

## [v0.3.0] — 2026-08-29

12-hour hardening complete (roadmap tasks T4–T18): circuit-breaker event
record + idempotent heartbeat reopen, metrics history store, defined REST
status API, UI legibility polish, structured event-log view/export,
config schema validation, poller retry/backoff, session-ID resilience,
mock-fleet integration harness + smoke pass, breaker auto-close rule.
