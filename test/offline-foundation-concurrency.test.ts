// Final Foundation (CONC, Track 13) — MULTI-TERMINAL concurrency, Tier 1 (deterministic, $0, CI-safe).
//
// TWO (sometimes three) terminals, each with its OWN local database and its OWN device / terminal identity, against
// ONE shared fake server. Every terminal runs the REAL capture engines, projections, orchestrator and handlers; the
// local Dexie database of the inactive terminal is parked in memory and restored byte-for-byte when it becomes active
// again (`use(terminal)`), and each terminal has its own localStorage (→ its own device_id / terminal_id). So the two
// devices share NOTHING but the server — exactly like two tills in one restaurant.
//
// The fake server models the CURRENT STAGING contracts (pg_get_functiondef, 2026-10-27):
//   pos_submit_order → pos_save_order: per-table bill (first open unpaid dine-in order), expected_order_id guard
//     (EXPECTED_ORDER_MISMATCH), the caller's OWN open shift (`_pos_lock_open_shift`: "This shift is closed"), menu price
//     check (PRICE_CHANGED, nothing written), idempotency by client_op_id with NO actor check (pos_order_submissions).
//   pos_pay_table(_core): pos_op_replay (cached for ANY actor), expected_order_ids (PAY_BILL_CHANGED / ALREADY_SETTLED
//     only when every pinned order is payment_status='paid'), the order's shift must be open, R = T − P (S4),
//     expected_amount (PAY_AMOUNT_CHANGED), ALREADY_PAID.
//   pos_split_settle: NOT_SPLITTABLE once closed/paid, shift open, item-subset legs.
//   pos_complete_table_on_account: the S2 pins (ON_ACCOUNT_BILL_CHANGED / ON_ACCOUNT_AMOUNT_CHANGED), R − now receivable.
//   pos_move_table_v2 / pos_merge_tables_v4: actor + request fingerprint (CROSS_ACTOR_REPLAY_REJECTED /
//     IDEMPOTENCY_PAYLOAD_MISMATCH), bill pins, versions, MOVE_DEST_OCCUPIED.
//   pos_open_shift: one open shift per cashier (adopt → reused:true), require_new → SHIFT_ALREADY_OPEN.
//   pos_upsert_customer: phone unique per OU; same phone + different name → CUSTOMER_IDENTITY_CONFLICT, compatible → link.
// Each server call is atomic — which is what the server's advisory / row locks guarantee (proven in Tier 2,
// test/staging/offline-foundation-concurrency-tier2.sql): a concurrent remote action can only land BETWEEN two of a
// terminal's calls. The interleaving scheduler therefore inserts the remote terminal's action before EVERY one of the
// replaying terminal's server calls (k = 0..n, exhaustive and deterministic), plus "after everything".
//
// Invariants asserted for every interleaving: stale state rejected (named conflict), dependents parked behind it, no
// double payment, no duplicate order / receivable / inventory demand, no hidden re-attachment to another cashier's
// shift, the collectible balance (Σ payments + Σ receivables ≤ T per order, = T when closed), every op ends synced or
// needs_attention with a named code, and a SECOND reconnect of every terminal produces zero calls and zero effects.

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
const G = globalThis as unknown as { localStorage: MemStorage };
G.localStorage = new MemStorage();

import { localdb, cacheBill, type PosOfflineTxn } from "@/lib/offline/db";
import type { OfflineOperation } from "@/lib/offline/operationLog";
import { drainOffline, __resetDrainLockForTests, __setReplayTimeoutForTests } from "@/lib/offline/orchestrator";
import type { PosTxnSyncDeps } from "@/lib/offline/posTxnSync";
import { openTableOffline, addDraftLine, sendRoundOffline, settleTableOffline, tableOnAccountOffline, getDineDraftForTable } from "@/lib/offline/dineinOffline";
import { getOperationalTableBill, offlineSettleAmount } from "@/lib/offline/operationalProjection";
import { captureMoveTableOffline } from "@/lib/offline/tableOpOffline";
import { captureCustomerUpsertOffline } from "@/lib/offline/customerOffline";
import { captureEndShiftOffline } from "@/lib/offline/endShiftOffline";
import { createLocalPendingShift } from "@/lib/offline/pendingShift";
import { classifyOperation } from "@/lib/offline/queueForensics";
import { serverDeductsPriorPayments, setServerDeductsPriorPayments } from "@/lib/pos/tablePayment";
import { getDeviceIdentity, type DeviceIdentity } from "@/lib/device";
import type { TableBill, TableSummary, BillOrder } from "@/types/tables";

const MAP_AT = Date.now() - 10 * 60_000;
const tick = () => new Promise((r) => setTimeout(r, 4));
const uuid = () => crypto.randomUUID();

// ================================================================ terminals: one local database + identity each

class Terminal {
  readonly storage = new MemStorage();
  readonly dump = new Map<string, unknown[]>();
  dev: DeviceIdentity | null = null;
  readonly name: string;
  readonly cashier: string;
  shiftId: string;
  constructor(name: string, cashier: string, shiftId: string) {
    this.name = name;
    this.cashier = cashier;
    this.shiftId = shiftId;
  }
  scope() {
    const d = this.dev as DeviceIdentity;
    return { tenantId: "t1", branchId: "b1", cashierUserId: this.cashier, deviceId: d.device_id, terminalId: d.terminal_id ?? null };
  }
  dscope(shiftId = this.shiftId) { return { ...this.scope(), shiftId }; }
}

let active: Terminal | null = null;
/** Make `t` the running terminal: park the current terminal's whole local database, restore t's. */
async function use(t: Terminal) {
  if (active === t) return;
  if (active) for (const tb of localdb.tables) active.dump.set(tb.name, await tb.toArray());
  for (const tb of localdb.tables) await tb.clear();
  for (const tb of localdb.tables) {
    const rows = t.dump.get(tb.name);
    if (rows && rows.length > 0) await tb.bulkPut(structuredClone(rows) as never);
  }
  G.localStorage = t.storage;
  __resetDrainLockForTests();
  active = t;
  if (!t.dev) t.dev = getDeviceIdentity();
}
/** A restored backup / cloned PC: the same local database, a different machine (and possibly another sign-in). */
async function cloneOf(src: Terminal, name: string, cashier: string): Promise<Terminal> {
  await use(src);
  const c = new Terminal(name, cashier, src.shiftId);
  for (const tb of localdb.tables) c.dump.set(tb.name, structuredClone(await tb.toArray()));
  const ident = src.storage.getItem("breadee-desktop-device"); // a disk clone carries the device identity too
  if (ident) c.storage.setItem("breadee-desktop-device", ident);
  return c;
}

beforeEach(async () => {
  active = null;
  for (const tb of localdb.tables) await tb.clear();
  __resetDrainLockForTests();
  setServerDeductsPriorPayments(null);
});
afterEach(() => {
  __setReplayTimeoutForTests(45_000);
  setServerDeductsPriorPayments(null);
});

// ================================================================ the shared fake server (staging contract model)

type SItem = { id: string; client_line_id: string | null; menu_item_id: string; name: string; price: number; qty: number; paid_qty: number; batch: number; void: boolean };
type SOrder = {
  id: string; table_id: string | null; order_type: string; status: "open" | "completed" | "voided";
  payment_status: "unpaid" | "partial" | "paid"; settlement_mode: "on_account" | null; shift_id: string; creator: string;
  items: SItem[]; settlements: number; version: number; customer_id: string | null; address_id: string | null; fee: number; merged_into?: string; created_at: string; created_by_op: string | null;
};
type Call = { actor: string; name: string; payload: unknown };
const posErr = (code: string, msg = code) => Object.assign(new Error(msg), { code: "P0001", details: JSON.stringify({ pos_error_code: code }) });
const sorted = (a: string[]) => [...a].sort();
const stable = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));
const MENU: Record<string, { name: string; price: number }> = { mP: { name: "Pizza", price: 100 }, mC: { name: "Cola", price: 10 }, mF: { name: "Fries", price: 50 }, mS: { name: "Shawarma", price: 300 } };
const SHIFT_CLOSED = "This shift is closed";

class FakeServer {
  menu: Record<string, { name: string; price: number }> = structuredClone(MENU);
  shifts = new Map<string, { status: "open" | "closed"; cashier: string }>();
  tables = new Map<string, { version: number; status: "available" | "occupied" }>();
  orders = new Map<string, SOrder>();
  payments: { order_id: string; amount: number; method: string; kind: "sale" | "split" | "on_account_now"; op: string; actor: string }[] = [];
  receivables: { order_id: string; customer_id: string; amount: number; op: string }[] = [];
  customers = new Map<string, { name: string | null; phone: string | null }>();
  addresses = new Map<string, { customer_id: string; street: string | null }>();
  submissions = new Map<string, { type: string; fp: string; actor: string; result: Record<string, unknown> }>();
  demand: { op: string; qty: number }[] = []; // inventory demand ledger (one entry per item-writing op)
  calls: Call[] = [];
  seq = 0;
  /** interleaving scheduler: before the victim's k-th call (0-based), run the remote terminal's action once. */
  hook: { victim: string; at: number; fn: () => Promise<void>; fired: boolean; n: number } | null = null;

