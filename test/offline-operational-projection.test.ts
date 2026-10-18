// rc.9 — CUMULATIVE OFFLINE CLOSURE: ONE operational projection per table / delivery order.
//
// Integration-level behavioural tests over the REAL Dexie store (fake-indexeddb), the REAL capture
// engines, the REAL single orchestrator (drainOffline) and the REAL replay handlers, with only the
// server RPCs injected. They pin the five native scenarios:
//   D1–D10  Dine-In: one total everywhere (the Table-1 1,800,000 vs 5,455,000 release blocker),
//           offline edits of canonical + locally-sent lines, paid-item wall, split, settle.
//   E1–E12  Delivery: one order projection (lines / totals / provider / ops / note), capability edits,
//           offline provider selection from the cached authorized catalog, settle ordering.
//   R1–R12  Reconnect / exactly-once / restart: the rc.8 "line-N"::uuid replay bug, bound sessions,
//           version chain, dependency order, idempotent re-drain.

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

import { localdb, cacheBill, cacheDeliveryLines, type PosOfflineTxn } from "@/lib/offline/db";
import { getOperation, listOperations, type OfflineOperation } from "@/lib/offline/operationLog";
import { drainOffline, __resetDrainLockForTests } from "@/lib/offline/orchestrator";
import type { PosTxnSyncDeps } from "@/lib/offline/posTxnSync";
import { dineinSendRoundHandler } from "@/lib/offline/handlers";
import {
  openTableOffline,
  addDraftLine,
  sendRoundOffline,
  draftLineFromCart,
  settleTableOffline,
  splitOperationalBillOffline,
  getDineDraftForTable,
  isUuid,
} from "@/lib/offline/dineinOffline";
import {
  editTargetFor,
  getOperationalTableBill,
  getOperationalTableTotals,
  getOperationalOrderProjection,
  overlayTableTotals,
  overlayDeliveryQueue,
  orderChainFor,
  deliveryEditBlock,
  projectTableBill,
} from "@/lib/offline/operationalProjection";
import { captureEditOrderLineOffline, captureAddOrderItemsOffline } from "@/lib/offline/itemEditOffline";
import { captureDeliveryProviderOffline, captureDeliveryOpsOffline, captureEditOrderNoteOffline } from "@/lib/offline/deliveryActionOffline";
import { capturePayOrderOffline } from "@/lib/offline/payOrderOffline";
import { buildSetQuantityPayload, buildChangeModifiersPayload, buildAddItemsPayload } from "@/lib/pos/orders";
import { foldBill } from "@/lib/pos/tableBill";
import type { BillOrder, TableSummary } from "@/types/tables";
import type { DeliveryQueueOrder } from "@/lib/pos/deliveryOrderManagement";

const DSCOPE = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1", shiftId: "sh1" };
const PSCOPE = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1" };
const CTX = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1", online: true };

beforeEach(async () => {
  await Promise.all([
    localdb.operations.clear(),
    localdb.entityMap.clear(),
    localdb.syncHistory.clear(),
    localdb.dineDrafts.clear(),
    localdb.snapshots.clear(),
    localdb.posOfflineTxns.clear(),
  ]);
  __resetDrainLockForTests();
});

// ---------------------------------------------------------------- fixtures

type Call = { name: string; arg: unknown };
function deps(calls: Call[], over: Partial<PosTxnSyncDeps> = {}): PosTxnSyncDeps {
  let editN = 0;
  let ver = 7;
  const d = {
    submit: async (p: unknown) => { calls.push({ name: "submit", arg: p }); return { order_id: "SRV-DEL", order_number: "D-1" }; },
    pay: async () => ({}),
    openShift: async () => ({ shiftId: "s", reused: false }),
    openTable: async (p: unknown) => { calls.push({ name: "open", arg: p }); return { table_id: "TBL-1", pos_entity_version: 2 }; },
    submitRound: async (p: unknown) => { calls.push({ name: "round", arg: p }); return { order_id: "ORD-C", order_number: "261015-0010", batch_no: 2, appended: true, idempotent: false }; },
    orderItemMap: async () => { calls.push({ name: "map", arg: null }); return MAP.slice(); },
    payTable: async (a: unknown) => { calls.push({ name: "pay_table", arg: a }); return { ok: true, amount: 1, idempotent: false }; },
    payOrderOp: async (a: { orderId: string }) => { calls.push({ name: "pay_order", arg: a }); return { order_id: a.orderId, paid: true, amount: 1, idempotent: false }; },
    splitSettle: async (a: unknown) => { calls.push({ name: "split", arg: a }); return { ok: true, split_no: 1, parent_completed: false, remaining_qty: 0, idempotent: false }; },
    editOrderLine: async (a: { payload: Record<string, unknown> }) => {
      calls.push({ name: "edit", arg: a.payload });
      editN += 1;
      ver = Number(a.payload.expected_version) + 1;
      return { ok: true, idempotent: false, replacement_order_item_id: `REPL-${editN}`, pos_entity_version: ver };
    },
    addOrderItems: async (a: { payload: Record<string, unknown> }) => { calls.push({ name: "add", arg: a.payload }); return { ok: true, idempotent: false, pos_entity_version: Number(a.payload.expected_version) + 1 }; },
    setDeliveryProviderOp: async (a: { payload: Record<string, unknown> }) => { calls.push({ name: "provider", arg: a.payload }); return { ok: true, idempotent: false }; },
    setDeliveryOps: async (a: { payload: Record<string, unknown> }) => { calls.push({ name: "ops", arg: a.payload }); return { ok: true, idempotent: false }; },
    editOrder: async (a: { payload: Record<string, unknown> }) => { calls.push({ name: "note", arg: a.payload }); return { ok: true, idempotent: false }; },
    isTransport: (e: unknown) => e instanceof TypeError,
    hasSession: async () => true,
    ...over,
  };
  return d as unknown as PosTxnSyncDeps;
}
let MAP: { client_line_id: string; order_item_id: string }[] = [];

