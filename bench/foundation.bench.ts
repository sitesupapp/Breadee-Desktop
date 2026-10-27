// Final Foundation (PERF, Tracks 9/11) — local-store performance budget harness. $0, local only.
//
//   node --expose-gc --import ./test/register.mjs bench/foundation.bench.ts <label>
//
// Seeds the 90-day tenure + reconnect-backlog profile (bench/seedFoundation.ts) into fake-indexeddb and
// measures p50/p95/p99 of the hot local paths, then the drain throughput over the backlog. fake-indexeddb
// is SLOWER than WebView2 IndexedDB: treat the numbers as RELATIVE (before/after, regression-gated), the
// budgets as an upper bound. Results are appended (by label) to
// D:\BreadeeDev\Temp\claude\bench_foundation_results.json (override with BENCH_OUT).
// Not part of `npm test` (outside test/*.test.ts).

import "fake-indexeddb/auto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? (this.m.get(k) as string) : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  get length() { return this.m.size; }
}
(globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage();

const label = process.argv[2] ?? "run";
const OUT = process.env.BENCH_OUT ?? "D:\\BreadeeDev\\Temp\\claude\\bench_foundation_results.json";

const { localdb } = await import("@/lib/offline/db");
const seed = await import("./seedFoundation.ts");
const { T, B, U, DEV, TERM, SHIFT, SCOPE } = seed;

/** fake-indexeddb never frees finished transactions (FDBDatabase.js: transactions.push, no removal); a real
 *  IndexedDB does. Dropping the fake's FINISHED ones between iterations keeps GC pressure realistic (an
 *  environment fix only, the app is untouched; see the long-run test). */
function releaseFakeTransactions(): void {
  const raw = (localdb.backendDB() as { _rawDatabase?: { transactions?: { _state?: string }[] } } | null)?._rawDatabase;
  if (raw?.transactions) raw.transactions = raw.transactions.filter((t) => t._state !== "finished");
}

type Stat = { n: number; p50: number; p95: number; p99: number; max: number; budget_p95?: number; within_budget?: boolean; error?: string };
const results: Record<string, Stat> = {};

function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return Number(s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))].toFixed(2));
}

async function measure(name: string, fn: (i: number) => Promise<unknown> | unknown, opts: { iters?: number; budgetMs?: number; timeBudgetMs?: number; warmup?: number } = {}): Promise<void> {
  const iters = opts.iters ?? 200;
  const timeBudget = opts.timeBudgetMs ?? Number(process.env.BENCH_TIME_BUDGET_MS ?? 20_000);
  // The pre-fix code needs SECONDS per call on the 90-day profile: BENCH_MIN_ITERS / BENCH_WARMUP keep a
  // baseline run finite (the same settings are used for the after run, so the two stay comparable).
  const minIters = Number(process.env.BENCH_MIN_ITERS ?? 10);
  const warmup = opts.warmup ?? Number(process.env.BENCH_WARMUP ?? 3);
  const xs: number[] = [];
  // BENCH_DRAIN_ONLY=1 skips every timed scenario (a drain-throughput-only run).
  if (process.env.BENCH_DRAIN_ONLY === "1") return;
  console.log(`  > ${name} …`);
  try {
    for (let w = 0; w < warmup; w++) await fn(-1 - w);
    const t0 = performance.now();
    for (let i = 0; i < iters; i++) {
      releaseFakeTransactions();
      const s = performance.now();
      await fn(i);
      xs.push(performance.now() - s);
      if (xs.length >= minIters && performance.now() - t0 > timeBudget) break;
    }
    const st: Stat = { n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), p99: pct(xs, 99), max: Number(Math.max(...xs).toFixed(2)) };
    if (opts.budgetMs != null) {
      st.budget_p95 = opts.budgetMs;
      st.within_budget = st.p95 <= opts.budgetMs;
    }
    results[name] = st;
    console.log(`${name.padEnd(34)} n=${String(st.n).padStart(3)} p50=${st.p50} p95=${st.p95} p99=${st.p99}${opts.budgetMs != null ? ` (budget ${opts.budgetMs}: ${st.within_budget ? "OK" : "OVER"})` : ""}`);
  } catch (e) {
    results[name] = { n: xs.length, p50: NaN, p95: NaN, p99: NaN, max: NaN, error: e instanceof Error ? e.message : String(e) };
    console.log(`${name.padEnd(34)} ERROR ${results[name].error}`);
  }
}

