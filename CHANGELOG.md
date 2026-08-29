# Changelog

All notable changes to hermes-fleet-ctrl are documented here. Releases are
tagged `vX.Y.Z` on GitHub; each release has a matching GitHub Release.

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
