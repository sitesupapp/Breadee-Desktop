// Phase D — offline SETTLE engine (pay_table / pay_order) through the ONE orchestrator + its
// pos_pay_table / pos_pay_order deps. Proves exactly-once replay (client_op_id), the already-
// settled-by-another-action CONFLICT (never a silent second charge), transport retryability,
// dependency remap of an offline-created table/order, and 5-dim scope exactness. Real Dexie
// (fake-indexeddb) + fake deps, no network.

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

import { localdb } from "@/lib/offline/db";
import { addOperation, getOperation, OPERATION_SCHEMA_VERSION } from "@/lib/offline/operationLog";
import type { OfflineOperation } from "@/lib/offline/operationLog";
import { resolveEntity } from "@/lib/offline/entityMap";
import { drainOffline, __resetDrainLockForTests } from "@/lib/offline/orchestrator";
import type { PosTxnSyncDeps } from "@/lib/offline/posTxnSync";
import { openTableOffline, addDraftLine, sendRoundOffline, settleTableOffline, findSettleOpForSession, tableOnAccountOffline } from "@/lib/offline/dineinOffline";
import { orderOnAccountOffline, takeawaySaleOpId } from "@/lib/offline/orderOnAccountOffline";

const DSCOPE = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1", shiftId: "sh1" };

const SCOPE = { tenant_id: "t1", branch_id: "b1", device_id: "dev1", terminal_id: "term1", cashier_user_id: "u1" };
const CTX = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1", online: true };

type PayTableCall = { tableId: string; method: string; clientOpId: string };
type PayOrderCall = { orderId: string; method: string; clientOpId: string; expectedVersion: number | null };

function deps(over: Partial<PosTxnSyncDeps> = {}): { deps: PosTxnSyncDeps; tableCalls: PayTableCall[]; orderCalls: PayOrderCall[] } {
  const tableCalls: PayTableCall[] = [];
  const orderCalls: PayOrderCall[] = [];
  const d: PosTxnSyncDeps = {
    submit: async () => ({ order_id: "x", order_number: "y" }),
    pay: async () => ({}),
    openShift: async () => ({ shiftId: "s", reused: false }),
    openTable: async () => ({ table_id: "T", pos_entity_version: 1 }),
    submitRound: async () => ({ order_id: "O", order_number: "N", batch_no: 1, appended: true, idempotent: false }),
    voidRefund: async () => ({ order_id: "O", status: "refunded", refunded: true, refund_usd: 0, refund_id: null, idempotent: false }),
    payTable: async (a) => { tableCalls.push({ tableId: a.tableId, method: a.method, clientOpId: a.clientOpId }); return { ok: true, amount: 5, idempotent: false }; },
    payOrderOp: async (a) => { orderCalls.push({ orderId: a.orderId, method: a.method, clientOpId: a.clientOpId, expectedVersion: a.expectedVersion }); return { order_id: a.orderId, paid: true, amount: 5, idempotent: false }; },
    onAccountTable: async () => ({ ok: true, idempotent: false }),
    onAccountOrder: async () => ({ ok: true, idempotent: false }),
    isTransport: (e) => e instanceof TypeError,
    hasSession: async () => true,
    ...over,
  };
  return { deps: d, tableCalls, orderCalls };
}

function op(type: "pay_table" | "pay_order" | "on_account_table" | "on_account_order", payload: Record<string, unknown>, over: Partial<OfflineOperation> = {}): OfflineOperation {
  return {
    operation_id: over.operation_id ?? ("op-" + Math.random().toString(36).slice(2)),
    operation_type: type,
    schema_version: OPERATION_SCHEMA_VERSION,
    scope: over.scope ?? SCOPE,
    created_at: new Date().toISOString(),
    client_op_id: over.client_op_id ?? ("cop-" + Math.random().toString(36).slice(2)),
    local_entity_id: null,
    canonical_entity_id: null,
    dependency_ids: over.dependency_ids ?? [],
    depends_on_local_entities: over.depends_on_local_entities ?? [],
    payload,
    status: "pending",
    retry_count: 0,
    last_attempt_at: null,
    last_error_code: null,
    last_error_message: null,
    result_meta: null,
    synced_at: null,
    ...over,
  };
}

beforeEach(async () => {
  await Promise.all([localdb.operations.clear(), localdb.entityMap.clear(), localdb.syncHistory.clear(), localdb.dineDrafts.clear()]);
  __resetDrainLockForTests();
});

