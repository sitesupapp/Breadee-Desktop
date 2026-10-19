// rc.12 — ENGINEERING-GATED CLOSURE: behavioural tests for the six confirmed rc.11 native failures, at the
// level the native run exercised (real Dexie via fake-indexeddb, the REAL shift store, the REAL single
// orchestrator + handlers, the REAL capture engines; only server RPCs are injected).
//
//   S   shift lifecycle: offline End Shift → barrier → close once → Open Shift (no false success)
//   Q   sync dependency graph: close-relevant barrier, non-terminal waiting, diagnostics, retry once
//   D   dine-in shift linkage (root of every "not attached to an open shift" refusal)
//   M/V Move / Merge server-coordinated (explicit, never silent)
//   C   customer identity: offline phone search, restart, sync promotion, no duplicate, On Account reuse

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

import { localdb, cacheDeliveryQueue, type PosOfflineTxn } from "@/lib/offline/db";
import { getOperation, requeueOperation, type OfflineOperation } from "@/lib/offline/operationLog";
import { drainOffline, __resetDrainLockForTests } from "@/lib/offline/orchestrator";
import type { PosTxnSyncDeps } from "@/lib/offline/posTxnSync";
import { useShift, shiftNet, closeStateOf, ShiftStillClosingError, requireOpenShiftId } from "@/state/shift";
import { clearPosSessionSnapshot } from "@/lib/offline/posSession";
import { CLOSE_RELEVANT_TYPES, evaluateCloseBarrier, captureEndShiftOffline } from "@/lib/offline/endShiftOffline";
import { openTableOffline, addDraftLine, sendRoundOffline, resolveShiftRef } from "@/lib/offline/dineinOffline";
import { createLocalPendingShift } from "@/lib/offline/pendingShift";
import { captureCustomerUpsertOffline } from "@/lib/offline/customerOffline";
import { searchCachedCustomers } from "@/lib/offline/customerCache";
import { orderOnAccountOffline } from "@/lib/offline/orderOnAccountOffline";
import { normalizeCustomerRef } from "@/lib/offline/operationLog";
import { buildDiagnostic, classifyOperation, dispositionOf, buildEra, recoverHistoricalReplayFailures, loadSyncCenterRows } from "@/lib/offline/queueForensics";
import { unresolvedOrdersForShift, openOrdersRefusal } from "@/lib/offline/shiftCloseGuard";
import { overlayDeliveryQueue } from "@/lib/offline/operationalProjection";
import { classifyError } from "@/lib/pos/errors";
import { getDeviceIdentity } from "@/lib/device";
import { appendHistory } from "@/lib/offline/syncHistory";
import type { ActiveShift } from "@/types/pos";
import type { DeliveryQueueOrder } from "@/lib/pos/deliveryOrderManagement";

const here = dirname(fileURLToPath(import.meta.url));
const src = (p: string) => readFileSync(resolve(here, "..", p), "utf8");

const DEV = getDeviceIdentity();
const SCOPE = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: DEV.device_id, terminalId: DEV.terminal_id ?? null };
const DSCOPE = { ...SCOPE, shiftId: "SRV-SHIFT-1" };
const OPSCOPE = { tenant_id: "t1", branch_id: "b1", device_id: DEV.device_id, terminal_id: DEV.terminal_id ?? "", cashier_user_id: "u1" };
const CTX = { ...SCOPE, online: true };
const SHIFT: ActiveShift = { id: "SRV-SHIFT-1", status: "open", opened_at: new Date(Date.now() - 3_600_000).toISOString(), opening_cash_amount: 50, branch_id: "b1" } as ActiveShift;

beforeEach(async () => {
  await Promise.all([
    localdb.operations.clear(), localdb.entityMap.clear(), localdb.syncHistory.clear(), localdb.dineDrafts.clear(),
    localdb.snapshots.clear(), localdb.posOfflineTxns.clear(), localdb.pendingShifts.clear(), localdb.posCustomers.clear(),
  ]);
  __resetDrainLockForTests();
  clearPosSessionSnapshot();
  useShift.getState().clear();
  shiftNet.findOpenShift = async () => null;
  shiftNet.getCashBox = async () => null as never;
  shiftNet.reachable = async () => true;
  shiftNet.openShift = async () => { throw new Error("openShift must not be called"); };
});