function canonOrder(lines: { id: string; name: string; qty: number; unit: number; batch?: number }[], over: Partial<BillOrder> = {}): BillOrder {
  const ls = lines.map((l) => ({ id: l.id, menu_item_id: "m-" + l.id, name: l.name, quantity: l.qty, base_price: l.unit, modifiers_total: 0, final_unit_price: l.unit, line_total: l.unit * l.qty, kitchen_note: null, batch_no: l.batch ?? 1, modifiers: [] }));
  const sub = ls.reduce((s, l) => s + l.line_total, 0);
  return { id: "ORD-C", order_number: "261015-0010", status: "sent_to_kitchen", payment_status: "unpaid", pos_entity_version: 5, shift_id: "sh1", branch_id: "b1", tenant_id: "t1", subtotal: sub, discount_amount: 0, total_amount: sub, currency: "LBP", exchange_rate: null, created_at: "2026-10-18T08:00:00.000Z", lines: ls, ...over };
}
function mapRow(over: Partial<TableSummary> = {}): TableSummary {
  return { id: "TBL-1", name: "Table 1", seats: 4, occupied: true, status: "occupied", canonical: true, configured: true, sort_order: 1, orders: 1, order_number: "261015-0010", opened_at: "2026-10-18T08:00:00.000Z", total: 1_800_000, collected: 0, outstanding: 1_800_000, currency: "LBP", mixed_currency: false, pos_entity_version: 3, ...over };
}
/** The native Table-1 state: canonical bill 1,800,000 cached online, then an OFFLINE round 5,455,000. */
async function table1(opts: { cache?: boolean; bound?: boolean } = {}) {
  const cache = opts.cache ?? true;
  if (cache) {
    const bill = foldBill("TBL-1", [canonOrder([{ id: "IT-1", name: "Pizza", qty: 2, unit: 900_000 }])]);
    await cacheBill("TBL-1", bill, "t1", "b1", Date.now() - 60_000);
  }
  const draft = await openTableOffline({ scope: DSCOPE, tableId: "TBL-1", tableName: "Table 1", seats: 4, currency: "LBP", baseOrderVersion: 3, canonicalOrderId: (opts.bound ?? cache) ? "ORD-C" : null });
  await addDraftLine(draft.local_session_id, { menu_item_id: "m9", name: "Mixed Grill", base_price: 2_500_000, quantity: 2, modifiers: [{ group_id: "g", option_id: "o", name: "Extra", price_delta: 227_500, quantity: 1 }], kitchen_note: null });
  const d = await sendRoundOffline(draft.local_session_id);
  return d;
}
function delivRow(over: Partial<DeliveryQueueOrder> = {}): DeliveryQueueOrder {
  return { id: "LOCAL-1", order_number: "OFF-LOCAL1", status: "sent_to_kitchen", payment_status: "unpaid", payment_method: null, subtotal: 840_000, discount_amount: null, delivery_fee: 50_000, total_amount: 890_000, currency: null, customer_id: "c1", address_id: "a1", notes: null, shift_id: "sh1", created_at: "2026-10-18T09:00:00.000Z", pos_entity_version: null, ...over };
}
async function offTxn(opts: { legacy?: boolean } = {}): Promise<PosOfflineTxn> {
  const t: PosOfflineTxn = {
    local_txn_id: "LOCAL-1", client_op_id: "11111111-1111-4111-8111-111111111111", tenant_id: "t1", branch_id: "b1", device_id: "dev1", terminal_id: "term1",
    cashier_user_id: "u1", cashier_user_name: "Ali", shift_id: "sh1", created_at: "2026-10-18T09:00:00.000Z",
    order_payload: {
      branch_id: "b1", order_type: "delivery", status: "sent_to_kitchen", shift_id: "sh1", client_op_id: "11111111-1111-4111-8111-111111111111", notes: null, customer_id: "c1", address_id: "a1", delivery_fee: 50_000,
      items: [
        { menu_item_id: "mA", name: "Shawarma", base_price: 300_000, quantity: 2, kitchen_note: null, modifiers: [], ...(opts.legacy ? {} : { client_line_id: "aaaaaaaa-0000-4000-8000-000000000001" }) },
        { menu_item_id: "mB", name: "Fries", base_price: 120_000, quantity: 2, kitchen_note: null, modifiers: [], ...(opts.legacy ? {} : { client_line_id: "aaaaaaaa-0000-4000-8000-000000000002" }) },
      ],
    },
    payment_intent: null, sent_to_kitchen: true, currency: "LBP", total: 890_000, status: "queued", attempts: 0,
  } as PosOfflineTxn;
  await localdb.posOfflineTxns.add(t);
  return t;
}
async function captureEdit(proj: Parameters<typeof editTargetFor>[0], lineId: string, newQty: number, reason: string | null = "guest changed mind") {
  const t = editTargetFor(proj, lineId);
  assert.equal(t.ok, true, t.ok ? "" : t.reason);
  if (!t.ok) throw new Error(t.reason);
  const clientOpId = crypto.randomUUID();
  const payload = buildSetQuantityPayload({ orderId: t.target.payloadOrderId, lineId, newQuantity: newQty, expectedVersion: t.target.expectedVersion, clientOpId, reason }) as unknown as Record<string, unknown>;
  const r = await captureEditOrderLineOffline({ scope: PSCOPE, orderId: t.target.orderId, orderLocal: t.target.orderLocal, payload, clientOpId, chain: { targetRef: t.target.ref, versionAfterOp: t.target.versionAfterOp, dependencyIds: t.target.dependencyIds } });
  return { op: (await getOperation(r.operationId)) as OfflineOperation, target: t.target };
}
const tableBill = () => getOperationalTableBill(PSCOPE, mapRow());

