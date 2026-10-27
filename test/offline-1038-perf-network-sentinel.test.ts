// 1.0.38 PERF (Track 8) — NETWORK-OFF SENTINEL.
//
// Every offline-capable capture / read is driven with the backend unreachable and asserted to make ZERO
// network attempts: `globalThis.fetch` records + throws TypeError("Failed to fetch") and "@/lib/supabase"
// is a recording Proxy (test/support/sentinel-hook.mjs redirects it — a SECOND loader hook registered
// only here, so no other test changes). The shared reachability store is forced unreachable through its
// test hook, and each action is also held to ≤ 1 reachability probe (the C10 probe-storm guard).
// Real Dexie (fake-indexeddb), real capture engines, real zustand stores.

import "fake-indexeddb/auto";
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { registerSentinelHook, installFetchSentinel, expectNoNetwork, netCalls, resetNet, type NetCall } from "./support/networkSentinel.ts";

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? (this.m.get(k) as string) : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
(globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage();

// The hook must be live BEFORE any module under test is resolved: everything below is imported dynamically.
registerSentinelHook();
installFetchSentinel();

const reach = await import("@/lib/offline/reachability");
const db = await import("@/lib/offline/db");
const dine = await import("@/lib/offline/dineinOffline");
const proj = await import("@/lib/offline/operationalProjection");
const tableOp = await import("@/lib/offline/tableOpOffline");
const endShift = await import("@/lib/offline/endShiftOffline");
const refund = await import("@/lib/offline/refundOffline");
const payout = await import("@/lib/offline/payoutOffline");
const receivable = await import("@/lib/offline/receivableCollectOffline");
const history = await import("@/lib/offline/ordersHistoryOffline");
const deliveryQueue = await import("@/lib/offline/deliveryQueueOffline");
const customerCache = await import("@/lib/offline/customerCache");
const printRoute = await import("@/lib/pos/printRouteResolver");
const { useTables } = await import("@/state/tables");
const { useShiftOrders } = await import("@/state/shiftOrders");
const { useCustomers } = await import("@/state/customers");
const { useSession } = await import("@/state/session");
const { raceBootRead, POS_BOOT_READ_TIMEOUT_MS } = await import("@/state/pos");
const { getDeviceIdentity } = await import("@/lib/device");

type TableSummary = import("@/types/tables").TableSummary;

const DEV = getDeviceIdentity();
const SCOPE = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: DEV.device_id, terminalId: DEV.terminal_id ?? null };
const DSCOPE = { ...SCOPE, shiftId: "SRV-SHIFT-1" };
const MAP_AT = Date.now() - 10 * 60_000;
const CTX = { tenantId: "t1", branchId: "b1" };

const row = (id: string, over: Partial<TableSummary> = {}): TableSummary =>
  ({ id, name: id, seats: 4, occupied: false, status: "available", canonical: true, configured: true, sort_order: 1, orders: 0, order_number: null, opened_at: null, total: null, collected: null, outstanding: null, currency: "LBP", mixed_currency: false, pos_entity_version: 1, ...over }) as TableSummary;

async function offlineSession(tableId: string, price = 100) {
  const d = await dine.openTableOffline({ scope: DSCOPE, tableId, tableName: tableId, seats: 4, currency: "LBP" });
  await dine.addDraftLine(d.local_session_id, { menu_item_id: "m", name: "Pizza", base_price: price, quantity: 2, modifiers: [], kitchen_note: null });
  return dine.sendRoundOffline(d.local_session_id);
}

// ---------------------------------------------------------------- the harness

type ActionResult = { name: string; calls: NetCall[]; probes: number; error: unknown };
const ledger: ActionResult[] = [];

/** One user action: fresh store forced UNREACHABLE, run, collect non-allow-listed network calls + probe count. */
async function action<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  reach.__resetReachabilityForTests(async () => false);
  const r = await expectNoNetwork(fn);
  const probes = reach.__reachabilityProbeCountForTests();
  ledger.push({ name, calls: r.calls, probes, error: r.error });
  assert.deepEqual(r.calls.map((c) => `${c.api}:${c.name}`), [], `${name}: no network offline`);
  assert.ok(probes <= 1, `${name}: at most one reachability probe per action (got ${probes})`);
  if (r.error) throw r.error;
  return r.result;
}

