// 1.0.38 Workstream E — Bugs 5 / 6: Move Table and Merge Tables work OFFLINE, safely.
// Real Dexie (fake-indexeddb), the REAL capture engines / projection / orchestrator / handlers, and a FAKE
// SERVER that models the prod_1038 client contract (§5.1 pos_move_table_v2, §5.2 pos_merge_tables_v4,
// §5.3 pos_pay_table pins + S4 remaining obligation): bill pins, paid-settlement pins, table versions,
// idempotency by client_op_id with a request fingerprint, and v3 merge semantics (only UNPAID whole items
// move; a part-paid source completes for exactly P; payments are never moved or created).

import "fake-indexeddb/auto";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? (this.m.get(k) as string) : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
(globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage();

import { localdb, cacheBill, type DineDraft } from "@/lib/offline/db";
import { getOperation, type OfflineOperation } from "@/lib/offline/operationLog";
import { drainOffline, __resetDrainLockForTests, __setReplayTimeoutForTests } from "@/lib/offline/orchestrator";
import type { PosTxnSyncDeps } from "@/lib/offline/posTxnSync";
import { posErrorCode } from "@/lib/offline/posTxnSync";
import { handlerFor } from "@/lib/offline/handlers";
import {
  openTableOffline,
  addDraftLine,
  sendRoundOffline,
  settleTableOffline,
  splitOperationalBillOffline,
  sessionBarrier,
  getDineDraftForTable,
} from "@/lib/offline/dineinOffline";
import {
  getOperationalTableBill,
  getOperationalTableTotals,
  overlayTableTotals,
  settleStillCovers,
  settlePrecedence,
  scopedOperations,
} from "@/lib/offline/operationalProjection";
import {
  captureMoveTableOffline,
  captureMergeTablesOffline,
  MERGE_PARTIAL_LINE_MESSAGE,
  MERGE_CROSS_SHIFT_MESSAGE,
  MERGE_CROSS_CURRENCY_MESSAGE,
  MERGE_ADJUSTED_MESSAGE,
  MERGE_ONLINE_PART_PAID_MESSAGE,
  TABLE_OP_SUMMARY_MESSAGE,
  MOVE_DEST_NOT_FREE_MESSAGE,
} from "@/lib/offline/tableOpOffline";
import { captureEndShiftOffline, CLOSE_RELEVANT_TYPES } from "@/lib/offline/endShiftOffline";
import { getDeviceIdentity } from "@/lib/device";
import { mergeableSources, moveDestinations } from "@/lib/pos/tableOps";
import { additionalRoundLineFor, stageUnsentDraftLines } from "@/lib/offline/dineinOffline";
import { editTargetFor } from "@/lib/offline/operationalProjection";
import { readOrdersHistoryLocal, mergeOrdersHistory } from "@/lib/offline/ordersHistoryOffline";
import { selectOpenTables } from "@/lib/pos/openTables";
import { isMergedSource, orderLifecycleLabel } from "@/lib/pos/shiftOrderSummary";
import type { TableBill, TableSummary, BillOrder } from "@/types/tables";

const DEV = getDeviceIdentity();
const SCOPE = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: DEV.device_id, terminalId: DEV.terminal_id ?? null };
const DSCOPE = { ...SCOPE, shiftId: "SRV-SHIFT-1" };
const CTX = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: DEV.device_id, terminalId: DEV.terminal_id ?? null, online: true };
const MAP_AT = Date.now() - 10 * 60_000; // the cached floor was read before any of this work

beforeEach(async () => {
  await Promise.all([
    localdb.operations.clear(), localdb.entityMap.clear(), localdb.syncHistory.clear(), localdb.dineDrafts.clear(),
    localdb.snapshots.clear(), localdb.posOfflineTxns.clear(), localdb.pendingShifts.clear(),
  ]);
  __resetDrainLockForTests();
});
afterEach(() => __setReplayTimeoutForTests(45_000));

// ================================================================ the fake server (contract model)

type SItem = { id: string; client_line_id: string | null; name: string; price: number; qty: number; paid_qty: number; batch: number };
type SOrder = { id: string; table_id: string; status: "open" | "voided" | "completed"; payment_status: "unpaid" | "paid"; shift_id: string; currency: string; items: SItem[]; settlements: number; merged_into?: string };
type Call = { name: string; payload: unknown };

const posErr = (code: string, msg = code) => Object.assign(new Error(msg), { code: "P0001", details: JSON.stringify({ pos_error_code: code }) });
const sorted = (a: string[]) => [...a].sort();
const stable = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

class FakeServer {
  tables = new Map<string, { version: number; status: "available" | "occupied"; name: string }>();
  orders = new Map<string, SOrder>();
  payments: { order_id: string; amount: number; client_op_id: string }[] = [];
  submissions = new Map<string, { type: string; fp: string; result: Record<string, unknown> }>();
  calls: Call[] = [];
  seq = 0;
  /** test hooks */
  hangNextMove = false;

  constructor(tables: [string, number][]) {
    for (const [id, v] of tables) this.tables.set(id, { version: v, status: "available", name: id });
  }
  id(p: string) { return `${p}-${++this.seq}`; }
  openOn(table: string) { return [...this.orders.values()].filter((o) => o.table_id === table && o.status === "open" && o.payment_status !== "paid"); }
  total(o: SOrder) { return o.items.reduce((s, i) => s + i.price * i.qty, 0); }
  paidP(o: SOrder) { return o.items.reduce((s, i) => s + i.price * i.paid_qty, 0); }
  bump(t: string) { const r = this.tables.get(t)!; r.version += 1; return r.version; }
  drawer() { return this.payments.reduce((s, p) => s + p.amount, 0); }
  replay(op: string, type: string, fp: string) {
    const s = this.submissions.get(op);
    if (!s) return null;
    if (s.type !== type) throw Object.assign(new Error("op id used for another type"), { code: "22023" });
    if (s.fp !== fp) throw posErr("IDEMPOTENCY_PAYLOAD_MISMATCH");
    return { ...s.result, idempotent: true, result_code: "DUPLICATE_REPLAY_RETURNED" };
  }
  seedOrder(table: string, items: { name: string; price: number; qty: number }[], shift = "SRV-SHIFT-1", currency = "LBP"): SOrder {
    const o: SOrder = { id: this.id("SO"), table_id: table, status: "open", payment_status: "unpaid", shift_id: shift, currency, items: items.map((i) => ({ id: this.id("SI"), client_line_id: null, name: i.name, price: i.price, qty: i.qty, paid_qty: 0, batch: 1 })), settlements: 0 };
    this.orders.set(o.id, o);
    this.tables.get(table)!.status = "occupied";
    this.bump(table);
    return o;
  }

