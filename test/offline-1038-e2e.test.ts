// 1.0.38 Workstream F — adversarial END-TO-END proofs (client follow-ups for Bug 9 / Move-Merge hold / D4 item
// edits, plus the whole offline replay spine).
//
// Real Dexie (fake-indexeddb), the REAL capture engines, projections, orchestrator and handlers. Only the server
// RPCs are injected — by a FAKE SERVER that models the prod_1038 contracts faithfully enough to catch a second
// effect: an idempotency table keyed by client_op_id (with a request fingerprint where the contract has one),
// bill pins (expected_order_ids), table / order versions (CAS), S4 remaining-obligation semantics R = T − P for
// pay AND on-account (the S2 model: expected_amount / expected_order_ids, ON_ACCOUNT_BILL_CHANGED /
// ON_ACCOUNT_AMOUNT_CHANGED, ALREADY_SETTLED / ALREADY_PAID), shift / customer / address existence checks (a local
// id leaking to the server is refused exactly like production), and two side-effect counters — a GL-queue
// counter (one per financial posting: payment row or receivable) and an inventory-demand counter (net quantity
// sent to the kitchen). Every scenario ends with a SECOND reconnect that must produce zero calls and zero state
// change.

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

import { localdb, cacheBill, type PosOfflineTxn } from "@/lib/offline/db";
import { getOperation, requeueOperation, type OfflineOperation } from "@/lib/offline/operationLog";
import { drainOffline, __resetDrainLockForTests, __setReplayTimeoutForTests } from "@/lib/offline/orchestrator";
import type { PosTxnSyncDeps } from "@/lib/offline/posTxnSync";
import {
  openTableOffline,
  addDraftLine,
  sendRoundOffline,
  settleTableOffline,
  tableOnAccountOffline,
  splitOperationalBillOffline,
  sessionBarrier,
  getDineDraftForTable,
} from "@/lib/offline/dineinOffline";
import {
  getOperationalTableBill,
  getOperationalTableTotals,
  overlayTableTotals,
  tablesWithUnreflectedWork,
  structuralHoldReason,
  STRUCTURAL_UNSYNCED_HOLD_MESSAGE,
  offlineSettleAmount,
  PART_PAID_OFFLINE_SETTLE_MESSAGE,
  settlePrecedence,
  settleRefusedByServer,
  getOperationalOrderProjection,
  editTargetFor,
  orderChainFor,
} from "@/lib/offline/operationalProjection";
import { captureMoveTableOffline, captureMergeTablesOffline } from "@/lib/offline/tableOpOffline";
import { captureCustomerUpsertOffline } from "@/lib/offline/customerOffline";
import { captureDeliveryProviderOffline } from "@/lib/offline/deliveryActionOffline";
import { captureEditOrderLineOffline, captureAddOrderItemsOffline } from "@/lib/offline/itemEditOffline";
import { capturePayOrderOffline, payOrderClientOpId } from "@/lib/offline/payOrderOffline";
import { projectTxnToQueueOrder } from "@/lib/offline/deliveryQueueOffline";
import { orderRefFor, editTargetWithOrderRef, liveCaptureDependencies } from "@/lib/offline/orderRef";
import { orderOnAccountOffline } from "@/lib/offline/orderOnAccountOffline";
import { captureEndShiftOffline } from "@/lib/offline/endShiftOffline";
import { createLocalPendingShift } from "@/lib/offline/pendingShift";
import { resolveEntity } from "@/lib/offline/entityMap";
import { loadOrdersHistoryOfflineAware } from "@/lib/offline/ordersHistoryOffline";
import { buildSetQuantityPayload, buildAddItemsPayload } from "@/lib/pos/orders";
import { payTableGate, serverDeductsPriorPayments, setServerDeductsPriorPayments, settleAmountDue, PART_PAID_FULL_PAY_MESSAGE } from "@/lib/pos/tablePayment";
import { getDeviceIdentity } from "@/lib/device";
import type { TableBill, TableSummary, BillOrder } from "@/types/tables";
import type { ShiftOpenOrder } from "@/lib/pos/shiftOrderSummary";

const DEV = getDeviceIdentity();
const SCOPE = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: DEV.device_id, terminalId: DEV.terminal_id ?? null };
const DSCOPE = { ...SCOPE, shiftId: "SRV-SHIFT-1" };
const CTX = { ...SCOPE, online: true };
const MAP_AT = Date.now() - 10 * 60_000; // the cached floor was read before any of this work
const tick = () => new Promise((r) => setTimeout(r, 4)); // distinct created_at → deterministic FIFO

beforeEach(async () => {
  await Promise.all([
    localdb.operations.clear(), localdb.entityMap.clear(), localdb.syncHistory.clear(), localdb.dineDrafts.clear(),
    localdb.snapshots.clear(), localdb.posOfflineTxns.clear(), localdb.pendingShifts.clear(), localdb.posCustomers.clear(),
  ]);
  __resetDrainLockForTests();
  setServerDeductsPriorPayments(null);
});
afterEach(() => {
  __setReplayTimeoutForTests(45_000);
  setServerDeductsPriorPayments(null);
});

// ================================================================ the fake server (contract model)

type SItem = { id: string; client_line_id: string | null; menu_item_id: string; name: string; price: number; qty: number; paid_qty: number; batch: number; void: boolean };
type SOrder = {
  id: string; table_id: string | null; order_type: string; status: "open" | "completed" | "voided";
  payment_status: "unpaid" | "partial" | "paid"; settlement_mode: "on_account" | null; shift_id: string; currency: string;
  items: SItem[]; settlements: number; version: number; customer_id: string | null; address_id: string | null;
  provider_id: string | null; fee: number; discount: number; merged_into?: string; created_at: string;
};
type Call = { name: string; payload: unknown };
const posErr = (code: string, msg = code) => Object.assign(new Error(msg), { code: "P0001", details: JSON.stringify({ pos_error_code: code }) });
const sorted = (a: string[]) => [...a].sort();
const stable = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));
const MENU: Record<string, { name: string; price: number }> = { mP: { name: "Pizza", price: 100 }, mC: { name: "Cola", price: 10 }, mS: { name: "Shawarma", price: 300 }, mF: { name: "Fries", price: 50 }, mL: { name: "Salad", price: 40 } };

class FakeServer {
  shifts = new Map<string, { status: "open" | "closed" }>([["SRV-SHIFT-1", { status: "open" }]]);
  tables = new Map<string, { version: number; status: "available" | "occupied" }>();
  orders = new Map<string, SOrder>();
  payments: { order_id: string; amount: number; method: string; kind: "sale" | "split" | "on_account_now"; op: string }[] = [];
  receivables: { order_id: string; customer_id: string; amount: number; op: string }[] = [];
  customers = new Map<string, { name: string | null; phone: string | null }>();
  addresses = new Map<string, { customer_id: string; street: string | null }>();
  providerAssignments: { order_id: string; provider_id: string }[] = [];
  submissions = new Map<string, { type: string; fp: string; result: Record<string, unknown> }>();
  calls: Call[] = [];
  glQueue = 0;
  inventoryDemand = 0;
  seq = 0;
  /** test hooks: fail the next call of a dep with this error (before any effect), or lose its response (after). */
  failNext = new Map<string, unknown>();
  loseNext = new Set<string>();

  constructor(tables: [string, number][] = []) {
    for (const [id, v] of tables) this.tables.set(id, { version: v, status: "available" });
  }
  id(p: string) { return `${p}-${++this.seq}`; }
  live(o: SOrder) { return o.items.filter((i) => !i.void); }
  total(o: SOrder) { return this.live(o).reduce((s, i) => s + i.price * i.qty, 0) + o.fee - o.discount; }
  paidP(o: SOrder) { return this.live(o).reduce((s, i) => s + i.price * i.paid_qty, 0); }
  openOn(t: string) { return [...this.orders.values()].filter((o) => o.table_id === t && o.status === "open"); }
  bump(t: string) { const r = this.tables.get(t)!; r.version += 1; return r.version; }
  drawer() { return this.payments.filter((p) => p.method === "cash").reduce((s, p) => s + p.amount, 0); }
  pay(order_id: string, amount: number, method: string, kind: "sale" | "split" | "on_account_now", op: string) {
    this.payments.push({ order_id, amount, method, kind, op });
    this.glQueue += 1;
  }
  newOrder(o: Partial<SOrder> & { shift_id: string }): SOrder {
    const order: SOrder = { id: this.id("SO"), table_id: null, order_type: "dine_in", status: "open", payment_status: "unpaid", settlement_mode: null, currency: "LBP", items: [], settlements: 0, version: 0, customer_id: null, address_id: null, provider_id: null, fee: 0, discount: 0, created_at: new Date().toISOString(), ...o };
    this.orders.set(order.id, order);
    return order;
  }
  addItems(o: SOrder, items: { menu_item_id?: string; name?: string; base_price?: number; quantity: number; client_line_id?: string }[]) {
    const batch = o.items.reduce((m, i) => Math.max(m, i.batch), 0) + 1;
    for (const it of items) {
      const menu = MENU[String(it.menu_item_id)] ?? { name: String(it.name ?? "Item"), price: Number(it.base_price ?? 0) };
      o.items.push({ id: this.id("SI"), client_line_id: it.client_line_id ?? null, menu_item_id: String(it.menu_item_id ?? "m"), name: it.name ?? menu.name, price: it.base_price ?? menu.price, qty: it.quantity, paid_qty: 0, batch, void: false });
      this.inventoryDemand += it.quantity;
    }
  }
  seedOrder(table: string, items: { menu_item_id: string; qty: number }[]): SOrder {
    const o = this.newOrder({ table_id: table, shift_id: "SRV-SHIFT-1" });
    this.addItems(o, items.map((i) => ({ menu_item_id: i.menu_item_id, quantity: i.qty })));
    this.tables.get(table)!.status = "occupied";
    this.bump(table);
    return o;
  }
  /** a split leg paid on the server (e.g. by another terminal before this device went offline). */
  seedSplit(o: SOrder, itemIdx: number, method: string) {
    const it = o.items[itemIdx];
    it.paid_qty = it.qty;
    o.settlements += 1;
    o.payment_status = "partial";
    this.pay(o.id, it.price * it.qty, method, "split", this.id("SEED"));
  }
  shiftOk(id: unknown) {
    const s = typeof id === "string" ? this.shifts.get(id) : undefined;
    if (!s) throw new Error("Shift not found for this tenant/branch");
    if (s.status !== "open") throw new Error("This shift is already closed.");
  }
  /** Everything a second reconnect must leave untouched. */
  state() {
    return stable({ o: [...this.orders.values()], p: this.payments, r: this.receivables, c: [...this.customers], a: [...this.addresses], pa: this.providerAssignments, t: [...this.tables], s: [...this.shifts], gl: this.glQueue, inv: this.inventoryDemand });
  }
  names() { return this.calls.map((c) => c.name); }
  count(name: string) { return this.calls.filter((c) => c.name === name).length; }