type Call = { name: string; arg: unknown };
function deps(calls: Call[], over: Partial<PosTxnSyncDeps> = {}): PosTxnSyncDeps {
  return {
    submit: async (p: unknown) => { calls.push({ name: "submit", arg: p }); return { order_id: "SRV-ORD", order_number: "N-1" }; },
    pay: async () => ({}),
    openShift: async () => { calls.push({ name: "open_shift", arg: null }); return { shiftId: "SRV-SHIFT-NEW", reused: false }; },
    openTable: async (p: unknown) => { calls.push({ name: "open_table", arg: p }); return { table_id: "TBL-1", pos_entity_version: 4 }; },
    submitRound: async (p: unknown) => { calls.push({ name: "round", arg: p }); return { order_id: "ORD-A", order_number: "N", batch_no: 1, appended: false, idempotent: false }; },
    orderItemMap: async () => [],
    payTable: async (a: unknown) => { calls.push({ name: "pay_table", arg: a }); return { ok: true, amount: 1, idempotent: false, pos_entity_version: 9 }; },
    payOrderOp: async (a: { orderId: string }) => { calls.push({ name: "pay_order", arg: a }); return { order_id: a.orderId, paid: true, amount: 1, idempotent: false }; },
    onAccountTable: async () => ({ ok: true, idempotent: false }),
    onAccountOrder: async (a: unknown) => { calls.push({ name: "on_account_order", arg: a }); return { ok: true, idempotent: false }; },
    upsertCustomer: async (a: { payload: Record<string, unknown> }) => { calls.push({ name: "customer", arg: a.payload }); return { customer_id: "SRV-CUST", address_id: null, is_new: true }; },
    editOrderLine: async () => ({ ok: true, idempotent: false, replacement_order_item_id: "R", pos_entity_version: 1 }),
    endShiftOp: async (a: { shiftId: string }) => { calls.push({ name: "end_shift", arg: a }); return { shift_id: a.shiftId, idempotent: false }; },
    isTransport: (e: unknown) => e instanceof TypeError,
    hasSession: async () => true,
    ...over,
  } as unknown as PosTxnSyncDeps;
}

function op(over: Partial<OfflineOperation> & Pick<OfflineOperation, "operation_id" | "operation_type">): OfflineOperation {
  return { schema_version: 1, scope: OPSCOPE, created_at: new Date().toISOString(), client_op_id: crypto.randomUUID(), local_entity_id: null, canonical_entity_id: null, dependency_ids: [], depends_on_local_entities: [], payload: {}, status: "pending", retry_count: 0, last_attempt_at: null, last_error_code: null, last_error_message: null, result_meta: null, synced_at: null, ...over } as OfflineOperation;
}

const deliveryRow = (over: Partial<DeliveryQueueOrder> = {}): DeliveryQueueOrder => ({ id: "SRV-D1", order_number: "261019-0006", status: "sent_to_kitchen", payment_status: "unpaid", payment_method: null, subtotal: 1, discount_amount: null, total_amount: 1, currency: "LBP", customer_id: null, address_id: null, notes: null, shift_id: "SRV-SHIFT-1", created_at: new Date().toISOString(), ...over });

// ================================================================ S — shift lifecycle

test("S1 offline End Shift is captured; its barrier holds ONLY close-relevant work of this shift", async () => {
  useShift.setState({ shift: SHIFT, pendingLocalId: null, loading: false });
  await localdb.operations.bulkAdd([
    op({ operation_id: "sale", operation_type: "takeaway_sale" }),
    op({ operation_id: "pay", operation_type: "pay_order" }),
    op({ operation_id: "cust", operation_type: "customer_upsert" }),
    op({ operation_id: "move", operation_type: "move_table" }),
    op({ operation_id: "prov", operation_type: "delivery_set_provider" }),
  ]);
  const ended = await useShift.getState().closeOffline({ scope: SCOPE, actualCashCounted: 100, notes: null });
  const end = await getOperation(ended.operationId);
  assert.deepEqual([...(end?.dependency_ids ?? [])].sort(), ["pay", "sale"]);
  assert.equal(useShift.getState().shift, null);
  assert.equal(closeStateOf(end), "closing");
  for (const t of ["takeaway_sale", "pay_table", "pay_order", "split_settle", "on_account_order", "void_refund", "payout", "dinein_send_round"]) assert.ok(CLOSE_RELEVANT_TYPES.has(t), t);
  for (const t of ["customer_upsert", "move_table", "merge_tables", "delivery_ops", "delivery_set_provider", "edit_order"]) assert.ok(!CLOSE_RELEVANT_TYPES.has(t), t);
});