const tSeed = performance.now();
// BENCH_SEED=steady seeds the bounded shape retention converges to (see seedFoundation `steady`).
// BENCH_TENURE=0: no tenure at all (only the backlog + floor + customers) — isolates the drain ENGINE cost
// from fake-indexeddb's O(N)-per-write index maintenance on a large store.
const info = await seed.seedFoundation({ steady: process.env.BENCH_SEED === "steady", tenure: process.env.BENCH_TENURE !== "0" });
const seedMs = performance.now() - tSeed;
console.log(`[${label}] seeded in ${(seedMs / 1000).toFixed(1)} s`, info.counts);

const OL = await import("@/lib/offline/operationLog");
const proj = await import("@/lib/offline/operationalProjection");
const hist = await import("@/lib/offline/ordersHistoryOffline");
const cc = await import("@/lib/offline/customerCache");
const sh = await import("@/lib/offline/syncHistory");
const qf = await import("@/lib/offline/queueForensics");
const scm = await import("@/components/sync/syncCenterModel");
const em = await import("@/lib/offline/entityMap");
const db = await import("@/lib/offline/db");
const { useCart } = await import("@/state/cart");

const FULL = { tenantId: T, branchId: B, cashierUserId: U, deviceId: DEV, terminalId: TERM };
const tables = info.tables as unknown as import("@/types/tables").TableSummary[];
const mapAt = info.now - 30_000;

// 1. Local cart operation (zustand, no I/O).
await measure("cart_add_modify_remove", () => {
  const c = useCart.getState();
  const key = c.addLine({ menuItemId: "m-1", name: "Pizza", basePrice: 12 });
  c.adjustQuantity(key, 1);
  c.removeLine(key);
}, { iters: 500, budgetMs: 100 });

// 2. Customer search (20k cached): name partial, partial phone, full e164.
const queries = ["rana", "7010012", "+96170112345", "haddad 1", "joelle"];
await measure("customer_search_offline", (i) => cc.searchCachedCustomers({ tenantId: T, branchId: B }, queries[Math.abs(i) % queries.length]), { budgetMs: 100 });

// 3. Floor projection (60 tables): unreflected work + the operational totals.
await measure("floor_projection", async () => {
  await proj.tablesWithUnreflectedWork(SCOPE, mapAt);
  await proj.getOperationalTableTotals(SCOPE, tables, undefined, mapAt);
}, { iters: 100, budgetMs: 250 });

// 4. Move/merge projection: one table's operational bill (the capture prechecks build on it).
await measure("table_bill_projection", (i) => proj.getOperationalTableBill(SCOPE, tables[Math.abs(i) % 40], undefined, undefined, mapAt), { iters: 100, budgetMs: 100 });

// 5. Orders history overlay (offline local read of the 5k shift / 8k day + the payment overlay; online
//    path with the server loader stubbed).
await measure("orders_history_shift_local", () => hist.readOrdersHistoryLocal({ kind: "shift", tenantId: T, branchId: B, shiftId: SHIFT }), { iters: 60, budgetMs: 250 });
await measure("orders_history_day_local", () => hist.readOrdersHistoryLocal({ kind: "day", tenantId: T, branchId: B, day: info.dayKey }), { iters: 60, budgetMs: 250 });
const shiftRows = ((await localdb.snapshots.get(`orders:shift:${SHIFT}`))?.data ?? []) as never[];
await measure("orders_history_shift_online", () => hist.loadOrdersHistoryOfflineAware({ kind: "shift", tenantId: T, branchId: B, shiftId: SHIFT }, { reachable: async () => true, loadShift: async () => shiftRows }), { iters: 60, budgetMs: 250 });