// ================================================================ D — Dine-In

test("D1 total invariant: canonical 1,800,000 + offline round 5,455,000 → card == detail == payment base == 7,255,000", async () => {
  await table1();
  const p = await tableBill();
  assert.equal(p.gross, 7_255_000, "the ONE operational total (not 1,800,000 card vs 5,455,000 detail)");
  assert.equal(p.bill.total, p.gross, "detail/sidebar/Add-Items bill total");
  assert.equal(p.bill.subtotal, p.gross, "payment dialog subtotal (settleBill.subtotal)");
  assert.equal(p.outstanding, p.gross, "payment outstanding base");
  const totals = await getOperationalTableTotals(PSCOPE, [mapRow()]);
  const [card] = overlayTableTotals([mapRow()], totals);
  assert.equal(card.total, p.gross, "Map/List card total == detail total");
  assert.equal(p.bill.orders.length, 1, "the offline round joined the SAME canonical bill (no second bill)");
  // captured prices (base + modifier) are honoured, never repriced
  const grill = p.bill.orders[0].lines.find((l) => l.name === "Mixed Grill");
  assert.equal(grill?.final_unit_price, 2_727_500);
});

test("D2 no double-count after sync: a round synced BEFORE the snapshot fetch is not re-added", async () => {
  const d = await table1();
  const roundOpId = d.rounds[0].operation_id;
  await localdb.operations.update(roundOpId, { status: "synced", synced_at: new Date(Date.now() - 30_000).toISOString() });
  // fresh canonical snapshot that already contains the round
  const bill = foldBill("TBL-1", [canonOrder([{ id: "IT-1", name: "Pizza", qty: 2, unit: 900_000 }, { id: "IT-2", name: "Mixed Grill", qty: 2, unit: 2_727_500, batch: 2 }])]);
  await cacheBill("TBL-1", bill, "t1", "b1", Date.now());
  const p = await tableBill();
  assert.equal(p.gross, 7_255_000);
  assert.equal(p.bill.orders[0].lines.length, 2, "round lines come from the canonical snapshot only");
});

test("D3 synced AFTER the snapshot was fetched → the round is still included (never lost)", async () => {
  const d = await table1();
  await localdb.operations.update(d.rounds[0].operation_id, { status: "synced", synced_at: new Date().toISOString() });
  const p = await tableBill();
  assert.equal(p.gross, 7_255_000);
});

test("D4 summary fallback (no cached bill): the canonical part is a summary line, totals still agree, its edit is refused", async () => {
  await table1({ cache: false });
  const p = await tableBill();
  assert.equal(p.summaryOnly, true);
  assert.equal(p.gross, 7_255_000);
  const summary = p.bill.orders.flatMap((o) => o.lines).find((l) => l.id.startsWith("summary:"));
  assert.ok(summary);
  const t = editTargetFor(p, (summary as { id: string }).id);
  assert.equal(t.ok, false);
});

test("D5 offline edit of a CANONICAL line: exact CAS (cached version), replacement mirrors the server, total follows", async () => {
  await table1();
  const p = await tableBill();
  const { op, target } = await captureEdit(p, "IT-1", 1);
  assert.equal(target.expectedVersion, 5, "the cached canonical order version");
  assert.deepEqual((op.payload as { target_ref: unknown }).target_ref, { kind: "canonical", order_item_id: "IT-1" });
  const after = await tableBill();
  assert.equal(after.gross, 7_255_000 - 900_000);
  assert.ok(after.bill.orders[0].lines.some((l) => l.id === `after:${op.operation_id}` && l.quantity === 1));
});

test("D6 offline edit of a LOCALLY-SENT round line: local target, depends on the round op", async () => {
  const d = await table1();
  const p = await tableBill();
  const local = d.lines[0].line_id;
  const { op, target } = await captureEdit(p, local, 1);
  assert.deepEqual(target.ref, { kind: "local", line_local: local, batch_no: null });
  assert.ok(op.dependency_ids.includes(d.rounds[0].operation_id), "never replays before its round");
  const after = await tableBill();
  assert.equal(after.gross, 7_255_000 - 2_727_500);
});