before(() => {
  useSession.setState({
    userId: "u1",
    tenant: { id: "t1", main_branch_id: "b1" },
    membership: { id: "mem1", all_branches: false, branch_id: "b1", role: "cashier" },
  } as never);
});

beforeEach(async () => {
  await Promise.all([
    db.localdb.operations.clear(), db.localdb.entityMap.clear(), db.localdb.syncHistory.clear(), db.localdb.dineDrafts.clear(),
    db.localdb.snapshots.clear(), db.localdb.posOfflineTxns.clear(), db.localdb.printRoutes.clear(),
  ]);
  useTables.getState().reset();
  resetNet();
});

// ---------------------------------------------------------------- sanity: the sentinel itself records

test("sentinel self-check: a direct client call and a raw fetch ARE recorded (so zero means zero)", async () => {
  const { supabase } = (await import("@/lib/supabase")) as unknown as { supabase: { from(t: string): { select(s: string): Promise<unknown> }; rpc(n: string): Promise<unknown> } };
  resetNet();
  await assert.rejects(async () => await supabase.from("orders").select("*"), TypeError);
  await assert.rejects(async () => await supabase.rpc("pos_submit_order"), TypeError);
  await assert.rejects(() => fetch("https://sentinel.invalid/x"), TypeError);
  assert.deepEqual(netCalls().map((c) => `${c.api}:${c.name}`), ["from:orders", "rpc:pos_submit_order", "fetch:https://sentinel.invalid/x"]);
});

// ---------------------------------------------------------------- Dine-In capture surface

test("Dine-In: open + round, move, merge, projections, split leg, settle — zero network", async () => {
  const a = await action("dine: openTableOffline+addDraftLine+sendRoundOffline", () => offlineSession("A"));
  assert.ok(a);
  const move = await action("dine: captureMoveTableOffline", () => tableOp.captureMoveTableOffline({ scope: SCOPE, from: row("A"), to: row("B"), mapLoadedAt: MAP_AT }));
  assert.equal(move?.ok, true);

  await action("dine: open C + D sessions", async () => { await offlineSession("C", 50); await offlineSession("D", 70); });
  const merge = await action("dine: captureMergeTablesOffline", () =>
    tableOp.captureMergeTablesOffline({ scope: SCOPE, primary: row("C"), sources: [row("D")], mapLoadedAt: MAP_AT }),
  );
  assert.equal(typeof merge?.ok, "boolean");

  const pB = await action("dine: getOperationalTableBill", () => proj.getOperationalTableBill(SCOPE, row("B"), undefined, undefined, MAP_AT));
  assert.equal(pB?.gross, 200);
  await action("dine: getOperationalTableTotals", () => proj.getOperationalTableTotals(SCOPE, [row("A"), row("B"), row("C"), row("D")], undefined, MAP_AT));

  const e = await offlineSession("E", 30);
  const leg = await action("dine: splitOperationalBillOffline", () =>
    dine.splitOperationalBillOffline({ scope: DSCOPE, orderId: null, orderLocal: e.local_session_id, allocations: [{ line_local: e.lines[0].line_id, quantity: 1 }], method: "cash", currency: "LBP", tableName: "E", dependencyIds: dine.sessionBarrier(e) }),
  );
  assert.equal(leg?.ok, true);
  const f = await offlineSession("F", 40);
  const settle = await action("dine: settleTableOffline", () => dine.settleTableOffline({ sessionId: f.local_session_id, method: "cash", covers: { orderIds: [], summary: false } }));
  assert.ok(settle);
});

// ---------------------------------------------------------------- money captures