  deps(): Partial<PosTxnSyncDeps> {
    const rec = (name: string, payload: unknown) => this.calls.push({ name, payload: JSON.parse(JSON.stringify(payload)) });
    return {
      isTransport: (e) => e instanceof TypeError,
      hasSession: async () => true,
      openTable: async (p) => {
        rec("open_table", p);
        const hit = this.submissions.get(p.client_op_id);
        if (hit) return hit.result as { table_id: string; pos_entity_version: number };
        const t = this.tables.get(p.name)!;
        if (p.expected_version != null && p.expected_version !== t.version) throw posErr("VERSION_CONFLICT");
        t.status = "occupied";
        const result = { table_id: p.name, pos_entity_version: this.bump(p.name) };
        this.submissions.set(p.client_op_id, { type: "open", fp: "", result });
        return result;
      },
      submitRound: async (p) => {
        rec("round", p);
        const op = String(p.client_op_id);
        const hit = this.submissions.get(op);
        if (hit) return { ...(hit.result as { order_id: string; order_number: string; batch_no: number; appended: boolean }), idempotent: true };
        const open = this.openOn(String(p.table_id));
        if (p.expected_order_id && (open.length !== 1 || open[0].id !== p.expected_order_id)) throw posErr("EXPECTED_ORDER_MISMATCH", "EXPECTED_ORDER_MISMATCH: bill changed");
        let o = open[0];
        if (!o) {
          o = { id: this.id("SO"), table_id: String(p.table_id), status: "open", payment_status: "unpaid", shift_id: String(p.shift_id), currency: "LBP", items: [], settlements: 0 };
          this.orders.set(o.id, o);
        }
        const batch = o.items.reduce((m, i) => Math.max(m, i.batch), 0) + 1;
        for (const it of p.items) o.items.push({ id: this.id("SI"), client_line_id: (it as { client_line_id?: string }).client_line_id ?? null, name: it.name, price: it.base_price, qty: it.quantity, paid_qty: 0, batch });
        const result = { order_id: o.id, order_number: o.id, batch_no: batch, appended: true };
        this.submissions.set(op, { type: "round", fp: "", result });
        return { ...result, idempotent: false };
      },
      orderItemMap: async ({ orderId }) => this.orders.get(orderId)!.items.filter((i) => i.client_line_id).map((i) => ({ client_line_id: i.client_line_id as string, order_item_id: i.id })),
      splitSettle: async (a) => {
        rec("split", a);
        const hit = this.submissions.get(a.clientOpId);
        if (hit) return { ...(hit.result as { ok: boolean; split_no: number; parent_completed: boolean; remaining_qty: number }), idempotent: true };
        const o = this.orders.get(a.orderId)!;
        let amount = 0;
        for (const al of a.allocations) {
          const it = o.items.find((i) => i.id === al.order_item_id)!;
          it.paid_qty += al.quantity;
          amount += it.price * al.quantity;
        }
        o.settlements += 1;
        this.payments.push({ order_id: o.id, amount, client_op_id: a.clientOpId });
        const result = { ok: true, split_no: o.settlements, parent_completed: false, remaining_qty: 0 };
        this.submissions.set(a.clientOpId, { type: "split", fp: "", result });
        return { ...result, idempotent: false };
      },
      moveTableV2: async ({ payload: p }) => {
        rec("move_v2", p);
        const fp = stable({ ...p, client_op_id: undefined });
        const cached = this.replay(p.client_op_id, "move", fp);
        if (cached) return cached as never;
        const from = this.tables.get(p.from_table_id)!;
        const to = this.tables.get(p.to_table_id)!;
        if (p.expected_from_version != null && from.version !== p.expected_from_version) throw posErr("VERSION_CONFLICT");
        if (p.expected_to_version != null && to.version !== p.expected_to_version) throw posErr("VERSION_CONFLICT");
        const src = this.openOn(p.from_table_id);
        if (stable(sorted(src.map((o) => o.id))) !== stable(sorted(p.expected_order_ids))) throw posErr("MOVE_SOURCE_CHANGED");
        if (src.length === 0) throw posErr("MOVE_SOURCE_EMPTY");
        if (p.expected_paid_settlements) for (const o of src) if (o.settlements !== (p.expected_paid_settlements[o.id] ?? 0)) throw posErr("MOVE_PAYMENT_STATE_CHANGED");
        if (this.openOn(p.to_table_id).length > 0) throw posErr("MOVE_DEST_OCCUPIED", "The destination table already has an open bill.");
        for (const o of src) o.table_id = p.to_table_id;
        from.status = "available";
        to.status = "occupied";
        const fv = this.bump(p.from_table_id);
        const tv = this.bump(p.to_table_id);
        const result = { ok: true, orders_moved: src.length, order_ids: src.map((o) => o.id), table_versions: { [p.from_table_id]: fv, [p.to_table_id]: tv } };
        this.submissions.set(p.client_op_id, { type: "move", fp, result });
        if (this.hangNextMove) {
          this.hangNextMove = false;
          return new Promise(() => undefined) as never; // committed, but the response never arrives
        }
        return { ...result, idempotent: false };
      },
      mergeTablesV4: async ({ payload: p }) => {
        rec("merge_v4", p);
        const fp = stable({ ...p, client_op_id: undefined });
        const cached = this.replay(p.client_op_id, "merge", fp);
        if (cached) return cached as never;
        const all = [p.primary_table_id, ...p.source_table_ids];
        for (const t of Object.keys(p.expected_versions ?? {})) if (this.tables.get(t)!.version !== p.expected_versions![t]) throw posErr("VERSION_CONFLICT");
        const bills = new Map<string, SOrder>();
        for (const t of all) {
          const open = this.openOn(t);
          if (open.length !== 1) throw posErr(t === p.primary_table_id ? "MERGE_PRIMARY_EMPTY" : "MERGE_SOURCE_EMPTY");
          if (p.expected_orders[t] && p.expected_orders[t] !== open[0].id) throw posErr("MERGE_BILL_CHANGED");
          if (p.expected_paid_settlements && open[0].settlements !== (p.expected_paid_settlements[open[0].id] ?? 0)) throw posErr("MERGE_PAYMENT_STATE_CHANGED");
          bills.set(t, open[0]);
        }
        const prim = bills.get(p.primary_table_id)!;
        for (const s of p.source_table_ids) {
          const o = bills.get(s)!;
          if (o.shift_id !== prim.shift_id) throw posErr("MERGE_CROSS_SHIFT");
          if (o.items.some((i) => i.paid_qty > 0 && i.paid_qty < i.qty)) throw posErr("UNSUPPORTED_STATE", "UNSUPPORTED_STATE(partial_line)");
        }
        const batch = prim.items.reduce((m, i) => Math.max(m, i.batch), 0) + 1;
        for (const s of p.source_table_ids) {
          const o = bills.get(s)!;
          const moving = o.items.filter((i) => i.paid_qty === 0);
          o.items = o.items.filter((i) => i.paid_qty > 0);
          for (const i of moving) prim.items.push({ ...i, batch });
          if (o.settlements > 0) {
            o.status = "completed";
            o.payment_status = "paid";
          } else {
            o.status = "voided";
          }
          o.merged_into = prim.id;
          this.tables.get(s)!.status = "available";
        }
        const versions = Object.fromEntries(all.map((t) => [t, this.bump(t)]));
        const result = { ok: true, merge_id: this.id("MG"), primary_order_id: prim.id, sources_merged: p.source_table_ids.length, pos_entity_version: 9, total_amount: this.total(prim), table_versions: versions };
        this.submissions.set(p.client_op_id, { type: "merge", fp, result });
        return { ...result, idempotent: false };
      },
      payTable: async (a) => {
        rec("pay_table", a);
        const hit = this.submissions.get(a.clientOpId);
        if (hit) return { ...(hit.result as { ok: boolean; amount: number; pos_entity_version: number }), idempotent: true };
        const open = this.openOn(a.tableId);
        if (a.expectedOrderIds) {
          if (open.length === 0) {
            if (a.expectedOrderIds.every((id) => this.orders.get(id)?.payment_status === "paid")) throw posErr("ALREADY_SETTLED", "This bill was already paid.");
            throw posErr("PAY_BILL_CHANGED", "The bill on this table changed since the payment was captured.");
          }
          if (stable(sorted(open.map((o) => o.id))) !== stable(sorted(a.expectedOrderIds))) throw posErr("PAY_BILL_CHANGED", "The bill on this table changed since the payment was captured.");
        }
        if (open.length === 0) throw new Error("no open order on this table");
        const due = open.reduce((s, o) => s + this.total(o) - this.paidP(o), 0); // S4: R = T − P
        if (a.expectedAmount != null && Math.abs(due - a.expectedAmount) >= 0.005) throw posErr("PAY_AMOUNT_CHANGED", "The amount due on this table changed since the payment was captured.");
        for (const o of open) {
          const r = this.total(o) - this.paidP(o);
          this.payments.push({ order_id: o.id, amount: r, client_op_id: a.clientOpId });
          o.status = "completed";
          o.payment_status = "paid";
        }
        this.tables.get(a.tableId)!.status = "available";
        const result = { ok: true, amount: due, pos_entity_version: this.bump(a.tableId) };
        this.submissions.set(a.clientOpId, { type: "pay", fp: "", result });
        return { ...result, idempotent: false };
      },
      endShiftOp: async (a) => {
        rec("end_shift", a);
        return { shift_id: a.shiftId, idempotent: false };
      },
    };
  }
  names() { return this.calls.map((c) => c.name); }
}

