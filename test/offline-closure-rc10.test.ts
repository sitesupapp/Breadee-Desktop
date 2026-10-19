// rc.10 — FINAL CLOSURE RECOVERY: behavioural tests at the level the rc.9 native run exercised
// (real Dexie via fake-indexeddb, the REAL stores — shift, cart — the REAL capture engines, the REAL
// single orchestrator + handlers; only server RPCs are injected).
//
//   S  Dine-In local settlement + immediate table reuse (F1, A1–A3, H1)
//   P  Partial / On-Account offline identity (F2)
//   V  Delivery create + edit before canonical remap (F3, D1–D3)
//   E  Normal End Shift offline: no server call, barrier, replays last, never resurrected (F4, E/E1)
//   A  Offline cold-start authority: restore / expired / mirror / transport classification (F5, F1–F3)
//   L  Cart-lock lifecycle (F6, G1–G2)
//   Q  Queue forensics + historical recovery + second-drain idempotency (F8, F10, I/I1/K)

import "fake-indexeddb/auto";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? (this.m.get(k) as string) : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
(globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage();

import { localdb, cacheBill, type PosOfflineTxn } from "@/lib/offline/db";
import { getOperation, listOperations, normalizeCustomerRef, isOfflineCreatedAddress, type OfflineOperation } from "@/lib/offline/operationLog";
import { drainOffline, __resetDrainLockForTests } from "@/lib/offline/orchestrator";
import type { PosTxnSyncDeps } from "@/lib/offline/posTxnSync";
import {
  openTableOffline,
  addDraftLine,
  sendRoundOffline,
  settleTableOffline,
  tableOnAccountOffline,
  getDineDraftForTable,
} from "@/lib/offline/dineinOffline";
import { getOperationalTableBill, getOperationalTableTotals, overlayTableTotals, getOperationalOrderProjection, editTargetFor } from "@/lib/offline/operationalProjection";
import { captureEditOrderLineOffline } from "@/lib/offline/itemEditOffline";
import { orderOnAccountOffline } from "@/lib/offline/orderOnAccountOffline";
import { captureCustomerUpsertOffline } from "@/lib/offline/customerOffline";
import { buildSetQuantityPayload } from "@/lib/pos/orders";
import { foldBill } from "@/lib/pos/tableBill";
import { useShift, shiftNet } from "@/state/shift";
import { savePosSessionSnapshot, clearPosSessionSnapshot } from "@/lib/offline/posSession";
import { getDeviceIdentity } from "@/lib/device";
import { createLocalPendingShift } from "@/lib/offline/pendingShift";
import {
  decideOfflineAuthority,
  readAuthorityCache,
  writeAuthorityCache,
  clearAuthorityCache,
  isAuthTransportError,
  OFFLINE_AUTH_TTL_MS,
  CONTEXT_CACHE_KEY,
  type AuthorityCache,
} from "@/lib/offline/offlineAuthority";
import { useCart } from "@/state/cart";
import { classifyOperation, recoverHistoricalReplayFailures, buildDiagnostic } from "@/lib/offline/queueForensics";
import type { BillOrder, TableSummary } from "@/types/tables";
import type { DeliveryQueueOrder } from "@/lib/pos/deliveryOrderManagement";

const DEVICE = getDeviceIdentity().device_id;
const TERMINAL = getDeviceIdentity().terminal_id ?? null;
const DSCOPE = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1", shiftId: "sh1" };
const PSCOPE = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1" };
const CTX = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1", online: true };

beforeEach(async () => {
  await Promise.all([
    localdb.operations.clear(), localdb.entityMap.clear(), localdb.syncHistory.clear(), localdb.dineDrafts.clear(),
    localdb.snapshots.clear(), localdb.posOfflineTxns.clear(), localdb.pendingShifts.clear(), localdb.posCustomers.clear(),
  ]);
  __resetDrainLockForTests();
  useCart.getState().reset();
  clearPosSessionSnapshot();
  useShift.getState().clear();
  shiftNet.findOpenShift = async () => null;
});

type Call = { name: string; arg: unknown };
function deps(calls: Call[], over: Partial<PosTxnSyncDeps> = {}): PosTxnSyncDeps {
  let rounds = 0;
  const d = {
    submit: async (p: unknown) => { calls.push({ name: "submit", arg: p }); return { order_id: "SRV-DEL", order_number: "D-1" }; },
    pay: async () => ({}),
    openShift: async () => ({ shiftId: "SRV-SHIFT", reused: false }),
    openTable: async (p: unknown) => { calls.push({ name: "open", arg: p }); return { table_id: "TBL-1", pos_entity_version: 4 }; },
    submitRound: async (p: unknown) => { calls.push({ name: "round", arg: p }); rounds += 1; return { order_id: rounds <= 1 ? "ORD-A" : "ORD-B", order_number: "N", batch_no: 1, appended: true, idempotent: false }; },
    orderItemMap: async () => MAP.slice(),
    payTable: async (a: unknown) => { calls.push({ name: "pay_table", arg: a }); return { ok: true, amount: 1, idempotent: false, pos_entity_version: 9 }; },
    payOrderOp: async (a: { orderId: string }) => { calls.push({ name: "pay_order", arg: a }); return { order_id: a.orderId, paid: true, amount: 1, idempotent: false }; },
    onAccountTable: async (a: unknown) => { calls.push({ name: "on_account_table", arg: a }); return { ok: true, idempotent: false }; },
    onAccountOrder: async (a: unknown) => { calls.push({ name: "on_account_order", arg: a }); return { ok: true, idempotent: false }; },
    upsertCustomer: async () => { calls.push({ name: "customer", arg: null }); return { customer_id: "SRV-CUST", address_id: "SRV-ADDR", is_new: true }; },
    editOrderLine: async (a: { payload: Record<string, unknown> }) => { calls.push({ name: "edit", arg: a.payload }); return { ok: true, idempotent: false, replacement_order_item_id: "REPL", pos_entity_version: Number(a.payload.expected_version) + 1 }; },
    endShiftOp: async (a: { shiftId: string }) => { calls.push({ name: "end_shift", arg: a }); return { shift_id: a.shiftId, idempotent: false }; },
    isTransport: (e: unknown) => e instanceof TypeError,
    hasSession: async () => true,
    ...over,
  };
  return d as unknown as PosTxnSyncDeps;
}
let MAP: { client_line_id: string; order_item_id: string }[] = [];

function mapRow(over: Partial<TableSummary> = {}): TableSummary {
  return { id: "TBL-1", name: "Table 1", seats: 4, occupied: true, status: "occupied", canonical: true, configured: true, sort_order: 1, orders: 1, order_number: "261015-0010", opened_at: "2026-10-18T08:00:00.000Z", total: 1_800_000, collected: 0, outstanding: 1_800_000, currency: "LBP", mixed_currency: false, pos_entity_version: 3, ...over };
}
function canon(): BillOrder {
  return { id: "ORD-C", order_number: "261015-0010", status: "sent_to_kitchen", payment_status: "unpaid", pos_entity_version: 5, shift_id: "sh1", branch_id: "b1", tenant_id: "t1", subtotal: 1_800_000, discount_amount: 0, total_amount: 1_800_000, currency: "LBP", exchange_rate: null, created_at: "2026-10-18T08:00:00.000Z",
    lines: [{ id: "IT-1", menu_item_id: "m1", name: "Pizza", quantity: 2, base_price: 900_000, modifiers_total: 0, final_unit_price: 900_000, line_total: 1_800_000, kitchen_note: null, batch_no: 1, modifiers: [] }] };
}
async function occupiedWithOfflineRound() {
  await cacheBill("TBL-1", foldBill("TBL-1", [canon()]), "t1", "b1", Date.now() - 60_000);
  const d = await openTableOffline({ scope: DSCOPE, tableId: "TBL-1", tableName: "Table 1", seats: 4, currency: "LBP", baseOrderVersion: 3, canonicalOrderId: "ORD-C" });
  await addDraftLine(d.local_session_id, { menu_item_id: "m9", name: "Mixed Grill", base_price: 2_500_000, quantity: 2, modifiers: [{ group_id: "g", option_id: "o", name: "Extra", price_delta: 227_500, quantity: 1 }], kitchen_note: null });
  return sendRoundOffline(d.local_session_id);
}
const bill = (row: TableSummary = mapRow()) => getOperationalTableBill(PSCOPE, row);

// ================================================================ S — settlement + table reuse

test("S1 total invariant before pay: 1,800,000 + 5,455,000 = 7,255,000 on card, detail, payment base", async () => {
  await occupiedWithOfflineRound();
  const p = await bill();
  assert.equal(p.gross, 7_255_000);
  assert.equal(p.outstanding, 7_255_000);
  const [card] = overlayTableTotals([mapRow()], await getOperationalTableTotals(PSCOPE, [mapRow()]));
  assert.equal(card.total, 7_255_000);
});

test("S2 full offline pay CLOSES the active bill: table available, session settled (kept), never re-attached", async () => {
  const d = await occupiedWithOfflineRound();
  const before = await bill();
  await settleTableOffline({ sessionId: d.local_session_id, table: { scope: DSCOPE, tableId: "TBL-1", tableName: "Table 1", currency: "LBP", orderIds: ["ORD-C"] }, method: "cash", extraDependencyIds: before.mutationOpIds, covers: { orderIds: ["ORD-C"], summary: false } });
  const after = await bill();
  assert.equal(after.bill.orders.length, 0, "the paid bill is no longer the table's active bill");
  assert.equal(after.settledLocally, true);
  const [card] = overlayTableTotals([mapRow()], await getOperationalTableTotals(PSCOPE, [mapRow()]));
  assert.equal(card.status, "available");
  assert.equal(card.orders, 0);
  assert.equal(card.total, null);
  const kept = await localdb.dineDrafts.get(d.local_session_id);
  assert.equal(kept?.status, "settled", "history preserved (lines, rounds, settle op)");
  assert.equal(kept?.rounds.length, 1);
  assert.equal(await getDineDraftForTable(DSCOPE, "TBL-1"), null, "a new order never re-attaches to the paid session");
});

test("S3 IMMEDIATE table reuse: new session chains after the settle; old + new bills stay distinct", async () => {
  const d = await occupiedWithOfflineRound();
  const p0 = await bill();
  const s = await settleTableOffline({ sessionId: d.local_session_id, method: "cash", extraDependencyIds: p0.mutationOpIds, covers: { orderIds: ["ORD-C"], summary: false } });
  const p1 = await bill();
  assert.equal(p1.settlingOpId, s.operationId);
  const nd = await openTableOffline({ scope: DSCOPE, tableId: "TBL-1", tableName: "Table 1", seats: 2, currency: "LBP", baseOrderVersion: 3, afterSettleOpId: p1.settlingOpId });
  assert.notEqual(nd.local_session_id, d.local_session_id, "a NEW local session/order id");
  const open = await getOperation(nd.open_operation_id);
  assert.deepEqual(open?.dependency_ids, [s.operationId]);
  assert.equal((open?.payload as { version_after_op: string }).version_after_op, s.operationId);
  await addDraftLine(nd.local_session_id, { menu_item_id: "m2", name: "Soup", base_price: 300_000, quantity: 1, modifiers: [], kitchen_note: null });
  await sendRoundOffline(nd.local_session_id);
  const p2 = await bill();
  assert.equal(p2.gross, 300_000, "only the NEW bill is active");
  assert.equal(p2.bill.orders.length, 1);
  // reconnect: old bill settles exactly once, then the new bill opens + appends — never one bill
  const calls: Call[] = [];
  const r = await drainOffline(CTX, "reconnect", deps(calls));
  const names = calls.map((c) => c.name);
  assert.deepEqual(names, ["open", "round", "pay_table", "open", "round"]);
  assert.equal((calls[3].arg as { expected_version: number }).expected_version, 9, "the reopen's CAS = the settle's returned table version");
  assert.equal(r.needsAttention.length, 0);
  // second network flap: zero additional business effects
  const again: Call[] = [];
  await drainOffline(CTX, "reconnect", deps(again));
  assert.equal(again.length, 0);
});

test("S4 rc.9 legacy data: a settled-but-still-open draft is repaired (closed, kept) and the table is free", async () => {
  const d = await occupiedWithOfflineRound();
  // rc.9 capture: no covers, draft left open
  const s = await settleTableOffline({ sessionId: d.local_session_id, method: "cash" });
  await localdb.dineDrafts.update(d.local_session_id, { status: "open", settled_operation_id: null });
  await localdb.operations.update(s.operationId, { payload: { ...(await getOperation(s.operationId))!.payload as object, covers: undefined } });
  const p = await bill();
  assert.equal(p.bill.orders.length, 0);
  assert.equal(await getDineDraftForTable(DSCOPE, "TBL-1"), null);
  assert.equal((await localdb.dineDrafts.get(d.local_session_id))?.status, "settled");
});

test("S5 canonical-only table (no offline round) settled offline → available; on-account (partial) also closes the table", async () => {
  await cacheBill("TBL-1", foldBill("TBL-1", [canon()]), "t1", "b1", Date.now() - 1000);
  const target = { scope: DSCOPE, tableId: "TBL-1", tableName: "Table 1", currency: "LBP", orderIds: ["ORD-C"] };
  await tableOnAccountOffline({ sessionId: null, table: target, customerId: "CUST-1", amount: 500_000, method: "cash", covers: { orderIds: ["ORD-C"], summary: false } });
  const p = await bill();
  assert.equal(p.bill.orders.length, 0);
  assert.equal(p.settledLocally, true);
});

// ================================================================ P — partial / on-account identity

test("P1 an OFFLINE-CREATED customer travels as customer_local (waits for + remaps on replay)", async () => {
  const c = await captureCustomerUpsertOffline({ scope: PSCOPE, upsert: { branch_id: "b1", name: "Walk-in", phone: "70000001" }, clientOpId: "c1c1c1c1-0000-4000-8000-000000000001" } as never);
  const local = (c as { localCustomerId: string }).localCustomerId;
  assert.deepEqual(await normalizeCustomerRef(local, null), { customerId: null, customerLocal: local });
  assert.deepEqual(await normalizeCustomerRef("CANON-1", null), { customerId: "CANON-1", customerLocal: null });
  const cap = await orderOnAccountOffline({ scope: PSCOPE, orderId: "ORD-9", orderLocal: null, migOpId: null, customerId: local, amount: 100, method: "cash" });
  const op = await getOperation(cap.operationId);
  assert.equal((op?.payload as { customer_id: unknown }).customer_id, null);
  assert.equal((op?.payload as { customer_local: unknown }).customer_local, local);
  assert.ok(op?.depends_on_local_entities.includes(local));
});

// ================================================================ V — Delivery create + edit before remap

test("V1 OFF-* order edited BEFORE its canonical order exists → replays after submit against the canonical id", async () => {
  await localdb.posOfflineTxns.add({
    local_txn_id: "LOCAL-1", client_op_id: "11111111-1111-4111-8111-111111111111", tenant_id: "t1", branch_id: "b1", device_id: "dev1", terminal_id: "term1", cashier_user_id: "u1", cashier_user_name: "A", shift_id: "sh1", created_at: "2026-10-18T09:00:00.000Z",
    order_payload: { branch_id: "b1", order_type: "delivery", status: "sent_to_kitchen", shift_id: "sh1", client_op_id: "11111111-1111-4111-8111-111111111111", notes: null, customer_id: "c1", address_id: "a1", items: [{ menu_item_id: "mA", name: "Shawarma", base_price: 300_000, quantity: 2, kitchen_note: null, modifiers: [], client_line_id: "aaaaaaaa-0000-4000-8000-000000000001" }] },
    payment_intent: null, sent_to_kitchen: true, currency: "LBP", total: 600_000, status: "queued", attempts: 0,
  } as PosOfflineTxn);
  const row: DeliveryQueueOrder = { id: "LOCAL-1", order_number: "OFF-LOCAL1", status: "sent_to_kitchen", payment_status: "unpaid", payment_method: null, subtotal: 600_000, discount_amount: null, delivery_fee: 0, total_amount: 600_000, currency: null, customer_id: "c1", address_id: "a1", notes: null, shift_id: "sh1", created_at: "2026-10-18T09:00:00.000Z", pos_entity_version: null };
  const p = await getOperationalOrderProjection(PSCOPE, row);
  const t = editTargetFor(p, "aaaaaaaa-0000-4000-8000-000000000001");
  if (!t.ok) throw new Error(t.reason);
  const cid = crypto.randomUUID();
  await captureEditOrderLineOffline({ scope: PSCOPE, orderId: t.target.orderId, orderLocal: t.target.orderLocal, payload: buildSetQuantityPayload({ orderId: t.target.payloadOrderId, lineId: "aaaaaaaa-0000-4000-8000-000000000001", newQuantity: 1, expectedVersion: t.target.expectedVersion, clientOpId: cid, reason: "r" }) as unknown as Record<string, unknown>, clientOpId: cid, chain: { targetRef: t.target.ref, versionAfterOp: t.target.versionAfterOp, dependencyIds: t.target.dependencyIds } });
  assert.equal((await getOperationalOrderProjection(PSCOPE, row)).row.total_amount, 300_000, "list/detail/pay follow the edit immediately");
  MAP = [{ client_line_id: "aaaaaaaa-0000-4000-8000-000000000001", order_item_id: "SRV-I1" }];
  const calls: Call[] = [];
  const r = await drainOffline(CTX, "reconnect", deps(calls));
  const names = calls.map((c) => c.name);
  assert.ok(names.indexOf("submit") < names.indexOf("edit"), "dependency order: submit, then edit");
  const edit = calls.find((c) => c.name === "edit")?.arg as { order_id: string; target_item_id: string; expected_version: number };
  assert.equal(edit.order_id, "SRV-DEL", "local → canonical order id");
  assert.equal(edit.target_item_id, "SRV-I1", "local line → canonical item id");
  assert.equal(edit.expected_version, 0, "no wrong version");
  assert.equal(r.needsAttention.length, 0);
});

test("V2 an address added OFFLINE is recognised as local (address_local) independently of its customer", async () => {
  await localdb.operations.add({ operation_id: "cu:1", operation_type: "customer_upsert", schema_version: 1, scope: { tenant_id: "t1", branch_id: "b1", device_id: "dev1", terminal_id: "term1", cashier_user_id: "u1" }, created_at: "x", client_op_id: "x", local_entity_id: null, canonical_entity_id: "CANON-C", dependency_ids: [], depends_on_local_entities: [], payload: { upsert: { id: "CANON-C" }, local_address_id: "LOCAL-ADDR" }, status: "pending", retry_count: 0, last_attempt_at: null, last_error_code: null, last_error_message: null, result_meta: null, synced_at: null } as OfflineOperation);
  assert.equal(await isOfflineCreatedAddress("LOCAL-ADDR"), true);
  assert.equal(await isOfflineCreatedAddress("SOME-CANON-ADDR"), false);
});

// ================================================================ E — normal End Shift offline

const SHIFT = { id: "SRV-SHIFT-1", status: "open" as const, opened_at: new Date(Date.now() - 3_600_000).toISOString(), opening_cash_amount: 50, branch_id: "b1" };
const ES_SCOPE = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: DEVICE, terminalId: TERMINAL };