test("money captures: refund, payout, receivable collect, End Shift — zero network", async () => {
  const RSCOPE = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1" };
  await refund.cacheRefundProof({ scope: RSCOPE, order: { order_id: "SRV-ORDER", order_number: "A-1", shift_id: "sh1", pos_entity_version: 4, payment_status: "paid", status: "completed", refundable_usd: 0.5, currency: "LBP" } as never });
  const rp = await refund.proveOfflineReversible("SRV-ORDER", RSCOPE);
  assert.equal(rp.ok, true);
  const rc = await action("money: captureOfflineRefund", () => refund.captureOfflineRefund({ scope: RSCOPE, proof: (rp as { proof: never }).proof, action: "refund", reason: "spill", tender: "cash" }));
  assert.equal(rc?.alreadyCaptured, false);

  await db.cachePayoutSourceProofs(RSCOPE, "expense", [{ id: "EXP-1", label: "Driver", sublabel: null }]);
  const pp = await payout.provePayoutSourceOffline("expense", "EXP-1", RSCOPE);
  assert.ok(pp.ok);
  await action("money: capturePayoutOffline", () =>
    payout.capturePayoutOffline({ scope: RSCOPE, shiftId: "SRV-SHIFT-1", proof: pp.ok ? pp.proof : (undefined as never), amount: 9, currency: "USD", note: null, amountUsd: 9, clientOpId: "pc1" }),
  );

  await db.cacheReceivableProof({ order_id: "ORD-1", order_number: "R-1", tenant_id: "t1", branch_id: "b1", customer_id: "C1", customer_name: "Sam", outstanding_amount: 100, currency: "USD", cached_at: new Date().toISOString() });
  await action("money: captureReceivableCollectOffline", () =>
    receivable.captureReceivableCollectOffline({ scope: RSCOPE, orderId: "ORD-1", amount: 40, method: "cash", currency: "USD", clientOpId: "rc1", cashAmountUsd: 40 }),
  );

  const es = await action("money: captureEndShiftOffline", () => endShift.captureEndShiftOffline({ scope: RSCOPE, shiftId: "SRV-SHIFT-1", shiftLocal: null, actualCashCounted: 100, notes: null }));
  assert.ok(es);
});

// ---------------------------------------------------------------- offline-aware readers (DEFAULT deps → shared store)

test("offline-aware readers with DEFAULT deps: orders history, delivery queue (+prewarm), customers — zero network", async () => {
  const h = await action("read: loadOrdersHistoryOfflineAware (default deps)", () => history.loadOrdersHistoryOfflineAware({ kind: "shift", tenantId: "t1", branchId: "b1", shiftId: "SRV-SHIFT-1" }));
  assert.ok(h);
  const q = await action("read: loadDeliveryQueueOfflineAware (default deps)", () => deliveryQueue.loadDeliveryQueueOfflineAware({ tenantId: "t1", branchId: "b1", shiftId: "SRV-SHIFT-1", now: new Date() }));
  assert.equal(q?.offline, true);
  assert.equal(await action("read: prewarmDeliveryQueue", () => deliveryQueue.prewarmDeliveryQueue({ tenantId: "t1", branchId: "b1", shiftId: "SRV-SHIFT-1", now: new Date() })), false);

  await customerCache.cacheCustomerProfile({ id: "CUST-1", name: "Sam Offline", phone: "03123456", phone_e164: "+9613123456", notes: null, addresses: [], orders: [] } as never, { tenantId: "t1", branchId: "b1" });
  const found = await action("read: searchCustomersOfflineAware", () => customerCache.searchCustomersOfflineAware("Sam"));
  assert.equal(found?.[0]?.id, "CUST-1");
  const prof = await action("read: loadCustomerProfileOfflineAware", () => customerCache.loadCustomerProfileOfflineAware("CUST-1"));
  assert.equal(prof?.name, "Sam Offline");
  const up = await action("write: upsertCustomerOfflineAware (captured)", () => customerCache.upsertCustomerOfflineAware({ name: "New Guest", phone: "03999888" }, crypto.randomUUID()));
  assert.equal(up?.pending_local, true);
});

// ---------------------------------------------------------------- store actions (the C10 probe storm)