// ================================================================ local fixtures

const row = (id: string, over: Partial<TableSummary> = {}): TableSummary =>
  ({ id, name: id, seats: 4, occupied: false, status: "available", canonical: true, configured: true, sort_order: 1, orders: 0, order_number: null, opened_at: null, total: null, collected: null, outstanding: null, currency: "LBP", mixed_currency: false, pos_entity_version: 1, ...over }) as TableSummary;
const occupiedRow = (id: string, total: number, over: Partial<TableSummary> = {}) => row(id, { orders: 1, occupied: true, status: "occupied", total, collected: 0, outstanding: total, ...over });

async function offlineSession(tableId: string, lines: { name: string; price: number; qty: number }[], scope = DSCOPE): Promise<DineDraft> {
  const d = await openTableOffline({ scope, tableId, tableName: tableId, seats: 4, currency: "LBP" });
  for (const l of lines) await addDraftLine(d.local_session_id, { menu_item_id: "m", name: l.name, base_price: l.price, quantity: l.qty, modifiers: [], kitchen_note: null });
  return sendRoundOffline(d.local_session_id);
}

function billOf(tableId: string, o: SOrder): TableBill {
  const order: BillOrder = {
    id: o.id, order_number: o.id, status: "sent_to_kitchen", payment_status: "unpaid", pos_entity_version: 1, shift_id: o.shift_id, branch_id: "b1", tenant_id: "t1",
    subtotal: 0, discount_amount: 0, total_amount: 0, currency: o.currency as "LBP", exchange_rate: null, created_at: new Date(MAP_AT).toISOString(),
    lines: o.items.map((i) => ({ id: i.id, menu_item_id: "m", name: i.name, quantity: i.qty, base_price: i.price, modifiers_total: 0, final_unit_price: i.price, line_total: i.price * i.qty, kitchen_note: null, batch_no: i.batch, modifiers: [] })),
  };
  order.subtotal = order.total_amount = order.lines.reduce((s, l) => s + l.line_total, 0);
  return { tableId, orders: [order], subtotal: order.total_amount, total: order.total_amount, currency: "LBP", mixedCurrency: false, splitShift: false, batches: [1] };
}

const proj = (r: TableSummary) => getOperationalTableBill(SCOPE, r, undefined, undefined, MAP_AT);
const drain = (srv: FakeServer) => drainOffline(CTX, "reconnect", srv.deps());
const opsOf = async (type: string) => (await localdb.operations.toArray()).filter((o) => o.operation_type === type);

// ================================================================ MOVE

test("MOVE offline → local result at once → restart → reconnect → exactly-once (one RPC; second drain 0 calls)", async () => {
  const A = row("A"), B = row("B");
  const d = await offlineSession("A", [{ name: "Pizza", price: 100, qty: 2 }]);
  const cap = await captureMoveTableOffline({ scope: SCOPE, from: A, to: B, mapLoadedAt: MAP_AT });
  assert.ok(cap.ok);
  const op = (await getOperation(cap.operationId))!;
  assert.equal(op.operation_type, "move_table");
  assert.equal(op.schema_version, 2);
  // barrier: the session's open + round
  for (const id of sessionBarrier({ ...d, structural_op_id: null })) assert.ok(op.dependency_ids.includes(id), id);
  // atomic local result: the bill is on B, A is free, totals conserved
  const moved = (await localdb.dineDrafts.get(d.local_session_id))!;
  assert.equal(moved.table_id, "B");
  assert.equal(moved.moved_from, "A");
  assert.equal(moved.structural_op_id, cap.operationId);
  const pB = await proj(B);
  const pA = await proj(A);
  assert.equal(pB.gross, 200);
  assert.equal(pB.outstanding, 200);
  assert.equal(pA.bill.orders.length, 0);
  const shown = overlayTableTotals([A, B], await getOperationalTableTotals(SCOPE, [A, B], undefined, MAP_AT));
  assert.equal(shown.find((t) => t.id === "B")?.orders, 1);
  assert.equal(shown.find((t) => t.id === "A")?.orders, 0);

  // restart (the durable record survives)
  localdb.close();
  await localdb.open();

  const srv = new FakeServer([["A", 1], ["B", 4]]);
  await drain(srv);
  assert.deepEqual(srv.names(), ["open_table", "round", "move_v2"]);
  const mv = srv.calls[2].payload as Record<string, unknown>;
  const orderId = [...srv.orders.keys()][0];
  assert.deepEqual(mv.expected_order_ids, [orderId]);
  assert.deepEqual(mv.expected_paid_settlements, { [orderId]: 0 });
  assert.equal(mv.expected_from_version, undefined, "a round after the open bumps A without returning it → no guessed CAS");
  assert.equal(mv.expected_to_version, undefined, "no own op on B → no CAS");
  assert.equal(srv.orders.get(orderId)!.table_id, "B");
  const after = (await getOperation(cap.operationId))!;
  assert.equal(after.status, "synced");
  assert.deepEqual((after.payload as { resolved: unknown }).resolved, mv, "the request was frozen before the first send");
  const second = new FakeServer([["A", 1], ["B", 4]]);
  await drain(second);
  assert.equal(second.calls.length, 0, "exactly-once: nothing re-sent");
});