  constructor(tables: string[], shifts: [string, string][]) {
    for (const t of tables) this.tables.set(t, { version: 1, status: "available" });
    for (const [id, cashier] of shifts) this.shifts.set(id, { status: "open", cashier });
  }
  id(p: string) { return `${p}-${++this.seq}`; }
  live(o: SOrder) { return o.items.filter((i) => !i.void); }
  total(o: SOrder) { return this.live(o).reduce((s, i) => s + i.price * i.qty, 0) + o.fee; }
  paidP(o: SOrder) { return this.live(o).reduce((s, i) => s + i.price * i.paid_qty, 0); }
  /** pos_save_order's bill: open (draft/sent_to_kitchen), not paid, dine-in, oldest first. */
  openOn(t: string) { return [...this.orders.values()].filter((o) => o.table_id === t && o.status === "open" && o.payment_status !== "paid").sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)); }
  bump(t: string) { const r = this.tables.get(t)!; r.version += 1; return r.version; }
  pay(order_id: string, amount: number, method: string, kind: "sale" | "split" | "on_account_now", op: string, actor: string) { this.payments.push({ order_id, amount, method, kind, op, actor }); }
  shiftOpen(id: unknown) {
    const s = typeof id === "string" ? this.shifts.get(id) : undefined;
    if (!s) throw new Error("Shift not found for this tenant/branch");
    if (s.status !== "open") throw new Error(SHIFT_CLOSED);
    return s;
  }
  newOrder(o: Partial<SOrder> & { shift_id: string; creator: string }): SOrder {
    const order: SOrder = { id: this.id("SO"), table_id: null, order_type: "dine_in", status: "open", payment_status: "unpaid", settlement_mode: null, items: [], settlements: 0, version: 0, customer_id: null, address_id: null, fee: 0, created_at: new Date(Date.now() + this.seq).toISOString(), created_by_op: null, ...o };
    this.orders.set(order.id, order);
    return order;
  }
  checkPrices(items: { menu_item_id?: string; name?: string; base_price?: number; quantity: number }[]) {
    items.forEach((it, i) => {
      const m = this.menu[String(it.menu_item_id)];
      if (m && it.base_price != null && Math.abs(Number(it.base_price) - m.price) >= 0.005) throw posErr("PRICE_CHANGED", `Line ${i + 1} (${m.name}): The price of "${m.name}" changed since this order was taken offline`);
    });
  }
  addItems(o: SOrder, items: { menu_item_id?: string; name?: string; base_price?: number; quantity: number; client_line_id?: string }[], op: string) {
    const batch = o.items.reduce((m, i) => Math.max(m, i.batch), 0) + 1;
    let qty = 0;
    for (const it of items) {
      const menu = this.menu[String(it.menu_item_id)] ?? { name: String(it.name ?? "Item"), price: Number(it.base_price ?? 0) };
      o.items.push({ id: this.id("SI"), client_line_id: it.client_line_id ?? null, menu_item_id: String(it.menu_item_id ?? "m"), name: menu.name, price: menu.price, qty: it.quantity, paid_qty: 0, batch, void: false });
      qty += it.quantity;
    }
    this.demand.push({ op, qty });
  }
  /** A bill opened ONLINE earlier by `creator` on `shift` (both terminals saw it on their map). */
  seedOrder(table: string, items: { menu_item_id: string; qty: number }[], creator: string, shift: string): SOrder {
    const o = this.newOrder({ table_id: table, shift_id: shift, creator });
    this.addItems(o, items.map((i) => ({ menu_item_id: i.menu_item_id, quantity: i.qty })), this.id("SEED"));
    this.tables.get(table)!.status = "occupied";
    this.bump(table);
    return o;
  }
  state() {
    return stable({ o: [...this.orders.values()], p: this.payments, r: this.receivables, c: [...this.customers], a: [...this.addresses], t: [...this.tables], s: [...this.shifts], d: this.demand, m: this.menu });
  }
  count(name: string, actor?: string) { return this.calls.filter((c) => c.name === name && (actor == null || c.actor === actor)).length; }

  deps(actor: string): PosTxnSyncDeps {
    const rec = async (name: string, payload: unknown) => {
      this.calls.push({ actor, name, payload: JSON.parse(JSON.stringify(payload ?? null)) });
      const h = this.hook;
      if (h && actor === h.victim) {
        if (!h.fired && h.n === h.at) {
          h.fired = true;
          await h.fn();
        }
        h.n += 1;
      }
    };
    const cached = (op: string) => {
      const s = this.submissions.get(op);
      return s ? { ...s.result, idempotent: true } : null;
    };
    const d: Partial<PosTxnSyncDeps> = {
      isTransport: (e) => e instanceof TypeError,
      hasSession: async () => true,
      openShift: async (a) => {
        await rec("open_shift", a);
        const hit = cached(a.clientOpId);
        if (hit) return { shiftId: String((hit as Record<string, unknown>).shiftId), reused: false };
        const mine = [...this.shifts].find(([, s]) => s.cashier === actor && s.status === "open");
        if (mine) {
          if (a.requireNew) throw posErr("SHIFT_ALREADY_OPEN", "Another shift is already open for this cashier on this branch. The shift opened offline was not attached to it.");
          this.submissions.set(a.clientOpId, { type: "shift", fp: "", actor, result: { shiftId: mine[0] } });
          return { shiftId: mine[0], reused: true };
        }
        const id = this.id("SH");
        this.shifts.set(id, { status: "open", cashier: actor });
        this.submissions.set(a.clientOpId, { type: "shift", fp: "", actor, result: { shiftId: id } });
        return { shiftId: id, reused: false };
      },
      endShiftOp: async (a) => {
        await rec("end_shift", a);
        if (cached(a.clientOpId)) return { shift_id: a.shiftId, idempotent: true };
        const s = this.shiftOpen(a.shiftId);
        s.status = "closed";
        this.submissions.set(a.clientOpId, { type: "end", fp: "", actor, result: {} });
        return { shift_id: a.shiftId, idempotent: false };
      },
      openTable: async (p) => {
        await rec("open_table", p);
        const hit = cached(p.client_op_id);
        if (hit) return hit as never;
        const t = this.tables.get(p.name)!;
        if (p.expected_version != null && p.expected_version !== t.version) throw posErr("VERSION_CONFLICT", "VERSION_CONFLICT: This table changed since it was opened");
        t.status = "occupied";
        const result = { table_id: p.name, pos_entity_version: this.bump(p.name) };
        this.submissions.set(p.client_op_id, { type: "open", fp: "", actor, result });
        return result;
      },
      submitRound: async (p) => {
        await rec("round", p);
        const op = String(p.client_op_id);
        const hit = cached(op); // pos_order_submissions: no actor check
        if (hit) return hit as never;
        const table = String(p.table_id);
        const open = this.openOn(table);
        let o: SOrder | undefined = open[0];
        if (p.expected_order_id && o?.id !== p.expected_order_id) throw posErr("EXPECTED_ORDER_MISMATCH", "This table's bill changed since it was opened offline and cannot take this round");
        if (p.shift_id) {
          const s = this.shiftOpen(p.shift_id);
          if (s.cashier !== actor) throw new Error("Use your own open shift for this order");
        }
        this.checkPrices(p.items as never);
        const appended = !!o;
        if (!o) o = this.newOrder({ table_id: table, shift_id: String(p.shift_id), creator: actor, created_by_op: op });
        this.addItems(o, p.items as never, op);
        this.tables.get(table)!.status = "occupied";
        const result = { order_id: o.id, order_number: o.id, batch_no: o.items.reduce((m, i) => Math.max(m, i.batch), 0), appended };
        this.submissions.set(op, { type: "round", fp: "", actor, result });
        return { ...result, idempotent: false };
      },
      submit: async (p) => {
        await rec("submit", p);
        const op = String(p.client_op_id);
        const hit = cached(op);
        if (hit) return hit as never;
        const s = this.shiftOpen(p.shift_id);
        if (s.cashier !== actor) throw new Error("Use your own open shift for this order");
        const pp = p as unknown as Record<string, unknown>;
        if (pp.customer_id != null && !this.customers.has(String(pp.customer_id))) throw new Error("Customer not found for this operating unit");
        if (pp.address_id != null && !this.addresses.has(String(pp.address_id))) throw new Error("Address not found for this customer");
        this.checkPrices(p.items as never);
        const o = this.newOrder({ order_type: String(pp.order_type ?? "takeaway"), shift_id: String(p.shift_id), creator: actor, customer_id: (pp.customer_id as string) ?? null, address_id: (pp.address_id as string) ?? null, fee: Number(pp.delivery_fee ?? 0) || 0, created_by_op: op });
        this.addItems(o, p.items as never, op);
        const result = { order_id: o.id, order_number: o.id };
        this.submissions.set(op, { type: "submit", fp: "", actor, result });
        return result;
      },
      payTable: async (a) => {
        await rec("pay_table", a);
        const hit = cached(a.clientOpId); // pos_op_replay: no actor check
        if (hit) return hit as never;
        const open = this.openOn(a.tableId);
        if (a.expectedOrderIds && a.expectedOrderIds.length > 0) {
          if (open.length === 0) {
            if (a.expectedOrderIds.every((id) => this.orders.get(id)?.payment_status === "paid")) throw posErr("ALREADY_SETTLED", "This bill was already paid.");
            throw posErr("PAY_BILL_CHANGED", "The bill on this table changed since the payment was captured.");
          }
          if (stable(sorted(open.map((o) => o.id))) !== stable(sorted([...new Set(a.expectedOrderIds)]))) throw posErr("PAY_BILL_CHANGED", "The bill on this table changed since the payment was captured.");
        }
        if (open.length === 0) throw new Error("No open order on this table to pay");
        for (const o of open) this.shiftOpen(o.shift_id);
        for (const o of open) if (o.settlements > 0 && this.total(o) - this.paidP(o) <= 0.005) throw posErr("ALREADY_PAID", "This bill is already fully paid by split settlements.");
        const due = open.reduce((s, o) => s + this.total(o) - this.paidP(o), 0);
        if (a.expectedAmount != null && Math.abs(due - a.expectedAmount) >= 0.005) throw posErr("PAY_AMOUNT_CHANGED", "The amount due on this table changed since the payment was captured.");
        for (const o of open) {
          this.pay(o.id, this.total(o) - this.paidP(o), a.method, "sale", a.clientOpId, actor);
          o.status = "completed";
          o.payment_status = "paid";
        }
        this.tables.get(a.tableId)!.status = "available";
        const result = { ok: true, amount: due, pos_entity_version: this.bump(a.tableId) };
        this.submissions.set(a.clientOpId, { type: "pay", fp: "", actor, result });
        return { ...result, idempotent: false };
      },
      orderItemMap: async ({ orderId }) => (this.orders.get(orderId)?.items ?? []).filter((i) => i.client_line_id).map((i) => ({ client_line_id: i.client_line_id as string, order_item_id: i.id })),
      splitSettle: async (a) => {
        await rec("split", a);
        const hit = cached(a.clientOpId);
        if (hit) return hit as never;
        const o = this.orders.get(a.orderId);
        if (!o) throw new Error("Order not found");
        if (o.status !== "open" || o.payment_status === "paid") throw posErr("NOT_SPLITTABLE", "This order is not an open, unpaid dine-in bill and cannot be split.");
        this.shiftOpen(o.shift_id);
        let amount = 0;
        for (const al of a.allocations) {
          const it = o.items.find((i) => i.id === al.order_item_id && !i.void);
          if (!it || it.paid_qty + al.quantity > it.qty) throw new Error("A selected line is not part of this bill");
          it.paid_qty += al.quantity;
          amount += it.price * al.quantity;
        }
        o.settlements += 1;
        o.version += 1;
        const done = this.total(o) - this.paidP(o) <= 0.005;
        o.payment_status = done ? "paid" : "partial";
        if (done) o.status = "completed";
        this.pay(o.id, amount, a.method, "split", a.clientOpId, actor);
        const result = { ok: true, split_no: o.settlements, parent_completed: done, remaining_qty: 0 };
        this.submissions.set(a.clientOpId, { type: "split", fp: "", actor, result });
        return { ...result, idempotent: false };
      },
      onAccountTable: async (a) => {
        await rec("on_account_table", a);
        const hit = cached(a.clientOpId);
        if (hit) return hit as never;
        const open = this.openOn(a.tableId);
        if (!this.customers.has(a.customerId)) throw Object.assign(new Error("Customer not found for this operating unit"), { code: "42501" });
        if (a.expectedOrderIds && a.expectedOrderIds.length > 0) {
          if (open.length === 0) {
            if (a.expectedOrderIds.every((id) => this.orders.get(id)?.payment_status === "paid")) throw posErr("ALREADY_SETTLED", "This bill was already settled.");
            throw posErr("ON_ACCOUNT_BILL_CHANGED", "The bill changed since it was put on account.");
          }
          if (stable(sorted(open.map((o) => o.id))) !== stable(sorted(a.expectedOrderIds))) throw posErr("ON_ACCOUNT_BILL_CHANGED", "The bill changed since it was put on account.");
        }
        if (open.length === 0) throw new Error("No open order to put on account");
        for (const o of open) this.shiftOpen(o.shift_id);
        const T = open.reduce((s, o) => s + this.total(o), 0);
        const P = open.reduce((s, o) => s + this.paidP(o), 0);
        const R = T - P;
        if (P > 0 && R <= 0.005) throw posErr("ALREADY_PAID", "ALREADY_PAID: the bill is fully covered by prior payments");
        if (a.expectedAmount != null && Math.abs(R - a.expectedAmount) >= 0.005) throw posErr("ON_ACCOUNT_AMOUNT_CHANGED", "The amount due changed since it was put on account.");
        if (a.amount > 0) this.pay(open[0].id, a.amount, a.method, "on_account_now", a.clientOpId, actor);
        if (R - a.amount > 0.005) this.receivables.push({ order_id: open[0].id, customer_id: a.customerId, amount: R - a.amount, op: a.clientOpId });
        for (const o of open) {
          o.status = "completed";
          o.payment_status = P > 0 || a.amount > 0 ? "partial" : "unpaid";
          o.settlement_mode = "on_account";
          o.customer_id = a.customerId;
        }
        this.tables.get(a.tableId)!.status = "available";
        this.bump(a.tableId);
        this.submissions.set(a.clientOpId, { type: "on_account", fp: "", actor, result: { ok: true } });
        return { ok: true, idempotent: false };
      },
      upsertCustomer: async (a) => {
        await rec("customer", a);
        const hit = cached(a.clientOpId);
        if (hit) return hit as never;
        const p = a.payload as { id?: string; name?: string; phone?: string; address?: { street?: string; id?: string } };
        const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
        let cid = p.id ?? null;
        let isNew = false;
        if (cid) {
          if (!this.customers.has(cid)) throw Object.assign(new Error("Customer not found for this operating unit"), { code: "42501" });
        } else {
          const match = [...this.customers].find(([, c]) => p.phone && c.phone === p.phone);
          if (match) {
            if (norm(p.name) && norm(match[1].name) && norm(p.name) !== norm(match[1].name)) throw new Error("CUSTOMER_IDENTITY_CONFLICT: A different customer has this number in this operating unit. Verify before linking.");
            cid = match[0]; // benign match: link, never a duplicate
          } else {
            cid = this.id("SC");
            this.customers.set(cid, { name: p.name ?? null, phone: p.phone ?? null });
            isNew = true;
          }
        }
        let aid: string | null = null;
        if (p.address && !p.address.id) {
          aid = this.id("SA");
          this.addresses.set(aid, { customer_id: cid, street: p.address.street ?? null });
        }
        const result = { customer_id: cid, address_id: aid, is_new: isNew };
        this.submissions.set(a.clientOpId, { type: "customer", fp: "", actor, result });
        return result;
      },
      moveTableV2: async ({ payload: p }) => {
        await rec("move_v2", p);
        const fp = stable({ ...p, client_op_id: undefined });
        const s = this.submissions.get(p.client_op_id);
        if (s) {
          if (s.actor !== actor) throw posErr("CROSS_ACTOR_REPLAY_REJECTED", "This operation id belongs to another operator");
          if (s.fp !== fp) throw posErr("IDEMPOTENCY_PAYLOAD_MISMATCH");
          return { ...s.result, idempotent: true } as never;
        }
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
        const result = { ok: true, orders_moved: src.length, order_ids: src.map((o) => o.id), table_versions: { [p.from_table_id]: this.bump(p.from_table_id), [p.to_table_id]: this.bump(p.to_table_id) } };
        this.submissions.set(p.client_op_id, { type: "move", fp, actor, result });
        return { ...result, idempotent: false };
      },
      mergeTablesV4: async ({ payload: p }) => {
        await rec("merge_v4", p);
        const fp = stable({ ...p, client_op_id: undefined });
        const s = this.submissions.get(p.client_op_id);
        if (s) {
          if (s.actor !== actor) throw posErr("CROSS_ACTOR_REPLAY_REJECTED", "This operation id belongs to another operator");
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
          bills.set(t, open[0]);
        }
        const prim = bills.get(p.primary_table_id)!;
        for (const sId of p.source_table_ids) {
          const o = bills.get(sId)!;
          const batch = prim.items.reduce((m, i) => Math.max(m, i.batch), 0) + 1;
          const moving = o.items.filter((i) => i.paid_qty === 0 && !i.void);
          o.items = o.items.filter((i) => i.paid_qty > 0);
          for (const i of moving) prim.items.push({ ...i, batch });
          o.status = "voided";
          o.merged_into = prim.id;
          this.tables.get(sId)!.status = "available";
        }
        const result = { ok: true, merge_id: this.id("MG"), primary_order_id: prim.id, sources_merged: p.source_table_ids.length, pos_entity_version: 9, table_versions: Object.fromEntries(all.map((t) => [t, this.bump(t)])) };
        this.submissions.set(p.client_op_id, { type: "merge", fp, actor, result });
        return { ...result, idempotent: false };
      },
    };
    return d as PosTxnSyncDeps;
  }

  // --- an ONLINE terminal's actions: it reads the fresh server bill, then calls the same RPC contract (pinned) ---
  async onlinePay(actor: string, table: string, method = "cash"): Promise<string> {
    const open = this.openOn(table);
    if (open.length === 0) return "nothing to pay";
    const due = open.reduce((s, o) => s + this.total(o) - this.paidP(o), 0);
    try {
      await this.deps(actor).payTable({ tableId: table, method, currency: "LBP", clientOpId: uuid(), expectedOrderIds: open.map((o) => o.id), expectedAmount: due });
      return "paid";
    } catch (e) { return (e as Error).message; }
  }
  async onlineRound(actor: string, shift: string, table: string, items: { menu_item_id: string; qty: number }[]): Promise<string> {
    try {
      const r = await this.deps(actor).submitRound({ branch_id: "b1", order_type: "dine_in", status: "sent_to_kitchen", table_id: table, shift_id: shift, client_op_id: uuid(), items: items.map((i) => ({ menu_item_id: i.menu_item_id, name: this.menu[i.menu_item_id].name, base_price: this.menu[i.menu_item_id].price, quantity: i.qty, modifiers: [] })) } as never);
      return r.appended ? "appended" : "new bill";
    } catch (e) { return (e as Error).message; }
  }

  // --- canonical read models (what a terminal's online refresh caches) ---
  mapRow(id: string): TableSummary {
    const open = this.openOn(id);
    const total = open.reduce((s, o) => s + this.total(o), 0);
    const collected = open.reduce((s, o) => s + this.paidP(o), 0);
    return row(id, open.length > 0 ? { orders: open.length, occupied: true, status: "occupied", total, collected, outstanding: total - collected, order_number: open[0].id, pos_entity_version: this.tables.get(id)!.version } : { pos_entity_version: this.tables.get(id)!.version });
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
}