test("store actions: useTables.refresh+select (ONE probe for the whole tap), useShiftOrders.refresh, useCustomers.search/select", async () => {
  await db.cacheTableMap({ tables: [row("A"), row("B", { orders: 1, occupied: true, status: "occupied", total: 100 })], total: 2, occupied: 1, available: 1, configured: 2, legacy_hidden: 0 } as never, "t1", "b1", MAP_AT);
  // The C10 sequence after an offline open: refresh the map, select the table (which loads its bill).
  await action("store: useTables.refresh + select + loadBill", async () => {
    await useTables.getState().refresh(CTX);
    await useTables.getState().select("B", CTX);
    await useTables.getState().loadBill(CTX);
  });
  assert.equal(useTables.getState().offline, true);
  assert.equal(useTables.getState().map.tables.length, 2);

  await action("store: useShiftOrders.refresh", () => useShiftOrders.getState().refresh({ tenantId: "t1", shiftId: "SRV-SHIFT-1", branchId: "b1" } as never));

  await customerCache.cacheCustomerProfile({ id: "CUST-2", name: "Rana", phone: "03111222", phone_e164: "+9613111222", notes: null, addresses: [], orders: [] } as never, { tenantId: "t1", branchId: "b1" });
  await action("store: useCustomers.search + select", async () => {
    await useCustomers.getState().search("Rana");
    await useCustomers.getState().select("CUST-2");
  });
});

// ---------------------------------------------------------------- the PERF helpers

test("PERF helpers: resolvePrintRouteCached (store offline) and raceBootRead — zero network", async () => {
  const ROUTE = { ...printRoute.UNRESOLVED, resolved: true, route_id: "R1", printer_id: "P1", system_printer_name: "WIN-FRONT", paper_width: "80mm", copies: 1 };
  await db.cachePrintRoute("b1", "receipt", "takeaway", ROUTE);
  // The store knows it is offline (as after the badge poll / a transport error): cache only.
  reach.__resetReachabilityForTests(async () => false);
  await reach.isBackendReachable();
  resetNet();
  const r = await expectNoNetwork(() => printRoute.resolvePrintRouteCached({ branchId: "b1", purpose: "receipt", orderSource: "takeaway" }));
  assert.deepEqual(r.calls, []);
  assert.deepEqual(r.result, ROUTE);
  const miss = await expectNoNetwork(() => printRoute.resolvePrintRouteCached({ branchId: "b1", purpose: "receipt", orderSource: "delivery" }));
  assert.deepEqual(miss.calls, []);
  assert.equal(miss.result, null);
  ledger.push({ name: "helper: resolvePrintRouteCached (hit + miss)", calls: [...r.calls, ...miss.calls], probes: 0, error: null });

  // Unknown store + a failing resolve (the C1–C3 path): falls back to the cache. This one DOES try the
  // server (that is its contract while reachability is unknown) — the attempt is the single allow-listed rpc.
  reach.__resetReachabilityForTests(async () => false);
  const fb = await expectNoNetwork(() => printRoute.resolvePrintRouteCached({ branchId: "b1", purpose: "receipt", orderSource: "takeaway" }), ["rpc:resolve_print_route"]);
  assert.deepEqual(fb.calls, []);
  assert.deepEqual(fb.result, ROUTE);

  // POS boot (C9): a hung branch read is bounded; the late answer is still delivered to whoever awaits it.
  assert.ok(POS_BOOT_READ_TIMEOUT_MS >= 1000 && POS_BOOT_READ_TIMEOUT_MS <= 10_000);
  const hung = new Promise<string>(() => undefined);
  assert.equal(await raceBootRead(hung, 15), null);
  assert.equal(await raceBootRead(Promise.resolve("Main"), 1000), "Main");
});

test("REPORT: every driven action stayed off the network", () => {
  const driven = ledger.length;
  const offending = ledger.filter((l) => l.calls.length > 0);
  const maxProbes = Math.max(0, ...ledger.map((l) => l.probes));
  console.log(`[sentinel] actions driven: ${driven}; non-allow-listed network calls: ${offending.length}; max probes per action: ${maxProbes}`);
  for (const l of ledger) console.log(`[sentinel]   ${l.calls.length === 0 ? "ok " : "NET"} probes=${l.probes} ${l.name}`);
  assert.ok(driven >= 20, `the sentinel must drive the capture surface (drove ${driven})`);
  assert.equal(offending.length, 0);
});