test("MOVE A→B, then B→A, then A→B again: three DIFFERENT ops (never a cached result), versions chained from own results", async () => {
  const srv = new FakeServer([["A", 3], ["B", 7]]);
  const O1 = srv.seedOrder("A", [{ name: "Steak", price: 300, qty: 1 }]);
  await cacheBill("A", billOf("A", O1), "t1", "b1", MAP_AT);
  const A = occupiedRow("A", 300, { pos_entity_version: srv.tables.get("A")!.version }), B = row("B", { pos_entity_version: 7 });
  const c1 = await captureMoveTableOffline({ scope: SCOPE, from: A, to: B, mapLoadedAt: MAP_AT });
  assert.ok(c1.ok);
  assert.equal((await proj(B)).gross, 300, "a canonical-only bill is carried by a session created by the move");
  assert.equal((await proj(A)).vacatedLocally, true);
  const c2 = await captureMoveTableOffline({ scope: SCOPE, from: B, to: A, mapLoadedAt: MAP_AT });
  assert.ok(c2.ok);
  assert.equal((await proj(A)).gross, 300);
  assert.equal((await proj(B)).bill.orders.length, 0);
  const c3 = await captureMoveTableOffline({ scope: SCOPE, from: A, to: B, mapLoadedAt: MAP_AT });
  assert.ok(c3.ok);
  assert.equal(new Set([c1.clientOpId, c2.clientOpId, c3.clientOpId]).size, 3, "same tables, same bill → distinct ids (structural generation)");
  assert.equal((await proj(B)).gross, 300);

  await drain(srv);
  assert.deepEqual(srv.names(), ["move_v2", "move_v2", "move_v2"]);
  const [m1, m2, m3] = srv.calls.map((c) => c.payload as Record<string, unknown>);
  assert.equal(m1.expected_from_version, undefined);
  assert.deepEqual([m2.from_table_id, m2.expected_from_version, m2.expected_to_version], ["B", 8, 5], "chained from move 1's returned table_versions");
  assert.deepEqual([m3.from_table_id, m3.expected_from_version, m3.expected_to_version], ["A", 6, 9]);
  assert.equal(O1.table_id, "B");
  assert.equal([...srv.submissions.values()].filter((s) => s.type === "move").length, 3, "each applied once");
});

test("MOVE destination occupied server-side → CONFLICT (needs_attention) and the bill is restored to its original table with attention", async () => {
  const A = row("A"), B = row("B");
  const d = await offlineSession("A", [{ name: "Pizza", price: 100, qty: 1 }]);
  const cap = await captureMoveTableOffline({ scope: SCOPE, from: A, to: B, mapLoadedAt: MAP_AT });
  assert.ok(cap.ok);
  const srv = new FakeServer([["A", 1], ["B", 1]]);
  srv.seedOrder("B", [{ name: "Remote", price: 5, qty: 1 }]); // another terminal opened B meanwhile
  const r = await drain(srv);
  const op = (await getOperation(cap.operationId))!;
  assert.equal(op.status, "needs_attention");
  assert.equal(op.last_error_code, "move_dest_occupied");
  assert.ok(r.needsAttention.some((x) => x.id === cap.operationId));
  const ord = [...srv.orders.values()].find((o) => o.items.some((i) => i.name === "Pizza"))!;
  assert.equal(ord.table_id, "A", "nothing moved");
  // reconcile (run by the drain) put the session back on A
  assert.equal((await localdb.dineDrafts.get(d.local_session_id))?.table_id, "A");
  const pA = await proj(A);
  assert.equal(pA.gross, 100);
  assert.ok(pA.attention >= 1 && pA.attentionOpIds.includes(cap.operationId), "attention badge on the original table");
  assert.equal((await proj(B)).bill.orders.length, 0);
});

test("MOVE server state changed before reconnect (bill paid + a new bill opened) → MOVE_SOURCE_CHANGED conflict, the new bill is never moved", async () => {
  const srv = new FakeServer([["A", 3], ["B", 1]]);
  const O1 = srv.seedOrder("A", [{ name: "Steak", price: 300, qty: 1 }]);
  await cacheBill("A", billOf("A", O1), "t1", "b1", MAP_AT);
  const cap = await captureMoveTableOffline({ scope: SCOPE, from: occupiedRow("A", 300), to: row("B"), mapLoadedAt: MAP_AT });
  assert.ok(cap.ok);
  O1.status = "completed"; O1.payment_status = "paid";
  const O2 = srv.seedOrder("A", [{ name: "Other", price: 10, qty: 1 }]);
  await drain(srv);
  assert.equal((await getOperation(cap.operationId))?.last_error_code, "move_source_changed");
  assert.equal(O2.table_id, "A");
});

test("MOVE disconnect during replay (response lost → watchdog timeout → retry) is idempotent: byte-identical request, applied once", async () => {
  __setReplayTimeoutForTests(80);
  const d = await offlineSession("A", [{ name: "Pizza", price: 100, qty: 1 }]);
  void d;
  const cap = await captureMoveTableOffline({ scope: SCOPE, from: row("A"), to: row("B"), mapLoadedAt: MAP_AT });
  assert.ok(cap.ok);
  const srv = new FakeServer([["A", 1], ["B", 1]]);
  srv.hangNextMove = true;
  await drain(srv);
  assert.equal((await getOperation(cap.operationId))?.status, "retryable");
  await localdb.operations.update(cap.operationId, { last_attempt_at: new Date(0).toISOString() }); // past the backoff
  await drain(srv);
  const moves = srv.calls.filter((c) => c.name === "move_v2");
  assert.equal(moves.length, 2);
  assert.equal(JSON.stringify(moves[0].payload), JSON.stringify(moves[1].payload), "the frozen request is re-sent byte-identically");
  assert.equal((await getOperation(cap.operationId))?.status, "synced");
  assert.equal((await getOperation(cap.operationId))?.result_meta?.idempotent, true, "the server returned the cached result");
  assert.equal([...srv.orders.values()][0].table_id, "B");
});

test("BARRIER: a round sent after the move depends on it, targets the new table, and waits while the move cannot replay", async () => {
  const d = await offlineSession("A", [{ name: "Pizza", price: 100, qty: 1 }]);
  const cap = await captureMoveTableOffline({ scope: SCOPE, from: row("A"), to: row("B"), mapLoadedAt: MAP_AT });
  assert.ok(cap.ok);
  await addDraftLine(d.local_session_id, { menu_item_id: "m", name: "Cola", base_price: 10, quantity: 1, modifiers: [], kitchen_note: null });
  const r2 = (await sendRoundOffline(d.local_session_id)).rounds[1];
  const round2 = (await getOperation(r2.operation_id))!;
  assert.ok(round2.dependency_ids.includes(cap.operationId));
  assert.equal((round2.payload as { submit: { table_id: string } }).submit.table_id, "B");
  // the move fails on transport → round 2 is NOT sent
  const srv = new FakeServer([["A", 1], ["B", 1]]);
  const deps = srv.deps();
  const realMove = deps.moveTableV2!;
  let down = true;
  deps.moveTableV2 = async (a) => { if (down) throw new TypeError("Failed to fetch"); return realMove(a); };
  await drainOffline(CTX, "reconnect", deps);
  assert.deepEqual(srv.names(), ["open_table", "round"], "round 2 waits behind the move");
  down = false;
  await localdb.operations.update(cap.operationId, { last_attempt_at: new Date(0).toISOString() });
  await drainOffline(CTX, "reconnect", deps);
  assert.deepEqual(srv.names(), ["open_table", "round", "move_v2", "round"]);
  const o = [...srv.orders.values()][0];
  assert.equal(o.table_id, "B");
  assert.equal(o.items.length, 2, "round 2 appended to the moved bill on B");
});

