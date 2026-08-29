# hermes-fleet-ctrl — Next Backlog (autonomous work program)

Status: v0.3.1 shipped (130/130 tests green, PR #11 merged, env knobs FLEET_MAX_RESTARTS /
FLEET_RESTART_WINDOW_MS exposed). The repo has **no `.github/workflows/ci.yml`** — that is the
natural next item. Work via branch -> PR -> squash-merge -> tag -> release.

## Phase A — CI workflow (highest priority)
1. [ ] Create `.github/workflows/ci.yml` running on push/PR: setup-node matrix (Node 18/20/22),
   `pnpm install --frozen-lockfile`, `pnpm run typecheck`, `pnpm run lint`, `pnpm run test`,
   `pnpm run build`. **done when** workflow file exists and lints valid YAML.
2. [ ] Ensure CI has no credentials/secrets (matches the repo's no-secret posture). **done when**
   workflow contains no `secrets.` references.
3. [ ] Verify the workflow runs green on a throwaway PR (or `act` locally if available). **done when**
   a CI run is green.
4. [ ] Re-tag v0.3.2-ci once CI is green. **done when** tag pushed.

## Phase B — Coverage & hardening
5. [ ] Add tests for the newly-exposed `FLEET_MAX_RESTARTS` / `FLEET_RESTART_WINDOW_MS` knobs
   (config schema parse + breaker behavior). **done when** knob tests green.
6. [ ] Add a circuit-breaker auto-close rule test (referenced in T17 docs). **done when** test covers
   auto-close.
7. [ ] Add a metrics-history store persistence test (survives restart). **done when** test green.
8. [ ] Add an alert-rules-as-data schema-validation test beyond the happy path (invalid rule
   rejected). **done when** negative test green.
9. [ ] Increase TUI event-log export coverage (currently thin). **done when** export path tested.
10. [ ] Add a poller retry/backoff unit test with injected failures. **done when** backoff tested.

## Phase C — Observability & docs
11. [ ] Emit a Grafana/JSON dashboard for the fleet metrics (mirror rag-service pattern). **done when**
    dashboard JSON committed.
12. [ ] Document the full API surface + test surface in README (T17 referenced it). **done when** README
    lists endpoints.
13. [ ] Add an `examples/` dir with a minimal watchdog config + systemd unit. **done when** example present.
14. [ ] Add a CHANGELOG entry per release going forward. **done when** CHANGELOG maintained.

## Phase D — Stretch
15. [ ] Add a mock-fleet integration harness to CI as a non-blocking job. **done when** CI runs the
    harness.
16. [ ] Investigate multi-instance coordination (two daemons watching one fleet) and document
    behavior. **done when** research note exists.
17. [ ] Add an OpenAPI/schema file for the REST status API. **done when** schema committed.
18. [ ] Benchmark poller under N simulated agents and record p99. **done when** benchmark note exists.