test("pay_table: a configured table settles once; client_op_id threaded", async () => {
  const o = op("pay_table", { table_id: "TBL-1", table_local: null, method: "cash", currency: "LBP", table_name: "5" }, { client_op_id: "cop-pt" });
  await addOperation(o);
  const { deps: d, tableCalls } = deps();
  const r = await drainOffline(CTX, "test", d);
  assert.deepEqual(r.drained, [o.operation_id]);
  assert.equal(tableCalls.length, 1);
  assert.deepEqual(tableCalls[0], { tableId: "TBL-1", method: "cash", clientOpId: "cop-pt" });
  assert.equal((await getOperation(o.operation_id))?.status, "synced");
});

test("pay_table: idempotent replay settles (exactly once)", async () => {
  const o = op("pay_table", { table_id: "TBL-1", table_local: null, method: "cash", currency: "USD" });
  await addOperation(o);
  const { deps: d } = deps({ payTable: async () => ({ ok: true, amount: 5, idempotent: true }) });
  const r = await drainOffline(CTX, "test", d);
  assert.deepEqual(r.drained, [o.operation_id]);
  assert.equal((await getOperation(o.operation_id))?.result_meta?.idempotent, true);
});

for (const msg of ["This order is already paid.", "No open order on this table to pay."]) {
  test(`pay_table: already-settled-by-another-action is a CONFLICT (never a silent second charge): ${msg.slice(0, 24)}`, async () => {
    const o = op("pay_table", { table_id: "TBL-1", table_local: null, method: "cash", currency: "USD" });
    await addOperation(o);
    const { deps: d } = deps({ payTable: async () => { throw new Error(msg); } });
    const r = await drainOffline(CTX, "test", d);
    assert.equal(r.drained.length, 0);
    assert.equal(r.needsAttention.length, 1);
    const saved = await getOperation(o.operation_id);
    assert.equal(saved?.status, "needs_attention");
    assert.equal(saved?.last_error_code, "settle_conflict");
  });
}

test("pay_table: transport failure stays retryable", async () => {
  const o = op("pay_table", { table_id: "TBL-1", table_local: null, method: "cash", currency: "USD" });
  await addOperation(o);
  const { deps: d } = deps({ payTable: async () => { throw new TypeError("Failed to fetch"); } });
  const r = await drainOffline(CTX, "test", d);
  assert.equal(r.needsAttention.length, 0);
  assert.equal((await getOperation(o.operation_id))?.status, "retryable");
});

test("pay_table: an offline-created ad-hoc table is DEPENDENCY_BLOCKED until its open-table op resolves", async () => {
  const o = op("pay_table", { table_id: null, table_local: "sess-local", method: "cash", currency: "USD" }, { depends_on_local_entities: ["sess-local"] });
  await addOperation(o);
  // No mapping yet → blocked, the settle is not sent.
  const { deps: d, tableCalls } = deps();
  let r = await drainOffline(CTX, "test", d);
  assert.equal(tableCalls.length, 0);
  assert.equal((await getOperation(o.operation_id))?.status, "blocked_dependency");
  // Resolve the session's canonical table (as the open-table op would) → the settle now remaps + sends.
  await resolveEntity({ local_entity_id: "sess-local", entity_type: "table", canonical_id: "SRV-TBL", resolved_at: new Date().toISOString(), tenant_id: "t1", branch_id: "b1", device_id: "dev1", cashier_user_id: "u1", terminal_id: "term1" });
  r = await drainOffline(CTX, "test", d);
  assert.deepEqual(r.drained, [o.operation_id]);
  assert.equal(tableCalls[0].tableId, "SRV-TBL");
});

test("pay_table: a foreign-OU mapping NEVER satisfies the dependency (fail-closed remap)", async () => {
  const o = op("pay_table", { table_id: null, table_local: "sess-local", method: "cash", currency: "USD" }, { depends_on_local_entities: ["sess-local"] });
  await addOperation(o);
  // Mapping exists but under a DIFFERENT OU → must not resolve.
  await resolveEntity({ local_entity_id: "sess-local", entity_type: "table", canonical_id: "SRV-TBL", resolved_at: new Date().toISOString(), tenant_id: "t1", branch_id: "OTHER-OU", device_id: "dev1", cashier_user_id: "u1", terminal_id: "term1" });
  const { deps: d, tableCalls } = deps();
  const r = await drainOffline(CTX, "test", d);
  assert.equal(tableCalls.length, 0);
  assert.equal((await getOperation(o.operation_id))?.status, "blocked_dependency");
  assert.equal(r.drained.length, 0);
});

