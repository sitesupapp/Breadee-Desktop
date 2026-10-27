// Final Foundation (PERF) — a --cpu-prof target: seeds the profile (BENCH_SCALE, default 0.3), then runs
// the floor projection (warm, cached ops) N times and one retention pass, so the V8 CPU profile shows where
// the time goes. node --cpu-prof --cpu-prof-dir=D:\BreadeeDev\Build\cpuprof --import ./test/register.mjs bench/cpuprofTarget.ts
import "fake-indexeddb/auto";
import { performance } from "node:perf_hooks";
(globalThis as unknown as { localStorage: Storage }).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {}, key: () => null, length: 0 } as unknown as Storage;
const seed = await import("./seedFoundation.ts");
const proj = await import("@/lib/offline/operationalProjection");
const R = await import("@/lib/offline/retention");
const info = await seed.seedFoundation({ scale: Number(process.env.BENCH_SCALE ?? 0.3) });
const tables = info.tables as unknown as import("@/types/tables").TableSummary[];
const mapAt = info.now - 30_000;
const what = process.env.TARGET ?? "floor";
const t0 = performance.now();
if (what === "floor") {
  for (let i = 0; i < 20; i++) {
    await proj.tablesWithUnreflectedWork(seed.SCOPE, mapAt);
    await proj.getOperationalTableTotals(seed.SCOPE, tables, undefined, mapAt);
  }
} else {
  console.log(JSON.stringify(await R.runRetention()));
}
console.log(what, ((performance.now() - t0) / (what === "floor" ? 20 : 1)).toFixed(1), "ms per call");
process.exit(0);