  deps(over: Partial<PosTxnSyncDeps> = {}): PosTxnSyncDeps {
    const rec = (name: string, payload: unknown) => {
      this.calls.push({ name, payload: JSON.parse(JSON.stringify(payload ?? null)) });
      const f = this.failNext.get(name);
      if (f !== undefined) {
        this.failNext.delete(name);
        throw f;
      }
    };
    const lose = <T>(name: string, v: T): T => {
      if (this.loseNext.has(name)) {
        this.loseNext.delete(name);
        throw Object.assign(new Error("Service Unavailable"), { status: 503 }); // committed, response lost
      }
      return v;
    };
    const cached = (op: string) => {
      const s = this.submissions.get(op);
      return s ? { ...s.result, idempotent: true } : null;
    };
    const d: Partial<PosTxnSyncDeps> = {
      isTransport: (e) => e instanceof TypeError,
      hasSession: async () => true,
      openShift: async (a) => {
        rec("open_shift", a);
        const hit = cached(a.clientOpId);
        if (hit) return { shiftId: String(hit.shiftId), reused: true };
        const id = this.id("SH");
        this.shifts.set(id, { status: "open" });
        this.submissions.set(a.clientOpId, { type: "shift", fp: "", result: { shiftId: id } });
        return lose("open_shift", { shiftId: id, reused: false });
      },
      endShiftOp: async (a) => {
        rec("end_shift", a);
        const hit = cached(a.clientOpId);
        if (hit) return { shift_id: a.shiftId, idempotent: true };
        this.shiftOk(a.shiftId);
        this.shifts.get(a.shiftId)!.status = "closed";
        this.submissions.set(a.clientOpId, { type: "end", fp: "", result: {} });
        return { shift_id: a.shiftId, idempotent: false };
      },
      openTable: async (p) => {
        rec("open_table", p);
        const hit = cached(p.client_op_id);
        if (hit) return hit as never;
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
        const hit = cached(op);
        if (hit) return hit as never;
        const open = this.openOn(String(p.table_id));
        if (p.expected_order_id && (open.length !== 1 || open[0].id !== p.expected_order_id)) throw posErr("EXPECTED_ORDER_MISMATCH", "EXPECTED_ORDER_MISMATCH: bill changed");
        let o = open[0];
        if (!o) {
          this.shiftOk(p.shift_id);
          o = this.newOrder({ table_id: String(p.table_id), shift_id: String(p.shift_id) });
          this.tables.get(String(p.table_id))!.status = "occupied";
        }
        this.addItems(o, p.items as never);
        const result = { order_id: o.id, order_number: o.id, batch_no: o.items.reduce((m, i) => Math.max(m, i.batch), 0), appended: true };
        this.submissions.set(op, { type: "round", fp: "", result });
        return { ...result, idempotent: false };
      },
      submit: async (p) => {
        rec("submit", p);
        const op = String(p.client_op_id);
        const hit = cached(op);
        if (hit) return hit as never;
        this.shiftOk(p.shift_id);
        const pp = p as unknown as Record<string, unknown>;
        if (pp.customer_id != null && !this.customers.has(String(pp.customer_id))) throw new Error("Customer not found for this operating unit");
        if (pp.address_id != null && !this.addresses.has(String(pp.address_id))) throw new Error("Address not found for this customer");
        const o = this.newOrder({ order_type: String(pp.order_type ?? "takeaway"), shift_id: String(p.shift_id), customer_id: (pp.customer_id as string) ?? null, address_id: (pp.address_id as string) ?? null, fee: Number(pp.delivery_fee ?? 0) || 0 });
        this.addItems(o, p.items as never);
        const result = { order_id: o.id, order_number: o.id };
        this.submissions.set(op, { type: "submit", fp: "", result });
        return lose("submit", result);
      },
      pay: async (a) => {
        rec("pay", a);
        const o = this.orders.get(a.orderId);
        if (!o) throw new Error("Order not found");
        if (o.payment_status === "paid") throw new Error("Order already paid"); // state-guarded (no op id)
        const r = this.total(o) - this.paidP(o);
        this.pay(o.id, r, "cash", "sale", "takeaway");
        o.status = "completed";
        o.payment_status = "paid";
        return { amount: r };
      },
      payOrderOp: async (a) => {
        rec("pay_order", a);
        const hit = cached(a.clientOpId);
        if (hit) return hit as never;
        const o = this.orders.get(a.orderId);
        if (!o) throw new Error("Order not found");
        if (o.status !== "open") throw new Error("This order is already paid");
        const disc = (a.discount ?? {}) as { delivery_fee?: number; discount_type?: string; discount_value?: number };
        if (disc.delivery_fee != null) o.fee = disc.delivery_fee;
        if (disc.discount_type === "amount") o.discount = Number(disc.discount_value) || 0;
        const P = this.paidP(o);
        const R = this.total(o) - P;
        if (P > 0 && R <= 0.005) throw posErr("ALREADY_PAID", "ALREADY_PAID: nothing left to pay");
        this.pay(o.id, R, a.method, "sale", a.clientOpId);
        o.status = "completed";
        o.payment_status = "paid";
        o.version += 1;
        const result = { order_id: o.id, paid: true, amount: R };
        this.submissions.set(a.clientOpId, { type: "pay_order", fp: "", result });
        return lose("pay_order", { ...result, idempotent: false });
      },
      payTable: async (a) => {
        rec("pay_table", a);
        const hit = cached(a.clientOpId);
        if (hit) return hit as never;
        const open = this.openOn(a.tableId);
        if (a.expectedOrderIds) {
          if (open.length === 0) {
            if (a.expectedOrderIds.every((id) => this.orders.get(id)?.status === "completed")) throw posErr("ALREADY_SETTLED", "This bill was already settled.");
            throw posErr("PAY_BILL_CHANGED", "The bill on this table changed since the payment was captured.");
          }
          if (stable(sorted(open.map((o) => o.id))) !== stable(sorted(a.expectedOrderIds))) throw posErr("PAY_BILL_CHANGED", "The bill on this table changed since the payment was captured.");
        }
        if (open.length === 0) throw new Error("no open order on this table");
        const due = open.reduce((s, o) => s + this.total(o) - this.paidP(o), 0); // S4: R = T − P
        if (a.expectedAmount != null && Math.abs(due - a.expectedAmount) >= 0.005) throw posErr("PAY_AMOUNT_CHANGED");
        for (const o of open) {
          this.pay(o.id, this.total(o) - this.paidP(o), a.method, "sale", a.clientOpId);
          o.status = "completed";
          o.payment_status = "paid";
        }
        this.tables.get(a.tableId)!.status = "available";
        const result = { ok: true, amount: due, pos_entity_version: this.bump(a.tableId) };
        this.submissions.set(a.clientOpId, { type: "pay", fp: "", result });
        return lose("pay_table", { ...result, idempotent: false });
      },
      orderItemMap: async ({ orderId }) => (this.orders.get(orderId)?.items ?? []).filter((i) => i.client_line_id).map((i) => ({ client_line_id: i.client_line_id as string, order_item_id: i.id })),
      splitSettle: async (a) => {
        rec("split", a);
        const hit = cached(a.clientOpId);
        if (hit) return hit as never;
        const o = this.orders.get(a.orderId)!;
        let amount = 0;
        for (const al of a.allocations) {
          const it = o.items.find((i) => i.id === al.order_item_id)!;
          it.paid_qty += al.quantity;
          amount += it.price * al.quantity;
        }
        o.settlements += 1;
        o.payment_status = "partial";
        o.version += 1;
        this.pay(o.id, amount, a.method, "split", a.clientOpId);
        const result = { ok: true, split_no: o.settlements, parent_completed: false, remaining_qty: 0 };
        this.submissions.set(a.clientOpId, { type: "split", fp: "", result });
        return { ...result, idempotent: false };
      },
      onAccountTable: async (a) => {
        rec("on_account_table", a);
        const hit = cached(a.clientOpId);
        if (hit) return hit as never;
        const open = this.openOn(a.tableId);
        const r = this.onAccount(open, a, () => {
          if (open.length === 0 && a.expectedOrderIds?.every((id) => this.orders.get(id)?.status === "completed")) throw posErr("ALREADY_SETTLED", "This bill was already settled.");
        });
        this.tables.get(a.tableId)!.status = "available";
        this.bump(a.tableId);
        return r;
      },
      onAccountOrder: async (a) => {
        rec("on_account_order", a);
        const hit = cached(a.clientOpId);
        if (hit) return hit as never;
        const o = this.orders.get(a.orderId);
        if (!o) throw new Error("Order not found");
        return this.onAccount(o.status === "open" ? [o] : [], a, () => {
          if (o.status === "completed") throw posErr("ALREADY_SETTLED", "This order was already settled.");
        });
      },
      upsertCustomer: async (a) => {
        rec("customer", a);
        const hit = cached(a.clientOpId);
        if (hit) return hit as never;
        const p = a.payload as { id?: string; name?: string; phone?: string; address?: { street?: string; id?: string } };
        let cid = p.id ?? null;
        if (cid) {
          const c = this.customers.get(cid);
          if (!c) throw Object.assign(new Error("Customer not found for this operating unit"), { code: "42501" });
          if (p.name) c.name = p.name;
        } else {
          cid = this.id("SC");
          this.customers.set(cid, { name: p.name ?? null, phone: p.phone ?? null });
        }
        let aid: string | null = null;
        if (p.address && !p.address.id) {
          aid = this.id("SA");
          this.addresses.set(aid, { customer_id: cid, street: p.address.street ?? null });
        }
        const result = { customer_id: cid, address_id: aid, is_new: !p.id };
        this.submissions.set(a.clientOpId, { type: "customer", fp: "", result });
        return result;
      },
      editOrderLine: async ({ payload: p }) => {
        rec("edit_line", p);
        const hit = cached(String(p.client_op_id));
        if (hit) return hit as never;
        const o = this.orders.get(String(p.order_id));
        if (!o) throw new Error("Order not found");
        if (o.payment_status !== "unpaid" || o.status !== "open") throw new Error("Only an open, unpaid order can be edited.");
        if (Number(p.expected_version) !== o.version) throw posErr("VERSION_CONFLICT", "VERSION_CONFLICT: the order changed since it was loaded");
        const it = o.items.find((i) => i.id === p.target_item_id && !i.void);
        if (!it) throw new Error("Order line not found");
        const n = Number(p.new_quantity);
        let replacement: string | null = null;
        if (n > it.qty) {
          const delta = { ...it, id: this.id("SI"), client_line_id: null, qty: n - it.qty, batch: o.items.reduce((m, i) => Math.max(m, i.batch), 0) + 1 };
          o.items.push(delta);
          this.inventoryDemand += n - it.qty;
          replacement = delta.id;
        } else {
          it.void = true;
          this.inventoryDemand -= it.qty - n;
          if (n > 0) {
            const nl = { ...it, id: this.id("SI"), client_line_id: null, qty: n, void: false };
            o.items.push(nl);
            replacement = nl.id;
          }
        }
        o.version += 1;
        const result = { ok: true, replacement_order_item_id: replacement, pos_entity_version: o.version };
        this.submissions.set(String(p.client_op_id), { type: "edit", fp: "", result });
        return { ...result, idempotent: false };
      },
      addOrderItems: async ({ payload: p }) => {
        rec("add_items", p);
        const hit = cached(String(p.client_op_id));
        if (hit) return hit as never;
        const o = this.orders.get(String(p.order_id));
        if (!o) throw new Error("Order not found");
        if (Number(p.expected_version) !== o.version) throw posErr("VERSION_CONFLICT", "VERSION_CONFLICT: the order changed since it was loaded");
        this.addItems(o, p.items as never);
        o.version += 1;
        const result = { ok: true, pos_entity_version: o.version };
        this.submissions.set(String(p.client_op_id), { type: "add", fp: "", result });
        return { ...result, idempotent: false };
      },
      setDeliveryProviderOp: async ({ payload: p }) => {
        rec("provider", p);
        const hit = cached(String(p.client_op_id));
        if (hit) return hit as never;
        const o = this.orders.get(String(p.order_id));
        if (!o) throw new Error("Order not found");
        o.provider_id = String(p.provider_id);
        this.providerAssignments.push({ order_id: o.id, provider_id: o.provider_id });
        this.submissions.set(String(p.client_op_id), { type: "provider", fp: "", result: { ok: true } });
        return { ok: true, idempotent: false };
      },
      moveTableV2: async ({ payload: p }) => {
        rec("move_v2", p);
        const fp = stable({ ...p, client_op_id: undefined });
        const s = this.submissions.get(p.client_op_id);
        if (s) {
          if (s.fp !== fp) throw posErr("IDEMPOTENCY_PAYLOAD_MISMATCH");
          return { ...s.result, idempotent: true } as never;
        }
        const from = this.tables.get(p.from_table_id)!;
        const to = this.tables.get(p.to_table_id)!;
        if (p.expected_from_version != null && from.version !== p.expected_from_version) throw posErr("VERSION_CONFLICT");
        if (p.expected_to_version != null && to.version !== p.expected_to_version) throw posErr("VERSION_CONFLICT");
        const src = this.openOn(p.from_table_id);
        if (stable(sorted(src.map((o) => o.id))) !== stable(sorted(p.expected_order_ids))) throw posErr("MOVE_SOURCE_CHANGED");
        if (src.length === 0) throw posErr("MOVE_SOURCE_EMPTY");
        if (p.expected_paid_settlements) for (const o of src) if (o.settlements !== (p.expected_paid_settlements[o.id] ?? 0)) throw posErr("MOVE_PAYMENT_STATE_CHANGED");
        if (this.openOn(p.to_table_id).length > 0) throw posErr("MOVE_DEST_OCCUPIED");
        for (const o of src) o.table_id = p.to_table_id;
        from.status = "available";
        to.status = "occupied";
        const result = { ok: true, orders_moved: src.length, order_ids: src.map((o) => o.id), table_versions: { [p.from_table_id]: this.bump(p.from_table_id), [p.to_table_id]: this.bump(p.to_table_id) } };
        this.submissions.set(p.client_op_id, { type: "move", fp, result });
        return { ...result, idempotent: false };
      },
      mergeTablesV4: async ({ payload: p }) => {
        rec("merge_v4", p);
        const fp = stable({ ...p, client_op_id: undefined });
        const s = this.submissions.get(p.client_op_id);
        if (s) {
          if (s.fp !== fp) throw posErr("IDEMPOTENCY_PAYLOAD_MISMATCH");
          return { ...s.result, idempotent: true } as never;
        }
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
        for (const sId of p.source_table_ids) {
          const o = bills.get(sId)!;
          if (o.items.some((i) => i.paid_qty > 0 && i.paid_qty < i.qty)) throw posErr("UNSUPPORTED_STATE", "UNSUPPORTED_STATE(partial_line)");
          const batch = prim.items.reduce((m, i) => Math.max(m, i.batch), 0) + 1;
          const moving = o.items.filter((i) => i.paid_qty === 0 && !i.void);
          o.items = o.items.filter((i) => i.paid_qty > 0);
          for (const i of moving) prim.items.push({ ...i, batch });
          if (o.settlements > 0) { o.status = "completed"; o.payment_status = "paid"; } else o.status = "voided";
          o.merged_into = prim.id;
          this.tables.get(sId)!.status = "available";
        }
        const result = { ok: true, merge_id: this.id("MG"), primary_order_id: prim.id, sources_merged: p.source_table_ids.length, pos_entity_version: 9, table_versions: Object.fromEntries(all.map((t) => [t, this.bump(t)])) };
        this.submissions.set(p.client_op_id, { type: "merge", fp, result });
        return { ...result, idempotent: false };
      },
      ...over,
    };
    return d as PosTxnSyncDeps;
  }

