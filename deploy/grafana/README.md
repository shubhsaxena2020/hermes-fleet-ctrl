# Hermes Fleet Commander — Grafana

A Grafana dashboard (`dashboards/fleet-ctrl.json`) for the fleet control-plane
daemon, mirroring the rag-service dashboard style (uid/title/tags, schemaVersion
39, templated panels).

## Why the Infinity datasource (not Prometheus)

The daemon exposes **REST/JSON** (`GET /api/fleet`, `GET /api/agents/:id/history`,
`GET /api/events`) — there is no Prometheus exporter yet (tracked as a future
item). So instead of PromQL panels, this dashboard reads the JSON over HTTP via
the **[Infinity datasource](https://grafana.com/grafana/plugins/grafana-infinity-datasource/)**
plugin — the standard "Grafana reads JSON from a URL" plugin. No extra backend
or bridge process is required.

## Setup

1. Install the Infinity plugin in Grafana:
   ```
   grafana-cli plugins install grafana-infinity-datasource
   ```
2. Add a datasource of type **Infinity** (uid `fleet-infinity` to match the
   template variable, or edit `DS_INFINITY` in the JSON). Point its HTTP
   transport at the daemon, e.g. `http://localhost:8787`. If the daemon is on a
   different host, update the `url` fields in the dashboard JSON (currently
   `http://localhost:8787/...`).
3. Import `dashboards/fleet-ctrl.json` (Dashboard → New → Import → Upload).

## Panels

- **Fleet summary** — total agent count (`/api/fleet.total`).
- **Agents by status** — ok / stuck / breakerOpen / protected (`/api/fleet.byStatus`).
- **Heartbeat age (ms)** — staleness trend per agent (`/api/agents/:id/history`).
- **Restart count in window** — circuit-breaker budget burn-down (thresholded at
  2/3, matching the default `maxRestartsPerWindow`).
- **Task queue depth** and **Poll latency (ms)** — throughput/health signals.
- **Breaker events** — durable open / auto-close log (`/api/events`).

The `agent` template variable is populated from `/api/fleet.agents[].agentId`
and drives the per-agent history panels.

## Note on fidelity

The dashboard JSON is validated as well-formed and its field selectors match the
daemon's actual response shapes (verified against `src/server/control-plane.ts`).
It was not rendered against a live Grafana instance in CI; verify visually after
import.
