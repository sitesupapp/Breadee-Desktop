// rc.14 — FINAL TARGETED RECOVERY: behavioural tests for the rc.13 native failures that were NEW code
// defects (not historical contamination), at the level the native run exercised (real Dexie via
// fake-indexeddb, the REAL orchestrator + handlers + migration + shift store; only server RPCs injected).
//
//   F4  Takeaway / Delivery sale under a shift opened OFFLINE replayed its RAW LOCAL shift id
//       ("Shift not found for this tenant/branch") — one shift-identity contract, fail-closed replay,
//       snapshot writer/restore guard, one-time evidence-gated recovery, exactly-once + second reconnect.
//   F3  Orders history offline: snapshot + local orders, never a raw fetch, honest "limited" state.
//   F1/F2/F5  historical shift-less bills: classified + actionable explanation, never re-attributed.

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

import { localdb, type PosOfflineTxn } from "@/lib/offline/db";
import { getOperation, type OfflineOperation } from "@/lib/offline/operationLog";
import { drainOffline, __resetDrainLockForTests } from "@/lib/offline/orchestrator";
import type { PosTxnSyncDeps } from "@/lib/offline/posTxnSync";
import { useShift, shiftNet } from "@/state/shift";
import { clearPosSessionSnapshot, savePosSessionSnapshot } from "@/lib/offline/posSession";
import { createLocalPendingShift } from "@/lib/offline/pendingShift";
import { resolveOperationalShift, isLocalShiftId } from "@/lib/offline/shiftIdentity";
import { resolveShiftRef, openTableOffline, addDraftLine, sendRoundOffline, settleTableOffline } from "@/lib/offline/dineinOffline";
import { classifyOperation, dispositionOf, recoverHistoricalReplayFailures, buildEra } from "@/lib/offline/queueForensics";
import { migrateLegacyToOperations } from "@/lib/offline/migration";
import { loadOrdersHistoryOfflineAware, readOrdersHistoryLocal, mergeOrdersHistory, OFFLINE_HISTORY_LIMITED_NOTE } from "@/lib/offline/ordersHistoryOffline";
import { historicalShiftlessNotice } from "@/lib/offline/operationalProjection";
import { classifyError } from "@/lib/pos/errors";
import { getDeviceIdentity } from "@/lib/device";
import type { ShiftOpenOrder } from "@/lib/pos/shiftOrderSummary";

const here = dirname(fileURLToPath(import.meta.url));
const src = (p: string) => readFileSync(resolve(here, "..", p), "utf8");

const DEV = getDeviceIdentity();
const SCOPE = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: DEV.device_id, terminalId: DEV.terminal_id ?? null };
const OPSCOPE = { tenant_id: "t1", branch_id: "b1", device_id: DEV.device_id, terminal_id: DEV.terminal_id ?? "", cashier_user_id: "u1" };
const CTX = { ...SCOPE, online: true };

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
  let n = 0;
  return {
    submit: async (p: { shift_id?: string }) => {
      calls.push({ name: "submit", arg: p });
      if (p.shift_id !== "SRV-SHIFT-NEW" && p.shift_id !== "SRV-SHIFT-1") throw new Error("Shift not found for this tenant/branch");
      n += 1;
      return { order_id: `SRV-ORD-${n}`, order_number: `N-${n}` };
    },
    pay: async (a: unknown) => { calls.push({ name: "pay", arg: a }); return {}; },
    openShift: async () => { calls.push({ name: "open_shift", arg: null }); return { shiftId: "SRV-SHIFT-NEW", reused: false }; },
    openTable: async (p: unknown) => { calls.push({ name: "open_table", arg: p }); return { table_id: "TBL-1", pos_entity_version: 4 }; },
    submitRound: async (p: unknown) => { calls.push({ name: "round", arg: p }); return { order_id: "ORD-A", order_number: "N", batch_no: 1, appended: false, idempotent: false }; },
    orderItemMap: async () => [],
    payTable: async (a: unknown) => { calls.push({ name: "pay_table", arg: a }); return { ok: true, amount: 1, idempotent: false, pos_entity_version: 9 }; },
    payOrderOp: async (a: { orderId: string }) => ({ order_id: a.orderId, paid: true, amount: 1, idempotent: false }),
    onAccountTable: async () => ({ ok: true, idempotent: false }),
    onAccountOrder: async () => ({ ok: true, idempotent: false }),
    upsertCustomer: async () => ({ customer_id: "SRV-CUST", address_id: null, is_new: true }),
    editOrderLine: async () => ({ ok: true, idempotent: false, replacement_order_item_id: "R", pos_entity_version: 1 }),
    endShiftOp: async (a: { shiftId: string }) => ({ shift_id: a.shiftId, idempotent: false }),
    isTransport: (e: unknown) => e instanceof TypeError,
    hasSession: async () => true,
    ...over,
  } as unknown as PosTxnSyncDeps;
}

