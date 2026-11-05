// 1.0.39 (L4/1, Hush #2124 incident 2026-11-02) — a local Dine-In session whose table open the server REFUSED
// (pos_open_table CAS → VERSION_CONFLICT, no write) with its round parked behind it (dependency_failed, never
// sent) must not keep a table "occupied" on the floor, must not inflate a real bill, must survive reconnect /
// restart, and must stay in full for an explicit, server-verified operator withdrawal.
//
// Real Dexie (fake-indexeddb), the REAL orchestrator, handlers, capture engine, projections and reconcile;
// server RPCs injected. Synthetic fixtures only (TBL-X / t1 / b1 / u1). No network, no Staging, no Production.

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

import { localdb, cacheBill } from "@/lib/offline/db";
import { getOperation, requeueOperation, type OfflineOperation } from "@/lib/offline/operationLog";
import { drainOffline, __resetDrainLockForTests } from "@/lib/offline/orchestrator";
import type { PosTxnSyncDeps } from "@/lib/offline/posTxnSync";
import { useShift, shiftNet } from "@/state/shift";
import { clearPosSessionSnapshot } from "@/lib/offline/posSession";
import {
  openTableOffline,
  addDraftLine,
  sendRoundOffline,
  settleTableOffline,
  getDineDraftForTable,
  reconcileDineDraftsFromOperations,
  retireClosedSessions,
} from "@/lib/offline/dineinOffline";
import { tablesWithUnreflectedWork, getOperationalTableTotals, overlayTableTotals, sessionRefusal, getOperationalTableBill } from "@/lib/offline/operationalProjection";
import {
  listRefusedSessions, reconcileRefusedSessions, withdrawRefusedSession, makeReceiptCheck, receiptFaultKind,
  WITHDRAW_NEEDS_CONNECTION, WITHDRAW_RECEIPT_FOUND, WITHDRAW_NOT_YOURS, WITHDRAW_STATE_CHANGED, WITHDRAW_NOT_AUTHORIZED, WITHDRAW_CHECK_FAILED, WITHDRAW_PERMISSION,
  type ReceiptCheck, type ReceiptCheckInput, type ReceiptClient,
} from "@/lib/offline/refusedSessions";
import { loadSyncSummary } from "@/components/sync/syncCenterModel";
import { OPEN_BEHIND_PARKED_SETTLE_MESSAGE, REFUSED_SESSION_SETTLE_MESSAGE } from "@/lib/offline/dineinOffline";
import { rebaseRefusedOpen, REBASE_TABLE_BUSY, type RebaseDeps } from "@/lib/offline/openRebase";
import { operatorRetry, runSyncNow, SYNC_NOW_NO_POS, SYNC_NOW_NOT_RUN } from "@/lib/offline/syncActions";
import { lastDrainReport } from "@/lib/offline/orchestrator";
import { loadSyncCenterRows, dependencyCycleOf, adviceFor } from "@/lib/offline/queueForensics";
import { COLLECTED_OFFLINE_NOT_ON_BILL } from "@/lib/offline/refusedSessions";
import { isOpenable } from "@/lib/pos/tables";
import { getDeviceIdentity } from "@/lib/device";
import type { ActiveShift } from "@/types/pos";
import type { TableSummary } from "@/types/tables";

const DEV = getDeviceIdentity();
const SCOPE = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: DEV.device_id, terminalId: DEV.terminal_id ?? null };
const DSCOPE = { ...SCOPE, shiftId: "SRV-SHIFT-OLD" };
const OTHER_CASHIER = { ...SCOPE, cashierUserId: "u2" };
const CTX = { ...SCOPE, online: true };
const SHIFT: ActiveShift = { id: "SRV-SHIFT-OLD", status: "open", opened_at: new Date(Date.now() - 3_600_000).toISOString(), opening_cash_amount: 0, branch_id: "b1" } as ActiveShift;
const VERSION_CONFLICT = "This table changed since it was loaded. Reload the table map and retry.";

beforeEach(async () => {
  await Promise.all([
    localdb.operations.clear(), localdb.entityMap.clear(), localdb.syncHistory.clear(), localdb.dineDrafts.clear(),
    localdb.snapshots.clear(), localdb.posOfflineTxns.clear(), localdb.pendingShifts.clear(), localdb.posCustomers.clear(),
  ]);
  __resetDrainLockForTests();
  clearPosSessionSnapshot();
  useShift.getState().clear();
  useShift.setState({ shift: SHIFT, pendingLocalId: null, loading: false });
  shiftNet.findOpenShift = async () => SHIFT;
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
    openTable: async (p: unknown) => { calls.push({ name: "open_table", arg: p }); return { table_id: "TBL-X", pos_entity_version: 194 }; },
    submitRound: async (p: unknown) => { calls.push({ name: "round", arg: p }); return { order_id: "ORD-A", order_number: "N", batch_no: 1, appended: false, idempotent: false }; },
    orderItemMap: async () => [],
    payTable: async (a: unknown) => { calls.push({ name: "pay_table", arg: a }); return { ok: true, amount: 1, idempotent: false, pos_entity_version: 9 }; },
    payOrderOp: async (a: { orderId: string }) => { calls.push({ name: "pay_order", arg: a }); return { order_id: a.orderId, paid: true, amount: 1, idempotent: false }; },
    onAccountTable: async () => { calls.push({ name: "on_account", arg: null }); return { ok: true, idempotent: false }; },
    onAccountOrder: async () => { calls.push({ name: "on_account", arg: null }); return { ok: true, idempotent: false }; },
    upsertCustomer: async () => ({ customer_id: "C", address_id: "A", is_new: true }),
    editOrderLine: async () => { calls.push({ name: "edit", arg: null }); return { ok: true, idempotent: false, replacement_order_item_id: "R", pos_entity_version: 1 }; },
    endShiftOp: async (a: { shiftId: string }) => ({ shift_id: a.shiftId, idempotent: false }),
    isTransport: (e: unknown) => e instanceof TypeError,
    hasSession: async () => true,
    ...over,
  } as unknown as PosTxnSyncDeps;
}

/** pos_open_table_core's CAS refusal for a stale expected_version (raised before any write). */
const conflictingOpen = (calls: Call[]) => deps(calls, {
  openTable: async (p: unknown) => { calls.push({ name: "open_table", arg: p }); throw Object.assign(new Error(VERSION_CONFLICT), { code: "P0001" }); },
});
/** Every server call that would create money, kitchen, stock or GL effects. */
const businessCalls = (calls: Call[]) => calls.filter((c) => ["round", "submit", "pay_table", "pay_order", "on_account", "edit"].includes(c.name));

const freeRow = (over: Partial<TableSummary> = {}): TableSummary =>
  ({ id: "TBL-X", name: "L4/1", seats: 3, occupied: false, status: "available", canonical: true, configured: true, sort_order: 63, orders: 0, order_number: null, opened_at: null, total: null, collected: null, outstanding: null, currency: "LBP", mixed_currency: false, merged_sources: [], pos_entity_version: 193, ...over }) as TableSummary;