test("E1 End Shift OFFLINE: no server call, durable end_shift captured, shift ended-pending-sync, snapshot cleared", async () => {
  useShift.setState({ shift: SHIFT, pendingLocalId: null, loading: false });
  savePosSessionSnapshot({ version: 1, source: "server", savedAt: Date.now(), device_id: DEVICE, tenant_id: "t1", cashier_user_id: "u1", branch_id: "b1", branch_name: "Main", currency: "USD", shift: SHIFT } as never);
  shiftNet.findOpenShift = async () => { throw new Error("must not be called"); };
  const ended = await useShift.getState().closeOffline({ scope: ES_SCOPE, actualCashCounted: 120, notes: null, deliveryFeeCashTreatment: "included" });
  const op = await getOperation(ended.operationId);
  assert.equal(op?.operation_type, "end_shift");
  assert.equal((op?.payload as { shift_id: string }).shift_id, SHIFT.id);
  assert.equal(useShift.getState().shift, null);
  assert.equal(useShift.getState().endedPendingSync?.operationId, ended.operationId);
});

test("E2 barrier = THIS shift's ops (incl. offline sales staged from posOfflineTxns); an older shift's parked op is excluded", async () => {
  useShift.setState({ shift: SHIFT, pendingLocalId: null, loading: false });
  const sc = { tenant_id: "t1", branch_id: "b1", device_id: DEVICE, terminal_id: TERMINAL ?? "", cashier_user_id: "u1" };
  await localdb.operations.add({ operation_id: "old:na", operation_type: "pay_order", schema_version: 1, scope: sc, created_at: new Date(Date.now() - 86_400_000).toISOString(), client_op_id: "o", local_entity_id: null, canonical_entity_id: null, dependency_ids: [], depends_on_local_entities: [], payload: {}, status: "needs_attention", retry_count: 1, last_attempt_at: null, last_error_code: "settle_conflict", last_error_message: "x", result_meta: null, synced_at: null } as OfflineOperation);
  await localdb.operations.add({ operation_id: "cur:pay", operation_type: "pay_order", schema_version: 1, scope: sc, created_at: new Date().toISOString(), client_op_id: "p", local_entity_id: null, canonical_entity_id: "ORD", dependency_ids: [], depends_on_local_entities: [], payload: { order_id: "ORD", method: "cash", currency: "USD" }, status: "pending", retry_count: 0, last_attempt_at: null, last_error_code: null, last_error_message: null, result_meta: null, synced_at: null } as OfflineOperation);
  await localdb.posOfflineTxns.add({ local_txn_id: "TX-1", client_op_id: "22222222-2222-4222-8222-222222222222", tenant_id: "t1", branch_id: "b1", device_id: DEVICE, terminal_id: TERMINAL ?? "", cashier_user_id: "u1", cashier_user_name: "A", shift_id: SHIFT.id, created_at: new Date().toISOString(), order_payload: { order_type: "takeaway", items: [] }, payment_intent: { method: "cash", currency: "USD" }, sent_to_kitchen: true, currency: "USD", total: 10, status: "queued", attempts: 0 } as PosOfflineTxn);
  const ended = await useShift.getState().closeOffline({ scope: ES_SCOPE, actualCashCounted: 0, notes: null });
  const op = await getOperation(ended.operationId);
  assert.ok(op?.dependency_ids.includes("cur:pay"));
  assert.ok(op?.dependency_ids.includes("mig:txn:TX-1"), "the offline takeaway sale joined the barrier");
  assert.ok(!op?.dependency_ids.includes("old:na"), "an earlier shift's parked op never blocks this close");
});

