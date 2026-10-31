// rc.11 — ULTRA FAST-TRACK FINAL CLOSURE: behavioural tests for the rc.10 native PARTIAL PASS findings
// (real Dexie via fake-indexeddb, the REAL capture engines, the REAL single orchestrator + handlers;
// only server RPCs are injected).
//
//   D  Delivery: offline customer + address edit replay (P0 root cause), payment precedence / status,
//      online queue continuity, local→canonical aliasing, unified customer projection, recovery
//   T  Dine-In: legacy-settle repair guard, Move/Merge from the active bill, quantity decrease
//   C  Closure: capture shape, classification, recovery-once, refused-payment wall, dedup, diagnostics

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

import { localdb, cacheBill, cacheCustomers, type PosOfflineTxn, type CachedCustomer } from "@/lib/offline/db";
import { getOperation, type OfflineOperation } from "@/lib/offline/operationLog";
import { drainOffline, __resetDrainLockForTests } from "@/lib/offline/orchestrator";
import type { PosTxnSyncDeps } from "@/lib/offline/posTxnSync";
import { openTableOffline, addDraftLine, sendRoundOffline, settleTableOffline, getDineDraftForTable } from "@/lib/offline/dineinOffline";
import {
  getOperationalTableBill,
  getOperationalTableTotals,
  overlayTableTotals,
  projectDeliveryOrder,
  overlayDeliveryQueue,
  editTargetFor,
} from "@/lib/offline/operationalProjection";
import { captureEditOrderLineOffline } from "@/lib/offline/itemEditOffline";
import { capturePayOrderOffline } from "@/lib/offline/payOrderOffline";
import { captureCustomerUpsertOffline } from "@/lib/offline/customerOffline";
import { loadDeliveryQueueOfflineAware, projectLocalDeliveryOrders } from "@/lib/offline/deliveryQueueOffline";
import { resolveOrderParties, pickParty } from "@/lib/offline/deliveryParties";
import { resolveEntity } from "@/lib/offline/entityMap";
import { classifyOperation, recoverHistoricalReplayFailures, buildDiagnostic } from "@/lib/offline/queueForensics";
import { paymentDisplayLabel, paymentStateLabel } from "@/lib/pos/deliveryHistory";
import { mergeableSources } from "@/lib/pos/tableOps";
import { buildSetQuantityPayload } from "@/lib/pos/orders";
import { foldBill } from "@/lib/pos/tableBill";
import type { BillOrder, TableSummary } from "@/types/tables";
import type { DeliveryQueueOrder } from "@/lib/pos/deliveryOrderManagement";

const here = dirname(fileURLToPath(import.meta.url));
const src = (p: string) => readFileSync(resolve(here, "..", p), "utf8");

const DSCOPE = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1", shiftId: "sh1" };
const PSCOPE = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1" };
const OPSCOPE = { tenant_id: "t1", branch_id: "b1", device_id: "dev1", terminal_id: "term1", cashier_user_id: "u1" };
const CTX = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1", online: true };

beforeEach(async () => {
  await Promise.all([
    localdb.operations.clear(), localdb.entityMap.clear(), localdb.syncHistory.clear(), localdb.dineDrafts.clear(),
    localdb.snapshots.clear(), localdb.posOfflineTxns.clear(), localdb.pendingShifts.clear(), localdb.posCustomers.clear(),
  ]);
  __resetDrainLockForTests();
});