const REAL_BILL_ROW = () => freeRow({ occupied: true, status: "occupied", orders: 1, order_number: "261102-0042", total: 1200000, outstanding: 1200000, collected: 0 });
async function cacheRealBill() {
  await cacheBill("TBL-X", {
    tableId: "TBL-X",
    orders: [{ id: "ORD-REAL", order_number: "261102-0042", status: "sent_to_kitchen", payment_status: "unpaid", pos_entity_version: 0, shift_id: "SRV-SHIFT-NOW", branch_id: "b1", tenant_id: "t1", subtotal: 1200000, discount_amount: 0, total_amount: 1200000, currency: "LBP", exchange_rate: null, created_at: new Date().toISOString(), lines: [{ id: "RL1", menu_item_id: "m1", name: "Arguile", quantity: 1, base_price: 700000, modifiers_total: 0, final_unit_price: 700000, line_total: 700000, kitchen_note: null, batch_no: 1, modifiers: [] }, { id: "RL2", menu_item_id: "m3", name: "Milkshake", quantity: 1, base_price: 500000, modifiers_total: 0, final_unit_price: 500000, line_total: 500000, kitchen_note: null, batch_no: 1, modifiers: [] }] }],
    subtotal: 1200000, total: 1200000, currency: "LBP", mixedCurrency: false, splitShift: false, batches: [1],
  }, "t1", "b1", Date.now());
}

/** The incident capture: open L4/1 offline at a since-superseded version + one round of 2 items (1,000,000). */
async function capturedSession(scope = DSCOPE) {
  const d = await openTableOffline({ scope, tableId: "TBL-X", tableName: "L4/1", seats: 3, currency: "LBP", baseOrderVersion: 7 });
  await addDraftLine(d.local_session_id, { menu_item_id: "m1", name: "Arguile", base_price: 700000, quantity: 1, modifiers: [], kitchen_note: null });
  await addDraftLine(d.local_session_id, { menu_item_id: "m2", name: "Nescaffe", base_price: 300000, quantity: 1, modifiers: [], kitchen_note: null });
  await sendRoundOffline(d.local_session_id);
  for (const o of await localdb.operations.toArray()) await localdb.operations.update(o.operation_id, { captured_build: null } as Partial<OfflineOperation>); // unstamped, like 1.0.37
  return d;
}

async function floorOnline(scope: typeof SCOPE, serverRow: TableSummary, mapLoadedAt = Date.now() + 5) {
  const work = await tablesWithUnreflectedWork(scope, mapLoadedAt);
  if (work.touched.size === 0) return { row: serverRow, work };
  const totals = await getOperationalTableTotals(scope, [serverRow], work.touched, mapLoadedAt);
  return { row: overlayTableTotals([serverRow], totals)[0], work };
}

const opsOf = async () => {
  const all = await localdb.operations.toArray();
  return { open: all.find((o) => o.operation_type === "dinein_open_table")!, round: all.find((o) => o.operation_type === "dinein_send_round")! };
};
const noReceipts: ReceiptCheck = async () => ({ kind: "none" });

// ============================================================ the incident, fixed

test("F1 rejected Open Table + dependent Send Round → session REFUSED; ops untouched (Conflict + Needs attention); round never sent", async () => {
  const d = await capturedSession();
  const calls: Call[] = [];
  await drainOffline(CTX, "reconnect", conflictingOpen(calls));
  assert.equal(businessCalls(calls).length, 0, "the stale round never reached pos_submit_order");
  const { open, round } = await opsOf();
  assert.equal(open.status, "needs_attention");
  assert.equal(open.last_error_code, "version_conflict");
  assert.equal(round.status, "needs_attention");
  assert.equal(round.last_error_code, "dependency_failed");
  assert.equal(round.retry_count, 0, "never handed to its handler");
  assert.equal((await localdb.dineDrafts.get(d.local_session_id))?.status, "refused");
  assert.equal((await localdb.dineDrafts.get(d.local_session_id))?.closed_evidence_op_id, open.operation_id);
  const s = await loadSyncSummary("t1", "b1");
  assert.equal(s.conflict, 1, "Sync Center still reports the server's refusal truthfully");
  assert.equal(s.needsAttention, 1);
});

test("F2 the stale round creates NO phantom occupancy: free server map → free, openable; Move/Merge not held", async () => {
  await capturedSession();
  await drainOffline(CTX, "reconnect", conflictingOpen([]));
  const { row, work } = await floorOnline(SCOPE, freeRow());
  assert.equal(work.touched.has("TBL-X"), false);
  assert.equal(work.structuralHold.has("TBL-X"), false, "no 'offline work not synced' hold on Move / Merge");
  assert.equal(work.refusedOrders.get("TBL-X"), 1, "the bill panel can point the operator to the review");
  assert.equal(row.occupied, false);
  assert.equal(isOpenable(row), true);
  // and OFFLINE too: the operational projection never carries it
  const p = await getOperationalTableBill(SCOPE, freeRow());
  assert.equal(p.bill.orders.length, 0);
});

test("F3 a REAL unpaid server bill stays occupied, its total is NOT inflated by the refused round", async () => {
  await capturedSession();
  await drainOffline(CTX, "reconnect", conflictingOpen([]));
  await cacheRealBill();
  const { row } = await floorOnline(SCOPE, REAL_BILL_ROW());
  assert.equal(row.occupied, true);
  assert.equal(row.orders, 1);
  assert.equal(row.total, 1200000, "1.0.38 showed 2,200,000 here");
  const p = await getOperationalTableBill(SCOPE, REAL_BILL_ROW());
  assert.equal(p.gross, 1200000);
  assert.deepEqual(p.bill.orders.map((o) => o.id), ["ORD-REAL"]);
});

test("F4 reconnect + RESTART: the refusal persists, no phantom returns, a second drain sends nothing", async () => {
  const d = await capturedSession();
  await drainOffline(CTX, "reconnect", conflictingOpen([]));
  localdb.close();
  await localdb.open();
  await reconcileDineDraftsFromOperations();
  assert.equal((await localdb.dineDrafts.get(d.local_session_id))?.status, "refused");
  __resetDrainLockForTests();
  const again: Call[] = [];
  await drainOffline(CTX, "reconnect", conflictingOpen(again));
  assert.equal(again.length, 0, "parked ops are not replayed by themselves");
  assert.equal((await floorOnline(SCOPE, freeRow())).row.occupied, false);
  assert.equal(await getDineDraftForTable(SCOPE, "TBL-X"), null, "never the table's active session");
  assert.deepEqual(await retireClosedSessions(), [], "retirement never touches it — it is not 'closed', it awaits review");
});

// ============================================================ genuinely live work is preserved

test("P1 an offline round that SYNCS normally is unaffected (no refusal; synced, reflected, table free after pay)", async () => {
  const d = await capturedSession();
  await settleTableOffline({ sessionId: d.local_session_id, method: "cash", covers: { orderIds: [], summary: false } });
  const calls: Call[] = [];
  await drainOffline(CTX, "reconnect", deps(calls));
  assert.deepEqual(calls.map((c) => c.name), ["open_table", "round", "pay_table"]);
  assert.notEqual((await localdb.dineDrafts.get(d.local_session_id))?.status, "refused");
  assert.equal((await floorOnline(SCOPE, freeRow(), Date.now() + 1000)).row.occupied, false);
});

