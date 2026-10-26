// 1.0.38 Workstream B — settlement + projection (BUG 1 / BUG 3, dine-in side; C3; C8; F1 client guard).
// Real Dexie via fake-indexeddb, the REAL capture engines / projections / history loader; no server.
//
//   BUG 1  a legitimately settled bill never reopens: a settle that is pending / retryable / blocked /
//          parked behind a prerequisite keeps the table closed (and HELD online); only an authoritative
//          server refusal reopens it — with the refusal shown, never a fake Paid. No ghost balance on a
//          table the server map shows free. Map freshness = read START.
//   C3     parked (needs_attention) edits / legs are attention items, never payable, never a dependency.
//   BUG 3  Orders History uses the SAME precedence rule as the floor / Delivery, online too, incl.
//          takeaway cash sales and offline-created dine-in orders (entity map).
//   F1     a full Pay of a part-paid (split) bill is refused client-side (server still charges T, not T − P).
//   F4     (Hush 261024-0045 review) an offline round sends ONLY the cart's lines — never a canonical
//          line — and a retried Send never stages the same cart lines twice.

import "fake-indexeddb/auto";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? (this.m.get(k) as string) : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
(globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage();

import { localdb, cacheBill, cacheTableMap, readCachedTableMap, type PosOfflineTxn } from "@/lib/offline/db";
import { getOperation, type OfflineOperation } from "@/lib/offline/operationLog";
import {
  openTableOffline,
  addDraftLine,
  stageUnsentDraftLines,
  sendRoundOffline,
  settleTableOffline,
  splitOperationalBillOffline,
  getDineDraftForTable,
  reconcileDineDraftsFromOperations,
} from "@/lib/offline/dineinOffline";
import {
  projectTableBill,
  projectDeliveryOrder,
  settleStillCovers,
  settleAwaitingRecovery,
  settleRefusedByServer,
  settlePrecedence,
  tablesWithUnreflectedWork,
  getOperationalTableTotals,
  overlayTableTotals,
  editTargetFor,
  refusedSettleNotice,
  SETTLE_ATTENTION_HOLD_MESSAGE,
} from "@/lib/offline/operationalProjection";
import { loadOrdersHistoryOfflineAware, readOrdersHistoryLocal } from "@/lib/offline/ordersHistoryOffline";
import { payTableGate, performTablePayment, PartPaidBillError, PART_PAID_FULL_PAY_MESSAGE, type TablePaymentResult } from "@/lib/pos/tablePayment";
import { getDeviceIdentity } from "@/lib/device";
import type { ShiftOpenOrder } from "@/lib/pos/shiftOrderSummary";
import type { TableBill, TableSummary } from "@/types/tables";
import type { DeliveryQueueOrder } from "@/lib/pos/deliveryOrderManagement";

const here = dirname(fileURLToPath(import.meta.url));
const src = (p: string) => readFileSync(resolve(here, "..", p), "utf8");

const DEV = getDeviceIdentity();
const SCOPE = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: DEV.device_id, terminalId: DEV.terminal_id ?? null };
const DSCOPE = { ...SCOPE, shiftId: "SRV-SHIFT-1" };
const OPSCOPE = { tenant_id: "t1", branch_id: "b1", device_id: DEV.device_id, terminal_id: DEV.terminal_id ?? "", cashier_user_id: "u1" };

beforeEach(async () => {
  await Promise.all([
    localdb.operations.clear(), localdb.entityMap.clear(), localdb.syncHistory.clear(), localdb.dineDrafts.clear(),
    localdb.snapshots.clear(), localdb.posOfflineTxns.clear(), localdb.pendingShifts.clear(),
  ]);
});

function op(over: Partial<OfflineOperation> & Pick<OfflineOperation, "operation_id" | "operation_type">): OfflineOperation {
  return { schema_version: 1, scope: OPSCOPE, created_at: new Date().toISOString(), client_op_id: crypto.randomUUID(), local_entity_id: null, canonical_entity_id: null, dependency_ids: [], depends_on_local_entities: [], payload: {}, status: "pending", retry_count: 0, last_attempt_at: null, last_error_code: null, last_error_message: null, result_meta: null, synced_at: null, ...over } as OfflineOperation;
}