test("E3 End Shift replays LAST, after the shift's sales; exactly once across two drains", async () => {
  useShift.setState({ shift: SHIFT, pendingLocalId: null, loading: false });
  const sc = { tenant_id: "t1", branch_id: "b1", device_id: DEVICE, terminal_id: TERMINAL ?? "", cashier_user_id: "u1" };
  await localdb.operations.add({ operation_id: "cur:pay", operation_type: "pay_order", schema_version: 1, scope: sc, created_at: new Date().toISOString(), client_op_id: "p", local_entity_id: null, canonical_entity_id: "ORD", dependency_ids: [], depends_on_local_entities: [], payload: { order_id: "ORD", method: "cash", currency: "USD" }, status: "pending", retry_count: 0, last_attempt_at: null, last_error_code: null, last_error_message: null, result_meta: null, synced_at: null } as OfflineOperation);
  await useShift.getState().closeOffline({ scope: ES_SCOPE, actualCashCounted: 0, notes: null });
  const ctx = { ...CTX, deviceId: DEVICE, terminalId: TERMINAL };
  const calls: Call[] = [];
  await drainOffline(ctx, "reconnect", deps(calls));
  assert.deepEqual(calls.map((c) => c.name), ["pay_order", "end_shift"]);
  const again: Call[] = [];
  await drainOffline(ctx, "reconnect", deps(again));
  assert.equal(again.length, 0);
});