type Call = { name: string; arg: unknown };
function deps(calls: Call[], over: Partial<PosTxnSyncDeps> = {}): PosTxnSyncDeps {
  const d = {
    submit: async (p: unknown) => { calls.push({ name: "submit", arg: p }); return { order_id: "SRV-DEL", order_number: "D-1" }; },
    pay: async () => ({}),
    openShift: async () => ({ shiftId: "SRV-SHIFT", reused: false }),
    openTable: async (p: unknown) => { calls.push({ name: "open", arg: p }); return { table_id: "TBL-1", pos_entity_version: 4 }; },
    submitRound: async (p: unknown) => { calls.push({ name: "round", arg: p }); return { order_id: "ORD-A", order_number: "N", batch_no: 1, appended: true, idempotent: false }; },
    orderItemMap: async () => [],
    payTable: async (a: unknown) => { calls.push({ name: "pay_table", arg: a }); return { ok: true, amount: 1, idempotent: false, pos_entity_version: 9 }; },
    payOrderOp: async (a: { orderId: string }) => { calls.push({ name: "pay_order", arg: a }); return { order_id: a.orderId, paid: true, amount: 1, idempotent: false }; },
    onAccountTable: async (a: unknown) => { calls.push({ name: "on_account_table", arg: a }); return { ok: true, idempotent: false }; },
    onAccountOrder: async (a: unknown) => { calls.push({ name: "on_account_order", arg: a }); return { ok: true, idempotent: false }; },
    upsertCustomer: async (a: { payload: Record<string, unknown> }) => {
      calls.push({ name: "customer", arg: a.payload });
      // create → canonical customer, no address; an address edit → the canonical address
      return a.payload.id ? { customer_id: String(a.payload.id), address_id: "SRV-ADDR2", is_new: false } : { customer_id: "SRV-CUST", address_id: null, is_new: true };
    },
    editOrderLine: async (a: { payload: Record<string, unknown> }) => { calls.push({ name: "edit", arg: a.payload }); return { ok: true, idempotent: false, replacement_order_item_id: "REPL", pos_entity_version: Number(a.payload.expected_version) + 1 }; },
    endShiftOp: async (a: { shiftId: string }) => { calls.push({ name: "end_shift", arg: a }); return { shift_id: a.shiftId, idempotent: false }; },
    isTransport: (e: unknown) => e instanceof TypeError,
    hasSession: async () => true,
    ...over,
  };
  return d as unknown as PosTxnSyncDeps;
}

function row(over: Partial<DeliveryQueueOrder> = {}): DeliveryQueueOrder {
  return { id: "SRV-1", order_number: "D-100", status: "sent_to_kitchen", payment_status: "unpaid", payment_method: null, subtotal: 600_000, discount_amount: null, delivery_fee: 0, total_amount: 600_000, currency: "LBP", customer_id: "SRV-CUST", address_id: "SRV-ADDR", notes: null, shift_id: "sh1", created_at: "2026-10-19T09:00:00.000Z", pos_entity_version: 2, ...over };
}

function op(over: Partial<OfflineOperation> & Pick<OfflineOperation, "operation_id" | "operation_type">): OfflineOperation {
  return { schema_version: 1, scope: OPSCOPE, created_at: "2026-10-19T09:10:00.000Z", client_op_id: over.operation_id, local_entity_id: null, canonical_entity_id: null, dependency_ids: [], depends_on_local_entities: [], payload: {}, status: "pending", retry_count: 0, last_attempt_at: null, last_error_code: null, last_error_message: null, result_meta: null, synced_at: null, ...over } as OfflineOperation;
}

function deliveryTxn(over: Partial<PosOfflineTxn> = {}): PosOfflineTxn {
  return {
    local_txn_id: "LOCAL-D1", client_op_id: "d1d1d1d1-0000-4000-8000-000000000001", tenant_id: "t1", branch_id: "b1", device_id: "dev1", terminal_id: "term1", cashier_user_id: "u1", cashier_user_name: "A", shift_id: "sh1",
    created_at: new Date(Date.now() + 1000).toISOString(),
    order_payload: { branch_id: "b1", order_type: "delivery", status: "sent_to_kitchen", shift_id: "sh1", client_op_id: "d1d1d1d1-0000-4000-8000-000000000001", notes: null, customer_id: "c-local", address_id: "a-local", items: [{ menu_item_id: "mA", name: "Shawarma", base_price: 300_000, quantity: 2, kitchen_note: null, modifiers: [], client_line_id: "aaaaaaaa-0000-4000-8000-0000000000d1" }] },
    payment_intent: null, sent_to_kitchen: true, currency: "LBP", total: 600_000, status: "queued", attempts: 0,
    ...over,
  } as PosOfflineTxn;
}

// ================================================================ D — Delivery

