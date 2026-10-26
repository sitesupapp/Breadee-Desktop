// Desktop 1.0.38 G3 — the NORTH-STAR offline lifecycle + the offline AMOUNT PIN (financial gap fix).
//
// Real Dexie (fake-indexeddb), the REAL shift store (useShift), capture engines, operational projection,
// single orchestrator and handlers. Only the server RPCs are injected — by a FAKE SERVER that models the
// prod_1038 contracts: idempotency by client_op_id (fingerprinted where the contract has one: move_v2 /
// merge_v4), pos_save_order table lookup + expected_order guard, split parent_completed, move_v2 / merge_v4
// pins + versions, pay_table R = T − P with expected_order_ids / expected_amount (S5, 0.005 tolerance, the
// discount rounded like pos_pay_table_core: round(sub × pct / 100, 2)), on-account R (S2b), open-shift
// require_new + reused (S6), end-shift (refuses a shift with open orders), GL (POS_SALE once per order that
// reaches completed, POS_PAYMENT per payment row), inventory demand frozen per item on completion, the drawer
// = opening float + CASH payments of THAT shift.
//
// The device is offline from BEFORE the shift opens. Nothing here talks to a real backend.

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

import { localdb, type PosOfflineTxn } from "@/lib/offline/db";
import { getOperation, type OfflineOperation } from "@/lib/offline/operationLog";
import { drainOffline, __resetDrainLockForTests, __setReplayTimeoutForTests } from "@/lib/offline/orchestrator";
import type { PosTxnSyncDeps } from "@/lib/offline/posTxnSync";
import {
  openTableOffline,
  addDraftLine,
  sendRoundOffline,
  settleTableOffline,
  tableOnAccountOffline,
  splitOperationalBillOffline,
  getDineDraftForTable,
} from "@/lib/offline/dineinOffline";
import {
  getOperationalTableBill,
  getOperationalTableTotals,
  overlayTableTotals,
  offlineSettleAmount,
  offlineSettlePin,
  roundNumeric,
  splitCompletesBill,
  settleRefusedByServer,
  PART_PAID_OFFLINE_SETTLE_MESSAGE,
  PART_PAID_DISCOUNT_MESSAGE,
} from "@/lib/offline/operationalProjection";
import { captureMoveTableOffline, captureMergeTablesOffline } from "@/lib/offline/tableOpOffline";
import { captureCustomerUpsertOffline } from "@/lib/offline/customerOffline";
import { captureDeliveryProviderOffline } from "@/lib/offline/deliveryActionOffline";
import { capturePayOrderOffline, payOrderClientOpId } from "@/lib/offline/payOrderOffline";
import { orderRefFor } from "@/lib/offline/orderRef";
import { useShift, shiftNet } from "@/state/shift";
import { clearPosSessionSnapshot } from "@/lib/offline/posSession";
import { cacheEndShiftApprovalRequired } from "@/lib/offline/pendingShift";
import { orderStatusKey, isMergedSource, type ShiftOpenOrder } from "@/lib/pos/shiftOrderSummary";
import { canSettleOrder } from "@/lib/pos/orderActions";
import { reversalTotals } from "@/lib/pos/shiftReport";
import { serverDeductsPriorPayments } from "@/lib/pos/tablePayment";
import { getDeviceIdentity } from "@/lib/device";
import type { TableSummary } from "@/types/tables";

const DEV = getDeviceIdentity();
const SCOPE = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: DEV.device_id, terminalId: DEV.terminal_id ?? null };
const CTX = { ...SCOPE, online: true };
const MAP_AT = Date.now() - 10 * 60_000; // the floor cached before the device went offline (all tables free)
const tick = () => new Promise((r) => setTimeout(r, 4));
const offlineNet = async () => { throw new TypeError("Failed to fetch"); };

beforeEach(async () => {
  await Promise.all([
    localdb.operations.clear(), localdb.entityMap.clear(), localdb.syncHistory.clear(), localdb.dineDrafts.clear(),
    localdb.snapshots.clear(), localdb.posOfflineTxns.clear(), localdb.pendingShifts.clear(), localdb.posCustomers.clear(),
  ]);
  __resetDrainLockForTests();
  clearPosSessionSnapshot();
  useShift.getState().clear();
  // INTERNET DISABLED from before the shift opens: every online shift read / open is a transport failure.
  shiftNet.findOpenShift = offlineNet;
  shiftNet.getCashBox = async () => null as never;
  shiftNet.reachable = async () => false;
  shiftNet.openShift = async () => { throw new Error("online openShift must not be called"); };
  shiftNet.endShiftApprovalRequired = null;
});
afterEach(() => __setReplayTimeoutForTests(45_000));

// ================================================================ the fake server (contract model)

const MENU: Record<string, { name: string; price: number }> = {
  mP: { name: "Pizza", price: 100 }, mC: { name: "Cola", price: 10 }, mS: { name: "Shawarma", price: 300 }, mF: { name: "Fries", price: 50 }, mL: { name: "Salad", price: 40 },
};
type SItem = { id: string; client_line_id: string | null; menu_item_id: string; name: string; price: number; qty: number; paid_qty: number; batch: number; void: boolean };
type SOrder = {
  id: string; number: string; table_id: string | null; order_type: string; status: "open" | "completed" | "voided";
  payment_status: "unpaid" | "partial" | "paid"; settlement_mode: "on_account" | null; shift_id: string;
  items: SItem[]; settlements: number; version: number; customer_id: string | null; address_id: string | null; provider_id: string | null;
  fee: number; discount: number; merged_into?: string; merge_id?: string; seq: number;
};
type SPayment = { id: string; order_id: string; shift_id: string; amount: number; method: string; kind: "sale" | "split" | "on_account_now"; op: string };
const posErr = (code: string, msg = code) => Object.assign(new Error(msg), { code: "P0001", details: JSON.stringify({ pos_error_code: code }) });
const sorted = (a: string[]) => [...a].sort();
const stable = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) && !(x instanceof Map) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x instanceof Map ? [...x] : x));
/** numeric money: integer cents (every price here is ≤ 2 dp) */
const c = (x: number) => Math.round(x * 100);

class FakeServer {
  shifts = new Map<string, { status: "open" | "closed"; cashier: string; float: number; counted: number | null; expected: number | null }>();
  tables = new Map<string, { version: number; status: "available" | "occupied" }>();
  orders = new Map<string, SOrder>();
  payments: SPayment[] = [];
  customers = new Map<string, { name: string | null; phone: string | null }>();
  addresses = new Map<string, { customer_id: string; street: string | null }>();
  providerAssignments: { order_id: string; provider_id: string }[] = [];
  merges: { id: string; primary: string; sources: string[] }[] = [];
  submissions = new Map<string, { type: string; fp: string; result: Record<string, unknown> }>();
  /** GL queue: accounting_enqueue(... on conflict (tenant, event_key) do nothing) — the RAW enqueue attempts are
   *  kept so a second completion of the same order would be visible as a duplicate attempt. */
  glAttempts: string[] = [];
  /** inventory demand frozen on finalize (per order, per menu item). */
  demandAttempts: { order_id: string; menu_item_id: string; qty: number }[] = [];
  calls: { name: string; payload: unknown }[] = [];
  seq = 0;
  num = 0;
  /** connectivity seam: a predicate that drops the connection BEFORE the matching call (and every later one). */
  cut: ((name: string, payload: Record<string, unknown>) => boolean) | null = null;
  down = false;
  loseNext = new Set<string>();
  /** the OTHER terminal: run right before the first matching call reaches the server. */
  before: { name: string; fn: (payload: Record<string, unknown>) => void } | null = null;