function txn(over: Partial<PosOfflineTxn> & Pick<PosOfflineTxn, "local_txn_id" | "shift_id">): PosOfflineTxn {
  return {
    client_op_id: crypto.randomUUID(), tenant_id: "t1", branch_id: "b1", device_id: DEV.device_id, terminal_id: DEV.terminal_id ?? "",
    cashier_user_id: "u1", cashier_user_name: "Mahdi", created_at: new Date().toISOString(),
    order_payload: { branch_id: "b1", order_type: "takeaway", shift_id: over.shift_id, items: [{ name: "Pizza", base_price: 355000, quantity: 1, modifiers: [] }] },
    payment_intent: { method: "cash", currency: "LBP" }, currency: "LBP", total: 355000, status: "queued", attempts: 0, ...over,
  } as PosOfflineTxn;
}

const pendingShift = () => createLocalPendingShift({ tenantId: "t1", branchId: "b1", cashierUserId: "u1", openingCashAmount: 0, currency: "LBP" });

// ================================================================ F4 — shift identity

test("A2 ONE shift-identity contract: canonical as captured; offline-opened → shift_local until known, then ITS OWN canonical", async () => {
  assert.deepEqual(await resolveOperationalShift("SRV-SHIFT-1"), { shift_id: "SRV-SHIFT-1", shift_local: null });
  const p = await pendingShift();
  assert.equal(await isLocalShiftId(p.local_shift_id), true);
  assert.equal(await isLocalShiftId("SRV-SHIFT-1"), false);
  assert.deepEqual(await resolveOperationalShift(p.local_shift_id), { shift_id: null, shift_local: p.local_shift_id });
  // resolved only through the entity map (pendingShifts not yet mirrored) → its own canonical id
  await localdb.entityMap.add({ local_entity_id: p.local_shift_id, entity_type: "shift", canonical_id: "SRV-SHIFT-NEW", resolved_at: new Date().toISOString(), tenant_id: "t1", branch_id: "b1", device_id: DEV.device_id, cashier_user_id: "u1", terminal_id: DEV.terminal_id ?? null });
  assert.deepEqual(await resolveOperationalShift(p.local_shift_id), { shift_id: "SRV-SHIFT-NEW", shift_local: null });
  assert.deepEqual(await resolveShiftRef(p.local_shift_id), await resolveOperationalShift(p.local_shift_id), "Dine-In delegates — no divergence");
});

test("G2 F4 reproduction: sales under an OFFLINE-opened shift — with AND without the local marker — reach the canonical shift exactly once", async () => {
  const p = await pendingShift();
  // the rc.13 poisoned capture: raw local shift id, NO pending marker (a restored snapshot dropped it)
  await localdb.posOfflineTxns.add(txn({ local_txn_id: "T-NOMARK", shift_id: p.local_shift_id, pending_shift_local_id: null, created_at: new Date(Date.now() - 2000).toISOString() }));
  // the correct capture: local shift id WITH its marker
  await localdb.posOfflineTxns.add(txn({ local_txn_id: "T-MARK", shift_id: p.local_shift_id, pending_shift_local_id: p.local_shift_id }));
  const calls: Call[] = [];
  await drainOffline(CTX, "reconnect", deps(calls));
  const submits = calls.filter((c) => c.name === "submit").map((c) => (c.arg as { shift_id: string }).shift_id);
  assert.ok(calls.findIndex((c) => c.name === "open_shift") < calls.findIndex((c) => c.name === "submit"), "SHIFT → ORDERS");
  assert.deepEqual(submits, ["SRV-SHIFT-NEW", "SRV-SHIFT-NEW"], "never the raw local id — no 'Shift not found'");
  for (const id of ["mig:txn:T-NOMARK", "mig:txn:T-MARK"]) assert.equal((await getOperation(id))?.status, "synced", id);
  assert.equal(calls.filter((c) => c.name === "pay").length, 2, "one payment each");
  const again: Call[] = [];
  await drainOffline(CTX, "reconnect", deps(again));
  assert.equal(again.length, 0, "second reconnect: zero effects");
});