  /** S2 model of pos_complete_(table_)on_account: pins, R = T − P, amount now, receivable R − now. */
  private onAccount(open: SOrder[], a: { customerId: string; amount: number; method: string; clientOpId: string; expectedOrderIds?: string[] | null; expectedAmount?: number | null }, closed: () => void) {
    if (!this.customers.has(a.customerId)) throw Object.assign(new Error("Customer not found for this operating unit"), { code: "42501" });
    if (a.expectedOrderIds) {
      if (open.length === 0) {
        closed();
        throw posErr("ON_ACCOUNT_BILL_CHANGED", "The bill changed since it was put on account.");
      }
      if (stable(sorted(open.map((o) => o.id))) !== stable(sorted(a.expectedOrderIds))) throw posErr("ON_ACCOUNT_BILL_CHANGED", "The bill changed since it was put on account.");
    }
    if (open.length === 0) throw new Error("No open order to put on account");
    const T = open.reduce((s, o) => s + this.total(o), 0);
    const P = open.reduce((s, o) => s + this.paidP(o), 0);
    const R = T - P;
    if (P > 0 && R <= 0.005) throw posErr("ALREADY_PAID", "ALREADY_PAID: the bill is fully covered by prior payments");
    if (a.expectedAmount != null && Math.abs(R - a.expectedAmount) >= 0.005) throw posErr("ON_ACCOUNT_AMOUNT_CHANGED", "The amount due changed since it was put on account.");
    if (a.amount > R + 0.005) throw new Error("Amount exceeds the outstanding balance");
    const first = open[0];
    if (a.amount > 0) this.pay(first.id, a.amount, a.method, "on_account_now", a.clientOpId);
    if (R - a.amount > 0.005) {
      this.receivables.push({ order_id: first.id, customer_id: a.customerId, amount: R - a.amount, op: a.clientOpId });
      this.glQueue += 1;
    }
    for (const o of open) {
      o.status = "completed";
      o.payment_status = P > 0 || a.amount > 0 ? "partial" : "unpaid";
      o.settlement_mode = "on_account";
      o.customer_id = a.customerId;
    }
    const result = { ok: true };
    this.submissions.set(a.clientOpId, { type: "on_account", fp: "", result });
    return { ...result, idempotent: false };
  }

  // --- canonical read models (what an online refresh shows) ---
  mapRows(): TableSummary[] {
    return [...this.tables.keys()].map((id) => {
      const open = this.openOn(id);
      const total = open.reduce((s, o) => s + this.total(o), 0);
      const collected = open.reduce((s, o) => s + this.paidP(o), 0);
      return row(id, open.length > 0 ? { orders: open.length, occupied: true, status: "occupied", total, collected, outstanding: total - collected, order_number: open[0].id, pos_entity_version: this.tables.get(id)!.version } : { pos_entity_version: this.tables.get(id)!.version });
    });
  }
  bill(t: string): TableBill | null {
    const open = this.openOn(t);
    if (open.length === 0) return null;
    const orders: BillOrder[] = open.map((o) => ({
      id: o.id, order_number: o.id, status: "sent_to_kitchen", payment_status: o.payment_status, pos_entity_version: o.version, shift_id: o.shift_id, branch_id: "b1", tenant_id: "t1",
      subtotal: this.total(o), discount_amount: 0, total_amount: this.total(o), currency: "LBP", exchange_rate: null, created_at: o.created_at,
      lines: this.live(o).map((i) => ({ id: i.id, menu_item_id: i.menu_item_id, name: i.name, quantity: i.qty, base_price: i.price, modifiers_total: 0, final_unit_price: i.price, line_total: i.price * i.qty, kitchen_note: null, batch_no: i.batch, modifiers: [] })),
    }));
    const total = orders.reduce((s, o) => s + o.total_amount, 0);
    return { tableId: t, orders, subtotal: total, total, currency: "LBP", mixedCurrency: false, splitShift: false, batches: [1] };
  }
  history(shiftId: string): ShiftOpenOrder[] {
    return [...this.orders.values()].filter((o) => o.shift_id === shiftId).map((o) => ({
      id: o.id, order_number: o.id, order_type: o.order_type, status: o.status, payment_status: o.settlement_mode === "on_account" ? "on_account" : o.payment_status, payment_method: null,
      subtotal: this.total(o), discount_amount: 0, total_amount: this.total(o), currency: "LBP", table_id: o.table_id, customer_id: o.customer_id, customer_name: null, customer_phone: null,
      cashier_user_id: "u1", staff_name: null, notes: null, created_at: o.created_at,
    }) as ShiftOpenOrder);
  }
}

// ================================================================ local fixtures + helpers

const row = (id: string, over: Partial<TableSummary> = {}): TableSummary =>
  ({ id, name: id, seats: 4, occupied: false, status: "available", canonical: true, configured: true, sort_order: 1, orders: 0, order_number: null, opened_at: null, total: null, collected: null, outstanding: null, currency: "LBP", mixed_currency: false, pos_entity_version: 1, ...over }) as TableSummary;

async function offlineSession(tableId: string, lines: { menu_item_id: string; qty: number }[], scope = DSCOPE) {
  const d = await openTableOffline({ scope, tableId, tableName: tableId, seats: 4, currency: "LBP" });
  for (const l of lines) await addDraftLine(d.local_session_id, { menu_item_id: l.menu_item_id, name: MENU[l.menu_item_id].name, base_price: MENU[l.menu_item_id].price, quantity: l.qty, modifiers: [], kitchen_note: null });
  return sendRoundOffline(d.local_session_id);
}

/** The DineInWorkspace offline settle target, from the SAME pure rule the workspace uses. */
async function settleTarget(t: TableSummary, mapAt = MAP_AT) {
  const p = await getOperationalTableBill(SCOPE, t, undefined, undefined, mapAt);
  const amount = offlineSettleAmount(p, serverDeductsPriorPayments());
  const draft = await getDineDraftForTable(SCOPE, t.id);
  const canonicalIds = p.orders.filter((o) => o.orderLocal == null).map((o) => o.orderId).filter((x): x is string => !!x);
  return {
    p,
    amount,
    sessionId: draft ? draft.local_session_id : null,
    table: canonicalIds.length > 0 ? { scope: DSCOPE, tableId: t.id, tableName: t.name, currency: "LBP", orderIds: canonicalIds } : undefined,
    covers: { orderIds: canonicalIds, summary: p.summaryOnly },
    deps: p.pendingMutationOpIds,
  };
}

const drain = (srv: FakeServer, over: Partial<PosTxnSyncDeps> = {}) => drainOffline(CTX, "reconnect", srv.deps(over));
async function restart() {
  localdb.close();
  await localdb.open();
  __resetDrainLockForTests();
}
const pastBackoff = async () => {
  for (const o of await localdb.operations.toArray()) if (o.status === "retryable") await localdb.operations.update(o.operation_id, { last_attempt_at: new Date(0).toISOString() });
};
const allOps = () => localdb.operations.toArray();
const attention = async () => (await allOps()).filter((o) => o.status === "needs_attention");

/** The second reconnect: no call reaches the server and no server state changes; the queue stays clean. */
async function secondReconnectIsZero(srv: FakeServer, label: string) {
  const before = srv.state();
  const n = srv.calls.length;
  const opsBefore = stable(await allOps());
  for (let i = 0; i < 2; i++) {
    await restart();
    const r = await drain(srv);
    assert.equal(r.drained.length, 0, `${label}: nothing replayed again`);
  }
  assert.deepEqual(srv.calls.slice(n).map((c) => c.name), [], `${label}: zero calls on the second reconnect`);
  assert.equal(srv.state(), before, `${label}: zero additional effects`);
  assert.equal(stable(await allOps()), opsBefore, `${label}: the op log is unchanged`);
}

const LOCAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** No server-call field that names an entity carries a LOCAL (uuid) id: every order / customer / address /
 *  line / table / shift reference reached the server canonically. (client_op_id / client_line_id are
 *  correlation tags and allowed.) */