test("D7 version chain: a second edit of the same line targets the first edit's replacement at expected+1", async () => {
  await table1();
  const first = await captureEdit(await tableBill(), "IT-1", 1);
  const p2 = await tableBill();
  const second = await captureEdit(p2, `after:${first.op.operation_id}`, 0);
  assert.equal(second.target.expectedVersion, 6);
  assert.equal(second.target.versionAfterOp, first.op.operation_id);
  assert.ok(second.op.dependency_ids.includes(first.op.operation_id));
  assert.deepEqual((second.op.payload as { target_ref: unknown }).target_ref, { kind: "after", op_id: first.op.operation_id });
});

test("D8 paid-item wall: a captured split leg or a server part-payment refuses offline item edits", async () => {
  const d = await table1();
  const p = await tableBill();
  const po = p.orders[0];
  const cap = await splitOperationalBillOffline({ scope: DSCOPE, orderId: po.orderId, orderLocal: null, allocations: [{ order_item_id: "IT-1", quantity: 1 }], method: "cash", currency: "LBP", tableName: "Table 1", dependencyIds: [d.open_operation_id, ...d.rounds.map((r) => r.operation_id)] });
  assert.equal(cap.ok, true);
  const after = await tableBill();
  assert.equal(editTargetFor(after, "IT-1").ok, false, "split-paid line");
  assert.equal(editTargetFor(after, d.lines[0].line_id).ok, false, "any line of a part-paid bill (server rule: unpaid only)");
  // server-held part-payment
  const part = projectTableBill({ tableId: "TBL-1", mapRow: mapRow({ collected: 100 }), canonical: { bill: foldBill("TBL-1", [canonOrder([{ id: "IT-1", name: "Pizza", qty: 2, unit: 900_000 }])]), fetchedAt: Date.now() }, draft: null, ops: [] });
  assert.equal(editTargetFor(part, "IT-1").ok, false);
});

test("D9 split over the operational bill: canonical + local lines in ONE leg, resolved on replay after the round", async () => {
  const d = await table1();
  const local = d.lines[0].line_id;
  const p = await tableBill();
  const cap = await splitOperationalBillOffline({ scope: DSCOPE, orderId: p.orders[0].orderId, orderLocal: null, allocations: [{ order_item_id: "IT-1", quantity: 1 }, { line_local: local, quantity: 1 }], method: "cash", currency: "LBP", tableName: "Table 1", dependencyIds: [d.open_operation_id, ...d.rounds.map((r) => r.operation_id)] });
  assert.equal(cap.ok, true);
  const after = await tableBill();
  assert.equal(after.paidPending, 900_000 + 2_727_500);
  assert.equal(after.outstanding, 7_255_000 - 900_000 - 2_727_500);
  MAP = [{ client_line_id: local, order_item_id: "IT-SRV-2" }];
  const calls: Call[] = [];
  const r = await drainOffline(CTX, "reconnect", deps(calls));
  const names = calls.map((c) => c.name);
  assert.ok(names.indexOf("round") < names.indexOf("split"));
  const split = calls.find((c) => c.name === "split")?.arg as { allocations: { order_item_id: string }[] };
  assert.deepEqual(split.allocations.map((a) => a.order_item_id).sort(), ["IT-1", "IT-SRV-2"]);
  assert.equal(r.needsAttention.length, 0);
});

test("D10 settle a canonical-only table offline (no draft): one op, replays AFTER the pending edit", async () => {
  const bill = foldBill("TBL-1", [canonOrder([{ id: "IT-1", name: "Pizza", qty: 2, unit: 900_000 }])]);
  await cacheBill("TBL-1", bill, "t1", "b1", Date.now() - 1000);
  const p = await tableBill();
  assert.equal(p.gross, 1_800_000);
  const { op: edit } = await captureEdit(p, "IT-1", 1);
  const p2 = await tableBill();
  const target = { scope: DSCOPE, tableId: "TBL-1", tableName: "Table 1", currency: "LBP", orderIds: ["ORD-C"] };
  const a = await settleTableOffline({ sessionId: null, table: target, method: "cash", extraDependencyIds: p2.mutationOpIds });
  const b = await settleTableOffline({ sessionId: null, table: target, method: "cash", extraDependencyIds: p2.mutationOpIds });
  assert.equal(b.alreadyCaptured, true, "double-tap → one settle");
  assert.equal(a.operationId, b.operationId);
  assert.ok((await getOperation(a.operationId))?.dependency_ids.includes(edit.operation_id));
  const calls: Call[] = [];
  await drainOffline(CTX, "reconnect", deps(calls));
  const names = calls.map((c) => c.name);
  assert.ok(names.indexOf("edit") >= 0 && names.indexOf("edit") < names.indexOf("pay_table"), "never charges a pre-edit total");
  const after = await tableBill();
  assert.equal(after.settlingOpId === null || after.outstanding === 0, true);
});

// ================================================================ E — Delivery

test("E1 OFF-* order: lines + totals from the local order payload (items + fee == list total)", async () => {
  const t = await offTxn();
  const p = await getOperationalOrderProjection(PSCOPE, delivRow());
  assert.equal(p.localPending, true);
  assert.equal(p.linesKnown, true);
  assert.equal(p.lines.length, 2);
  assert.equal(p.lines.reduce((s, l) => s + l.lineTotal, 0) + 50_000, t.total);
  assert.equal(p.row.total_amount, 890_000);
});