test("A5 FAIL CLOSED: a raw local shift with no canonical mapping is never sent (blocked while pending, parked SHIFT_MAPPING_MISSING when refused)", async () => {
  const p = await pendingShift();
  await localdb.pendingShifts.update(p.local_shift_id, { status: "needs_attention" });
  await localdb.operations.add({
    operation_id: "sale-x", operation_type: "takeaway_sale", schema_version: 1, scope: OPSCOPE, created_at: new Date().toISOString(), client_op_id: crypto.randomUUID(),
    local_entity_id: "TX", canonical_entity_id: null, dependency_ids: [], depends_on_local_entities: [],
    payload: { order_payload: { order_type: "takeaway", shift_id: p.local_shift_id, items: [] }, payment_intent: null },
    status: "pending", retry_count: 0, last_attempt_at: null, last_error_code: null, last_error_message: null, result_meta: null, synced_at: null,
  } as OfflineOperation);
  const calls: Call[] = [];
  await drainOffline(CTX, "reconnect", deps(calls));
  assert.equal(calls.filter((c) => c.name === "submit").length, 0, "nothing sent");
  const o = await getOperation("sale-x");
  assert.equal(o?.status, "needs_attention");
  assert.equal(o?.last_error_code, "shift_mapping_missing");
  assert.match(o?.last_error_message ?? "", /SHIFT_MAPPING_MISSING/);
  // Konan — a current-build SHIFT_MAPPING_MISSING park is MANUAL REVIEW, never "retry safe", never auto-recovered.
  assert.equal(classifyOperation(o!).category, "SHIFT_MAPPING_MISSING");
  assert.equal(dispositionOf(o!, "SHIFT_MAPPING_MISSING", null), "MANUAL_REVIEW");
  assert.deepEqual(await recoverHistoricalReplayFailures(), []);
  assert.equal((await getOperation("sale-x"))?.status, "needs_attention");
});

test("QUEUE RECOVERY: the rc.13 'Shift not found' sale is re-queued ONCE (no server order, own shift mapped) and lands exactly once", async () => {
  const p = await pendingShift();
  const calls0: Call[] = [];
  await drainOffline(CTX, "reconnect", deps(calls0)); // the shift opens → mapping L → SRV-SHIFT-NEW
  assert.equal((await localdb.entityMap.get(p.local_shift_id))?.canonical_id, "SRV-SHIFT-NEW");
  const failed = (id: string, over: Partial<OfflineOperation> = {}): OfflineOperation => ({
    operation_id: id, operation_type: "takeaway_sale", schema_version: 1, scope: OPSCOPE, created_at: new Date().toISOString(), client_op_id: crypto.randomUUID(),
    local_entity_id: id, canonical_entity_id: null, dependency_ids: [], depends_on_local_entities: [],
    payload: { order_payload: { order_type: "takeaway", shift_id: p.local_shift_id, items: [] }, payment_intent: { method: "cash", currency: "LBP" }, paid: false },
    status: "needs_attention", retry_count: 1, last_attempt_at: null, last_error_code: "shift_closed", last_error_message: "Shift not found for this tenant/branch", result_meta: null, synced_at: null,
    captured_build: "a83ba16ad7767d43b177e25a8c4bb8238999cebc", ...over,
  } as OfflineOperation);
  await localdb.operations.bulkAdd([
    failed("rc13-sale"),
    failed("rc13-has-order", { canonical_entity_id: "SRV-ORD-X" }), // a server order exists → ambiguous → NOT auto-retried
    failed("rc13-unknown-shift", { payload: { order_payload: { order_type: "takeaway", shift_id: "NOT-A-LOCAL-SHIFT", items: [] }, payment_intent: null } }),
    // Konan — an otherwise IDENTICAL sale captured by ANOTHER build (rc.12 / unknown / a future build) is never touched.
    failed("rc12-twin", { captured_build: "b51d4fbaec610209ef2909c1e1d8d9a995db2ed9" }),
    failed("unknown-build-twin", { captured_build: null }),
    failed("future-build-twin", { captured_build: "ffff000" }),
    // …and neither is its parked dependent.
    { ...failed("rc12-dependent"), operation_type: "pay_order", dependency_ids: ["rc12-twin"], last_error_code: "dependency_failed", last_error_message: "rc12-twin", captured_build: "b51d4fbaec610209ef2909c1e1d8d9a995db2ed9" } as OfflineOperation,
  ]);
  assert.equal(classifyOperation((await getOperation("rc13-sale"))!).category, "RC13_SHIFT_MAPPING");
  assert.equal(dispositionOf((await getOperation("rc13-sale"))!, "RC13_SHIFT_MAPPING", null), "RETRY_SAFE");
  for (const id of ["rc12-twin", "unknown-build-twin", "future-build-twin"]) {
    assert.notEqual(classifyOperation((await getOperation(id))!).category, "RC13_SHIFT_MAPPING", `${id} is not the rc.13 defect`);
  }
  const recovered = await recoverHistoricalReplayFailures();
  assert.ok(recovered.includes("rc13-sale"));
  for (const id of ["rc13-has-order", "rc13-unknown-shift", "rc12-twin", "unknown-build-twin", "future-build-twin", "rc12-dependent"]) {
    assert.ok(!recovered.includes(id), `${id} untouched`);
    assert.equal((await getOperation(id))?.status, "needs_attention", `${id} stays for review`);
  }
  const calls: Call[] = [];
  await drainOffline(CTX, "reconnect", deps(calls));
  const submits = calls.filter((c) => c.name === "submit");
  assert.equal(submits.length, 1, "exactly one submit");
  assert.equal((submits[0].arg as { shift_id: string }).shift_id, "SRV-SHIFT-NEW", "its OWN canonical shift");
  assert.equal((await getOperation("rc13-sale"))?.status, "synced");
  assert.equal((await getOperation("rc13-has-order"))?.status, "needs_attention");
  assert.deepEqual(await recoverHistoricalReplayFailures(), [], "never twice");
  const again: Call[] = [];
  await drainOffline(CTX, "reconnect", deps(again));
  assert.equal(again.length, 0, "second reconnect: zero effects");
});