function assertNoLocalIdsSent(srv: FakeServer) {
  const FIELDS = ["order_id", "orderId", "customer_id", "customerId", "address_id", "target_item_id", "table_id", "tableId", "shift_id", "shiftId", "expected_order_id", "from_table_id", "to_table_id", "primary_table_id"];
  for (const c of srv.calls) {
    const walk = (v: unknown) => {
      if (!v || typeof v !== "object") return;
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (FIELDS.includes(k) && typeof x === "string") assert.ok(!LOCAL_UUID.test(x), `${c.name}.${k} sent a local id ${x}`);
        if (k === "expectedOrderIds" || k === "expected_order_ids") for (const id of x as string[]) assert.ok(!LOCAL_UUID.test(id), `${c.name}.${k} pinned a local id`);
        walk(x);
      }
    };
    walk(c.payload);
  }
}

// ================================================================ client follow-ups (unit level)

test("Bug 9: serverDeductsPriorPayments() is FALSE by default — the F1 guard still refuses a part-paid full settle (Pay / On Account / offline)", async () => {
  assert.equal(serverDeductsPriorPayments(), false);
  const t = row("T", { orders: 1, occupied: true, status: "occupied", total: 180, collected: 150 });
  const srv = new FakeServer([["T", 1]]);
  const o = srv.seedOrder("T", [{ menu_item_id: "mP", qty: 1 }, { menu_item_id: "mF", qty: 1 }, { menu_item_id: "mC", qty: 3 }]);
  srv.seedSplit(o, 0, "card");
  srv.seedSplit(o, 1, "cash");
  const bill = srv.bill("T")!;
  const gate = payTableGate({ takePayments: { allowed: true, reason: null }, table: t, bill, hasOpenShift: true, online: true, settling: false });
  assert.deepEqual(gate, { allowed: false, reason: PART_PAID_FULL_PAY_MESSAGE });
  assert.equal(settleAmountDue(180, 150), 180, "the dialog keeps T while the guard is on (it never opens for this bill)");
  await cacheBill("T", bill, "t1", "b1", MAP_AT);
  const tg = await settleTarget(srv.mapRows()[0]);
  assert.deepEqual(tg.amount, { ok: false, reason: PART_PAID_OFFLINE_SETTLE_MESSAGE }, "offline Pay / On Account refused at capture");
  // flipped at release (or by a server capability): the gate opens and the amount is R = T − P
  setServerDeductsPriorPayments(true);
  assert.equal(payTableGate({ takePayments: { allowed: true, reason: null }, table: t, bill, hasOpenShift: true, online: true, settling: false }).allowed, true);
  assert.equal(settleAmountDue(180, 150), 30);
  const tg2 = await settleTarget(srv.mapRows()[0]);
  assert.deepEqual(tg2.amount, { ok: true, exactAmount: 30 });
  setServerDeductsPriorPayments(null);
  assert.equal(serverDeductsPriorPayments(), false, "null returns to the release default");
});

test("Move/Merge HOLD: an online Move/Merge is held for a table with unsynced / unreflected offline work; clears once reflected", async () => {
  await offlineSession("A", [{ menu_item_id: "mP", qty: 1 }]);
  const w1 = await tablesWithUnreflectedWork(SCOPE, MAP_AT);
  assert.ok(w1.structuralHold.has("A"));
  assert.equal(structuralHoldReason(["A"], w1.structuralHold), STRUCTURAL_UNSYNCED_HOLD_MESSAGE);
  assert.equal(structuralHoldReason(["B", "A"], w1.structuralHold), STRUCTURAL_UNSYNCED_HOLD_MESSAGE, "a held SOURCE / destination holds the merge / move too");
  assert.equal(structuralHoldReason(["B"], w1.structuralHold), null);
  const srv = new FakeServer([["A", 1], ["B", 1]]);
  await drain(srv);
  // synced but the map on screen predates it → still held (the online floor has not caught up)
  assert.ok((await tablesWithUnreflectedWork(SCOPE, MAP_AT)).structuralHold.has("A"));
  // the refreshed map reflects it → released
  assert.equal((await tablesWithUnreflectedWork(SCOPE, Date.now())).structuralHold.size, 0);
  // an authoritatively REFUSED settle never holds the table forever; a parked-behind-prerequisite one does
  const s = await settleTableOffline({ sessionId: null, table: { scope: DSCOPE, tableId: "B", tableName: "B", currency: "LBP", orderIds: ["SO-X"] }, method: "cash", covers: { orderIds: ["SO-X"], summary: false } });
  await localdb.operations.update(s.operationId, { status: "needs_attention", last_error_code: "pay_bill_changed", last_error_message: "The bill changed" });
  assert.equal((await tablesWithUnreflectedWork(SCOPE, Date.now())).structuralHold.has("B"), false);
  await localdb.operations.update(s.operationId, { last_error_code: "dependency_failed", last_error_message: "round" });
  assert.equal((await tablesWithUnreflectedWork(SCOPE, Date.now())).structuralHold.has("B"), true);
});

test("D4 item edits: the edit target follows the ONE order reference (entity map), never the projection's legacy-row guess", async () => {
  const LINE = "aaaaaaaa-0000-4000-8000-0000000000e1";
  const txn = deliveryTxn("LOCAL-E1", [{ menu_item_id: "mS", base_price: 300, quantity: 2, client_line_id: LINE }]);
  await localdb.posOfflineTxns.add(txn);
  // (1) still local: the create-op dependency is ADDED (a parked create escalates the edit, never blocks it forever)
  const p0 = await getOperationalOrderProjection(SCOPE, projectTxnToQueueOrder(txn));
  const t0 = editTargetFor(p0, LINE);
  assert.ok(t0.ok);
  if (!t0.ok) return;
  assert.ok(!t0.target.dependencyIds.includes("mig:txn:LOCAL-E1"), "the projection alone omits the create op");
  const r0 = editTargetWithOrderRef(t0.target, await orderRefFor("LOCAL-E1", SCOPE));
  assert.deepEqual([r0.orderId, r0.orderLocal, r0.payloadOrderId], [null, "LOCAL-E1", "LOCAL-E1"]);
  assert.ok(r0.dependencyIds.includes("mig:txn:LOCAL-E1"));
  // (2) the order synced and its legacy row reconciled, but the detail still shows the LOCAL row: the projection
  // thinks it is canonical under the LOCAL id (rc.8-class defect) — the ref re-points it at the canonical order.
  const srv = new FakeServer();
  srv.customers.set("SC-0", { name: "Rana", phone: null });
  srv.addresses.set("SA-0", { customer_id: "SC-0", street: null });
  await drain(srv);
  const synced = (await localdb.posOfflineTxns.get("LOCAL-E1"))!;
  assert.equal(synced.status, "synced");
  const serverId = synced.server_order_id!;
  const localRow = { ...projectTxnToQueueOrder(synced), id: "LOCAL-E1", pos_entity_version: 0 };
  const p1 = await getOperationalOrderProjection(SCOPE, localRow);
  const t1 = orderChainFor(p1.orders[0]);
  assert.ok(t1.ok);
  if (!t1.ok) return;
  assert.equal(t1.target.orderId, "LOCAL-E1", "defect reproduced: the projection would send the LOCAL id as a canonical order id");
  const r1 = editTargetWithOrderRef(t1.target, await orderRefFor("LOCAL-E1", SCOPE));
  assert.deepEqual([r1.orderId, r1.orderLocal, r1.payloadOrderId, r1.dependencyIds], [serverId, null, serverId, []]);
  const cid = crypto.randomUUID();
  await captureAddOrderItemsOffline({ scope: SCOPE, orderId: r1.orderId, orderLocal: r1.orderLocal, payload: { ...buildAddItemsPayload({ orderId: r1.payloadOrderId, items: [{ menu_item_id: "mF", quantity: 1 }], expectedVersion: r1.expectedVersion, clientOpId: cid }) } as never, clientOpId: cid, chain: { versionAfterOp: r1.versionAfterOp, dependencyIds: r1.dependencyIds } });
  await drain(srv);
  assert.equal((await attention()).length, 0);
  assert.equal(srv.count("add_items"), 1);
  assert.equal(srv.orders.get(serverId)!.items.length, 2);
  assertNoLocalIdsSent(srv);
  await secondReconnectIsZero(srv, "D4");
});

test("Bug 9 handlers: on-account replays send the frozen bill pins; refusal codes map to refused, ALREADY_* to reflected", async () => {
  const srv = new FakeServer([["T", 1]]);
  srv.customers.set("SC-1", { name: "A", phone: null });
  const o = srv.seedOrder("T", [{ menu_item_id: "mP", qty: 1 }]);
  await cacheBill("T", srv.bill("T")!, "t1", "b1", MAP_AT);
  const tg = await settleTarget(srv.mapRows()[0]);
  assert.ok(tg.amount.ok);
  const cap = await tableOnAccountOffline({ sessionId: null, table: tg.table, customerId: "SC-1", amount: 0, method: "cash", covers: tg.covers, expectedAmount: tg.amount.ok ? tg.amount.exactAmount : null });
  assert.equal((await getOperation(cap.operationId))!.payload && ((await getOperation(cap.operationId))!.payload as { expected_amount: number }).expected_amount, 100);
  // first attempt: transport down AFTER the pins froze → the retry sends the byte-identical pins
  srv.failNext.set("on_account_table", new TypeError("Failed to fetch"));
  await drain(srv);
  const frozen = ((await getOperation(cap.operationId))!.payload as { resolved_pins: unknown }).resolved_pins;
  assert.deepEqual(frozen, { order_ids: [o.id], amount: 100 });
  await pastBackoff();
  await drain(srv);
  const sent = srv.calls.filter((c) => c.name === "on_account_table").map((c) => c.payload as { expectedOrderIds: string[]; expectedAmount: number });
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0], sent[1], "frozen request");
  assert.deepEqual([sent[1].expectedOrderIds, sent[1].expectedAmount], [[o.id], 100]);
  assert.equal((await getOperation(cap.operationId))!.status, "synced");
  assert.deepEqual(srv.receivables.map((r) => r.amount), [100]);
  await secondReconnectIsZero(srv, "on-account frozen pins");
});

// ================================================================ (a) Dine-In