  constructor(tables: string[]) {
    for (const t of tables) this.tables.set(t, { version: 1, status: "available" });
  }
  id(p: string) { return `${p}-${++this.seq}`; }
  live(o: SOrder) { return o.items.filter((i) => !i.void); }
  totalC(o: SOrder) { return this.live(o).reduce((s, i) => s + c(i.price) * i.qty, 0) + c(o.fee) - c(o.discount); }
  paidC(o: SOrder) { return this.payments.filter((p) => p.order_id === o.id && p.kind === "split").reduce((s, p) => s + c(p.amount), 0); }
  total(o: SOrder) { return this.totalC(o) / 100; }
  openOn(t: string) { return [...this.orders.values()].filter((o) => o.table_id === t && o.status === "open").sort((a, b) => a.seq - b.seq); }
  bump(t: string) { const r = this.tables.get(t)!; r.version += 1; return r.version; }
  shiftOk(id: unknown) {
    const s = typeof id === "string" ? this.shifts.get(id) : undefined;
    if (!s) throw new Error("Shift not found for this tenant/branch");
    if (s.status !== "open") throw new Error("This shift is already closed.");
  }
  newOrder(o: Partial<SOrder> & { shift_id: string }): SOrder {
    this.shiftOk(o.shift_id);
    const order: SOrder = {
      id: this.id("SO"), number: `261026-${String(++this.num).padStart(4, "0")}`, table_id: null, order_type: "dine_in", status: "open", payment_status: "unpaid", settlement_mode: null,
      items: [], settlements: 0, version: 0, customer_id: null, address_id: null, provider_id: null, fee: 0, discount: 0, seq: this.seq, ...o,
    };
    this.orders.set(order.id, order);
    return order;
  }
  addItems(o: SOrder, items: { menu_item_id?: string; name?: string; base_price?: number; quantity: number; client_line_id?: string }[]) {
    const batch = o.items.reduce((m, i) => Math.max(m, i.batch), 0) + 1;
    for (const it of items) {
      const menu = MENU[String(it.menu_item_id)] ?? { name: String(it.name ?? "Item"), price: Number(it.base_price ?? 0) };
      // the captured selling price is honoured (snapshot, never repriced)
      o.items.push({ id: this.id("SI"), client_line_id: it.client_line_id ?? null, menu_item_id: String(it.menu_item_id ?? "m"), name: it.name ?? menu.name, price: it.base_price ?? menu.price, qty: it.quantity, paid_qty: 0, batch, void: false });
    }
  }
  pay(o: SOrder, amount: number, method: string, kind: SPayment["kind"], op: string) {
    const p: SPayment = { id: this.id("PAY"), order_id: o.id, shift_id: o.shift_id, amount, method, kind, op };
    this.payments.push(p);
    this.glAttempts.push(`POS_PAYMENT:${p.id}`);
  }
  /** the ONE transition to completed (trg_accounting_pos_sale + _pos_order_freeze_demand_on_finalize). */
  complete(o: SOrder, payment_status: SOrder["payment_status"]) {
    if (o.status === "completed") throw new Error(`BUG: order ${o.id} completed twice`);
    o.status = "completed";
    o.payment_status = payment_status;
    this.glAttempts.push(`POS_SALE:${o.id}`);
    for (const i of this.live(o)) this.demandAttempts.push({ order_id: o.id, menu_item_id: i.menu_item_id, qty: i.qty });
  }
  freeTable(t: string | null) {
    if (t && this.openOn(t).length === 0) this.tables.get(t)!.status = "available";
  }
  /** pos_pay_table_core: bill_sub, the discount round(…, 2), its allocation, R = T − P (cents). */
  billDue(open: SOrder[], discount?: { discount_type?: string; discount_value?: number }) {
    const pct = discount?.discount_type === "percent" ? Number(discount.discount_value) : 0;
    const amt = discount?.discount_type === "amount" ? Number(discount.discount_value) : 0;
    const apply = (pct > 0 || amt > 0);
    const sub = open.reduce((s, o) => s + this.live(o).reduce((x, i) => x + c(i.price) * i.qty, 0), 0);
    const P = open.reduce((s, o) => s + this.paidC(o), 0);
    if (apply && P > 0) throw posErr("SPLIT_DISCOUNT_UNSUPPORTED");
    // round(sub × pct / 100, 2), half away from zero, on exact decimals (pct as basis points)
    const disc = pct > 0 ? Math.floor((sub * Math.round(pct * 100) * 2 + 10000) / 20000) : apply ? c(amt) : 0;
    return { sub, disc, P, R: open.reduce((s, o) => s + this.totalC(o), 0) - (apply ? disc : 0) - P };
  }

  // --- canonical read models ---
  drawer(shiftId: string) {
    const s = this.shifts.get(shiftId)!;
    return (c(s.float) + this.payments.filter((p) => p.shift_id === shiftId && p.method === "cash").reduce((x, p) => x + c(p.amount), 0)) / 100;
  }
  receivable(customerId: string) {
    return [...this.orders.values()]
      .filter((o) => o.settlement_mode === "on_account" && o.customer_id === customerId)
      .reduce((s, o) => s + this.totalC(o) - this.payments.filter((p) => p.order_id === o.id).reduce((x, p) => x + c(p.amount), 0), 0) / 100;
  }
  history(shiftId: string): ShiftOpenOrder[] {
    return [...this.orders.values()].filter((o) => o.shift_id === shiftId).map((o) => ({
      id: o.id, order_number: o.number, order_type: o.order_type, status: o.status, payment_status: o.settlement_mode === "on_account" ? "on_account" : o.payment_status, payment_method: null,
      subtotal: this.total(o), discount_amount: o.discount, total_amount: this.total(o), currency: "LBP", table_id: o.table_id, customer_id: o.customer_id, customer_name: null, customer_phone: null,
      cashier_user_id: "u1", staff_name: null, notes: null, created_at: new Date().toISOString(),
      merged_into_order_id: o.merged_into ?? null, merged_into_merge_id: o.merge_id ?? null, merged_into_order_number: o.merged_into ? this.orders.get(o.merged_into)!.number : null,
    }) as ShiftOpenOrder);
  }
  /** Everything a second reconnect / a replay must leave untouched. */
  state() {
    return stable({ s: [...this.shifts], t: [...this.tables], o: [...this.orders.values()], p: this.payments, c: [...this.customers], a: [...this.addresses], pa: this.providerAssignments, m: this.merges, gl: this.glAttempts, d: this.demandAttempts });
  }
  count(name: string) { return this.calls.filter((x) => x.name === name).length; }

