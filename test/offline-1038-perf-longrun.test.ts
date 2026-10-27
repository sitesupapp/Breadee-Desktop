// Final Foundation (PERF, Tracks 9/11) — compressed 12-hour long-run (memory / listener / timer / store
// bounds). Run with GC exposed for the heap samples:
//   node --expose-gc --import ./test/register.mjs test/offline-1038-perf-longrun.test.ts
// (without --expose-gc the heap numbers are reported as noisy; the count invariants still hold).
//
// Simulated clock (Date.now is driven by the test; IndexedDB timers stay real). Starting state: a
// 90-day tenure at small scale (bench/seedFoundation.ts). Every simulated 10 minutes: 15 takeaway sales,
// 2 dine-in table cycles (open → round → pay), 3 delivery orders, one connectivity flap (an offline drain,
// then an online drain), one Sync Center open/close and one POS mount/unmount (drain-request +
// reachability subscriptions). Sampled every simulated hour: heap, active timers, drain listeners,
// window listeners, per-store row counts.

import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";

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
// A window shim that COUNTS listeners (the reachability store / POS subscribe to online/offline).
const winListeners = new Map<string, Set<unknown>>();
(globalThis as unknown as { window: unknown }).window = {
  addEventListener: (t: string, l: unknown) => { if (!winListeners.has(t)) winListeners.set(t, new Set()); winListeners.get(t)!.add(l); },
  removeEventListener: (t: string, l: unknown) => { winListeners.get(t)?.delete(l); },
};
const windowListenerCount = () => [...winListeners.values()].reduce((s, x) => s + x.size, 0);

// fake-indexeddb (the Node stand-in for WebView2 IndexedDB) RETAINS every finished transaction forever —
// `Database.transactions.push(tx)` with no removal (build/esm/FDBDatabase.js:159), and with it each
// request's result (every toArray). Measured independently of app code: ~5.7 KB per raw read+write pair,
// ~16 KB with Dexie. A real IndexedDB releases finished transactions, so before each slot the test drops
// the fake's FINISHED transactions (an environment fix only — nothing of the app is touched). Transactions
// are still counted for the report.
let idbTxns = 0;
function releaseFinishedFakeTransactions(db: { backendDB(): unknown }): void {
  const raw = (db.backendDB() as { _rawDatabase?: { transactions?: { _state?: string }[] } } | null)?._rawDatabase;
  if (raw?.transactions) raw.transactions = raw.transactions.filter((t) => t._state !== "finished");
}
{
  const proto = (globalThis as unknown as { IDBDatabase: { prototype: { transaction: (...a: unknown[]) => unknown } } }).IDBDatabase.prototype;
  const orig = proto.transaction;
  proto.transaction = function (this: unknown, ...a: unknown[]) {
    idbTxns++;
    return orig.apply(this, a);
  };
}

const realNow = Date.now.bind(Date);
const START = realNow();
let sim = START;
Date.now = () => sim;

const { localdb } = await import("@/lib/offline/db");
const seed = await import("../bench/seedFoundation.ts");
const OL = await import("@/lib/offline/operationLog");
const orch = await import("@/lib/offline/orchestrator");
const R = await import("@/lib/offline/retention");
const reach = await import("@/lib/offline/reachability");
const scm = await import("@/components/sync/syncCenterModel");
const qf = await import("@/lib/offline/queueForensics");
const { T, B, U, DEV, TERM, SC } = seed;

const HOUR = 3_600_000;
const SLOT = 10 * 60_000;