test("D1 P0 root cause: offline customer + offline address EDIT + order + pay replay in order, remapped, exactly once", async () => {
  const c = await captureCustomerUpsertOffline({ scope: PSCOPE, upsert: { branch_id: "b1", name: "Rana", phone: "70000002" }, clientOpId: "c1c1c1c1-0000-4000-8000-0000000000a1" });
  const localCust = c.localCustomerId as string;
  const a = await captureCustomerUpsertOffline({ scope: PSCOPE, upsert: { branch_id: "b1", id: localCust, address: { street: "Hamra St" } }, clientOpId: "c1c1c1c1-0000-4000-8000-0000000000a2" });
  const localAddr = a.localAddressId as string;
  const edit = await getOperation(a.operationId);
  assert.equal(edit?.canonical_entity_id, null, "never claims the local id as canonical");
  assert.deepEqual(edit?.depends_on_local_entities, [localCust], "the edit WAITS for the create");
  assert.equal((edit?.payload as { customer_local: string }).customer_local, localCust);

  await localdb.posOfflineTxns.add(deliveryTxn({ order_payload: { ...(deliveryTxn().order_payload as object), customer_id: localCust, address_id: localAddr }, customer_local: localCust, address_local: localAddr }));
  await capturePayOrderOffline({ scope: PSCOPE, orderId: null, orderLocal: "LOCAL-D1", method: "cash", currency: "LBP", clientOpId: "e1e1e1e1-0000-4000-8000-0000000000a3" });

  const calls: Call[] = [];
  const r = await drainOffline(CTX, "reconnect", deps(calls));
  assert.equal(r.needsAttention.length, 0);
  const names = calls.map((x) => x.name);
  assert.deepEqual(names, ["customer", "customer", "submit", "pay_order"]);
  assert.equal((calls[0].arg as { id?: string }).id, undefined, "create first");
  assert.equal((calls[1].arg as { id: string }).id, "SRV-CUST", "the address edit is sent with the CANONICAL id, never the local one");
  const sub = calls[2].arg as { customer_id: string; address_id: string };
  assert.equal(sub.customer_id, "SRV-CUST");
  assert.equal(sub.address_id, "SRV-ADDR2", "the order's local address remapped to the canonical address");
  assert.equal((calls[3].arg as { orderId: string }).orderId, "SRV-DEL", "the payment settles the canonical order");
  const again: Call[] = [];
  await drainOffline(CTX, "reconnect", deps(again));
  assert.equal(again.length, 0, "second reconnect: zero additional business effects");
});

test("D2 payment precedence: unresolved local settle > newer confirmed canonical > older cached row; a refused settle never claims payment", () => {
  const pay = (status: OfflineOperation["status"], synced_at: string | null = null) =>
    op({ operation_id: "payorder:1", operation_type: "pay_order", status, synced_at, payload: { order_id: "SRV-1", order_local: null, method: "cash", currency: "LBP" } });
  const proj = (o: OfflineOperation, rowFetchedAt: number | null, r = row()) => projectDeliveryOrder({ row: r, txn: null, cachedLines: null, ops: [o], rowFetchedAt }).row;
  const t0 = Date.parse("2026-10-19T09:20:00.000Z");
  for (const st of ["pending", "blocked", "retryable"] as const) {
    const p = proj(pay(st), t0);
    assert.equal(p.payment_status, "paid", st);
    assert.equal(p.status, "completed");
    assert.equal(p.local_pending_sync, true);
  }
  const confirmedAfter = proj(pay("synced", "2026-10-19T09:30:00.000Z"), t0);
  assert.equal(confirmedAfter.payment_status, "paid", "a confirmation newer than the cached row wins");
  assert.equal(confirmedAfter.local_pending_sync, false);
  const reflected = proj(pay("synced", "2026-10-19T09:10:00.000Z"), t0);
  assert.equal(reflected.payment_status, "unpaid", "already in the row → the row is authoritative (nothing re-applied)");
  assert.equal(reflected.local_pending_sync, undefined);
  const refused = proj(pay("needs_attention"), t0);
  assert.equal(refused.payment_status, "unpaid", "a refused settle never shows as paid");
  assert.equal(projectDeliveryOrder({ row: row(), txn: null, cachedLines: null, ops: [pay("needs_attention")] }).attention, 1);
  assert.equal(proj(pay("pending"), t0, row({ payment_status: "refunded", status: "refunded" })).payment_status, "refunded", "never relabels a refunded order");
  const oa = (amount: number) => op({ operation_id: "onaccountorder:1", operation_type: "on_account_order", payload: { order_id: "SRV-1", order_local: null, customer_id: "SRV-CUST", customer_local: null, amount, method: "cash" } });
  const part = proj(oa(100_000), t0);
  assert.deepEqual([part.payment_status, part.settlement_mode, part.status], ["partial", "on_account", "completed"]);
  const none = proj(oa(0), t0);
  assert.deepEqual([none.payment_status, none.settlement_mode], ["unpaid", "on_account"]);
  assert.equal(paymentDisplayLabel(proj(pay("pending"), t0)), "Paid (pending sync)");
  assert.equal(paymentDisplayLabel(part), "Partially Paid · On Account (pending sync)");
  assert.equal(paymentDisplayLabel(none), "On Account (pending sync)");
  assert.equal(paymentDisplayLabel(row({ payment_status: "paid" })), "Paid", "a server row reads exactly as before");
  assert.equal(paymentStateLabel("partial"), "partial", "the server-state label is unchanged");
});