  deps(): PosTxnSyncDeps {
    const rec = (name: string, payload: unknown) => {
      const pl = (payload ?? {}) as Record<string, unknown>;
      if (!this.down && this.cut?.(name, pl)) this.down = true;
      if (this.down) throw new TypeError("Failed to fetch"); // the connection is gone: nothing reaches the server
      if (this.before && this.before.name === name) {
        const b = this.before;
        this.before = null;
        b.fn(pl);
      }
      this.calls.push({ name, payload: JSON.parse(JSON.stringify(payload ?? null)) });
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
    const fingerprinted = (op: string, fp: string) => {
      const s = this.submissions.get(op);
      if (!s) return null;
      if (s.fp !== fp) throw posErr("IDEMPOTENCY_PAYLOAD_MISMATCH");
      return { ...s.result, idempotent: true };
    };
    const d: Partial<PosTxnSyncDeps> = {
      isTransport: (e) => e instanceof TypeError,
      hasSession: async () => true,
      openShift: async (a) => {
        rec("openShift", a);
        const hit = this.submissions.get(a.clientOpId);
        if (hit) return { shiftId: String(hit.result.shiftId), reused: Boolean(hit.result.reused) };
        const open = [...this.shifts.entries()].find(([, s]) => s.status === "open" && s.cashier === "u1");
        let r: { shiftId: string; reused: boolean };
        if (open) {
          if (a.requireNew) throw Object.assign(new Error("Another shift is already open for this cashier on this branch."), { details: JSON.stringify({ pos_error_code: "SHIFT_ALREADY_OPEN" }) });
          r = { shiftId: open[0], reused: true };
        } else {
          const id = this.id("SH");
          this.shifts.set(id, { status: "open", cashier: "u1", float: a.openingCash, counted: null, expected: null });
          r = { shiftId: id, reused: false };
        }
        this.submissions.set(a.clientOpId, { type: "shift", fp: "", result: r });
        return lose("openShift", r);
      },
      endShiftOp: async (a) => {
        rec("endShiftOp", a);
        const hit = cached(a.clientOpId);
        if (hit) return { shift_id: a.shiftId, idempotent: true, approval_required: false };
        this.shiftOk(a.shiftId);
        const open = [...this.orders.values()].filter((o) => o.shift_id === a.shiftId && o.status === "open").length;
        if (open > 0) throw new Error(`Cannot close this shift: ${open} order(s) still open.`);
        const s = this.shifts.get(a.shiftId)!;
        s.status = "closed";
        s.counted = a.actualCashCounted;
        s.expected = this.drawer(a.shiftId);
        this.submissions.set(a.clientOpId, { type: "end", fp: "", result: {} });
        return lose("endShiftOp", { shift_id: a.shiftId, idempotent: false, approval_required: false });
      },
      openTable: async (p) => {
        rec("openTable", p);
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
        rec("submitRound", p);
        const op = String(p.client_op_id);
        const hit = cached(op);
        if (hit) return hit as never;
        // pos_save_order's table lookup + the expected-order guard
        const open = this.openOn(String(p.table_id));
        if (p.expected_order_id && (open.length !== 1 || open[0].id !== p.expected_order_id)) throw posErr("EXPECTED_ORDER_MISMATCH", "EXPECTED_ORDER_MISMATCH: bill changed");
        let o = open[0];
        if (!o) {
          o = this.newOrder({ table_id: String(p.table_id), shift_id: String(p.shift_id) });
          this.tables.get(String(p.table_id))!.status = "occupied";
        }
        this.addItems(o, p.items as never);
        const result = { order_id: o.id, order_number: o.number, batch_no: o.items.reduce((m, i) => Math.max(m, i.batch), 0), appended: open.length > 0 };
        this.submissions.set(op, { type: "round", fp: "", result });
        return { ...result, idempotent: false };
      },
      submit: async (p) => {
        rec("submit", p);
        const op = String(p.client_op_id);
        const hit = cached(op);
        if (hit) return hit as never;
        const pp = p as unknown as Record<string, unknown>;
        if (pp.customer_id != null && !this.customers.has(String(pp.customer_id))) throw new Error("Customer not found for this operating unit");
        if (pp.address_id != null && !this.addresses.has(String(pp.address_id))) throw new Error("Address not found for this customer");
        const o = this.newOrder({ order_type: String(pp.order_type ?? "takeaway"), shift_id: String(p.shift_id), customer_id: (pp.customer_id as string) ?? null, address_id: (pp.address_id as string) ?? null, fee: Number(pp.delivery_fee ?? 0) || 0 });
        this.addItems(o, p.items as never);
        const result = { order_id: o.id, order_number: o.number };
        this.submissions.set(op, { type: "submit", fp: "", result });
        return lose("submit", result);
      },
      pay: async (a) => {
        rec("pay", a);
        const o = this.orders.get(a.orderId);
        if (!o) throw new Error("Order not found");
        if (o.status !== "open") throw new Error("Order already paid"); // state-guarded (this RPC carries no op id)
        this.pay(o, this.total(o), "cash", "sale", "takeaway");
        this.complete(o, "paid");
        return { amount: this.total(o) };
      },
      payOrderOp: async (a) => {
        rec("payOrderOp", a);
        const hit = cached(a.clientOpId);
        if (hit) return hit as never;
        const o = this.orders.get(a.orderId);
        if (!o) throw new Error("Order not found");
        if (o.status !== "open") throw new Error("This order is already paid");
        const R = (this.totalC(o) - this.paidC(o)) / 100;
        this.pay(o, R, a.method, "sale", a.clientOpId);
        this.complete(o, "paid");
        o.version += 1;
        const result = { order_id: o.id, paid: true, amount: R };
        this.submissions.set(a.clientOpId, { type: "pay_order", fp: "", result });
        return lose("payOrderOp", { ...result, idempotent: false });
      },
      payTable: async (a) => {
        rec("payTable", a);
        const hit = cached(a.clientOpId);
        if (hit) return hit as never;
        const open = this.openOn(a.tableId);
        if (a.expectedOrderIds) {
          if (open.length === 0) {
            if (a.expectedOrderIds.every((id) => this.orders.get(id)?.payment_status === "paid")) throw posErr("ALREADY_SETTLED", "This bill was already paid.");
            throw posErr("PAY_BILL_CHANGED", "The bill on this table changed since the payment was captured.");
          }
          if (stable(sorted(open.map((o) => o.id))) !== stable(sorted(a.expectedOrderIds))) throw posErr("PAY_BILL_CHANGED", "The bill on this table changed since the payment was captured.");
        }
        if (open.length === 0) throw new Error("No open order on this table to pay");
        for (const o of open) this.shiftOk(o.shift_id); // _pos_lock_open_shift
        const due = this.billDue(open, a.discount);
        if (a.expectedAmount != null && Math.abs(due.R / 100 - a.expectedAmount) >= 0.005) {
          throw posErr("PAY_AMOUNT_CHANGED", "The amount due on this table changed since the payment was captured. Reconnect and review before settling.");
        }
        let rem = due.disc;
        open.forEach((o, i) => {
          const base = this.live(o).reduce((x, it) => x + c(it.price) * it.qty, 0);
          const od = i < open.length - 1 && due.sub > 0 ? Math.round((due.disc * base) / due.sub) : rem;
          rem -= od;
          if (due.disc > 0) o.discount = od / 100;
          this.pay(o, (this.totalC(o) - this.paidC(o)) / 100, a.method, "sale", a.clientOpId);
          this.complete(o, "paid");
        });
        this.tables.get(a.tableId)!.status = "available";
        const result = { ok: true, amount: due.R / 100, pos_entity_version: this.bump(a.tableId) };
        this.submissions.set(a.clientOpId, { type: "pay", fp: "", result });
        return lose("payTable", { ...result, idempotent: false });
      },
      orderItemMap: async ({ orderId }) => (this.orders.get(orderId)?.items ?? []).filter((i) => i.client_line_id).map((i) => ({ client_line_id: i.client_line_id as string, order_item_id: i.id })),
      splitSettle: async (a) => {
        rec("splitSettle", a);
        const hit = cached(a.clientOpId);
        if (hit) return hit as never;
        const o = this.orders.get(a.orderId)!;
        if (o.status !== "open") throw new Error("This order is no longer active");
        this.shiftOk(o.shift_id);
        let amount = 0;
        for (const al of a.allocations) {
          const it = o.items.find((i) => i.id === al.order_item_id && !i.void)!;
          if (it.qty - it.paid_qty < al.quantity) throw new Error(`Only ${it.qty - it.paid_qty} remaining`);
          it.paid_qty += al.quantity;
          amount += c(it.price) * al.quantity;
        }
        o.settlements += 1;
        o.version += 1;
        this.pay(o, amount / 100, a.method, "split", a.clientOpId);
        const remaining = this.live(o).reduce((s, i) => s + (i.qty - i.paid_qty), 0);
        if (remaining === 0) {
          this.complete(o, "paid");
          this.freeTable(o.table_id);
          if (o.table_id) this.bump(o.table_id);
        } else o.payment_status = "partial";
        const result = { ok: true, split_no: o.settlements, parent_completed: remaining === 0, remaining_qty: remaining };
        this.submissions.set(a.clientOpId, { type: "split", fp: "", result });
        return { ...result, idempotent: false };
      },
      onAccountTable: async (a) => {
        rec("onAccountTable", a);
        const hit = cached(a.clientOpId);
        if (hit) return hit as never;
        const open = this.openOn(a.tableId);
        if (!this.customers.has(a.customerId)) throw Object.assign(new Error("Customer not found for this operating unit"), { code: "42501" });
        if (a.expectedOrderIds) {
          if (open.length === 0) {
            if (a.expectedOrderIds.every((id) => this.orders.get(id)?.status === "completed")) throw posErr("ALREADY_SETTLED", "This bill was already settled.");
            throw posErr("ON_ACCOUNT_BILL_CHANGED");
          }
          if (stable(sorted(open.map((o) => o.id))) !== stable(sorted(a.expectedOrderIds))) throw posErr("ON_ACCOUNT_BILL_CHANGED");
        }
        if (open.length === 0) throw new Error("No open order to put on account");
        const due = this.billDue(open, a.discount);
        if (due.P > 0 && due.R <= 0) throw posErr("ALREADY_PAID");
        if (a.expectedAmount != null && Math.abs(due.R / 100 - a.expectedAmount) >= 0.005) throw posErr("ON_ACCOUNT_AMOUNT_CHANGED", "The amount due on this bill changed since On Account was captured. Reconnect and review before settling.");
        if (c(a.amount) > due.R) throw posErr("ON_ACCOUNT_AMOUNT_EXCEEDS_REMAINING");
        if (due.disc > 0) open[open.length - 1].discount = due.disc / 100;
        if (a.amount > 0) this.pay(open[0], a.amount, a.method, "on_account_now", a.clientOpId);
        for (const o of open) {
          o.settlement_mode = "on_account";
          o.customer_id = a.customerId;
          this.complete(o, a.amount > 0 || due.P > 0 ? "partial" : "unpaid");
        }
        this.tables.get(a.tableId)!.status = "available";
        this.bump(a.tableId);
        const result = { ok: true };
        this.submissions.set(a.clientOpId, { type: "on_account", fp: "", result });
        return { ...result, idempotent: false };
      },
      upsertCustomer: async (a) => {
        rec("upsertCustomer", a);
        const hit = cached(a.clientOpId);
        if (hit) return hit as never;
        const p = a.payload as { id?: string; name?: string; phone?: string; address?: { street?: string; id?: string } };
        const cid = p.id ?? this.id("SC");
        if (!p.id) this.customers.set(cid, { name: p.name ?? null, phone: p.phone ?? null });
        let aid: string | null = null;
        if (p.address && !p.address.id) {
          aid = this.id("SA");
          this.addresses.set(aid, { customer_id: cid, street: p.address.street ?? null });
        }
        const result = { customer_id: cid, address_id: aid, is_new: !p.id };
        this.submissions.set(a.clientOpId, { type: "customer", fp: "", result });
        return result;
      },
      setDeliveryProviderOp: async ({ payload: p }) => {
        rec("setDeliveryProviderOp", { payload: p });
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
        rec("moveTableV2", { payload: p });
        const fp = stable({ ...p, client_op_id: undefined });
        const hit = fingerprinted(p.client_op_id, fp);
        if (hit) return hit as never;
        const from = this.tables.get(p.from_table_id)!;
        const to = this.tables.get(p.to_table_id)!;
        if (p.expected_from_version != null && from.version !== p.expected_from_version) throw posErr("VERSION_CONFLICT");
        if (p.expected_to_version != null && to.version !== p.expected_to_version) throw posErr("VERSION_CONFLICT");
        const src = this.openOn(p.from_table_id);
        if (src.length === 0) throw posErr("MOVE_SOURCE_EMPTY");
        if (stable(sorted(src.map((o) => o.id))) !== stable(sorted(p.expected_order_ids))) throw posErr("MOVE_SOURCE_CHANGED");
        if (p.expected_paid_settlements) for (const o of src) if (o.settlements !== (p.expected_paid_settlements[o.id] ?? 0)) throw posErr("MOVE_PAYMENT_STATE_CHANGED");
        if (this.openOn(p.to_table_id).length > 0) throw posErr("MOVE_DEST_OCCUPIED");
        for (const o of src) o.table_id = p.to_table_id;
        from.status = "available";
        to.status = "occupied";
        const result = { ok: true, orders_moved: src.length, order_ids: src.map((o) => o.id), from_table_id: p.from_table_id, to_table_id: p.to_table_id, table_versions: { [p.from_table_id]: this.bump(p.from_table_id), [p.to_table_id]: this.bump(p.to_table_id) } };
        this.submissions.set(p.client_op_id, { type: "move", fp, result });
        return { ...result, idempotent: false };
      },
      mergeTablesV4: async ({ payload: p }) => {
        rec("mergeTablesV4", { payload: p });
        const fp = stable({ ...p, client_op_id: undefined });
        const hit = fingerprinted(p.client_op_id, fp);
        if (hit) return hit as never;
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
        const mergeId = this.id("MG");
        for (const sId of p.source_table_ids) {
          const o = bills.get(sId)!;
          if (o.shift_id !== prim.shift_id) throw posErr("MERGE_CROSS_SHIFT");
          if (o.items.some((i) => i.paid_qty > 0 && i.paid_qty < i.qty)) throw posErr("UNSUPPORTED_STATE", "UNSUPPORTED_STATE(partial_line)");
          const batch = prim.items.reduce((m, i) => Math.max(m, i.batch), 0) + 1;
          const moving = o.items.filter((i) => i.paid_qty === 0 && !i.void);
          o.items = o.items.filter((i) => i.paid_qty > 0); // only R moves; P stays on its source
          for (const i of moving) prim.items.push({ ...i, batch });
          o.merged_into = prim.id;
          o.merge_id = mergeId;
          if (o.settlements > 0) this.complete(o, "paid"); // completed for exactly P
          else o.status = "voided"; // merge provenance — never a real void
          this.tables.get(sId)!.status = "available";
        }
        this.merges.push({ id: mergeId, primary: prim.id, sources: p.source_table_ids.map((t) => bills.get(t)!.id) });
        prim.version += 1;
        const result = { ok: true, merge_id: mergeId, primary_order_id: prim.id, primary_order_number: prim.number, sources_merged: p.source_table_ids.length, pos_entity_version: prim.version, table_versions: Object.fromEntries(all.map((t) => [t, this.bump(t)])) };
        this.submissions.set(p.client_op_id, { type: "merge", fp, result });
        return { ...result, idempotent: false };
      },
    };
    return d as PosTxnSyncDeps;
  }
}

// ================================================================ local fixtures + the workspace emulation

const row = (id: string): TableSummary =>
  ({ id, name: id, seats: 4, occupied: false, status: "available", canonical: true, configured: true, sort_order: 1, orders: 0, order_number: null, opened_at: null, total: null, collected: null, outstanding: null, currency: "LBP", mixed_currency: false, pos_entity_version: 1 }) as TableSummary;

const TABLES = ["T1", "T2", "T3", "T4", "M1", "M2", "G1", "G2", "H1", "H2"];
const dscope = (shiftId: string) => ({ ...SCOPE, shiftId });

async function restart() {
  localdb.close();
  await localdb.open();
  __resetDrainLockForTests();
  // module state is gone too: the shift store re-hydrates from Dexie only (still offline)
  useShift.getState().clear();
  await useShift.getState().refresh("t1", "u1", "b1");
}

/** DineInWorkspace.sendRound (offline): the table's session (opened on first use) + one round. */
async function round(shiftId: string, table: string, lines: [string, number][]) {
  let d = await getDineDraftForTable(SCOPE, table);
  if (!d) d = await openTableOffline({ scope: dscope(shiftId), tableId: table, tableName: table, seats: 4, currency: "LBP" });
  for (const [m, q] of lines) await addDraftLine(d.local_session_id, { menu_item_id: m, name: MENU[m].name, base_price: MENU[m].price, quantity: q, modifiers: [], kitchen_note: null });
  const r = await sendRoundOffline(d.local_session_id);
  await tick();
  return r;
}

const bill = (t: string) => getOperationalTableBill(SCOPE, row(t), undefined, undefined, MAP_AT);

/** DineInWorkspace.offlineSettleTarget + confirmPay / confirmTableOnAccount (offline), step for step. */
async function settleUI(t: string, opt: { method?: string; discount?: { discount_type: string; discount_value: number }; onAccount?: { customerId: string; amount: number } } = {}) {
  const p = await bill(t);
  assert.ok(p.bill.orders.length > 0, `${t}: a bill to settle`);
  const amount = offlineSettleAmount(p, serverDeductsPriorPayments());
  if (!amount.ok) return { ok: false as const, reason: amount.reason };
  const pin = offlineSettlePin(amount.exactAmount, { subtotal: p.bill.subtotal, collected: p.collected }, opt.discount);
  if (!pin.ok) return { ok: false as const, reason: pin.reason };
  const draft = await getDineDraftForTable(SCOPE, t);
  const canonicalIds = p.orders.filter((o) => o.orderLocal == null).map((o) => o.orderId).filter((x): x is string => !!x);
  const hasCanonical = canonicalIds.length > 0;
  const common = {
    sessionId: draft && (draft.rounds.length > 0 || hasCanonical) ? draft.local_session_id : null,
    table: hasCanonical ? { scope: SCOPE, tableId: t, tableName: t, currency: "LBP", orderIds: canonicalIds } : undefined,
    method: opt.method ?? "cash",
    discount: opt.discount,
    covers: { orderIds: canonicalIds, summary: p.summaryOnly },
    extraDependencyIds: p.pendingMutationOpIds,
    expectedAmount: pin.amount,
  };
  const r = opt.onAccount
    ? await tableOnAccountOffline({ ...common, customerId: opt.onAccount.customerId, amount: opt.onAccount.amount })
    : await settleTableOffline({ ...common, cashAmountUsd: null });
  await tick();
  return { ok: true as const, ...r, pin: pin.amount, outstanding: p.outstanding };
}

/** DineInWorkspace.paySplit (offline): a leg over the named lines (or all still open). */
async function splitUI(shiftId: string, t: string, names: string[] | null, method: string) {
  const p = await bill(t);
  const po = p.orders[0];
  const order = p.bill.orders.find((b) => b.id === po.key)!;
  const allocations = order.lines
    .filter((l) => !names || names.includes(l.name))
    .map((l) => ({ order_item_id: l.id, quantity: l.quantity - (p.meta.get(l.id)?.paidQty ?? 0) }))
    .filter((a) => a.quantity > 0);
  const allocs = allocations.map((a) => {
    const m = p.meta.get(a.order_item_id)!;
    return m.ref.kind === "canonical" ? { order_item_id: m.ref.order_item_id, quantity: a.quantity } : { line_local: (m.ref as { line_local: string }).line_local, quantity: a.quantity };
  });
  const creators = allocations.map((a) => p.meta.get(a.order_item_id)!.creatorOpId).filter((x): x is string => !!x);
  const draft = await getDineDraftForTable(SCOPE, t);
  const sessionDeps = draft ? [draft.open_operation_id, ...draft.rounds.map((r) => r.operation_id)] : [];
  const completes = splitCompletesBill(p, po.key, allocations) ? { tableId: t, sessionLocal: draft?.local_session_id ?? null, orderIds: po.orderId ? [po.orderId] : [] } : null;
  const r = await splitOperationalBillOffline({
    scope: dscope(shiftId), orderId: po.orderId, orderLocal: po.orderId ? null : po.orderLocal, allocations: allocs, method, currency: "LBP",
    tableName: t, orderNumber: order.order_number || t, dependencyIds: [...sessionDeps, ...po.bumpOps, ...creators, ...p.structuralOpIds], completes,
  });
  assert.ok(r.ok, r.ok ? "" : r.reason);
  await tick();
  return { ...r, completes: completes != null };
}

function takeawayTxn(id: string, shiftLocal: string, items: [string, number][]): PosOfflineTxn {
  const cop = crypto.randomUUID();
  return {
    local_txn_id: id, client_op_id: cop, tenant_id: "t1", branch_id: "b1", device_id: DEV.device_id, terminal_id: DEV.terminal_id ?? "", cashier_user_id: "u1", cashier_user_name: "A", shift_id: shiftLocal,
    created_at: new Date().toISOString(),
    order_payload: { branch_id: "b1", order_type: "takeaway", status: "sent_to_kitchen", shift_id: shiftLocal, client_op_id: cop, notes: null, items: items.map(([m, q]) => ({ menu_item_id: m, name: MENU[m].name, base_price: MENU[m].price, quantity: q, kitchen_note: null, modifiers: [] })) },
    payment_intent: { method: "cash", currency: "LBP" }, sent_to_kitchen: true, currency: "LBP", total: items.reduce((s, [m, q]) => s + MENU[m].price * q, 0), status: "queued", attempts: 0,
    pending_shift_local_id: shiftLocal,
  } as PosOfflineTxn;
}

/** Σ what is still collectible on the floor (the operational projection, every table). */
async function collectible(): Promise<number> {
  let s = 0;
  for (const t of TABLES) s += (await bill(t)).outstanding ?? 0;
  return s;
}

type Day = { N: string; N1: string; endOp: string; cust: string; ops: Record<string, string> };

/**
 * The scripted offline day, captured through the real capture paths. `hook(boundary)` lets a test restart the
 * device (Dexie + module state) at a capture-side boundary.
 */
async function captureDay(hook: (b: string) => Promise<void> = async () => {}): Promise<Day> {
  const ops: Record<string, string> = {};
  // --- launch offline with valid offline authority; open shift N offline (float 40) ---
  await useShift.getState().open({ tenantId: "t1", userId: "u1", branchId: "b1", openingCash: 40, currency: "LBP" });
  const N = useShift.getState().pendingLocalId as string;
  assert.ok(N, "shift N opened offline (local pending shift)");
  assert.equal(useShift.getState().shift?.id, N);

  // --- takeaway, cash ---
  await localdb.posOfflineTxns.add(takeawayTxn("TK-1", N, [["mP", 1], ["mC", 2]])); // 120
  await tick();

  // --- dine-in, multiple rounds, cash ---
  await round(N, "T1", [["mP", 2]]);
  await round(N, "T1", [["mC", 1]]);
  await round(N, "T1", [["mF", 1]]); // 260
  await hook("dinein-rounds");

  // --- delivery: new customer + address + provider, cash ---
  const cust = await captureCustomerUpsertOffline({ scope: SCOPE, upsert: { branch_id: "b1", name: "Rana", phone: "70000002", address: { street: "Hamra St" } }, clientOpId: crypto.randomUUID() });
  await tick();
  const L1 = "aaaaaaaa-0000-4000-8000-0000000000d1";
  const dl = takeawayTxn("DL-1", N, []);
  await localdb.posOfflineTxns.add({
    ...dl, payment_intent: null,
    order_payload: { ...(dl.order_payload as object), order_type: "delivery", customer_id: cust.localCustomerId, address_id: cust.localAddressId, delivery_fee: 20, items: [{ menu_item_id: "mS", name: "Shawarma", base_price: 300, quantity: 1, kitchen_note: null, modifiers: [], client_line_id: L1 }] },
    customer_local: cust.localCustomerId, address_local: cust.localAddressId, total: 320,
  } as PosOfflineTxn);
  await tick();
  const ref = await orderRefFor("DL-1", SCOPE);
  const provId = crypto.randomUUID();
  await captureDeliveryProviderOffline({ scope: SCOPE, orderId: ref.orderId, orderLocal: ref.orderLocal, payload: { order_id: "DL-1", provider_id: "PRV-1", cost: null, cost_provided: false, client_op_id: provId }, clientOpId: provId, dependencyIds: ref.dependencyIds });
  await tick();
  const pref = await orderRefFor("DL-1", SCOPE);
  ops.dlPay = (await capturePayOrderOffline({ scope: SCOPE, orderId: pref.orderId, orderLocal: pref.orderLocal, method: "cash", currency: "LBP", clientOpId: payOrderClientOpId(SCOPE, "DL-1", "cash", "LBP"), orderNumber: "OFF", dependencyIds: pref.dependencyIds, orderType: "delivery" })).operationId;
  await tick();

  // --- T1 cash pay (the multi-round bill) ---
  const t1 = await settleUI("T1");
  assert.ok(t1.ok);
  assert.equal(t1.ok && t1.pin, 260, "the amount collected offline is pinned (local rounds only)");
  ops.t1 = t1.ok ? t1.operationId : "";

  // --- discount where allowed (15 % of 310 → 46.50) → cash ---
  await round(N, "T2", [["mS", 1], ["mC", 1]]);
  const t2 = await settleUI("T2", { discount: { discount_type: "percent", discount_value: 15 } });
  assert.ok(t2.ok);
  assert.equal(t2.ok && t2.pin, 263.5, "R after the discount, rounded like pos_pay_table_core");
  ops.t2 = t2.ok ? t2.operationId : "";

  // --- partial (split) payment: Pizza by card, then the rest by cash (the leg completes the bill) ---
  await round(N, "T3", [["mP", 1], ["mF", 1]]);
  const leg1 = await splitUI(N, "T3", ["Pizza"], "card");
  assert.equal(leg1.completes, false);
  // a full settle / On Account of a bill with an unsynced leg is refused at capture (R unknown here)
  assert.deepEqual(await settleUI("T3"), { ok: false, reason: PART_PAID_OFFLINE_SETTLE_MESSAGE });
  const leg2 = await splitUI(N, "T3", null, "cash");
  assert.equal(leg2.completes, true, "the leg that pays the rest closes the bill locally");
  ops.t3a = leg1.operationId;
  ops.t3b = leg2.operationId;

  // --- partial payment now + On Account remainder (the new, offline-created customer) ---
  await round(N, "T4", [["mS", 1], ["mL", 1]]); // 340
  const t4 = await settleUI("T4", { onAccount: { customerId: cust.localCustomerId as string, amount: 40 } });
  assert.ok(t4.ok);
  assert.equal(t4.ok && t4.pin, 340);
  ops.t4 = t4.ok ? t4.operationId : "";

  // --- move table, then pay after move ---
  await round(N, "M1", [["mP", 1], ["mL", 1]]); // 140
  await round(N, "G1", [["mF", 2]]); // 100
  await round(N, "G2", [["mC", 3]]); // 30
  await round(N, "H1", [["mS", 1], ["mF", 1]]); // 350
  await round(N, "H2", [["mL", 1]]); // 40
  const h1leg = await splitUI(N, "H1", ["Shawarma"], "card"); // H1 part-paid 300
  ops.h1leg = h1leg.operationId;
  const before = await collectible();
  assert.equal(before, 140 + 100 + 30 + 50 + 40, "collectible before move / merge");
  const mv = await captureMoveTableOffline({ scope: SCOPE, from: row("M1"), to: row("M2"), mapLoadedAt: MAP_AT });
  assert.ok(mv.ok, mv.ok ? "" : mv.reason);
  ops.move = mv.ok ? mv.operationId : "";
  await tick();
  assert.equal(await collectible(), before, "a move keeps the collectible balance");
  assert.deepEqual([(await bill("M1")).bill.orders.length, (await bill("M2")).outstanding], [0, 140]);

  // --- merge unpaid + unpaid (G2 → G1) and partial + unpaid (H1 part-paid → H2) ---
  const mg1 = await captureMergeTablesOffline({ scope: SCOPE, primary: row("G1"), sources: [row("G2")], mapLoadedAt: MAP_AT });
  assert.ok(mg1.ok, mg1.ok ? "" : mg1.reason);
  await tick();
  const mg2 = await captureMergeTablesOffline({ scope: SCOPE, primary: row("H2"), sources: [row("H1")], mapLoadedAt: MAP_AT });
  assert.ok(mg2.ok, mg2.ok ? "" : mg2.reason);
  assert.equal(mg2.ok && mg2.outstanding, 90, "R_H2 40 + R_H1 50 (H1's paid Shawarma stays on H1)");
  ops.merge1 = mg1.ok ? mg1.operationId : "";
  ops.merge2 = mg2.ok ? mg2.operationId : "";
  await tick();
  assert.equal(await collectible(), before, "merges keep the collectible balance (no independently collectible duplicate)");
  for (const t of ["G2", "H1"]) assert.equal((await bill(t)).outstanding ?? 0, 0, `${t}: the merged source is not collectible on its own`);
  await hook("before-pay-after-merge");

  // --- pay after move, pay after merge ---
  const m2 = await settleUI("M2");
  assert.ok(m2.ok);
  assert.equal(m2.ok && m2.pin, 140);
  const g1 = await settleUI("G1");
  assert.ok(g1.ok);
  assert.equal(g1.ok && g1.pin, 130);
  const h2 = await settleUI("H2");
  assert.ok(h2.ok);
  assert.equal(h2.ok && h2.pin, 90);
  ops.m2 = m2.ok ? m2.operationId : "";
  ops.g1 = g1.ok ? g1.operationId : "";
  ops.h2 = h2.ok ? h2.operationId : "";

  // --- receipt / floor projection: everything settled locally, nothing collectible, no duplicate ---
  assert.equal(await collectible(), 0, "the whole floor is settled: nothing is collectible twice");
  const floor = overlayTableTotals(TABLES.map(row), await getOperationalTableTotals(SCOPE, TABLES.map(row), undefined, MAP_AT));
  assert.deepEqual(floor.filter((x) => x.orders > 0).map((x) => x.id), [], "every table is free for the next customer");

  // --- close shift N offline (counted = float 40 + cash 1413.50) ---
  await cacheEndShiftApprovalRequired("t1", "b1", false);
  const ended = await useShift.getState().closeOffline({ scope: SCOPE, actualCashCounted: 1453.5, notes: null });
  await hook("after-close-N");

  // --- open shift N+1 offline (float 25) → one order ---
  await useShift.getState().open({ tenantId: "t1", userId: "u1", branchId: "b1", openingCash: 25, currency: "LBP" });
  const N1 = useShift.getState().pendingLocalId as string;
  assert.ok(N1 && N1 !== N, "N+1 is a new local shift");
  await hook("after-open-N1");
  assert.equal(useShift.getState().shift?.id, N1, "N+1 survives a restart as the active shift");
  await localdb.posOfflineTxns.add(takeawayTxn("TK-2", N1, [["mF", 1], ["mC", 1]])); // 60
  await tick();
  return { N, N1, endOp: ended.operationId, cust: cust.localCustomerId as string, ops };
}

/** Reconnect: drain until nothing is left to replay (the backoff window is elapsed between passes). */
async function reconnect(srv: FakeServer) {
  srv.down = false;
  srv.cut = null;
  for (let i = 0; i < 6; i++) {
    for (const o of await localdb.operations.toArray()) if (o.status === "retryable") await localdb.operations.update(o.operation_id, { last_attempt_at: new Date(0).toISOString() });
    const r = await drainOffline(CTX, "reconnect", srv.deps());
    const left = (await localdb.operations.toArray()).filter((o) => o.status === "pending" || o.status === "retryable" || o.status === "in_flight");
    if (left.length === 0 && r.drained.length === 0) break;
  }
}

/** The canonical end state — asserted identically after the plain run and after every restart boundary. */
async function assertCanonical(srv: FakeServer, day: Day, label: string) {
  const ops = await localdb.operations.toArray();
  const stuck = ops.filter((o) => o.status !== "synced" && o.status !== "cancelled").map((o) => `${o.operation_type}:${o.status}:${o.last_error_code}`);
  assert.deepEqual(stuck, [], `${label}: every op synced`);
  // shifts: exactly two canonical shifts, N closed, N+1 open; one float each; correct binding
  const shiftN = (await localdb.entityMap.get(day.N))?.canonical_id as string;
  const shiftN1 = (await localdb.entityMap.get(day.N1))?.canonical_id as string;
  assert.ok(shiftN && shiftN1 && shiftN !== shiftN1, `${label}: both shifts resolved to distinct canonical shifts`);
  assert.deepEqual([...srv.shifts.values()].map((s) => [s.status, s.float]), [["closed", 40], ["open", 25]], `${label}: two shifts, opening float once each`);
  assert.equal(srv.count("openShift") >= 2, true);
  const inN = [...srv.orders.values()].filter((o) => o.shift_id === shiftN);
  const inN1 = [...srv.orders.values()].filter((o) => o.shift_id === shiftN1);
  assert.deepEqual([inN.length, inN1.length, srv.orders.size], [11, 1, 12], `${label}: 11 orders in N, 1 in N+1, no duplicate`);
  assert.deepEqual(inN1.map((o) => [o.order_type, srv.total(o)]), [["takeaway", 60]], `${label}: N+1's order is bound to N+1`);
  // payments (exactly once), per method, per shift
  const pay = (o: SOrder | undefined) => srv.payments.filter((p) => p.order_id === o?.id).map((p) => [p.amount, p.method, p.kind]);
  const byTable = (t: string, open = false) => inN.find((o) => o.table_id === t && (open ? o.merged_into == null : true));
  const tk1 = inN.find((o) => o.order_type === "takeaway")!;
  const dl1 = inN.find((o) => o.order_type === "delivery")!;
  assert.deepEqual(pay(tk1), [[120, "cash", "sale"]], `${label}: takeaway`);
  assert.deepEqual(pay(byTable("T1")), [[260, "cash", "sale"]], `${label}: dine-in multi-round`);
  assert.deepEqual(pay(dl1), [[320, "cash", "sale"]], `${label}: delivery`);
  assert.deepEqual(pay(byTable("T2")), [[263.5, "cash", "sale"]], `${label}: discount 15 % → 263.50`);
  assert.equal(byTable("T2")!.discount, 46.5);
  assert.deepEqual(pay(byTable("T3")), [[100, "card", "split"], [50, "cash", "split"]], `${label}: partial (split) legs`);
  assert.deepEqual(pay(byTable("T4")), [[40, "cash", "on_account_now"]], `${label}: paid now`);
  assert.deepEqual(pay(byTable("M2")), [[140, "cash", "sale"]], `${label}: pay after move`);
  const g1 = inN.find((o) => o.table_id === "G1")!;
  const g2 = inN.find((o) => o.table_id === "G2")!;
  const h1 = inN.find((o) => o.table_id === "H1")!;
  const h2 = inN.find((o) => o.table_id === "H2")!;
  assert.deepEqual(pay(g1), [[130, "cash", "sale"]], `${label}: pay after merge (unpaid + unpaid)`);
  assert.deepEqual(pay(h2), [[90, "cash", "sale"]], `${label}: pay after merge (partial + unpaid) = Σ R`);
  assert.deepEqual(pay(h1), [[300, "card", "split"]], `${label}: the prior payment stays on its source, untouched`);
  assert.deepEqual(pay(g2), [], `${label}: a merge creates no payment`);
  assert.equal(srv.payments.length, 12, `${label}: 12 payment rows in total`);
  // merged-source state: voided WITH provenance (G2), completed for exactly P (H1)
  assert.deepEqual([g2.status, g2.merged_into, srv.total(g2)], ["voided", g1.id, 0]);
  assert.deepEqual([h1.status, h1.merged_into, srv.total(h1)], ["completed", h2.id, 300]);
  // receivable / customer balance (the offline-created customer, remapped once)
  assert.equal(srv.customers.size, 1, `${label}: one customer`);
  const [cid] = [...srv.customers.keys()];
  assert.equal(byTable("T4")!.customer_id, cid);
  assert.equal(srv.receivable(cid), 300, `${label}: the customer's balance is R − paid now`);
  assert.deepEqual([dl1.customer_id, dl1.address_id, dl1.provider_id, dl1.fee], [cid, [...srv.addresses.keys()][0], "PRV-1", 20], `${label}: delivery refs`);
  assert.deepEqual([srv.addresses.size, srv.providerAssignments.length], [1, 1]);
  // drawer = float + cash of THAT shift; no cash leaks N → N+1
  assert.equal(srv.drawer(shiftN), 40 + 1413.5, `${label}: drawer N`);
  assert.equal(srv.drawer(shiftN1), 25 + 60, `${label}: drawer N+1 (float + its own cash only)`);
  const sN = srv.shifts.get(shiftN)!;
  assert.deepEqual([sN.expected, sN.counted], [1453.5, 1453.5], `${label}: the close counted exactly the expected drawer`);
  // GL: POS_SALE exactly once per completed order; POS_PAYMENT once per payment row
  const sales = srv.glAttempts.filter((k) => k.startsWith("POS_SALE:"));
  assert.equal(new Set(sales).size, sales.length, `${label}: no order completed twice`);
  const completed = [...srv.orders.values()].filter((o) => o.status === "completed").map((o) => `POS_SALE:${o.id}`).sort();
  assert.deepEqual([...sales].sort(), completed, `${label}: POS_SALE once per completed order`);
  assert.equal(completed.length, 11, `${label}: 10 completed in N (G2 merged, not sold) + 1 in N+1`);
  assert.equal(srv.glAttempts.filter((k) => k.startsWith("POS_PAYMENT:")).length, 12);
  // inventory demand, per item, frozen once per completed order
  const perOrder = new Set(srv.demandAttempts.map((d) => d.order_id));
  assert.equal(perOrder.size, 11);
  const demand: Record<string, number> = {};
  for (const d of srv.demandAttempts) demand[d.menu_item_id] = (demand[d.menu_item_id] ?? 0) + d.qty;
  assert.deepEqual(demand, { mP: 5, mC: 8, mS: 4, mF: 6, mL: 3 }, `${label}: inventory demand per item`);
  // tables: everything free; versions moved forward
  assert.deepEqual([...srv.tables.values()].filter((t) => t.status !== "available").length, 0, `${label}: every table free`);
  // canonical history: the merged source reads Merged (not Voided / collectible), the part-paid source Paid
  const hist = srv.history(shiftN);
  const g2row = hist.find((o) => o.id === g2.id)!;
  assert.deepEqual([isMergedSource(g2row), orderStatusKey(g2row), canSettleOrder(g2row)], [true, "merged", false], `${label}: merged ≠ voided, never collectible`);
  const h1row = hist.find((o) => o.id === h1.id)!;
  assert.deepEqual([isMergedSource(h1row), orderStatusKey(h1row) === "voided"], [false, false]);
  assert.equal(reversalTotals(hist).voided, 0, `${label}: a merge is not a void`);
  assert.equal(hist.filter((o) => canSettleOrder(o)).length, 0, `${label}: nothing in N is collectible again`);
}

async function secondReconnectIsZero(srv: FakeServer, label: string) {
  const before = srv.state();
  const n = srv.calls.length;
  const opsBefore = stable(await localdb.operations.toArray());
  for (let i = 0; i < 2; i++) {
    await restart(); // disconnect (process restart offline) …
    const r = await drainOffline(CTX, "reconnect", srv.deps()); // … reconnect
    assert.equal(r.drained.length, 0, `${label}: nothing replayed again`);
  }
  assert.deepEqual(srv.calls.slice(n).map((x) => x.name), [], `${label}: zero calls on the second reconnect`);
  assert.equal(srv.state(), before, `${label}: zero additional effects`);
  assert.equal(stable(await localdb.operations.toArray()), opsBefore, `${label}: the op log is unchanged`);
}

/** Every call that reached the server, sent again with its identical client_op_id (×3): same logical result. */
async function replayIdenticalOps(srv: FakeServer) {
  const before = srv.state();
  const deps = srv.deps() as unknown as Record<string, (a: unknown) => Promise<unknown>>;
  const recorded = srv.calls.slice();
  for (let k = 0; k < 3; k++) {
    for (const call of recorded) {
      try {
        const r = (await deps[call.name](call.payload)) as Record<string, unknown> | undefined;
        if (r && typeof r === "object" && "idempotent" in r && call.name !== "openShift") assert.equal(r.idempotent, true, `${call.name}: replay returns the stored result`);
      } catch (e) {
        // only the op-id-less legacy takeaway pay is state-guarded (refused, never charged twice)
        assert.equal(call.name, "pay", `${call.name}: ${(e as Error).message}`);
      }
    }
  }
  assert.equal(srv.state(), before, "identical client_op_id ×3 → the same logical result, zero new effects");
}

// ================================================================ NORTH STAR

test("NORTH STAR: offline before the shift → open N → takeaway / multi-round dine-in / delivery+new customer / discount / split / on-account / move / merges → close N → open N+1 → restart → reconnect → canonical, exactly once; reconnect again = 0", async () => {
  const day = await captureDay(async (b) => {
    if (b === "after-open-N1") await restart();
  });
  // restart (re-open db + module state) OFFLINE: both shifts and every op restored, correct shift binding
  await restart();
  assert.equal(useShift.getState().shift?.id, day.N1, "the active shift after restart is N+1");
  assert.equal(useShift.getState().endedPendingSync?.operationId, day.endOp, "N's close is still pending sync");
  const pending = (await localdb.operations.toArray()).filter((o) => o.status === "pending");
  const tk2 = (await localdb.posOfflineTxns.get("TK-2"))!;
  assert.equal(tk2.pending_shift_local_id, day.N1, "N+1's sale is bound to N+1");
  assert.equal((await localdb.posOfflineTxns.get("TK-1"))!.pending_shift_local_id, day.N, "N's sale is bound to N");
  assert.ok(pending.length >= 30, `the whole day is queued durably (${pending.length} ops)`);
  assert.equal(await collectible(), 0, "after restart: nothing collectible twice");

  // reconnect → automatic drain → canonical
  const srv = new FakeServer(TABLES);
  await reconnect(srv);
  await assertCanonical(srv, day, "north star");
  // the replay order respected the graph: N's close after all of N, before N+1's open; N+1's sale after it
  const names = srv.calls.map((x) => x.name);
  const end = names.indexOf("endShiftOp");
  const opens = names.map((n, i) => (n === "openShift" ? i : -1)).filter((i) => i >= 0);
  assert.equal(opens.length, 2);
  assert.ok(opens[0] < end && end < opens[1], "open(N) → … → end(N) → open(N+1)");
  assert.equal((srv.calls[opens[1]].payload as { requireNew?: boolean }).requireNew, true, "N+1 must create, never adopt");
  const lastSubmit = names.lastIndexOf("submit");
  assert.ok(lastSubmit > opens[1], "N+1's sale replays after N+1's open");
  // every amount pin that reached the server equals what the device collected
  const pins = srv.calls.filter((x) => x.name === "payTable").map((x) => (x.payload as { tableId: string; expectedAmount: number }).expectedAmount);
  assert.deepEqual(pins.sort((a, b) => a - b), [90, 130, 140, 260, 263.5]);

  // disconnect → reconnect again: zero additional effects
  await secondReconnectIsZero(srv, "north star");
  // the identical client_op_ids replayed ×3 → the same logical result
  await replayIdenticalOps(srv);
});

// ================================================================ restart at every boundary

const BOUNDARIES: { name: string; cut?: (n: string, p: Record<string, unknown>) => boolean; lose?: string; capture?: string }[] = [
  { name: "before round replay", cut: (n) => n === "submitRound" },
  { name: "after rounds synced, before move", cut: (n) => n === "moveTableV2" },
  { name: "after move, before pay", cut: (n, p) => n === "payTable" && p.tableId === "M2" },
  { name: "after merge, before pay", cut: (n, p) => n === "payTable" && p.tableId === "G1" },
  { name: "during close shift (committed, response lost)", lose: "endShiftOp" },
  { name: "after local next-shift open (capture side)", capture: "after-open-N1" },
  { name: "before reconnect (capture side, after the close)", capture: "after-close-N" },
];

for (const b of BOUNDARIES) {
  test(`RESTART BOUNDARY — ${b.name}: the graph resumes, the canonical state is exactly the north star's, reconnect again = 0`, async () => {
    const day = await captureDay(async (x) => {
      if (b.capture === x) await restart();
    });
    await restart();
    const srv = new FakeServer(TABLES);
    if (b.lose) {
      srv.loseNext.add(b.lose);
      // the response is lost, then the connection drops before anything else
      srv.cut = (n) => srv.calls.some((x) => x.name === b.lose) && n !== b.lose;
    } else if (b.cut) srv.cut = b.cut;
    if (b.cut || b.lose) {
      await drainOffline(CTX, "reconnect", srv.deps());
      if (b.lose) assert.equal((await getOperation(day.endOp))?.status, "retryable", "the close committed but its response was lost");
      else assert.equal(srv.down, true, "the connection dropped at the boundary");
      const left = (await localdb.operations.toArray()).filter((o) => o.status !== "synced").length;
      assert.ok(left > 0, "work is still queued at the boundary");
      await restart(); // the device restarts offline at the boundary
      assert.ok(useShift.getState().shift, "an active shift is restored after the restart");
    }
    await reconnect(srv);
    await assertCanonical(srv, day, b.name);
    await secondReconnectIsZero(srv, b.name);
  });
}

// ================================================================ the AMOUNT PIN (financial gap)

/** A dine-in bill whose rounds are captured offline; the shift exists canonically (the gap is about the bill). */
async function amountPinSetup(lines: [string, number, number][]) {
  const srv = new FakeServer(["A"]);
  srv.shifts.set("SRV-SHIFT-1", { status: "open", cashier: "u1", float: 0, counted: null, expected: null });
  const d = await openTableOffline({ scope: dscope("SRV-SHIFT-1"), tableId: "A", tableName: "A", seats: 4, currency: "LBP" });
  for (const [name, price, qty] of lines) await addDraftLine(d.local_session_id, { menu_item_id: `x-${name}`, name, base_price: price, quantity: qty, modifiers: [], kitchen_note: null });
  await sendRoundOffline(d.local_session_id);
  await tick();
  return srv;
}

test("AMOUNT PIN — unchanged bill (offline rounds only): expected_amount = R_local is ALWAYS sent and accepted; drawer = R", async () => {
  const srv = await amountPinSetup([["Pizza", 100, 2]]);
  const d = (await getDineDraftForTable(SCOPE, "A"))!;
  await addDraftLine(d.local_session_id, { menu_item_id: "x-Cola", name: "Cola", base_price: 10, quantity: 3, modifiers: [], kitchen_note: null });
  await sendRoundOffline(d.local_session_id);
  const s = await settleUI("A");
  assert.ok(s.ok);
  assert.equal((await getOperation(s.operationId))!.payload && ((await getOperation(s.operationId))!.payload as { expected_amount: number }).expected_amount, 230);
  await reconnect(srv);
  assert.equal((await getOperation(s.operationId))!.status, "synced");
  assert.deepEqual(srv.calls.filter((x) => x.name === "payTable").map((x) => (x.payload as { expectedAmount: number }).expectedAmount), [230]);
  assert.deepEqual(srv.payments.map((p) => [p.amount, p.method]), [[230, "cash"]]);
  assert.equal(srv.drawer("SRV-SHIFT-1"), 230);
});

test("AMOUNT PIN — another terminal appends a round to the SAME bill before our pay replays: REFUSED (PAY_AMOUNT_CHANGED), no payment, drawer unchanged, bill shown refused (never fake paid), never retried blindly", async () => {
  const srv = await amountPinSetup([["Pizza", 100, 1], ["Fries", 50, 1]]);
  const s = await settleUI("A");
  assert.ok(s.ok);
  assert.equal(s.ok && s.pin, 150);
  // our round 1 reaches the server first; then (before our pay) the other terminal appends Salad to that bill
  srv.before = { name: "payTable", fn: () => { const o = srv.openOn("A")[0]; srv.addItems(o, [{ name: "Salad", base_price: 40, quantity: 1 }]); } };
  await reconnect(srv);
  const op = (await getOperation(s.operationId))!;
  assert.deepEqual([op.status, op.last_error_code], ["needs_attention", "pay_amount_changed"]);
  assert.equal(settleRefusedByServer(op), true, "a refusal: the bill is unpaid again with the reason (never a fake Paid)");
  assert.deepEqual(srv.payments, [], "no payment written at the server's NEW R (190) the cashier never collected");
  assert.equal(srv.drawer("SRV-SHIFT-1"), 0, "drawer unchanged");
  assert.deepEqual([srv.openOn("A").length, srv.total(srv.openOn("A")[0])], [1, 190], "the bill stays open for manager review");
  const p = await getOperationalTableBill(SCOPE, row("A"), undefined, undefined, MAP_AT);
  assert.equal(p.settlementConflict || p.refusedSettleMessage != null, true, "the floor shows the refused settle");
  // never retried blindly: further reconnects send nothing
  const n = srv.count("payTable");
  await reconnect(srv);
  await reconnect(srv);
  assert.equal(srv.count("payTable"), n);
});

test("AMOUNT PIN — On Account: a remote round appended → ON_ACCOUNT_AMOUNT_CHANGED, no receivable, no paid-now row", async () => {
  const srv = await amountPinSetup([["Shawarma", 300, 1]]);
  srv.customers.set("SC-1", { name: "Acc", phone: null });
  const s = await settleUI("A", { onAccount: { customerId: "SC-1", amount: 20 } });
  assert.ok(s.ok);
  srv.before = { name: "onAccountTable", fn: () => srv.addItems(srv.openOn("A")[0], [{ name: "Cola", base_price: 10, quantity: 1 }]) };
  await reconnect(srv);
  const op = (await getOperation(s.ok ? s.operationId : ""))!;
  assert.deepEqual([op.status, op.last_error_code], ["needs_attention", "on_account_amount_changed"]);
  assert.deepEqual([srv.payments.length, srv.receivable("SC-1")], [0, 0]);
  assert.equal(srv.openOn("A").length, 1);
});

test("AMOUNT PIN — rounding edges: LBP (discount rounded to 2 dp), USD float sums, half-away rounding (1.005), fixed-amount discount — the server accepts every pin on an unchanged bill", async () => {
  // pure: Postgres numeric rounding without binary noise
  assert.equal(roundNumeric(1.1 + 2.2, 2), 3.3);
  assert.equal(roundNumeric(1.005, 2), 1.01, "Math.round(1.005 * 100) / 100 gives 1.00");
  assert.equal(roundNumeric(4.995, 2), 5);
  assert.equal(roundNumeric(-1.005, 2), -1.01);
  assert.equal(roundNumeric(30999.69, 2), 30999.69);
  // pure: the pin with the discount, exactly as pos_pay_table_core computes it
  const pin = (sub: number, d?: { discount_type: string; discount_value: number }, collected = 0) => offlineSettlePin(sub - collected, { subtotal: sub, collected }, d);
  assert.deepEqual(pin(33333, { discount_type: "percent", discount_value: 7 }), { ok: true, amount: 30999.69 }, "LBP: round(33333 × 7 / 100, 2) = 2333.31 (2 dp, never LBP-integer)");
  assert.deepEqual(pin(6.7, { discount_type: "percent", discount_value: 15 }), { ok: true, amount: 5.69 }, "1.005 → 1.01 (half away from zero)");
  assert.deepEqual(pin(33.33, { discount_type: "percent", discount_value: 12.5 }), { ok: true, amount: 29.16 }, "4.16625 → 4.17");
  assert.deepEqual(pin(10, { discount_type: "amount", discount_value: 0.125 }), { ok: true, amount: 9.87 }, "round(0.125, 2) = 0.13");
  assert.deepEqual(pin(100, { discount_type: "percent", discount_value: 100 }), { ok: true, amount: 0 });
  assert.deepEqual(pin(100), { ok: true, amount: 100 }, "no discount → R_local unchanged");
  assert.deepEqual(pin(180, { discount_type: "percent", discount_value: 10 }, 150), { ok: false, reason: PART_PAID_DISCOUNT_MESSAGE }, "discount on a part-paid bill: refused at capture (SPLIT_DISCOUNT_UNSUPPORTED)");
  assert.deepEqual(offlineSettlePin(null, { subtotal: null, collected: 0 }, { discount_type: "percent", discount_value: 5 }), { ok: true, amount: null }, "mixed currency: no single figure");

  // end-to-end through capture → replay → the fake server's numeric arithmetic (cents)
  const cases: { lines: [string, number, number][]; discount?: { discount_type: string; discount_value: number }; expect: number }[] = [
    { lines: [["Mezze", 11111, 3]], expect: 33333 }, // LBP, no discount
    { lines: [["Mezze", 11111, 3]], discount: { discount_type: "percent", discount_value: 7 }, expect: 30999.69 }, // LBP + discount
    { lines: [["Tea", 1.1, 3], ["Water", 0.2, 1]], expect: 3.5 }, // USD float sum 3.5000000000000004
    { lines: [["Wrap", 3.35, 2]], discount: { discount_type: "percent", discount_value: 15 }, expect: 5.69 }, // 6.70 × 15 % = 1.005
    { lines: [["Wrap", 3.35, 2]], discount: { discount_type: "amount", discount_value: 0.125 }, expect: 6.57 },
  ];
  for (const k of cases) {
    await Promise.all([localdb.operations.clear(), localdb.entityMap.clear(), localdb.dineDrafts.clear()]);
    __resetDrainLockForTests();
    const srv = await amountPinSetup(k.lines);
    const s = await settleUI("A", { discount: k.discount });
    assert.ok(s.ok);
    assert.equal(s.ok && s.pin, k.expect, `pin ${JSON.stringify(k)}`);
    await reconnect(srv);
    const op = (await getOperation(s.ok ? s.operationId : ""))!;
    assert.equal(op.status, "synced", `accepted: ${JSON.stringify(k)} (${op.last_error_code ?? ""})`);
    assert.deepEqual(srv.payments.map((p) => p.amount), [k.expect]);
  }
});