test("P2 GENUINELY PENDING work (never attempted / transient failure) keeps its occupancy — never treated as refused", async () => {
  const d = await capturedSession();
  // never attempted
  assert.equal((await reconcileRefusedSessions()).refused.length, 0);
  assert.equal((await floorOnline(SCOPE, freeRow())).row.occupied, true, "pending local work is still the table's bill");
  // a transport failure → retryable, still live
  await drainOffline(CTX, "reconnect", deps([], { openTable: async () => { throw new TypeError("Failed to fetch"); } }));
  assert.equal((await opsOf()).open.status, "retryable");
  assert.equal((await localdb.dineDrafts.get(d.local_session_id))?.status, "open");
  assert.equal((await floorOnline(SCOPE, freeRow())).row.occupied, true);
});

test("P3 a round that WAS handed to its handler (retry_count > 0) is never assumed unapplied — no refusal", async () => {
  const d = await capturedSession();
  await drainOffline(CTX, "reconnect", conflictingOpen([]));
  const { round } = await opsOf();
  await localdb.operations.update(round.operation_id, { retry_count: 1 });
  await reconcileDineDraftsFromOperations();
  assert.equal((await localdb.dineDrafts.get(d.local_session_id))?.status, "open", "conservative: 1.0.38 behaviour, operator review");
});

test("P4 duplicate replay with a valid server RECEIPT (DUPLICATE_REPLAY_RETURNED) syncs — never refused", async () => {
  const d = await capturedSession();
  const calls: Call[] = [];
  await drainOffline(CTX, "reconnect", deps(calls, {
    openTable: async (p: unknown) => { calls.push({ name: "open_table", arg: p }); return { table_id: "TBL-X", pos_entity_version: 8, idempotent: true, result_code: "DUPLICATE_REPLAY_RETURNED" }; },
    submitRound: async (p: unknown) => { calls.push({ name: "round", arg: p }); return { order_id: "ORD-A", order_number: "N", batch_no: 1, appended: false, idempotent: true }; },
  }));
  const { open, round } = await opsOf();
  assert.equal(open.status, "synced");
  assert.equal(round.status, "synced");
  assert.equal(calls.filter((c) => c.name === "round").length, 1, "exactly one submit (server dedups on client_op_id)");
  assert.notEqual((await localdb.dineDrafts.get(d.local_session_id))?.status, "refused");
});

test("P5 operator 'Try again' re-opens the session while its open is live again; the CAS refuses again → refused again; round never sent", async () => {
  const d = await capturedSession();
  await drainOffline(CTX, "reconnect", conflictingOpen([]));
  const { open } = await opsOf();
  assert.equal(await requeueOperation(open.operation_id), true);
  await reconcileRefusedSessions();
  assert.equal((await localdb.dineDrafts.get(d.local_session_id))?.status, "open", "the proof no longer holds while it is queued");
  __resetDrainLockForTests();
  const calls: Call[] = [];
  await drainOffline(CTX, "operator-retry", conflictingOpen(calls));
  assert.deepEqual(calls.map((c) => c.name), ["open_table"]);
  assert.equal((await localdb.dineDrafts.get(d.local_session_id))?.status, "refused");
});

test("P6 a NEW order on the same table after a refusal is a NEW session that syncs on its own (not chained to the refused one)", async () => {
  const d = await capturedSession();
  await drainOffline(CTX, "reconnect", conflictingOpen([]));
  const d2 = await openTableOffline({ scope: DSCOPE, tableId: "TBL-X", tableName: "L4/1", seats: 3, currency: "LBP", baseOrderVersion: 193 });
  assert.notEqual(d2.local_session_id, d.local_session_id);
  assert.equal((await getDineDraftForTable(SCOPE, "TBL-X"))?.local_session_id, d2.local_session_id);
  await addDraftLine(d2.local_session_id, { menu_item_id: "m3", name: "Milkshake", base_price: 500000, quantity: 1, modifiers: [], kitchen_note: null });
  await sendRoundOffline(d2.local_session_id);
  __resetDrainLockForTests();
  const calls: Call[] = [];
  await drainOffline(CTX, "reconnect", deps(calls));
  const rounds = calls.filter((c) => c.name === "round");
  assert.equal(rounds.length, 1, "only the NEW round is sent");
  assert.deepEqual(((rounds[0].arg as { items: { name: string }[] }).items).map((i) => i.name), ["Milkshake"]);
  assert.equal((await localdb.dineDrafts.get(d.local_session_id))?.status, "refused", "the refused one is still kept for review");
});

// ============================================================ isolation

test("I1 cashier / terminal isolation: another cashier neither sees nor can withdraw it; their own floor is untouched", async () => {
  const d = await capturedSession();
  await drainOffline(CTX, "reconnect", conflictingOpen([]));
  assert.equal((await listRefusedSessions(OTHER_CASHIER)).length, 0);
  assert.equal((await listRefusedSessions({ ...SCOPE, terminalId: "OTHER-TERMINAL" })).length, 0);
  assert.equal((await listRefusedSessions({ ...SCOPE, branchId: "b2" })).length, 0);
  const r = await withdrawRefusedSession({ sessionId: d.local_session_id, scope: OTHER_CASHIER, actorUserId: "u2", checkReceipts: noReceipts });
  assert.deepEqual(r, { ok: false, reason: WITHDRAW_NOT_YOURS });
  assert.equal((await localdb.dineDrafts.get(d.local_session_id))?.status, "refused");
  // another cashier's own live session on this terminal is never refused by this one's evidence
  const other = await openTableOffline({ scope: { ...OTHER_CASHIER, shiftId: "SRV-SHIFT-OLD" }, tableId: "TBL-Y", tableName: "L4/2", seats: 2, currency: "LBP" });
  await reconcileRefusedSessions();
  assert.equal((await localdb.dineDrafts.get(other.local_session_id))?.status, "open");
});

// ============================================================ explicit, verified withdrawal