// 6. Operation-log queries (badges / claim).
await measure("oplog_summarize_badge", () => OL.summarizeOperations(FULL, { includeSynced: false }), { budgetMs: 100 });
await measure("oplog_summarize_with_synced", () => OL.summarizeOperations(FULL), { iters: 60, budgetMs: 100 });
await measure("oplog_claimable", () => OL.claimableOperations(FULL), { budgetMs: 100 });

// 7. Sync Center tick (summary + rows) and history page.
await measure("sync_center_tick", async () => {
  await scm.loadSyncSummary(T, B, { includeSynced: true });
  await qf.loadSyncCenterRows({ tenantId: T, branchId: B, currentBuild: "bench", currentShiftId: SHIFT });
}, { iters: 60, budgetMs: 100 });
await measure("sync_history_page", () => sh.listHistory(T, B, 100), { budgetMs: 100 });
await measure("history_summary", () => sh.historySummary(T, B), { iters: 60, budgetMs: 100 });

// 8. Misc hot reads.
await measure("resumable_txns", () => db.listResumablePosTxns(T, B, U), { budgetMs: 100 });
await measure("latest_receipt", () => db.readLatestReceiptSnapshot(T), { budgetMs: 100 });
await measure("local_aliases_of", (i) => proj.localAliasesOf(`CAN-${10000 + Math.abs(i) * 7}`), { budgetMs: 100 });
await measure("canonical_ids_50", (i) => em.canonicalIds(Array.from({ length: 50 }, (_, k) => `L-${10002 + Math.abs(i) * 50 + k * 8}`)), { budgetMs: 100 });

// 9. Dependency resolution: one pure gate pass over the backlog.
await measure("dependency_resolution_pass", async () => {
  const all = await localdb.operations.toArray();
  const byId = new Map(all.map((o) => [o.operation_id, o]));
  const resolved = new Set((await localdb.entityMap.toArray()).map((m) => m.local_entity_id));
  for (const id of info.backlogIds) em.evaluateDependencies(byId.get(id)!, byId, resolved);
}, { iters: 20, budgetMs: 250 });

// 10. Offline startup estimate: the local reads POS runs at boot.
await measure("offline_startup_local_reads", async () => {
  await Promise.all([
    OL.summarizeOperations(FULL, { includeSynced: false }),
    db.listResumablePosTxns(T, B, U),
    db.listDineDrafts(FULL),
    db.readCachedTableMap(T, B),
    db.listActivePendingShifts(T, U, B, DEV),
    db.readLatestReceiptSnapshot(T),
  ]);
  await proj.tablesWithUnreflectedWork(SCOPE, mapAt);
  await proj.getOperationalTableTotals(SCOPE, tables, undefined, mapAt);
  await hist.readOrdersHistoryLocal({ kind: "shift", tenantId: T, branchId: B, shiftId: SHIFT });
}, { iters: 20, budgetMs: 1500 });