test("pay_order: settles once; client_op_id + expected_version threaded", async () => {
  const o = op("pay_order", { order_id: "ORD-1", order_local: null, method: "visa", currency: "USD", expected_version: 7, order_number: "A-9" }, { client_op_id: "cop-po" });
  await addOperation(o);
  const { deps: d, orderCalls } = deps();
  const r = await drainOffline(CTX, "test", d);
  assert.deepEqual(r.drained, [o.operation_id]);
  assert.deepEqual(orderCalls[0], { orderId: "ORD-1", method: "visa", clientOpId: "cop-po", expectedVersion: 7 });
});

test("scope-exact: a settle op from another terminal is NOT drained here", async () => {
  const o = op("pay_table", { table_id: "TBL-1", table_local: null, method: "cash", currency: "USD" }, { scope: { ...SCOPE, terminal_id: "OTHER" } });
  await addOperation(o);
  let called = 0;
  const { deps: d } = deps({ payTable: async () => { called++; return { ok: true, amount: 5, idempotent: false }; } });
  const r = await drainOffline(CTX, "test", d);
  assert.equal(called, 0);
  assert.equal((await getOperation(o.operation_id))?.status, "pending");
});

// ---------------- On-account (receivable) engine ----------------

test("on_account_table: puts a table on a cached customer's account once; conflict → needs_attention", async () => {
  const good = op("on_account_table", { table_id: "TBL-1", table_local: null, customer_id: "CUST-1", customer_local: null, amount: 12, method: "cash" }, { client_op_id: "cop-at" });
  await addOperation(good);
  let calls: { tableId: string; customerId: string; clientOpId: string }[] = [];
  const { deps: d } = deps({ onAccountTable: async (a) => { calls.push({ tableId: a.tableId, customerId: a.customerId, clientOpId: a.clientOpId }); return { ok: true, idempotent: false }; } });
  const r1 = await drainOffline(CTX, "t", d);
  assert.deepEqual(r1.drained, [good.operation_id]);
  assert.deepEqual(calls[0], { tableId: "TBL-1", customerId: "CUST-1", clientOpId: "cop-at" });

  __resetDrainLockForTests();
  await localdb.operations.clear();
  const conflicted = op("on_account_table", { table_id: "TBL-1", table_local: null, customer_id: "CUST-1", customer_local: null, amount: 12, method: "cash" });
  await addOperation(conflicted);
  const { deps: d2 } = deps({ onAccountTable: async () => { throw new Error("This order is already paid."); } });
  const r2 = await drainOffline(CTX, "t", d2);
  assert.equal(r2.needsAttention.length, 1);
  assert.equal((await getOperation(conflicted.operation_id))?.last_error_code, "settle_conflict");
});

test("on_account_order: a missing customer is a terminal validation refusal (never a blind receivable)", async () => {
  const o = op("on_account_order", { order_id: "ORD-1", order_local: null, customer_id: null, customer_local: null, amount: 5, method: "cash" });
  await addOperation(o);
  let called = 0;
  const { deps: d } = deps({ onAccountOrder: async () => { called++; return { ok: true, idempotent: false }; } });
  const r = await drainOffline(CTX, "t", d);
  assert.equal(called, 0);
  assert.equal((await getOperation(o.operation_id))?.status, "needs_attention");
});

test("on_account_order: an offline-created customer (customer_local) blocks until it resolves", async () => {
  const o = op("on_account_order", { order_id: "ORD-1", order_local: null, customer_id: null, customer_local: "cust-local", amount: 5, method: "cash" }, { depends_on_local_entities: ["cust-local"] });
  await addOperation(o);
  const { deps: d } = deps();
  let r = await drainOffline(CTX, "t", d);
  assert.equal((await getOperation(o.operation_id))?.status, "blocked_dependency");
  await resolveEntity({ local_entity_id: "cust-local", entity_type: "customer", canonical_id: "CUST-9", resolved_at: new Date().toISOString(), tenant_id: "t1", branch_id: "b1", device_id: "dev1", cashier_user_id: "u1", terminal_id: "term1" });
  let captured = "";
  const { deps: d2 } = deps({ onAccountOrder: async (a) => { captured = a.customerId; return { ok: true, idempotent: false }; } });
  r = await drainOffline(CTX, "t", d2);
  assert.deepEqual(r.drained, [o.operation_id]);
  assert.equal(captured, "CUST-9");
});

// ---------------- Order (Takeaway/Delivery) on-account capture + chain ----------------

const ORDSCOPE = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1" };

test("orderOnAccountOffline: requires an order and a customer", async () => {
  await assert.rejects(() => orderOnAccountOffline({ scope: ORDSCOPE, orderId: null, orderLocal: null, migOpId: null, customerId: "C1", amount: 5, method: "cash" }), /order is required/i);
  await assert.rejects(() => orderOnAccountOffline({ scope: ORDSCOPE, orderId: "ORD-1", orderLocal: null, migOpId: null, customerId: null, amount: 5, method: "cash" }), /customer is required/i);
});