test("W1 withdrawal: listed with its figures; withdraws only after Breadee confirms no receipt; ops kept (cancelled + audit + refusal)", async () => {
  const d = await capturedSession();
  await drainOffline(CTX, "reconnect", conflictingOpen([]));
  const [o] = await listRefusedSessions(SCOPE);
  assert.equal(o.tableName, "L4/1");
  assert.equal(o.items, 2);
  assert.equal(o.total, 1000000);
  assert.match(o.refusal, /changed since it was loaded/);
  const asked: ReceiptCheckInput[] = [];
  const r = await withdrawRefusedSession({
    sessionId: d.local_session_id, scope: SCOPE, actorUserId: "u1",
    checkReceipts: async (q) => { asked.push(q); return { kind: "none" }; },
  });
  assert.equal(r.ok, true);
  const { open, round } = await opsOf();
  assert.deepEqual(asked, [{ tenantId: "t1", branchIds: ["b1"], actorUserId: "u1", openClientOpIds: [open.client_op_id], roundClientOpIds: [round.client_op_id] }], "every op's server receipt was checked, under the operator's authority in the order's tenant + branch");
  assert.deepEqual(open.withdrawal?.verified_against, ["pos_op_submissions", `authority:${WITHDRAW_PERMISSION}`]);
  for (const x of [open, round]) {
    assert.equal(x.status, "cancelled");
    assert.equal(x.withdrawal?.by_user_id, "u1");
    assert.equal(x.withdrawal?.reason, "refused_never_applied");
  }
  assert.equal(open.last_error_code, "version_conflict", "the refusal evidence is preserved");
  assert.equal(round.last_error_code, "dependency_failed");
  const dd = await localdb.dineDrafts.get(d.local_session_id);
  assert.equal(dd?.status, "withdrawn");
  assert.equal(dd?.lines.length, 2, "the order's lines are kept for audit");
  const s = await loadSyncSummary("t1", "b1");
  assert.equal(s.parked, 0, "nothing parked any more");
  assert.equal((await listRefusedSessions(SCOPE)).length, 0);
  const hist = await localdb.syncHistory.toArray();
  assert.equal(hist.filter((h) => h.status === "cancelled").length, 2);
  // never resurrected: requeue refuses a cancelled op, a drain sends nothing, the floor stays free
  assert.equal(await requeueOperation(open.operation_id), false);
  __resetDrainLockForTests();
  const calls: Call[] = [];
  await drainOffline(CTX, "reconnect", deps(calls));
  assert.equal(calls.length, 0);
  assert.equal((await floorOnline(SCOPE, freeRow())).row.occupied, false);
});

test("W2 withdrawal refuses — and changes NOTHING — when Breadee holds a receipt, when offline, or when the state moved", async () => {
  const d = await capturedSession();
  await drainOffline(CTX, "reconnect", conflictingOpen([]));
  const before = JSON.stringify(await localdb.operations.toArray());
  const { round } = await opsOf();
  const w = (checkReceipts: ReceiptCheck) => withdrawRefusedSession({ sessionId: d.local_session_id, scope: SCOPE, actorUserId: "u1", checkReceipts });
  assert.deepEqual(await w(async () => ({ kind: "found", clientOpIds: [round.client_op_id] })), { ok: false, reason: WITHDRAW_RECEIPT_FOUND });
  assert.deepEqual(await w(async () => ({ kind: "offline", detail: "x" })), { ok: false, reason: WITHDRAW_NEEDS_CONNECTION });
  assert.deepEqual(await w(async () => { throw new TypeError("Failed to fetch"); }), { ok: false, reason: WITHDRAW_NEEDS_CONNECTION }, "a thrown transport error is still 'needs connection'");
  assert.deepEqual(await w(async () => ({ kind: "unauthorized", detail: "x" })), { ok: false, reason: WITHDRAW_NOT_AUTHORIZED });
  assert.deepEqual(await w(async () => ({ kind: "failed", detail: "x" })), { ok: false, reason: WITHDRAW_CHECK_FAILED });
  assert.deepEqual(await w(async () => { throw new Error("boom"); }), { ok: false, reason: WITHDRAW_CHECK_FAILED }, "an unknown fault is never 'no receipt'");
  assert.equal(JSON.stringify(await localdb.operations.toArray()), before);
  assert.equal((await localdb.dineDrafts.get(d.local_session_id))?.status, "refused");
  // CAS: the open was re-queued (operator Try again) between the server check and the commit
  const { open } = await opsOf();
  const r = await withdrawRefusedSession({
    sessionId: d.local_session_id, scope: SCOPE, actorUserId: "u1",
    checkReceipts: async () => { await requeueOperation(open.operation_id); return { kind: "none" }; },
  });
  assert.deepEqual(r, { ok: false, reason: WITHDRAW_STATE_CHANGED });
  assert.equal((await getOperation(open.operation_id))?.status, "pending", "the operator's retry stands; nothing cancelled");
  assert.equal((await getOperation(round.operation_id))?.status !== "cancelled", true);
});

test("W3 sessionRefusal is pure and strict: a missing barrier op or a synced op voids the proof", async () => {
  const d = await capturedSession();
  await drainOffline(CTX, "reconnect", conflictingOpen([]));
  const draft = (await localdb.dineDrafts.get(d.local_session_id))!;
  const ops = await localdb.operations.toArray();
  assert.ok(sessionRefusal(draft, ops));
  assert.equal(sessionRefusal(draft, ops.filter((o) => o.operation_type !== "dinein_send_round")), null, "a round GC'd from the log could have synced");
  assert.equal(sessionRefusal(draft, ops.map((o) => (o.operation_type === "dinein_send_round" ? { ...o, status: "synced" as const, synced_at: new Date().toISOString() } : o))), null);
  assert.equal(sessionRefusal(draft, ops.map((o) => (o.operation_type === "dinein_open_table" ? { ...o, last_error_message: "permission denied" } : o))), null, "only the CAS refusal proves never-applied");
});

// ============================================================ review hardening (1.0.39 integration gate)

/** A fake Supabase slice: by default a signed-in u1 in t1 with access to b1 and pos.cancel_orders, and RLS
 *  returning zero receipt rows. Every call is recorded. */
function fakeClient(over: {
  user?: { id: string } | null;
  userError?: { message?: string; status?: number } | null;
  rpc?: Record<string, (args?: Record<string, unknown>) => { data: unknown; error: { message?: string; code?: string } | null; status?: number }>;
  read?: (table: string, ids: string[]) => Promise<{ data: unknown; error: { message?: string; code?: string } | null; status?: number }>;
} = {}) {
  const calls: string[] = [];
  const rpc = {
    current_tenant_id: () => ({ data: "t1", error: null, status: 200 }),
    can_access_branch: (a?: Record<string, unknown>) => ({ data: a?.p_branch === "b1", error: null, status: 200 }),
    pos_current_user_has_perm: (a?: Record<string, unknown>) => ({ data: a?.p_key === "pos.cancel_orders", error: null, status: 200 }),
    ...over.rpc,
  } as Record<string, (args?: Record<string, unknown>) => { data: unknown; error: { message?: string; code?: string } | null; status?: number }>;
  const client: ReceiptClient = {
    auth: { getUser: async () => { calls.push("getUser"); return { data: { user: over.user === undefined ? { id: "u1" } : over.user }, error: over.userError ?? null }; } },
    rpc: async (fn, args) => { calls.push(`rpc:${fn}:${JSON.stringify(args ?? {})}`); return rpc[fn] ? rpc[fn](args) : { data: null, error: { message: "unknown fn", code: "PGRST202" }, status: 404 }; },
    from: (t) => ({ select: () => ({ eq: (_k: string, v: string) => ({ in: (_c: string, ids: string[]) => { calls.push(`read:${t}:${v}:${ids.join(",")}`); return over.read ? over.read(t, ids) : Promise.resolve({ data: [], error: null, status: 200 }); } }) }) }),
  };
  return { calls, check: makeReceiptCheck(async () => client) };
}
const Q: ReceiptCheckInput = { tenantId: "t1", branchIds: ["b1"], actorUserId: "u1", openClientOpIds: ["OPEN-1"], roundClientOpIds: ["ROUND-1"] };