test("A3/A4 a restored snapshot can never present an offline LOCAL shift as canonical (rc.13 poisoned snapshot)", async () => {
  const p = await pendingShift();
  savePosSessionSnapshot({ version: 1, source: "server", savedAt: Date.now(), device_id: DEV.device_id, tenant_id: "t1", cashier_user_id: "u1", branch_id: "b1", branch_name: "Main Branch", currency: "LBP", shift: { id: p.local_shift_id, status: "open", opened_at: p.opened_at, opening_cash_amount: 0, branch_id: "b1" } });
  shiftNet.findOpenShift = async () => { throw new TypeError("Failed to fetch"); };
  await useShift.getState().refresh("t1", "u1", "b1");
  assert.equal(useShift.getState().shift?.id, p.local_shift_id);
  assert.equal(useShift.getState().pendingLocalId, p.local_shift_id, "restored as the PENDING shift (marker kept), never as a server shift");
  // once that shift synced, the same snapshot restores under its OWN canonical id
  await localdb.pendingShifts.update(p.local_shift_id, { status: "synced", server_shift_id: "SRV-SHIFT-NEW" });
  useShift.getState().clear();
  await useShift.getState().refresh("t1", "u1", "b1");
  assert.equal(useShift.getState().shift?.id, "SRV-SHIFT-NEW");
  assert.equal(useShift.getState().pendingLocalId, null);
});