// 11. Drain throughput over the reconnect backlog (fake server: 2 ms latency, 1 % transient faults).
const orch = await import("@/lib/offline/orchestrator");
orch.__resetDrainLockForTests();
orch.__setReplayTimeoutForTests(10_000);
let n = 0;
const lat = () => new Promise((res) => setTimeout(res, 2));
const fault = async () => {
  await lat();
  if (++n % 100 === 0) throw Object.assign(new Error("Service unavailable"), { status: 503 });
};
const deps = {
  hasSession: async () => true,
  refreshSession: async () => true,
  isTransport: (e: unknown) => e instanceof TypeError,
  openShift: async () => { await fault(); return { shiftId: "SHIFT-BACK-CANON", reused: false }; },
  submit: async () => { await fault(); return { order_id: `S-${n}`, order_number: `B${n}` }; },
  pay: async () => { await fault(); return {}; },
  openTable: async () => { await fault(); return { table_id: `TC-${n}`, pos_entity_version: 1 }; },
  submitRound: async () => { await fault(); return { order_id: `RO-${n}`, order_number: `R${n}`, batch_no: 1, appended: true, idempotent: false }; },
  orderItemMap: async () => [],
  payTable: async () => { await fault(); return { ok: true, amount: 48, idempotent: false }; },
  upsertCustomer: async () => { await fault(); return { customer_id: `CC-${n}`, address_id: `CA-${n}`, is_new: true }; },
  payout: async () => { await fault(); return { payout_id: `P-${n}`, idempotent: false }; },
};
const ctx = { ...FULL, online: true };
const before = await localdb.operations.where("status").anyOf(OL.UNSETTLED_STATUSES).count();
const tDrain = performance.now();
const passes: number[] = [];
let settled = 0;
// BENCH_SKIP_DRAIN=1: no drain / retention catch-up (on the raw 90-day tenure every op write costs
// fake-indexeddb an O(N) scan of each index — RecordStore.deleteByValue — so those phases are only run on
// the steady-state seed).
const SKIP_DRAIN = process.env.BENCH_SKIP_DRAIN === "1";
for (let pass = 0; pass < (SKIP_DRAIN ? 0 : 4); pass++) {
  releaseFakeTransactions();
  const s = performance.now();
  const rep = await orch.drainOffline(ctx, "bench", deps as never);
  passes.push(performance.now() - s);
  settled += rep.drained.length + rep.needsAttention.length;
  if (rep.drained.length === 0 && rep.needsAttention.length === 0) break;
}
const drainMs = performance.now() - tDrain;
const after = await localdb.operations.where("status").anyOf(OL.UNSETTLED_STATUSES).count();
const byStatus: Record<string, number> = {};
for (const id of info.backlogIds) {
  const o = await localdb.operations.get(id);
  const k = o ? o.status : "gone";
  byStatus[k] = (byStatus[k] ?? 0) + 1;
}
const drain = {
  backlog: info.backlogIds.length,
  unsettled_before: before,
  unsettled_after: after,
  settled_in_run: settled,
  total_ms: Math.round(drainMs),
  pass_ms: passes.map((x) => Math.round(x)),
  ops_per_s: Number((settled / (drainMs / 1000)).toFixed(1)),
  backlog_status: byStatus,
  budget: ">= 40 ops/s; backlog < 60 s",
  within_budget: settled / (drainMs / 1000) >= 40 && drainMs < 60_000,
};
console.log("drain", drain);

const storeCounts: Record<string, number> = {};
for (const t of localdb.tables) storeCounts[t.name] = await t.count();
console.log("store counts after drain", storeCounts);