test("E4 an ended shift is NEVER resurrected: offline restart (snapshot), pending shift, or a not-yet-synced server read", async () => {
  useShift.setState({ shift: SHIFT, pendingLocalId: null, loading: false });
  savePosSessionSnapshot({ version: 1, source: "server", savedAt: Date.now(), device_id: DEVICE, tenant_id: "t1", cashier_user_id: "u1", branch_id: "b1", branch_name: "Main", currency: "USD", shift: SHIFT } as never);
  await useShift.getState().closeOffline({ scope: ES_SCOPE, actualCashCounted: 0, notes: null });
  // restore the snapshot as if the clear had been lost, then restart offline
  savePosSessionSnapshot({ version: 1, source: "server", savedAt: Date.now(), device_id: DEVICE, tenant_id: "t1", cashier_user_id: "u1", branch_id: "b1", branch_name: "Main", currency: "USD", shift: SHIFT } as never);
  useShift.getState().clear();
  shiftNet.findOpenShift = async () => { throw new TypeError("Failed to fetch"); };
  await useShift.getState().refresh("t1", "u1", "b1");
  assert.equal(useShift.getState().shift, null, "offline restart does not restore the ended shift");
  // back online, the server still reports it open until the close syncs
  shiftNet.findOpenShift = async () => SHIFT;
  await useShift.getState().refresh("t1", "u1", "b1");
  assert.equal(useShift.getState().shift, null, "a not-yet-synced close keeps the shift closed locally");
});