test("E2E (a) Dine-In: offline open → rounds → pay → local release → restart → reconnect → canonical Paid → map refresh → second reconnect = 0", async () => {
  const T1 = row("T1");
  const d = await offlineSession("T1", [{ menu_item_id: "mP", qty: 2 }]);
  await addDraftLine(d.local_session_id, { menu_item_id: "mC", name: "Cola", base_price: 10, quantity: 1, modifiers: [], kitchen_note: null });
  await sendRoundOffline(d.local_session_id);
  const tg = await settleTarget(T1);
  assert.ok(tg.amount.ok);
  assert.equal(tg.p.gross, 210);
  // 1.0.38 G3 (updated intentionally) — the amount this device collected is ALWAYS pinned, local delta or not.
  assert.equal(tg.amount.ok && tg.amount.exactAmount, 210, "R_local: the amount collected offline");
  const s = await settleTableOffline({ sessionId: tg.sessionId, method: "cash", covers: tg.covers, extraDependencyIds: tg.deps, expectedAmount: tg.amount.ok ? tg.amount.exactAmount : null });
  // local release: the table is free for a new order, the floor shows it available
  assert.equal(await getDineDraftForTable(SCOPE, "T1"), null);
  const offFloor = overlayTableTotals([T1], await getOperationalTableTotals(SCOPE, [T1], undefined, MAP_AT));
  assert.deepEqual([offFloor[0].orders, offFloor[0].status], [0, "available"]);

  await restart();
  const srv = new FakeServer([["T1", 1]]);
  // reconnect #1: the rounds land, the pay hits a dropped connection — and the online floor refreshes right
  // then (navigate away / back): a CANONICAL map that shows the bill open (summary, no cached bill).
  srv.failNext.set("pay_table", new TypeError("Failed to fetch"));
  await drain(srv);
  const midRows = srv.mapRows();
  const midAt = Date.now();
  assert.deepEqual([midRows[0].orders, midRows[0].total], [1, 210], "the server still holds the bill open");
  {
    const work = await tablesWithUnreflectedWork(SCOPE, midAt);
    const shown = overlayTableTotals(midRows, await getOperationalTableTotals(SCOPE, midRows, work.touched, midAt));
    assert.deepEqual([shown[0].orders, shown[0].status], [0, "available"], "mid-sync: the bill this device settled never resurrects as unpaid");
    assert.ok(work.syncingSettle.has("T1"), "mid-sync: online Pay / rounds on it are held");
  }
  await tick();
  await pastBackoff();
  const r = await drain(srv);
  assert.equal(r.needsAttention.length, 0, JSON.stringify(r.needsAttention));
  assert.deepEqual(srv.names(), ["open_table", "round", "round", "pay_table", "pay_table"]);
  const orders = [...srv.orders.values()];
  assert.equal(orders.length, 1, "one order");
  const o = orders[0];
  assert.deepEqual([o.status, o.payment_status, o.table_id], ["completed", "paid", "T1"]);
  assert.deepEqual(o.items.map((i) => [i.name, i.qty, i.batch]), [["Pizza", 2, 1], ["Cola", 1, 2]], "two rounds, once each");
  assert.deepEqual(srv.payments.map((p) => [p.amount, p.method]), [[210, "cash"]]);
  assert.equal(srv.drawer(), 210);
  assert.equal(srv.receivables.length, 0);
  assert.equal(srv.glQueue, 1);
  assert.equal(srv.inventoryDemand, 3);
  assert.equal(srv.tables.get("T1")!.status, "available");
  assert.deepEqual((srv.calls[4].payload as { expectedOrderIds: string[] }).expectedOrderIds, [o.id], "pay bound to the session's canonical order");
  assert.equal(stable(srv.calls[3].payload), stable(srv.calls[4].payload), "the retried pay is the frozen request");
  assert.equal((await getOperation(s.operationId))!.status, "synced");

  // map refresh after the drain (navigate away / back): fresh server floor + the stale offline-cached one
  for (const [label, rows, at] of [["fresh", srv.mapRows(), Date.now()], ["stale mid-sync", midRows, midAt]] as const) {
    const work = await tablesWithUnreflectedWork(SCOPE, at);
    const shown = overlayTableTotals([...rows], await getOperationalTableTotals(SCOPE, [...rows], work.touched, at));
    assert.deepEqual([shown[0].orders, shown[0].status], [0, "available"], `${label}: no resurrection`);
    assert.equal(work.syncingSettle.has("T1"), false, `${label}: not held`);
    assert.equal(work.refusedSettle.has("T1"), false);
    const p = await getOperationalTableBill(SCOPE, shown[0], undefined, undefined, at);
    assert.deepEqual([p.bill.orders.length, p.settlementConflict], [0, false], `${label}: no unpaid ghost bill`);
    const gate = payTableGate({ takePayments: { allowed: true, reason: null }, table: shown[0], bill: p.bill, hasOpenShift: true, online: true, settling: false });
    assert.equal(gate.allowed, false, `${label}: the payment dialog has nothing to collect`);
  }
  assert.equal(await getDineDraftForTable(SCOPE, "T1"), null);
  // Orders History (online, same precedence rule): exactly one row for the order, Paid
  const hist = await loadOrdersHistoryOfflineAware({ kind: "shift", tenantId: "t1", branchId: "b1", shiftId: "SRV-SHIFT-1" }, { reachable: async () => true, loadShift: async () => srv.history("SRV-SHIFT-1") });
  assert.deepEqual(hist.orders.map((x) => [x.id, x.payment_status]), [[o.id, "paid"]], "no duplicate / unpaid local twin");
  assertNoLocalIdsSent(srv);
  await secondReconnectIsZero(srv, "dine-in");
});

// ================================================================ (b) Takeaway

function takeawayTxn(id: string, items: { menu_item_id: string; base_price: number; quantity: number }[], over: Partial<PosOfflineTxn> = {}): PosOfflineTxn {
  const cop = crypto.randomUUID();
  return {
    local_txn_id: id, client_op_id: cop, tenant_id: "t1", branch_id: "b1", device_id: DEV.device_id, terminal_id: DEV.terminal_id, cashier_user_id: "u1", cashier_user_name: "A", shift_id: "SRV-SHIFT-1",
    created_at: new Date().toISOString(),
    order_payload: { branch_id: "b1", order_type: "takeaway", status: "sent_to_kitchen", shift_id: "SRV-SHIFT-1", client_op_id: cop, notes: null, items: items.map((i) => ({ ...i, name: MENU[i.menu_item_id].name, kitchen_note: null, modifiers: [] })) },
    payment_intent: null, sent_to_kitchen: true, currency: "LBP", total: items.reduce((s, i) => s + i.base_price * i.quantity, 0), status: "queued", attempts: 0,
    ...over,
  } as PosOfflineTxn;
}

test("E2E (b) Takeaway: offline create → edit (re-send) → cash pay → reconnect (response lost once) → exactly one order + one payment; flap pay after sync; second reconnect = 0", async () => {
  const t = takeawayTxn("TK-1", [{ menu_item_id: "mP", base_price: 100, quantity: 1 }]);
  await localdb.posOfflineTxns.add(t);
  // edit before sync: the cart re-send updates the SAME row (one logical order)
  const edited = { ...(t.order_payload as object), items: [{ menu_item_id: "mP", name: "Pizza", base_price: 100, quantity: 2, kitchen_note: null, modifiers: [] }, { menu_item_id: "mC", name: "Cola", base_price: 10, quantity: 1, kitchen_note: null, modifiers: [] }] };
  await localdb.posOfflineTxns.update("TK-1", { order_payload: edited, total: 210 });
  await localdb.posOfflineTxns.update("TK-1", { payment_intent: { method: "cash", currency: "LBP" } });
  await restart();
  const srv = new FakeServer();
  srv.loseNext.add("submit"); // the order committed, the response was lost
  await drain(srv);
  await pastBackoff();
  await drain(srv);
  assert.equal((await attention()).length, 0);
  assert.equal(srv.orders.size, 1, "one order despite the lost response (client_op_id)");
  const o = [...srv.orders.values()][0];
  assert.deepEqual(o.items.map((i) => [i.name, i.qty]), [["Pizza", 2], ["Cola", 1]], "the edited cart, once");
  assert.deepEqual(srv.payments.map((p) => [p.amount, p.method]), [[210, "cash"]]);
  assert.deepEqual([srv.glQueue, srv.inventoryDemand, srv.drawer()], [1, 3, 210]);
  assert.equal((await localdb.posOfflineTxns.get("TK-1"))!.status, "synced");
  await secondReconnectIsZero(srv, "takeaway");

  // flap: a second order sent offline, synced UNPAID, then paid offline (C5 bridge) → paid once
  const t2 = takeawayTxn("TK-2", [{ menu_item_id: "mF", base_price: 50, quantity: 2 }]);
  await localdb.posOfflineTxns.add(t2);
  await drain(srv);
  await localdb.posOfflineTxns.update("TK-2", { payment_intent: { method: "cash", currency: "LBP" }, status: "queued", paid: false });
  await drain(srv);
  const o2 = [...srv.orders.values()].find((x) => x.items[0].name === "Fries")!;
  assert.equal(srv.count("submit"), 3, "TK-1 (twice: lost response) + TK-2 once — never re-submitted after the flap");
  assert.deepEqual(srv.payments.filter((p) => p.order_id === o2.id).map((p) => p.amount), [100]);
  assert.deepEqual([srv.glQueue, srv.inventoryDemand], [2, 5]);
  await secondReconnectIsZero(srv, "takeaway flap");
});

// ================================================================ (c) Delivery

function deliveryTxn(id: string, items: { menu_item_id: string; base_price: number; quantity: number; client_line_id: string }[], over: Partial<PosOfflineTxn> = {}): PosOfflineTxn {
  const cop = crypto.randomUUID();
  return {
    local_txn_id: id, client_op_id: cop, tenant_id: "t1", branch_id: "b1", device_id: DEV.device_id, terminal_id: DEV.terminal_id, cashier_user_id: "u1", cashier_user_name: "A", shift_id: "SRV-SHIFT-1",
    created_at: new Date().toISOString(),
    order_payload: { branch_id: "b1", order_type: "delivery", status: "sent_to_kitchen", shift_id: "SRV-SHIFT-1", client_op_id: cop, notes: null, customer_id: "SC-0", address_id: "SA-0", delivery_fee: 20, items: items.map((i) => ({ ...i, name: MENU[i.menu_item_id].name, kitchen_note: null, modifiers: [] })) },
    payment_intent: null, sent_to_kitchen: true, currency: "LBP", total: items.reduce((s, i) => s + i.base_price * i.quantity, 0) + 20, status: "queued", attempts: 0,
    ...over,
  } as PosOfflineTxn;
}

/** The useDeliveryItemEditing offline capture, step for step: projection target → ONE order ref → capture. */
async function editLine(orderId: string, lineId: string, newQuantity: number) {
  const txn = (await localdb.posOfflineTxns.get(orderId))!;
  const p = await getOperationalOrderProjection(SCOPE, projectTxnToQueueOrder(txn));
  const t = editTargetFor(p, lineId);
  if (!t.ok) throw new Error(t.reason);
  const r = editTargetWithOrderRef(t.target, await orderRefFor(orderId, SCOPE));
  const cid = crypto.randomUUID();
  const payload = buildSetQuantityPayload({ orderId: r.payloadOrderId, lineId, newQuantity, expectedVersion: r.expectedVersion, clientOpId: cid, reason: newQuantity < 99 ? "change" : null });
  const c = await captureEditOrderLineOffline({ scope: SCOPE, orderId: r.orderId, orderLocal: r.orderLocal, payload: payload as never, clientOpId: cid, chain: { targetRef: r.ref, versionAfterOp: r.versionAfterOp, dependencyIds: r.dependencyIds } });
  await tick();
  return c.operationId;
}