const row = (id: string, over: Partial<TableSummary> = {}): TableSummary =>
  ({ id, name: id, seats: 4, occupied: false, status: "available", canonical: true, configured: true, sort_order: 1, orders: 0, order_number: null, opened_at: null, total: null, collected: null, outstanding: null, currency: "LBP", mixed_currency: false, pos_entity_version: 1, ...over }) as TableSummary;

// ================================================================ terminal-side helpers (the real capture paths)

/** The terminal caches the server bill + map row while it is still online (what the DineIn screen keeps offline). */
async function cacheView(t: Terminal, srv: FakeServer, table: string) {
  await use(t);
  const b = srv.bill(table);
  if (b) await cacheBill(table, b, "t1", "b1", MAP_AT);
  return srv.mapRow(table);
}
/** Offline: a round on a table — a NEW session, or one continuing (bound to) the cached canonical bill. */
async function offlineRound(t: Terminal, table: string, lines: { menu_item_id: string; qty: number; price?: number }[], boundTo: string | null = null) {
  await use(t);
  let d = await getDineDraftForTable(t.scope(), table);
  if (!d) d = await openTableOffline({ scope: t.dscope(), tableId: table, tableName: table, seats: 4, currency: "LBP", canonicalOrderId: boundTo });
  for (const l of lines) await addDraftLine(d.local_session_id, { menu_item_id: l.menu_item_id, name: MENU[l.menu_item_id].name, base_price: l.price ?? MENU[l.menu_item_id].price, quantity: l.qty, modifiers: [], kitchen_note: null });
  const out = await sendRoundOffline(d.local_session_id);
  await tick();
  return out;
}
/** Offline: settle the table exactly as DineInWorkspace does (operational bill → R_local pin → capture). */
async function offlineSettle(t: Terminal, mapRow: TableSummary) {
  await use(t);
  const p = await getOperationalTableBill(t.scope(), mapRow, undefined, undefined, MAP_AT);
  const amount = offlineSettleAmount(p, serverDeductsPriorPayments());
  assert.ok(amount.ok, `settle capturable: ${amount.ok ? "" : amount.reason}`);
  const draft = await getDineDraftForTable(t.scope(), mapRow.id);
  const canonicalIds = p.orders.filter((o) => o.orderLocal == null).map((o) => o.orderId).filter((x): x is string => !!x);
  const s = await settleTableOffline({
    sessionId: draft ? draft.local_session_id : null,
    table: canonicalIds.length > 0 ? { scope: t.dscope(), tableId: mapRow.id, tableName: mapRow.name, currency: "LBP", orderIds: canonicalIds } : undefined,
    method: "cash",
    covers: { orderIds: canonicalIds, summary: p.summaryOnly },
    extraDependencyIds: p.pendingMutationOpIds,
    expectedAmount: amount.ok ? amount.exactAmount : null,
  });
  await tick();
  return { ...s, amount: amount.ok ? amount.exactAmount : null };
}
async function offlineOnAccount(t: Terminal, mapRow: TableSummary, customerId: string) {
  await use(t);
  const p = await getOperationalTableBill(t.scope(), mapRow, undefined, undefined, MAP_AT);
  const amount = offlineSettleAmount(p, serverDeductsPriorPayments());
  assert.ok(amount.ok);
  const draft = await getDineDraftForTable(t.scope(), mapRow.id);
  const canonicalIds = p.orders.filter((o) => o.orderLocal == null).map((o) => o.orderId).filter((x): x is string => !!x);
  const s = await tableOnAccountOffline({
    sessionId: draft ? draft.local_session_id : null,
    table: canonicalIds.length > 0 ? { scope: t.dscope(), tableId: mapRow.id, tableName: mapRow.name, currency: "LBP", orderIds: canonicalIds } : undefined,
    customerId, amount: 0, method: "cash",
    covers: { orderIds: canonicalIds, summary: p.summaryOnly },
    extraDependencyIds: p.pendingMutationOpIds,
    expectedAmount: amount.ok ? amount.exactAmount : null,
  });
  await tick();
  return s;
}