test("E2 legacy OFF-* without line ids: lines visible, line edits refused (never a fake id), add still allowed", async () => {
  await offTxn({ legacy: true });
  const p = await getOperationalOrderProjection(PSCOPE, delivRow());
  assert.equal(p.lines.length, 2);
  assert.equal(editTargetFor(p, p.lines[0].id).ok, false);
  assert.equal(orderChainFor(p.orders[0]).ok, true);
});

test("E3 OFF-* qty edit: order_local + local line target + version 0; list == detail total", async () => {
  await offTxn();
  const p = await getOperationalOrderProjection(PSCOPE, delivRow());
  const lineId = "aaaaaaaa-0000-4000-8000-000000000001";
  const { op, target } = await captureEdit(p, lineId, 1);
  assert.equal(target.orderLocal, "LOCAL-1");
  assert.equal(target.expectedVersion, 0, "an offline-created order starts at version 0 (submit never bumps)");
  assert.deepEqual(op.depends_on_local_entities, ["LOCAL-1"]);
  const after = await getOperationalOrderProjection(PSCOPE, delivRow());
  assert.equal(after.row.total_amount, 890_000 - 300_000);
  const [listRow] = await overlayDeliveryQueue(PSCOPE, [delivRow()]);
  assert.equal(listRow.total_amount, after.row.total_amount, "Orders list == detail == payment base");
});

test("E4 OFF-* add items: preview lines (captured menu price) appear; the RPC payload carries no price", async () => {
  await offTxn();
  const p = await getOperationalOrderProjection(PSCOPE, delivRow());
  const c = orderChainFor(p.orders[0]);
  assert.equal(c.ok, true);
  if (!c.ok) return;
  const opId = crypto.randomUUID();
  const built = buildAddItemsPayload({ orderId: c.target.payloadOrderId, items: [{ menu_item_id: "mC", quantity: 1 }], expectedVersion: c.target.expectedVersion, clientOpId: opId });
  const cli = crypto.randomUUID();
  const payload = { ...built, items: built.items.map((it) => ({ ...it, client_line_id: cli })) };
  await captureAddOrderItemsOffline({ scope: PSCOPE, orderId: c.target.orderId, orderLocal: c.target.orderLocal, payload: payload as unknown as Record<string, unknown>, clientOpId: opId, chain: { versionAfterOp: c.target.versionAfterOp, dependencyIds: c.target.dependencyIds }, previewItems: [{ client_line_id: cli, menu_item_id: "mC", name: "Soda", base_price: 100_000, quantity: 1, kitchen_note: null, modifiers: [] }] });
  const after = await getOperationalOrderProjection(PSCOPE, delivRow());
  assert.ok(after.lines.some((l) => l.id === cli && l.name === "Soda"));
  assert.equal(after.row.total_amount, 990_000);
  const op = (await listOperations()).find((o) => o.operation_type === "add_order_items") as OfflineOperation;
  const sent = (op.payload as { payload: { items: Record<string, unknown>[] } }).payload.items[0];
  assert.equal("base_price" in sent || "price" in sent, false, "the server resolves every price");
});

test("E5 canonical delivery order: cached lines editable at the row version; second edit chains", async () => {
  await cacheDeliveryLines("ORD-D", [{ id: "DI-1", menuItemId: "mA", name: "Shawarma", quantity: 2, lineTotal: 600_000, kitchenNote: null, modifiers: [] }], "t1", "b1", Date.now() - 1000);
  const row = delivRow({ id: "ORD-D", order_number: "D-77", pos_entity_version: 4, subtotal: 600_000, total_amount: 650_000 });
  const p = await getOperationalOrderProjection(PSCOPE, row);
  const first = await captureEdit(p, "DI-1", 1);
  assert.equal(first.target.expectedVersion, 4);
  assert.equal(first.target.orderId, "ORD-D");
  const p2 = await getOperationalOrderProjection(PSCOPE, row);
  const second = await captureEdit(p2, `after:${first.op.operation_id}`, 2);
  assert.equal(second.target.expectedVersion, 5);
});

test("E6 discounted order → offline item edit refused (server pricing recompute)", async () => {
  await cacheDeliveryLines("ORD-D", [{ id: "DI-1", menuItemId: "mA", name: "Shawarma", quantity: 2, lineTotal: 600_000, kitchenNote: null, modifiers: [] }], "t1", "b1");
  const p = await getOperationalOrderProjection(PSCOPE, delivRow({ id: "ORD-D", pos_entity_version: 4, discount_amount: 60_000 }));
  assert.match(String(deliveryEditBlock(p)), /discount/i);
});

test("E7 canonical order whose lines were never cached → edits refused with a controlled reason", async () => {
  const p = await getOperationalOrderProjection(PSCOPE, delivRow({ id: "ORD-X", pos_entity_version: 2 }));
  assert.equal(p.linesKnown, false);
  assert.match(String(deliveryEditBlock(p)), /Reconnect/);
});

test("E8 provider chosen offline: overlay on the order + replay via the replay-safe provider RPC after submit", async () => {
  await offTxn();
  await captureDeliveryProviderOffline({ scope: PSCOPE, orderId: null, orderLocal: "LOCAL-1", payload: { order_id: "LOCAL-1", provider_id: "PRV-1", cost: 20_000, cost_provided: true, client_op_id: "22222222-2222-4222-8222-222222222222" }, clientOpId: "22222222-2222-4222-8222-222222222222" });
  const p = await getOperationalOrderProjection(PSCOPE, delivRow());
  assert.equal(p.row.delivery_provider_id, "PRV-1");
  assert.equal(p.row.delivery_cost, 20_000);
  const calls: Call[] = [];
  const r = await drainOffline(CTX, "reconnect", deps(calls));
  const names = calls.map((c) => c.name);
  assert.ok(names.indexOf("submit") < names.indexOf("provider"));
  assert.equal((calls.find((c) => c.name === "provider")?.arg as { order_id: string }).order_id, "SRV-DEL", "order_local → canonical");
  assert.equal(r.needsAttention.length, 0);
});