test("orderOnAccountOffline: canonical order + cached customer settles once; double-tap idempotent", async () => {
  const cap = await orderOnAccountOffline({ scope: ORDSCOPE, orderId: "ORD-1", orderLocal: null, migOpId: null, customerId: "C1", amount: 5, method: "cash" });
  assert.equal(cap.alreadyCaptured, false);
  let calls: { orderId: string; customerId: string }[] = [];
  const { deps: d } = deps({ onAccountOrder: async (a) => { calls.push({ orderId: a.orderId, customerId: a.customerId }); return { ok: true, idempotent: false }; } });
  const r = await drainOffline(CTX, "t", d);
  assert.deepEqual(r.drained, [cap.operationId]);
  assert.deepEqual(calls[0], { orderId: "ORD-1", customerId: "C1" });
  const again = await orderOnAccountOffline({ scope: ORDSCOPE, orderId: "ORD-1", orderLocal: null, migOpId: null, customerId: "C1", amount: 5, method: "cash" });
  assert.equal(again.alreadyCaptured, true);
});

test("takeaway chain: an offline order's receivable settles only AFTER the order syncs", async () => {
  // A takeaway_sale op (as migration.ts would create it): id mig:txn:tx1, local_entity_id tx1.
  const saleId = takeawaySaleOpId("tx1");
  await addOperation({
    operation_id: saleId, operation_type: "takeaway_sale", schema_version: OPERATION_SCHEMA_VERSION, scope: SCOPE,
    created_at: new Date(Date.now() - 1000).toISOString(), client_op_id: "cop-tx1", local_entity_id: "tx1", canonical_entity_id: null,
    dependency_ids: [], depends_on_local_entities: [], payload: { order_payload: { items: [] }, payment_intent: null, paid: true },
    status: "pending", retry_count: 0, last_attempt_at: null, last_error_code: null, last_error_message: null, result_meta: null, synced_at: null,
  });
  const cap = await orderOnAccountOffline({ scope: ORDSCOPE, orderId: null, orderLocal: "tx1", migOpId: saleId, customerId: "C1", amount: 7, method: "cash" });

  const order: string[] = [];
  let settledOrderId = "";
  const { deps: d } = deps({
    submit: async () => { order.push("sale"); return { order_id: "SRV-ORD", order_number: "N1" }; },
    onAccountOrder: async (a) => { order.push("oa"); settledOrderId = a.orderId; return { ok: true, idempotent: false }; },
  });
  const r = await drainOffline({ tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1", online: true }, "reconnect", d);
  assert.ok(order.indexOf("sale") < order.indexOf("oa"), "receivable settles after the order syncs");
  assert.equal(settledOrderId, "SRV-ORD"); // order_local tx1 remapped to the canonical order
  assert.ok(r.drained.includes(cap.operationId));
});

// ---------------- Dine-in CAPTURE → drain (open → round → settle dependency chain) ----------------

test("settleTableOffline: captures a pay_table op that depends on the session's open + rounds", async () => {
  const draft = await openTableOffline({ scope: DSCOPE, tableId: "TBL-9", tableName: "9", currency: "USD" });
  await addDraftLine(draft.local_session_id, { menu_item_id: "m1", name: "Burger", base_price: 10, quantity: 1, modifiers: [], kitchen_note: null });
  await sendRoundOffline(draft.local_session_id);
  const cap = await settleTableOffline({ sessionId: draft.local_session_id, method: "cash" });
  assert.equal(cap.alreadyCaptured, false);
  const settleOp = await getOperation(cap.operationId);
  assert.equal(settleOp?.operation_type, "pay_table");
  // Depends on the open op + the round op (so it replays only after they sync).
  const fresh = await localdb.dineDrafts.get(draft.local_session_id);
  assert.ok(settleOp?.dependency_ids.includes(fresh!.open_operation_id));
  assert.ok(settleOp?.dependency_ids.includes(fresh!.rounds[0].operation_id));
  assert.equal((settleOp?.payload as { table_id?: string }).table_id, "TBL-9");
});

test("settleTableOffline: double-tap collapses to ONE pay_table op", async () => {
  const draft = await openTableOffline({ scope: DSCOPE, tableId: "TBL-9", tableName: "9", currency: "USD" });
  await addDraftLine(draft.local_session_id, { menu_item_id: "m1", name: "Burger", base_price: 10, quantity: 1, modifiers: [], kitchen_note: null });
  await sendRoundOffline(draft.local_session_id);
  const a = await settleTableOffline({ sessionId: draft.local_session_id, method: "cash" });
  const b = await settleTableOffline({ sessionId: draft.local_session_id, method: "cash" });
  assert.equal(a.operationId, b.operationId);
  assert.equal(b.alreadyCaptured, true);
  assert.equal(await localdb.operations.where("operation_type").equals("pay_table").count(), 1);
  assert.ok(await findSettleOpForSession(draft.local_session_id));
});

test("settleTableOffline: refuses a table with nothing sent", async () => {
  const draft = await openTableOffline({ scope: DSCOPE, tableId: "TBL-9", tableName: "9", currency: "USD" });
  await assert.rejects(() => settleTableOffline({ sessionId: draft.local_session_id, method: "cash" }), /nothing has been sent/i);
});

test("tableOnAccountOffline: captures an on_account_table op depending on the session + a customer", async () => {
  const draft = await openTableOffline({ scope: DSCOPE, tableId: "TBL-9", tableName: "9", currency: "USD" });
  await addDraftLine(draft.local_session_id, { menu_item_id: "m1", name: "Burger", base_price: 10, quantity: 1, modifiers: [], kitchen_note: null });
  await sendRoundOffline(draft.local_session_id);
  const cap = await tableOnAccountOffline({ sessionId: draft.local_session_id, customerId: "CUST-1", amount: 10, method: "cash" });
  assert.equal(cap.alreadyCaptured, false);
  const o = await getOperation(cap.operationId);
  assert.equal(o?.operation_type, "on_account_table");
  const fresh = await localdb.dineDrafts.get(draft.local_session_id);
  assert.ok(o?.dependency_ids.includes(fresh!.open_operation_id));
  assert.ok(o?.dependency_ids.includes(fresh!.rounds[0].operation_id));
  const p = o?.payload as Record<string, unknown>;
  assert.equal(p.customer_id, "CUST-1");
  assert.equal(p.amount, 10);
  // double-tap idempotent
  const cap2 = await tableOnAccountOffline({ sessionId: draft.local_session_id, customerId: "CUST-1", amount: 10, method: "cash" });
  assert.equal(cap2.alreadyCaptured, true);
  assert.equal(await localdb.operations.where("operation_type").equals("on_account_table").count(), 1);
});

test("tableOnAccountOffline: refuses without a customer or with nothing sent", async () => {
  const draft = await openTableOffline({ scope: DSCOPE, tableId: "TBL-9", tableName: "9", currency: "USD" });
  await assert.rejects(() => tableOnAccountOffline({ sessionId: draft.local_session_id, customerId: "CUST-1", amount: 10, method: "cash" }), /nothing has been sent/i);
  await addDraftLine(draft.local_session_id, { menu_item_id: "m1", name: "Burger", base_price: 10, quantity: 1, modifiers: [], kitchen_note: null });
  await sendRoundOffline(draft.local_session_id);
  await assert.rejects(() => tableOnAccountOffline({ sessionId: draft.local_session_id, customerId: null, amount: 10, method: "cash" }), /customer is required/i);
});

test("capture → drain: open → round → settle replay IN ORDER, exactly once", async () => {
  const draft = await openTableOffline({ scope: DSCOPE, tableId: "TBL-9", tableName: "9", currency: "USD" });
  await addDraftLine(draft.local_session_id, { menu_item_id: "m1", name: "Burger", base_price: 10, quantity: 1, modifiers: [], kitchen_note: null });
  await sendRoundOffline(draft.local_session_id);
  const cap = await settleTableOffline({ sessionId: draft.local_session_id, method: "cash" });

  const order: string[] = [];
  const { deps: d } = deps({
    openTable: async () => { order.push("open"); return { table_id: "TBL-9", pos_entity_version: 1 }; },
    submitRound: async () => { order.push("round"); return { order_id: "O1", order_number: "N1", batch_no: 1, appended: true, idempotent: false }; },
    payTable: async () => { order.push("pay"); return { ok: true, amount: 10, idempotent: false }; },
  });
  await drainOffline({ tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1", online: true }, "reconnect", d);
  assert.equal(order[order.length - 1], "pay"); // settle is LAST — after open + round
  assert.ok(order.indexOf("open") < order.indexOf("pay"));
  assert.ok(order.indexOf("round") < order.indexOf("pay"));
  assert.equal(order.filter((x) => x === "pay").length, 1); // exactly once
  assert.equal((await getOperation(cap.operationId))?.status, "synced");
});