// ================================================================ MERGE

test("MERGE UNPAID + UNPAID offline: primary shows both bills, source free; replay folds once (second drain 0 calls)", async () => {
  const A = row("A"), B = row("B");
  const a = await offlineSession("A", [{ name: "Pizza", price: 100, qty: 1 }]);
  const b = await offlineSession("B", [{ name: "Salad", price: 50, qty: 1 }]);
  // the picker offers a table whose bill exists only on this device (projected floor = occupied)
  const floor = overlayTableTotals([A, B], await getOperationalTableTotals(SCOPE, [A, B], undefined, MAP_AT));
  assert.deepEqual(mergeableSources(floor, floor[0]).map((t) => t.id), ["B"]);
  assert.deepEqual(moveDestinations(floor, floor[0]).map((t) => t.id), [], "never a move target");
  const cap = await captureMergeTablesOffline({ scope: SCOPE, primary: A, sources: [B], mapLoadedAt: MAP_AT });
  assert.ok(cap.ok);
  assert.equal(cap.outstanding, 150);
  assert.equal((await localdb.dineDrafts.get(b.local_session_id))?.status, "merged");
  const pA = await proj(A);
  assert.equal(pA.gross, 150);
  assert.equal(pA.outstanding, 150);
  assert.equal((await proj(B)).bill.orders.length, 0);
  assert.equal(await getDineDraftForTable(SCOPE, "B"), null, "B is free for a new order");
  void a;

  localdb.close();
  await localdb.open(); // restart before replay

  const srv = new FakeServer([["A", 1], ["B", 1]]);
  await drain(srv);
  assert.deepEqual(srv.names(), ["open_table", "round", "open_table", "round", "merge_v4"]);
  const mg = srv.calls[4].payload as Record<string, unknown>;
  const [oa, ob] = [...srv.orders.values()];
  assert.deepEqual(mg.expected_orders, { A: oa.id, B: ob.id });
  assert.deepEqual(mg.expected_paid_settlements, { [oa.id]: 0, [ob.id]: 0 });
  assert.equal(ob.status, "voided");
  assert.equal(srv.total(oa), 150);
  assert.equal((await getOperation(cap.operationId))?.status, "synced");
  const again = new FakeServer([["A", 1], ["B", 1]]);
  await drain(again);
  assert.equal(again.calls.length, 0);
});

test("MERGE PARTIAL + UNPAID (mandatory case): P stays on its source, only R moves, no payment created, collected/drawer unchanged, final settle = Σ R, replay = 0 effects", async () => {
  const A = row("A"), B = row("B");
  // A: Steak 100 (paid by an offline split leg) + Fries 50 (unpaid) → P = 100, R = 50
  const a = await offlineSession("A", [{ name: "Steak", price: 100, qty: 1 }, { name: "Fries", price: 50, qty: 1 }]);
  const steak = a.lines.find((l) => l.name === "Steak")!;
  const leg = await splitOperationalBillOffline({ scope: DSCOPE, orderId: null, orderLocal: a.local_session_id, allocations: [{ line_local: steak.line_id, quantity: 1 }], method: "cash", currency: "LBP", tableName: "A", dependencyIds: sessionBarrier(a) });
  assert.ok(leg.ok);
  // B: Salad 30 (unpaid) → R = 30
  const b = await offlineSession("B", [{ name: "Salad", price: 30, qty: 1 }]);
  const before = await proj(A);
  assert.equal(before.paidPending, 100);
  assert.equal(before.outstanding, 50);

  const cap = await captureMergeTablesOffline({ scope: SCOPE, primary: B, sources: [A], mapLoadedAt: MAP_AT });
  assert.ok(cap.ok, cap.ok ? "" : cap.reason);
  assert.equal(cap.outstanding, 80, "R_primary + Σ R_sources");
  const mop = (await getOperation(cap.operationId))!;
  const preview = (mop.payload as { preview: Record<string, { moved_line_ids: string[]; retained_line_ids: string[] }> }).preview;
  assert.deepEqual(preview.A.retained_line_ids, [steak.line_id], "the paid line stays on its source");
  assert.equal(preview.A.moved_line_ids.length, 1);
  assert.ok(mop.dependency_ids.includes(leg.ok ? leg.operationId : ""), "the merge replays after the split leg");
  const pB = await proj(B);
  assert.equal(pB.gross, 80);
  assert.equal(pB.collected, 0);
  assert.equal(pB.paidPending, 0);
  assert.equal(pB.outstanding, 80);
  assert.equal((await proj(A)).bill.orders.length, 0, "the part-paid source is free locally");
  assert.equal((await opsOf("split_settle")).length, 1, "no payment op created by the merge");
  assert.equal((await opsOf("pay_table")).length, 0);

  // settle the merged primary offline — it waits for the merge (barrier)
  const settle = await settleTableOffline({ sessionId: b.local_session_id, method: "cash", extraDependencyIds: pB.pendingMutationOpIds, covers: { orderIds: [], summary: false } });
  assert.ok((await getOperation(settle.operationId))!.dependency_ids.includes(cap.operationId));

  const srv = new FakeServer([["A", 1], ["B", 1]]);
  await drain(srv);
  assert.deepEqual(srv.names(), ["open_table", "round", "split", "open_table", "round", "merge_v4", "pay_table"]);
  const oA = [...srv.orders.values()].find((o) => o.table_id === "A")!;
  const oB = [...srv.orders.values()].find((o) => o.table_id === "B")!;
  const mg = srv.calls[5].payload as Record<string, unknown>;
  assert.deepEqual(mg.expected_paid_settlements, { [oA.id]: 1, [oB.id]: 0 }, "paid-state pin from this device's leg");
  // source: completed for exactly P, its payment untouched
  assert.equal(oA.status, "completed");
  assert.equal(srv.total(oA), 100);
  assert.deepEqual(srv.payments.filter((p) => p.order_id === oA.id).map((p) => p.amount), [100]);
  // primary: T_p + R_s, settled for Σ R
  assert.equal(srv.total(oB), 80);
  const pay = srv.calls[6].payload as { expectedOrderIds: string[] };
  assert.deepEqual(pay.expectedOrderIds, [oB.id], "pay_table bound to the merged bill");
  assert.deepEqual(srv.payments.map((p) => p.amount), [100, 80], "final settle = Σ R; P never charged again");
  assert.equal(srv.drawer(), 180, "Σ payments = Σ T (150 + 30)");
  // replay the same merge → 0 effects
  const frozen = (await getOperation(cap.operationId))!.payload as { resolved: Parameters<NonNullable<PosTxnSyncDeps["mergeTablesV4"]>>[0]["payload"] };
  const snapshot = JSON.stringify([...srv.orders.values()]);
  const r = await srv.deps().mergeTablesV4!({ payload: frozen.resolved });
  assert.equal(r.idempotent, true);
  assert.equal(JSON.stringify([...srv.orders.values()]), snapshot);
  assert.equal(srv.payments.length, 2);
  const second = new FakeServer([["A", 1], ["B", 1]]);
  await drain(second);
  assert.equal(second.calls.length, 0);
});

