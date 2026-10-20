// rc.13 — FINAL CLOSURE: behavioural tests for the four confirmed rc.12 native failures, at the level the
// native run exercised (real Dexie via fake-indexeddb, the REAL single orchestrator + handlers, the REAL
// capture engines and projections; only server RPCs are injected).
//
//   F1/F2  Dine-In causal model: SHIFT → TABLE OPEN → ROUNDS → SETTLEMENT → TABLE RELEASE; a paid bill never
//          resurrects after reconnect / canonical refresh / restart; a REFUSED settle is SETTLEMENT_CONFLICT
//          (bill active, never shown paid); a shift-less canonical bill fails closed BEFORE local success.
//   F3     customer identity: online-created customer remembered, server-search failure falls back to the
//          device's customers, pending-local merge (one result), auth: only an INVALIDATION signs out.
//   F4     Delivery customer identity is a durable order association: navigation, failed reads, remap,
//          restart never blank it.

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

import { localdb, cacheBill, type PosOfflineTxn } from "@/lib/offline/db";
import { getOperation, type OfflineOperation } from "@/lib/offline/operationLog";
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
  coveringSettleOp,
  SETTLE_REFUSED_MESSAGE,
} from "@/lib/offline/dineinOffline";
import {
  projectTableBill,
  settleStillCovers,
  shiftlessCanonicalOrders,
  shiftlessRefusal,
  tablesWithUnreflectedWork,
  getOperationalTableTotals,
  overlayTableTotals,
  SUMMARY_ONLY_SETTLE_MESSAGE,
} from "@/lib/offline/operationalProjection";
import { cacheCustomerMatches, mergePendingLocalMatches, searchCachedCustomers } from "@/lib/offline/customerCache";
import { captureCustomerUpsertOffline } from "@/lib/offline/customerOffline";
import { isAuthInvalidation, isAuthTransportError } from "@/lib/offline/offlineAuthority";
import {
  resolveOrderParties,
  rememberOrderParty,
  persistResolvedParties,
  mergePartyMaps,
  pruneOrderParties,
  orderPartyKey,
  ORDER_PARTY_RETENTION_MS,
} from "@/lib/offline/deliveryParties";
import { normalizePhoneE164 } from "@/lib/pos/phone";
import { getDeviceIdentity } from "@/lib/device";
import type { ActiveShift } from "@/types/pos";
import type { TableSummary } from "@/types/tables";
import type { DeliveryQueueOrder } from "@/lib/pos/deliveryOrderManagement";
import type { OrderParty } from "@/lib/pos/deliveryHistory";

const here = dirname(fileURLToPath(import.meta.url));
const src = (p: string) => readFileSync(resolve(here, "..", p), "utf8");

const DEV = getDeviceIdentity();
const SCOPE = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: DEV.device_id, terminalId: DEV.terminal_id ?? null };
const DSCOPE = { ...SCOPE, shiftId: "SRV-SHIFT-1" };
const OPSCOPE = { tenant_id: "t1", branch_id: "b1", device_id: DEV.device_id, terminal_id: DEV.terminal_id ?? "", cashier_user_id: "u1" };
const CTX = { ...SCOPE, online: true };
const SHIFT: ActiveShift = { id: "SRV-SHIFT-1", status: "open", opened_at: new Date(Date.now() - 3_600_000).toISOString(), opening_cash_amount: 50, branch_id: "b1" } as ActiveShift;
const PARTY_SCOPE = { tenantId: "t1", branchId: "b1" };

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
    openTable: async (p: unknown) => { calls.push({ name: "open_table", arg: p }); return { table_id: "TBL-1", pos_entity_version: 4 }; },
    submitRound: async (p: unknown) => { calls.push({ name: "round", arg: p }); return { order_id: "ORD-A", order_number: "N", batch_no: 1, appended: false, idempotent: false }; },
    orderItemMap: async () => [],
    payTable: async (a: unknown) => { calls.push({ name: "pay_table", arg: a }); return { ok: true, amount: 1, idempotent: false, pos_entity_version: 9 }; },
    payOrderOp: async (a: { orderId: string }) => { calls.push({ name: "pay_order", arg: a }); return { order_id: a.orderId, paid: true, amount: 1, idempotent: false }; },
    onAccountTable: async () => ({ ok: true, idempotent: false }),
    onAccountOrder: async (a: unknown) => { calls.push({ name: "on_account_order", arg: a }); return { ok: true, idempotent: false }; },
    upsertCustomer: async (a: { payload: Record<string, unknown> }) => { calls.push({ name: "customer", arg: a.payload }); return { customer_id: "SRV-CUST", address_id: "SRV-ADDR", is_new: true }; },
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