const table = (over: Partial<TableSummary> = {}): TableSummary =>
  ({ id: "TBL-1", name: "1", seats: 4, occupied: false, status: "available", canonical: true, configured: true, sort_order: 1, orders: 0, order_number: null, opened_at: null, total: null, collected: null, outstanding: null, currency: "LBP", mixed_currency: false, pos_entity_version: 1, ...over }) as TableSummary;
const occupied = (over: Partial<TableSummary> = {}) => table({ orders: 1, occupied: true, status: "occupied", total: 355000, order_number: "260101-0001", ...over });

const canonicalBill = (orderId = "ORD-A", tableId = "TBL-1"): TableBill => ({
  tableId,
  orders: [{ id: orderId, order_number: "260101-0001", status: "sent_to_kitchen", payment_status: "unpaid", pos_entity_version: 1, shift_id: "SRV-SHIFT-1", branch_id: "b1", tenant_id: "t1", subtotal: 355000, discount_amount: 0, total_amount: 355000, currency: "LBP", exchange_rate: null, created_at: new Date().toISOString(), lines: [{ id: "L1", menu_item_id: "m", name: "Pizza", quantity: 1, base_price: 355000, modifiers_total: 0, final_unit_price: 355000, line_total: 355000, kitchen_note: null, batch_no: 1, modifiers: [] }] }],
  subtotal: 355000, total: 355000, currency: "LBP", mixedCurrency: false, splitShift: false, batches: [1],
});

async function sentSession(tableId = "TBL-1") {
  const d = await openTableOffline({ scope: DSCOPE, tableId, tableName: tableId, seats: 4, currency: "LBP" });
  await addDraftLine(d.local_session_id, { menu_item_id: "m", name: "Pizza", base_price: 355000, quantity: 1, modifiers: [], kitchen_note: null });
  return sendRoundOffline(d.local_session_id);
}

async function settledSession(tableId = "TBL-1") {
  const d = await sentSession(tableId);
  const s = await settleTableOffline({ sessionId: d.local_session_id, method: "cash", covers: { orderIds: [], summary: false } });
  return { d, s };
}

const park = (id: string, code: string, message: string) => localdb.operations.update(id, { status: "needs_attention", last_error_code: code, last_error_message: message });

// ================================================================ BUG 1 — a settled bill never reopens

test("settleStillCovers: only an AUTHORITATIVE server refusal un-covers; parked / transient / pending keep covering", () => {
  const pay = (status: OfflineOperation["status"], code: string | null = null, message: string | null = null) => op({ operation_id: crypto.randomUUID(), operation_type: "pay_table", status, last_error_code: code, last_error_message: message });
  for (const st of ["pending", "blocked_dependency", "retryable", "syncing", "synced"] as const) assert.equal(settleStillCovers(pay(st)), true, st);
  const parked: [string, string][] = [
    ["dependency_failed", "round:1"],
    ["missing_dependency", "open:1"],
    ["circular_dependency", "a -> b"],
    ["engine_error", "boom"],
    ["validation", "JWT expired"],
    ["validation", "502 Bad Gateway"],
    ["validation", "deadlock detected"],
    ["validation", "cannot execute UPDATE in a read-only transaction"],
  ];
  for (const [code, msg] of parked) {
    const o = pay("needs_attention", code, msg);
    assert.equal(settleStillCovers(o), true, `${code}: ${msg}`);
    assert.equal(settleAwaitingRecovery(o), true, `${code} is awaiting recovery (held), not refused`);
    assert.equal(settleRefusedByServer(o), false);
  }
  for (const [code, msg] of [["validation", "This order is not attached to an open shift"], ["permission", "permission denied"], ["shift_closed", "This shift is already closed."], ["settle_conflict", "VERSION_CONFLICT"]]) {
    const o = pay("needs_attention", code, msg);
    assert.equal(settleRefusedByServer(o), true, msg);
    assert.equal(settleStillCovers(o), false, msg);
  }
  // an amount in a validation message is never mistaken for an HTTP 5xx
  assert.equal(settleRefusedByServer(pay("needs_attention", "validation", "Amount 500,000 exceeds the outstanding balance")), true);
  const closed = pay("needs_attention", "settle_conflict", "Order already paid");
  assert.equal(settleStillCovers(closed), true);
  assert.equal(settleAwaitingRecovery(closed), false, "closed elsewhere: no hold needed");
  assert.equal(settleStillCovers(pay("cancelled")), false);
});

