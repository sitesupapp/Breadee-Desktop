// Final Foundation (PERF) — sub-step profile of the two budget misses (floor projection, orders history)
// at BOTH profiles: the 90-day pre-retention tenure and the STEADY STATE retention enforces (synced ops
// ≤ 30 d, history ≤ 90 d; same 5k-order shift, 60 tables / 40 open drafts, the 1.2k unsettled backlog).
// Also a fake-indexeddb microbench: the same read shapes timed against the plain-JS work over the same rows.
//
//   node --expose-gc --import ./test/register.mjs bench/profileSteady.ts
// Writes D:\BreadeeDev\Temp\claude\bench_profile_steady.json (override with PROFILE_OUT).

import "fake-indexeddb/auto";
import { writeFileSync } from "node:fs";
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
const OUT = process.env.PROFILE_OUT ?? `D:\\BreadeeDev\\Temp\\claude\\bench_profile_${process.env.PROFILE_SEED === "steady" ? "steady" : "tenure"}.json`;

const { localdb, readCachedBillsMany, operationsRevision } = await import("@/lib/offline/db");
const seed = await import("./seedFoundation.ts");
const proj = await import("@/lib/offline/operationalProjection");
const hist = await import("@/lib/offline/ordersHistoryOffline");
const R = await import("@/lib/offline/retention");
const { T, B, SHIFT, SCOPE } = seed;

/** Release fake-indexeddb's retained finished transactions (environment artefact, see the long-run test). */
function releaseFake() {
  const raw = (localdb.backendDB() as { _rawDatabase?: { transactions?: { _state?: string }[] } } | null)?._rawDatabase;
  if (raw?.transactions) raw.transactions = raw.transactions.filter((t) => t._state !== "finished");
}
function pct(xs: number[], p: number) {
  const s = [...xs].sort((a, b) => a - b);
  return Number(s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))].toFixed(2));
}
async function time<X>(n: number, fn: () => Promise<X> | X, before?: () => Promise<unknown>): Promise<{ p50: number; p95: number; p99: number; n: number }> {
  const xs: number[] = [];
  await fn();
  for (let i = 0; i < n; i++) {
    releaseFake();
    if (before) await before(); // not timed (e.g. a write that invalidates the revision caches = "cold")
    const s = performance.now();
    await fn();
    xs.push(performance.now() - s);
  }
  return { n, p50: pct(xs, 50), p95: pct(xs, 95), p99: pct(xs, 99) };
}

const SEED = process.env.PROFILE_SEED === "steady" ? "steady" : "tenure";
const info = await seed.seedFoundation({ steady: SEED === "steady" });
const tables = info.tables as unknown as import("@/types/tables").TableSummary[];
const mapAt = info.now - 30_000;
const out: Record<string, unknown> = {};

