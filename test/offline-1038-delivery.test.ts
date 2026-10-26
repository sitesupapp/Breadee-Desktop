// 1.0.38 — Workstream C: offline Delivery (Bug 4: D2 / D3 / D4 / D7 + C3 for Delivery).
//
// Real Dexie (fake-indexeddb), the REAL capture helpers, the REAL single orchestrator + handlers; only
// the server RPCs are injected. Proves exactly-once end to end, P1→P2→P1 provider ordering, the flap
// (synced order → canonical reference), pay-step discount/fee carried to replay, capture-time
// dependency filtering, the on-account edit dependency, and local-order visibility after shift sync.

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
import { capturePayOrderOffline, payOrderClientOpId } from "@/lib/offline/payOrderOffline";
import { captureDeliveryOpsOffline, captureDeliveryProviderOffline, captureEditOrderNoteOffline } from "@/lib/offline/deliveryActionOffline";
import { captureCustomerUpsertOffline } from "@/lib/offline/customerOffline";
import { captureEditOrderLineOffline } from "@/lib/offline/itemEditOffline";
import { getOperationalOrderProjection, editTargetFor } from "@/lib/offline/operationalProjection";
import { projectLocalDeliveryOrders, projectTxnToQueueOrder } from "@/lib/offline/deliveryQueueOffline";
import { resolveEntity } from "@/lib/offline/entityMap";
import { createIntentIds, liveCaptureDependencies, orderOnAccountWithDependencies, orderRefFor } from "@/lib/offline/orderRef";
import { buildDeliveryPaymentPayload, validateDeliveryDiscount } from "@/lib/pos/deliverySettlement";
import { buildSetQuantityPayload } from "@/lib/pos/orders";

const here = dirname(fileURLToPath(import.meta.url));
const src = (p: string) => readFileSync(resolve(here, "..", p), "utf8");

const PSCOPE = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1" };
const OPSCOPE = { tenant_id: "t1", branch_id: "b1", device_id: "dev1", terminal_id: "term1", cashier_user_id: "u1" };
const MAP_SCOPE = { tenant_id: "t1", branch_id: "b1", device_id: "dev1", cashier_user_id: "u1", terminal_id: "term1" };
const CTX = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1", online: true };
const LINE = "aaaaaaaa-0000-4000-8000-0000000000d1";

beforeEach(async () => {
  await Promise.all([
    localdb.operations.clear(), localdb.entityMap.clear(), localdb.syncHistory.clear(), localdb.posOfflineTxns.clear(),
    localdb.pendingShifts.clear(), localdb.posCustomers.clear(), localdb.snapshots.clear(),
  ]);
  __resetDrainLockForTests();
});

const tick = () => new Promise((r) => setTimeout(r, 5)); // distinct created_at → deterministic FIFO

type Call = { name: string; arg: Record<string, unknown> };
function deps(calls: Call[], over: Partial<PosTxnSyncDeps> = {}): PosTxnSyncDeps {
  const d = {
    submit: async (p: Record<string, unknown>) => { calls.push({ name: "submit", arg: p }); return { order_id: "SRV-DEL", order_number: "D-1" }; },
    pay: async () => ({}),
    openShift: async () => ({ shiftId: "SRV-SHIFT", reused: false }),
    orderItemMap: async () => [{ client_line_id: LINE, order_item_id: "SRV-LINE-1" }],
    payOrderOp: async (a: Record<string, unknown>) => { calls.push({ name: "pay_order", arg: a }); return { order_id: String(a.orderId), paid: true, amount: 1, idempotent: false }; },
    onAccountOrder: async (a: Record<string, unknown>) => { calls.push({ name: "on_account_order", arg: a }); return { ok: true, idempotent: false }; },
    upsertCustomer: async (a: { payload: Record<string, unknown> }) => {
      calls.push({ name: "customer", arg: a.payload });
      return a.payload.id ? { customer_id: String(a.payload.id), address_id: "SRV-ADDR2", is_new: false } : { customer_id: "SRV-CUST", address_id: null, is_new: true };
    },
    editOrderLine: async (a: { payload: Record<string, unknown> }) => { calls.push({ name: "edit_line", arg: a.payload }); return { ok: true, idempotent: false, replacement_order_item_id: "REPL", pos_entity_version: Number(a.payload.expected_version ?? 0) + 1 }; },
    setDeliveryProviderOp: async (a: { payload: Record<string, unknown> }) => { calls.push({ name: "provider", arg: a.payload }); return { idempotent: false }; },
    setDeliveryOps: async (a: { payload: Record<string, unknown> }) => { calls.push({ name: "ops", arg: a.payload }); return { idempotent: false }; },
    editOrder: async (a: { payload: Record<string, unknown> }) => { calls.push({ name: "note", arg: a.payload }); return { idempotent: false, pos_entity_version: 2 }; },
    isTransport: (e: unknown) => e instanceof TypeError,
    hasSession: async () => true,
    ...over,
  };
  return d as unknown as PosTxnSyncDeps;
}