// 12. STEADY STATE after retention catch-up: the drain ran one (throttled) retention pass; later passes
//     (every RETENTION_MIN_INTERVAL_MS in production) finish the 90-day backlog. Run them now, then
//     re-measure the tenure-sensitive scenarios on the bounded store. (On a build without retention.ts the
//     store is unchanged and this phase simply re-measures the same profile.)
const retention: Record<string, unknown>[] = [];
try {
  const R = await import("@/lib/offline/retention" as string);
  for (let i = 0; i < (SKIP_DRAIN ? 0 : 6); i++) {
    const rep = await (R as { runRetention: (o?: { now?: number }) => Promise<Record<string, number>> }).runRetention();
    retention.push(rep);
    if (!rep.operations && !rep.syncHistory && !rep.entityMap && !rep.posOfflineTxns && !rep.dineDrafts) break;
  }
} catch (e) {
  retention.push({ unavailable: e instanceof Error ? e.message : String(e) });
}
const storeCountsSteady: Record<string, number> = {};
for (const t of localdb.tables) storeCountsSteady[t.name] = await t.count();
console.log("retention passes", retention.length, "store counts (steady state)", storeCountsSteady);
await measure("steady:customer_search_offline", (i) => cc.searchCachedCustomers({ tenantId: T, branchId: B }, queries[Math.abs(i) % queries.length]), { budgetMs: 100 });
await measure("steady:floor_projection", async () => {
  await proj.tablesWithUnreflectedWork(SCOPE, mapAt);
  await proj.getOperationalTableTotals(SCOPE, tables, undefined, mapAt);
}, { iters: 100, budgetMs: 250 });
await measure("steady:table_bill_projection", (i) => proj.getOperationalTableBill(SCOPE, tables[Math.abs(i) % 40], undefined, undefined, mapAt), { iters: 100, budgetMs: 100 });
await measure("steady:orders_history_shift_local", () => hist.readOrdersHistoryLocal({ kind: "shift", tenantId: T, branchId: B, shiftId: SHIFT }), { iters: 60, budgetMs: 250 });
await measure("steady:orders_history_shift_online", () => hist.loadOrdersHistoryOfflineAware({ kind: "shift", tenantId: T, branchId: B, shiftId: SHIFT }, { reachable: async () => true, loadShift: async () => shiftRows }), { iters: 60, budgetMs: 250 });
await measure("steady:oplog_summarize_badge", () => OL.summarizeOperations(FULL, { includeSynced: false }), { budgetMs: 100 });
await measure("steady:oplog_claimable", () => OL.claimableOperations(FULL), { budgetMs: 100 });
await measure("steady:sync_center_tick", async () => {
  await scm.loadSyncSummary(T, B, { includeSynced: true });
  await qf.loadSyncCenterRows({ tenantId: T, branchId: B, currentBuild: "bench", currentShiftId: SHIFT });
}, { iters: 60, budgetMs: 100 });
await measure("steady:offline_startup_local_reads", async () => {
  await Promise.all([
    OL.summarizeOperations(FULL, { includeSynced: false }),
    db.listResumablePosTxns(T, B, U),
    db.listDineDrafts(FULL),
    db.readCachedTableMap(T, B),
    db.listActivePendingShifts(T, U, B, DEV),
    db.readLatestReceiptSnapshot(T),
  ]);
  await proj.tablesWithUnreflectedWork(SCOPE, mapAt);
  await proj.getOperationalTableTotals(SCOPE, tables, undefined, mapAt);
  await hist.readOrdersHistoryLocal({ kind: "shift", tenantId: T, branchId: B, shiftId: SHIFT });
}, { iters: 20, budgetMs: 1500 });
// A second drain on the steady store (nothing left to replay: the per-drain fixed cost).
if (!SKIP_DRAIN) {
  const s = performance.now();
  await orch.drainOffline(ctx, "bench-steady", deps as never);
  results["steady:drain_noop_pass"] = { n: 1, p50: Number((performance.now() - s).toFixed(2)), p95: NaN, p99: NaN, max: NaN };
  console.log("steady:drain_noop_pass", results["steady:drain_noop_pass"].p50, "ms");
}

if (typeof (globalThis as { gc?: () => void }).gc === "function") (globalThis as { gc: () => void }).gc();
const record = {
  label,
  at: new Date().toISOString(),
  node: process.version,
  seed_ms: Math.round(seedMs),
  seeded: info.counts,
  scenarios: results,
  drain,
  store_counts_after_drain: storeCounts,
  retention_passes: retention,
  store_counts_steady_state: storeCountsSteady,
  heap_used_mb: Number((process.memoryUsage().heapUsed / 1048576).toFixed(1)),
};
let all: Record<string, unknown> = {};
if (existsSync(OUT)) {
  try { all = JSON.parse(readFileSync(OUT, "utf8")); } catch { all = {}; }
}
all[label] = record;
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(all, null, 1));
console.log(`results → ${OUT} [${label}]`);
process.exit(0);