test("12 h compressed long-run: flat listeners/timers, bounded stores, no heap leak", { timeout: 30 * 60_000 }, async () => {
  const info = await seed.seedFoundation({ scale: 0.04, backlog: false, now: START });
  const seeded = info.counts.operations;
  reach.__resetReachabilityForTests(async () => true);
  orch.__resetDrainLockForTests();
  orch.__setReplayTimeoutForTests(10_000);
  R.__resetRetentionForTests();

  let n = 0;
  const ok = {
    hasSession: async () => true,
    refreshSession: async () => true,
    isTransport: (e: unknown) => e instanceof TypeError,
    submit: async () => ({ order_id: `S-${++n}`, order_number: `N${n}` }),
    pay: async () => ({}),
    openTable: async () => ({ table_id: `TC-${++n}`, pos_entity_version: 1 }),
    submitRound: async () => ({ order_id: `RO-${++n}`, order_number: `R${n}`, batch_no: 1, appended: false, idempotent: false }),
    orderItemMap: async () => [],
    payTable: async () => ({ ok: true, amount: 20, idempotent: false }),
  };
  const ctxOn = { tenantId: T, branchId: B, cashierUserId: U, deviceId: DEV, terminalId: TERM, online: true };
  const ctxOff = { ...ctxOn, online: false };

  type Sample = { hour: number; heapMB: number; idbTxns: number; timers: number; drainListeners: number; windowListeners: number; stores: Record<string, number> };
  const samples: Sample[] = [];
  const gc = (globalThis as { gc?: () => void }).gc;
  const sample = async (hour: number) => {
    releaseFinishedFakeTransactions(localdb);
    for (let i = 0; i < 3; i++) gc?.();
    const stores: Record<string, number> = {};
    for (const t of localdb.tables) stores[t.name] = await t.count();
    samples.push({
      hour,
      heapMB: Number((process.memoryUsage().heapUsed / 1048576).toFixed(2)),
      idbTxns,
      timers: process.getActiveResourcesInfo().filter((r) => r === "Timeout").length,
      drainListeners: OL.__drainListenerCountForTests(),
      windowListeners: windowListenerCount(),
      stores,
    });
  };

  // POS mount: one drain-request listener + one reachability subscription for the whole run (as the
  // workspace does); each slot additionally mounts/unmounts a Sync Center + a POS remount.
  const unmountPos = [OL.onDrainRequested(() => {}), reach.subscribeReachability(() => {})];
  await orch.drainOffline(ctxOn, "mount", ok as never); // h0: first drain → retention prunes the >30-day tenure
  await sample(0);

  let k = 0;
  const op = (id: string, type: string, over: Record<string, unknown>) => ({ ...seed.baseOp(id, type, over), created_at: new Date(sim).toISOString() });
  for (let slot = 1; slot <= 72; slot++) {
    sim = START + slot * SLOT;
    releaseFinishedFakeTransactions(localdb);
    const batch: Record<string, unknown>[] = [];
    for (let i = 0; i < 15; i++) batch.push(op(`LR-sale-${++k}`, "takeaway_sale", { local_entity_id: `LRS-${k}`, payload: { order_payload: { order_type: "takeaway", shift_id: seed.SHIFT, branch_id: B, currency: "USD", items: [{ menu_item_id: "m-1", quantity: 1, base_price: 10, modifiers: [] }] }, payment_intent: { method: "cash", currency: "USD" }, paid: false, shift_local: null, customer_local: null, address_local: null } }));
    for (let i = 0; i < 3; i++) batch.push(op(`LR-deliv-${++k}`, "takeaway_sale", { local_entity_id: `LRD-${k}`, payload: { order_payload: { order_type: "delivery", shift_id: seed.SHIFT, branch_id: B, currency: "USD", customer_id: "C-1", address_id: "A-1", items: [] }, payment_intent: null, paid: false, shift_local: null, customer_local: null, address_local: null } }));
    for (let t = 0; t < 2; t++) {
      const open = `LR-open-${++k}`;
      batch.push(op(open, "dinein_open_table", { local_entity_id: `LRT-${k}`, payload: { branch_id: B, name: `T${t}`, seats: 2, expected_version: null } }));
      const round = `LR-round-${k}`;
      batch.push(op(round, "dinein_send_round", { local_entity_id: `LRR-${k}`, dependency_ids: [open], depends_on_local_entities: [`LRT-${k}`], payload: { submit: { order_type: "dine_in", table_id: null, shift_id: seed.SHIFT, branch_id: B, currency: "USD", items: [] }, table_local: `LRT-${k}`, session_local: null, shift_local: null, table_name: `T${t}`, round_seq: 1 } }));
      batch.push(op(`LR-pay-${k}`, "pay_table", { dependency_ids: [round], depends_on_local_entities: [`LRT-${k}`], payload: { table_id: null, table_local: `LRT-${k}`, method: "cash", currency: "USD", table_name: `T${t}` } }));
    }
    await localdb.operations.bulkAdd(batch as never);
    // Flap: offline 2 minutes (no replay), then online.
    await orch.drainOffline(ctxOff, "flap-offline");
    sim += 2 * 60_000;
    await orch.drainOffline(ctxOn, "reconnect", ok as never);
    // Sync Center open/close + POS remount.
    const unsubs = [OL.onDrainRequested(() => {}), reach.subscribeReachability(() => {})];
    await scm.loadSyncSummary(T, B, { includeSynced: true });
    await qf.loadSyncCenterRows({ tenantId: T, branchId: B, currentBuild: "bench", currentShiftId: seed.SHIFT });
    for (const u of unsubs) u();
    if (slot % 6 === 0) await sample(slot / 6);
  }
  for (const u of unmountPos) u();
  Date.now = realNow;

  console.log(JSON.stringify({ seeded_ops: seeded, samples: samples.map((s) => ({ ...s, stores: { operations: s.stores.operations, syncHistory: s.stores.syncHistory, entityMap: s.stores.entityMap, posOfflineTxns: s.stores.posOfflineTxns, dineDrafts: s.stores.dineDrafts, receipts: s.stores.receipts } })) }));

  // Listener / timer counts are FLAT across 72 Sync Center open/close + POS remount cycles.
  for (const s of samples) {
    assert.equal(s.drainListeners, samples[0].drainListeners, `drain listeners at h${s.hour}`);
    assert.equal(s.windowListeners, samples[0].windowListeners, `window listeners at h${s.hour}`);
    assert.ok(s.timers <= samples[0].timers + 1, `active timers at h${s.hour}: ${s.timers} vs ${samples[0].timers}`);
  }
  // Retention ran at h0 (and again at h6 / h12 by the throttle): the >30-day tenure is gone.
  assert.ok(samples[0].stores.operations < seeded, `h0 retention pruned the old tenure (${samples[0].stores.operations} < ${seeded})`);
  // Stores grow only by the work actually captured in the window (no duplication / leak of rows).
  const workPerHour = 6 * (15 + 3 + 2 * 3);
  const opsGrowth = samples[samples.length - 1].stores.operations - samples[0].stores.operations;
  assert.ok(opsGrowth <= 12 * workPerHour, `ops growth ${opsGrowth} <= ${12 * workPerHour}`);
  // Heap: after hour 1 (finished fake transactions released, see above). What remains is the app plus the
  // in-memory DB rows of the work captured in the window (~144 ops + ~300 history events per hour, kept by
  // design inside the 30-day window): it must stay under 1 MB/h.
  if (gc) {
    const xs = samples.slice(1);
    const a = xs[0], b = xs[xs.length - 1];
    const hours = b.hour - a.hour;
    const slope = (b.heapMB - a.heapMB) / hours;
    console.log(JSON.stringify({ heap_slope_mb_per_h: Number(slope.toFixed(3)), idb_txns_per_h: Math.round((b.idbTxns - a.idbTxns) / hours), heap_h1_mb: a.heapMB, heap_h12_mb: b.heapMB }));
    assert.ok(slope < 1, `heap slope ${slope.toFixed(3)} MB/h`);
  }
});
