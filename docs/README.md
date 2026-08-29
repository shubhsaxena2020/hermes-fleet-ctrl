# Docs

- `openapi.json` — OpenAPI 3.0 schema for the control-plane REST + WS/SSE API (D17).
- `multi-instance-coordination.md` — research note on running >1 daemon against one
  fleet: behavior, split-brain risks, and a leader-election recommendation (D16).
- `poller-benchmark.md` — measured per-tick cost vs fleet size, with how to re-run
  the benchmark (D18). `../bench/poller.bench.ts` is the harness (run after build).