const table = (over: Partial<TableSummary> = {}): TableSummary =>
  ({ id: "TBL-1", name: "1", seats: 4, occupied: false, status: "available", canonical: true, configured: true, sort_order: 1, orders: 0, order_number: null, opened_at: null, total: null, collected: null, outstanding: null, currency: "LBP", mixed_currency: false, ...over }) as TableSummary;

/** A canonical cached bill of ONE order (shift_id as the server holds it). */
const canonicalBill = (orderId: string, shiftId: string | null, tableId = "TBL-1") => ({
  tableId,
  orders: [{ id: orderId, order_number: "260101-0001", status: "sent_to_kitchen", payment_status: "unpaid", pos_entity_version: 1, shift_id: shiftId, branch_id: "b1", tenant_id: "t1", subtotal: 355000, discount_amount: 0, total_amount: 355000, currency: "LBP", exchange_rate: null, created_at: new Date().toISOString(), lines: [{ id: "L1", menu_item_id: "m", name: "Pizza", quantity: 1, base_price: 355000, modifiers_total: 0, final_unit_price: 355000, line_total: 355000, kitchen_note: null, batch_no: 1, modifiers: [] }] }],
  subtotal: 355000, total: 355000, currency: "LBP", mixedCurrency: false, splitShift: false, batches: [1],
});

async function sentSession(tableId = "TBL-1") {
  const d = await openTableOffline({ scope: DSCOPE, tableId, tableName: tableId, seats: 4, currency: "LBP" });
  await addDraftLine(d.local_session_id, { menu_item_id: "m", name: "Pizza", base_price: 355000, quantity: 1, modifiers: [], kitchen_note: null });
  await sendRoundOffline(d.local_session_id);
  return d;
}

// ================================================================ F1/F2 — Dine-In causal model

test("G2 Dine-In lifecycle: offline round → pay → release → reconnect → canonical refresh → restart: never resurrects, one payment", async () => {
  const d = await sentSession();
  const settle = await settleTableOffline({ sessionId: d.local_session_id, method: "cash", covers: { orderIds: [], summary: false } });
  // LOCAL: the table is released (no active session), the settle covers the session.
  assert.equal(await getDineDraftForTable(SCOPE, "TBL-1"), null);
  const before = Date.now() - 1; // the map / bill the device showed BEFORE the drain
  await cacheBill("TBL-1", canonicalBill("ORD-A", "SRV-SHIFT-1"), "t1", "b1", before);

  const calls: Call[] = [];
  await drainOffline(CTX, "reconnect", deps(calls));
  assert.deepEqual(calls.map((c) => c.name), ["open_table", "round", "pay_table"], "SHIFT → OPEN → ROUND → SETTLE, in causal order");
  assert.equal((calls.find((c) => c.name === "round")?.arg as { shift_id: string }).shift_id, "SRV-SHIFT-1", "the order carries its shift");
  assert.equal((await getOperation(settle.operationId))?.status, "synced");

  // CANONICAL REFRESH IS A MERGE: the stale map (loaded before the settle synced) still shows the bill …
  const stale = table({ orders: 1, occupied: true, status: "occupied", total: 355000, order_number: "260101-0001" });
  const { touched, syncingSettle } = await tablesWithUnreflectedWork(SCOPE, before);
  assert.ok(touched.has("TBL-1"), "local work the map does not reflect keeps the projection online");
  assert.ok(!syncingSettle.has("TBL-1"), "the settle has landed — no hold");
  const shown = overlayTableTotals([stale], await getOperationalTableTotals(SCOPE, [stale], touched));
  assert.equal(shown[0].orders, 0, "the paid bill never resurrects behind a stale map");
  assert.equal(shown[0].status, "available");

  // … and a FRESH map (loaded after the settle) is taken raw — nothing projected over it.
  const fresh = await tablesWithUnreflectedWork(SCOPE, Date.now() + 1000);
  assert.equal(fresh.touched.size, 0);

  // reconcile + RESTART: the settled session stays settled; the table is reusable.
  await reconcileDineDraftsFromOperations();
  localdb.close();
  await localdb.open();
  await reconcileDineDraftsFromOperations();
  assert.equal(await getDineDraftForTable(SCOPE, "TBL-1"), null);
  assert.equal((await localdb.dineDrafts.get(d.local_session_id))?.status, "settled");

  // A NEW order on the SAME table chains after the settle and is a NEW bill.
  const d2 = await openTableOffline({ scope: DSCOPE, tableId: "TBL-1", tableName: "1", seats: 4, currency: "LBP", afterSettleOpId: settle.operationId });
  assert.notEqual(d2.local_session_id, d.local_session_id);
  assert.equal((await getDineDraftForTable(SCOPE, "TBL-1"))?.local_session_id, d2.local_session_id);

  // SECOND reconnect: zero business effects for the settled bill (exactly once).
  const again: Call[] = [];
  await drainOffline(CTX, "reconnect", deps(again));
  assert.equal(again.filter((c) => c.name === "pay_table" || c.name === "round").length, 0, "no second payment, no second round");
});