test("E5 an offline-opened (pending) shift can be ended offline; a new offline shift is refused while the close is pending", async () => {
  const pending = await createLocalPendingShift({ tenantId: "t1", branchId: "b1", cashierUserId: "u1", openingCashAmount: 0, currency: "USD" });
  useShift.setState({ shift: { id: pending.local_shift_id, status: "open", opened_at: new Date().toISOString(), opening_cash_amount: 0, branch_id: "b1" }, pendingLocalId: pending.local_shift_id, loading: false });
  const ended = await useShift.getState().closeOffline({ scope: ES_SCOPE, actualCashCounted: 0, notes: null });
  const op = await getOperation(ended.operationId);
  assert.equal((op?.payload as { shift_local: string }).shift_local, pending.local_shift_id);
  shiftNet.findOpenShift = async () => { throw new TypeError("Failed to fetch"); };
  await useShift.getState().refresh("t1", "u1", "b1");
  assert.equal(useShift.getState().shift, null, "the pending shift is not resurrected");
  await assert.rejects(() => useShift.getState().open({ tenantId: "t1", userId: "u1", branchId: "b1", openingCash: 0 }), /still closing/i);
});

// ================================================================ A — offline cold-start authority

const auth = (cachedAt: number): AuthorityCache => ({ userId: "u1", email: "a@b.c", isPlatformUser: false, tenant: { id: "t1" }, membership: { tenant_id: "t1" }, features: { pos: true }, permissions: { "pos.access": true }, currency: { primary: "LBP", rate: 89_500 }, cachedAt });