test("R1 receipt check: zero rows count as 'no receipt' ONLY after sign-in, tenant, branch and permission are proven on the server", async () => {
  const ok = fakeClient();
  assert.deepEqual(await ok.check(Q), { kind: "none" });
  assert.deepEqual(ok.calls, [
    "getUser",
    "rpc:current_tenant_id:{}",
    'rpc:can_access_branch:{"p_branch":"b1"}',
    `rpc:pos_current_user_has_perm:{"p_key":"${WITHDRAW_PERMISSION}"}`,
    "read:pos_op_submissions:t1:OPEN-1",
    "read:pos_order_submissions:t1:ROUND-1",
  ]);
  // Each authority gap → unauthorized, and the receipt tables are never read (an RLS-empty answer would lie).
  const denied: [string, Parameters<typeof fakeClient>[0]][] = [
    ["anonymous / expired session", { user: null }],
    ["session refused by the auth server", { userError: { message: "invalid JWT", status: 401 } }],
    ["another user signed in", { user: { id: "u2" } }],
    ["another current tenant", { rpc: { current_tenant_id: () => ({ data: "t-other", error: null, status: 200 }) } }],
    ["branch access revoked", { rpc: { can_access_branch: () => ({ data: false, error: null, status: 200 }) } }],
    ["no cancel-orders permission", { rpc: { pos_current_user_has_perm: () => ({ data: false, error: null, status: 200 }) } }],
    ["permission RPC refused (42501)", { rpc: { pos_current_user_has_perm: () => ({ data: null, error: { message: "permission denied for function", code: "42501" }, status: 403 }) } }],
  ];
  for (const [why, over] of denied) {
    const c = fakeClient(over);
    const r = await c.check(Q);
    assert.equal(r.kind, "unauthorized", why);
    assert.equal(c.calls.some((x) => x.startsWith("read:")), false, `${why}: receipts never read`);
  }
});

test("R2 receipt check: absence, receipt, network failure, RLS/permission denial and query failure are distinct outcomes", async () => {
  const found = fakeClient({ read: async (t, ids) => ({ data: t === "pos_order_submissions" ? [{ client_op_id: ids[0] }, { client_op_id: "NOT-ASKED" }] : [], error: null, status: 200 }) });
  assert.deepEqual(await found.check(Q), { kind: "found", clientOpIds: ["ROUND-1"] }, "only asked-for ids count");
  const cases: [string, Parameters<typeof fakeClient>[0]["read"], string][] = [
    ["transport rejection", async () => { throw new TypeError("Failed to fetch"); }, "offline"],
    ["postgrest transport error (status 0)", async () => ({ data: null, error: { message: "TypeError: Failed to fetch", code: "" }, status: 0 }), "offline"],
    ["read timeout (AbortError surfaced)", async () => ({ data: null, error: { message: "AbortError: Request timed out after 15000 ms", code: "" }, status: 0 }), "offline"],
    ["RLS / grant refusal", async () => ({ data: null, error: { message: "permission denied for table pos_order_submissions", code: "42501" }, status: 403 }), "unauthorized"],
    ["expired JWT mid-check", async () => ({ data: null, error: { message: "JWT expired", code: "PGRST301" }, status: 401 }), "unauthorized"],
    ["server fault", async () => ({ data: null, error: { message: "internal error", code: "XX000" }, status: 500 }), "failed"],
    ["malformed answer (no rows array)", async () => ({ data: null, error: null, status: 200 }), "failed"],
  ];
  for (const [why, read, kind] of cases) assert.equal((await fakeClient({ read }).check(Q)).kind, kind, why);
  assert.equal(receiptFaultKind(new Error("something odd")), "failed", "an unknown fault is never 'none'");
  assert.equal(receiptFaultKind(Object.assign(new Error("x"), { name: "TimeoutError" })), "offline");
});

/** The exact records 1.0.37 wrote for the incident: a 1.0.37-shaped draft (no 1.0.38 fields) and its ops as the
 *  1.0.37 orchestrator left them (open: version_conflict + the server's verbatim text after attempts; round:
 *  parked dependency_failed BEFORE its handler — retry_count 0), with no build stamp. */
async function seed1037(openMessage = VERSION_CONFLICT) {
  const sid = "LS-1037-L41";
  const scope = { tenant_id: "t1", branch_id: "b1", device_id: DEV.device_id, terminal_id: DEV.terminal_id ?? null, cashier_user_id: "u1" };
  const at = new Date(Date.now() - 6 * 3_600_000).toISOString();
  const base = { schema_version: 1, scope, created_at: at, canonical_entity_id: null, depends_on_local_entities: [], result_meta: null, synced_at: null };
  const open = { ...base, operation_id: "OP-OPEN-37", operation_type: "dinein_open_table", client_op_id: "11111111-1111-4111-8111-111111111111", local_entity_id: sid, dependency_ids: [], payload: { table_id: "TBL-X", expected_version: 7, branch_id: "b1" }, status: "needs_attention", retry_count: 3, last_attempt_at: at, last_error_code: "version_conflict", last_error_message: openMessage };
  const round = { ...base, operation_id: "OP-R1-37", operation_type: "dinein_send_round", client_op_id: "22222222-2222-4222-8222-222222222222", local_entity_id: sid, dependency_ids: ["OP-OPEN-37"], payload: { submit: { table_id: "TBL-X", client_op_id: "22222222-2222-4222-8222-222222222222", items: [] }, table_local: null, session_local: null, shift_local: null, table_name: "L4/1", round_seq: 1 }, status: "needs_attention", retry_count: 0, last_attempt_at: null, last_error_code: "dependency_failed", last_error_message: "OP-OPEN-37" };
  await localdb.operations.bulkAdd([open, round] as unknown as OfflineOperation[]);
  await localdb.dineDrafts.add({
    local_session_id: sid, tenant_id: "t1", branch_id: "b1", cashier_user_id: "u1", device_id: DEV.device_id, terminal_id: DEV.terminal_id ?? null,
    floor_id: null, section_id: null, table_id: "TBL-X", table_name: "L4/1", currency: "LBP", open_operation_id: "OP-OPEN-37", canonical_order_id: null,
    origin: "offline", base_order_version: 7, status: "open", shift_id: "SRV-SHIFT-OLD", shift_local: null,
    lines: [
      { line_id: "L1", menu_item_id: "m1", name: "Arguile", base_price: 700000, quantity: 1, modifiers: [], kitchen_note: null, sent_round: 1 },
      { line_id: "L2", menu_item_id: "m2", name: "Nescaffe", base_price: 300000, quantity: 1, modifiers: [], kitchen_note: null, sent_round: 1 },
    ],
    rounds: [{ round_local_id: "RL-1", operation_id: "OP-R1-37", seq: 1, line_ids: ["L1", "L2"], print_state: "printed", sent_at: at }],
    draft_revision: 3, notes: null, created_at: at, updated_at: at,
  } as never);
  return sid;
}