test("E2E (c) Delivery: customer + phone + address + order + provider + items add/edit/decrease/remove + pay → restart → reconnect → exactly one of each; no local id reaches the server; second reconnect = 0", async () => {
  const L1 = "aaaaaaaa-0000-4000-8000-0000000000c1";
  const L2 = "aaaaaaaa-0000-4000-8000-0000000000c2";
  const cust = await captureCustomerUpsertOffline({ scope: SCOPE, upsert: { branch_id: "b1", name: "Rana", phone: "70000002", address: { street: "Hamra St" } }, clientOpId: crypto.randomUUID() });
  const localCust = cust.localCustomerId!;
  const localAddr = cust.localAddressId!;
  await tick();
  const base = deliveryTxn("DL-1", [{ menu_item_id: "mS", base_price: 300, quantity: 2, client_line_id: L1 }, { menu_item_id: "mF", base_price: 50, quantity: 1, client_line_id: L2 }]);
  await localdb.posOfflineTxns.add({ ...base, order_payload: { ...(base.order_payload as object), customer_id: localCust, address_id: localAddr }, customer_local: localCust, address_local: localAddr } as PosOfflineTxn);
  await tick();
  const ref = await orderRefFor("DL-1", SCOPE);
  const provId = crypto.randomUUID();
  await captureDeliveryProviderOffline({ scope: SCOPE, orderId: ref.orderId, orderLocal: ref.orderLocal, payload: { order_id: "DL-1", provider_id: "PRV-1", cost: null, cost_provided: false, client_op_id: provId }, clientOpId: provId, dependencyIds: ref.dependencyIds });
  await tick();
  // items: decrease L1 2→1, remove L2, add Salad×2, then increase the ADDED line 2→3
  await editLine("DL-1", L1, 1);
  await editLine("DL-1", L2, 0);
  {
    const txn = (await localdb.posOfflineTxns.get("DL-1"))!;
    const p = await getOperationalOrderProjection(SCOPE, projectTxnToQueueOrder(txn));
    const t = orderChainFor(p.orders[0]);
    if (!t.ok) throw new Error(t.reason);
    const r = editTargetWithOrderRef(t.target, await orderRefFor("DL-1", SCOPE));
    assert.ok(r.dependencyIds.includes("mig:txn:DL-1"), "a local order's edit depends on its create op (D4)");
    const cid = crypto.randomUUID();
    const added = "aaaaaaaa-0000-4000-8000-0000000000c3";
    const built = buildAddItemsPayload({ orderId: r.payloadOrderId, items: [{ menu_item_id: "mL", quantity: 2 }], expectedVersion: r.expectedVersion, clientOpId: cid });
    await captureAddOrderItemsOffline({ scope: SCOPE, orderId: r.orderId, orderLocal: r.orderLocal, payload: { ...built, items: built.items.map((it) => ({ ...it, client_line_id: added })) } as never, clientOpId: cid, chain: { versionAfterOp: r.versionAfterOp, dependencyIds: r.dependencyIds }, previewItems: [{ client_line_id: added, menu_item_id: "mL", name: "Salad", base_price: 40, quantity: 2, kitchen_note: null, modifiers: [] }] });
    await tick();
    await editLine("DL-1", added, 3);
  }
  // projection == what the server will hold: 300 + 3×40 + fee 20
  const txn = (await localdb.posOfflineTxns.get("DL-1"))!;
  const proj = await getOperationalOrderProjection(SCOPE, projectTxnToQueueOrder(txn));
  assert.equal(proj.row.total_amount, 440);
  // pay offline (waits for the create, the provider and every edit)
  const pref = await orderRefFor("DL-1", SCOPE);
  const pay = await capturePayOrderOffline({ scope: SCOPE, orderId: pref.orderId, orderLocal: pref.orderLocal, method: "cash", currency: "LBP", clientOpId: payOrderClientOpId(SCOPE, "DL-1", "cash", "LBP"), orderNumber: "OFF", dependencyIds: [...pref.dependencyIds, ...(await liveCaptureDependencies(proj.mutationOpIds))], orderType: "delivery" });

  await restart();
  const srv = new FakeServer();
  const r = await drain(srv);
  assert.equal(r.needsAttention.length, 0, JSON.stringify(r.needsAttention));
  assert.equal(srv.names()[srv.names().length - 1], "pay_order", "the settle replays last");
  assert.deepEqual([srv.orders.size, srv.customers.size, srv.addresses.size, srv.providerAssignments.length, srv.payments.length], [1, 1, 1, 1, 1], "exactly one order / customer / address / provider assignment / payment");
  const o = [...srv.orders.values()][0];
  const [cid] = [...srv.customers.keys()];
  const [aid] = [...srv.addresses.keys()];
  assert.deepEqual([o.customer_id, o.address_id, o.provider_id, o.order_type], [cid, aid, "PRV-1", "delivery"]);
  assert.deepEqual(srv.live(o).map((i) => [i.name, i.qty]).sort(), [["Salad", 2], ["Salad", 1], ["Shawarma", 1]].sort(), "decrease, remove, add, increase — each once");
  assert.equal(srv.total(o), 440);
  assert.deepEqual(srv.payments.map((p) => [p.amount, p.method]), [[440, "cash"]]);
  assert.deepEqual([srv.glQueue, srv.inventoryDemand, srv.drawer(), o.version], [1, 4, 440, 5]);
  assert.equal((await getOperation(pay.operationId))!.status, "synced");
  assertNoLocalIdsSent(srv);
  // after mapping, no local id stays referenced by the device's own read models
  assert.equal((await localdb.posOfflineTxns.get("DL-1"))!.server_order_id, o.id);
  assert.equal((await localdb.posCustomers.get(localCust)) ?? null, null, "the pending-local customer was promoted to its canonical id");
  assert.ok(await localdb.posCustomers.get(cid));
  const hist = await loadOrdersHistoryOfflineAware({ kind: "shift", tenantId: "t1", branchId: "b1", shiftId: "SRV-SHIFT-1" }, { reachable: async () => true, loadShift: async () => srv.history("SRV-SHIFT-1") });
  assert.deepEqual(hist.orders.map((x) => [x.id, x.payment_status]), [[o.id, "paid"]], "no OFF-* / local twin");
  await secondReconnectIsZero(srv, "delivery");
});

// ================================================================ (d) Move

test("E2E (d) Move: open bill → move offline → restart → reconnect → moved once → second reconnect = 0; server-changed → conflict, nothing moved", async () => {
  await offlineSession("A", [{ menu_item_id: "mP", qty: 1 }]);
  const cap = await captureMoveTableOffline({ scope: SCOPE, from: row("A"), to: row("B"), mapLoadedAt: MAP_AT });
  assert.ok(cap.ok);
  await restart();
  const srv = new FakeServer([["A", 1], ["B", 1]]);
  await drain(srv);
  assert.equal(srv.count("move_v2"), 1);
  const o = [...srv.orders.values()][0];
  assert.deepEqual([o.table_id, srv.tables.get("A")!.status, srv.tables.get("B")!.status], ["B", "available", "occupied"]);
  assert.deepEqual([srv.payments.length, srv.glQueue, srv.inventoryDemand], [0, 0, 1], "a move moves no money and no stock");
  const work = await tablesWithUnreflectedWork(SCOPE, Date.now());
  const shown = overlayTableTotals(srv.mapRows(), await getOperationalTableTotals(SCOPE, srv.mapRows(), work.touched, Date.now()));
  assert.deepEqual(shown.map((t) => [t.id, t.orders]), [["A", 0], ["B", 1]]);
  await secondReconnectIsZero(srv, "move");

  // server-changed: the canonical bill on C was paid by another terminal and a NEW bill opened before replay
  const srv2 = new FakeServer([["C", 3], ["D", 1]]);
  const O1 = srv2.seedOrder("C", [{ menu_item_id: "mS", qty: 1 }]);
  await cacheBill("C", srv2.bill("C")!, "t1", "b1", MAP_AT);
  const cap2 = await captureMoveTableOffline({ scope: SCOPE, from: srv2.mapRows()[0], to: row("D"), mapLoadedAt: MAP_AT });
  assert.ok(cap2.ok);
  O1.status = "completed"; O1.payment_status = "paid";
  const O2 = srv2.seedOrder("C", [{ menu_item_id: "mC", qty: 1 }]);
  await drain(srv2);
  const op = (await getOperation(cap2.ok ? cap2.operationId : ""))!;
  assert.deepEqual([op.status, op.last_error_code], ["needs_attention", "move_source_changed"]);
  assert.equal(O2.table_id, "C", "the newer bill is never moved");
  await secondReconnectIsZero(srv2, "move conflict");
});

// ================================================================ (e) Merge

test("E2E (e) Merge UNPAID+UNPAID, PARTIAL+UNPAID (P stays, only R moves), PARTIAL+PARTIAL: replayed once, final settle = Σ R; second reconnect = 0", async () => {
  // UNPAID + UNPAID
  await offlineSession("A", [{ menu_item_id: "mP", qty: 1 }]);
  await offlineSession("B", [{ menu_item_id: "mF", qty: 1 }]);
  const m1 = await captureMergeTablesOffline({ scope: SCOPE, primary: row("A"), sources: [row("B")], mapLoadedAt: MAP_AT });
  assert.ok(m1.ok);
  // PARTIAL + UNPAID: C has Steak(300) paid by an offline leg + Fries(50); D has Salad(40)
  const c = await offlineSession("C", [{ menu_item_id: "mS", qty: 1 }, { menu_item_id: "mF", qty: 1 }]);
  const leg = await splitOperationalBillOffline({ scope: DSCOPE, orderId: null, orderLocal: c.local_session_id, allocations: [{ line_local: c.lines[0].line_id, quantity: 1 }], method: "card", currency: "LBP", tableName: "C", dependencyIds: sessionBarrier(c) });
  assert.ok(leg.ok);
  const dd = await offlineSession("D", [{ menu_item_id: "mL", qty: 1 }]);
  const m2 = await captureMergeTablesOffline({ scope: SCOPE, primary: row("D"), sources: [row("C")], mapLoadedAt: MAP_AT });
  assert.ok(m2.ok);
  assert.equal(m2.ok && m2.outstanding, 90, "R_D 40 + R_C 50");
  const pD = await getOperationalTableBill(SCOPE, row("D"), undefined, undefined, MAP_AT);
  const settle = await settleTableOffline({ sessionId: dd.local_session_id, method: "cash", covers: { orderIds: [], summary: false }, extraDependencyIds: pD.pendingMutationOpIds });
  // PARTIAL + PARTIAL (whole items): E Pizza paid + Cola; F Fries paid + Salad
  const e = await offlineSession("E", [{ menu_item_id: "mP", qty: 1 }, { menu_item_id: "mC", qty: 1 }]);
  const f = await offlineSession("F", [{ menu_item_id: "mF", qty: 1 }, { menu_item_id: "mL", qty: 1 }]);
  for (const [s, t] of [[e, "E"], [f, "F"]] as const) {
    const l = await splitOperationalBillOffline({ scope: DSCOPE, orderId: null, orderLocal: s.local_session_id, allocations: [{ line_local: s.lines[0].line_id, quantity: 1 }], method: "cash", currency: "LBP", tableName: t, dependencyIds: sessionBarrier(s) });
    assert.ok(l.ok);
  }
  const m3 = await captureMergeTablesOffline({ scope: SCOPE, primary: row("E"), sources: [row("F")], mapLoadedAt: MAP_AT });
  assert.ok(m3.ok, m3.ok ? "" : m3.reason);
  assert.equal(m3.ok && m3.outstanding, 50, "R_E 10 + R_F 40");

  await restart();
  const srv = new FakeServer([["A", 1], ["B", 1], ["C", 1], ["D", 1], ["E", 1], ["F", 1]]);
  const r = await drain(srv);
  assert.equal(r.needsAttention.length, 0, JSON.stringify(r.needsAttention));
  assert.equal(srv.count("merge_v4"), 3);
  const on = (t: string) => [...srv.orders.values()].find((o) => o.table_id === t && o.merged_into == null)!;
  const src = (t: string) => [...srv.orders.values()].find((o) => o.table_id === t && o.merged_into != null)!;
  assert.deepEqual([srv.total(on("A")), src("B").status], [150, "voided"]);
  // P stays on its source (completed for exactly P), only R moved; the final settle charged Σ R
  assert.deepEqual([src("C").status, srv.total(src("C"))], ["completed", 300]);
  assert.equal(srv.total(on("D")), 90);
  assert.deepEqual(srv.payments.filter((p) => p.order_id === src("C").id).map((p) => [p.amount, p.kind]), [[300, "split"]], "prior payment untouched");
  assert.deepEqual(srv.payments.filter((p) => p.order_id === on("D").id).map((p) => p.amount), [90], "final settle = Σ R");
  assert.equal(srv.payments.filter((p) => p.kind === "sale").length, 1, "a merge creates no payment");
  assert.equal(srv.total(on("E")), 100 + 10 + 40, "E: Pizza (paid) + Cola + F's unpaid Salad (F's paid Fries stays on F)");
  assert.deepEqual([src("F").status, srv.paidP(on("E"))], ["completed", 100]);
  assert.equal((await getOperation(settle.operationId))!.status, "synced");
  assert.equal(srv.inventoryDemand, 9, "merges never touch stock (Σ items sent: 1+1+2+1+2+2)");
  await secondReconnectIsZero(srv, "merge");
});