test("A1 decision: valid → restore; expired → controlled re-auth; missing → none; a backwards clock is never an infinite lease", () => {
  const now = Date.now();
  assert.equal(decideOfflineAuthority(auth(now - 1000), now).kind, "restore");
  assert.equal(decideOfflineAuthority(auth(now - OFFLINE_AUTH_TTL_MS - 1), now).kind, "expired");
  assert.equal(decideOfflineAuthority(null, now).kind, "none");
  assert.equal(decideOfflineAuthority(auth(now + 60_000), now).kind, "expired");
});

test("A2 durable mirror: a lost localStorage copy still restores from IndexedDB; the newer copy wins; sign-out clears both", async () => {
  await writeAuthorityCache(auth(Date.now() - 5000));
  localStorage.removeItem(CONTEXT_CACHE_KEY);
  assert.equal((await readAuthorityCache())?.userId, "u1", "restored from the IndexedDB mirror");
  localStorage.setItem(CONTEXT_CACHE_KEY, JSON.stringify(auth(Date.now() - 999_999)));
  assert.ok(((await readAuthorityCache())?.cachedAt ?? 0) > Date.now() - 10_000, "the fresher mirror wins over a stale local copy");
  await clearAuthorityCache();
  assert.equal(await readAuthorityCache(), null);
});