test("MERGE PARTIAL + PARTIAL (whole items) is accepted; a partly-paid LINE is refused", async () => {
  const a = await offlineSession("A", [{ name: "Steak", price: 100, qty: 1 }, { name: "Fries", price: 50, qty: 1 }]);
  const b = await offlineSession("B", [{ name: "Wine", price: 40, qty: 2 }, { name: "Salad", price: 30, qty: 1 }]);
  const legA = await splitOperationalBillOffline({ scope: DSCOPE, orderId: null, orderLocal: a.local_session_id, allocations: [{ line_local: a.lines[0].line_id, quantity: 1 }], method: "cash", currency: "LBP", tableName: "A", dependencyIds: sessionBarrier(a) });
  assert.ok(legA.ok);
  // B: 1 of 2 wines paid → a partly-paid line
  const legB = await splitOperationalBillOffline({ scope: DSCOPE, orderId: null, orderLocal: b.local_session_id, allocations: [{ line_local: b.lines[0].line_id, quantity: 1 }], method: "cash", currency: "LBP", tableName: "B", dependencyIds: sessionBarrier(b) });
  assert.ok(legB.ok);
  const refused = await captureMergeTablesOffline({ scope: SCOPE, primary: row("A"), sources: [row("B")], mapLoadedAt: MAP_AT });
  assert.deepEqual(refused, { ok: false, reason: MERGE_PARTIAL_LINE_MESSAGE });
  // C: whole items only → PARTIAL + PARTIAL ok
  const c = await offlineSession("C", [{ name: "Cake", price: 20, qty: 1 }, { name: "Tea", price: 5, qty: 1 }]);
  const legC = await splitOperationalBillOffline({ scope: DSCOPE, orderId: null, orderLocal: c.local_session_id, allocations: [{ line_local: c.lines[0].line_id, quantity: 1 }], method: "cash", currency: "LBP", tableName: "C", dependencyIds: sessionBarrier(c) });
  assert.ok(legC.ok);
  const ok = await captureMergeTablesOffline({ scope: SCOPE, primary: row("A"), sources: [row("C")], mapLoadedAt: MAP_AT });
  assert.ok(ok.ok);
  assert.equal(ok.outstanding, 55, "R_A 50 + R_C 5");
  assert.equal((await proj(row("A"))).outstanding, 55);
});

test("MERGE capture refusals: cross-shift, cross-currency, adjusted, part-paid ONLINE, summary-only; MOVE to a non-free table", async () => {
  await offlineSession("A", [{ name: "Pizza", price: 100, qty: 1 }]);
  await offlineSession("B", [{ name: "Salad", price: 50, qty: 1 }], { ...DSCOPE, shiftId: "SRV-SHIFT-OTHER" });
  assert.deepEqual(await captureMergeTablesOffline({ scope: SCOPE, primary: row("A"), sources: [row("B")], mapLoadedAt: MAP_AT }), { ok: false, reason: MERGE_CROSS_SHIFT_MESSAGE });
  assert.deepEqual(await captureMoveTableOffline({ scope: SCOPE, from: row("A"), to: row("B"), mapLoadedAt: MAP_AT }), { ok: false, reason: MOVE_DEST_NOT_FREE_MESSAGE });

  const srv = new FakeServer([["U", 1], ["C", 1], ["D", 1], ["S", 1]]);
  const usd = srv.seedOrder("U", [{ name: "x", price: 1, qty: 1 }], "SRV-SHIFT-1", "USD");
  const usdBill = billOf("U", usd);
  usdBill.orders[0].currency = "USD"; usdBill.currency = "USD";
  await cacheBill("U", usdBill, "t1", "b1", MAP_AT);
  assert.deepEqual(await captureMergeTablesOffline({ scope: SCOPE, primary: row("A"), sources: [occupiedRow("U", 1, { currency: "USD" })], mapLoadedAt: MAP_AT }), { ok: false, reason: MERGE_CROSS_CURRENCY_MESSAGE });

  const disc = srv.seedOrder("C", [{ name: "y", price: 100, qty: 1 }]);
  const discBill = billOf("C", disc);
  discBill.orders[0].discount_amount = 10; discBill.orders[0].total_amount = 90; discBill.total = 90;
  await cacheBill("C", discBill, "t1", "b1", MAP_AT);
  assert.deepEqual(await captureMergeTablesOffline({ scope: SCOPE, primary: row("A"), sources: [occupiedRow("C", 90)], mapLoadedAt: MAP_AT }), { ok: false, reason: MERGE_ADJUSTED_MESSAGE });

  const part = srv.seedOrder("D", [{ name: "z", price: 100, qty: 1 }]);
  await cacheBill("D", billOf("D", part), "t1", "b1", MAP_AT);
  assert.deepEqual(await captureMergeTablesOffline({ scope: SCOPE, primary: row("A"), sources: [occupiedRow("D", 100, { collected: 40, outstanding: 60 })], mapLoadedAt: MAP_AT }), { ok: false, reason: MERGE_ONLINE_PART_PAID_MESSAGE });

  // a bill known only as a map summary (no cached lines)
  assert.deepEqual(await captureMergeTablesOffline({ scope: SCOPE, primary: row("A"), sources: [occupiedRow("S", 70)], mapLoadedAt: MAP_AT }), { ok: false, reason: TABLE_OP_SUMMARY_MESSAGE });
  assert.equal((await localdb.operations.toArray()).filter((o) => o.operation_type === "merge_tables" || o.operation_type === "move_table").length, 0, "nothing captured");
});

test("MERGE server state changed before reconnect (a remote split on the source) → MERGE_PAYMENT_STATE_CHANGED conflict; source restored", async () => {
  await offlineSession("A", [{ name: "Pizza", price: 100, qty: 1 }]);
  const b = await offlineSession("B", [{ name: "Salad", price: 50, qty: 1 }]);
  const cap = await captureMergeTablesOffline({ scope: SCOPE, primary: row("A"), sources: [row("B")], mapLoadedAt: MAP_AT });
  assert.ok(cap.ok);
  const srv = new FakeServer([["A", 1], ["B", 1]]);
  const deps = srv.deps();
  const realRound = deps.submitRound!;
  deps.submitRound = async (p) => {
    const r = await realRound(p);
    if (p.table_id === "B") srv.orders.get(r.order_id)!.settlements = 1; // another terminal took a split payment on B
    return r;
  };
  await drainOffline(CTX, "reconnect", deps);
  const op = (await getOperation(cap.operationId))!;
  assert.equal(op.status, "needs_attention");
  assert.equal(op.last_error_code, "merge_payment_state_changed");
  assert.equal((await localdb.dineDrafts.get(b.local_session_id))?.status, "open", "the source bill is active again");
  assert.equal((await proj(row("A"))).gross, 100, "nothing folded");
  assert.equal((await proj(row("B"))).gross, 50);
});

// ================================================================ END SHIFT / PAY BINDING / CLASSES