function deliveryTxn(over: Partial<PosOfflineTxn> = {}): PosOfflineTxn {
  return {
    local_txn_id: "LOCAL-D1", client_op_id: "d1d1d1d1-0000-4000-8000-000000000001", tenant_id: "t1", branch_id: "b1", device_id: "dev1", terminal_id: "term1", cashier_user_id: "u1", cashier_user_name: "A", shift_id: "sh1",
    created_at: new Date(Date.now() - 60_000).toISOString(),
    order_payload: { branch_id: "b1", order_type: "delivery", status: "sent_to_kitchen", shift_id: "sh1", client_op_id: "d1d1d1d1-0000-4000-8000-000000000001", notes: null, customer_id: "SRV-CUST0", address_id: "SRV-ADDR0", delivery_fee: 50_000, items: [{ menu_item_id: "mA", name: "Shawarma", base_price: 300_000, quantity: 2, kitchen_note: null, modifiers: [], client_line_id: LINE }] },
    payment_intent: null, sent_to_kitchen: true, currency: "LBP", total: 650_000, status: "queued", attempts: 0,
    ...over,
  } as PosOfflineTxn;
}

function op(over: Partial<OfflineOperation> & Pick<OfflineOperation, "operation_id" | "operation_type">): OfflineOperation {
  return { schema_version: 1, scope: OPSCOPE, created_at: new Date().toISOString(), client_op_id: over.operation_id, local_entity_id: null, canonical_entity_id: null, dependency_ids: [], depends_on_local_entities: [], payload: {}, status: "pending", retry_count: 0, last_attempt_at: null, last_error_code: null, last_error_message: null, result_meta: null, synced_at: null, ...over } as OfflineOperation;
}

/** The DeliveryWorkspace offline settle, step for step (orderRefFor → projection → C3 filter → D2 pricing). */
async function settleOffline(orderId: string, confirm: { discountType: "none" | "percent" | "amount"; discountValue: string; deliveryFee: number | null }, subtotal: number) {
  const ref = await orderRefFor(orderId, PSCOPE);
  const txn = await localdb.posOfflineTxns.get(orderId);
  const row = txn && !ref.orderId ? projectTxnToQueueOrder(txn) : { ...projectTxnToQueueOrder(deliveryTxn()), id: ref.orderId ?? orderId };
  const proj = await getOperationalOrderProjection(PSCOPE, row);
  const discount = validateDeliveryDiscount({ canDiscount: { allowed: true, reason: null }, subtotal, type: confirm.discountType, value: confirm.discountValue });
  const priced = buildDeliveryPaymentPayload({ orderId, method: "cash", currency: "LBP", discount: discount.fields, deliveryFee: confirm.deliveryFee });
  const pricing = { discount_type: priced.discount_type, discount_value: priced.discount_value, delivery_fee: priced.delivery_fee };
  const dependencyIds = [...ref.dependencyIds, ...(await liveCaptureDependencies(proj.mutationOpIds))];
  return capturePayOrderOffline({ scope: PSCOPE, orderId: ref.orderId, orderLocal: ref.orderLocal, method: "cash", currency: "LBP", clientOpId: payOrderClientOpId(PSCOPE, orderId, "cash", "LBP", pricing), orderNumber: "OFF-LOCAL", dependencyIds, pricing, orderType: "delivery" });
}

// ---------------------------------------------------------------------------------------------------