// ================================================================ (f) On Account

async function onAccountSession(table: string, amount: number, method: string) {
  const d = await offlineSession(table, [{ menu_item_id: "mP", qty: 2 }]);
  const tg = await settleTarget(row(table));
  assert.ok(tg.amount.ok);
  return tableOnAccountOffline({ sessionId: d.local_session_id, customerId: "SC-1", amount, method, covers: tg.covers, extraDependencyIds: tg.deps, expectedAmount: tg.amount.ok ? tg.amount.exactAmount : null });
}

test("E2E (f) On Account offline: unpaid / partial cash / partial card → receivable exactly R − now once, drawer only by cash-now; restart; second reconnect = 0", async () => {
  const unpaid = await onAccountSession("U", 0, "cash");
  const cash = await onAccountSession("V", 50, "cash");
  const card = await onAccountSession("W", 80, "card");
  assert.equal(await getDineDraftForTable(SCOPE, "U"), null, "locally settled (receivable), the table is free");
  await restart();
  const srv = new FakeServer([["U", 1], ["V", 1], ["W", 1]]);
  srv.customers.set("SC-1", { name: "Acc", phone: null });
  const r = await drain(srv);
  assert.equal(r.needsAttention.length, 0, JSON.stringify(r.needsAttention));
  const byTable = (t: string) => [...srv.orders.values()].find((o) => o.table_id === t)!;
  assert.deepEqual(srv.receivables.map((x) => [x.order_id, x.amount]), [[byTable("U").id, 200], [byTable("V").id, 150], [byTable("W").id, 120]]);
  assert.deepEqual(srv.payments.map((p) => [p.amount, p.method]), [[50, "cash"], [80, "card"]]);
  assert.equal(srv.drawer(), 50, "on-account itself never increases the drawer; only cash taken now does");
  assert.deepEqual([byTable("U").payment_status, byTable("V").payment_status, byTable("U").settlement_mode], ["unpaid", "partial", "on_account"]);
  assert.equal(srv.glQueue, 5, "3 receivables + 2 payments");
  for (const op of [unpaid, cash, card]) assert.equal((await getOperation(op.operationId))!.status, "synced");
  const hist = await loadOrdersHistoryOfflineAware({ kind: "shift", tenantId: "t1", branchId: "b1", shiftId: "SRV-SHIFT-1" }, { reachable: async () => true, loadShift: async () => srv.history("SRV-SHIFT-1") });
  assert.deepEqual(hist.orders.map((x) => x.payment_status), ["on_account", "on_account", "on_account"]);
  await secondReconnectIsZero(srv, "on-account");
});

/** A canonical bill on the server with prior PAID split legs (another terminal), cached on this device. */
async function partPaidCanonical(srv: FakeServer, table: string, splits: [number, string][]) {
  srv.tables.set(table, { version: 1, status: "available" });
  const o = srv.seedOrder(table, [{ menu_item_id: "mP", qty: 1 }, { menu_item_id: "mF", qty: 1 }, { menu_item_id: "mC", qty: 3 }]); // T = 180
  for (const [idx, method] of splits) srv.seedSplit(o, idx, method);
  await cacheBill(table, srv.bill(table)!, "t1", "b1", MAP_AT);
  return { o, mapRow: srv.mapRows().find((t) => t.id === table)! };
}

test("E2E (f) On Account of a PART-PAID bill (multiple splits, partial+partial, zero remaining) with the server modelling R = T − P; refused while the flag is off", async () => {
  const srv = new FakeServer();
  srv.customers.set("SC-1", { name: "Acc", phone: null });
  const multi = await partPaidCanonical(srv, "M", [[0, "card"], [1, "cash"]]); // P = 150 → R = 30
  // flag OFF (production today): refused at capture, nothing recorded
  assert.deepEqual((await settleTarget(multi.mapRow)).amount, { ok: false, reason: PART_PAID_OFFLINE_SETTLE_MESSAGE });
  setServerDeductsPriorPayments(true);
  const tgM = await settleTarget(multi.mapRow);
  assert.deepEqual(tgM.amount, { ok: true, exactAmount: 30 }, "the dialog / pin is R, not T");
  const capM = await tableOnAccountOffline({ sessionId: null, table: tgM.table, customerId: "SC-1", amount: 0, method: "cash", covers: tgM.covers, expectedAmount: 30 });
  const pp = await partPaidCanonical(srv, "N", [[0, "cash"]]); // P = 100 → R = 80; 20 cash now
  const tgN = await settleTarget(pp.mapRow);
  const capN = await tableOnAccountOffline({ sessionId: null, table: tgN.table, customerId: "SC-1", amount: 20, method: "cash", covers: tgN.covers, expectedAmount: tgN.amount.ok ? tgN.amount.exactAmount : null });
  const zero = await partPaidCanonical(srv, "Z", [[0, "cash"], [1, "cash"], [2, "card"]]); // P = T → R = 0
  const tgZ = await settleTarget(zero.mapRow);
  assert.deepEqual(tgZ.amount, { ok: true, exactAmount: 0 });
  const capZ = await tableOnAccountOffline({ sessionId: null, table: tgZ.table, customerId: "SC-1", amount: 0, method: "cash", covers: tgZ.covers, expectedAmount: 0 });
  const priorPayments = stable(srv.payments);
  const drawer0 = srv.drawer();
  const gl0 = srv.glQueue;

  await restart();
  await drain(srv);
  assert.equal((await getOperation(capM.operationId))!.status, "synced");
  assert.equal((await getOperation(capN.operationId))!.status, "synced");
  assert.deepEqual(srv.receivables.map((x) => [x.order_id, x.amount]), [[multi.o.id, 30], [pp.o.id, 60]], "receivable exactly R (− paid now), once");
  assert.equal(stable(srv.payments.slice(0, 6)), priorPayments, "prior payments unchanged");
  assert.deepEqual(srv.payments.slice(6).map((p) => [p.order_id, p.amount, p.kind]), [[pp.o.id, 20, "on_account_now"]]);
  assert.equal(srv.drawer() - drawer0, 20, "only the cash taken now reaches the drawer");
  assert.equal(srv.glQueue - gl0, 3);
  // zero remaining → ALREADY_PAID → reflected (no receivable, no payment, never a fake settle by this device)
  const z = (await getOperation(capZ.operationId))!;
  assert.deepEqual([z.status, z.last_error_code], ["needs_attention", "already_paid"]);
  assert.equal(settlePrecedence(z, Date.now()), "reflected");
  assert.equal(srv.receivables.some((x) => x.order_id === zero.o.id), false);
  await secondReconnectIsZero(srv, "part-paid on-account");
});

test("E2E (f) On Account bill CHANGED before replay: amount drift → ON_ACCOUNT_AMOUNT_CHANGED, newer bill → ON_ACCOUNT_BILL_CHANGED, closed elsewhere → ALREADY_SETTLED — refused / reflected, never a fake settle", async () => {
  setServerDeductsPriorPayments(true);
  const srv = new FakeServer();
  srv.customers.set("SC-1", { name: "Acc", phone: null });
  const a = await partPaidCanonical(srv, "P", [[0, "card"]]); // R = 80
  const b = await partPaidCanonical(srv, "Q", [[0, "card"]]);
  const c = await partPaidCanonical(srv, "S", [[0, "card"]]);
  const caps: Record<string, string> = {};
  for (const [t, m] of [["P", a.mapRow], ["Q", b.mapRow], ["S", c.mapRow]] as const) {
    const tg = await settleTarget(m);
    caps[t] = (await tableOnAccountOffline({ sessionId: null, table: tg.table, customerId: "SC-1", amount: 0, method: "cash", covers: tg.covers, expectedAmount: tg.amount.ok ? tg.amount.exactAmount : null })).operationId;
  }
  // meanwhile, on other terminals:
  srv.addItems(a.o, [{ menu_item_id: "mC", quantity: 2 }]); // P: R 80 → 100
  b.o.status = "completed"; b.o.payment_status = "paid"; // Q: paid elsewhere…
  const newer = srv.seedOrder("Q", [{ menu_item_id: "mF", qty: 1 }]); // …and a newer bill opened
  c.o.status = "completed"; c.o.payment_status = "paid"; // S: paid elsewhere, table free
  const payments0 = stable(srv.payments);
  await drain(srv);
  const opP = (await getOperation(caps.P))!;
  const opQ = (await getOperation(caps.Q))!;
  const opS = (await getOperation(caps.S))!;
  assert.deepEqual([opP.last_error_code, opQ.last_error_code, opS.last_error_code], ["on_account_amount_changed", "on_account_bill_changed", "already_settled"]);
  for (const o of [opP, opQ]) {
    assert.equal(settleRefusedByServer(o), true, "refused: the bill is shown unpaid with the reason");
    assert.equal(settlePrecedence(o, Date.now()), "refused");
  }
  assert.equal(settlePrecedence(opS, Date.now()), "reflected", "closed elsewhere: the canonical row stands");
  assert.equal(srv.receivables.length, 0, "no receivable booked");
  assert.equal(stable(srv.payments), payments0, "prior payments unchanged");
  assert.equal(newer.status, "open", "the newer bill is never put on account");
  const work = await tablesWithUnreflectedWork(SCOPE, Date.now());
  assert.ok(work.refusedSettle.has("P") && work.refusedSettle.has("Q"));
  assert.equal(work.refusedSettle.has("S"), false);
  const pP = await getOperationalTableBill(SCOPE, srv.mapRows().find((t) => t.id === "P")!, undefined, undefined, MAP_AT);
  assert.deepEqual([pP.settlementConflict, pP.settledLocally, pP.bill.orders.length], [true, false, 1], "bill P stays active + refused, never fake settled");
  await secondReconnectIsZero(srv, "on-account changed");
});

test("E2E (f) order On Account (Delivery/Takeaway) sends the order pin; ALREADY_SETTLED → reflected", async () => {
  const srv = new FakeServer();
  srv.customers.set("SC-1", { name: "Acc", phone: null });
  const o = srv.newOrder({ order_type: "delivery", shift_id: "SRV-SHIFT-1", customer_id: "SC-1" });
  srv.addItems(o, [{ menu_item_id: "mS", quantity: 1 }]);
  const cap = await orderOnAccountOffline({ scope: SCOPE, orderId: o.id, orderLocal: null, migOpId: null, customerId: "SC-1", amount: 0, method: "cash", expectedAmount: 300 });
  await drain(srv);
  const call = srv.calls.find((x) => x.name === "on_account_order")!.payload as { expectedOrderIds: string[]; expectedAmount: number };
  assert.deepEqual([call.expectedOrderIds, call.expectedAmount], [[o.id], 300]);
  assert.deepEqual(srv.receivables.map((x) => x.amount), [300]);
  assert.equal((await getOperation(cap.operationId))!.status, "synced");
  const o2 = srv.newOrder({ order_type: "delivery", shift_id: "SRV-SHIFT-1" });
  srv.addItems(o2, [{ menu_item_id: "mF", quantity: 1 }]);
  const cap2 = await orderOnAccountOffline({ scope: SCOPE, orderId: o2.id, orderLocal: null, migOpId: null, customerId: "SC-1", amount: 0, method: "cash" });
  o2.status = "completed"; o2.payment_status = "paid";
  await drain(srv);
  const op2 = (await getOperation(cap2.operationId))!;
  assert.deepEqual([op2.last_error_code, settlePrecedence(op2, Date.now())], ["already_settled", "reflected"]);
  assert.equal(srv.receivables.length, 1);
  await secondReconnectIsZero(srv, "order on-account");
});