test("A3 transport classification: AuthRetryableFetchError / TypeError are offline, a wrong password is not", () => {
  assert.equal(isAuthTransportError({ name: "AuthRetryableFetchError", message: "Failed to fetch" }), true);
  assert.equal(isAuthTransportError(new TypeError("Failed to fetch")), true);
  assert.equal(isAuthTransportError({ name: "AuthApiError", message: "Invalid login credentials" }), false);
});

// ================================================================ L — cart-lock lifecycle

test("L1 an EMPTY cart is never 'in use'", () => {
  useCart.getState().claim({ kind: "table", tableId: "T1" });
  assert.equal(useCart.getState().claim({ kind: "takeaway" }), true);
});

test("L2 a DURABLY-saved buffer (offline Send) is released to another context; unsaved work still locks", () => {
  const c = useCart.getState();
  c.claim({ kind: "takeaway" });
  c.addLine({ menuItemId: "m", name: "x", basePrice: 1 });
  assert.equal(useCart.getState().claim({ kind: "table", tableId: "T1" }), false, "unsaved takeaway lines lock the cart");
  useCart.getState().markDurable();
  assert.equal(useCart.getState().claim({ kind: "table", tableId: "T1" }), true, "durably saved → released");
  assert.equal(useCart.getState().lines.length, 0);
  assert.deepEqual(useCart.getState().owner, { kind: "table", tableId: "T1" });
});

test("L3 any edit after the durable save re-arms the lock; releaseIfOwner frees a settled table's leftovers only", () => {
  const c = useCart.getState();
  c.claim({ kind: "takeaway" });
  const k = c.addLine({ menuItemId: "m", name: "x", basePrice: 1 });
  useCart.getState().markDurable();
  useCart.getState().adjustQuantity(k, 1);
  assert.equal(useCart.getState().durable, false);
  assert.equal(useCart.getState().claim({ kind: "table", tableId: "T1" }), false);
  useCart.getState().reset();
  useCart.getState().claim({ kind: "table", tableId: "T7" });
  useCart.getState().addLine({ menuItemId: "m", name: "x", basePrice: 1 });
  assert.equal(useCart.getState().releaseIfOwner({ kind: "table", tableId: "T8" }), false, "another table's work is untouched");
  assert.equal(useCart.getState().releaseIfOwner({ kind: "table", tableId: "T7" }), true);
  assert.equal(useCart.getState().lines.length, 0);
});

// ================================================================ Q — queue forensics + historical recovery

function parked(id: string, type: string, code: string, msg: string, depIds: string[] = [], payload: unknown = {}): OfflineOperation {
  return { operation_id: id, operation_type: type, schema_version: 1, scope: { tenant_id: "t1", branch_id: "b1", device_id: "dev1", terminal_id: "term1", cashier_user_id: "u1" }, created_at: new Date().toISOString(), client_op_id: crypto.randomUUID(), local_entity_id: null, canonical_entity_id: null, dependency_ids: depIds, depends_on_local_entities: [], payload, status: "needs_attention", retry_count: 1, last_attempt_at: null, last_error_code: code, last_error_message: msg, result_meta: null, synced_at: null };
}