test("E2E exactly-once: customer+address → order → edit items → customer edit → provider/ops/note → pay offline; reconnect drains in order; second reconnect = zero effects", async () => {
  const intents = createIntentIds();
  // Customer created offline + a NEW address on it.
  const c = await captureCustomerUpsertOffline({ scope: PSCOPE, upsert: { branch_id: "b1", name: "Rana", phone: "70000002" }, clientOpId: "c1c1c1c1-0000-4000-8000-0000000000a1" });
  const localCust = c.localCustomerId as string;
  await tick();
  const a = await captureCustomerUpsertOffline({ scope: PSCOPE, upsert: { branch_id: "b1", id: localCust, address: { street: "Hamra St" } }, clientOpId: intents.clientOpId(`address:${localCust}:new`, ["Hamra St"]) });
  intents.done(`address:${localCust}:new`);
  const localAddr = a.localAddressId as string;
  await tick();
  // The delivery order (legacy outbox row, as DeliveryWorkspace.send writes it offline).
  const base = deliveryTxn();
  await localdb.posOfflineTxns.add(deliveryTxn({ order_payload: { ...(base.order_payload as object), customer_id: localCust, address_id: localAddr }, customer_local: localCust, address_local: localAddr }));
  await tick();
  // Item edit (qty 2 → 3) through the ONE projection target.
  const p0 = await getOperationalOrderProjection(PSCOPE, projectTxnToQueueOrder((await localdb.posOfflineTxns.get("LOCAL-D1")) as PosOfflineTxn));
  const t = editTargetFor(p0, LINE);
  if (!t.ok) throw new Error(t.reason);
  const ecid = crypto.randomUUID();
  const edit = await captureEditOrderLineOffline({ scope: PSCOPE, orderId: t.target.orderId, orderLocal: t.target.orderLocal, payload: buildSetQuantityPayload({ orderId: t.target.payloadOrderId, lineId: LINE, newQuantity: 3, expectedVersion: t.target.expectedVersion, clientOpId: ecid, reason: "more" }) as unknown as Record<string, unknown>, clientOpId: ecid, chain: { targetRef: t.target.ref, versionAfterOp: t.target.versionAfterOp, dependencyIds: t.target.dependencyIds } });
  await tick();
  // Customer edit (per-intent id).
  await captureCustomerUpsertOffline({ scope: PSCOPE, upsert: { branch_id: "b1", id: localCust, name: "Rana K" }, clientOpId: intents.clientOpId(`customer_edit:${localCust}`, ["Rana K", null, null]) });
  intents.done(`customer_edit:${localCust}`);
  await tick();
  // Provider / ops / note through orderRefFor (local → order_local + create-op dependency).
  const ref = await orderRefFor("LOCAL-D1", PSCOPE);
  assert.deepEqual(ref, { orderId: null, orderLocal: "LOCAL-D1", dependencyIds: ["mig:txn:LOCAL-D1"] });
  const provId = intents.clientOpId("delivery_set_provider:LOCAL-D1", ["PRV-1", "~"]);
  const prov = await captureDeliveryProviderOffline({ scope: PSCOPE, orderId: ref.orderId, orderLocal: ref.orderLocal, payload: { order_id: "LOCAL-D1", provider_id: "PRV-1", cost: null, cost_provided: false, client_op_id: provId }, clientOpId: provId, dependencyIds: ref.dependencyIds });
  intents.done("delivery_set_provider:LOCAL-D1");
  await tick();
  const opsId = intents.clientOpId("delivery_ops:LOCAL-D1", ["in_house", null, "Sami", 15_000]);
  await captureDeliveryOpsOffline({ scope: PSCOPE, orderId: ref.orderId, orderLocal: ref.orderLocal, payload: { order_id: "LOCAL-D1", handler_type: "in_house", delivered_by_user_id: null, person_ref: "Sami", cost: 15_000, client_op_id: opsId }, clientOpId: opsId, dependencyIds: ref.dependencyIds });
  await tick();
  const noteId = intents.clientOpId("edit_order_note:LOCAL-D1", ["Ring twice"]);
  await captureEditOrderNoteOffline({ scope: PSCOPE, orderId: ref.orderId, orderLocal: ref.orderLocal, payload: { order_id: "LOCAL-D1", note: "Ring twice", client_op_id: noteId }, clientOpId: noteId, dependencyIds: ref.dependencyIds });
  await tick();
  // Pay offline with a discount + a pay-step fee.
  const pay = await settleOffline("LOCAL-D1", { discountType: "amount", discountValue: "10000", deliveryFee: 60_000 }, 900_000);
  const payOp = (await getOperation(pay.operationId)) as OfflineOperation;
  assert.ok(payOp.dependency_ids.includes("mig:txn:LOCAL-D1"), "pay waits for the order-create op (D4)");
  assert.ok(payOp.dependency_ids.includes(edit.operationId), "pay waits for the item edit");
  assert.ok(payOp.dependency_ids.includes(prov.operationId), "pay waits for the provider");
  assert.deepEqual((payOp.payload as { discount: unknown }).discount, { discount_type: "amount", discount_value: 10000, delivery_fee: 60_000 }, "D2: pricing carried");
  assert.equal((payOp.payload as { order_type: string }).order_type, "delivery");
  const opCount = await localdb.operations.count();

  // Reconnect.
  const calls: Call[] = [];
  const r = await drainOffline(CTX, "reconnect", deps(calls));
  assert.equal(r.needsAttention.length, 0, JSON.stringify(r.needsAttention));
  const names = calls.map((x) => x.name);
  assert.deepEqual(names.filter((n) => n === "customer").length, 3);
  for (const n of ["submit", "edit_line", "provider", "ops", "note", "pay_order"]) assert.equal(names.filter((x) => x === n).length, 1, `${n} exactly once`);
  assert.ok(names.indexOf("submit") < names.indexOf("edit_line"));
  assert.ok(names.indexOf("submit") < names.indexOf("provider"));
  assert.equal(names[names.length - 1], "pay_order", "the settle replays LAST, after every edit");
  const sub = calls.find((x) => x.name === "submit")!.arg as { customer_id: string; address_id: string };
  assert.deepEqual([sub.customer_id, sub.address_id], ["SRV-CUST", "SRV-ADDR2"]);
  for (const n of ["provider", "ops", "note"]) assert.equal(calls.find((x) => x.name === n)!.arg.order_id, "SRV-DEL", `${n} remapped to canonical`);
  const payArg = calls.find((x) => x.name === "pay_order")!.arg as { orderId: string; discount: Record<string, unknown> };
  assert.equal(payArg.orderId, "SRV-DEL");
  assert.deepEqual(payArg.discount, { discount_type: "amount", discount_value: 10000, delivery_fee: 60_000 }, "the replay receives the confirmed discount + fee");

  // Second (and third) reconnect: zero extra ops, zero extra calls.
  for (let i = 0; i < 2; i++) {
    const again: Call[] = [];
    const r2 = await drainOffline(CTX, "reconnect", deps(again));
    assert.equal(again.length, 0, "no additional business effects");
    assert.equal(r2.needsAttention.length, 0);
  }
  assert.equal(await localdb.operations.count(), opCount + 1, "only the migration op was added (mig:txn), nothing else");
});