async function profile(label: string, iters: number) {
  const r: Record<string, unknown> = {};
  const counts: Record<string, number> = {};
  for (const t of localdb.tables) counts[t.name] = await t.count();
  r.store_counts = counts;
  // ---- FLOOR: the end-to-end step and each sub-step ----
  const floor = async () => {
    await proj.tablesWithUnreflectedWork(SCOPE, mapAt);
    await proj.getOperationalTableTotals(SCOPE, tables, undefined, mapAt);
  };
  // WARM = no write since the last floor read (revision caches valid); COLD = right after a write to the op
  // log (an identical re-put of one op: every cache keyed on it is invalidated, as after a capture).
  const oneOp = (await localdb.operations.limit(1).toArray())[0];
  const touchOps = () => localdb.operations.put(oneOp);
  r.floor_total_warm = await time(iters, floor);
  r.floor_total_cold = await time(iters, floor, touchOps);
  // (a) the whole-log IndexedDB read the projection starts from (uncached: a write just happened)
  r.floor_idb_ops_toArray = await time(iters, () => localdb.operations.toArray());
  const all = await localdb.operations.toArray();
  // (b) the plain-JS scope filter over those rows
  r.floor_js_scope_filter = await time(iters, () => all.filter((o) => proj.opInScope(o, SCOPE)));
  const scoped = all.filter((o) => proj.opInScope(o, SCOPE));
  // (c) open drafts (indexed) + (d) bulk cached bills
  r.floor_idb_open_drafts = await time(iters, () => proj.openDraftsInScope(SCOPE));
  const drafts = await proj.openDraftsInScope(SCOPE);
  r.floor_idb_bills_bulkGet = await time(iters, () => readCachedBillsMany(tables.map((t) => t.id), T, B));
  const bills = await readCachedBillsMany(tables.map((t) => t.id), T, B);
  // (e) the pure per-table projection (plain JS, no I/O) for the projected tables
  const withSession = new Set(drafts.map((d) => d.table_id));
  const projected = tables.filter((t) => !(t.orders === 0 && !withSession.has(t.id)));
  r.floor_projected_tables = projected.length;
  r.floor_js_project_all_tables = await time(iters, async () => {
    for (const t of projected) await proj.getOperationalTableBill(SCOPE, t, scoped, drafts, mapAt, bills.get(t.id) ?? null);
  });
  r.floor_js_unreflected_pass = await time(iters, async () => {
    // tablesWithUnreflectedWork's pure loop over the (cached) scoped ops
    await proj.tablesWithUnreflectedWork(SCOPE, mapAt);
  });
  r.floor_cached_rev_note = `ops revision ${operationsRevision()} (scopedOperations is revision-cached between calls with no write)`;
  // ---- ORDERS HISTORY (shift): end-to-end + sub-steps ----
  const orders = () => hist.readOrdersHistoryLocal({ kind: "shift", tenantId: T, branchId: B, shiftId: SHIFT });
  const oneTxn = (await localdb.posOfflineTxns.limit(1).toArray())[0];
  const oneDraft = (await localdb.dineDrafts.limit(1).toArray())[0];
  r.orders_total_warm = await time(iters, orders);
  // COLD = after a sale: the op log, the legacy sales store and the sessions store all just changed.
  r.orders_total_cold = await time(iters, orders, async () => {
    await touchOps();
    if (oneTxn) await localdb.posOfflineTxns.put(oneTxn);
    if (oneDraft) await localdb.dineDrafts.put(oneDraft);
  });
  r.orders_idb_snapshot_get = await time(iters, () => localdb.snapshots.get(`orders:shift:${SHIFT}`));
  r.orders_idb_txns_tenant = await time(iters, () => localdb.posOfflineTxns.where("tenant_id").equals(T).toArray());
  r.orders_idb_drafts_tenant = await time(iters, () => localdb.dineDrafts.where("tenant_id").equals(T).toArray());
  r.orders_idb_unsettled_ops = await time(iters, async () => {
    for (const s of ["blocked_dependency", "cancelled", "needs_attention", "pending", "retryable", "syncing"]) await localdb.operations.where("status").equals(s).toArray();
  });
  const snap = (await localdb.snapshots.get(`orders:shift:${SHIFT}`))?.data as import("@/lib/pos/shiftOrderSummary").ShiftOpenOrder[];
  r.orders_js_merge = await time(iters, () => hist.mergeOrdersHistory(snap, [], new Map()));
  out[label] = r;
  console.log(label, JSON.stringify(r, null, 1));
}

await profile(SEED === "steady" ? "steady_state" : "pre_retention_90d", SEED === "steady" ? 20 : 5);
// A retention pass on this profile is a no-op at steady state (nothing left to prune): its fixed cost.
{
  const s = performance.now();
  const rep = SEED === "steady" ? await R.runRetention() : null;
  out.retention_pass_at_steady = rep ? { ms: Number((performance.now() - s).toFixed(1)), report: rep } : "skipped on the raw tenure (fake-idb O(N) deletes)";
}
// fake-indexeddb WRITE cost vs store size: an identical re-put of one op (every index entry rewritten).
{
  const one = (await localdb.operations.limit(1).toArray())[0];
  const big = await time(20, () => localdb.operations.put(one));
  out.fake_idb_put_on_this_store_ms = { rows: await localdb.operations.count(), ...big };
}

// fake-indexeddb microbench: the SAME rows, read through fake-indexeddb vs held in a plain JS array.
{
  const rows = await localdb.operations.toArray();
  const fakeRead = await time(20, () => localdb.operations.toArray());
  const jsCopy = await time(20, () => rows.map((o) => ({ ...o })));
  const structuredCopy = await time(20, () => structuredClone(rows));
  out.microbench = {
    rows: rows.length,
    fake_idb_getAll_ms: fakeRead,
    js_shallow_copy_ms: jsCopy,
    js_structuredClone_ms: structuredCopy,
    note: "fake-indexeddb getAll vs a plain structuredClone of the same rows: the difference is fake-idb's in-memory B-tree/cursor overhead (a real IndexedDB getAll is native).",
  };
  console.log("microbench", JSON.stringify(out.microbench, null, 1));
}
writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log(`→ ${OUT}`);
process.exit(0);