test("H1 historical 1.0.37 records are recognised after the upgrade: refused, floor free, listed (printed), nothing sent, withdrawable", async () => {
  const sid = await seed1037();
  await reconcileDineDraftsFromOperations();
  assert.equal((await localdb.dineDrafts.get(sid))?.status, "refused");
  assert.equal((await floorOnline(SCOPE, freeRow())).row.occupied, false);
  const calls: Call[] = [];
  await drainOffline(CTX, "reconnect", deps(calls));
  assert.equal(calls.length, 0, "the upgrade replays nothing");
  const [o] = await listRefusedSessions(SCOPE);
  assert.equal(o.items, 2);
  assert.equal(o.total, 1000000);
  assert.equal(o.kitchenPrinted, true, "the review warns it may have been served");
  const asked: ReceiptCheckInput[] = [];
  const r = await withdrawRefusedSession({ sessionId: sid, scope: SCOPE, actorUserId: "u1", checkReceipts: async (q) => { asked.push(q); return { kind: "none" }; } });
  assert.equal(r.ok, true);
  assert.deepEqual(asked[0].openClientOpIds, ["11111111-1111-4111-8111-111111111111"]);
  assert.deepEqual(asked[0].roundClientOpIds, ["22222222-2222-4222-8222-222222222222"], "the receipt key is the client_op_id the round would have sent");
});

test("H2 a 1.0.37 refusal whose wording is NOT the proven table-version CAS keeps today's behaviour (open, visible, never refused)", async () => {
  const sid = await seed1037("VERSION_CONFLICT");
  await reconcileDineDraftsFromOperations();
  assert.equal((await localdb.dineDrafts.get(sid))?.status, "open");
  assert.equal((await listRefusedSessions(SCOPE)).length, 0);
});

// ============================================================ 1.0.40 — BUG 03 (Sync Center deadlock) / BUG 04 (phantom table)
//
// The Hush "mahdi" chain: Open#1 (offline, cached version) → Round#1 → Pay#1 (cash collected) → table reopened
// offline (Open#2 chained after Pay#1) → Round#2. On reconnect the server refuses Open#1 on its table-version
// CAS; everything behind it parks dependency_failed, never sent.

/** Capture the whole incident chain offline. */
async function incidentChain() {
  const d1 = await capturedSession();
  const pay = await settleTableOffline({ sessionId: d1.local_session_id, method: "cash", covers: { orderIds: [], summary: false }, expectedAmount: 1000000 });
  // still offline: the table is free locally, its NEW bill chains after the payment (rc.10)
  const proj = await getOperationalTableBill(SCOPE, freeRow({ pos_entity_version: 7 }));
  assert.equal(proj.freedByOpId ?? proj.settlingOpId, pay.operationId, "offline, the live payment frees the table");
  const d2 = await openTableOffline({ scope: DSCOPE, tableId: "TBL-X", tableName: "L4/1", seats: 3, currency: "LBP", baseOrderVersion: 7, afterSettleOpId: pay.operationId });
  await addDraftLine(d2.local_session_id, { menu_item_id: "m3", name: "Milkshake", base_price: 500000, quantity: 1, modifiers: [], kitchen_note: null });
  await sendRoundOffline(d2.local_session_id);
  const all = await localdb.operations.toArray();
  const open1 = all.find((o) => o.operation_id === d1.open_operation_id)!;
  const open2 = all.find((o) => o.operation_id === d2.open_operation_id)!;
  return { d1, d2, payOpId: pay.operationId, open1, open2 };
}

const rebaseDeps = (row: TableSummary | null, receipt = false, calls: string[] = []): RebaseDeps => ({
  readTable: async (b, t) => { calls.push(`table:${b}:${t}`); return row; },
  hasReceipt: async (_t, id) => { calls.push(`receipt:${id}`); return receipt; },
});

test("G2-a refused Open#1 → parked Pay#1 → Open#2 + Round#2 behind it: BOTH sessions refused, table not held, cash preserved and not collectable", async () => {
  const { d1, d2, payOpId } = await incidentChain();
  const calls: Call[] = [];
  await drainOffline(CTX, "reconnect", conflictingOpen(calls));
  assert.deepEqual(calls.map((c) => c.name), ["open_table"], "only Open#1 reached the server; nothing behind it was sent");
  const s1 = (await localdb.dineDrafts.get(d1.local_session_id))!;
  const s2 = (await localdb.dineDrafts.get(d2.local_session_id))!;
  assert.equal(s1.status, "refused", "a refused session the cashier PAID offline is refused too (BUG 04)");
  assert.equal(s1.settled_operation_id, payOpId, "its payment reference is kept");
  assert.equal(s2.status, "refused", "the session reopened behind the dead payment is refused (chained)");
  // nothing deleted / acknowledged / synced
  const pay = (await getOperation(payOpId))!;
  assert.equal(pay.status, "needs_attention");
  assert.equal(pay.last_error_code, "dependency_failed");
  assert.equal((await localdb.operations.toArray()).filter((o) => o.status === "cancelled" || o.status === "synced").length, 0);
  // the floor: free, not held, no phantom paid bill, nothing chains behind the dead pay
  const { row, work } = await floorOnline(SCOPE, freeRow({ pos_entity_version: 8 }));
  assert.equal(row.occupied, false);
  assert.equal(isOpenable(row), true);
  for (const set of [work.touched, work.syncingSettle, work.attentionSettle, work.structuralHold]) assert.equal(set.has("TBL-X"), false);
  assert.equal(work.refusedOrders.get("TBL-X"), 2);
  const p = await getOperationalTableBill(SCOPE, freeRow({ pos_entity_version: 8 }));
  assert.equal(p.bill.orders.length, 0);
  assert.equal(p.settlingOpId, null, "the dead payment never frees the table");
  assert.equal(p.freedByOpId, null);
  assert.equal(p.attention, 0);
  // the review: case B money is surfaced, chained order identified
  const list = await listRefusedSessions(SCOPE);
  assert.equal(list.length, 2);
  const r1 = list.find((o) => o.sessionId === d1.local_session_id)!;
  const r2 = list.find((o) => o.sessionId === d2.local_session_id)!;
  assert.equal(r1.chained, false);
  assert.deepEqual(r1.collected.map((c) => [c.kind, c.method, c.amount, c.currency]), [["payment", "cash", 1000000, "LBP"]]);
  assert.equal(r2.chained, true);
  assert.equal(r2.rootOpId, d1.open_operation_id);
  assert.match(r2.refusal, /changed since it was loaded/);
  assert.match(COLLECTED_OFFLINE_NOT_ON_BILL, /not on any Breadee bill/);
});