test("E9 provider invalid at replay → needs_attention (provider_invalid), never silently dropped", async () => {
  await captureDeliveryProviderOffline({ scope: PSCOPE, orderId: "ORD-D", orderLocal: null, payload: { order_id: "ORD-D", provider_id: "GONE", cost: null, cost_provided: false, client_op_id: "33333333-3333-4333-8333-333333333333" }, clientOpId: "33333333-3333-4333-8333-333333333333" });
  const calls: Call[] = [];
  await drainOffline(CTX, "reconnect", deps(calls, { setDeliveryProviderOp: async () => { throw new Error("Provider is not active for this operating unit"); } }));
  const op = (await listOperations()).find((o) => o.operation_type === "delivery_set_provider");
  assert.equal(op?.status, "needs_attention");
  assert.equal(op?.last_error_code, "provider_invalid");
});

test("E10 offline settle replays only AFTER the order's edit + provider ops", async () => {
  await offTxn();
  const p = await getOperationalOrderProjection(PSCOPE, delivRow());
  await captureEdit(p, "aaaaaaaa-0000-4000-8000-000000000002", 1);
  await captureDeliveryProviderOffline({ scope: PSCOPE, orderId: null, orderLocal: "LOCAL-1", payload: { order_id: "LOCAL-1", provider_id: "PRV-1", cost: null, cost_provided: false, client_op_id: "44444444-4444-4444-8444-444444444444" }, clientOpId: "44444444-4444-4444-8444-444444444444" });
  const p2 = await getOperationalOrderProjection(PSCOPE, delivRow());
  await capturePayOrderOffline({ scope: PSCOPE, orderId: null, orderLocal: "LOCAL-1", method: "cash", currency: "LBP", clientOpId: "55555555-5555-4555-8555-555555555555", dependencyIds: p2.mutationOpIds });
  MAP = [{ client_line_id: "aaaaaaaa-0000-4000-8000-000000000002", order_item_id: "SRV-I2" }];
  const calls: Call[] = [];
  const r = await drainOffline(CTX, "reconnect", deps(calls));
  const names = calls.map((c) => c.name);
  assert.ok(names.indexOf("edit") < names.indexOf("pay_order"));
  assert.ok(names.indexOf("provider") < names.indexOf("pay_order"));
  assert.equal((calls.find((c) => c.name === "edit")?.arg as { target_item_id: string }).target_item_id, "SRV-I2");
  assert.equal(r.needsAttention.length, 0);
});

test("E11 a settled-offline order exposes settlingOpId (no second settle offered)", async () => {
  await offTxn();
  await capturePayOrderOffline({ scope: PSCOPE, orderId: null, orderLocal: "LOCAL-1", method: "cash", currency: "LBP", clientOpId: "66666666-6666-4666-8666-666666666666" });
  const p = await getOperationalOrderProjection(PSCOPE, delivRow());
  assert.ok(p.settlingOpId);
  assert.match(String(deliveryEditBlock(p)), /settled offline/);
});

test("E12 delivery ops + note captured offline overlay the ONE order row", async () => {
  await offTxn();
  await captureDeliveryOpsOffline({ scope: PSCOPE, orderId: null, orderLocal: "LOCAL-1", payload: { order_id: "LOCAL-1", handler_type: "in_house", person_ref: "Sami", cost: 15_000, client_op_id: "77777777-7777-4777-8777-777777777777" }, clientOpId: "77777777-7777-4777-8777-777777777777" });
  await captureEditOrderNoteOffline({ scope: PSCOPE, orderId: null, orderLocal: "LOCAL-1", payload: { order_id: "LOCAL-1", note: "Ring twice", client_op_id: "88888888-8888-4888-8888-888888888888" }, clientOpId: "88888888-8888-4888-8888-888888888888" });
  const p = await getOperationalOrderProjection(PSCOPE, delivRow());
  assert.equal(p.row.delivery_person_ref, "Sami");
  assert.equal(p.row.delivery_cost, 15_000);
  assert.equal(p.row.notes, "Ring twice");
  // the note bumps the order version → a following item edit expects version 1
  assert.equal(orderChainFor(p.orders[0]).ok && (orderChainFor(p.orders[0]) as { target: { expectedVersion: number } }).target.expectedVersion, 1);
});

// ================================================================ R — reconnect / exactly-once / restart