test("D3 provider P1 → P2 → P1: three ops, replayed in order, the server ends on P1; a retry of the SAME submit stays exactly-once", async () => {
  const intents = createIntentIds();
  const key = "delivery_set_provider:SRV-9";
  const ids: string[] = [];
  for (const pv of ["P1", "P2", "P1"]) {
    const cid = intents.clientOpId(key, [pv, "~"]);
    // a retry of this same submit (double-tap / error retry) → same id → already captured
    assert.equal(intents.clientOpId(key, [pv, "~"]), cid);
    const ref = await orderRefFor("SRV-9", PSCOPE);
    const first = await captureDeliveryProviderOffline({ scope: PSCOPE, orderId: ref.orderId, orderLocal: ref.orderLocal, payload: { order_id: "SRV-9", provider_id: pv, cost: null, cost_provided: false, client_op_id: cid }, clientOpId: cid, dependencyIds: ref.dependencyIds });
    const retry = await captureDeliveryProviderOffline({ scope: PSCOPE, orderId: ref.orderId, orderLocal: ref.orderLocal, payload: { order_id: "SRV-9", provider_id: pv, cost: null, cost_provided: false, client_op_id: cid }, clientOpId: cid, dependencyIds: ref.dependencyIds });
    assert.equal(first.alreadyCaptured, false);
    assert.equal(retry.alreadyCaptured, true);
    intents.done(key);
    ids.push(cid);
    await tick();
  }
  assert.equal(new Set(ids).size, 3, "the third P1 is a NEW op, not swallowed by the first");
  let serverProvider: string | null = null;
  const calls: Call[] = [];
  await drainOffline(CTX, "reconnect", deps(calls, { setDeliveryProviderOp: async (a: { payload: Record<string, unknown> }) => { serverProvider = String(a.payload.provider_id); calls.push({ name: "provider", arg: a.payload }); return { idempotent: false }; } } as Partial<PosTxnSyncDeps>));
  assert.deepEqual(calls.map((x) => x.arg.provider_id), ["P1", "P2", "P1"]);
  assert.equal(serverProvider, "P1");
  const again: Call[] = [];
  await drainOffline(CTX, "reconnect", deps(again));
  assert.equal(again.length, 0);
});