for (const [label, status, code] of [
  ["pending", "pending", null],
  ["retryable", "retryable", "pay_table: transport"],
  ["dependency-blocked", "blocked_dependency", null],
  ["parked behind a failed prerequisite", "needs_attention", "dependency_failed"],
] as const) {
  test(`BUG 1 a settle that is ${label} keeps the table CLOSED (draft settled, floor available, held online)`, async () => {
    const { d, s } = await settledSession();
    await localdb.operations.update(s.operationId, { status, last_error_code: code, last_error_message: code ? "round:1" : null });
    await reconcileDineDraftsFromOperations();
    assert.equal((await localdb.dineDrafts.get(d.local_session_id))?.status, "settled", "never reopened");
    assert.equal(await getDineDraftForTable(SCOPE, "TBL-1"), null);
    // the session's open + round reached the server (round 1 created ORD-A) — the settle has not
    const mapAt = Date.now() - 60_000;
    for (const id of [d.open_operation_id, d.rounds[0].operation_id]) {
      await localdb.operations.update(id, { status: "synced", synced_at: new Date(mapAt + 10_000).toISOString(), canonical_entity_id: id === d.open_operation_id ? "TBL-1" : "ORD-A" });
    }
    await cacheBill("TBL-1", canonicalBill("ORD-A"), "t1", "b1", mapAt + 20_000);
    // a map still showing the bill: the projection keeps it closed (no fake unpaid bill)
    const stale = occupied();
    const work = await tablesWithUnreflectedWork(SCOPE, mapAt + 20_000);
    assert.ok(work.touched.has("TBL-1"));
    const shown = overlayTableTotals([stale], await getOperationalTableTotals(SCOPE, [stale], work.touched, mapAt + 20_000));
    assert.equal(shown[0].orders, 0);
    assert.equal(shown[0].status, "available");
    // ONLINE hold: no second payment / new round on a bill whose settle is not finally refused
    assert.ok(work.syncingSettle.has("TBL-1"), "held");
    assert.equal(work.attentionSettle.has("TBL-1"), status === "needs_attention");
    assert.equal(work.refusedSettle.has("TBL-1"), false);
  });
}

test("BUG 1 a session 1.0.37 REOPENED for a dependency_failed settle heals: it is settled again, never the active bill", async () => {
  const { d, s } = await settledSession();
  await park(s.operationId, "dependency_failed", "round:1");
  // what 1.0.37's reconcile did to it
  await localdb.dineDrafts.update(d.local_session_id, { status: "open", settled_operation_id: null, settled_at: null });
  assert.equal(await getDineDraftForTable(SCOPE, "TBL-1"), null, "repaired to settled, not returned as the table's bill");
  assert.equal((await localdb.dineDrafts.get(d.local_session_id))?.status, "settled");
});