test("R1 the rc.8 replay bug: a legacy round carrying client_line_id 'line-3' replays WITHOUT it (no 22P02)", async () => {
  const sent: unknown[] = [];
  const op = {
    operation_id: "r", operation_type: "dinein_send_round", schema_version: 1, scope: { tenant_id: "t1", branch_id: "b1", device_id: "dev1", terminal_id: "term1", cashier_user_id: "u1" },
    created_at: "x", client_op_id: "c", local_entity_id: "s", canonical_entity_id: null, dependency_ids: [], depends_on_local_entities: [],
    payload: { submit: { branch_id: "b1", order_type: "dine_in", status: "sent_to_kitchen", shift_id: "", client_op_id: "c", notes: null, table_id: "TBL-1", items: [{ menu_item_id: "m", name: "x", base_price: 1, quantity: 1, kitchen_note: null, client_line_id: "line-3", modifiers: [] }, { menu_item_id: "m", name: "y", base_price: 1, quantity: 1, kitchen_note: null, client_line_id: "aaaaaaaa-0000-4000-8000-0000000000ff", modifiers: [] }] }, table_local: null, session_local: null },
    status: "pending", retry_count: 0, last_attempt_at: null, last_error_code: null, last_error_message: null, result_meta: null, synced_at: null,
  } as OfflineOperation;
  const r = await dineinSendRoundHandler.replay(op, { deps: deps([], { submitRound: async (p: unknown) => { sent.push(p); return { order_id: "O", order_number: "N", batch_no: 1, appended: true, idempotent: false }; } } as Partial<PosTxnSyncDeps>), canonicalFor: async () => null, update: async () => {} });
  assert.equal(r.ok, true);
  const items = (sent[0] as { items: Record<string, unknown>[] }).items;
  assert.equal("client_line_id" in items[0], false, "non-uuid dropped");
  assert.equal(items[1].client_line_id, "aaaaaaaa-0000-4000-8000-0000000000ff", "uuid kept");
});

test("R2 new draft lines get a fresh uuid (never the per-process cart key)", () => {
  const l = draftLineFromCart({ key: "line-3", menu_item_id: "m", name: "x", base_price: 1, quantity: 1, kitchen_note: null, modifiers: [] });
  assert.equal(isUuid(l.line_id), true);
  assert.notEqual(l.line_id, "line-3");
});

test("R3 restart persistence: the projection is re-derived identically from Dexie", async () => {
  await table1();
  const a = await tableBill();
  const b = await tableBill();
  assert.equal(a.gross, b.gross);
  assert.deepEqual(a.bill.orders.map((o) => o.lines.map((l) => l.id)), b.bill.orders.map((o) => o.lines.map((l) => l.id)));
});

test("R4 full reconnect of the Table-1 scenario: open → round → edit → settle, each exactly once, in order", async () => {
  const d = await table1();
  const local = d.lines[0].line_id;
  await captureEdit(await tableBill(), local, 1);
  const p = await tableBill();
  await settleTableOffline({ sessionId: d.local_session_id, method: "cash", extraDependencyIds: p.mutationOpIds });
  MAP = [{ client_line_id: local, order_item_id: "IT-SRV-9" }];
  const calls: Call[] = [];
  const r = await drainOffline(CTX, "reconnect", deps(calls));
  assert.deepEqual(calls.filter((c) => c.name !== "map").map((c) => c.name), ["open", "round", "edit", "pay_table"]);
  assert.equal(r.needsAttention.length, 0);
});

test("R5 a session continuing an occupied table is BOUND: round 1 pins expected_order_id, open adopts (no stale CAS)", async () => {
  const d = await table1();
  const open = await getOperation(d.open_operation_id);
  assert.equal((open?.payload as { expected_version: unknown }).expected_version, null);
  const round = await getOperation(d.rounds[0].operation_id);
  assert.equal((round?.payload as { submit: { expected_order_id?: string } }).submit.expected_order_id, "ORD-C");
  assert.equal(isUuid((round?.payload as { submit: { items: { client_line_id?: string }[] } }).submit.items[0].client_line_id), true);
});

test("R6 an idempotent server replay of an edit settles the op once (no second application)", async () => {
  await table1();
  await captureEdit(await tableBill(), "IT-1", 1);
  const calls: Call[] = [];
  await drainOffline(CTX, "reconnect", deps(calls, { editOrderLine: async (a: { payload: Record<string, unknown> }) => { calls.push({ name: "edit", arg: a.payload }); return { ok: true, idempotent: true, replacement_order_item_id: "R", pos_entity_version: 6 }; } } as Partial<PosTxnSyncDeps>));
  assert.equal(calls.filter((c) => c.name === "edit").length, 1);
  const op = (await listOperations()).find((o) => o.operation_type === "edit_order_line");
  assert.equal(op?.status, "synced");
});

test("R7 re-drain after a full sync makes ZERO server calls (exactly-once)", async () => {
  await table1();
  await captureEdit(await tableBill(), "IT-1", 1);
  await drainOffline(CTX, "reconnect", deps([]));
  const calls: Call[] = [];
  await drainOffline(CTX, "reconnect", deps(calls));
  assert.equal(calls.length, 0);
});

test("R8 transport failure on the round keeps the edit + settle BLOCKED; the next drain completes all once", async () => {
  const d = await table1();
  await captureEdit(await tableBill(), d.lines[0].line_id, 1);
  const p = await tableBill();
  await settleTableOffline({ sessionId: d.local_session_id, method: "cash", extraDependencyIds: p.mutationOpIds });
  MAP = [{ client_line_id: d.lines[0].line_id, order_item_id: "IT-SRV-9" }];
  const c1: Call[] = [];
  await drainOffline(CTX, "reconnect", deps(c1, { submitRound: async () => { throw new TypeError("Failed to fetch"); } } as Partial<PosTxnSyncDeps>));
  assert.equal(c1.some((c) => c.name === "edit" || c.name === "pay_table"), false);
  for (const o of await listOperations()) if (o.status === "retryable") await localdb.operations.update(o.operation_id, { last_attempt_at: null });
  const c2: Call[] = [];
  const r = await drainOffline(CTX, "reconnect", deps(c2));
  assert.deepEqual(c2.filter((c) => c.name !== "map").map((c) => c.name), ["round", "edit", "pay_table"]);
  assert.equal(r.needsAttention.length, 0);
});