test("A2 wiring: Takeaway + Delivery capture through the ONE resolver; the snapshot writer refuses a pending shift", () => {
  const pw = src("src/screens/pos/PosWorkspace.tsx");
  assert.equal((pw.match(/const shiftRef = await resolveOperationalShift\(capturedShiftId\)/g) ?? []).length, 2, "Send + Pay");
  assert.doesNotMatch(pw, /const pendingLocalId = shiftSnap\.pendingLocalId/, "the UI flag is no longer the identity source");
  assert.match(pw, /if \(shiftStore\.pendingLocalId\) return;/);
  assert.match(pw, /isLocalShiftId\(shift\.id\)\.then\(\(local\) => \{\s*if \(!live \|\| local\) return;/);
  const dw = src("src/screens/pos/DeliveryWorkspace.tsx");
  assert.match(dw, /const shiftRef = await resolveOperationalShift\(snapshot\.shiftId\)/);
  assert.match(dw, /pending_shift_local_id: shiftRef\.shift_local/);
});

test("migration bridge: a re-queued (pay after send) sale keeps its remap fields (rc.13 dropped them)", async () => {
  const p = await pendingShift();
  await localdb.posOfflineTxns.add(txn({ local_txn_id: "T-SEND", shift_id: p.local_shift_id, pending_shift_local_id: p.local_shift_id, payment_intent: null }));
  await drainOffline(CTX, "reconnect", deps([]));
  assert.equal((await getOperation("mig:txn:T-SEND"))?.status, "synced");
  await localdb.posOfflineTxns.update("T-SEND", { status: "queued", payment_intent: { method: "cash", currency: "LBP" } });
  await migrateLegacyToOperations();
  const o = await getOperation("mig:txn:T-SEND");
  assert.equal(o?.status, "pending");
  assert.equal((o?.payload as { shift_local?: string }).shift_local, p.local_shift_id, "shift_local preserved");
  assert.ok(o?.canonical_entity_id, "canonical order kept — the pay replays against it, never a re-submit");
  const calls: Call[] = [];
  await drainOffline(CTX, "reconnect", deps(calls));
  assert.deepEqual(calls.map((c) => c.name), ["pay"], "only the payment — exactly once");
});

test("Sync Center era: rc.13 builds are labelled rc.13", () => {
  assert.equal(buildEra("a83ba16abc", "zzz"), "RC13");
});

// ================================================================ F3 — Orders history offline

const row = (over: Partial<ShiftOpenOrder> & Pick<ShiftOpenOrder, "id">): ShiftOpenOrder => ({
  order_number: "261020-0001", order_type: "takeaway", status: "completed", payment_status: "paid", payment_method: "cash", subtotal: 1, discount_amount: 0,
  total_amount: 1, currency: "LBP", table_id: null, customer_id: null, customer_name: null, customer_phone: null, cashier_user_id: "u1", staff_name: "M", notes: null,
  created_at: new Date(Date.now() - 3_600_000).toISOString(), ...over,
});
const offlineDeps = { reachable: async () => false, loadShift: async () => { throw new TypeError("Failed to fetch — must not be called offline"); }, loadDay: async () => { throw new TypeError("Failed to fetch — must not be called offline"); } };

test("G5 Orders history OFFLINE: cached canonical + local pending + locally-paid — no network call, nothing raw", async () => {
  // online once: the snapshot is written through
  await loadOrdersHistoryOfflineAware({ kind: "shift", tenantId: "t1", branchId: "b1", shiftId: "SRV-SHIFT-1" }, { reachable: async () => true, loadShift: async () => [row({ id: "SRV-A" }), row({ id: "SRV-B", payment_status: "unpaid", status: "sent_to_kitchen" })] });
  await localdb.posOfflineTxns.add(txn({ local_txn_id: "T-OFF-1", shift_id: "SRV-SHIFT-1" }));
  await localdb.operations.add({ operation_id: "payorder:b", operation_type: "pay_order", schema_version: 1, scope: OPSCOPE, created_at: new Date().toISOString(), client_op_id: "c", local_entity_id: null, canonical_entity_id: null, dependency_ids: [], depends_on_local_entities: [], payload: { order_id: "SRV-B", order_local: null, method: "cash", currency: "LBP" }, status: "pending", retry_count: 0, last_attempt_at: null, last_error_code: null, last_error_message: null, result_meta: null, synced_at: null } as OfflineOperation);
  const d = await openTableOffline({ scope: { ...SCOPE, shiftId: "SRV-SHIFT-1" }, tableId: "TBL-2", tableName: "2", seats: 2, currency: "LBP" });
  await addDraftLine(d.local_session_id, { menu_item_id: "m", name: "Tea", base_price: 100, quantity: 2, modifiers: [], kitchen_note: null });
  await sendRoundOffline(d.local_session_id);
  await settleTableOffline({ sessionId: d.local_session_id, method: "cash", covers: { orderIds: [], summary: false } });

  const res = await loadOrdersHistoryOfflineAware({ kind: "shift", tenantId: "t1", branchId: "b1", shiftId: "SRV-SHIFT-1" }, offlineDeps);
  assert.equal(res.offline, true);
  assert.equal(res.limited, false);
  const byId = new Map(res.orders.map((o) => [o.id, o]));
  assert.ok(byId.has("SRV-A"), "cached canonical order");
  assert.equal(byId.get("SRV-B")?.payment_status, "paid", "a payment captured here is never hidden by an older UNPAID snapshot");
  assert.equal(byId.get("SRV-B")?.local_pending, true);
  assert.equal(byId.get("T-OFF-1")?.order_number, "OFF-T-OFF-", "offline sale with its provisional ref (same as its receipt)");
  const dine = byId.get(d.local_session_id);
  assert.equal(dine?.order_type, "dine_in");
  assert.equal(dine?.payment_status, "paid", "locally-paid pending-sync bill moved to history as Paid");
  assert.equal(dine?.total_amount, 200);
});

test("G5 nothing cached for the scope: local orders + an honest LIMITED flag (never a fake empty), OU wall", async () => {
  await localdb.posOfflineTxns.add(txn({ local_txn_id: "T-HERE", shift_id: "SRV-SHIFT-1" }));
  await localdb.posOfflineTxns.add(txn({ local_txn_id: "T-OTHER-OU", shift_id: "SRV-SHIFT-1", branch_id: "OTHER" }));
  const today = new Date();
  const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const res = await loadOrdersHistoryOfflineAware({ kind: "day", tenantId: "t1", branchId: "b1", day }, offlineDeps);
  assert.equal(res.offline, true);
  assert.equal(res.limited, true);
  assert.deepEqual(res.orders.map((o) => o.id), ["T-HERE"]);
  assert.match(OFFLINE_HISTORY_LIMITED_NOTE, /Offline — showing only orders taken on this device/);
});

test("G5 the shift's offline-local twin: sales captured under the LOCAL shift show under its canonical shift after sync", async () => {
  const p = await pendingShift();
  await localdb.posOfflineTxns.add(txn({ local_txn_id: "T-L", shift_id: p.local_shift_id, pending_shift_local_id: p.local_shift_id, status: "queued" }));
  await localdb.pendingShifts.update(p.local_shift_id, { status: "synced", server_shift_id: "SRV-SHIFT-NEW" });
  const res = await readOrdersHistoryLocal({ kind: "shift", tenantId: "t1", branchId: "b1", shiftId: "SRV-SHIFT-NEW" });
  assert.deepEqual(res.orders.map((o) => o.id), ["T-L"]);
});

test("mergeOrdersHistory is pure: canonical wins, refused/voided never overlaid, oldest first", () => {
  const a = row({ id: "A", payment_status: "unpaid", created_at: "2026-10-20T10:00:00Z" });
  const v = row({ id: "V", status: "voided", payment_status: "unpaid", created_at: "2026-10-20T09:00:00Z" });
  const out = mergeOrdersHistory([a, v], [row({ id: "A", total_amount: 999 })], new Map([["A", "paid"], ["V", "paid"]]));
  assert.deepEqual(out.map((o) => o.id), ["V", "A"]);
  assert.equal(out[1].total_amount, 1, "canonical row wins");
  assert.equal(out[1].payment_status, "paid");
  assert.equal(out[0].payment_status, "unpaid", "a voided order is never shown paid");
});

test("G5 wiring: the Orders modal + shift-orders store use the offline-aware loader (no server-only read left)", () => {
  const m = src("src/components/pos/OrdersModal.tsx");
  assert.match(m, /loadOrdersHistoryOfflineAware\(\{ kind: "day"/);
  assert.doesNotMatch(m, /loadOrdersForDay\(/);
  assert.match(m, /role="note"/);
  const s = src("src/state/shiftOrders.ts");
  assert.match(s, /loadOrdersHistoryOfflineAware\(\{ kind: "shift"/);
  assert.doesNotMatch(s, /loadShiftOrders\(/);
});

// ================================================================ F1 / F2 / F5 — historical shift-less

test("G4/G10 historical shift-less refusals are classified with an actionable explanation (never re-attributed)", () => {
  for (const msg of ["The primary bill is not attached to a shift.", "Selected orders are not attached to a shift"]) {
    const c = classifyError(new Error(msg));
    assert.equal(c.kind, "historical_shiftless", msg);
    assert.match(c.hint ?? "", /created without a valid shift and cannot be paid, moved or merged automatically/);
  }
  assert.equal(classifyError(new Error("This order is not attached to an open shift")).kind, "no_shift", "the existing order-creation refusal is unchanged");
  assert.match(historicalShiftlessNotice([{ order_number: "261019-0003" }]), /#261019-0003.*without a valid shift.*online manager reconciliation/);
  const dw = src("src/screens/pos/DineInWorkspace.tsx");
  assert.match(dw, /const hits = shiftlessCanonicalOrders\(tables\.bill, null\)/);
  assert.match(dw, /if \(g\.allowed && historicalShiftlessReason\) return \{ allowed: false, reason: historicalShiftlessReason \}/);
  // 1.0.38 — the wrapped gate is now the offline-capturable one (see offline-1038-movemerge); the
  // historical shift-less refusal still wraps Move AND Merge (1.0.38 WS-F: inside the unsynced-work hold).
  assert.match(dw, /move: (unsynced\()?historical\(offlineAware/);
  assert.match(dw, /merge: (unsynced\()?historical\(offlineAware/);
});
