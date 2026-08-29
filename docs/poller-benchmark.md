# Poller benchmark — per-tick cost vs fleet size (BACKLOG D18)

**Method:** `bench/poller.bench.ts` drives `FleetControl.tick()` over N simulated
agents using an in-memory mock transport (no tmux, no real I/O). Each tick
captures+classifies every pane, evaluates the Guardian, and appends a metrics
sample + audit row. We record wall-clock per tick and report percentiles.

**Caveat:** this is the *compute* cost of one poll cycle on a single process. The
real daemon's per-agent latency is dominated by `capture-pane` over tmux/SSH
(the `captureRetries` backoff path in B10), which this in-memory harness does
not model. Treat these numbers as a **lower bound** on the poll-loop CPU cost
and a guide to how the in-process work scales.

## Measured (this VPS, Node 22, `:memory:` journal)

| agents | ticks | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | mean (ms) |
|-------:|------:|---------:|---------:|---------:|---------:|----------:|
| 10     | 300   | 3.3      | 8.2      | 11.2     | 11.7     | 3.9       |
| 50     | 300   | 15.5     | 51.6     | 73.3     | 85.4     | 21.5      |
| 200    | 200   | 69.1     | 138.7    | 167.4    | 177.7    | 76.7      |

## Interpretation

- The in-process tick cost is roughly **linear** in agent count (≈0.4 ms/agent
  mean at 200 agents), as expected — each tick is one capture+classify+guardian
  pass per pane plus a SQLite insert.
- At the realistic single-VPS scale (~10–20 agents) a tick is **sub-15 ms p99**,
  so `FLEET_POLL_MS=5000` leaves enormous headroom; the daemon is I/O-bound on
  tmux, not CPU-bound on this loop.
- Even at 200 agents the p99 tick (~167 ms) is well under a 5 s poll interval.
  The poll loop would only become a concern well into the thousands of agents on
  one process — at which point the multi-instance note (docs/multi-instance-coordination.md)
  becomes relevant.

## Run it yourself

```bash
pnpm run build
BENCH_AGENTS=200 BENCH_TICKS=200 node bench/poller.bench.ts
```

Numbers will vary with CPU and SQLite mode (`:memory:` here; the on-disk
`FLEET_JOURNAL` with WAL adds a small per-tick write cost that this harness does
not include).