async function drain(t: Terminal, srv: FakeServer) {
  await use(t);
  return drainOffline({ ...t.scope(), online: true }, "reconnect", srv.deps(t.cashier));
}
const opsOf = async (t: Terminal) => { await use(t); return localdb.operations.toArray(); };
const opById = async (t: Terminal, id: string) => { await use(t); return (await localdb.operations.get(id)) as OfflineOperation; };

/** Every op settled (synced / needs_attention with a NAMED code); a dependency_failed op names a parked prerequisite. */
async function assertSettledQueue(t: Terminal, label: string) {
  const ops = await opsOf(t);
  const summary = summarize(ops);
  for (const o of ops) {
    assert.ok(o.status === "synced" || o.status === "needs_attention", `${label}: ${t.name} ${o.operation_type} ended ${o.status} (${o.last_error_code}) — ${summary}`);
    if (o.status === "needs_attention") {
      assert.ok(o.last_error_code, `${label}: ${o.operation_type} parked with a named reason`);
      if (o.last_error_code === "dependency_failed") {
        const prereqs = ops.filter((x) => o.dependency_ids.includes(x.operation_id) || (x.local_entity_id != null && o.depends_on_local_entities.includes(x.local_entity_id)));
        assert.ok(prereqs.some((x) => x.status === "needs_attention"), `${label}: ${o.operation_type} parked behind a parked prerequisite — ${summary}`);
      }
    }
  }
}
const summarize = (ops: OfflineOperation[]) => ops.map((o) => `${o.operation_type}=${o.status === "needs_attention" ? o.last_error_code : o.status}`).join(", ");

/** The server-side money / stock invariants (any interleaving). */
function assertServerInvariants(srv: FakeServer, label: string) {
  // no duplicate effect per client_op_id: one order created per op, one demand entry per op, one payment per (op, order)
  const created = [...srv.orders.values()].map((o) => o.created_by_op).filter((x): x is string => !!x);
  assert.equal(new Set(created).size, created.length, `${label}: no duplicate order`);
  const dem = srv.demand.map((x) => x.op);
  assert.equal(new Set(dem).size, dem.length, `${label}: no duplicate inventory demand`);
  const live = [...srv.orders.values()].reduce((s, o) => s + srv.live(o).reduce((q, i) => q + i.qty, 0), 0);
  assert.equal(srv.demand.reduce((s, x) => s + x.qty, 0), live, `${label}: inventory demand = items on the books`);
  const pk = srv.payments.map((p) => `${p.op}|${p.order_id}`);
  assert.equal(new Set(pk).size, pk.length, `${label}: no double payment by one operation`);
  const rk = srv.receivables.map((r) => r.order_id);
  assert.equal(new Set(rk).size, rk.length, `${label}: no duplicate receivable`);
  for (const o of srv.orders.values()) {
    if (o.status === "voided") {
      assert.equal(srv.payments.filter((p) => p.order_id === o.id).length, 0, `${label}: a merged-away / voided bill holds no money`);
      continue;
    }
    const paid = srv.payments.filter((p) => p.order_id === o.id).reduce((s, p) => s + p.amount, 0);
    const recv = srv.receivables.filter((r) => r.order_id === o.id).reduce((s, r) => s + r.amount, 0);
    const T = srv.total(o);
    assert.ok(paid + recv <= T + 0.005, `${label}: ${o.id} collected ${paid}+${recv} ≤ T ${T} (no over-collection)`);
    if (o.status === "completed") assert.ok(Math.abs(paid + recv - T) < 0.005, `${label}: ${o.id} closed for exactly T (${paid}+${recv} vs ${T})`);
    else assert.ok(Math.abs(paid - srv.paidP(o)) < 0.005, `${label}: ${o.id} open, collected = paid legs; remaining ${T - paid} still collectible`);
    // no hidden re-attachment: an order lives on its creator's own shift
    assert.equal(srv.shifts.get(o.shift_id)?.cashier, o.creator, `${label}: ${o.id} on its creator's shift`);
  }
}