test("D3 online refresh never drops an unsynced offline order; a resolved-but-unreconciled one de-dups under its canonical id", async () => {
  await localdb.posOfflineTxns.add(deliveryTxn({ local_txn_id: "LOCAL-A", client_op_id: "a" }));
  await localdb.posOfflineTxns.add(deliveryTxn({ local_txn_id: "LOCAL-B", client_op_id: "b" }));
  await resolveEntity({ local_entity_id: "LOCAL-B", entity_type: "order", canonical_id: "SRV-1", resolved_at: "x", ...{ tenant_id: "t1", branch_id: "b1", device_id: "dev1", cashier_user_id: "u1", terminal_id: "term1" } });
  const locals = await projectLocalDeliveryOrders("t1", "b1", "sh1");
  assert.deepEqual(locals.map((l) => l.id).sort(), ["LOCAL-A", "SRV-1"]);
  const online = await loadDeliveryQueueOfflineAware({ tenantId: "t1", branchId: "b1", shiftId: "sh1", now: new Date() }, { reachable: async () => true, load: async () => [row()] });
  assert.equal(online.offline, false);
  assert.ok(online.fetchedAt != null);
  assert.deepEqual(online.orders.map((o) => o.id).sort(), ["LOCAL-A", "SRV-1"], "the blocked offline order stays visible online, and is never doubled");
});

test("D4 aliases: a settle captured against the OFFLINE order still shows on its canonical row after the order synced", async () => {
  await localdb.operations.add(op({ operation_id: "payorder:2", operation_type: "pay_order", depends_on_local_entities: ["LOCAL-D1"], payload: { order_id: null, order_local: "LOCAL-D1", method: "cash", currency: "LBP" } }));
  await resolveEntity({ local_entity_id: "LOCAL-D1", entity_type: "order", canonical_id: "SRV-1", resolved_at: "x", tenant_id: "t1", branch_id: "b1", device_id: "dev1", cashier_user_id: "u1", terminal_id: "term1" });
  const [shown] = await overlayDeliveryQueue(PSCOPE, [row()], { rowFetchedAt: Date.now() });
  assert.equal(shown.payment_status, "paid");
  assert.equal(shown.local_pending_sync, true);
  // once that settle synced BEFORE the read, the fresh server row stands untouched
  await localdb.operations.update("payorder:2", { status: "synced", synced_at: new Date(Date.now() - 5000).toISOString() });
  const [fresh] = await overlayDeliveryQueue(PSCOPE, [row({ payment_status: "paid", status: "completed" })], { rowFetchedAt: Date.now() });
  assert.equal(fresh.local_pending_sync, undefined);
});