test("END SHIFT waits for an offline move / merge (close barrier); a legacy schema-1 move never gates it", async () => {
  assert.ok(CLOSE_RELEVANT_TYPES.has("move_table") && CLOSE_RELEVANT_TYPES.has("merge_tables"));
  await offlineSession("A", [{ name: "Pizza", price: 100, qty: 1 }]);
  const cap = await captureMoveTableOffline({ scope: SCOPE, from: row("A"), to: row("B"), mapLoadedAt: MAP_AT });
  assert.ok(cap.ok);
  const end = await captureEndShiftOffline({ scope: SCOPE, shiftId: "SRV-SHIFT-1", shiftLocal: null, actualCashCounted: 0, notes: null });
  assert.ok((await getOperation(end.operationId))!.dependency_ids.includes(cap.operationId));
  const srv = new FakeServer([["A", 1], ["B", 1]]);
  await drain(srv);
  assert.deepEqual(srv.names(), ["open_table", "round", "move_v2", "end_shift"]);
});

test("PAY_TABLE replay carries expected_order_ids (+ expected_amount when known); PAY_BILL_CHANGED → refused (never fake paid); ALREADY_SETTLED → reflected", async () => {
  const srv = new FakeServer([["A", 1], ["B", 1]]);
  const O1 = srv.seedOrder("A", [{ name: "Steak", price: 300, qty: 1 }]);
  await cacheBill("A", billOf("A", O1), "t1", "b1", MAP_AT);
  const s1 = await settleTableOffline({ sessionId: null, table: { scope: DSCOPE, tableId: "A", tableName: "A", currency: "LBP", orderIds: [O1.id] }, method: "cash", covers: { orderIds: [O1.id], summary: false }, expectedAmount: 300 });
  // the bill was paid elsewhere and a NEW bill opened on A before this device reconnected
  O1.status = "completed"; O1.payment_status = "paid";
  const O2 = srv.seedOrder("A", [{ name: "New", price: 20, qty: 1 }]);
  await drain(srv);
  const call = srv.calls.find((c) => c.name === "pay_table")!.payload as { expectedOrderIds: string[]; expectedAmount: number };
  assert.deepEqual(call.expectedOrderIds, [O1.id]);
  assert.equal(call.expectedAmount, 300);
  const op1 = (await getOperation(s1.operationId))!;
  assert.equal(op1.last_error_code, "pay_bill_changed");
  assert.equal(settleStillCovers(op1), false, "refused → the bill is never shown as paid by this device");
  assert.equal(O2.payment_status, "unpaid", "the newer bill was NOT paid");
  assert.equal(srv.payments.length, 0);

  // ALREADY_SETTLED: every pinned order already paid, table free
  const srv2 = new FakeServer([["B", 1]]);
  const O3 = srv2.seedOrder("B", [{ name: "Fish", price: 50, qty: 1 }]);
  await cacheBill("B", billOf("B", O3), "t1", "b1", MAP_AT);
  const s2 = await settleTableOffline({ sessionId: null, table: { scope: DSCOPE, tableId: "B", tableName: "B", currency: "LBP", orderIds: [O3.id] }, method: "cash", covers: { orderIds: [O3.id], summary: false } });
  O3.status = "completed"; O3.payment_status = "paid";
  await drain(srv2);
  const op2 = (await getOperation(s2.operationId))!;
  assert.equal(op2.last_error_code, "already_settled");
  assert.equal(settleStillCovers(op2), true);
  assert.equal(settlePrecedence(op2, null), "reflected");
});

test("CLASSES: shift busy / deadlock → retryable; occupied / version / shift closed → needs_attention; 42501 → authority", async () => {
  const h = handlerFor("move_table", 2)!;
  const base = { from_table_id: "A", to_table_id: "B", bill: { orders: [{ order_id: "SO-1", order_local: null }] }, paid_pins: null, version_after: { from: null, to: null } };
  const run = async (err: unknown) => {
    const op = { operation_id: "x", operation_type: "move_table", schema_version: 2, client_op_id: "c", payload: { ...base }, scope: {} } as unknown as OfflineOperation;
    return h.replay(op, { deps: { isTransport: (e: unknown) => e instanceof TypeError, moveTableV2: async () => { throw err; } } as unknown as PosTxnSyncDeps, canonicalFor: async () => null, update: async () => undefined });
  };
  const cls = async (e: unknown) => { const r = await run(e); return r.ok ? "ok" : `${r.retryClass}/${r.code}`; };
  assert.equal(await cls(posErr("MERGE_SHIFT_BUSY", "Retry in a moment")), "SERVER_RETRYABLE/server_transient");
  assert.equal(await cls(Object.assign(new Error("deadlock detected"), { code: "40P01" })), "SERVER_RETRYABLE/server_transient");
  assert.equal(await cls(posErr("MOVE_DEST_OCCUPIED")), "CONFLICT/move_dest_occupied");
  assert.equal(await cls(posErr("VERSION_CONFLICT")), "CONFLICT/version_conflict");
  assert.equal(await cls(posErr("MERGE_SHIFT_CLOSED")), "CONFLICT/shift_closed");
  assert.equal(await cls(posErr("UNSUPPORTED_STATE", "UNSUPPORTED_STATE(kitchen_active)")), "CONFLICT/unsupported_state");
  assert.equal(await cls(Object.assign(new Error("Tables belong to different operating units"), { code: "42501", details: JSON.stringify({ pos_error_code: "CROSS_OU_REJECTED" }) })), "AUTHORITY_REFUSED/permission");
  assert.equal(await cls(new TypeError("Failed to fetch")), "TRANSPORT_RETRYABLE/move_table: transport");
  assert.equal(posErrorCode({ message: "x", details: '{"pos_error_code":"MOVE_SOURCE_CHANGED"}' }), "MOVE_SOURCE_CHANGED");
  // ops the scope can see are the only ones projected
  assert.equal((await scopedOperations(SCOPE)).length, 0);
});

// ================================================================ 1.0.38 NATIVE DEFECTS 4 / 5 / 6 (PO: Table 8 + VIP22)

const SHIFT_SCOPE = { kind: "shift" as const, tenantId: "t1", branchId: "b1", shiftId: "SRV-SHIFT-1" };