test("G3 a settle the SERVER REFUSED is SETTLEMENT_CONFLICT: the bill is ACTIVE + unpaid, never shown paid, the session reopens", async () => {
  const d = await sentSession();
  const s = await settleTableOffline({ sessionId: d.local_session_id, method: "cash", covers: { orderIds: [], summary: false } });
  await localdb.operations.update(s.operationId, { status: "needs_attention", last_error_code: "validation", last_error_message: "This order is not attached to an open shift" });
  const refused = (await getOperation(s.operationId))!;
  assert.equal(settleStillCovers(refused), false);
  assert.equal(await coveringSettleOp((await localdb.dineDrafts.get(d.local_session_id))!), undefined);

  await reconcileDineDraftsFromOperations();
  const reopened = await localdb.dineDrafts.get(d.local_session_id);
  assert.equal(reopened?.status, "open", "the bill is the table's active bill again");
  assert.equal(reopened?.settled_operation_id, null);

  const p = projectTableBill({ tableId: "TBL-1", mapRow: table({ orders: 1 }), canonical: null, draft: reopened!, ops: await localdb.operations.toArray() });
  assert.equal(p.settledLocally, false, "never shown as paid / released");
  assert.equal(p.settlementConflict, true);
  assert.equal(p.gross, 355000);
  assert.ok(p.attention >= 1);
});

test("G3 a refusal that PROVES the bill is already closed server-side still covers it (no double payment offered)", () => {
  for (const msg of ["Order already paid", "This table has no open order", "already settled"]) {
    assert.equal(settleStillCovers(op({ operation_id: "x", operation_type: "pay_table", status: "needs_attention", last_error_message: msg })), true, msg);
  }
  for (const st of ["pending", "blocked_dependency", "syncing", "synced"] as const) {
    assert.equal(settleStillCovers(op({ operation_id: "y", operation_type: "pay_table", status: st })), true, st);
  }
  assert.equal(settleStillCovers(op({ operation_id: "z", operation_type: "pay_table", status: "cancelled" })), false);
  assert.equal(settleStillCovers(op({ operation_id: "w", operation_type: "pay_table", status: "needs_attention", last_error_code: "dependency_failed", last_error_message: "A prerequisite could not be completed" })), false);
});

test("G3 a refused settle never reopens a session when a NEWER session is already open on that table", async () => {
  const d = await sentSession();
  const s = await settleTableOffline({ sessionId: d.local_session_id, method: "cash", covers: { orderIds: [], summary: false } });
  await openTableOffline({ scope: DSCOPE, tableId: "TBL-1", tableName: "1", seats: 4, currency: "LBP", afterSettleOpId: s.operationId });
  await localdb.operations.update(s.operationId, { status: "needs_attention", last_error_code: "validation", last_error_message: "refused" });
  await reconcileDineDraftsFromOperations();
  assert.equal((await localdb.dineDrafts.get(d.local_session_id))?.status, "settled", "one active session per table");
});

test("K(onan) reconcile chronology: of several refused sessions on one table only the NEWEST reopens; an open session blocks any reopen", async () => {
  const older = await sentSession();
  const s1 = await settleTableOffline({ sessionId: older.local_session_id, method: "cash", covers: { orderIds: [], summary: false } });
  const newer = await openTableOffline({ scope: DSCOPE, tableId: "TBL-1", tableName: "1", seats: 4, currency: "LBP", afterSettleOpId: s1.operationId });
  await addDraftLine(newer.local_session_id, { menu_item_id: "m", name: "Tea", base_price: 10, quantity: 1, modifiers: [], kitchen_note: null });
  await sendRoundOffline(newer.local_session_id);
  const s2 = await settleTableOffline({ sessionId: newer.local_session_id, method: "cash", covers: { orderIds: [], summary: false } });
  await localdb.dineDrafts.update(older.local_session_id, { created_at: new Date(Date.now() - 60_000).toISOString() });
  for (const id of [s1.operationId, s2.operationId]) await localdb.operations.update(id, { status: "needs_attention", last_error_code: "validation", last_error_message: "refused" });
  await reconcileDineDraftsFromOperations();
  assert.equal((await localdb.dineDrafts.get(newer.local_session_id))?.status, "open", "the newest refused session is the active bill");
  assert.equal((await localdb.dineDrafts.get(older.local_session_id))?.status, "settled", "never two active sessions on one table");
  await reconcileDineDraftsFromOperations();
  assert.equal((await localdb.dineDrafts.where("status").equals("open").count()), 1, "idempotent");
});