test("D5 unified customer projection: canonical → local cache → remap alias → order snapshot, field by field; OU wall", async () => {
  const cust = (over: Partial<CachedCustomer>): CachedCustomer => ({ id: "x", tenant_id: "t1", branch_id: "b1", name: null, phone: null, phone_e164: null, addresses: null, notes: null, has_profile: true, cached_at: "x", ...over });
  await cacheCustomers([
    cust({ id: "c-local", name: "Rana", phone: "70000002", addresses: [{ id: "a-local", street: "Hamra St", building: "5" }] }),
    cust({ id: "c-other-ou", branch_id: "b2", name: "WRONG OU", phone: "1" }),
  ]);
  await localdb.posOfflineTxns.add(deliveryTxn({ local_txn_id: "LOCAL-S", client_op_id: "s", order_payload: { order_type: "delivery", customer_id: "c-none", address_id: "a-none" }, party_snapshot: { customer_name: "Snap", customer_phone: "71", address_text: "Snap addr" } }));
  await resolveEntity({ local_entity_id: "c-local", entity_type: "customer", canonical_id: "SRV-CUST", resolved_at: "x", tenant_id: "t1", branch_id: "b1", device_id: "dev1", cashier_user_id: "u1", terminal_id: "term1" });
  await resolveEntity({ local_entity_id: "a-local", entity_type: "address", canonical_id: "SRV-ADDR", resolved_at: "x", tenant_id: "t1", branch_id: "b1", device_id: "dev1", cashier_user_id: "u1", terminal_id: "term1" });
  const rows = [
    row({ id: "LOCAL-L", customer_id: "c-local", address_id: "a-local" }), // offline: local cache
    row({ id: "SRV-1" }), // synced under canonical ids, profile cached only under the local id → alias
    row({ id: "LOCAL-S", customer_id: null, address_id: null }), // nothing cached → order snapshot
    row({ id: "SRV-9", customer_id: "c-other-ou", address_id: null }), // another OU's cache never serves
  ];
  const server = new Map([["SRV-1", { customerName: "Rana (server)", customerPhone: null, addressText: null }]]);
  const p = await resolveOrderParties(rows, server, { tenantId: "t1", branchId: "b1" });
  assert.deepEqual(p.get("LOCAL-L"), { customerName: "Rana", customerPhone: "70000002", addressText: "Hamra St, Bldg 5" });
  assert.deepEqual(p.get("SRV-1"), { customerName: "Rana (server)", customerPhone: "70000002", addressText: "Hamra St, Bldg 5" }, "canonical first; gaps filled from the alias");
  assert.deepEqual(p.get("LOCAL-S"), { customerName: "Snap", customerPhone: "71", addressText: "Snap addr" });
  assert.deepEqual(p.get("SRV-9"), { customerName: null, customerPhone: null, addressText: null });
  assert.deepEqual(pickParty([null, { customerName: " " }, { customerName: "B" }]).customerName, "B");
  // the receipt reads the same map (DeliveryWorkspace receiptIdentity → parties)
  const dw = src("src/screens/pos/DeliveryWorkspace.tsx");
  assert.match(dw, /resolveOrderParties\(rows, server/);
  assert.match(dw, /party_snapshot: partySnapshot/);
});

test("D6 historical recovery: a pre-rc.11 edit of an offline-created customer is re-pointed ONCE and replays with the canonical id", async () => {
  await localdb.operations.add(op({ operation_id: "customer:create", operation_type: "customer_upsert", local_entity_id: "c-local", status: "synced", synced_at: "2026-10-19T09:00:00.000Z", payload: { upsert: { branch_id: "b1", name: "R" }, local_address_id: null } }));
  await resolveEntity({ local_entity_id: "c-local", entity_type: "customer", canonical_id: "SRV-CUST", resolved_at: "x", tenant_id: "t1", branch_id: "b1", device_id: "dev1", cashier_user_id: "u1", terminal_id: "term1" });
  await localdb.operations.add(op({ operation_id: "customer:edit", operation_type: "customer_upsert", canonical_entity_id: "c-local", status: "needs_attention", last_error_code: "permission", last_error_message: "Customer not found for this operating unit", payload: { upsert: { branch_id: "b1", id: "c-local", address: { street: "S" } }, local_address_id: "a-local" } }));
  assert.equal(classifyOperation((await getOperation("customer:edit"))!).category, "HISTORICAL_LOCAL_CUSTOMER_EDIT");
  const ids = await recoverHistoricalReplayFailures();
  assert.deepEqual(ids, ["customer:edit"]);
  const fixed = await getOperation("customer:edit");
  assert.equal(fixed?.status, "pending");
  assert.equal(fixed?.canonical_entity_id, null);
  assert.deepEqual(fixed?.depends_on_local_entities, ["c-local"]);
  const calls: Call[] = [];
  await drainOffline(CTX, "reconnect", deps(calls));
  assert.equal((calls.find((x) => x.name === "customer")?.arg as { id: string }).id, "SRV-CUST");
  assert.equal((await localdb.entityMap.get("a-local"))?.canonical_id, "SRV-ADDR2", "the address now resolves → dependent orders unblock");
  assert.deepEqual(await recoverHistoricalReplayFailures(), [], "never twice");
});

// ================================================================ T — Dine-In

function mapRow(over: Partial<TableSummary> = {}): TableSummary {
  return { id: "TBL-1", name: "Table 1", seats: 4, occupied: true, status: "occupied", canonical: true, configured: true, sort_order: 1, orders: 1, order_number: "261015-0010", opened_at: "2026-10-18T08:00:00.000Z", total: 1_800_000, collected: 0, outstanding: 1_800_000, currency: "LBP", mixed_currency: false, pos_entity_version: 3, ...over };
}
function canon(): BillOrder {
  return { id: "ORD-C", order_number: "261015-0010", status: "sent_to_kitchen", payment_status: "unpaid", pos_entity_version: 5, shift_id: "sh1", branch_id: "b1", tenant_id: "t1", subtotal: 2_100_000, discount_amount: 0, total_amount: 2_100_000, currency: "LBP", exchange_rate: null, created_at: "2026-10-18T08:00:00.000Z",
    lines: [
      { id: "IT-1", menu_item_id: "m1", name: "Pizza", quantity: 2, base_price: 900_000, modifiers_total: 0, final_unit_price: 900_000, line_total: 1_800_000, kitchen_note: null, batch_no: 1, modifiers: [] },
      { id: "IT-2", menu_item_id: "m2", name: "Soup", quantity: 1, base_price: 300_000, modifiers_total: 0, final_unit_price: 300_000, line_total: 300_000, kitchen_note: null, batch_no: 1, modifiers: [] },
    ] };
}
const tbl = (r: TableSummary = mapRow({ total: 2_100_000 })) => getOperationalTableBill(PSCOPE, r);

async function reduce(lineId: string, n: number) {
  const p = await tbl();
  const t = editTargetFor(p, lineId);
  if (!t.ok) throw new Error(t.reason);
  const cid = crypto.randomUUID();
  return captureEditOrderLineOffline({ scope: PSCOPE, orderId: t.target.orderId, orderLocal: t.target.orderLocal, payload: buildSetQuantityPayload({ orderId: t.target.payloadOrderId, lineId, newQuantity: n, expectedVersion: t.target.expectedVersion, clientOpId: cid, reason: "guest changed mind" }) as unknown as Record<string, unknown>, clientOpId: cid, chain: { targetRef: t.target.ref, versionAfterOp: t.target.versionAfterOp, dependencyIds: t.target.dependencyIds } });
}

test("T1 legacy settle (no covers) + a round sent AFTER it: the session stays ACTIVE (never hidden behind an old payment)", async () => {
  await cacheBill("TBL-1", foldBill("TBL-1", [canon()]), "t1", "b1", Date.now() - 60_000);
  const d = await openTableOffline({ scope: DSCOPE, tableId: "TBL-1", tableName: "Table 1", seats: 4, currency: "LBP", baseOrderVersion: 3, canonicalOrderId: "ORD-C" });
  await addDraftLine(d.local_session_id, { menu_item_id: "m9", name: "Grill", base_price: 1_000_000, quantity: 1, modifiers: [], kitchen_note: null });
  await sendRoundOffline(d.local_session_id);
  const s = await settleTableOffline({ sessionId: d.local_session_id, method: "cash" });
  await localdb.dineDrafts.update(d.local_session_id, { status: "open", settled_operation_id: null });
  await localdb.operations.update(s.operationId, { payload: { ...((await getOperation(s.operationId))!.payload as object), covers: undefined }, created_at: new Date(Date.now() - 30_000).toISOString() });
  // a LATER round on the same (legacy-open) session
  const dd = (await localdb.dineDrafts.get(d.local_session_id))!;
  await localdb.dineDrafts.update(d.local_session_id, { rounds: dd.rounds.map((r) => ({ ...r, sent_at: new Date().toISOString() })) });
  assert.ok(await getDineDraftForTable(DSCOPE, "TBL-1"), "not repaired as settled");
  assert.equal((await localdb.dineDrafts.get(d.local_session_id))?.status, "open", "nothing deleted, nothing rewritten");
});

test("T2 Move/Merge read the ACTIVE bill: a locally-settled table is never offered as a merge source (no stale 5,455,000)", async () => {
  await cacheBill("TBL-1", foldBill("TBL-1", [canon()]), "t1", "b1", Date.now() - 60_000);
  await settleTableOffline({ sessionId: null, table: { scope: DSCOPE, tableId: "TBL-1", tableName: "Table 1", currency: "LBP", orderIds: ["ORD-C"] }, method: "cash", covers: { orderIds: ["ORD-C"], summary: false } });
  const raw = [mapRow({ id: "TBL-1", total: 5_455_000 }), mapRow({ id: "TBL-2", name: "Table 2" }), mapRow({ id: "TBL-P", name: "Primary" })];
  const shown = overlayTableTotals(raw, await getOperationalTableTotals(PSCOPE, raw));
  const sources = mergeableSources(shown, shown.find((t) => t.id === "TBL-P")!);
  assert.deepEqual(sources.map((t) => t.id), ["TBL-2"]);
  const dw = src("src/screens/pos/DineInWorkspace.tsx");
  // 1.0.38 (WS-F) — the same projected rows, minus (online) tables held for unsynced offline work.
  assert.match(dw, /sources=\{mergeableSources\(displayMap\.tables, selected\)(\.filter\(\(t\) => !input\.online \|\| !structuralHold\.has\(t\.id\)\))?\}/);
  assert.match(dw, /<MoveTableDialog[\s\S]*?tables=\{displayMap\.tables\}/);
});

test("T3 sent-line quantity DECREASE offline: replaced IN PLACE (same round), total drops, audited op carries reason + CAS + client_op_id + 5-D scope", async () => {
  await cacheBill("TBL-1", foldBill("TBL-1", [canon()]), "t1", "b1", Date.now() - 60_000);
  const before = await tbl();
  assert.equal(before.gross, 2_100_000);
  const r = await reduce("IT-1", 1);
  const after = await tbl();
  assert.equal(after.gross, 1_200_000);
  const first = after.bill.orders[0].lines[0];
  assert.equal(first.quantity, 1);
  assert.equal(first.batch_no, 1, "stays in its round");
  assert.equal(first.name, "Pizza");
  const o = await getOperation(r.operationId);
  const body = (o?.payload as { payload: Record<string, unknown> }).payload;
  assert.equal(body.op, "set_quantity");
  assert.equal(body.new_quantity, 1, "expected remaining quantity");
  assert.equal(body.expected_version, 5);
  assert.equal(body.reason, "guest changed mind");
  assert.ok(typeof body.client_op_id === "string" && body.client_op_id !== "");
  assert.deepEqual(o?.scope, OPSCOPE);
});

test("T4 decrease at quantity 1 = audited removal; replays ONCE through the canonical writer; second reconnect inert", async () => {
  await cacheBill("TBL-1", foldBill("TBL-1", [canon()]), "t1", "b1", Date.now() - 60_000);
  await reduce("IT-2", 0);
  const p = await tbl();
  assert.equal(p.gross, 1_800_000);
  assert.ok(!p.bill.orders[0].lines.some((l) => l.name === "Soup"));
  const calls: Call[] = [];
  await drainOffline(CTX, "reconnect", deps(calls));
  const edits = calls.filter((c) => c.name === "edit");
  assert.equal(edits.length, 1);
  assert.equal((edits[0].arg as { target_item_id: string }).target_item_id, "IT-2");
  assert.equal((edits[0].arg as { new_quantity: number }).new_quantity, 0);
  const again: Call[] = [];
  await drainOffline(CTX, "reconnect", deps(again));
  assert.equal(again.length, 0);
  const panel = src("src/components/pos/DineInRoundPanel.tsx");
  assert.doesNotMatch(panel, /disabled=\{editing \|\| l\.quantity <= 1\}/, "− is usable at quantity 1");
});

test("T5 paid-item wall preserved: a part-paid bill refuses offline item edits", async () => {
  await cacheBill("TBL-1", foldBill("TBL-1", [{ ...canon(), payment_status: "partial" }]), "t1", "b1", Date.now() - 60_000);
  const p = await tbl(mapRow({ total: 2_100_000, collected: 300_000 }));
  const t = editTargetFor(p, "IT-1");
  assert.equal(t.ok, false);
});

test("T6 two decreases on the same line chain (version +1, dependency) — never a guessed CAS", async () => {
  await cacheBill("TBL-1", foldBill("TBL-1", [canon()]), "t1", "b1", Date.now() - 60_000);
  const r1 = await reduce("IT-1", 1);
  const p = await tbl();
  const afterId = p.bill.orders[0].lines[0].id;
  assert.ok(afterId.startsWith("after:"));
  const r2 = await reduce(afterId, 0);
  const o2 = await getOperation(r2.operationId);
  assert.equal(((o2?.payload as { payload: { expected_version: number } }).payload).expected_version, 6);
  assert.ok(o2?.dependency_ids.includes(r1.operationId));
  assert.equal((await tbl()).gross, 300_000);
});

test("T7 the full-payment path still frees the table (preservation)", async () => {
  await cacheBill("TBL-1", foldBill("TBL-1", [canon()]), "t1", "b1", Date.now() - 60_000);
  await settleTableOffline({ sessionId: null, table: { scope: DSCOPE, tableId: "TBL-1", tableName: "Table 1", currency: "LBP", orderIds: ["ORD-C"] }, method: "cash", covers: { orderIds: ["ORD-C"], summary: false } });
  const [card] = overlayTableTotals([mapRow()], await getOperationalTableTotals(PSCOPE, [mapRow()]));
  assert.equal(card.status, "available");
});

// ================================================================ C — closure

test("C1 a customer EDIT of a canonical customer is unchanged (canonical id, no dependency)", async () => {
  const r = await captureCustomerUpsertOffline({ scope: PSCOPE, upsert: { branch_id: "b1", id: "SRV-CUST", address: { street: "X" } }, clientOpId: "c1c1c1c1-0000-4000-8000-0000000000c1" });
  const o = await getOperation(r.operationId);
  assert.equal(o?.canonical_entity_id, "SRV-CUST");
  assert.deepEqual(o?.depends_on_local_entities, []);
  assert.equal((o?.payload as { customer_local?: string }).customer_local, undefined);
});

test("C2 the handler never sends a local customer id: unresolved → waits (no server call)", async () => {
  await localdb.operations.add(op({ operation_id: "customer:e2", operation_type: "customer_upsert", depends_on_local_entities: [], payload: { upsert: { branch_id: "b1", id: "c-unknown", address: { street: "S" } }, local_address_id: "a2", customer_local: "c-unknown" } }));
  const calls: Call[] = [];
  await drainOffline(CTX, "reconnect", deps(calls));
  assert.equal(calls.filter((c) => c.name === "customer").length, 0);
  assert.notEqual((await getOperation("customer:e2"))?.status, "synced");
});

test("C3 recovery only re-points edits whose target is PROVABLY offline-created; an unknown id stays parked", async () => {
  await localdb.operations.add(op({ operation_id: "customer:x", operation_type: "customer_upsert", status: "needs_attention", last_error_code: "permission", last_error_message: "Customer not found for this operating unit", payload: { upsert: { id: "never-created" }, local_address_id: null } }));
  assert.deepEqual(await recoverHistoricalReplayFailures(), []);
  assert.equal((await getOperation("customer:x"))?.status, "needs_attention");
});

test("C4 never retry a payment blindly: a refused (needs_attention) pay is not re-queued by recovery and not shown as paid", async () => {
  await localdb.operations.add(op({ operation_id: "payorder:r", operation_type: "pay_order", status: "needs_attention", last_error_code: "settle_conflict", last_error_message: "already paid", payload: { order_id: "SRV-1", order_local: null, method: "cash", currency: "LBP" } }));
  assert.deepEqual(await recoverHistoricalReplayFailures(), []);
  const [shown] = await overlayDeliveryQueue(PSCOPE, [row()], { rowFetchedAt: Date.now() });
  assert.equal(shown.payment_status, "unpaid");
  const calls: Call[] = [];
  await drainOffline(CTX, "reconnect", deps(calls));
  assert.equal(calls.filter((c) => c.name === "pay_order").length, 0);
});

test("C5 Sync Center diagnostic classifies historical vs current vs conflicts (redacted)", () => {
  const ops = [
    op({ operation_id: "a", operation_type: "customer_upsert", status: "needs_attention", last_error_message: "Customer not found for this operating unit", payload: { upsert: { name: "SECRET NAME" } } }),
    op({ operation_id: "b", operation_type: "pay_order", status: "needs_attention", last_error_code: "settle_conflict", last_error_message: "x" }),
    op({ operation_id: "c", operation_type: "takeaway_sale", status: "needs_attention", last_error_code: "dependency_failed", last_error_message: "a" }),
    op({ operation_id: "d", operation_type: "pay_order", status: "blocked" }),
  ];
  const diag = buildDiagnostic(ops, "build-rc11");
  assert.deepEqual(diag.map((r) => r.category), ["HISTORICAL_LOCAL_CUSTOMER_EDIT", "EXPECTED_CONFLICT", "HISTORICAL_DEPENDENT", "WAITING"]);
  assert.doesNotMatch(JSON.stringify(diag), /SECRET NAME/, "no payload / customer data in the export");
});

test("C6 release identity: 1.0.40 is the PRODUCTION bundle (no RC suffix, the fleet's identifier)", () => {
  const conf = JSON.parse(src("src-tauri/tauri.conf.json")) as { version: string; identifier: string };
  // The RC stage (1.0.37-rc.N / app.breadee.desktop.offlinerc) ended at rc.14; the production release ships
  // under the installed fleet's identity so the in-app update replaces it in place (offline-rc-diagnostics pins the rest).
  assert.equal(conf.version, "1.0.40");
  assert.equal(conf.identifier, "app.breadee.desktop");
});