/** The second reconnect of every terminal: zero calls, zero server effects, the op logs unchanged. */
async function secondReconnectIsZero(srv: FakeServer, terminals: Terminal[], label: string) {
  srv.hook = null;
  const before = srv.state();
  const n = srv.calls.length;
  for (const t of terminals) {
    const opsBefore = stable(await opsOf(t));
    for (let i = 0; i < 2; i++) {
      const r = await drain(t, srv);
      assert.equal(r.drained.length, 0, `${label}: ${t.name} replays nothing again`);
    }
    assert.equal(stable(await opsOf(t)), opsBefore, `${label}: ${t.name} op log unchanged`);
  }
  assert.deepEqual(srv.calls.slice(n).map((c) => `${c.actor}:${c.name}`), [], `${label}: zero calls on the second reconnect`);
  assert.equal(srv.state(), before, `${label}: zero additional effects`);
}

/** Exhaustive deterministic interleavings: the remote action lands before each of the victim's server calls, or after
 *  all of them. `run(k)` builds the whole world from scratch, so every k is independent and reproducible. */
async function everyInterleaving(name: string, run: (k: number, label: string) => Promise<{ victimCalls: number }>) {
  const base = await run(Number.POSITIVE_INFINITY, `${name}@none`);
  for (let k = 0; k <= base.victimCalls; k++) await run(k, `${name}@${k}`);
  return base.victimCalls;
}
/** Wire the remote action into the victim's next drain; if it never fired during the drain, it lands right after. */
function arm(srv: FakeServer, victim: Terminal, k: number, fn: () => Promise<void>) {
  srv.hook = { victim: victim.cashier, at: k, fn, fired: false, n: 0 };
}
async function drainArmed(t: Terminal, srv: FakeServer) {
  const r = await drain(t, srv);
  const h = srv.hook;
  if (h && !h.fired && Number.isFinite(h.at)) {
    h.fired = true;
    await h.fn();
  }
  return { r, victimCalls: h ? h.n : 0 };
}
async function reset() {
  active = null;
  for (const tb of localdb.tables) await tb.clear();
  __resetDrainLockForTests();
}
const codeOf = (o: OfflineOperation | undefined) => (!o ? "missing" : o.status === "needs_attention" ? `${o.status}:${o.last_error_code ?? ""}` : o.status);
const UA = "uA";
const UB = "uB";

// ================================================================ S1 — both terminals add rounds to the same table

test("S1 both terminals add rounds to the same bill (B online at every point of A's replay, then B's own offline round): one bill, every round once, versions monotonic", async () => {
  await everyInterleaving("S1", async (k, label) => {
    await reset();
    const srv = new FakeServer(["T1"], [["SH-A", UA], ["SH-B", UB]]);
    const A = new Terminal("A", UA, "SH-A");
    const B = new Terminal("B", UB, "SH-B");
    const O1 = srv.seedOrder("T1", [{ menu_item_id: "mP", qty: 1 }], UA, "SH-A");
    await cacheView(A, srv, "T1");
    await cacheView(B, srv, "T1");
    await offlineRound(A, "T1", [{ menu_item_id: "mC", qty: 2 }], O1.id);
    await offlineRound(A, "T1", [{ menu_item_id: "mF", qty: 1 }]); // round 2 of the same session
    await offlineRound(B, "T1", [{ menu_item_id: "mS", qty: 1 }], O1.id);
    let online = "";
    arm(srv, A, k, async () => { online = await srv.onlineRound(UB, "SH-B", "T1", [{ menu_item_id: "mC", qty: 1 }]); });
    const { victimCalls } = await drainArmed(A, srv);
    if (Number.isFinite(k)) assert.equal(online, "appended", `${label}: B's online round appends to the one bill`);
    await drain(B, srv);
    const open = srv.openOn("T1");
    assert.deepEqual(open.map((o) => o.id), [O1.id], `${label}: one bill on the table`);
    assert.equal(srv.orders.size, 1, `${label}: no second order`);
    const batches = O1.items.map((i) => i.batch);
    assert.deepEqual(batches, [...batches].sort((a, b) => a - b), `${label}: batch numbers monotonic`);
    assert.equal(new Set(batches).size, Number.isFinite(k) ? 5 : 4, `${label}: one batch per round`);
    assert.equal(srv.live(O1).reduce((s, i) => s + i.qty, 0), 1 + 2 + 1 + 1 + (Number.isFinite(k) ? 1 : 0), `${label}: every round once`);
    assertServerInvariants(srv, label);
    await assertSettledQueue(A, label);
    await assertSettledQueue(B, label);
    assert.ok((await opsOf(A)).every((o) => o.status === "synced"), `${label}: A all synced`);
    assert.ok((await opsOf(B)).every((o) => o.status === "synced"), `${label}: B all synced`);
    await secondReconnectIsZero(srv, [A, B], label);
    return { victimCalls };
  });
});

// ================================================================ S2 / S4 — remote payment / remote close of the bill A holds offline work for

test("S2 remote payment: B pays the bill while A holds an offline round + settle for it — never a silent append to a paid bill, never a second charge", async () => {
  await everyInterleaving("S2", async (k, label) => {
    await reset();
    const srv = new FakeServer(["T1"], [["SH-A", UA], ["SH-B", UB]]);
    const A = new Terminal("A", UA, "SH-A");
    const O1 = srv.seedOrder("T1", [{ menu_item_id: "mP", qty: 2 }], UA, "SH-A");
    const map = await cacheView(A, srv, "T1");
    const r = await offlineRound(A, "T1", [{ menu_item_id: "mC", qty: 1 }], O1.id);
    const s = await offlineSettle(A, map);
    assert.equal(s.amount, 210, "A collected T_local = 200 + 10");
    let remote = "";
    arm(srv, A, k, async () => { remote = await srv.onlinePay(UB, "T1"); });
    const { victimCalls } = await drainArmed(A, srv);
    const round = (await opsOf(A)).find((o) => o.operation_type === "dinein_send_round")!;
    const settle = await opById(A, s.operationId);
    const sales = srv.payments.filter((p) => p.kind === "sale");
    assert.equal(sales.length, 1, `${label}: exactly one payment of the bill (${remote})`);
    assert.equal(srv.orders.size, 1, `${label}: no new order from a stale round`);
    // A's calls: 0 open_table (adopt), 1 round (pinned to O1), 2 pay_table (pinned [O1] + 210)
    if (k <= 1) {
      assert.equal(codeOf(round), "needs_attention:expected_order_mismatch", `${label}: stale round refused`);
      assert.equal(classifyOperation(round).category, "STALE_BILL_ROUND");
      assert.equal(codeOf(settle), "needs_attention:dependency_failed", `${label}: the settle parks behind it`);
      assert.deepEqual([sales[0].actor, sales[0].amount], [UB, 200], `${label}: B collected the bill it saw`);
    } else if (k === 2) {
      assert.equal(round.status, "synced");
      assert.equal(codeOf(settle), "needs_attention:already_settled", `${label}: A's settle refused — B already paid the bill incl. A's round`);
      assert.deepEqual([sales[0].actor, sales[0].amount], [UB, 210]);
    } else {
      assert.equal(codeOf(settle), "synced", `${label}: A paid first`);
      assert.deepEqual([sales[0].actor, sales[0].amount], [UA, 210]);
      if (Number.isFinite(k)) assert.equal(remote, "nothing to pay", `${label}: B's fresh read shows the table free`);
    }
    void r;
    assertServerInvariants(srv, label);
    await assertSettledQueue(A, label);
    await secondReconnectIsZero(srv, [A], label);
    return { victimCalls };
  });
});