// ================================================================ (g) Needs-Attention convergence

test("E2E (g) convergence: current ops never stay needs_attention for a recovered / satisfied / remapped prerequisite; historical shift-less ops stay conflicts", async () => {
  // shift opened OFFLINE; work captured under its LOCAL id
  const ps = await createLocalPendingShift({ tenantId: "t1", branchId: "b1", cashierUserId: "u1", openingCashAmount: 0, currency: "LBP" });
  const SH = { ...DSCOPE, shiftId: ps.local_shift_id };
  const d = await offlineSession("G", [{ menu_item_id: "mP", qty: 1 }], SH);
  const s = await settleTableOffline({ sessionId: d.local_session_id, method: "cash", covers: { orderIds: [], summary: false } });
  // a move after the settle's table is reused: an unrelated table moved offline
  await offlineSession("H", [{ menu_item_id: "mF", qty: 1 }], SH);
  const mv = await captureMoveTableOffline({ scope: SCOPE, from: row("H"), to: row("K"), mapLoadedAt: MAP_AT });
  assert.ok(mv.ok);
  const afterMove = await getOperationalTableBill(SCOPE, row("K"), undefined, undefined, MAP_AT);
  const dk = await getDineDraftForTable(SCOPE, "K");
  const sK = await settleTableOffline({ sessionId: dk!.local_session_id, method: "cash", covers: { orderIds: [], summary: false }, extraDependencyIds: afterMove.pendingMutationOpIds });
  assert.ok((await getOperation(sK.operationId))!.dependency_ids.includes(mv.ok ? mv.operationId : ""), "settle after a move waits on the move");
  // historical: a pre-rc.12 round with NO shift (and no session) — must stay a conflict, never re-attributed
  await localdb.operations.add({ operation_id: "hist-round", operation_type: "dinein_send_round", schema_version: 1, scope: { tenant_id: "t1", branch_id: "b1", device_id: DEV.device_id, terminal_id: DEV.terminal_id ?? "", cashier_user_id: "u1" }, created_at: new Date(MAP_AT).toISOString(), client_op_id: crypto.randomUUID(), local_entity_id: null, canonical_entity_id: null, dependency_ids: [], depends_on_local_entities: [], payload: { submit: { table_id: "L", items: [{ menu_item_id: "mC", name: "Cola", base_price: 10, quantity: 1, modifiers: [] }], client_op_id: crypto.randomUUID() }, table_local: null, session_local: null }, status: "pending", retry_count: 0, last_attempt_at: null, last_error_code: null, last_error_message: null, result_meta: null, synced_at: null } as OfflineOperation);

  const srv = new FakeServer([["G", 1], ["H", 1], ["K", 1], ["L", 1]]);
  // 1st reconnect: the shift opens, then the backend drops (transport) on the first round → retryable, not parked
  srv.failNext.set("round", new TypeError("Failed to fetch"));
  await drain(srv);
  assert.ok((await allOps()).every((o) => o.operation_id === "hist-round" || o.status !== "needs_attention"), "connectivity never parks current work");
  assert.equal((await getOperation("hist-round"))!.last_error_code, "shift_missing");
  // 2nd reconnect: the round now hits a 5xx past its budget → parked retry_exhausted, its dependents dependency_failed
  for (let i = 0; i < 13; i++) {
    srv.failNext.set("round", Object.assign(new Error("Service Unavailable"), { status: 503 }));
    await pastBackoff();
    await drain(srv);
    if ((await attention()).some((o) => o.last_error_code === "retry_exhausted")) break;
  }
  const parked = (await attention()).filter((o) => o.operation_id !== "hist-round");
  assert.ok(parked.some((o) => o.last_error_code === "retry_exhausted"));
  assert.ok(parked.some((o) => o.last_error_code === "dependency_failed" && o.operation_id === s.operationId), "the settle parked behind the round");
  // the operator retries the round: the whole chain converges (dependency satisfied → reopened → synced)
  const root = parked.find((o) => o.last_error_code === "retry_exhausted")!;
  assert.equal(await requeueOperation(root.operation_id), true);
  await drain(srv);
  const left = await attention();
  assert.deepEqual(left.map((o) => o.operation_id), ["hist-round"], "only the historical shift-less op remains a conflict");
  assert.equal(srv.calls.filter((c) => c.name === "round" && (c.payload as { table_id: string }).table_id === "L").length, 0, "never sent, never re-attributed to the current shift");
  // stale shift mapping: every order is on the CANONICAL shift the offline-opened one became
  const shiftId = [...srv.shifts.keys()].find((k) => k !== "SRV-SHIFT-1")!;
  assert.ok([...srv.orders.values()].every((o) => o.shift_id === shiftId));
  // a capture made AFTER the shift synced, still holding the stale LOCAL shift id, converges too
  const late = await offlineSession("G", [{ menu_item_id: "mC", qty: 1 }], SH);
  void late;
  // settled-bill alias: a settle captured after round 1 mapped (covers.session_local → canonical via the map)
  const pG = await getOperationalTableBill(SCOPE, row("G"), undefined, undefined, MAP_AT);
  const dG = await getDineDraftForTable(SCOPE, "G");
  await settleTableOffline({ sessionId: dG!.local_session_id, method: "cash", covers: { orderIds: [], summary: false }, extraDependencyIds: pG.pendingMutationOpIds });
  // completed-payment dependency that was GC'd: a dependent of a synced, deleted op is not "missing"
  const synced = (await allOps()).find((o) => o.operation_id === s.operationId)!;
  await localdb.operations.delete(synced.operation_id);
  srv.tables.set("M", { version: 1, status: "available" });
  const gone = await openTableOffline({ scope: SH, tableId: "M", tableName: "M", seats: 2, currency: "LBP" });
  await localdb.operations.update(gone.open_operation_id, { dependency_ids: [synced.operation_id] });
  await drain(srv);
  assert.deepEqual((await attention()).map((o) => o.operation_id), ["hist-round"]);
  assert.equal((await getOperation(gone.open_operation_id))!.status, "synced", "a GC'd, history-proven synced prerequisite is satisfied, never missing_dependency");
  assert.equal(srv.payments.length, 3, "G, K and the second G bill — each paid once");
  assert.equal(new Set(srv.payments.map((p) => p.order_id)).size, 3);
  assertNoLocalIdsSent(srv);
  await secondReconnectIsZero(srv, "convergence");
});

// ================================================================ (h) Durability

test("E2E (h) durability: pending ops survive restart, connectivity loss, 5xx outage (incl. a lost committed response), auth-refresh failure, navigation and a shift transition", async () => {
  // shift 1 (canonical) work + its close, then a NEW shift opened offline with more work
  const d1 = await offlineSession("A", [{ menu_item_id: "mP", qty: 1 }]);
  const s1 = await settleTableOffline({ sessionId: d1.local_session_id, method: "cash", covers: { orderIds: [], summary: false } });
  const end = await captureEndShiftOffline({ scope: SCOPE, shiftId: "SRV-SHIFT-1", shiftLocal: null, actualCashCounted: 100, notes: null, shiftOpenedAt: new Date(MAP_AT).toISOString() });
  assert.ok((await getOperation(end.operationId))!.dependency_ids.includes(s1.operationId), "the close waits for the shift's payment");
  await tick();
  const ps = await createLocalPendingShift({ tenantId: "t1", branchId: "b1", cashierUserId: "u1", openingCashAmount: 0, currency: "LBP" });
  const d2 = await offlineSession("B", [{ menu_item_id: "mF", qty: 2 }], { ...DSCOPE, shiftId: ps.local_shift_id });
  const s2 = await settleTableOffline({ sessionId: d2.local_session_id, method: "cash", covers: { orderIds: [], summary: false } });
  const opsAtCapture = (await allOps()).length;

  // navigation: re-deriving every projection many times never mutates the log
  const before = stable(await allOps());
  for (let i = 0; i < 3; i++) {
    await getOperationalTableTotals(SCOPE, [row("A"), row("B")], undefined, MAP_AT);
    await tablesWithUnreflectedWork(SCOPE, MAP_AT);
    await loadOrdersHistoryOfflineAware({ kind: "shift", tenantId: "t1", branchId: "b1", shiftId: "SRV-SHIFT-1" }, { reachable: async () => false });
  }
  assert.equal(stable(await allOps()), before);
  await restart();
  assert.equal((await allOps()).filter((o) => o.status === "pending").length, opsAtCapture, "every op survived the restart, still pending");

  const srv = new FakeServer([["A", 1], ["B", 1]]);
  let refreshes = 0;
  const flaky: Partial<PosTxnSyncDeps> = { refreshSession: async () => { refreshes += 1; return false; } };
  // connectivity loss mid-drain
  srv.failNext.set("round", new TypeError("Failed to fetch"));
  await drain(srv, flaky);
  // a backend outage (5xx) on the first pay
  srv.failNext.set("pay_table", Object.assign(new Error("Service Unavailable"), { status: 503 }));
  await pastBackoff();
  await drain(srv, flaky);
  // the auth refresh fails while the local session is still valid (expired JWT on the next attempt)
  srv.failNext.set("pay_table", Object.assign(new Error("JWT expired"), { code: "PGRST301", status: 401 }));
  await pastBackoff();
  await drain(srv, flaky);
  assert.ok(refreshes >= 1, "a refresh was attempted");
  assert.equal((await attention()).length, 0, "transport / 5xx / auth never park the work");
  // a committed pay whose response is lost → retried idempotently, applied once
  srv.loseNext.add("pay_table");
  for (let i = 0; i < 6 && (await allOps()).some((o) => o.status !== "synced"); i++) {
    await restart();
    await pastBackoff();
    await drain(srv, flaky);
  }
  const ops = await allOps();
  assert.ok(ops.every((o) => o.status === "synced"), JSON.stringify(ops.filter((o) => o.status !== "synced").map((o) => [o.operation_type, o.status, o.last_error_code])));
  // shift transition: the old shift's sale settled BEFORE its close; the new shift's sale on the NEW shift
  const names = srv.names();
  assert.ok(names.lastIndexOf("pay_table") > names.indexOf("end_shift") || names.indexOf("end_shift") > names.indexOf("pay_table"));
  const oA = [...srv.orders.values()].find((o) => o.table_id === "A")!;
  const oB = [...srv.orders.values()].find((o) => o.table_id === "B")!;
  const firstPayA = srv.calls.findIndex((c) => c.name === "pay_table" && (c.payload as { tableId: string }).tableId === "A");
  assert.ok(firstPayA >= 0 && firstPayA < names.indexOf("end_shift"), "the close replayed after the shift's payment");
  assert.equal(srv.shifts.get("SRV-SHIFT-1")!.status, "closed");
  assert.notEqual(oB.shift_id, "SRV-SHIFT-1");
  assert.equal(srv.shifts.get(oB.shift_id)!.status, "open");
  assert.deepEqual(srv.payments.map((p) => [p.order_id, p.amount]).sort(), [[oA.id, 100], [oB.id, 100]].sort(), "each paid exactly once despite every fault");
  assert.deepEqual([srv.glQueue, srv.inventoryDemand], [2, 3]);
  assert.equal((await getOperation(s2.operationId))!.status, "synced");
  await secondReconnectIsZero(srv, "durability");
});
