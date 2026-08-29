/**
 * hermes-fleet-ctrl/bench/poller.bench.ts — drive FleetControl.tick() over N
 * simulated agents (in-memory mock transport, no tmux) and record per-tick
 * wall-clock duration. Prints p50/p95/p99 so we have a real baseline for
 * poll-loop cost as the fleet grows.
 *
 * Run (after `pnpm run build`): node bench/poller.bench.mjs
 * Not part of `pnpm run test` (it is a bench, not a unit test). Imports from the
 * compiled `dist/` so it runs under plain Node.
 */
import { EventJournal } from '../dist/storage/db.js';
import { FleetControl } from '../dist/server/fleet-control.js';
import type { TmuxTransport, ExecResult } from '../dist/driver/types.js';

class MockTmuxTransport implements TmuxTransport {
  private screens = new Map<string, string>();
  setScreen(host: string, pane: string, text: string): void {
    this.screens.set(`${host}|${pane}`, text);
  }
  private get(host: string, target: string): string {
    return this.screens.get(`${host}|${target}`) ?? '';
  }
  exec(): Promise<ExecResult> {
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  }
  execWithStdin(): Promise<ExecResult> {
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  }
  capturePane(host: string, target: string): Promise<string> {
    return Promise.resolve(this.get(host, target));
  }
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx]!;
}

async function main(): Promise<void> {
  const AGENTS = Number(process.env.BENCH_AGENTS ?? 200);
  const TICKS = Number(process.env.BENCH_TICKS ?? 200);

  const agents: Record<string, { host: string; pane: string }> = {};
  const transport = new MockTmuxTransport();
  for (let i = 0; i < AGENTS; i++) {
    const id = `agent-${i}`;
    agents[id] = { host: id, pane: '0.0' };
    // A non-IDLE screen so the Guardian treats each pane as "alive" (no STUCK churn).
    transport.setScreen(id, '0.0', `⏵ working on task ${i}`);
  }
  const journal = new EventJournal();
  const fleet = new FleetControl(transport, journal, agents, { stuckAfterMs: 1000, slots: 7, now: () => Date.now() });

  const durations: number[] = [];
  for (let t = 0; t < TICKS; t++) {
    const start = performance.now();
    await fleet.tick();
    durations.push(performance.now() - start);
  }
  durations.sort((a, b) => a - b);

  const mean = durations.reduce((s, d) => s + d, 0) / durations.length;
  console.log(`agents=${AGENTS} ticks=${TICKS}`);
  console.log(`tick ms — p50=${quantile(durations, 0.5).toFixed(2)} p95=${quantile(durations, 0.95).toFixed(2)} p99=${quantile(durations, 0.99).toFixed(2)} max=${durations[durations.length - 1]!.toFixed(2)} mean=${mean.toFixed(2)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