test("S4 remote close (on account): B puts the bill on a customer account while A holds an offline settle — one settlement, never payment + receivable", async () => {
  await everyInterleaving("S4", async (k, label) => {
    await reset();
    const srv = new FakeServer(["T1"], [["SH-A", UA], ["SH-B", UB]]);
    srv.customers.set("SC-1", { name: "Acc", phone: null });
    const A = new Terminal("A", UA, "SH-A");
    srv.seedOrder("T1", [{ menu_item_id: "mP", qty: 1 }], UA, "SH-A");
    const map = await cacheView(A, srv, "T1");
    const s = await offlineSettle(A, map);
    arm(srv, A, k, async () => {
      const open = srv.openOn("T1");
      if (open.length === 0) return;
      await srv.deps(UB).onAccountTable({ tableId: "T1", customerId: "SC-1", amount: 0, method: "cash", clientOpId: uuid(), expectedOrderIds: open.map((o) => o.id), expectedAmount: 100 }).catch(() => undefined);
    });
    const { victimCalls } = await drainArmed(A, srv);
    const settle = await opById(A, s.operationId);
    assert.equal(srv.payments.length + srv.receivables.length, 1, `${label}: exactly one settlement`);
    if (k === 0) assert.equal(codeOf(settle), "needs_attention:pay_bill_changed", `${label}: A's settle refused, the bill closed elsewhere`);
    else assert.equal(codeOf(settle), "synced");
    assertServerInvariants(srv, label);
    await assertSettledQueue(A, label);
    await secondReconnectIsZero(srv, [A], label);
    return { victimCalls };
  });
});

// ================================================================ S3 / S11-split — remote partial payment

test("S3 remote partial payment: B takes a split leg while A holds an offline full settle — A's stale amount is refused, the remainder stays collectible; no double charge", async () => {
  await everyInterleaving("S3", async (k, label) => {
    await reset();
    const srv = new FakeServer(["T1"], [["SH-A", UA], ["SH-B", UB]]);
    const A = new Terminal("A", UA, "SH-A");
    const O1 = srv.seedOrder("T1", [{ menu_item_id: "mP", qty: 1 }, { menu_item_id: "mF", qty: 1 }], UA, "SH-A");
    const map = await cacheView(A, srv, "T1");
    const s = await offlineSettle(A, map);
    assert.equal(s.amount, 150);
    let remote = "";
    arm(srv, A, k, async () => {
      remote = await srv.deps(UB).splitSettle({ orderId: O1.id, method: "card", currency: "LBP", allocations: [{ order_item_id: O1.items[0].id, quantity: 1 }], expectedVersion: null, clientOpId: uuid() }).then(() => "split", (e: Error) => e.message);
    });
    const { victimCalls } = await drainArmed(A, srv);
    const settle = await opById(A, s.operationId);
    const total = srv.payments.reduce((x, p) => x + p.amount, 0);
    assert.ok(total <= 150 + 0.005, `${label}: never more than T collected (${total})`);
    if (k === 0) {
      assert.equal(codeOf(settle), "needs_attention:pay_amount_changed", `${label}: A's T is stale (R is now 50)`);
      assert.deepEqual(srv.payments.map((p) => [p.kind, p.amount]), [["split", 100]]);
      assert.equal(srv.total(O1) - srv.paidP(O1), 50, `${label}: R = 50 still collectible on the open bill`);
    } else {
      assert.equal(codeOf(settle), "synced");
      if (Number.isFinite(k)) assert.match(remote, /not an open, unpaid/, `${label}: B's leg refused once A closed it`);
      assert.deepEqual(srv.payments.map((p) => [p.kind, p.amount]), [["sale", 150]]);
    }
    assertServerInvariants(srv, label);
    await assertSettledQueue(A, label);
    await secondReconnectIsZero(srv, [A], label);
    return { victimCalls };
  });
});

// ================================================================ S5 / S6 — remote Move / Merge

test("S5 remote Move: B moves A's table while A holds an offline round + settle pinned to it — refused by bill pins; nothing lands on the wrong table", async () => {
  await everyInterleaving("S5", async (k, label) => {
    await reset();
    const srv = new FakeServer(["T1", "T5"], [["SH-A", UA], ["SH-B", UB]]);
    const A = new Terminal("A", UA, "SH-A");
    const O1 = srv.seedOrder("T1", [{ menu_item_id: "mP", qty: 1 }], UA, "SH-A");
    const map = await cacheView(A, srv, "T1");
    await offlineRound(A, "T1", [{ menu_item_id: "mC", qty: 1 }], O1.id);
    const s = await offlineSettle(A, map);
    let moved = false;
    arm(srv, A, k, async () => {
      const open = srv.openOn("T1");
      if (open.length === 0) return;
      await srv.deps(UB).moveTableV2({ payload: { client_op_id: uuid(), from_table_id: "T1", to_table_id: "T5", expected_order_ids: open.map((o) => o.id) } }).then(() => { moved = true; }, () => undefined);
    });
    const { victimCalls } = await drainArmed(A, srv);
    const ops = await opsOf(A);
    const round = ops.find((o) => o.operation_type === "dinein_send_round")!;
    const settle = ops.find((o) => o.operation_id === s.operationId)!;
    assert.equal(srv.orders.size, 1, `${label}: never a second order on T1`);
    if (moved) {
      assert.equal(O1.table_id, "T5");
      assert.equal(srv.payments.length, 0, `${label}: the moved bill is not paid by a settle captured for T1`);
      assert.ok(settle.status === "needs_attention", `${label}: settle refused/parked (${codeOf(settle)})`);
      if (k <= 1) {
        assert.equal(codeOf(round), "needs_attention:expected_order_mismatch", `${label}: the round never lands on the empty source table`);
        assert.equal(codeOf(settle), "needs_attention:dependency_failed");
      } else assert.equal(codeOf(settle), "needs_attention:pay_bill_changed");
    } else {
      assert.equal(codeOf(settle), "synced", `${label}: A settled before the move; B had nothing to move`);
      assert.equal(srv.payments.length, 1);
    }
    assertServerInvariants(srv, label);
    await assertSettledQueue(A, label);
    await secondReconnectIsZero(srv, [A], label);
    return { victimCalls };
  });
});

test("S6 remote Merge: B merges A's table into another bill while A holds an offline round + settle — refused; the merged bill carries every item once", async () => {
  await everyInterleaving("S6", async (k, label) => {
    await reset();
    const srv = new FakeServer(["T1", "T6"], [["SH-A", UA], ["SH-B", UB]]);
    const A = new Terminal("A", UA, "SH-A");
    const O1 = srv.seedOrder("T1", [{ menu_item_id: "mP", qty: 1 }], UA, "SH-A");
    const O6 = srv.seedOrder("T6", [{ menu_item_id: "mS", qty: 1 }], UB, "SH-B");
    const map = await cacheView(A, srv, "T1");
    await offlineRound(A, "T1", [{ menu_item_id: "mC", qty: 1 }], O1.id);
    const s = await offlineSettle(A, map);
    let merged = false;
    arm(srv, A, k, async () => {
      const src = srv.openOn("T1");
      if (src.length !== 1) return;
      await srv.deps(UB).mergeTablesV4({ payload: { client_op_id: uuid(), primary_table_id: "T6", source_table_ids: ["T1"], expected_orders: { T6: O6.id, T1: src[0].id } } }).then(() => { merged = true; }, () => undefined);
    });
    const { victimCalls } = await drainArmed(A, srv);
    const settle = await opById(A, s.operationId);
    if (merged) {
      assert.equal(O1.status, "voided");
      assert.ok(settle.status === "needs_attention", `${label}: A's settle never pays the merged bill (${codeOf(settle)})`);
      assert.equal(srv.payments.length, 0);
      const roundLanded = k > 1;
      assert.equal(srv.live(O6).reduce((q, i) => q + i.qty, 0), 1 + 1 + (roundLanded ? 1 : 0), `${label}: merged bill = its items + T1's, once`);
    } else assert.equal(codeOf(settle), "synced");
    assertServerInvariants(srv, label);
    await assertSettledQueue(A, label);
    await secondReconnectIsZero(srv, [A], label);
    return { victimCalls };
  });
});

// ================================================================ S7 — destination becomes occupied

test("S7 destination occupied: A moves offline to T7 while B opens T7 online — MOVE_DEST_OCCUPIED, A's bill stays put, B's bill intact", async () => {
  await everyInterleaving("S7", async (k, label) => {
    await reset();
    const srv = new FakeServer(["T1", "T7"], [["SH-A", UA], ["SH-B", UB]]);
    const A = new Terminal("A", UA, "SH-A");
    const O1 = srv.seedOrder("T1", [{ menu_item_id: "mP", qty: 1 }], UA, "SH-A");
    await cacheView(A, srv, "T1");
    const cap = await captureMoveTableOffline({ scope: A.scope(), from: srv.mapRow("T1"), to: srv.mapRow("T7"), mapLoadedAt: MAP_AT });
    assert.ok(cap.ok);
    let remote = "";
    arm(srv, A, k, async () => { remote = await srv.onlineRound(UB, "SH-B", "T7", [{ menu_item_id: "mF", qty: 1 }]); });
    const { victimCalls } = await drainArmed(A, srv);
    const mv = await opById(A, cap.ok ? cap.operationId : "");
    if (k === 0) {
      assert.equal(codeOf(mv), "needs_attention:move_dest_occupied");
      assert.equal(O1.table_id, "T1", `${label}: A's bill stays on T1`);
      assert.equal(remote, "new bill");
      assert.equal(srv.openOn("T7").length, 1, `${label}: B's bill intact on T7`);
    } else {
      assert.equal(codeOf(mv), "synced");
      if (Number.isFinite(k)) assert.equal(remote, "appended", `${label}: B's fresh map shows T7 occupied by the moved bill — B adds to it`);
    }
    assertServerInvariants(srv, label);
    await assertSettledQueue(A, label);
    await secondReconnectIsZero(srv, [A], label);
    return { victimCalls };
  });
});