test("BUG 1 an AUTHORITATIVE refusal reopens the bill WITH the refusal visible — never a fake Paid, never held", async () => {
  const { d, s } = await settledSession();
  await park(s.operationId, "validation", "This order is not attached to an open shift");
  await reconcileDineDraftsFromOperations();
  const reopened = (await localdb.dineDrafts.get(d.local_session_id))!;
  assert.equal(reopened.status, "open");
  const p = projectTableBill({ tableId: "TBL-1", mapRow: occupied({ total: null }), canonical: null, draft: reopened, ops: await localdb.operations.toArray() });
  assert.equal(p.settledLocally, false);
  assert.equal(p.settlementConflict, true);
  assert.equal(p.refusedSettleMessage, "This order is not attached to an open shift");
  assert.equal(p.gross, 355000, "the bill is active + unpaid");
  const work = await tablesWithUnreflectedWork(SCOPE, Date.now());
  assert.equal(work.refusedSettle.get("TBL-1"), "This order is not attached to an open shift");
  assert.equal(work.syncingSettle.has("TBL-1"), false, "payable again — the server refused the money");
  assert.match(refusedSettleNotice("x"), /refused this table's offline payment \(x\)\. The bill is still unpaid/);
  // a LATER valid settle supersedes the old refusal (no stale notice)
  await localdb.operations.add(op({ operation_id: "paytable:later", operation_type: "pay_table", created_at: new Date(Date.now() + 1000).toISOString(), payload: { table_id: "TBL-1" } }));
  assert.equal((await tablesWithUnreflectedWork(SCOPE, Date.now())).refusedSettle.has("TBL-1"), false);
});

test("BUG 1 wiring: the online hold covers parked settles (own message); a refusal is told to the cashier", () => {
  const dw = src("src/screens/pos/DineInWorkspace.tsx");
  assert.match(dw, /syncingSettle\.has\(selected\.id\)\s*\?\s*attentionSettle\.has\(selected\.id\)\s*\?\s*SETTLE_ATTENTION_HOLD_MESSAGE/);
  assert.match(dw, /setAttentionSettle\(work\?\.attentionSettle \?\? new Set\(\)\)/);
  assert.match(dw, /toast\.push\(\{ tone: "warning", message: "Offline payment refused", detail: refusedSettleNotice\(selectedRefusal\) \}\)/);
  assert.match(SETTLE_ATTENTION_HOLD_MESSAGE, /already collected — don't take payment or add a new round/);
  // payGate + openGate both start with the hold (rc.13 contract kept)
  for (const gate of ["const payGate: Gate = useMemo", "const openGate: Gate = useMemo"]) {
    const i = dw.indexOf(gate);
    assert.ok(i > 0 && /if \(settleSyncHoldReason\) return/.test(dw.slice(i, i + 200)), gate);
  }
});

test("BUG 1 no GHOST balance: a reopened draft's SYNCED rounds are not re-added on a table the (newer) map shows FREE", async () => {
  const d = await sentSession();
  const syncedAt = Date.now() - 30_000;
  for (const id of [d.open_operation_id, d.rounds[0].operation_id]) {
    await localdb.operations.update(id, { status: "synced", synced_at: new Date(syncedAt).toISOString(), canonical_entity_id: id === d.open_operation_id ? "TBL-1" : "ORD-A" });
  }
  const free = table();
  // the map read STARTED after the round synced and shows the table free → the server closed that bill
  assert.equal((await getOperationalTableTotals(SCOPE, [free], new Set(["TBL-1"]), Date.now())).size, 0, "no ghost unpaid balance");
  // a map read that started BEFORE the round synced cannot speak for it → the local bill is still shown
  const early = await getOperationalTableTotals(SCOPE, [free], new Set(["TBL-1"]), syncedAt - 10_000);
  assert.equal(early.get("TBL-1")?.total, 355000);
  // a PENDING settle covering the reopened session: no ghost either (the settle closes it)
  await settleTableOffline({ sessionId: d.local_session_id, method: "cash", covers: { orderIds: [], summary: false } });
  const withSettle = await getOperationalTableTotals(SCOPE, [free], new Set(["TBL-1"]), syncedAt - 10_000);
  assert.equal(withSettle.get("TBL-1")?.orders ?? 0, 0);
});

test("C8 floor-map freshness = read START (state + cached snapshot)", async () => {
  const startedAt = Date.now() - 5_000;
  await cacheTableMap({ tables: [] }, "t1", "b1", startedAt);
  assert.equal((await readCachedTableMap("t1", "b1"))?.cachedAt, startedAt);
  const t = src("src/state/tables.ts");
  const i = t.indexOf("const startedAt = Date.now();");
  assert.ok(i > 0 && i < t.indexOf("await loadTableMap(ctx.branchId)"), "stamped BEFORE the read");
  assert.match(t, /cacheTableMap\(map, ctx\.tenantId, ctx\.branchId, startedAt\)/);
  assert.match(t, /offline: false,\s*lastLoadedAt: startedAt,/);
  assert.match(src("src/screens/pos/DineInWorkspace.tsx"), /getOperationalTableTotals\(scope, tables\.map\.tables, work\?\.touched, tables\.lastLoadedAt\)/);
});

// ================================================================ C3 — parked ops are attention items only

test("C3 a PARKED edit / split leg is never applied to the payable bill, the version chain, or a settle's deps", async () => {
  const t0 = Date.now() - 60_000;
  const at = (s: number) => new Date(t0 + s * 1000).toISOString();
  const editPayload = (n: number) => ({ order_id: "ORD-A", payload: { order_id: "ORD-A", op: "set_quantity", new_quantity: n, target_item_id: "L1" }, target_ref: { kind: "canonical", order_item_id: "L1" } });
  const parkedEdit = op({ operation_id: "edit:parked", operation_type: "edit_order_line", created_at: at(1), status: "needs_attention", last_error_code: "conflict", last_error_message: "VERSION_CONFLICT", payload: editPayload(3) });
  const parkedLeg = op({ operation_id: "split:parked", operation_type: "split_settle", created_at: at(2), status: "needs_attention", last_error_code: "validation", last_error_message: "over-allocation", payload: { order_id: "ORD-A", allocations: [{ order_item_id: "L1", quantity: 1 }] } });
  const goodEdit = op({ operation_id: "edit:ok", operation_type: "edit_order_line", created_at: at(3), payload: editPayload(2) });
  const p = projectTableBill({ tableId: "TBL-1", mapRow: occupied(), canonical: { bill: canonicalBill(), fetchedAt: t0 }, draft: null, ops: [parkedEdit, parkedLeg, goodEdit] });
  assert.equal(p.gross, 710000, "only the valid edit (1 → 2) is on the bill; the refused 1 → 3 is not");
  assert.equal(p.paidPending, 0, "a refused leg is not money collected");
  assert.equal(p.outstanding, 710000);
  assert.deepEqual(p.pendingMutationOpIds, ["edit:ok"]);
  assert.deepEqual(p.attentionOpIds.sort(), ["edit:parked", "split:parked"]);
  assert.equal(p.attention, 2);
  assert.deepEqual(p.mutationOpIds.sort(), ["edit:ok", "edit:parked", "split:parked"], "still listed for display");
  assert.deepEqual(p.orders[0].bumpOps, ["edit:ok"], "the version chain counts only bumps the server can apply");
  assert.deepEqual(p.orders[0].pendingSplitOps, [], "a refused leg never trips the paid-item wall");
  const t = editTargetFor(p, "L1");
  assert.ok(t.ok && !t.target.dependencyIds.includes("edit:parked"));
  // the settle is captured with ONLY the live mutations as dependencies (DineInWorkspace passes these)
  const s = await settleTableOffline({ sessionId: null, table: { scope: SCOPE, tableId: "TBL-1", tableName: "1", currency: "LBP", orderIds: ["ORD-A"] }, method: "cash", extraDependencyIds: p.pendingMutationOpIds, covers: { orderIds: ["ORD-A"], summary: false } });
  const settle = (await getOperation(s.operationId))!;
  assert.deepEqual(settle.dependency_ids, ["edit:ok"], "never dead at capture behind a refused op");
  assert.match(src("src/screens/pos/DineInWorkspace.tsx"), /deps: p\.pendingMutationOpIds,/);
});

test("C3 a new offline split leg never chains onto a PARKED leg", async () => {
  await localdb.operations.add(op({ operation_id: "split:parked", operation_type: "split_settle", status: "needs_attention", last_error_code: "validation", last_error_message: "over-allocation", created_at: new Date(Date.now() - 5000).toISOString(), payload: { order_id: "ORD-A", order_local: null, allocations: [{ order_item_id: "L1", quantity: 1 }] } }));
  const r = await splitOperationalBillOffline({ scope: SCOPE, orderId: "ORD-A", orderLocal: null, allocations: [{ order_item_id: "L1", quantity: 1 }], method: "card", currency: "LBP", tableName: "1", dependencyIds: [] });
  assert.ok(r.ok);
  assert.deepEqual((await getOperation(r.operationId))?.dependency_ids, []);
});

// ================================================================ BUG 3 — Orders History, one precedence rule

const row = (over: Partial<ShiftOpenOrder> & Pick<ShiftOpenOrder, "id">): ShiftOpenOrder => ({
  order_number: "261020-0001", order_type: "takeaway", status: "sent_to_kitchen", payment_status: "unpaid", payment_method: null, subtotal: 1, discount_amount: 0,
  total_amount: 1, currency: "LBP", table_id: null, customer_id: null, customer_name: null, customer_phone: null, cashier_user_id: "u1", staff_name: "M", notes: null,
  created_at: new Date(Date.now() - 3_600_000).toISOString(), ...over,
});
const SHIFT_SCOPE = { kind: "shift" as const, tenantId: "t1", branchId: "b1", shiftId: "SRV-SHIFT-1" };
const snapshot = (rows: ShiftOpenOrder[], at: number) => localdb.snapshots.put({ key: "orders:shift:SRV-SHIFT-1", tenant_id: "t1", branch_id: "b1", data: rows, cached_at: new Date(at).toISOString() });
const payOrder = (over: Partial<OfflineOperation>) => op({ operation_id: "payorder:b", operation_type: "pay_order", payload: { order_id: "SRV-B", order_local: null, method: "cash", currency: "LBP" }, ...over });

test("BUG 3 history precedence matrix: pending local > older snapshot; synced-after > snapshot; synced-before = snapshot; refused never Paid", async () => {
  const T = Date.now() - 60_000;
  const cases: [string, Partial<OfflineOperation>, string][] = [
    ["pending local settlement vs older snapshot", { status: "pending" }, "paid"],
    ["retryable", { status: "retryable" }, "paid"],
    ["parked behind a prerequisite (not refused)", { status: "needs_attention", last_error_code: "dependency_failed", last_error_message: "x" }, "paid"],
    ["synced AFTER the snapshot was read", { status: "synced", synced_at: new Date(T + 10_000).toISOString() }, "paid"],
    ["synced BEFORE the snapshot was read (the snapshot stands)", { status: "synced", synced_at: new Date(T - 10_000).toISOString() }, "unpaid"],
    ["refused by the server", { status: "needs_attention", last_error_code: "validation", last_error_message: "Order not attached to an open shift" }, "unpaid"],
    ["cancelled", { status: "cancelled" }, "unpaid"],
  ];
  for (const [label, o, expected] of cases) {
    await localdb.operations.clear();
    await snapshot([row({ id: "SRV-B" })], T);
    await localdb.operations.add(payOrder(o));
    const res = await readOrdersHistoryLocal(SHIFT_SCOPE);
    assert.equal(res.orders.find((x) => x.id === "SRV-B")?.payment_status, expected, label);
    // the pure rule agrees
    const prec = settlePrecedence(payOrder(o), T);
    assert.equal(prec === "pending" || prec === "confirmed" ? "paid" : "unpaid", expected, `precedence: ${label}`);
  }
});

test("BUG 3 the overlay applies ONLINE too (read-start freshness), and the snapshot is stamped with the read start", async () => {
  await localdb.operations.add(payOrder({ status: "retryable" }));
  const before = Date.now();
  const online = await loadOrdersHistoryOfflineAware(SHIFT_SCOPE, { reachable: async () => true, loadShift: async () => [row({ id: "SRV-B" }), row({ id: "SRV-C" })] });
  assert.equal(online.offline, false);
  assert.equal(online.orders.find((o) => o.id === "SRV-B")?.payment_status, "paid", "cash taken offline is never shown Open after reconnect");
  assert.equal(online.orders.find((o) => o.id === "SRV-C")?.payment_status, "unpaid");
  const snap = await localdb.snapshots.get("orders:shift:SRV-SHIFT-1");
  assert.ok(Date.parse(snap!.cached_at) <= before + 5 && Date.parse(snap!.cached_at) >= before - 1000, "read-start stamp");
  // a settle that synced BEFORE the read started is the server's own row (the overlay never overrides it)
  await localdb.operations.clear();
  await localdb.operations.add(payOrder({ status: "synced", synced_at: new Date(Date.now() - 60_000).toISOString() }));
  const raw = await loadOrdersHistoryOfflineAware(SHIFT_SCOPE, { reachable: async () => true, loadShift: async () => [row({ id: "SRV-B" })] });
  assert.equal(raw.orders[0].payment_status, "unpaid");
});

test("BUG 3 takeaway cash sales: an unsynced pay part overlays the canonical row; a refused sale never shows Paid", async () => {
  const T = Date.now() - 60_000;
  await snapshot([row({ id: "SRV-T" })], T);
  // submit synced (canonical id recorded mid-replay), the cash pay still retrying
  await localdb.operations.add(op({ operation_id: "mig:txn:T-1", operation_type: "takeaway_sale", local_entity_id: "T-1", canonical_entity_id: "SRV-T", status: "retryable", payload: { order_payload: {}, payment_intent: { method: "cash", currency: "LBP" }, paid: false } }));
  // a send-only sale is never an overlay
  await localdb.operations.add(op({ operation_id: "mig:txn:T-2", operation_type: "takeaway_sale", local_entity_id: "T-2", canonical_entity_id: "SRV-T2", payload: { order_payload: {}, payment_intent: null } }));
  // a local offline sale the server REFUSED
  await localdb.posOfflineTxns.add({ local_txn_id: "T-R", client_op_id: crypto.randomUUID(), tenant_id: "t1", branch_id: "b1", device_id: DEV.device_id, terminal_id: DEV.terminal_id ?? "", cashier_user_id: "u1", cashier_user_name: "M", created_at: new Date().toISOString(), shift_id: "SRV-SHIFT-1", order_payload: { branch_id: "b1", order_type: "takeaway", shift_id: "SRV-SHIFT-1", items: [] }, payment_intent: { method: "cash", currency: "LBP" }, currency: "LBP", total: 10, status: "queued", attempts: 1 } as unknown as PosOfflineTxn);
  await localdb.operations.add(op({ operation_id: "mig:txn:T-R", operation_type: "takeaway_sale", local_entity_id: "T-R", status: "needs_attention", last_error_code: "validation", last_error_message: "Menu item is not available", payload: { order_payload: {}, payment_intent: { method: "cash", currency: "LBP" } } }));
  const res = await readOrdersHistoryLocal(SHIFT_SCOPE);
  const by = new Map(res.orders.map((o) => [o.id, o]));
  assert.equal(by.get("SRV-T")?.payment_status, "paid");
  assert.equal(by.get("T-R")?.payment_status, "unpaid", "a server-refused payment is never shown as Paid");
});

test("BUG 3 an offline-created dine-in order maps local → canonical (entity map): ONE row, Paid while its settle is pending", async () => {
  const T = Date.now() - 60_000;
  const { d } = await settledSession();
  // round 1 synced and resolved the session to its canonical order; the settle is still pending
  await localdb.entityMap.put({ local_entity_id: d.local_session_id, entity_type: "order", canonical_id: "SRV-D", resolved_at: new Date().toISOString(), tenant_id: "t1", branch_id: "b1", device_id: DEV.device_id, cashier_user_id: "u1", terminal_id: DEV.terminal_id ?? null });
  await snapshot([row({ id: "SRV-D", order_type: "dine_in", table_id: "TBL-1" })], T);
  const res = await readOrdersHistoryLocal(SHIFT_SCOPE);
  assert.deepEqual(res.orders.map((o) => o.id), ["SRV-D"], "no duplicate OFF- row beside its canonical order");
  assert.equal(res.orders[0].payment_status, "paid");
  // online too
  const online = await loadOrdersHistoryOfflineAware(SHIFT_SCOPE, { reachable: async () => true, loadShift: async () => [row({ id: "SRV-D", order_type: "dine_in" })] });
  assert.deepEqual(online.orders.map((o) => [o.id, o.payment_status]), [["SRV-D", "paid"]]);
});

test("Delivery shares the rule: a REFUSED pay stops blocking Pay and never shows Paid; an unresolved / parked / already-closed one keeps blocking", () => {
  const drow = { id: "SRV-1", order_number: "N-1", status: "sent_to_kitchen", payment_status: "unpaid", pos_entity_version: 1, shift_id: "SRV-SHIFT-1", branch_id: "b1", discount_amount: 0, currency: "LBP", created_at: new Date().toISOString(), delivery_fee: 0 } as unknown as DeliveryQueueOrder;
  const proj = (o: Partial<OfflineOperation>) => projectDeliveryOrder({ row: drow, txn: null, cachedLines: null, ops: [op({ operation_id: "payorder:1", operation_type: "pay_order", payload: { order_id: "SRV-1", order_local: null, method: "cash", currency: "LBP" }, ...o })], rowFetchedAt: Date.now() - 60_000 });
  const refused = proj({ status: "needs_attention", last_error_code: "validation", last_error_message: "Select a delivery provider before completing this delivery order" });
  assert.equal(refused.settlingOpId, null, "Pay is offered again — the server refused the money");
  assert.equal(refused.row.payment_status, "unpaid");
  assert.equal(refused.attention, 1, "still an attention item");
  for (const o of [{ status: "pending" }, { status: "retryable" }, { status: "needs_attention", last_error_code: "dependency_failed", last_error_message: "x" }, { status: "needs_attention", last_error_code: "settle_conflict", last_error_message: "already paid" }] as Partial<OfflineOperation>[]) {
    assert.equal(proj(o).settlingOpId, "payorder:1", `${o.status} ${o.last_error_code ?? ""} blocks a second payment`);
  }
  assert.equal(proj({ status: "needs_attention", last_error_code: "settle_conflict", last_error_message: "already paid" }).row.payment_status, "unpaid", "already-closed: the server row stands (no claim by this device)");
});

// ================================================================ F1 — part-paid full Pay refused (client mitigation)

const bill = (): TableBill => canonicalBill("o1");
const okResult: TablePaymentResult = { ok: true, orders: 1, subtotal: 355000, discount: 0, amount: 355000, currency_code: "LBP", original_amount: 355000, exchange_rate: null };

test("F1 payTableGate refuses a full Pay of a bill with PAID split settlements (settle the rest via split)", () => {
  const base = { takePayments: { allowed: true, reason: null }, bill: bill(), hasOpenShift: true, online: true, settling: false, branchId: "b1" };
  assert.deepEqual(payTableGate({ ...base, table: occupied({ collected: 740000, outstanding: 300000 }) }), { allowed: false, reason: PART_PAID_FULL_PAY_MESSAGE });
  const partial = bill();
  partial.orders[0].payment_status = "partial";
  assert.equal(payTableGate({ ...base, bill: partial, table: occupied() }).allowed, false);
  assert.deepEqual(payTableGate({ ...base, table: occupied({ collected: 0 }) }), { allowed: true, reason: null }, "an unpaid bill pays as before");
  assert.match(PART_PAID_FULL_PAY_MESSAGE, /settle the remaining items via split/i);
});

test("F1 the authoritative re-read refuses the full charge when a split was paid meanwhile (submit never called)", async () => {
  let submits = 0;
  const outcome = await performTablePayment({
    shownBill: bill(),
    table: occupied(),
    payload: { table_id: "TBL-1", method: "cash", currency_code: "LBP" },
    reReadBill: async () => ({ bill: bill(), table: occupied({ collected: 740000 }) }),
    submit: async () => { submits += 1; return okResult; },
    recoverRead: async () => ({ bill: bill(), table: occupied() }),
    complete: () => undefined,
    refresh: async () => undefined,
  });
  assert.equal(submits, 0);
  assert.equal(outcome.ok, false);
  assert.ok(!outcome.ok && outcome.error instanceof PartPaidBillError && outcome.retryable === false);
});

// ================================================================ F4 — Hush 261024-0045 review (round content)

test("F4 an offline round on a BOUND canonical bill sends ONLY the cart's lines — never an existing canonical line", async () => {
  const d = await openTableOffline({ scope: DSCOPE, tableId: "TBL-1", tableName: "R1/1", seats: 2, currency: "LBP", canonicalOrderId: "ORD-A" });
  await stageUnsentDraftLines(d.local_session_id, [{ menu_item_id: "cr", name: "Cinnamon Roll", base_price: 250000, quantity: 1, modifiers: [], kitchen_note: null }]);
  const sent = await sendRoundOffline(d.local_session_id);
  const r = (await getOperation(sent.rounds[0].operation_id))!;
  const submit = (r.payload as { submit: { items: { name?: string; menu_item_id?: string | null }[]; expected_order_id?: string } }).submit;
  assert.equal(submit.items.length, 1);
  assert.equal(submit.expected_order_id, "ORD-A", "appends to the canonical bill, pinned");
});

test("F4 a Send retried after a failure that followed staging never stages the cart twice (no duplicated items)", async () => {
  const d = await openTableOffline({ scope: DSCOPE, tableId: "TBL-1", tableName: "1", seats: 2, currency: "LBP", canonicalOrderId: "ORD-A" });
  const latte = { menu_item_id: "ivl", name: "Iced Vanilla Latte", base_price: 250000, quantity: 1, modifiers: [], kitchen_note: null };
  const roll = { menu_item_id: "cr", name: "Cinnamon Roll", base_price: 250000, quantity: 1, modifiers: [], kitchen_note: null };
  await stageUnsentDraftLines(d.local_session_id, [latte]); // …then the send failed; the cart still holds the latte
  await stageUnsentDraftLines(d.local_session_id, [latte, roll]); // retry with the roll added
  const sent = await sendRoundOffline(d.local_session_id);
  assert.deepEqual(sent.lines.map((l) => l.name).sort(), ["Cinnamon Roll", "Iced Vanilla Latte"]);
  const r = (await getOperation(sent.rounds[0].operation_id))!;
  assert.equal((r.payload as { submit: { items: unknown[] } }).submit.items.length, 2);
  // a SENT line is never touched by a later staging
  await stageUnsentDraftLines(d.local_session_id, []);
  assert.equal((await localdb.dineDrafts.get(d.local_session_id))?.lines.length, 2);
  assert.match(src("src/screens/pos/DineInWorkspace.tsx"), /await stageUnsentDraftLines\(draft\.local_session_id, submitted\.map\(draftLineFromCart\)\);/);
});