test("R9 the predecessor's SERVER-returned version supersedes the captured count", async () => {
  await table1();
  const first = await captureEdit(await tableBill(), "IT-1", 1);
  await captureEdit(await tableBill(), `after:${first.op.operation_id}`, 3);
  const calls: Call[] = [];
  let n = 0;
  await drainOffline(CTX, "reconnect", deps(calls, {
    editOrderLine: async (a: { payload: Record<string, unknown> }) => {
      calls.push({ name: "edit", arg: a.payload });
      n += 1;
      // the server reports version 42 after the first edit (e.g. a concurrent bump it absorbed)
      return { ok: true, idempotent: false, replacement_order_item_id: n === 1 ? "REPL-A" : "REPL-B", pos_entity_version: n === 1 ? 42 : 43 };
    },
  } as Partial<PosTxnSyncDeps>));
  const edits = calls.filter((c) => c.name === "edit").map((c) => c.arg as Record<string, unknown>);
  assert.equal(edits.length, 2);
  assert.equal(edits[1].expected_version, 42);
  assert.equal(edits[1].target_item_id, "REPL-A", "targets the first edit's replacement line");
});

test("R10 an offline add replays with client_line_id and records the server version", async () => {
  await cacheDeliveryLines("ORD-D", [{ id: "DI-1", menuItemId: "mA", name: "Shawarma", quantity: 2, lineTotal: 600_000, kitchenNote: null, modifiers: [] }], "t1", "b1");
  const p = await getOperationalOrderProjection(PSCOPE, delivRow({ id: "ORD-D", pos_entity_version: 4 }));
  const c = orderChainFor(p.orders[0]);
  if (!c.ok) throw new Error(c.reason);
  const cli = crypto.randomUUID();
  const built = buildAddItemsPayload({ orderId: c.target.payloadOrderId, items: [{ menu_item_id: "mC", quantity: 1 }], expectedVersion: c.target.expectedVersion, clientOpId: "99999999-9999-4999-8999-999999999999" });
  await captureAddOrderItemsOffline({ scope: PSCOPE, orderId: "ORD-D", orderLocal: null, payload: { ...built, items: built.items.map((it) => ({ ...it, client_line_id: cli })) } as unknown as Record<string, unknown>, clientOpId: "99999999-9999-4999-8999-999999999999" });
  const calls: Call[] = [];
  await drainOffline(CTX, "reconnect", deps(calls));
  const add = calls.find((c) => c.name === "add")?.arg as { items: { client_line_id: string }[]; expected_version: number };
  assert.equal(add.items[0].client_line_id, cli);
  assert.equal(add.expected_version, 4);
  const op = (await listOperations()).find((o) => o.operation_type === "add_order_items");
  assert.equal(op?.result_meta?.pos_entity_version, 5);
});

test("R11 modifier change offline mirrors the server (replace target, new unit price) and keeps the reason", async () => {
  await table1();
  const p = await tableBill();
  const t = editTargetFor(p, "IT-1");
  if (!t.ok) throw new Error(t.reason);
  const cid = crypto.randomUUID();
  const payload = buildChangeModifiersPayload({ orderId: t.target.payloadOrderId, lineId: "IT-1", quantity: 2, modifiers: [{ group_id: "g", option_id: "o2", name: "Cheese", price_delta: 50_000, quantity: 1 }], expectedVersion: t.target.expectedVersion, clientOpId: cid, reason: "swap" }) as unknown as Record<string, unknown>;
  await captureEditOrderLineOffline({ scope: PSCOPE, orderId: t.target.orderId, orderLocal: t.target.orderLocal, payload, clientOpId: cid, chain: { targetRef: t.target.ref, versionAfterOp: t.target.versionAfterOp, dependencyIds: t.target.dependencyIds } });
  const after = await tableBill();
  const repl = after.bill.orders[0].lines.find((l) => l.name === "Pizza");
  assert.equal(repl?.final_unit_price, 950_000);
  assert.equal(after.gross, 7_255_000 + 100_000);
  const op = (await listOperations()).find((o) => o.operation_type === "edit_order_line");
  assert.equal(((op?.payload as { payload: { reason: string } }).payload).reason, "swap");
});

test("R12 card overlay: every table's card == its projection; untouched tables unchanged", async () => {
  await table1();
  const free = mapRow({ id: "TBL-2", name: "Table 2", orders: 0, status: "available", total: null, order_number: null, occupied: false });
  const totals = await getOperationalTableTotals(PSCOPE, [mapRow(), free]);
  const [t1, t2] = overlayTableTotals([mapRow(), free], totals);
  assert.equal(t1.total, (await tableBill()).gross);
  assert.deepEqual(t2, free);
  // the local session is found for the table, in exact 5-D scope
  assert.ok(await getDineDraftForTable(DSCOPE, "TBL-1"));
});