test("S1b offline End Shift with an OPEN bill of this shift is refused up-front with the server's own rule", async () => {
  useShift.setState({ shift: SHIFT, pendingLocalId: null, loading: false });
  const d = await openTableOffline({ scope: DSCOPE, tableId: "TBL-3", tableName: "3", seats: 4, currency: "LBP" });
  await addDraftLine(d.local_session_id, { menu_item_id: "m", name: "Pizza", base_price: 100, quantity: 1, modifiers: [], kitchen_note: null });
  await sendRoundOffline(d.local_session_id);
  await cacheDeliveryQueue([deliveryRow()], "t1", "b1", "SRV-SHIFT-1");
  await assert.rejects(useShift.getState().closeOffline({ scope: SCOPE, actualCashCounted: 1, notes: null }), (e: Error) => {
    assert.match(e.message, /Cannot close this shift: 2 order\(s\) still open \(.*Delivery #261019-0006.*Table 3.*\)/);
    assert.equal(classifyError(e).kind, "open_orders_block", "the existing End-Shift UI path applies");
    return true;
  });
  assert.equal(useShift.getState().shift?.id, "SRV-SHIFT-1", "nothing captured, the shift stays open");
  assert.equal((await localdb.operations.where("operation_type").equals("end_shift").toArray()).length, 0);
});

test("S1c a delivery settled LOCALLY (pay pending sync) and another shift's orders do not block the close", async () => {
  await cacheDeliveryQueue([deliveryRow(), deliveryRow({ id: "SRV-OTHER", shift_id: "OTHER-SHIFT" })], "t1", "b1", "SRV-SHIFT-1");
  await localdb.operations.add(op({ operation_id: "payorder:x", operation_type: "pay_order", payload: { order_id: "SRV-D1", order_local: null, method: "cash", currency: "LBP" } }));
  assert.deepEqual(await unresolvedOrdersForShift(SCOPE, "SRV-SHIFT-1"), []);
  assert.match(openOrdersRefusal([{ kind: "delivery", label: "Delivery #1" }]), /1 order\(s\) still open/);
});

test("S2/S3/Q4 the close replays LAST, exactly once; a second reconnect performs zero business effects", async () => {
  useShift.setState({ shift: SHIFT, pendingLocalId: null, loading: false });
  await localdb.posOfflineTxns.add({ local_txn_id: "T1", client_op_id: crypto.randomUUID(), tenant_id: "t1", branch_id: "b1", device_id: DEV.device_id, terminal_id: DEV.terminal_id ?? "", cashier_user_id: "u1", cashier_user_name: "A", shift_id: "SRV-SHIFT-1", created_at: new Date().toISOString(), order_payload: { branch_id: "b1", order_type: "takeaway", shift_id: "SRV-SHIFT-1", items: [] }, payment_intent: null, currency: "LBP", total: 1, status: "queued", attempts: 0 } as PosOfflineTxn);
  await useShift.getState().closeOffline({ scope: SCOPE, actualCashCounted: 100, notes: null });
  const calls: Call[] = [];
  await drainOffline(CTX, "reconnect", deps(calls));
  assert.deepEqual(calls.map((c) => c.name), ["submit", "end_shift"]);
  const again: Call[] = [];
  await drainOffline(CTX, "reconnect", deps(again));
  assert.equal(again.length, 0);
});

test("Q1/S2 a PARKED close-relevant prerequisite makes the close WAIT (non-terminal, named) — then it closes once the operator resolves it", async () => {
  await localdb.operations.add(op({ operation_id: "pay", operation_type: "pay_table", status: "needs_attention", last_error_code: "validation", last_error_message: "refused", payload: { table_id: "TBL-1", table_local: null, method: "cash", currency: "LBP" } }));
  await localdb.operations.add(op({ operation_id: "endshift:1", operation_type: "end_shift", dependency_ids: ["pay"], payload: { shift_id: "SRV-SHIFT-1", shift_local: null, actual_cash_counted: 1, notes: null } }));
  const calls: Call[] = [];
  await drainOffline(CTX, "reconnect", deps(calls));
  const end = await getOperation("endshift:1");
  assert.equal(end?.status, "blocked_dependency", "never TERMINAL 'a prerequisite could not be completed'");
  assert.equal(end?.last_error_code, "awaiting_parked_prerequisite");
  assert.equal(end?.last_error_message, "pay");
  assert.equal(calls.length, 0);
  // Q3 — the operator retries the parked payment: it replays ONCE, and the close follows automatically.
  await requeueOperation("pay");
  const after: Call[] = [];
  await drainOffline(CTX, "reconnect", deps(after));
  assert.deepEqual(after.map((c) => c.name), ["pay_table", "end_shift"]);
  const third: Call[] = [];
  await drainOffline(CTX, "reconnect", deps(third));
  assert.equal(third.length, 0, "safe retry executed once");
});

test("Q1 a parked NON-close-relevant op (customer edit / table move) never holds the close", async () => {
  await localdb.operations.add(op({ operation_id: "cust", operation_type: "customer_upsert", status: "needs_attention", last_error_code: "permission", last_error_message: "Customer not found for this operating unit" }));
  await localdb.operations.add(op({ operation_id: "mv", operation_type: "move_table", status: "needs_attention", last_error_code: "validation", last_error_message: "The destination table already has an open order" }));
  await localdb.operations.add(op({ operation_id: "endshift:2", operation_type: "end_shift", dependency_ids: ["cust", "mv"], payload: { shift_id: "SRV-SHIFT-1", shift_local: null, actual_cash_counted: 1, notes: null } }));
  assert.deepEqual(evaluateCloseBarrier((await getOperation("endshift:2"))!, new Map((await localdb.operations.toArray()).map((o) => [o.operation_id, o]))), { ready: true });
  const calls: Call[] = [];
  await drainOffline(CTX, "reconnect", deps(calls));
  assert.deepEqual(calls.map((c) => c.name), ["end_shift"]);
  assert.equal((await getOperation("endshift:2"))?.status, "synced");
});

test("Q2 a blocked End Shift exposes its exact dependency chain (type, state, reason) in the diagnostic", async () => {
  const pay = op({ operation_id: "payorder:abc", operation_type: "pay_order", status: "needs_attention", last_error_code: "settle_conflict", last_error_message: "Select a delivery provider before completing this delivery order" });
  const end = op({ operation_id: "endshift:3", operation_type: "end_shift", status: "blocked_dependency", last_error_code: "awaiting_parked_prerequisite", dependency_ids: ["payorder:abc"], payload: { shift_id: "SRV-SHIFT-1" } });
  const [row] = buildDiagnostic([end], "build-x", { allOps: [pay, end] });
  assert.deepEqual(row.depends_on, [{ op: "payorder:abc", type: "pay_order", status: "needs_attention" }]);
  assert.match(row.blocking ?? "", /waiting for: pay_order payorder:abc is needs_attention \(Select a delivery provider/);
  assert.equal(row.shift, "SRV-SHIFT-1");
  assert.equal(row.ou, "b1");
});

test("S2 recovery: an End Shift rc.10/rc.11 made TERMINAL (dependency_failed) is re-queued ONCE and closes after its work", async () => {
  await localdb.operations.add(op({ operation_id: "sale2", operation_type: "takeaway_sale", status: "synced", synced_at: new Date().toISOString() }));
  await localdb.operations.add(op({ operation_id: "endshift:4", operation_type: "end_shift", status: "needs_attention", last_error_code: "dependency_failed", last_error_message: "x", dependency_ids: ["sale2"], payload: { shift_id: "SRV-SHIFT-1", shift_local: null, actual_cash_counted: 1, notes: null } }));
  assert.equal(closeStateOf(await getOperation("endshift:4")), "closing", "a never-sent close is still CLOSING, not refused");
  assert.deepEqual(await recoverHistoricalReplayFailures(), ["endshift:4"]);
  const calls: Call[] = [];
  await drainOffline(CTX, "reconnect", deps(calls));
  assert.deepEqual(calls.map((c) => c.name), ["end_shift"]);
  assert.deepEqual(await recoverHistoricalReplayFailures(), [], "never twice");
});

test("F1 Open Shift while the previous close is still CLOSING is refused BEFORE the server is called (never the old shift)", async () => {
  await localdb.operations.add(op({ operation_id: "endshift:5", operation_type: "end_shift", status: "blocked_dependency", dependency_ids: [], payload: { shift_id: "OLD" } }));
  let called = false;
  shiftNet.openShift = async () => { called = true; return { shiftId: "OLD" }; };
  await assert.rejects(useShift.getState().open({ tenantId: "t1", userId: "u1", branchId: "b1", openingCash: 0 }), ShiftStillClosingError);
  assert.equal(called, false, "pos_open_shift would have handed back the OLD shift");
});

test("S4/S5/S6/S7 after the close syncs, Open Shift creates ONE new shift, commits it locally, and the POS accepts orders", async () => {
  await localdb.operations.add(op({ operation_id: "endshift:6", operation_type: "end_shift", status: "synced", synced_at: new Date().toISOString(), payload: { shift_id: "OLD" } }));
  assert.equal(closeStateOf(await getOperation("endshift:6")), "closed_confirmed");
  let opened = 0;
  const NEW: ActiveShift = { ...SHIFT, id: "NEW-SHIFT" };
  shiftNet.openShift = async () => { opened++; return { shiftId: "NEW-SHIFT" }; };
  shiftNet.findOpenShift = async () => (opened > 0 ? NEW : null);
  const r = await useShift.getState().open({ tenantId: "t1", userId: "u1", branchId: "b1", openingCash: 0 });
  assert.equal(opened, 1, "one canonical open");
  assert.deepEqual(r, { continuedPrevious: false });
  assert.equal(useShift.getState().shift?.id, "NEW-SHIFT");
  assert.equal(requireOpenShiftId(useShift.getState().shift), "NEW-SHIFT", "the order paths accept the new shift immediately");
  // S8 — a restart (fresh store) reads the SAME open shift.
  useShift.getState().clear();
  await useShift.getState().refresh("t1", "u1", "b1");
  assert.equal(useShift.getState().shift?.id, "NEW-SHIFT");
});

test("F1 SUCCESS means committed: a server open the device cannot activate is an error, never a false success", async () => {
  shiftNet.openShift = async () => ({ shiftId: "NEW-SHIFT" });
  shiftNet.findOpenShift = async () => null; // the device never sees it
  await assert.rejects(useShift.getState().open({ tenantId: "t1", userId: "u1", branchId: "b1", openingCash: 0 }), /could not activate it/);
  assert.equal(useShift.getState().shift, null);
});

test("F1 a close the SERVER refused (orders still open) re-opens the shift with the reason — never hidden, never replayed later", async () => {
  const OLD: ActiveShift = { ...SHIFT, id: "OLD" };
  await localdb.operations.add(op({ operation_id: "endshift:7", operation_type: "end_shift", status: "needs_attention", last_error_code: "validation", last_error_message: "Cannot close this shift: 2 order(s) still open. Resolve them before ending the shift.", payload: { shift_id: "OLD" } }));
  shiftNet.openShift = async () => ({ shiftId: "OLD" });
  shiftNet.findOpenShift = async () => OLD;
  const r = await useShift.getState().open({ tenantId: "t1", userId: "u1", branchId: "b1", openingCash: 0 });
  assert.deepEqual(r, { continuedPrevious: true }, "the UI never says 'Shift opened' for the old shift");
  assert.equal(useShift.getState().shift?.id, "OLD");
  assert.match(useShift.getState().closeRefused?.message ?? "", /still open/);
  const end = await getOperation("endshift:7");
  assert.equal(end?.status, "cancelled", "the refused close is superseded (kept for audit)");
  assert.equal(end?.result_meta?.superseded, "close_refused_shift_still_open");
});

test("F1 a refused close of a shift the server NO LONGER has open is superseded on the next server read — it never blocks a later Open Shift", async () => {
  await localdb.operations.add(op({ operation_id: "endshift:8", operation_type: "end_shift", status: "needs_attention", last_error_code: "shift_closed", last_error_message: "This shift is already closed.", payload: { shift_id: "FORCE-ENDED" } }));
  shiftNet.findOpenShift = async () => null;
  await useShift.getState().refresh("t1", "u1", "b1");
  assert.equal((await getOperation("endshift:8"))?.status, "cancelled");
  assert.equal((await getOperation("endshift:8"))?.result_meta?.superseded, "close_refused_shift_not_open_on_server");
  // …so an offline Open Shift is no longer refused by it.
  shiftNet.reachable = async () => false;
  await useShift.getState().open({ tenantId: "t1", userId: "u1", branchId: "b1", openingCash: 0 });
  assert.ok(useShift.getState().pendingLocalId, "opened offline (pending shift)");
});

test("S10 a server permission refusal surfaces as-is (no offline fallback, nothing captured)", async () => {
  shiftNet.openShift = async () => { throw new Error("You do not have permission to open a shift"); };
  await assert.rejects(useShift.getState().open({ tenantId: "t1", userId: "u1", branchId: "b1", openingCash: 0 }), /permission to open a shift/);
  assert.equal(await localdb.pendingShifts.count(), 0);
});

// ================================================================ D — dine-in shift linkage

test("D1 an offline dine-in round now carries the SHIFT (canonical) — never the shift-less order of rc.4–rc.11", async () => {
  const d = await openTableOffline({ scope: DSCOPE, tableId: "TBL-1", tableName: "1", seats: 4, currency: "LBP" });
  assert.equal(d.shift_id, "SRV-SHIFT-1");
  await addDraftLine(d.local_session_id, { menu_item_id: "m", name: "Soup", base_price: 100, quantity: 1, modifiers: [], kitchen_note: null });
  const s = await sendRoundOffline(d.local_session_id);
  const round = await getOperation(s.rounds[0].operation_id);
  assert.equal((round?.payload as { submit: { shift_id: string } }).submit.shift_id, "SRV-SHIFT-1");
  const calls: Call[] = [];
  await drainOffline(CTX, "reconnect", deps(calls));
  assert.equal((calls.find((c) => c.name === "round")?.arg as { shift_id: string }).shift_id, "SRV-SHIFT-1");
});

test("D2 a round on a shift opened OFFLINE waits for that shift and is created on its CANONICAL id", async () => {
  const pending = await createLocalPendingShift({ tenantId: "t1", branchId: "b1", cashierUserId: "u1", openingCashAmount: 0, currency: "LBP" });
  assert.deepEqual(await resolveShiftRef(pending.local_shift_id), { shift_id: null, shift_local: pending.local_shift_id });
  const d = await openTableOffline({ scope: { ...SCOPE, shiftId: pending.local_shift_id }, tableId: "TBL-2", tableName: "2", seats: 2, currency: "LBP" });
  await addDraftLine(d.local_session_id, { menu_item_id: "m", name: "Tea", base_price: 10, quantity: 1, modifiers: [], kitchen_note: null });
  const s = await sendRoundOffline(d.local_session_id);
  const round = await getOperation(s.rounds[0].operation_id);
  assert.ok(round?.depends_on_local_entities.includes(pending.local_shift_id));
  const calls: Call[] = [];
  await drainOffline(CTX, "reconnect", deps(calls));
  const names = calls.map((c) => c.name);
  assert.ok(names.indexOf("open_shift") < names.indexOf("round"));
  assert.equal((calls.find((c) => c.name === "round")?.arg as { shift_id: string }).shift_id, "SRV-SHIFT-NEW");
});

test("D3 the server refusal of a pre-rc.12 shift-less order is classified (MANUAL_REVIEW), never auto-retried", async () => {
  const pay = op({ operation_id: "pt", operation_type: "pay_table", status: "needs_attention", last_error_code: "validation", last_error_message: "This order is not attached to an open shift" });
  const c = classifyOperation(pay);
  assert.equal(c.category, "HISTORICAL_SHIFTLESS_DINEIN");
  assert.equal(dispositionOf(pay, c.category, null), "MANUAL_REVIEW");
  await localdb.operations.add(pay);
  assert.deepEqual(await recoverHistoricalReplayFailures(), []);
  assert.equal((await getOperation("pt"))?.status, "needs_attention");
});

// ---- Konan REQUIRED_FIXES (upgrade path / structural checks / scope) ----

async function legacyDraft(createdAt: string): Promise<string> {
  const d = await openTableOffline({ scope: { ...SCOPE, shiftId: null }, tableId: "TBL-L", tableName: "L", seats: 2, currency: "LBP" });
  await localdb.dineDrafts.update(d.local_session_id, { shift_id: undefined, shift_local: undefined, created_at: createdAt });
  await addDraftLine(d.local_session_id, { menu_item_id: "m", name: "Tea", base_price: 10, quantity: 1, modifiers: [], kitchen_note: null });
  return d.local_session_id;
}

test("K1 an UPGRADED pre-rc.12 session with no shift: a NEW order is refused (fail closed), never sent shift-less", async () => {
  const sid = await legacyDraft(new Date(Date.now() - 7_200_000).toISOString());
  // current shift opened AFTER the session was started → not provably its own
  await assert.rejects(sendRoundOffline(sid, { currentShift: { id: "SRV-SHIFT-1", openedAt: new Date(Date.now() - 3_600_000).toISOString() } }), /started by an earlier build without a shift/);
  await assert.rejects(sendRoundOffline(sid), /without a shift/);
  assert.equal((await localdb.operations.where("operation_type").equals("dinein_send_round").count()), 0, "nothing captured");
});

test("K2 an upgraded session started DURING the current shift is attached to it (provable), and the round carries it", async () => {
  const sid = await legacyDraft(new Date(Date.now() - 600_000).toISOString());
  const d = await sendRoundOffline(sid, { currentShift: { id: "SRV-SHIFT-1", openedAt: new Date(Date.now() - 3_600_000).toISOString() } });
  assert.equal(d.shift_id, "SRV-SHIFT-1");
  const round = await getOperation(d.rounds[0].operation_id);
  assert.equal((round?.payload as { submit: { shift_id: string } }).submit.shift_id, "SRV-SHIFT-1");
});

test("K3 a pre-rc.12 CAPTURED round with no shift is parked for review at replay (shift_missing), never a shift-less order", async () => {
  await localdb.operations.add(op({ operation_id: "legacy-round", operation_type: "dinein_send_round", local_entity_id: "no-such-session", payload: { submit: { branch_id: "b1", order_type: "dine_in", status: "sent_to_kitchen", shift_id: "", table_id: "TBL-9", items: [] }, table_local: null, session_local: null } }));
  const calls: Call[] = [];
  await drainOffline(CTX, "reconnect", deps(calls));
  assert.equal(calls.filter((c) => c.name === "round").length, 0, "nothing sent");
  const o = await getOperation("legacy-round");
  assert.equal(o?.status, "needs_attention");
  assert.equal(o?.last_error_code, "shift_missing");
  assert.equal(classifyOperation(o!).category, "HISTORICAL_SHIFTLESS_DINEIN");
});

test("K4 End Shift keeps the structural checks: a MISSING close-relevant prerequisite is diagnosed, never assumed done", async () => {
  await localdb.operations.add(op({ operation_id: "endshift:m", operation_type: "end_shift", dependency_ids: ["ghost-op"], payload: { shift_id: "SRV-SHIFT-1", shift_local: null, actual_cash_counted: 1, notes: null } }));
  const calls: Call[] = [];
  await drainOffline(CTX, "reconnect", deps(calls));
  assert.equal(calls.length, 0, "no premature close");
  const e = await getOperation("endshift:m");
  assert.equal(e?.status, "needs_attention");
  assert.equal(e?.last_error_code, "missing_dependency");
});

test("K5 End Shift keeps cycle detection (never an infinite wait)", async () => {
  await localdb.operations.add(op({ operation_id: "p-cyc", operation_type: "pay_order", dependency_ids: ["endshift:c"], payload: { order_id: "X", order_local: null, method: "cash", currency: "LBP" } }));
  await localdb.operations.add(op({ operation_id: "endshift:c", operation_type: "end_shift", dependency_ids: ["p-cyc"], payload: { shift_id: "SRV-SHIFT-1", shift_local: null, actual_cash_counted: 1, notes: null } }));
  await drainOffline(CTX, "reconnect", deps([]));
  assert.equal((await getOperation("endshift:c"))?.last_error_code, "circular_dependency");
});

test("K6 OU wall: a same-id local txn from ANOTHER operating unit never feeds this OU's delivery projection", async () => {
  await localdb.posOfflineTxns.add({ local_txn_id: "SRV-D1", client_op_id: crypto.randomUUID(), tenant_id: "t1", branch_id: "OTHER-OU", device_id: DEV.device_id, terminal_id: "", cashier_user_id: "u1", cashier_user_name: "A", shift_id: "x", created_at: new Date().toISOString(), order_payload: { order_type: "delivery", items: [{ name: "Foreign", base_price: 999, quantity: 9, modifiers: [] }] }, payment_intent: null, currency: "LBP", total: 8991, status: "queued", attempts: 0 } as PosOfflineTxn);
  await localdb.operations.add(op({ operation_id: "payorder:ou", operation_type: "pay_order", payload: { order_id: "SRV-D1", order_local: null, method: "cash", currency: "LBP" } }));
  const [shown] = await overlayDeliveryQueue(SCOPE, [deliveryRow()], { rowFetchedAt: Date.now() });
  assert.equal(shown.total_amount, 1, "the foreign OU's local lines/total never leak in");
  assert.equal(shown.payment_status, "paid", "this OU's own settle still projects");
});

test("Sync Center classifies another shift's parked work as UNRELATED_OLD_SHIFT when the live shift is known", () => {
  const old = op({ operation_id: "old", operation_type: "pay_order", status: "needs_attention", last_error_code: "validation", last_error_message: "x", payload: { order_payload: { shift_id: "OLD-SHIFT" } } as never });
  const [row] = buildDiagnostic([old], "b", { currentShiftId: "SRV-SHIFT-1" });
  assert.equal(row.disposition, "UNRELATED_OLD_SHIFT");
});

// ================================================================ M / V — move & merge

test("M1/V1 Move and Merge are server-coordinated: offline the gate gives an explicit, visible reason (no silent no-op, no capture)", () => {
  const dw = src("src/screens/pos/DineInWorkspace.tsx");
  assert.match(dw, /offlineCapable: false/);
  assert.doesNotMatch(dw, /captureMoveTableOffline\(|captureMergeTablesOffline\(/);
  const panel = src("src/components/pos/TableBillPanel.tsx");
  assert.match(panel, /role="note"/);
  const pre = op({ operation_id: "mg", operation_type: "merge_tables", status: "needs_attention", last_error_code: "validation", last_error_message: 'invalid input syntax for type uuid: "a|b"' });
  assert.equal(classifyOperation(pre).category, "SERVER_COORDINATION_REQUIRED", "a pre-rc.12 offline merge is reviewed, never blindly retried");
});

// ================================================================ C — customer identity

test("C1 an offline-created customer is found IMMEDIATELY by phone, in any typed form", async () => {
  await captureCustomerUpsertOffline({ scope: SCOPE, upsert: { branch_id: "b1", phone: "78900000", name: "Walk-in" }, clientOpId: "c1c1c1c1-0000-4000-8000-0000000000f5" });
  for (const q of ["78900000", "+961 78 900 000", "0096178900000", "961-78-900000"]) {
    const hits = await searchCachedCustomers({ tenantId: "t1", branchId: "b1" }, q);
    assert.equal(hits.length, 1, q);
  }
  // C2 — a restart (Dexie re-opened) keeps it searchable.
  localdb.close();
  await localdb.open();
  assert.equal((await searchCachedCustomers({ tenantId: "t1", branchId: "b1" }, "78900000")).length, 1);
});

test("C3/C4 after sync the SAME logical customer is found under its canonical id — one result, never two", async () => {
  const c = await captureCustomerUpsertOffline({ scope: SCOPE, upsert: { branch_id: "b1", phone: "78900000", name: "Walk-in" }, clientOpId: "c1c1c1c1-0000-4000-8000-0000000000f6" });
  await drainOffline(CTX, "reconnect", deps([]));
  const hits = await searchCachedCustomers({ tenantId: "t1", branchId: "b1" }, "78900000");
  assert.deepEqual(hits.map((h) => h.id), ["SRV-CUST"]);
  assert.equal(await localdb.posCustomers.get(c.localCustomerId as string), undefined, "the local row was promoted, not duplicated");
  assert.equal((await localdb.entityMap.get(c.localCustomerId as string))?.canonical_id, "SRV-CUST", "local references still resolve");
});

test("C5 On Account reuses the same logical customer: local before sync (waits + remaps), canonical after", async () => {
  const c = await captureCustomerUpsertOffline({ scope: SCOPE, upsert: { branch_id: "b1", phone: "78900000", name: "Walk-in" }, clientOpId: "c1c1c1c1-0000-4000-8000-0000000000f7" });
  const oa = await orderOnAccountOffline({ scope: SCOPE, orderId: "ORD-9", orderLocal: null, migOpId: null, customerId: c.localCustomerId, amount: 0, method: "cash" });
  const calls: Call[] = [];
  await drainOffline(CTX, "reconnect", deps(calls));
  assert.equal((calls.find((x) => x.name === "on_account_order")?.arg as { customerId: string }).customerId, "SRV-CUST");
  assert.equal((await getOperation(oa.operationId))?.status, "synced");
  const [hit] = await searchCachedCustomers({ tenantId: "t1", branchId: "b1" }, "78900000");
  assert.deepEqual(await normalizeCustomerRef(hit.id, null), { customerId: "SRV-CUST", customerLocal: null }, "a later On Account uses the canonical id directly");
});

// ================================================================ Sync Center

test("Sync Center shows ONE row per operation in its CURRENT state (rc.11 listed every history event)", async () => {
  const o = op({ operation_id: "pay-x", operation_type: "pay_order", status: "synced", synced_at: new Date().toISOString() });
  await localdb.operations.add(o);
  for (const status of ["syncing", "needs_attention", "synced"] as const) {
    await appendHistory({ at: new Date().toISOString(), operation_id: "pay-x", operation_type: "pay_order", action_label: "Pay order", tenant_id: "t1", branch_id: "b1", device_id: DEV.device_id, cashier_user_id: "u1", local_ref: null, canonical_ref: null, status, retry_count: 0, error_summary: null, synced_at: null });
  }
  const rows = await loadSyncCenterRows({ tenantId: "t1", branchId: "b1", currentBuild: "abc" });
  assert.equal(rows.filter((r) => r.operation_id === "pay-x").length, 1);
  assert.equal(rows[0].status, "synced");
  assert.equal(buildEra(null, "abc"), "HISTORICAL_RC8_RC9");
  assert.equal(buildEra("f61fbd8xyz", "abc"), "RC11");
  assert.equal(buildEra("abc", "abc"), "CURRENT");
});

test("capture idempotency is unchanged: a double End Shift tap is ONE op", async () => {
  const a = await captureEndShiftOffline({ scope: SCOPE, shiftId: "SRV-SHIFT-1", shiftLocal: null, actualCashCounted: 1, notes: null, shiftOpenedAt: SHIFT.opened_at });
  const b = await captureEndShiftOffline({ scope: SCOPE, shiftId: "SRV-SHIFT-1", shiftLocal: null, actualCashCounted: 1, notes: null, shiftOpenedAt: SHIFT.opened_at });
  assert.equal(a.operationId, b.operationId);
  assert.equal(b.alreadyCaptured, true);
});