test("K(onan) an OLDER open session + a NEWER refused one: no second active session is created", async () => {
  const open = await sentSession();
  const other = await openTableOffline({ scope: DSCOPE, tableId: "TBL-1", tableName: "1", seats: 4, currency: "LBP" });
  await addDraftLine(other.local_session_id, { menu_item_id: "m", name: "Tea", base_price: 10, quantity: 1, modifiers: [], kitchen_note: null });
  await sendRoundOffline(other.local_session_id);
  const s = await settleTableOffline({ sessionId: other.local_session_id, method: "cash", covers: { orderIds: [], summary: false } });
  await localdb.operations.update(s.operationId, { status: "needs_attention", last_error_code: "validation", last_error_message: "refused" });
  await reconcileDineDraftsFromOperations();
  assert.equal((await localdb.dineDrafts.get(open.local_session_id))?.status, "open");
  assert.equal((await localdb.dineDrafts.get(other.local_session_id))?.status, "settled", "stays for review in the Sync Center");
});

test("K LOCAL SUCCESS RULE: re-tapping Pay / On Account on a REFUSED settle never marks the bill paid again", async () => {
  const d = await sentSession();
  const s = await settleTableOffline({ sessionId: d.local_session_id, method: "cash", covers: { orderIds: [], summary: false } });
  await localdb.operations.update(s.operationId, { status: "needs_attention", last_error_code: "validation", last_error_message: "This order is not attached to an open shift" });
  await reconcileDineDraftsFromOperations();
  await assert.rejects(settleTableOffline({ sessionId: d.local_session_id, method: "cash", covers: { orderIds: [], summary: false } }), (e: Error) => e.message === SETTLE_REFUSED_MESSAGE);
  assert.equal((await localdb.dineDrafts.get(d.local_session_id))?.status, "open", "still the active unpaid bill");
  assert.equal((await getOperation(s.operationId))?.status, "needs_attention", "the refusal is untouched (no silent retry)");
  const dl = src("src/lib/offline/dineinOffline.ts");
  assert.equal((dl.match(/if \(!settleStillCovers\(existing\)\) throw new Error\(SETTLE_REFUSED_MESSAGE\)/g) ?? []).length, 2, "pay_table AND on_account_table");
});

test("K summary-only bills fail closed for offline full payment / On Account (shift unprovable); split already refused", () => {
  const dw = src("src/screens/pos/DineInWorkspace.tsx");
  const i = dw.indexOf("const offlineSettleTarget");
  const body = dw.slice(i, i + 3200);
  assert.match(body, /if \(p\.summaryOnly\) return \{ ok: false, reason: SUMMARY_ONLY_SETTLE_MESSAGE \}/);
  assert.ok(body.indexOf("SUMMARY_ONLY_SETTLE_MESSAGE") < body.indexOf("ok: true,"), "refused before any capture target is built");
  assert.ok((dw.match(/offlineSettleTarget\(table\)/g) ?? []).length >= 2, "both the Pay and the On Account paths use the guarded target");
  assert.match(dw, /if \(p\.summaryOnly\) return \{ ok: false, reason: "Part of this bill was sent before this device went offline\. Reconnect to split it\." \}/);
  assert.match(SUMMARY_ONLY_SETTLE_MESSAGE, /Reconnect to settle it/);
});

