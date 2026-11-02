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
import { listRefusedSessions, reconcileRefusedSessions, withdrawRefusedSession, WITHDRAW_NEEDS_CONNECTION, WITHDRAW_RECEIPT_FOUND, WITHDRAW_NOT_YOURS, WITHDRAW_STATE_CHANGED } from "@/lib/offline/refusedSessions";
import { loadSyncSummary } from "@/components/sync/syncCenterModel";
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
const noReceipts = async () => [] as string[];

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
  const asked: { open: string[]; rounds: string[] }[] = [];
  const r = await withdrawRefusedSession({
    sessionId: d.local_session_id, scope: SCOPE, actorUserId: "u1",
    checkReceipts: async (q) => { asked.push({ open: q.openClientOpIds, rounds: q.roundClientOpIds }); return []; },
  });
  assert.equal(r.ok, true);
  const { open, round } = await opsOf();
  assert.deepEqual(asked, [{ open: [open.client_op_id], rounds: [round.client_op_id] }], "every op's server receipt was checked");
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
  assert.deepEqual(await withdrawRefusedSession({ sessionId: d.local_session_id, scope: SCOPE, actorUserId: "u1", checkReceipts: async () => [round.client_op_id] }), { ok: false, reason: WITHDRAW_RECEIPT_FOUND });
  assert.deepEqual(await withdrawRefusedSession({ sessionId: d.local_session_id, scope: SCOPE, actorUserId: "u1", checkReceipts: async () => { throw new TypeError("Failed to fetch"); } }), { ok: false, reason: WITHDRAW_NEEDS_CONNECTION });
  assert.equal(JSON.stringify(await localdb.operations.toArray()), before);
  assert.equal((await localdb.dineDrafts.get(d.local_session_id))?.status, "refused");
  // CAS: the open was re-queued (operator Try again) between the server check and the commit
  const { open } = await opsOf();
  const r = await withdrawRefusedSession({
    sessionId: d.local_session_id, scope: SCOPE, actorUserId: "u1",
    checkReceipts: async () => { await requeueOperation(open.operation_id); return []; },
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