test("D4 flap: order synced, then paid offline → canonical id, no local dependency; unreconciled legacy row still resolves canonically", async () => {
  await localdb.posOfflineTxns.add(deliveryTxn());
  const calls: Call[] = [];
  await drainOffline(CTX, "reconnect", deps(calls));
  assert.deepEqual(calls.map((x) => x.name), ["submit"]);
  assert.deepEqual(await orderRefFor("LOCAL-D1", PSCOPE), { orderId: "SRV-DEL", orderLocal: null, dependencyIds: [] });

  // Offline again; the UI still holds the LOCAL id (customer-half) → pay goes to the canonical order.
  const pay = await settleOffline("LOCAL-D1", { discountType: "none", discountValue: "", deliveryFee: 50_000 }, 600_000);
  const payOp = (await getOperation(pay.operationId)) as OfflineOperation;
  assert.equal(payOp.canonical_entity_id, "SRV-DEL");
  assert.deepEqual(payOp.depends_on_local_entities, []);
  assert.equal((payOp.payload as { order_id: string }).order_id, "SRV-DEL");
  const c2: Call[] = [];
  const r = await drainOffline(CTX, "reconnect", deps(c2));
  assert.equal(r.needsAttention.length, 0);
  assert.deepEqual(c2.map((x) => [x.name, x.arg.orderId]), [["pay_order", "SRV-DEL"]]);
  const c3: Call[] = [];
  await drainOffline(CTX, "reconnect", deps(c3));
  assert.equal(c3.length, 0);

  // The window between the op sync (entity map) and the legacy reconcile: still canonical.
  await localdb.posOfflineTxns.add(deliveryTxn({ local_txn_id: "LOCAL-D2", client_op_id: "x2" }));
  await resolveEntity({ local_entity_id: "LOCAL-D2", entity_type: "order", canonical_id: "SRV-D2", resolved_at: "x", ...MAP_SCOPE });
  assert.deepEqual(await orderRefFor("LOCAL-D2", PSCOPE), { orderId: "SRV-D2", orderLocal: null, dependencyIds: [] });
  // A hydrated canonical order is referenced as itself.
  assert.deepEqual(await orderRefFor("SRV-77", PSCOPE), { orderId: "SRV-77", orderLocal: null, dependencyIds: [] });
});

test("D4 fail-closed: a mapping / local order of another OU is never referenced", async () => {
  await resolveEntity({ local_entity_id: "LOCAL-X", entity_type: "order", canonical_id: "SRV-X", resolved_at: "x", ...MAP_SCOPE, branch_id: "b2" });
  await assert.rejects(() => orderRefFor("LOCAL-X", PSCOPE), /another location/);
  await localdb.posOfflineTxns.add(deliveryTxn({ local_txn_id: "LOCAL-Y", client_op_id: "y", branch_id: "b2" }));
  await assert.rejects(() => orderRefFor("LOCAL-Y", PSCOPE), /another location/);
});

test("D4: a parked order-create escalates the dependent pay (dependency_failed), never blocked forever", async () => {
  await localdb.posOfflineTxns.add(deliveryTxn());
  await settleOffline("LOCAL-D1", { discountType: "none", discountValue: "", deliveryFee: null }, 600_000);
  const calls: Call[] = [];
  // A definitive server refusal of the order itself (structured business code → needs_attention).
  const refusal = Object.assign(new Error("permission denied for this operating unit"), { code: "42501" });
  const r = await drainOffline(CTX, "reconnect", deps(calls, { submit: async () => { throw refusal; } } as Partial<PosTxnSyncDeps>));
  assert.equal(calls.some((x) => x.name === "pay_order"), false, "no charge for an order that does not exist");
  assert.equal((await getOperation("mig:txn:LOCAL-D1"))?.status, "needs_attention", "precondition: the create op parked");
  const payOp = (await localdb.operations.where("operation_type").equals("pay_order").toArray())[0];
  assert.equal(payOp.status, "needs_attention");
  assert.equal(payOp.last_error_code, "dependency_failed");
  assert.ok(r.needsAttention.length >= 1);
});