test("K scope change / read failure clears the floor overlay AND the settle hold (no cross-OU leftovers)", () => {
  const dw = src("src/screens/pos/DineInWorkspace.tsx");
  assert.match(dw, /if \(projScopeKey\.current !== key\) \{\s*projScopeKey\.current = key;\s*setOpTotals\(new Map\(\)\);\s*setSyncingSettle\(new Set\(\)\);/);
  assert.match(dw, /\.catch\(\(\) => \{\s*if \(live\) \{\s*setOpTotals\(new Map\(\)\);\s*setSyncingSettle\(new Set\(\)\);/);
});

test("K persistence completes BEFORE success is reported (customer create / conflict / Delivery send)", () => {
  const cp = src("src/state/customerPicker.ts");
  assert.doesNotMatch(cp, /void rememberCustomer\(/);
  assert.equal((cp.match(/await rememberCustomer\(/g) ?? []).length, 2);
  const dw = src("src/screens/pos/DeliveryWorkspace.tsx");
  assert.doesNotMatch(dw, /void rememberOrderParty\(/);
  const online = dw.indexOf("outcome.result.order_id, {");
  assert.ok(online > 0 && online < dw.indexOf("setSubmitted({ order: authoritative"), "the online association is persisted before the order is reported");
});

test("K auth invalidation (returned OR thrown) also clears the cached offline authority", () => {
  const s = src("src/state/session.ts");
  assert.match(s, /if \(!session && r\.error && isAuthInvalidation\(r\.error\)\) \{\s*await clearAuthorityCache\(\)/);
  assert.match(s, /if \(isAuthInvalidation\(e\)\) \{\s*await clearAuthorityCache\(\)/);
});

test("LOCAL SUCCESS RULE: a canonical bill held WITHOUT a shift is detected before any local settlement", () => {
  const bill = canonicalBill("OLD-ORD", null);
  const hits = shiftlessCanonicalOrders(bill as never, null);
  assert.deepEqual(hits, [{ id: "OLD-ORD", order_number: "260101-0001" }]);
  assert.match(shiftlessRefusal(hits), /#260101-0001.*not attached to a shift on the server.*cannot be settled — offline or online/);
  assert.deepEqual(shiftlessCanonicalOrders(canonicalBill("OK", "SRV-SHIFT-1") as never, null), [], "a bill with its shift is settleable");
  // Exempt: a bound session with a shift whose round APPENDS to it (the server coalesces the shift in).
  const draft = { local_session_id: "S", canonical_order_id: "OLD-ORD", shift_id: "SRV-SHIFT-1", shift_local: null, rounds: [{ seq: 1 }] } as never;
  assert.deepEqual(shiftlessCanonicalOrders(bill as never, draft), []);
  // Not exempt: a bound session with no round yet (nothing will attach the shift).
  assert.equal(shiftlessCanonicalOrders(bill as never, { ...(draft as object), rounds: [] } as never).length, 1);
});

test("LOCAL SUCCESS RULE wiring: the offline settle / split paths refuse a shift-less bill before capture", () => {
  const dw = src("src/screens/pos/DineInWorkspace.tsx");
  const settleIdx = dw.indexOf("const shiftless = shiftlessCanonicalOrders(p.bill, draft)");
  assert.ok(settleIdx > 0, "offline settle target guard present");
  assert.match(dw.slice(settleIdx, settleIdx + 300), /return \{ ok: false, reason: shiftlessRefusal\(shiftless\) \}/);
  assert.ok((dw.match(/shiftlessCanonicalOrders\(/g) ?? []).length >= 2, "the split path is guarded too");
});

test("ONLINE merge: unsynced settle → table held (no append / pay on a bill mid-settle); refused settle → not held", async () => {
  await localdb.operations.add(op({ operation_id: "paytable:p", operation_type: "pay_table", payload: { table_id: "TBL-7" } }));
  await localdb.operations.add(op({ operation_id: "paytable:r", operation_type: "pay_table", status: "needs_attention", last_error_message: "refused", payload: { table_id: "TBL-8" } }));
  await localdb.operations.add(op({ operation_id: "paytable:s", operation_type: "pay_table", status: "synced", synced_at: new Date(Date.now() - 60_000).toISOString(), payload: { table_id: "TBL-9" } }));
  const { touched, syncingSettle } = await tablesWithUnreflectedWork(SCOPE, Date.now());
  assert.deepEqual([...syncingSettle].sort(), ["TBL-7"]);
  assert.ok(touched.has("TBL-7") && touched.has("TBL-8"));
  assert.ok(!touched.has("TBL-9"), "work already reflected in the map is not re-projected");
  // OU wall: another cashier's / OU's ops never touch this floor.
  await localdb.operations.add(op({ operation_id: "paytable:o", operation_type: "pay_table", scope: { ...OPSCOPE, branch_id: "OTHER" }, payload: { table_id: "TBL-X" } }));
  assert.ok(!(await tablesWithUnreflectedWork(SCOPE, Date.now())).touched.has("TBL-X"));
});

test("ONLINE merge wiring: post-drain refresh event + the settle-sync hold in every table action gate", () => {
  const rd = src("src/lib/offline/reconnectDrain.ts");
  assert.match(rd, /export const OFFLINE_DRAINED_EVENT = "breadee:offline-drained"/);
  assert.match(rd, /dispatchEvent\(new Event\(OFFLINE_DRAINED_EVENT\)\)/);
  const dw = src("src/screens/pos/DineInWorkspace.tsx");
  assert.match(dw, /addEventListener\(OFFLINE_DRAINED_EVENT/);
  assert.match(dw, /tablesWithUnreflectedWork\(/);
  for (const gate of ["openGate", "payGate", "addItemsGate"]) {
    const i = dw.indexOf(`const ${gate}`);
    assert.ok(i > 0, gate);
    assert.match(dw.slice(i, i + 900), /settleSyncHoldReason/, `${gate} holds a table whose settle is syncing`);
  }
  const del = src("src/screens/pos/DeliveryWorkspace.tsx");
  assert.match(del, /addEventListener\(OFFLINE_DRAINED_EVENT/);
});

// ================================================================ F3 — customer identity + auth

test("C a customer created ONLINE is remembered under its normalised phone and found offline, in any typed form, after restart", async () => {
  // rememberCustomer() = cacheCustomerMatches(normalised) in the session scope; exercised here with the scope explicit.
  await cacheCustomerMatches([{ id: "SRV-NEW", name: "Rana", phone: "03 123 456", phone_e164: normalizePhoneE164("03 123 456") }], PARTY_SCOPE);
  localdb.close();
  await localdb.open();
  for (const q of ["03123456", "+961 3 123 456", "3123456", "Rana"]) {
    assert.deepEqual((await searchCachedCustomers(PARTY_SCOPE, q)).map((h) => h.id), ["SRV-NEW"], q);
  }
  assert.deepEqual(await searchCachedCustomers({ tenantId: "t1", branchId: "OTHER" }, "03123456"), [], "OU wall");
  const cp = src("src/state/customerPicker.ts");
  assert.match(cp, /upsertCustomer\([\s\S]{0,400}rememberCustomer\(/, "online create remembers the customer");
  assert.match(cp, /resolveCustomerConflict\([\s\S]{0,400}rememberCustomer\(/, "conflict resolution remembers the customer");
});

test("C a server search FAILURE answers from the device's customers (never an error / sign-in)", () => {
  const cc = src("src/lib/offline/customerCache.ts");
  const i = cc.indexOf("export async function searchCustomersOfflineAware");
  const body = cc.slice(i, i + 1400);
  assert.match(body, /try \{\s*results = await searchCustomers\(query\);\s*\} catch \{[\s\S]*?return searchCachedCustomers\(scope, query\);/);
});

test("C pending-local + server results are ONE logical customer (dedupe by id and normalised phone)", () => {
  const server = [{ id: "SRV-CUST", name: "Walk-in", phone: "78900000", phone_e164: normalizePhoneE164("78900000") }];
  const local = [
    { id: "LOCAL-1", name: "Walk-in", phone: "+961 78 900 000", phone_e164: normalizePhoneE164("+961 78 900 000"), pending_local: true },
    { id: "LOCAL-2", name: "New guy", phone: "71000000", phone_e164: normalizePhoneE164("71000000"), pending_local: true },
    { id: "CACHED", name: "Cached", phone: "70000000", phone_e164: normalizePhoneE164("70000000"), pending_local: false },
  ];
  assert.deepEqual(mergePendingLocalMatches(server, local).map((m) => m.id), ["SRV-CUST", "LOCAL-2"]);
  assert.deepEqual(mergePendingLocalMatches(server, [{ ...server[0], pending_local: true }]).map((m) => m.id), ["SRV-CUST"]);
  // Konan — two pending-local rows for ONE person (same normalised phone) → one result.
  const twins = [
    { id: "LOCAL-A", name: "Sara", phone: "76 111 222", phone_e164: normalizePhoneE164("76 111 222"), pending_local: true },
    { id: "LOCAL-B", name: "Sara", phone: "+961 76 111 222", phone_e164: null, pending_local: true },
    { id: "LOCAL-A", name: "Sara", phone: "76111222", phone_e164: null, pending_local: true },
  ];
  assert.deepEqual(mergePendingLocalMatches([], twins).map((m) => m.id), ["LOCAL-A"]);
});

test("C offline create → sync → ONE canonical customer, normalised phone, local refs still resolve", async () => {
  const c = await captureCustomerUpsertOffline({ scope: SCOPE, upsert: { branch_id: "b1", phone: "+961 71 222 333", name: "Nour" }, clientOpId: "c1c1c1c1-0000-4000-8000-0000000013a1" });
  assert.equal((await searchCachedCustomers(PARTY_SCOPE, "71222333")).length, 1, "found before sync");
  const calls: Call[] = [];
  await drainOffline(CTX, "reconnect", deps(calls));
  assert.equal(calls.filter((x) => x.name === "customer").length, 1, "created once");
  assert.deepEqual((await searchCachedCustomers(PARTY_SCOPE, "071 222 333")).map((h) => h.id), ["SRV-CUST"]);
  assert.equal((await localdb.entityMap.get(c.localCustomerId as string))?.canonical_id, "SRV-CUST");
  const again: Call[] = [];
  await drainOffline(CTX, "reconnect", deps(again));
  assert.equal(again.length, 0, "second drain: zero effects");
});

test("AUTH: only a definitive INVALIDATION is a sign-out; a network / gateway / customer-query failure never is", () => {
  const invalidations = [
    { code: "refresh_token_not_found", status: 400, message: "Invalid Refresh Token: Refresh Token Not Found" },
    { code: "refresh_token_already_used", status: 400, message: "Invalid Refresh Token: Already Used" },
    { code: "session_not_found", status: 403, message: "Session from session_id claim in JWT does not exist" },
    { code: "user_banned", status: 403, message: "User is banned" },
    { status: 400, message: "Invalid Refresh Token: Refresh Token Not Found" },
    { status: 401, message: "invalid_grant" },
  ];
  for (const e of invalidations) assert.equal(isAuthInvalidation(e), true, JSON.stringify(e));
  const notAuth = [
    new TypeError("Failed to fetch"),
    { name: "AuthRetryableFetchError", status: 0, message: "Failed to fetch" },
    { status: 502, message: "Bad Gateway" },
    { status: 503, message: "Service Unavailable" },
    { status: 504, message: "Gateway Timeout" },
    { status: 401, message: "JWT expired" }, // an expired ACCESS token (customer query) — refresh will fix it
    { status: 500, message: "Internal Server Error" },
    null,
  ];
  for (const e of notAuth) assert.equal(isAuthInvalidation(e), false, JSON.stringify(e));
  assert.equal(isAuthTransportError(new TypeError("Failed to fetch")), true);
});

test("AUTH wiring: init() keeps a valid 7-day authority on any non-invalidation refresh failure; invalidation → Sign In", () => {
  const s = src("src/state/session.ts");
  assert.match(s, /if \(!session && r\.error && !isAuthInvalidation\(r\.error\)\) \{\s*apply\(decision, true\);\s*return;/);
  assert.match(s, /catch \(e\) \{[\s\S]{0,200}if \(isAuthInvalidation\(e\)\) \{\s*await clearAuthorityCache\(\)\.catch\(\(\) => undefined\);\s*set\(\{ loading: false, offlineMode: false, userId: null, authNotice: null \}\);\s*return;\s*\}\s*apply\(decision, true\);/);
  // apply(): an EXPIRED authority still gets the controlled re-authorization message (7-day policy intact).
  assert.match(s, /authNotice: d\.kind === "expired" \? REAUTH_MESSAGE/);
});

// ================================================================ F4 — Delivery customer identity

const drow = (over: Partial<DeliveryQueueOrder> = {}): DeliveryQueueOrder => ({ id: "SRV-D1", order_number: "261020-0001", status: "sent_to_kitchen", payment_status: "unpaid", payment_method: null, subtotal: 1, discount_amount: null, total_amount: 1, currency: "LBP", customer_id: "SRV-CUST", address_id: "SRV-ADDR", notes: null, shift_id: "SRV-SHIFT-1", created_at: new Date().toISOString(), ...over });
const PARTY: OrderParty = { customerName: "Rana", customerPhone: "03123456", addressText: "Home · Hamra" };
const empty = new Map<string, OrderParty>();

test("F4 the order association survives Add Items → Orders when every server / cache read fails (List == Detail == Receipt)", async () => {
  await rememberOrderParty(PARTY_SCOPE, "SRV-D1", { ...PARTY, customerId: "SRV-CUST", addressId: "SRV-ADDR" });
  const who = await resolveOrderParties([drow()], empty, PARTY_SCOPE);
  assert.deepEqual(who.get("SRV-D1"), PARTY);
});

test("F4 an OFFLINE order's association (local id) follows the remap to its canonical id after sync", async () => {
  await localdb.posOfflineTxns.add({ local_txn_id: "LOCAL-D1", client_op_id: crypto.randomUUID(), tenant_id: "t1", branch_id: "b1", device_id: DEV.device_id, terminal_id: "", cashier_user_id: "u1", cashier_user_name: "A", shift_id: "SRV-SHIFT-1", created_at: new Date().toISOString(), order_payload: { order_type: "delivery", items: [] }, payment_intent: null, currency: "LBP", total: 1, status: "synced", attempts: 1, server_order_id: "SRV-D1" } as PosOfflineTxn);
  await rememberOrderParty(PARTY_SCOPE, "LOCAL-D1", { ...PARTY, customerId: "LOCAL-CUST", addressId: "LOCAL-ADDR" });
  const who = await resolveOrderParties([drow({ customer_id: "SRV-CUST" })], empty, PARTY_SCOPE);
  assert.deepEqual(who.get("SRV-D1"), PARTY, "same customer under the canonical order");
  // also via the entity map alone (no txn link)
  await localdb.posOfflineTxns.clear();
  await localdb.entityMap.add({ local_entity_id: "LOCAL-D1", entity_type: "order", canonical_id: "SRV-D1", resolved_at: new Date().toISOString(), tenant_id: "t1", branch_id: "b1", device_id: DEV.device_id, cashier_user_id: "u1", terminal_id: null });
  assert.deepEqual((await resolveOrderParties([drow()], empty, PARTY_SCOPE)).get("SRV-D1"), PARTY);
});

test("F4 restart keeps the association; the canonical source still wins field-wise; OU wall holds", async () => {
  await persistResolvedParties(PARTY_SCOPE, [drow()], new Map([["SRV-D1", PARTY]]));
  localdb.close();
  await localdb.open();
  assert.deepEqual((await resolveOrderParties([drow()], empty, PARTY_SCOPE)).get("SRV-D1"), PARTY);
  const server = new Map([["SRV-D1", { customerName: "Rana H.", customerPhone: null, addressText: null } as OrderParty]]);
  assert.deepEqual((await resolveOrderParties([drow()], server, PARTY_SCOPE)).get("SRV-D1"), { ...PARTY, customerName: "Rana H." });
  const other = await resolveOrderParties([drow()], empty, { tenantId: "t1", branchId: "OTHER" });
  assert.deepEqual(other.get("SRV-D1"), { customerName: null, customerPhone: null, addressText: null });
});

test("F4 a refresh MERGES: a blank result never erases a known party; a blank write never erases the association", async () => {
  const prev = new Map([["SRV-D1", PARTY]]);
  const blank = new Map([["SRV-D1", { customerName: null, customerPhone: null, addressText: null } as OrderParty]]);
  assert.deepEqual(mergePartyMaps(prev, blank).get("SRV-D1"), PARTY);
  const changed = new Map([["SRV-D1", { ...PARTY, addressText: "Work · Verdun" }]]);
  assert.equal(mergePartyMaps(prev, changed).get("SRV-D1")?.addressText, "Work · Verdun", "a changed address is followed");
  await rememberOrderParty(PARTY_SCOPE, "SRV-D1", { ...PARTY, customerId: "SRV-CUST", addressId: "SRV-ADDR" });
  await persistResolvedParties(PARTY_SCOPE, [drow()], blank);
  await rememberOrderParty(PARTY_SCOPE, "SRV-D1", { customerName: null, customerPhone: null, addressText: null });
  assert.deepEqual((await resolveOrderParties([drow()], empty, PARTY_SCOPE)).get("SRV-D1"), PARTY);
});

test("F4 bounded growth: stale associations are pruned by key range, recent ones kept", async () => {
  await rememberOrderParty(PARTY_SCOPE, "RECENT", PARTY);
  await localdb.snapshots.put({ key: orderPartyKey("OLD"), tenant_id: "t1", branch_id: "b1", data: PARTY, cached_at: new Date(Date.now() - ORDER_PARTY_RETENTION_MS - 1000).toISOString() });
  await localdb.snapshots.put({ key: "tables:b1", tenant_id: "t1", branch_id: "b1", data: [], cached_at: new Date(0).toISOString() });
  assert.equal(await pruneOrderParties(Date.now(), true), 1);
  assert.ok(await localdb.snapshots.get(orderPartyKey("RECENT")));
  assert.equal(await localdb.snapshots.get(orderPartyKey("OLD")), undefined);
  assert.ok(await localdb.snapshots.get("tables:b1"), "other snapshots untouched");
});

test("F4 wiring: the association is written at offline AND online send, merged on refresh, written through", () => {
  const dw = src("src/screens/pos/DeliveryWorkspace.tsx");
  assert.ok((dw.match(/rememberOrderParty\(\{ tenantId: pos\.tenantId, branchId \}/g) ?? []).length >= 2, "offline + online send");
  assert.match(dw, /rememberOrderParty\([^)]*localId/);
  assert.match(dw, /rememberOrderParty\([^)]*outcome\.result\.order_id/);
  assert.match(dw, /setParties\(\(prev\) => mergePartyMaps\(prev, who\)\)/);
  assert.match(dw, /persistResolvedParties\(\{ tenantId: pos\.tenantId, branchId \}, rows, who\)/);
});