// ================================================================ S8 / S9 — shift closes / opens elsewhere

test("S8 shift closed elsewhere: a supervisor force-ends A's shift during A's replay — shift_closed conflict, dependents parked, never re-attached to another shift", async () => {
  await everyInterleaving("S8", async (k, label) => {
    await reset();
    const srv = new FakeServer(["T2"], [["SH-A", UA], ["SH-B", UB]]);
    const A = new Terminal("A", UA, "SH-A");
    await use(A);
    await offlineRound(A, "T2", [{ menu_item_id: "mP", qty: 1 }]);
    const s = await offlineSettle(A, row("T2"));
    arm(srv, A, k, async () => { srv.shifts.get("SH-A")!.status = "closed"; });
    const { victimCalls } = await drainArmed(A, srv);
    const ops = await opsOf(A);
    const round = ops.find((o) => o.operation_type === "dinein_send_round")!;
    const settle = ops.find((o) => o.operation_id === s.operationId)!;
    if (k <= 1) {
      // closed before the round created the order (k=0: before open_table; k=1: before the round)
      assert.equal(codeOf(round), "needs_attention:shift_closed", `${label}: round refused`);
      assert.equal(codeOf(settle), "needs_attention:dependency_failed");
      assert.equal(srv.orders.size, 0, `${label}: no order on any shift`);
    } else if (k === 2) {
      assert.equal(codeOf(settle), "needs_attention:shift_closed", `${label}: the order's shift closed before the pay`);
      assert.equal(srv.payments.length, 0);
      assert.equal(srv.openOn("T2").length, 1, `${label}: the bill stays open and collectible (for a manager)`);
    } else assert.equal(codeOf(settle), "synced");
    assert.equal([...srv.orders.values()].filter((o) => o.shift_id !== "SH-A").length, 0, `${label}: never re-attached to another shift`);
    assertServerInvariants(srv, label);
    await assertSettledQueue(A, label);
    await secondReconnectIsZero(srv, [A], label);
    return { victimCalls };
  });
});

test("S9 shift opened elsewhere: A closes shift N and opens N+1 offline while the SAME cashier opens a shift on another terminal — N+1 fails closed, its sales never join the other drawer", async () => {
  await everyInterleaving("S9", async (k, label) => {
    await reset();
    const srv = new FakeServer(["T3"], [["SH-A", UA]]);
    const A = new Terminal("A", UA, "SH-A");
    await use(A);
    const end = await captureEndShiftOffline({ scope: A.scope(), shiftId: "SH-A", shiftLocal: null, actualCashCounted: 0, notes: null, shiftOpenedAt: new Date(MAP_AT).toISOString() });
    await tick();
    const ps = await createLocalPendingShift({ tenantId: "t1", branchId: "b1", cashierUserId: UA, openingCashAmount: 0, currency: "LBP", afterEndOpId: end.operationId });
    A.shiftId = ps.local_shift_id;
    await offlineRound(A, "T3", [{ menu_item_id: "mF", qty: 2 }]);
    let other: string | null = null;
    arm(srv, A, k, async () => {
      const r = await srv.deps(UA).openShift({ branchId: "b1", openingCash: 0, clientOpId: uuid() });
      other = r.shiftId;
    });
    const { victimCalls } = await drainArmed(A, srv);
    const ops = await opsOf(A);
    const open = ops.find((o) => o.operation_type === "open_shift")!;
    const endOp = ops.find((o) => o.operation_id === end.operationId)!;
    assert.equal(codeOf(endOp), "synced");
    if (other && other !== "SH-A" && k <= 1) {
      // the other terminal opened a NEW shift after N closed and before N+1 replayed
      assert.equal(codeOf(open), "needs_attention:shift_already_open", `${label}: N+1 refused, not adopted`);
      assert.equal(srv.orders.size, 0, `${label}: N+1's sales stay queued, never on the other drawer`);
      assert.equal(codeOf(ops.find((o) => o.operation_type === "dinein_send_round")), "needs_attention:dependency_failed", `${label}: N+1's sale parked — ${summarize(ops)}`);
      // (residual, no money / stock effect: the session's open_table op has no shift dependency, so it syncs and the
      // table shows occupied with no bill until the parked sale is resolved — see the CONC report)
      assert.equal(srv.openOn("T3").length, 0, `${label}: no bill on the table`);
    } else {
      assert.equal(codeOf(open), "synced");
      const mine = (open.canonical_entity_id ?? "") as string;
      assert.ok([...srv.orders.values()].every((o) => o.shift_id === mine), `${label}: A's sale is on A's own N+1`);
      // before A's close the other terminal adopts N (then sees it closed); after N+1 opened it adopts N+1 — the
      // cashier's ONE drawer. It never creates a second open shift for the same cashier.
      if (other) assert.ok(other === "SH-A" || other === mine, `${label}: the other terminal adopted the cashier's one open shift (${other})`);
      assert.equal([...srv.shifts.values()].filter((s) => s.cashier === UA && s.status === "open").length, 1, `${label}: one open shift per cashier`);
    }
    assertServerInvariants(srv, label);
    await assertSettledQueue(A, label);
    await secondReconnectIsZero(srv, [A], label);
    return { victimCalls };
  });
});

// ================================================================ S10 — customer / account change

test("S10a customer identity: A creates a customer offline while B creates the same phone online — a different name conflicts (no duplicate), a compatible one links", async () => {
  for (const bName of ["Rami", "rana"]) {
    await everyInterleaving(`S10a(${bName})`, async (k, label) => {
      await reset();
      const srv = new FakeServer([], [["SH-A", UA], ["SH-B", UB]]);
      const A = new Terminal("A", UA, "SH-A");
      await use(A);
      const cust = await captureCustomerUpsertOffline({ scope: A.scope(), upsert: { branch_id: "b1", name: "Rana", phone: "70000002", address: { street: "Hamra" } }, clientOpId: uuid() });
      await tick();
      const cop = uuid();
      const txn = {
        local_txn_id: "DL-1", client_op_id: cop, tenant_id: "t1", branch_id: "b1", device_id: A.dev!.device_id, terminal_id: A.dev!.terminal_id, cashier_user_id: UA, cashier_user_name: "A", shift_id: "SH-A",
        created_at: new Date().toISOString(),
        order_payload: { branch_id: "b1", order_type: "delivery", status: "sent_to_kitchen", shift_id: "SH-A", client_op_id: cop, notes: null, customer_id: cust.localCustomerId, address_id: cust.localAddressId, delivery_fee: 0, items: [{ menu_item_id: "mS", name: "Shawarma", base_price: 300, quantity: 1, kitchen_note: null, modifiers: [] }] },
        payment_intent: null, sent_to_kitchen: true, currency: "LBP", total: 300, status: "queued", attempts: 0, customer_local: cust.localCustomerId, address_local: cust.localAddressId,
      } as unknown as PosOfflineTxn;
      await localdb.posOfflineTxns.add(txn);
      await tick();
      arm(srv, A, k, async () => {
        await srv.deps(UB).upsertCustomer({ payload: { branch_id: "b1", name: bName, phone: "70000002" }, clientOpId: uuid() }).catch(() => undefined);
      });
      const { victimCalls } = await drainArmed(A, srv);
      const ops = await opsOf(A);
      const cOp = ops.find((o) => o.operation_type === "customer_upsert")!;
      assert.equal(srv.customers.size, 1, `${label}: never a duplicate customer`);
      if (k === 0 && bName === "Rami") {
        assert.equal(cOp.status, "needs_attention", `${label}: identity conflict parked (${codeOf(cOp)})`);
        assert.equal(srv.orders.size, 0, `${label}: the order waits for the reviewed customer`);
      } else {
        assert.equal(cOp.status, "synced");
        const [cid] = [...srv.customers.keys()];
        assert.deepEqual([...srv.orders.values()].map((o) => o.customer_id), [cid], `${label}: the order is on the one customer`);
      }
      assertServerInvariants(srv, label);
      await assertSettledQueue(A, label);
      await secondReconnectIsZero(srv, [A], label);
      return { victimCalls };
    });
  }
});