test("NATIVE BUG 4: Merge VIP22 into Table 8 offline → Orders shows the source MERGED (not Open / Paid / plain Voided), never collectible; Floor agrees; after replay + Pay destination still merged; second drain 0", async () => {
  const T8 = row("T8"), V22 = row("V22");
  await offlineSession("T8", [{ name: "Burger", price: 300, qty: 1 }]);
  const v = await offlineSession("V22", [{ name: "Soda", price: 50, qty: 2 }]);
  const cap = await captureMergeTablesOffline({ scope: SCOPE, primary: T8, sources: [V22], mapLoadedAt: MAP_AT });
  assert.ok(cap.ok);

  const before = (await readOrdersHistoryLocal(SHIFT_SCOPE)).orders;
  const src = before.find((o) => o.table_id === "V22" || o.id === v.local_session_id)!;
  assert.ok(src, "the merged source is still listed (its history is kept)");
  assert.equal(isMergedSource(src), true, `source disposition = merged (got ${src.status}/${src.payment_status})`);
  assert.match(orderLifecycleLabel(src), /^Merged into #/);
  assert.notEqual(src.payment_status, "paid", "never a fake Paid");
  const dest = before.find((o) => o.table_id === "T8")!;
  assert.equal(dest.status, "sent_to_kitchen", "the destination is the one open bill");
  // Floor: source vacated, destination carries both bills' items (one projection).
  const floor = overlayTableTotals([T8, V22], await getOperationalTableTotals(SCOPE, [T8, V22], undefined, MAP_AT));
  assert.deepEqual(selectOpenTables(floor).map((t) => [t.id, t.total]), [["T8", 400]]);

  // Pay the destination offline, then reconnect.
  const d8 = (await getDineDraftForTable(SCOPE, "T8"))!;
  const p8 = await proj(T8);
  const settle = await settleTableOffline({ sessionId: d8.local_session_id, method: "cash", extraDependencyIds: p8.pendingMutationOpIds, covers: { orderIds: [], summary: false } });
  assert.ok((await getOperation(settle.operationId))!.dependency_ids.includes(cap.operationId), "the payment replays after the merge");
  const srv = new FakeServer([["T8", 1], ["V22", 1]]);
  await drain(srv);
  assert.equal(srv.names().filter((n) => n === "merge_v4").length, 1, "one merge effect");
  assert.equal(srv.names().filter((n) => n === "pay_table").length, 1, "one payment call");
  const [o8, o22] = [...srv.orders.values()];
  assert.equal(o22.status, "voided");
  assert.equal(o22.merged_into, o8.id);
  assert.equal(o8.payment_status, "paid");
  assert.deepEqual(srv.payments.map((p) => [p.order_id, p.amount]), [[o8.id, 400]], "exactly one payment, on the destination, for both bills");
  const after = (await readOrdersHistoryLocal(SHIFT_SCOPE)).orders;
  const srcAfter = after.find((o) => o.table_id === "V22")!;
  assert.equal(isMergedSource(srcAfter), true, "still merged after reconnect");
  const again = new FakeServer([["T8", 1], ["V22", 1]]);
  await drain(again);
  assert.equal(again.calls.length, 0, "second reconnect: zero new effects");
});

test("NATIVE BUG 4: a canonical snapshot that already holds the server's merged source keeps the server's word; a PART-PAID source completes (not voided)", () => {
  const snap = [
    { id: "S1", order_number: "0006", status: "voided", payment_status: "unpaid", merged_into_order_id: "P1", table_id: "V22", created_at: "1" },
    { id: "P1", order_number: "0005", status: "completed", payment_status: "paid", table_id: "T8", created_at: "0" },
  ] as never[];
  const merged = mergeOrdersHistory(snap, [], new Map(), [{ sourceIds: ["S1"], primaryIds: ["P1"], partPaid: new Set(), pending: false }]);
  assert.equal(merged.find((o) => o.id === "S1")?.merged_into_order_id, "P1");
  const pp = mergeOrdersHistory([{ id: "S2", order_number: "0007", status: "sent_to_kitchen", payment_status: "partial", table_id: "A", created_at: "2" }, { id: "P2", order_number: "0008", status: "sent_to_kitchen", payment_status: "unpaid", table_id: "B", created_at: "3" }] as never[], [], new Map(), [{ sourceIds: ["S2"], primaryIds: ["P2"], partPaid: new Set(["S2"]), pending: true }]);
  const s2 = pp.find((o) => o.id === "S2")!;
  assert.equal(s2.status, "completed");
  assert.equal(s2.payment_status, "paid");
  assert.equal(s2.merged_into_order_number, "0008");
});

test("NATIVE BUG 5: after an unsynced MERGE the version-checked edit is (correctly) unavailable, and an INCREASE is a NEW round — replayed exactly once, no duplicate demand, second drain 0", async () => {
  const T8 = row("T8"), V22 = row("V22");
  const d8 = await offlineSession("T8", [{ name: "Burger", price: 300, qty: 1 }]);
  await offlineSession("V22", [{ name: "Soda", price: 50, qty: 1 }]);
  assert.ok((await captureMergeTablesOffline({ scope: SCOPE, primary: T8, sources: [V22], mapLoadedAt: MAP_AT })).ok);
  const p = await proj(T8);
  const burger = p.bill.orders[0].lines.find((l) => l.name === "Burger")!;
  const edit = editTargetFor(p, burger.id);
  assert.equal(edit.ok, false, "the root cause: no bill version is known after an unsynced merge");
  // The fix: the extra quantity as a new round (same item, price snapshot, modifiers).
  const sent = (await localdb.dineDrafts.get(d8.local_session_id))!.lines.find((l) => l.line_id === burger.id) ?? null;
  const extra = additionalRoundLineFor(burger, 2, sent)!;
  assert.equal(extra.quantity, 2);
  assert.equal(extra.base_price, 300);
  assert.notEqual(extra.line_id, burger.id, "a new line — the sent round is never rewritten");
  const draft = (await getDineDraftForTable(SCOPE, "T8"))!;
  await stageUnsentDraftLines(draft.local_session_id, [extra]);
  await sendRoundOffline(draft.local_session_id);
  const p2 = await proj(T8);
  assert.equal(p2.gross, 300 + 50 + 600, "Floor / panel / payment total include the extra round");
  assert.equal(additionalRoundLineFor({ ...burger, menu_item_id: null }, 1), null, "a pre-offline summary line cannot be re-ordered");
  assert.equal(additionalRoundLineFor(burger, 0), null);

  const srv = new FakeServer([["T8", 1], ["V22", 1]]);
  await drain(srv);
  const rounds = srv.calls.filter((c) => c.name === "round");
  assert.equal(rounds.length, 3, "T8 round 1, V22 round 1, the extra-quantity round");
  const o8 = [...srv.orders.values()].find((o) => o.table_id === "T8" && o.status === "open")!;
  assert.deepEqual(o8.items.map((i) => [i.name, i.qty]).sort(), [["Burger", 1], ["Burger", 2], ["Soda", 1]], "original round + new round + merged item; nothing rewritten, nothing doubled");
  assert.equal(srv.total(o8), 950);
  const again = new FakeServer([["T8", 1], ["V22", 1]]);
  await drain(again);
  assert.equal(again.calls.length, 0, "second reconnect: zero new effects");
});

test("NATIVE BUG 6: Open Tables reads the effective floor — a bill opened offline is open there (Floor: occupied ⇔ Open Tables: listed); settled → removed; partial → remaining outstanding", async () => {
  const T8 = row("T8"), T9 = row("T9");
  await offlineSession("T8", [{ name: "Burger", price: 300, qty: 1 }]);
  assert.equal(selectOpenTables([T8, T9]).length, 0, "the RAW cached map (what Open Tables read) says 0 — the PO's defect");
  const floor = overlayTableTotals([T8, T9], await getOperationalTableTotals(SCOPE, [T8, T9], undefined, MAP_AT));
  const open = selectOpenTables(floor);
  assert.deepEqual(open.map((t) => [t.id, t.total, t.outstanding]), [["T8", 300, 300]]);
  assert.equal(floor.find((t) => t.id === "T8")?.occupied, true);
});