test("G2-b the refusal of both sessions survives a restart (Dexie re-open); the floor stays free; a drain sends nothing", async () => {
  const { d1, d2 } = await incidentChain();
  await drainOffline(CTX, "reconnect", conflictingOpen([]));
  localdb.close();
  await localdb.open();
  await reconcileDineDraftsFromOperations();
  assert.equal((await localdb.dineDrafts.get(d1.local_session_id))?.status, "refused");
  assert.equal((await localdb.dineDrafts.get(d2.local_session_id))?.status, "refused");
  __resetDrainLockForTests();
  const again: Call[] = [];
  await drainOffline(CTX, "reconnect", conflictingOpen(again));
  assert.equal(again.length, 0);
  assert.equal((await floorOnline(SCOPE, freeRow())).row.occupied, false);
  assert.equal(await getDineDraftForTable(SCOPE, "TBL-X"), null);
});

test("G2-c F2 a new open chained behind a DEAD (parked) settle is refused with a Sync Center pointer; nothing is captured", async () => {
  const { payOpId } = await incidentChain();
  await drainOffline(CTX, "reconnect", conflictingOpen([]));
  const before = await localdb.operations.count();
  const drafts = await localdb.dineDrafts.count();
  await assert.rejects(
    openTableOffline({ scope: DSCOPE, tableId: "TBL-X", tableName: "L4/1", seats: 3, currency: "LBP", baseOrderVersion: 8, afterSettleOpId: payOpId }),
    (e: Error) => e.message === OPEN_BEHIND_PARKED_SETTLE_MESSAGE && /Sync Center/.test(e.message),
  );
  assert.equal(await localdb.operations.count(), before, "no op captured");
  assert.equal(await localdb.dineDrafts.count(), drafts, "no session captured");
  // a fresh open (not chained: the projection no longer offers the dead pay) is allowed and replays on its own
  const d3 = await openTableOffline({ scope: DSCOPE, tableId: "TBL-X", tableName: "L4/1", seats: 3, currency: "LBP", baseOrderVersion: 8 });
  assert.deepEqual((await getOperation(d3.open_operation_id))?.dependency_ids, []);
});