test("S10b account: A puts the bill on account offline while B adds a round online — ON_ACCOUNT_AMOUNT_CHANGED, no receivable for a stale amount, never two receivables", async () => {
  await everyInterleaving("S10b", async (k, label) => {
    await reset();
    const srv = new FakeServer(["T1"], [["SH-A", UA], ["SH-B", UB]]);
    srv.customers.set("SC-1", { name: "Acc", phone: null });
    const A = new Terminal("A", UA, "SH-A");
    const O1 = srv.seedOrder("T1", [{ menu_item_id: "mP", qty: 2 }], UA, "SH-A");
    const map = await cacheView(A, srv, "T1");
    const s = await offlineOnAccount(A, map, "SC-1");
    let remote = "";
    arm(srv, A, k, async () => { remote = await srv.onlineRound(UB, "SH-B", "T1", [{ menu_item_id: "mC", qty: 1 }]); });
    const { victimCalls } = await drainArmed(A, srv);
    const op = await opById(A, s.operationId);
    assert.ok(srv.receivables.length <= 1);
    if (k === 0) {
      assert.equal(codeOf(op), "needs_attention:on_account_amount_changed");
      assert.equal(srv.receivables.length, 0, `${label}: nothing booked for the stale amount`);
      assert.equal(srv.total(O1), 210, `${label}: the bill (with B's round) stays open and collectible`);
    } else {
      assert.equal(codeOf(op), "synced");
      assert.deepEqual(srv.receivables.map((r) => [r.order_id, r.amount]), [[O1.id, 200]]);
      if (Number.isFinite(k)) assert.equal(remote, "new bill", `${label}: B's round after the close starts a new bill, never joins the closed one`);
    }
    assertServerInvariants(srv, label);
    await assertSettledQueue(A, label);
    await secondReconnectIsZero(srv, [A], label);
    return { victimCalls };
  });
});

// ================================================================ S11 — stale price / stale version

test("S11a stale price: the menu price changes (manager on B) during A's replay — PRICE_CHANGED price conflict, nothing written, the settle parks", async () => {
  await everyInterleaving("S11a", async (k, label) => {
    await reset();
    const srv = new FakeServer(["T4"], [["SH-A", UA], ["SH-B", UB]]);
    const A = new Terminal("A", UA, "SH-A");
    await use(A);
    await offlineRound(A, "T4", [{ menu_item_id: "mP", qty: 1 }]);
    const s = await offlineSettle(A, row("T4"));
    arm(srv, A, k, async () => { srv.menu.mP = { name: "Pizza", price: 120 }; });
    const { victimCalls } = await drainArmed(A, srv);
    const ops = await opsOf(A);
    const round = ops.find((o) => o.operation_type === "dinein_send_round")!;
    const settle = ops.find((o) => o.operation_id === s.operationId)!;
    if (k <= 1) {
      assert.equal(codeOf(round), "needs_attention:price_changed");
      assert.equal(classifyOperation(round).category, "PRICE_CONFLICT");
      assert.equal(codeOf(settle), "needs_attention:dependency_failed");
      assert.deepEqual([srv.orders.size, srv.demand.length, srv.payments.length], [0, 0, 0], `${label}: nothing written`);
    } else {
      assert.equal(codeOf(settle), "synced", `${label}: captured and replayed before the change — the captured price stands`);
      assert.deepEqual(srv.payments.map((p) => p.amount), [100]);
    }
    assertServerInvariants(srv, label);
    await assertSettledQueue(A, label);
    await secondReconnectIsZero(srv, [A], label);
    return { victimCalls };
  });
});

test("S11b stale version: A opens a free table offline (version CAS from its map) while B opens it online — VERSION_CONFLICT, A's round parks, B's bill untouched", async () => {
  await everyInterleaving("S11b", async (k, label) => {
    await reset();
    const srv = new FakeServer(["T8"], [["SH-A", UA], ["SH-B", UB]]);
    const A = new Terminal("A", UA, "SH-A");
    await use(A);
    const d = await openTableOffline({ scope: A.dscope(), tableId: "T8", tableName: "T8", seats: 4, currency: "LBP", baseOrderVersion: 1 });
    await addDraftLine(d.local_session_id, { menu_item_id: "mP", name: "Pizza", base_price: 100, quantity: 1, modifiers: [], kitchen_note: null });
    await sendRoundOffline(d.local_session_id);
    await tick();
    let remote = "";
    arm(srv, A, k, async () => {
      await srv.deps(UB).openTable({ branch_id: "b1", name: "T8", seats: 4, client_op_id: uuid(), expected_version: srv.tables.get("T8")!.version }).catch(() => undefined);
      remote = await srv.onlineRound(UB, "SH-B", "T8", [{ menu_item_id: "mC", qty: 1 }]);
    });
    const { victimCalls } = await drainArmed(A, srv);
    const ops = await opsOf(A);
    const open = ops.find((o) => o.operation_type === "dinein_open_table")!;
    if (k === 0) {
      assert.equal(codeOf(open), "needs_attention:version_conflict");
      assert.equal(codeOf(ops.find((o) => o.operation_type === "dinein_send_round")), "needs_attention:dependency_failed");
      assert.deepEqual([...srv.orders.values()].map((o) => o.creator), [UB], `${label}: only B's bill`);
    } else {
      assert.equal(codeOf(open), "synced");
      assert.equal(srv.orders.size, 1, `${label}: one bill (B joins A's) — ${remote}`);
    }
    assertServerInvariants(srv, label);
    await assertSettledQueue(A, label);
    await secondReconnectIsZero(srv, [A], label);
    return { victimCalls };
  });
});

// ================================================================ S12 — the same op replayed from two terminals

test("S12 cross-terminal replay: a restored backup / cloned PC replays A's ops (same or another cashier, before or after A) — exactly-once, no second effect", async () => {
  for (const order of ["A-first", "clone-first"] as const) {
    for (const cloneCashier of [UA, UB]) {
      const label = `S12(${order},${cloneCashier})`;
      await reset();
      const srv = new FakeServer(["T1", "T2", "T9"], [["SH-A", UA], ["SH-B", UB]]);
      const A = new Terminal("A", UA, "SH-A");
      const O1 = srv.seedOrder("T1", [{ menu_item_id: "mP", qty: 1 }], UA, "SH-A");
      const O2 = srv.seedOrder("T2", [{ menu_item_id: "mF", qty: 1 }], UA, "SH-A");
      await cacheView(A, srv, "T1");
      const map2 = await cacheView(A, srv, "T2");
      await offlineRound(A, "T1", [{ menu_item_id: "mC", qty: 2 }], O1.id);
      const mv = await captureMoveTableOffline({ scope: A.scope(), from: srv.mapRow("T1"), to: srv.mapRow("T9"), mapLoadedAt: MAP_AT });
      assert.ok(mv.ok);
      const s2 = await offlineSettle(A, map2);
      const C = await cloneOf(A, "C", cloneCashier);
      const seq = order === "A-first" ? [A, C] : [C, A];
      for (const t of seq) await drain(t, srv);
      for (const t of seq) await drain(t, srv); // and once more each, crossing again
      assert.equal(srv.orders.size, 2, `${label}: no extra order`);
      assert.equal(srv.demand.length, 3, `${label}: the two seeds + A's round, once`);
      assert.equal(srv.live(O1).reduce((s, i) => s + i.qty, 0), 3);
      assert.equal(O1.table_id, "T9", `${label}: moved once`);
      assert.deepEqual(srv.payments.map((p) => [p.order_id, p.amount]), [[O2.id, 50]], `${label}: T2 paid once`);
      assert.equal(srv.count("move_v2"), cloneCashier === UA ? 2 : 1, `${label}: a same-identity clone replays (deduplicated); another sign-in replays nothing`);
      assert.equal(srv.calls.filter((c) => c.actor === UB).length, 0, `${label}: the 5-D scope keeps A's ops off another cashier's session`);
      for (const sub of srv.submissions.values()) assert.equal(sub.actor, UA, `${label}: every effect is attributed to A`);
      assertServerInvariants(srv, label);
      await assertSettledQueue(A, label);
      if (cloneCashier === UA) await assertSettledQueue(C, label);
      await secondReconnectIsZero(srv, [A, C], label);

      // the SERVER guard for a replay that does reach it under another operator (no client scope filter): the move
      // is refused by actor; a settle / round replay returns the recorded result — never a second effect.
      await use(A);
      const sentMove = srv.calls.find((c) => c.name === "move_v2")!.payload as { client_op_id: string };
      const before = srv.state();
      await assert.rejects(srv.deps(UB).moveTableV2({ payload: sentMove as never }), (e: Error & { details?: string }) => /CROSS_ACTOR_REPLAY_REJECTED/.test(String(e.details)));
      const payOp = (await localdb.operations.get(s2.operationId))!;
      const r = await srv.deps(UB).payTable({ tableId: "T2", method: "cash", currency: "LBP", clientOpId: payOp.client_op_id, expectedOrderIds: [O2.id], expectedAmount: 50 });
      assert.equal(r.idempotent, true);
      assert.equal(srv.state(), before, `${label}: foreign replays produced no effect`);
    }
  }
});