test("C3: a new capture never depends on a parked / cancelled / synced / unknown op", async () => {
  await localdb.operations.bulkAdd([
    op({ operation_id: "editline:parked", operation_type: "edit_order_line", status: "needs_attention" }),
    op({ operation_id: "editline:cancelled", operation_type: "edit_order_line", status: "cancelled" }),
    op({ operation_id: "editline:done", operation_type: "edit_order_line", status: "synced", synced_at: new Date().toISOString() }),
    op({ operation_id: "editline:live", operation_type: "edit_order_line", status: "pending" }),
    op({ operation_id: "editline:blocked", operation_type: "edit_order_line", status: "blocked_dependency" }),
  ]);
  assert.deepEqual(
    await liveCaptureDependencies(["editline:parked", "editline:cancelled", "editline:done", "editline:live", "editline:blocked", "editline:live", "nope"]),
    ["editline:live", "editline:blocked"],
  );
});

test("D2: pricing is carried in the online field names, joins the op id, and the replay path spreads it into p_payload", () => {
  const legacy = payOrderClientOpId(PSCOPE, "ORD-1", "cash", "USD");
  assert.equal(payOrderClientOpId(PSCOPE, "ORD-1", "cash", "USD", {}), legacy, "no pricing → the pre-1.0.38 id");
  assert.equal(payOrderClientOpId(PSCOPE, "ORD-1", "cash", "USD", { delivery_fee: undefined }), legacy);
  const fee5 = payOrderClientOpId(PSCOPE, "ORD-1", "cash", "USD", { delivery_fee: 5 });
  assert.notEqual(fee5, legacy);
  assert.equal(payOrderClientOpId(PSCOPE, "ORD-1", "cash", "USD", { delivery_fee: 5 }), fee5, "same pricing → same id (exactly-once)");
  assert.notEqual(payOrderClientOpId(PSCOPE, "ORD-1", "cash", "USD", { delivery_fee: 5, discount_type: "percent", discount_value: 10 }), fee5);
  // The online builder's keys are exactly what the op carries (minus identity/tender fields).
  const priced = buildDeliveryPaymentPayload({ orderId: "ORD-1", method: "cash", currency: "USD", discount: { discount_type: "percent", discount_value: 10 }, deliveryFee: 0 });
  assert.deepEqual(priced, { order_id: "ORD-1", method: "cash", currency_code: "USD", discount_type: "percent", discount_value: 10, delivery_fee: 0 });
  // Replay contract: payOrderOp spreads `discount` verbatim into pos_pay_order's p_payload, next to
  // client_op_id — the same RPC + fields the online settle sends (plus the idempotency key).
  const sync = src("src/lib/offline/posTxnSync.ts");
  assert.match(sync, /callPosRpc\("pos_pay_order", \{\s*p_payload: \{\s*order_id: args\.orderId,\s*method: args\.method,\s*currency_code: args\.currency,\s*client_op_id: args\.clientOpId,[\s\S]{0,140}\.\.\.\(args\.discount \?\? \{\}\),/);
  const h = src("src/lib/offline/handlers.ts");
  assert.match(h, /payOrderOp\(\{ orderId, method: p\.method, currency: [^}]*discount: p\.discount,/);
});

test("D2: a free-delivery fee of 0 is carried (0 ≠ absent); no pricing → no discount key", async () => {
  await capturePayOrderOffline({ scope: PSCOPE, orderId: "ORD-1", method: "cash", currency: "USD", clientOpId: "p0", pricing: { delivery_fee: 0 } });
  assert.deepEqual(((await getOperation("payorder:p0"))?.payload as { discount: unknown }).discount, { delivery_fee: 0 });
  await capturePayOrderOffline({ scope: PSCOPE, orderId: "ORD-2", method: "cash", currency: "USD", clientOpId: "p1", pricing: {} });
  assert.equal("discount" in ((await getOperation("payorder:p1"))?.payload as object), false);
});

test("D7a: a not-yet-synced local order stays in the Delivery list after its offline-opened shift syncs", async () => {
  await localdb.posOfflineTxns.add(deliveryTxn({ shift_id: "SH-LOCAL", pending_shift_local_id: "SH-LOCAL" }));
  await localdb.posOfflineTxns.add(deliveryTxn({ local_txn_id: "LOCAL-OTHER", client_op_id: "o", shift_id: "SH-OTHER" }));
  assert.deepEqual((await projectLocalDeliveryOrders("t1", "b1", "SH-LOCAL")).map((o) => o.id), ["LOCAL-D1"], "before the shift syncs");
  await resolveEntity({ local_entity_id: "SH-LOCAL", entity_type: "shift", canonical_id: "SRV-SHIFT", resolved_at: "x", ...MAP_SCOPE });
  assert.deepEqual((await projectLocalDeliveryOrders("t1", "b1", "SRV-SHIFT")).map((o) => o.id), ["LOCAL-D1"], "after: asked by the CANONICAL shift id");
  assert.deepEqual((await projectLocalDeliveryOrders("t1", "b1", "SH-LOCAL")).map((o) => o.id), ["LOCAL-D1"]);
  assert.equal((await projectLocalDeliveryOrders("t1", "b2", "SRV-SHIFT")).length, 0, "OU isolation unchanged");
});

test("D7b: offline on-account waits for the order's earlier LIVE edits (atomic), never a parked one; a re-capture never rewrites", async () => {
  await localdb.operations.bulkAdd([
    op({ operation_id: "editline:e1", operation_type: "edit_order_line", canonical_entity_id: "ORD-9", payload: { payload: { order_id: "ORD-9", expected_version: 1 }, order_local: null } }),
    op({ operation_id: "editline:bad", operation_type: "edit_order_line", status: "needs_attention", payload: { payload: { order_id: "ORD-9" }, order_local: null } }),
  ]);
  const live = await liveCaptureDependencies(["editline:e1", "editline:bad"]);
  const input = { scope: PSCOPE, orderId: "ORD-9", orderLocal: null, migOpId: null, customerId: "C1", amount: 0, method: "cash", orderNumber: "D-9" };
  const r = await orderOnAccountWithDependencies(input, live);
  const oa = (await getOperation(r.operationId)) as OfflineOperation;
  assert.deepEqual(oa.dependency_ids, ["editline:e1"]);
  const again = await orderOnAccountWithDependencies(input, ["editline:other"]);
  assert.equal(again.alreadyCaptured, true);
  assert.deepEqual(((await getOperation(r.operationId)) as OfflineOperation).dependency_ids, ["editline:e1"], "an existing op is never rewritten");
  const calls: Call[] = [];
  await drainOffline(CTX, "reconnect", deps(calls));
  assert.deepEqual(calls.map((x) => x.name), ["edit_line", "on_account_order"], "receivable after the edit");
});

test("DeliveryWorkspace source: one order reference, per-intent ids, double-settle guard, pricing carried", () => {
  const dw = src("src/screens/pos/DeliveryWorkspace.tsx");
  assert.doesNotMatch(dw, /txn\.status !== "synced"/, "no per-site 'is local' decision left");
  assert.doesNotMatch(dw, /deterministicUuid\(\[\s*target\.id/, "no value-derived op id for provider / ops / note");
  assert.doesNotMatch(dw, /"delivery_address"\]|"delivery_customer_edit"\]/, "no value-derived op id for address / customer edit");
  assert.equal((dw.match(/await orderRefFor\(/g) ?? []).length, 5, "pay + on-account + provider + ops + note");
  assert.match(dw, /intentIds\.clientOpId\(intentKey/);
  assert.match(dw, /const dependencyIds = \[\.\.\.ref\.dependencyIds, \.\.\.\(await liveCaptureDependencies\(proj\?\.mutationOpIds \?\? \[\]\)\)\]/);
  assert.match(dw, /pricing,\s*orderType: "delivery",/);
  assert.match(dw, /payTarget\.order\.id === offlineSettledOrderId/, "the just-sent order has a double-settle guard");
  assert.match(dw, /if \(offlineSettledOrderId === order\.id\)/);
});