test("Q1 classification separates the historical line-id bug, its dependents, expected conflicts and real bugs", () => {
  assert.equal(classifyOperation(parked("a", "dinein_send_round", "validation", 'invalid input syntax for type uuid: "line-3"')).category, "HISTORICAL_LINE_ID_BUG");
  assert.equal(classifyOperation(parked("b", "pay_table", "dependency_failed", "a")).category, "HISTORICAL_DEPENDENT");
  assert.equal(classifyOperation(parked("c", "edit_order_line", "edit_conflict", "VERSION_CONFLICT")).category, "EXPECTED_CONFLICT");
  assert.equal(classifyOperation(parked("d", "x", "unknown_handler", "x@1")).category, "REAL_REPLAY_BUG");
  const rows = buildDiagnostic([parked("e", "pay_table", "settle_conflict", "already paid", [], { secret: "customer data" })], "abc");
  assert.equal(JSON.stringify(rows).includes("customer data"), false, "never exports payloads");
});

test("Q2 historical recovery: the line-N round + its dependent settle re-queue ONCE and replay exactly once; others untouched", async () => {
  const sc = { tenant_id: "t1", branch_id: "b1", device_id: "dev1", terminal_id: "term1", cashier_user_id: "u1" };
  await localdb.operations.add({ operation_id: "open:1", operation_type: "dinein_open_table", schema_version: 1, scope: sc, created_at: "2026-10-17T10:00:00.000Z", client_op_id: crypto.randomUUID(), local_entity_id: "TBL-9", canonical_entity_id: "TBL-9", dependency_ids: [], depends_on_local_entities: [], payload: { name: "9" }, status: "synced", retry_count: 1, last_attempt_at: null, last_error_code: null, last_error_message: null, result_meta: null, synced_at: "2026-10-17T10:01:00.000Z" });
  await localdb.operations.add({ ...parked("round:1", "dinein_send_round", "validation", 'invalid input syntax for type uuid: "line-3"', ["open:1"], { submit: { branch_id: "b1", order_type: "dine_in", status: "sent_to_kitchen", shift_id: "", client_op_id: "r1", notes: null, table_id: "TBL-9", items: [{ menu_item_id: "m", name: "x", base_price: 1, quantity: 1, kitchen_note: null, client_line_id: "line-3", modifiers: [] }] }, table_local: null, session_local: null }), local_entity_id: "SESS-9", created_at: "2026-10-17T10:02:00.000Z" });
  await localdb.operations.add({ ...parked("pay:1", "pay_table", "dependency_failed", "round:1", ["open:1", "round:1"], { table_id: "TBL-9", table_local: null, method: "cash", currency: "LBP" }), created_at: "2026-10-17T10:03:00.000Z" });
  await localdb.operations.add({ ...parked("other:1", "edit_order_line", "edit_conflict", "VERSION_CONFLICT"), created_at: "2026-10-17T10:04:00.000Z" });
  const calls: Call[] = [];
  const r = await drainOffline(CTX, "reconnect", deps(calls));
  assert.deepEqual(calls.map((c) => c.name), ["round", "pay_table"]);
  assert.equal("client_line_id" in ((calls[0].arg as { items: Record<string, unknown>[] }).items[0]), false, "the non-uuid id is stripped");
  assert.equal((await getOperation("other:1"))?.status, "needs_attention", "a genuine conflict is never auto-retried");
  assert.equal(r.needsAttention.filter((n) => n.id !== "other:1").length, 0);
  const again: Call[] = [];
  await drainOffline(CTX, "reconnect", deps(again));
  assert.equal(again.length, 0, "second drain: zero business effects");
  assert.equal((await listOperations()).filter((o) => o.result_meta?.rc10_recovered === true).length, 2);
});

test("Q3 recovery never loops: a recovered op that fails again stays parked for the operator", async () => {
  const sc = { tenant_id: "t1", branch_id: "b1", device_id: "dev1", terminal_id: "term1", cashier_user_id: "u1" };
  await localdb.operations.add({ ...parked("round:2", "dinein_send_round", "validation", 'invalid input syntax for type uuid: "line-1"'), scope: sc, result_meta: { rc10_recovered: true } });
  assert.deepEqual(await recoverHistoricalReplayFailures(), []);
});