test("G2-d Sync Center: labels carry time + ref, the chain is never printed as a loop; plain reason + action; a TRUE cycle is detected", async () => {
  const { open1, open2, payOpId } = await incidentChain();
  await drainOffline(CTX, "reconnect", conflictingOpen([]));
  const rows = await loadSyncCenterRows({ tenantId: "t1", branchId: "b1", currentBuild: null });
  const r1 = rows.find((r) => r.operation_id === open1.operation_id)!;
  const r2 = rows.find((r) => r.operation_id === open2.operation_id)!;
  assert.notEqual(r1.label, r2.label, "two 'Open table · L4/1' ops are distinguishable");
  assert.match(r2.blocking ?? "", /^Blocked by Pay table · L4\/1 \[.*ref [0-9a-f]{6}\], itself blocked by Open table · L4\/1 \(This table changed/);
  const refs = [...(r2.blocking ?? "").matchAll(/ref ([0-9a-f]{6})/g)].map((m) => m[1]);
  assert.equal(new Set(refs).size, refs.length, "every link of the chain has its own ref — no identical labels at both ends");
  assert.doesNotMatch(r2.blocking ?? "", /circular/);
  assert.match(r1.advice?.reason ?? "", /table version changed/);
  assert.match(r1.advice?.action ?? "", /Retry/);
  const round1 = rows.find((r) => r.type === "dinein_send_round" && r.created_at < r2.created_at)!;
  assert.match(round1.advice?.reason ?? "", /^Round could not sync because the table version changed/);
  assert.match(round1.advice?.reason ?? "", /payment is recorded on this device and must not be collected again/);
  const payRow = rows.find((r) => r.operation_id === payOpId)!;
  assert.match(payRow.advice?.reason ?? "", /must not be collected again/);
  assert.equal(dependencyCycleOf((await getOperation(open2.operation_id))!, new Map((await localdb.operations.toArray()).map((o) => [o.operation_id, o]))), null, "a chain is not a cycle");
  // a genuine cycle (A ↔ B) is detected and explained
  const a = { ...open1, operation_id: "CYC-A", dependency_ids: ["CYC-B"], status: "needs_attention", last_error_code: "dependency_failed", last_error_message: "CYC-B" } as OfflineOperation;
  const b = { ...open1, operation_id: "CYC-B", dependency_ids: ["CYC-A"], status: "needs_attention", last_error_code: "dependency_failed", last_error_message: "CYC-A" } as OfflineOperation;
  const m = new Map([[a.operation_id, a], [b.operation_id, b]]);
  assert.deepEqual(dependencyCycleOf(a, m)?.map((x) => x.operation_id), ["CYC-A", "CYC-B"]);
  assert.match(adviceFor(a, m)?.reason ?? "", /circular dependency/);
});

test("G2-e F3 Retry rebase: free server table + no receipt → re-armed ONCE with the fresh version (same client_op_id); the chain then syncs exactly once", async () => {
  const { d1, d2, open1 } = await incidentChain();
  await drainOffline(CTX, "reconnect", conflictingOpen([]));
  const seen: string[] = [];
  const r = await rebaseRefusedOpen(open1.operation_id, rebaseDeps(freeRow({ pos_entity_version: 8 }), false, seen), "u1", { drain: false });
  assert.deepEqual(r, { kind: "rebased", fromVersion: 7, toVersion: 8 });
  assert.deepEqual(seen, [`receipt:${open1.client_op_id}`, "table:b1:TBL-X"]);
  const o = (await getOperation(open1.operation_id))!;
  assert.equal(o.status, "pending");
  assert.equal(o.client_op_id, open1.client_op_id, "pos_op_replay keys on id+type+branch, so the id is kept");
  assert.equal((o.payload as { expected_version: number }).expected_version, 8);
  assert.equal(o.rebases?.length, 1);
  assert.equal(o.rebases?.[0].from_version, 7);
  assert.match(o.rebases?.[0].refusal ?? "", /changed since it was loaded/);
  assert.equal((await rebaseRefusedOpen(open1.operation_id, rebaseDeps(freeRow({ pos_entity_version: 9 })), "u1", { drain: false })).kind, "not_applicable", "re-armed once: a queued open is not rebased again");
  await reconcileRefusedSessions();
  assert.equal((await localdb.dineDrafts.get(d1.local_session_id))?.status, "settled", "back to settled — never open, never payable again");
  assert.equal((await localdb.dineDrafts.get(d2.local_session_id))?.status, "open");
  __resetDrainLockForTests();
  const calls: Call[] = [];
  await drainOffline(CTX, "operator-retry", deps(calls));
  assert.deepEqual(calls.map((c) => c.name), ["open_table", "round", "pay_table", "open_table", "round"]);
  assert.equal((calls[0].arg as { expected_version: number }).expected_version, 8);
  assert.equal(calls.filter((c) => c.name === "pay_table").length, 1, "the cash is applied exactly once");
  assert.equal((await localdb.operations.toArray()).every((x) => x.status === "synced"), true);
});

test("G2-e2 F3 Retry rebase never re-arms with a server receipt, on an occupied table, or offline — nothing changes", async () => {
  const { open1 } = await incidentChain();
  await drainOffline(CTX, "reconnect", conflictingOpen([]));
  const before = JSON.stringify(await localdb.operations.toArray());
  assert.deepEqual(await rebaseRefusedOpen(open1.operation_id, rebaseDeps(freeRow(), true), "u1", { drain: false }), { kind: "receipt_found" });
  assert.deepEqual(await rebaseRefusedOpen(open1.operation_id, rebaseDeps(REAL_BILL_ROW()), "u1", { drain: false }), { kind: "table_busy", message: REBASE_TABLE_BUSY });
  assert.deepEqual(await rebaseRefusedOpen(open1.operation_id, rebaseDeps(null), "u1", { drain: false }), { kind: "table_busy", message: REBASE_TABLE_BUSY });
  const off = await rebaseRefusedOpen(open1.operation_id, { readTable: async () => { throw new TypeError("Failed to fetch"); }, hasReceipt: async () => false }, "u1", { drain: false });
  assert.equal(off.kind, "offline");
  assert.equal(JSON.stringify(await localdb.operations.toArray()), before);
  // operatorRetry surfaces the genuine conflict and queues nothing
  const rr = await operatorRetry(open1.operation_id, { actorUserId: "u1", rebaseDeps: rebaseDeps(REAL_BILL_ROW()), drain: async () => 1 });
  assert.deepEqual(rr, { ok: false, text: REBASE_TABLE_BUSY });
  assert.equal(JSON.stringify(await localdb.operations.toArray()), before);
});

test("G2-f RC-4 lost ACK: the open applied server-side but the answer was lost → retried → idempotent receipt → synced exactly once", async () => {
  await capturedSession();
  const applied = new Set<string>();
  const calls: Call[] = [];
  let lose = true;
  const lossy = deps(calls, {
    openTable: async (p: unknown) => {
      const id = (p as { client_op_id: string }).client_op_id;
      calls.push({ name: "open_table", arg: p });
      const dup = applied.has(id);
      applied.add(id);
      if (lose) { lose = false; throw new TypeError("Failed to fetch"); }
      return { table_id: "TBL-X", pos_entity_version: 8, idempotent: dup };
    },
  });
  await drainOffline(CTX, "reconnect", lossy);
  const { open } = await opsOf();
  assert.equal(open.status, "retryable");
  await localdb.operations.update(open.operation_id, { last_attempt_at: new Date(Date.now() - 600_000).toISOString() });
  __resetDrainLockForTests();
  await drainOffline(CTX, "reconnect", lossy);
  const after = await opsOf();
  assert.equal(after.open.status, "synced");
  assert.equal(after.round.status, "synced");
  assert.equal(applied.size, 1, "one client_op_id → one server application");
  assert.equal(calls.filter((c) => c.name === "round").length, 1);
});

test("G2-g case B: a refused order's recorded payment is never offered for a second collection; withdraw checks its receipt too", async () => {
  const { d1, d2, payOpId, open1 } = await incidentChain();
  await drainOffline(CTX, "reconnect", conflictingOpen([]));
  await assert.rejects(settleTableOffline({ sessionId: d1.local_session_id, method: "cash", covers: { orderIds: [], summary: false } }), (e: Error) => e.message === REFUSED_SESSION_SETTLE_MESSAGE);
  await assert.rejects(settleTableOffline({ sessionId: d1.local_session_id, method: "card", covers: { orderIds: [], summary: false } }), (e: Error) => e.message === REFUSED_SESSION_SETTLE_MESSAGE);
  assert.equal((await localdb.operations.toArray()).filter((o) => o.operation_type === "pay_table").length, 1, "no second payment op");
  // the operator's authorized withdrawal remains the only retirement; the pay's receipt is checked in pos_op_submissions
  const asked: ReceiptCheckInput[] = [];
  const w1 = await withdrawRefusedSession({ sessionId: d1.local_session_id, scope: SCOPE, actorUserId: "u1", checkReceipts: async (q) => { asked.push(q); return { kind: "none" }; } });
  assert.equal(w1.ok, true);
  const pay = (await getOperation(payOpId))!;
  assert.deepEqual([...asked[0].openClientOpIds].sort(), [open1.client_op_id, pay.client_op_id].sort());
  assert.equal(pay.status, "cancelled");
  assert.deepEqual(pay.withdrawal?.verified_against, ["pos_op_submissions", `authority:${WITHDRAW_PERMISSION}`]);
  assert.ok((await localdb.syncHistory.toArray()).some((h) => h.operation_id === payOpId && /collected offline/i.test(h.action_label)));
  // the chained order stays refused behind the withdrawn payment (no phantom resurrection)
  await reconcileRefusedSessions();
  assert.equal((await localdb.dineDrafts.get(d2.local_session_id))?.status, "refused");
  assert.equal((await floorOnline(SCOPE, freeRow())).row.occupied, false);
  assert.equal((await withdrawRefusedSession({ sessionId: d2.local_session_id, scope: SCOPE, actorUserId: "u1", checkReceipts: noReceipts })).ok, true);
});

test("G2-h the floor row and the bill panel agree: no occupied card over an empty bill, no settle hold, no 'held' state", async () => {
  await incidentChain();
  await drainOffline(CTX, "reconnect", conflictingOpen([]));
  const { row, work } = await floorOnline(SCOPE, freeRow());
  const p = await getOperationalTableBill(SCOPE, freeRow());
  assert.equal(row.occupied, p.bill.orders.length > 0, "card and bill tell the same story");
  // the bill panel's "held for review" condition (DineInWorkspace offlineWorkHeld) is false: nothing projects it
  assert.equal(work.touched.has("TBL-X") || work.syncingSettle.has("TBL-X") || work.structuralHold.has("TBL-X"), false);
});

test("G2-i Sync now: runs the drain and reports the pass's actual counts; a pass that did not run is never '0 synced'", async () => {
  await capturedSession();
  const run = (ctx: typeof CTX, d: PosTxnSyncDeps) => async () => { __resetDrainLockForTests(); await drainOffline(ctx, "operator-sync-now", d); return 1; };
  const bad = await runSyncNow(run(CTX, conflictingOpen([])), lastDrainReport);
  assert.equal(bad.ran, true);
  if (bad.ran) assert.deepEqual([bad.synced, bad.needsAttention, bad.failed], [0, 2, 0]);
  assert.match(bad.text, /0 synced · 2 still need attention · 0 failed/);
  assert.deepEqual(await runSyncNow(async () => 0, lastDrainReport), { ran: false, text: SYNC_NOW_NO_POS });
  assert.deepEqual(await runSyncNow(run({ ...CTX, online: false }, deps([])), lastDrainReport), { ran: false, text: SYNC_NOW_NOT_RUN });
  // operator retry of the refused open (table free on Breadee) → rebased → drained → real outcome "Synced."
  const { open } = await opsOf();
  const rr = await operatorRetry(open.operation_id, { actorUserId: "u1", rebaseDeps: rebaseDeps(freeRow({ pos_entity_version: 8 })), drain: run(CTX, deps([])) });
  assert.deepEqual(rr, { ok: true, text: "Synced." });
  assert.equal((await opsOf()).round.status, "synced");
  const ok = await runSyncNow(run(CTX, deps([])), lastDrainReport);
  assert.equal(ok.ran, true);
});
