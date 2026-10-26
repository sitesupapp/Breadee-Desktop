// 1.0.38 Workstream G1 — Move / Merge → Pay CHAINS and local SESSION LIFECYCLE TRUTH.
//
// Real Dexie (fake-indexeddb), the REAL capture engines (dineinOffline / tableOpOffline), projection, orchestrator
// and handlers. Only the server RPCs are injected — by a FAKE SERVER modelling the staging contracts the chains
// touch: pos_save_order's table lookup ("the first open dine-in order on the table") + the expected_order_id guard
// (EXPECTED_ORDER_MISMATCH), pos_split_settle's parent_completed, pos_move_table_v2 / pos_merge_tables_v4 pins
// (order ids, paid settlements, versions, request fingerprint), pos_pay_table pins + R = T − P, exactly-once on
// client_op_id. The "other terminal" acts directly on the server state (online pay, remote close, remote round /
// move / open). Every chain ends with a SECOND reconnect that must produce zero calls and zero effects.
//
// The workspace emulation below (sendRoundUI / payUI / splitAllUI / mergeUI / moveUI) follows DineInWorkspace's
// offline branches rule for rule: the session comes from getDineDraftForTable, a new session binds to / chains
// after exactly what the ONE projection says, and every capture reads the RAW cached map rows.

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

import { localdb, cacheBill, cacheTableMap, readCachedTableMap, type DineDraft } from "@/lib/offline/db";
import { getOperation, type OfflineOperation } from "@/lib/offline/operationLog";
import { drainOffline, __resetDrainLockForTests, __setReplayTimeoutForTests } from "@/lib/offline/orchestrator";
import type { PosTxnSyncDeps } from "@/lib/offline/posTxnSync";
import {
  openTableOffline,
  stageUnsentDraftLines,
  sendRoundOffline,
  settleTableOffline,
  splitOperationalBillOffline,
  getDineDraftForTable,
  retireClosedSessions,
  SESSION_CLOSED_MESSAGE,
} from "@/lib/offline/dineinOffline";
import {
  getOperationalTableBill,
  offlineSettleAmount,
  splitCompletesBill,
  sessionClosure,
  scopedOperations,
  settleHeldByRefusedStructural,
} from "@/lib/offline/operationalProjection";
import { captureMoveTableOffline, captureMergeTablesOffline } from "@/lib/offline/tableOpOffline";
import { buildDiagnostic, classifyOperation, STALE_BILL_ROUND_REASON } from "@/lib/offline/queueForensics";
import { displayStateOf } from "@/components/sync/syncCenterModel";
import { serverDeductsPriorPayments } from "@/lib/pos/tablePayment";
import { getDeviceIdentity } from "@/lib/device";
import type { TableBill, TableSummary, BillOrder } from "@/types/tables";

const DEV = getDeviceIdentity();
const SCOPE = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: DEV.device_id, terminalId: DEV.terminal_id ?? null };
const DSCOPE = { ...SCOPE, shiftId: "SRV-SHIFT-1" };
const CTX = { ...SCOPE, online: true };
const tick = () => new Promise((r) => setTimeout(r, 4));

beforeEach(async () => {
  await Promise.all([
    localdb.operations.clear(), localdb.entityMap.clear(), localdb.syncHistory.clear(), localdb.dineDrafts.clear(),
    localdb.snapshots.clear(), localdb.posOfflineTxns.clear(), localdb.pendingShifts.clear(),
  ]);
  __resetDrainLockForTests();
});
afterEach(() => __setReplayTimeoutForTests(45_000));

// ================================================================ the fake server (staging contract model)

type SItem = { id: string; client_line_id: string | null; name: string; price: number; qty: number; paid_qty: number; batch: number };
type SOrder = {
  id: string; number: string; table_id: string; status: "open" | "completed" | "voided"; payment_status: "unpaid" | "partial" | "paid";
  shift_id: string; items: SItem[]; settlements: number; merged_into?: string; seq: number;
};
const posErr = (code: string, msg = code) => Object.assign(new Error(msg), { code: "P0001", details: JSON.stringify({ pos_error_code: code }) });
const sorted = (a: string[]) => [...a].sort();
const stable = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

class FakeServer {
  tables = new Map<string, { version: number; status: "available" | "occupied" }>();
  orders = new Map<string, SOrder>();
  payments: { order_id: string; amount: number; method: string; op: string }[] = [];
  submissions = new Map<string, { type: string; fp: string; result: Record<string, unknown> }>();
  calls: { name: string; payload: unknown }[] = [];
  failNext = new Map<string, unknown>();
  seq = 0;
  num = 0;

  constructor(tables: string[]) {
    for (const t of tables) this.tables.set(t, { version: 1, status: "available" });
  }
  id(p: string) { return `${p}-${++this.seq}`; }
  live(o: SOrder) { return o.items; }
  total(o: SOrder) { return o.items.reduce((s, i) => s + i.price * i.qty, 0); }
  paidP(o: SOrder) { return o.items.reduce((s, i) => s + i.price * i.paid_qty, 0); }
  /** pos_save_order's lookup: the open, not-fully-paid dine-in orders on the table, oldest first. */
  openOn(t: string) { return [...this.orders.values()].filter((o) => o.table_id === t && o.status === "open").sort((a, b) => a.seq - b.seq); }
  bump(t: string) { const r = this.tables.get(t)!; r.version += 1; return r.version; }
  newOrder(table: string): SOrder {
    const o: SOrder = { id: this.id("SO"), number: `261026-${String(++this.num).padStart(4, "0")}`, table_id: table, status: "open", payment_status: "unpaid", shift_id: "SRV-SHIFT-1", items: [], settlements: 0, seq: this.seq };
    this.orders.set(o.id, o);
    this.tables.get(table)!.status = "occupied";
    return o;
  }
  addItems(o: SOrder, items: { name: string; base_price: number; quantity: number; client_line_id?: string }[]) {
    const batch = o.items.reduce((m, i) => Math.max(m, i.batch), 0) + 1;
    for (const it of items) o.items.push({ id: this.id("SI"), client_line_id: it.client_line_id ?? null, name: it.name, price: it.base_price, qty: it.quantity, paid_qty: 0, batch });
  }
  // --- the OTHER terminal / online actions (no op ids from this device) ---
  payOnline(t: string) {
    for (const o of this.openOn(t)) {
      this.payments.push({ order_id: o.id, amount: this.total(o) - this.paidP(o), method: "cash", op: "online" });
      o.status = "completed"; o.payment_status = "paid";
    }
    this.tables.get(t)!.status = "available";
    this.bump(t);
  }
  voidOnline(t: string) {
    for (const o of this.openOn(t)) o.status = "voided";
    this.tables.get(t)!.status = "available";
    this.bump(t);
  }
  roundOnline(t: string, items: { name: string; price: number; qty: number }[]) {
    const o = this.openOn(t)[0] ?? this.newOrder(t);
    this.addItems(o, items.map((i) => ({ name: i.name, base_price: i.price, quantity: i.qty })));
    this.bump(t);
    return o;
  }
  moveOnline(from: string, to: string) {
    for (const o of this.openOn(from)) o.table_id = to;
    this.tables.get(from)!.status = "available";
    this.tables.get(to)!.status = "occupied";
    this.bump(from); this.bump(to);
  }
  state() { return stable({ o: [...this.orders.values()], p: this.payments, t: [...this.tables] }); }
  names() { return this.calls.map((c) => c.name); }
  count(name: string) { return this.calls.filter((c) => c.name === name).length; }
  /** Σ R = T − P over every open bill: the real remaining obligation. */
  obligation() { return [...this.orders.values()].filter((o) => o.status === "open").reduce((s, o) => s + this.total(o) - this.paidP(o), 0); }

  deps(): Partial<PosTxnSyncDeps> {
    const rec = (name: string, payload: unknown) => {
      this.calls.push({ name, payload: JSON.parse(JSON.stringify(payload ?? null)) });
      const f = this.failNext.get(name);
      if (f !== undefined) {
        this.failNext.delete(name);
        throw f;
      }
    };
    const fingerprinted = (op: string, type: string, fp: string) => {
      const s = this.submissions.get(op);
      if (!s) return null;
      if (s.fp !== fp) throw posErr("IDEMPOTENCY_PAYLOAD_MISMATCH");
      return { ...s.result, idempotent: true };
    };
    return {
      isTransport: (e) => e instanceof TypeError,
      hasSession: async () => true,
      openTable: async (p) => {
        rec("open_table", p);
        const hit = this.submissions.get(p.client_op_id);
        if (hit) return hit.result as never;
        const t = this.tables.get(p.name)!;
        if (p.expected_version != null && p.expected_version !== t.version) throw posErr("VERSION_CONFLICT", "VERSION_CONFLICT: table changed");
        t.status = "occupied";
        const result = { table_id: p.name, pos_entity_version: this.bump(p.name) };
        this.submissions.set(p.client_op_id, { type: "open", fp: "", result });
        return result;
      },
      submitRound: async (p) => {
        rec("round", p);
        const op = String(p.client_op_id);
        const hit = this.submissions.get(op);
        if (hit) return { ...(hit.result as never), idempotent: true };
        const open = this.openOn(String(p.table_id));
        // the staging guard: an expected bill that is not THE open bill of the table is refused, nothing written
        if (p.expected_order_id && (open.length === 0 || open[0].id !== p.expected_order_id)) {
          throw posErr("EXPECTED_ORDER_MISMATCH", "EXPECTED_ORDER_MISMATCH: This table's bill changed since it was opened offline and cannot take this round");
        }
        const o = open[0] ?? this.newOrder(String(p.table_id));
        this.addItems(o, p.items as never);
        const result = { order_id: o.id, order_number: o.number, batch_no: o.items.reduce((m, i) => Math.max(m, i.batch), 0), appended: open.length > 0 };
        this.submissions.set(op, { type: "round", fp: "", result });
        return { ...result, idempotent: false };
      },
      orderItemMap: async ({ orderId }) => (this.orders.get(orderId)?.items ?? []).filter((i) => i.client_line_id).map((i) => ({ client_line_id: i.client_line_id as string, order_item_id: i.id })),
      splitSettle: async (a) => {
        rec("split", a);
        const hit = this.submissions.get(a.clientOpId);
        if (hit) return { ...(hit.result as never), idempotent: true };
        const o = this.orders.get(a.orderId)!;
        if (o.status !== "open") throw new Error("This order is no longer active");
        let amount = 0;
        for (const al of a.allocations) {
          const it = o.items.find((i) => i.id === al.order_item_id)!;
          if (it.qty - it.paid_qty < al.quantity) throw new Error(`Only ${it.qty - it.paid_qty} remaining`);
          it.paid_qty += al.quantity;
          amount += it.price * al.quantity;
        }
        o.settlements += 1;
        this.payments.push({ order_id: o.id, amount, method: a.method, op: a.clientOpId });
        const remaining = o.items.reduce((s, i) => s + (i.qty - i.paid_qty), 0);
        if (remaining === 0) {
          o.status = "completed"; o.payment_status = "paid";
          this.tables.get(o.table_id)!.status = "available";
          this.bump(o.table_id);
        } else o.payment_status = "partial";
        const result = { ok: true, split_no: o.settlements, parent_completed: remaining === 0, remaining_qty: remaining };
        this.submissions.set(a.clientOpId, { type: "split", fp: "", result });
        return { ...result, idempotent: false };
      },
      moveTableV2: async ({ payload: p }) => {
        rec("move_v2", p);
        const fp = stable({ ...p, client_op_id: undefined });
        const cached = fingerprinted(p.client_op_id, "move", fp);
        if (cached) return cached as never;
        const from = this.tables.get(p.from_table_id)!;
        const to = this.tables.get(p.to_table_id)!;
        if (p.expected_from_version != null && from.version !== p.expected_from_version) throw posErr("VERSION_CONFLICT");
        if (p.expected_to_version != null && to.version !== p.expected_to_version) throw posErr("VERSION_CONFLICT");
        const src = this.openOn(p.from_table_id);
        if (src.length === 0) throw posErr("MOVE_SOURCE_EMPTY");
        if (stable(sorted(src.map((o) => o.id))) !== stable(sorted(p.expected_order_ids))) throw posErr("MOVE_SOURCE_CHANGED");
        if (p.expected_paid_settlements) for (const o of src) if (o.settlements !== (p.expected_paid_settlements[o.id] ?? 0)) throw posErr("MOVE_PAYMENT_STATE_CHANGED");
        if (this.openOn(p.to_table_id).length > 0) throw posErr("MOVE_DEST_OCCUPIED", "The destination table already has an open bill.");
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
        const cached = fingerprinted(p.client_op_id, "merge", fp);
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
        for (const sId of p.source_table_ids) {
          const o = bills.get(sId)!;
          if (o.items.some((i) => i.paid_qty > 0 && i.paid_qty < i.qty)) throw posErr("UNSUPPORTED_STATE", "UNSUPPORTED_STATE(partial_line)");
          const batch = prim.items.reduce((m, i) => Math.max(m, i.batch), 0) + 1;
          const moving = o.items.filter((i) => i.paid_qty === 0);
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
      payTable: async (a) => {
        rec("pay_table", a);
        const hit = this.submissions.get(a.clientOpId);
        if (hit) return { ...(hit.result as never), idempotent: true };
        const open = this.openOn(a.tableId);
        if (a.expectedOrderIds) {
          if (open.length === 0) {
            if (a.expectedOrderIds.every((id) => this.orders.get(id)?.payment_status === "paid")) throw posErr("ALREADY_SETTLED", "This bill was already settled.");
            throw posErr("PAY_BILL_CHANGED", "The bill on this table changed since the payment was captured.");
          }
          if (stable(sorted(open.map((o) => o.id))) !== stable(sorted(a.expectedOrderIds))) throw posErr("PAY_BILL_CHANGED", "The bill on this table changed since the payment was captured.");
        }
        if (open.length === 0) throw new Error("no open order on this table");
        const due = open.reduce((s, o) => s + this.total(o) - this.paidP(o), 0); // S4: R = T − P
        if (a.expectedAmount != null && Math.abs(due - a.expectedAmount) >= 0.005) throw posErr("PAY_AMOUNT_CHANGED");
        for (const o of open) {
          this.payments.push({ order_id: o.id, amount: this.total(o) - this.paidP(o), method: a.method, op: a.clientOpId });
          o.status = "completed"; o.payment_status = "paid";
        }
        this.tables.get(a.tableId)!.status = "available";
        const result = { ok: true, amount: due, pos_entity_version: this.bump(a.tableId) };
        this.submissions.set(a.clientOpId, { type: "pay", fp: "", result });
        return { ...result, idempotent: false };
      },
    };
  }

  // --- canonical read models (what an online refresh shows) ---
  mapRows(): TableSummary[] {
    return [...this.tables.keys()].map((id) => {
      const open = this.openOn(id);
      const total = open.reduce((s, o) => s + this.total(o), 0);
      const collected = open.reduce((s, o) => s + this.paidP(o), 0);
      const v = this.tables.get(id)!.version;
      return row(id, open.length > 0 ? { orders: open.length, occupied: true, status: "occupied", total, collected, outstanding: total - collected, order_number: open[0].number, pos_entity_version: v } : { pos_entity_version: v });
    });
  }
  bill(t: string): TableBill {
    const orders: BillOrder[] = this.openOn(t).map((o) => ({
      id: o.id, order_number: o.number, status: "sent_to_kitchen", payment_status: o.payment_status, pos_entity_version: 1, shift_id: o.shift_id, branch_id: "b1", tenant_id: "t1",
      subtotal: this.total(o), discount_amount: 0, total_amount: this.total(o), currency: "LBP", exchange_rate: null, created_at: new Date().toISOString(),
      lines: o.items.map((i) => ({ id: i.id, menu_item_id: "m", name: i.name, quantity: i.qty, base_price: i.price, modifiers_total: 0, final_unit_price: i.price, line_total: i.price * i.qty, kitchen_note: null, batch_no: i.batch, modifiers: [] })),
    }));
    const total = orders.reduce((s, o) => s + o.total_amount, 0);
    return { tableId: t, orders, subtotal: orders.length ? total : null, total: orders.length ? total : null, currency: orders.length ? "LBP" : null, mixedCurrency: false, splitShift: false, batches: [1] };
  }
}

// ================================================================ local fixtures + the workspace emulation

const row = (id: string, over: Partial<TableSummary> = {}): TableSummary =>
  ({ id, name: id, seats: 4, occupied: false, status: "available", canonical: true, configured: true, sort_order: 1, orders: 0, order_number: null, opened_at: null, total: null, collected: null, outstanding: null, currency: "LBP", mixed_currency: false, pos_entity_version: 1, ...over }) as TableSummary;

/** An ONLINE floor refresh: the map + every occupied table's bill, stamped with the read START. */
async function refresh(srv: FakeServer) {
  await tick();
  const at = Date.now();
  await cacheTableMap({ tables: srv.mapRows() }, "t1", "b1", at);
  for (const t of srv.mapRows()) await cacheBill(t.id, srv.bill(t.id), "t1", "b1", at);
  await tick();
}
/** The first floor this device ever cached (before any of the work). */
async function initialMap(srv: FakeServer) {
  await cacheTableMap({ tables: srv.mapRows() }, "t1", "b1", Date.now() - 10 * 60_000);
}
async function rawRow(id: string): Promise<TableSummary> {
  const m = await readCachedTableMap("t1", "b1");
  return ((m?.map as { tables?: TableSummary[] } | null)?.tables ?? []).find((t) => t.id === id) ?? row(id);
}

type L = { name: string; price: number; qty: number };
const PIZZA: L = { name: "Pizza", price: 100, qty: 1 };
const FRIES: L = { name: "Fries", price: 50, qty: 1 };
const COLA: L = { name: "Cola", price: 10, qty: 2 };
const SHRIMP: L = { name: "Shrimp", price: 300, qty: 1 };
const SALAD: L = { name: "Salad", price: 40, qty: 1 };

/** DineInWorkspace.sendRound — offline branch. */
async function sendRoundUI(tableId: string, lines: L[]): Promise<DineDraft> {
  let draft = await getDineDraftForTable(SCOPE, tableId);
  if (!draft) {
    const raw = await rawRow(tableId);
    const proj = await getOperationalTableBill(SCOPE, raw);
    const canonicalOrderId = proj.bill.orders.length > 0 && !proj.summaryOnly ? (proj.orders.find((o) => o.orderId && !o.orderLocal)?.orderId ?? null) : null;
    draft = await openTableOffline({
      scope: DSCOPE, tableId, tableName: raw.name, seats: 4, currency: proj.currency ?? "LBP",
      baseOrderVersion: raw.pos_entity_version ?? null, canonicalOrderId,
      afterSettleOpId: canonicalOrderId ? null : (proj.freedByOpId ?? proj.settlingOpId),
    });
  }
  await stageUnsentDraftLines(draft.local_session_id, lines.map((l) => ({ menu_item_id: "m", name: l.name, base_price: l.price, quantity: l.qty, modifiers: [], kitchen_note: null })));
  const d = await sendRoundOffline(draft.local_session_id);
  await tick();
  return d;
}

/** DineInWorkspace.offlineSettleTarget + settleTableOffline. */
async function payUI(tableId: string) {
  const raw = await rawRow(tableId);
  const p = await getOperationalTableBill(SCOPE, raw);
  assert.ok(p.bill.orders.length > 0, `${tableId}: a bill to pay`);
  const amount = offlineSettleAmount(p, serverDeductsPriorPayments());
  assert.ok(amount.ok, `${tableId}: settle allowed`);
  const draft = await getDineDraftForTable(SCOPE, tableId);
  const canonicalIds = p.orders.filter((o) => o.orderLocal == null).map((o) => o.orderId).filter((x): x is string => !!x);
  const hasCanonical = p.summaryOnly || canonicalIds.length > 0;
  const r = await settleTableOffline({
    sessionId: draft && (draft.rounds.length > 0 || hasCanonical) ? draft.local_session_id : null,
    table: hasCanonical ? { scope: DSCOPE, tableId, tableName: raw.name, currency: p.currency ?? "LBP", orderIds: canonicalIds } : undefined,
    method: "cash",
    covers: { orderIds: canonicalIds, summary: p.summaryOnly },
    extraDependencyIds: p.pendingMutationOpIds,
    expectedAmount: amount.ok ? amount.exactAmount : null,
  });
  await tick();
  return { ...r, outstanding: p.outstanding };
}

/** DineInWorkspace.paySplit — offline branch, allocating EVERYTHING still open (or `only` line names).
 *  `legacy` = captured by the 1.0.38 acceptance build (e008a0b), which never recorded that a leg completes. */
async function splitUI(tableId: string, only?: string[], legacy = false) {
  const raw = await rawRow(tableId);
  const p = await getOperationalTableBill(SCOPE, raw);
  const po = p.orders[0];
  const order = p.bill.orders.find((b) => b.id === po.key)!;
  const allocations = order.lines
    .filter((l) => !only || only.includes(l.name))
    .map((l) => ({ order_item_id: l.id, quantity: l.quantity - (p.meta.get(l.id)?.paidQty ?? 0) }))
    .filter((a) => a.quantity > 0);
  const allocs = allocations.map((a) => {
    const m = p.meta.get(a.order_item_id)!;
    return m.ref.kind === "canonical" ? { order_item_id: m.ref.order_item_id, quantity: a.quantity } : { line_local: (m.ref as { line_local: string }).line_local, quantity: a.quantity };
  });
  const creators = allocations.map((a) => p.meta.get(a.order_item_id)!.creatorOpId).filter((x): x is string => !!x);
  const draft = p.sessionId ? await getDineDraftForTable(SCOPE, tableId) : null;
  const sessionDeps = draft ? [draft.open_operation_id, ...draft.rounds.map((r) => r.operation_id)] : [];
  const completes = !legacy && splitCompletesBill(p, po.key, allocations) ? { tableId, sessionLocal: draft?.local_session_id ?? null, orderIds: po.orderId ? [po.orderId] : [] } : null;
  const r = await splitOperationalBillOffline({
    scope: DSCOPE, orderId: po.orderId, orderLocal: po.orderId ? null : po.orderLocal, allocations: allocs, method: "card", currency: "LBP",
    tableName: raw.name, orderNumber: order.order_number || raw.name, dependencyIds: [...sessionDeps, ...po.bumpOps, ...creators, ...p.structuralOpIds], completes,
  });
  assert.ok(r.ok, r.ok ? "" : r.reason);
  await tick();
  return { ...r, completes: completes != null };
}

async function mergeUI(primary: string, sources: string[]) {
  const r = await captureMergeTablesOffline({ scope: SCOPE, primary: await rawRow(primary), sources: await Promise.all(sources.map(rawRow)) });
  assert.ok(r.ok, r.ok ? "" : r.reason);
  await tick();
  return r as { ok: true; operationId: string; outstanding?: number | null };
}
async function moveUI(from: string, to: string) {
  const r = await captureMoveTableOffline({ scope: SCOPE, from: await rawRow(from), to: await rawRow(to) });
  assert.ok(r.ok, r.ok ? "" : r.reason);
  await tick();
  return r as { ok: true; operationId: string };
}

const drain = (srv: FakeServer) => drainOffline(CTX, "reconnect", srv.deps());
async function restart() {
  localdb.close();
  await localdb.open();
  __resetDrainLockForTests();
}
const pastBackoff = async () => {
  for (const o of await localdb.operations.toArray()) if (o.status === "retryable") await localdb.operations.update(o.operation_id, { last_attempt_at: new Date(0).toISOString() });
};
const op = async (id: string) => (await getOperation(id))!;
const roundOps = async () => (await localdb.operations.toArray()).filter((o) => o.operation_type === "dinein_send_round").sort((a, b) => a.created_at.localeCompare(b.created_at));
const attention = async () => (await localdb.operations.toArray()).filter((o) => o.status === "needs_attention");

async function secondReconnectIsZero(srv: FakeServer, label: string) {
  const before = srv.state();
  const n = srv.calls.length;
  for (let i = 0; i < 2; i++) {
    await restart();
    const r = await drain(srv);
    assert.equal(r.drained.length, 0, `${label}: nothing replayed again`);
  }
  assert.deepEqual(srv.calls.slice(n).map((c) => c.name), [], `${label}: zero calls on the second reconnect`);
  assert.equal(srv.state(), before, `${label}: zero additional effects`);
}

/** What the cashier can still collect on a table right now (the projection's outstanding; 0 when held / free). */
async function collectible(tableId: string): Promise<number> {
  const p = await getOperationalTableBill(SCOPE, await rawRow(tableId));
  return p.bill.orders.length === 0 ? 0 : (p.outstanding ?? 0);
}

const roundPayload = (o: OfflineOperation) => o.payload as { submit: { table_id: string; expected_order_id?: string }; session_local: string | null; round_seq: number };
const sentRounds = (srv: FakeServer) => srv.calls.filter((c) => c.name === "round").map((c) => c.payload as { table_id: string; expected_order_id?: string });

// ================================================================ A–E: the five chains (fresh tables)

test("A round → merge → pay: replayed once, pay bound to the post-merge bill and AFTER the merge; second reconnect = 0", async () => {
  const srv = new FakeServer(["A", "B"]);
  await initialMap(srv);
  const a = await sendRoundUI("A", [PIZZA]);
  await sendRoundUI("B", [FRIES]);
  const m = await mergeUI("A", ["B"]);
  assert.equal(m.outstanding, 150);
  const pay = await payUI("A");
  const payOp = await op(pay.operationId);
  assert.ok(payOp.dependency_ids.includes(m.operationId), "the pay depends on the merge");
  assert.equal((payOp.payload as { covers: { session_local: string } }).covers.session_local, a.local_session_id, "bound to the primary (post-merge) bill");
  await restart();
  const r = await drain(srv);
  assert.equal(r.needsAttention.length, 0, JSON.stringify(r.needsAttention));
  assert.deepEqual(srv.names(), ["open_table", "round", "open_table", "round", "merge_v4", "pay_table"]);
  const prim = [...srv.orders.values()].find((o) => o.table_id === "A" && !o.merged_into)!;
  assert.deepEqual((srv.calls[5].payload as { expectedOrderIds: string[] }).expectedOrderIds, [prim.id]);
  assert.deepEqual(srv.payments.map((p) => [p.order_id, p.amount]), [[prim.id, 150]]);
  assert.equal(srv.obligation(), 0);
  await secondReconnectIsZero(srv, "A");
});

test("B multiple rounds → merge → pay: every round once on its own bill, the merge folds all, pay = Σ", async () => {
  const srv = new FakeServer(["A", "B"]);
  await initialMap(srv);
  await sendRoundUI("A", [PIZZA]);
  await sendRoundUI("A", [COLA]);
  await sendRoundUI("B", [FRIES]);
  await sendRoundUI("B", [SALAD]);
  await mergeUI("A", ["B"]);
  await payUI("A");
  const r = await drain(srv);
  assert.equal(r.needsAttention.length, 0, JSON.stringify(r.needsAttention));
  assert.equal(srv.count("round"), 4);
  const prim = [...srv.orders.values()].find((o) => o.table_id === "A" && !o.merged_into)!;
  assert.deepEqual(prim.items.map((i) => i.name).sort(), ["Cola", "Fries", "Pizza", "Salad"]);
  assert.deepEqual(srv.payments.map((p) => p.amount), [100 + 20 + 50 + 40]);
  await secondReconnectIsZero(srv, "B");
});

test("C partial → merge → pay remainder: P stays on the source, only R moves, the pay collects exactly the remainder", async () => {
  const srv = new FakeServer(["A", "B"]);
  await initialMap(srv);
  await sendRoundUI("B", [SHRIMP, FRIES]);
  const leg = await splitUI("B", ["Shrimp"]);
  assert.equal(leg.completes, false, "a partial leg never closes the bill");
  assert.equal((await getDineDraftForTable(SCOPE, "B"))?.status, "open");
  await sendRoundUI("A", [SALAD]);
  const m = await mergeUI("A", ["B"]);
  assert.equal(m.outstanding, 40 + 50, "R_A + R_B");
  await payUI("A");
  const r = await drain(srv);
  assert.equal(r.needsAttention.length, 0, JSON.stringify(r.needsAttention));
  const src = [...srv.orders.values()].find((o) => o.merged_into)!;
  assert.deepEqual([src.status, srv.total(src)], ["completed", 300], "the paid Shrimp stays on its source");
  assert.deepEqual(srv.payments.map((p) => [p.amount, p.method]), [[300, "card"], [90, "cash"]]);
  assert.equal(srv.obligation(), 0);
  await secondReconnectIsZero(srv, "C");
});

test("D round → move → pay: pay bound to the SAME order on the destination and depends on the move", async () => {
  const srv = new FakeServer(["A", "B"]);
  await initialMap(srv);
  const a = await sendRoundUI("A", [PIZZA]);
  const mv = await moveUI("A", "B");
  const pay = await payUI("B");
  const payOp = await op(pay.operationId);
  assert.ok(payOp.dependency_ids.includes(mv.operationId), "pay after move depends on the move");
  assert.equal((payOp.payload as { table_id: string; covers: { session_local: string } }).table_id, "B");
  assert.equal((payOp.payload as { covers: { session_local: string } }).covers.session_local, a.local_session_id, "the same bill");
  await restart();
  const r = await drain(srv);
  assert.equal(r.needsAttention.length, 0, JSON.stringify(r.needsAttention));
  assert.deepEqual(srv.names(), ["open_table", "round", "move_v2", "pay_table"]);
  const o = [...srv.orders.values()][0];
  assert.deepEqual([o.table_id, o.payment_status], ["B", "paid"]);
  assert.deepEqual((srv.calls[3].payload as { expectedOrderIds: string[] }).expectedOrderIds, [o.id]);
  await secondReconnectIsZero(srv, "D");
});

test("E multiple rounds → move → round on the destination → pay: rounds keep their capture-time table, one bill, one payment", async () => {
  const srv = new FakeServer(["A", "B"]);
  await initialMap(srv);
  await sendRoundUI("A", [PIZZA]);
  await sendRoundUI("A", [COLA]);
  await moveUI("A", "B");
  await sendRoundUI("B", [FRIES]);
  await payUI("B");
  const rounds = await roundOps();
  assert.deepEqual(rounds.map((o) => [roundPayload(o).submit.table_id, roundPayload(o).round_seq]), [["A", 1], ["A", 2], ["B", 3]]);
  const r = await drain(srv);
  assert.equal(r.needsAttention.length, 0, JSON.stringify(r.needsAttention));
  assert.equal(srv.orders.size, 1);
  const o = [...srv.orders.values()][0];
  assert.deepEqual([o.table_id, srv.total(o), o.payment_status], ["B", 170, "paid"]);
  assert.deepEqual(srv.payments.map((p) => p.amount), [170]);
  await secondReconnectIsZero(srv, "E");
});

// ================================================================ the EXACT acceptance repro (F1)

/** Phase 1 (offline): a bill on V that ends CLOSED by `how`, and an open bill on T8. Returns the old V session. */
async function closedBillOnV(srv: FakeServer, how: "split" | "split_legacy" | "online_pay" | "remote_close", opts: { refreshAfter: boolean }): Promise<DineDraft> {
  await initialMap(srv);
  const s5 = await sendRoundUI("V", [SHRIMP]);
  if (how === "split" || how === "split_legacy") {
    const leg = await splitUI("V", undefined, how === "split_legacy");
    assert.equal(leg.completes, how === "split", "the leg pays everything still open");
    assert.equal((await localdb.dineDrafts.get(s5.local_session_id))?.status, how === "split" ? "settled" : "open");
  }
  await sendRoundUI("T8", [PIZZA]);
  const r = await drain(srv);
  assert.equal(r.needsAttention.length, 0, JSON.stringify(r.needsAttention));
  if (how === "online_pay") srv.payOnline("V");
  if (how === "remote_close") srv.voidOnline("V");
  if (opts.refreshAfter) await refresh(srv);
  return s5;
}

const HOW_LABEL = { split: "paid in full by an offline split", split_legacy: "paid in full by an offline split captured by the acceptance build", online_pay: "paid online", remote_close: "closed remotely" };
for (const how of ["split", "split_legacy", "online_pay", "remote_close"] as const) {
  test(`ACCEPTANCE: bill on V ${HOW_LABEL[how]} → new customer on V offline: round → merge → pay all succeed as a NEW order`, async () => {
    const srv = new FakeServer(["V", "T8"]);
    const s5 = await closedBillOnV(srv, how, { refreshAfter: true });
    const oldOrder = [...srv.orders.values()].find((o) => o.table_id === "V")!;
    // Phase 2 (offline): the next customer on V.
    const n = await sendRoundUI("V", [FRIES]);
    assert.notEqual(n.local_session_id, s5.local_session_id, "a NEW local session");
    const old = (await localdb.dineDrafts.get(s5.local_session_id))!;
    assert.notEqual(old.status, "open", "the old session is retired");
    assert.equal(old.closed_reason, how === "split" || how === "split_legacy" ? "split_completed" : "canonical_closed");
    assert.equal(old.rounds.length, 1, "the retired session keeps its history");
    const r1 = (await roundOps()).at(-1)!;
    assert.deepEqual([roundPayload(r1).round_seq, roundPayload(r1).session_local, roundPayload(r1).submit.expected_order_id], [1, null, undefined], "round 1 of the new bill, no expected_order_id");
    await mergeUI("T8", ["V"]);
    await payUI("T8");
    await restart();
    const r = await drain(srv);
    assert.equal(r.needsAttention.length, 0, JSON.stringify(r.needsAttention));
    assert.ok(!sentRounds(srv).some((c) => c.expected_order_id === oldOrder.id), "no round ever pinned the closed order");
    const t8 = [...srv.orders.values()].find((o) => o.table_id === "T8" && !o.merged_into)!;
    const fresh = [...srv.orders.values()].find((o) => o.table_id === "V" && o.id !== oldOrder.id)!;
    assert.ok(fresh, "the new customer's order is a NEW order");
    assert.deepEqual([fresh.status, fresh.merged_into], ["voided", t8.id], "folded into T8");
    assert.deepEqual([t8.payment_status, srv.total(t8)], ["paid", 150]);
    assert.equal(oldOrder.items.length, 1, "the closed order never got another round");
    assert.equal(srv.obligation(), 0);
    await secondReconnectIsZero(srv, `acceptance ${how}`);
  });
}

test("ACCEPTANCE (stale map, staging state): the acceptance-build split synced (parent_completed) but the floor was NOT refreshed — never bound to the paid order, never a stale CAS", async () => {
  const srv = new FakeServer(["V", "T8"]);
  const s5 = await closedBillOnV(srv, "split_legacy", { refreshAfter: false });
  assert.equal((await localdb.dineDrafts.get(s5.local_session_id))?.status, "settled", "retired by the drain's reconcile (parent_completed)");
  const oldOrder = [...srv.orders.values()].find((o) => o.table_id === "V")!;
  const n = await sendRoundUI("V", [FRIES]);
  assert.notEqual(n.local_session_id, s5.local_session_id);
  assert.equal(n.canonical_order_id, null, "never bound to the completed order");
  await mergeUI("T8", ["V"]);
  await payUI("T8");
  const r = await drain(srv);
  assert.equal(r.needsAttention.length, 0, JSON.stringify(r.needsAttention));
  assert.equal(oldOrder.items.length, 1);
  assert.equal(srv.obligation(), 0);
  await secondReconnectIsZero(srv, "stale map");
});

test("ACCEPTANCE (same offline period): full split → next customer on the table → round → move → pay, before any reconnect", async () => {
  const srv = new FakeServer(["V", "W"]);
  await initialMap(srv);
  const s5 = await sendRoundUI("V", [SHRIMP]);
  const leg = await splitUI("V");
  assert.equal(leg.completes, true);
  assert.equal((await localdb.dineDrafts.get(s5.local_session_id))?.status, "settled", "closed locally by the completing leg");
  assert.equal(await collectible("V"), 0, "nothing left to collect on V");
  const n = await sendRoundUI("V", [FRIES]);
  assert.notEqual(n.local_session_id, s5.local_session_id);
  const openOp = (await op(n.open_operation_id))!;
  assert.ok(openOp.dependency_ids.includes(leg.operationId), "the new bill replays after the leg that closed the old one");
  await moveUI("V", "W");
  await payUI("W");
  await restart();
  const r = await drain(srv);
  assert.equal(r.needsAttention.length, 0, JSON.stringify(r.needsAttention));
  assert.deepEqual(srv.names(), ["open_table", "round", "split", "open_table", "round", "move_v2", "pay_table"]);
  const orders = [...srv.orders.values()];
  assert.equal(orders.length, 2);
  assert.deepEqual(orders.map((o) => [o.table_id, o.payment_status]), [["V", "paid"], ["W", "paid"]]);
  assert.deepEqual(srv.payments.map((p) => p.amount), [300, 50]);
  await secondReconnectIsZero(srv, "same period");
});

test("ACCEPTANCE chain B: a moved bill paid ONLINE on its new table → next customer there offline: round → move → pay as a NEW order", async () => {
  const srv = new FakeServer(["T8", "T999", "V"]);
  await initialMap(srv);
  const s6 = await sendRoundUI("T8", [PIZZA]);
  await moveUI("T8", "T999");
  assert.equal((await drain(srv)).needsAttention.length, 0);
  srv.payOnline("T999");
  await refresh(srv);
  const old = [...srv.orders.values()][0];
  const n = await sendRoundUI("T999", [FRIES]);
  assert.notEqual(n.local_session_id, s6.local_session_id);
  assert.equal((await localdb.dineDrafts.get(s6.local_session_id))?.status, "closed");
  await moveUI("T999", "V");
  await payUI("V");
  await restart();
  const r = await drain(srv);
  assert.equal(r.needsAttention.length, 0, JSON.stringify(r.needsAttention));
  const fresh = [...srv.orders.values()].find((o) => o.id !== old.id)!;
  assert.deepEqual([fresh.table_id, fresh.payment_status, srv.total(fresh)], ["V", "paid", 50]);
  assert.equal(old.items.length, 1);
  await secondReconnectIsZero(srv, "chain B");
});

test("D2: a stale session on a table whose bill closed elsewhere never makes it look occupied — a move onto it is allowed", async () => {
  const srv = new FakeServer(["A", "B"]);
  await initialMap(srv);
  await sendRoundUI("B", [PIZZA]);
  await drain(srv);
  srv.payOnline("B");
  await refresh(srv);
  await sendRoundUI("A", [FRIES]);
  const mv = await captureMoveTableOffline({ scope: SCOPE, from: await rawRow("A"), to: await rawRow("B") });
  assert.ok(mv.ok, mv.ok ? "" : mv.reason);
  const r = await drain(srv);
  assert.equal(r.needsAttention.length, 0, JSON.stringify(r.needsAttention));
  assert.equal([...srv.orders.values()].find((o) => o.status === "open")!.table_id, "B");
});

// ================================================================ F1 negatives (never retire live work)

test("F1 negatives: a session is NEVER retired with unsynced / parked work, before its canonical order is known, or on a map read before it synced", async () => {
  const srv = new FakeServer(["A"]);
  await initialMap(srv);
  const s = await sendRoundUI("A", [PIZZA]);
  const draft = () => localdb.dineDrafts.get(s.local_session_id) as Promise<DineDraft>;
  const ops = () => scopedOperations(SCOPE);
  const free = row("A");
  // unsynced work, free map read AFTER capture
  assert.equal(sessionClosure(await draft(), await ops(), { row: free, mapAt: Date.now() + 1000 }), null, "unsynced → active bill");
  await drain(srv);
  // synced, but the floor read predates the sync
  assert.equal(sessionClosure(await draft(), await ops(), { row: free, mapAt: Date.now() - 60_000 }), null, "a map read before the sync proves nothing");
  // synced, map after, but the map still shows the SAME order
  const live = srv.mapRows()[0];
  assert.equal(sessionClosure(await draft(), await ops(), { row: live, mapAt: Date.now() + 1000 }), null, "still its open bill");
  // a later round parked (needs_attention, recoverable) → never retired
  const s2 = await sendRoundUI("A", [COLA]);
  const r2 = s2.rounds[1].operation_id;
  await localdb.operations.update(r2, { status: "needs_attention", last_error_code: "dependency_failed", last_error_message: "x" });
  assert.equal(sessionClosure(await draft(), await ops(), { row: free, mapAt: Date.now() + 1000 }), null, "parked work keeps it active");
  assert.equal((await retireClosedSessions()).length, 0);
  // a session with no synced round 1 (no canonical order) proves nothing either
  const fresh = await openTableOffline({ scope: DSCOPE, tableId: "Z", tableName: "Z", seats: 2, currency: "LBP" });
  assert.equal(sessionClosure(fresh, await ops(), { row: row("Z"), mapAt: Date.now() + 1000 }), null);
  // and a capture can never attach a round to a retired session
  await localdb.dineDrafts.update(s.local_session_id, { status: "closed" });
  await stageUnsentDraftLines(s.local_session_id, [{ menu_item_id: "m", name: "X", base_price: 1, quantity: 1, modifiers: [], kitchen_note: null }]);
  await assert.rejects(sendRoundOffline(s.local_session_id), new RegExp(SESSION_CLOSED_MESSAGE.slice(0, 30)));
});

// ================================================================ immutable capture-time identity + restarts

test("IDENTITY: round / merge / pay pins are frozen at capture and replay resolves ONLY through predecessor results — never the current local table state", async () => {
  const srv = new FakeServer(["A", "B", "Q"]);
  await initialMap(srv);
  const a = await sendRoundUI("A", [PIZZA]);
  const b = await sendRoundUI("B", [FRIES]);
  const m = await mergeUI("A", ["B"]);
  const pay = await payUI("A");
  const before = stable((await localdb.operations.toArray()).map((o) => [o.operation_id, o.payload, o.dependency_ids]));
  // Scramble the LOCAL projection after capture: sessions "moved" to another table, a bogus canonical id.
  await localdb.dineDrafts.update(a.local_session_id, { table_id: "Q", canonical_order_id: "SO-BOGUS" });
  await localdb.dineDrafts.update(b.local_session_id, { table_id: "Q", canonical_order_id: "SO-BOGUS" });
  await cacheTableMap({ tables: [row("A"), row("B"), row("Q", { orders: 1, order_number: "X" })] }, "t1", "b1", Date.now());
  assert.equal(stable((await localdb.operations.toArray()).map((o) => [o.operation_id, o.payload, o.dependency_ids])), before, "captured ops untouched");
  await restart();
  const r = await drain(srv);
  assert.equal(r.needsAttention.length, 0, JSON.stringify(r.needsAttention));
  const prim = [...srv.orders.values()].find((o) => o.table_id === "A" && !o.merged_into)!;
  const src = [...srv.orders.values()].find((o) => o.merged_into)!;
  const merge = srv.calls.find((c) => c.name === "merge_v4")!.payload as { expected_orders: Record<string, string> };
  assert.deepEqual(merge.expected_orders, { A: prim.id, B: src.id }, "merge pins = the predecessors' round results");
  assert.deepEqual((srv.calls.find((c) => c.name === "pay_table")!.payload as { tableId: string; expectedOrderIds: string[] }), { ...(srv.calls.find((c) => c.name === "pay_table")!.payload as object), tableId: "A", expectedOrderIds: [prim.id] });
  assert.ok(!JSON.stringify(srv.calls).includes("SO-BOGUS") && !srv.calls.some((c) => JSON.stringify(c.payload).includes('"Q"')), "nothing came from the scrambled local state");
  assert.equal((await op(m.operationId)).result_meta?.primary_order_id, prim.id, "the merge result records the post-merge identity");
  assert.equal((await op(pay.operationId)).status, "synced");
});

for (const boundary of ["before round replay", "after round synced, before merge", "after merge, before pay"] as const) {
  test(`RESTART ${boundary}: round → merge → pay and round → move → pay are exactly-once`, async () => {
    const srv = new FakeServer(["A", "B", "C", "D"]);
    await initialMap(srv);
    await sendRoundUI("A", [PIZZA]);
    await sendRoundUI("B", [FRIES]);
    await mergeUI("A", ["B"]);
    await payUI("A");
    await sendRoundUI("C", [SALAD]);
    await moveUI("C", "D");
    await payUI("D");
    if (boundary === "before round replay") {
      await restart();
    } else {
      const lost = new TypeError("Failed to fetch");
      if (boundary === "after round synced, before merge") {
        srv.failNext.set("merge_v4", lost);
        srv.failNext.set("move_v2", lost);
      } else {
        srv.failNext.set("pay_table", lost);
      }
      await drain(srv);
      if (boundary === "after round synced, before merge") assert.equal(srv.count("merge_v4"), 1, "the merge reached the transport once");
      await restart();
      await pastBackoff();
    }
    let guard = 0;
    while ((await localdb.operations.toArray()).some((o) => o.status !== "synced") && guard++ < 4) {
      await pastBackoff();
      await drain(srv);
      await restart();
    }
    assert.equal((await attention()).length, 0);
    assert.equal(srv.orders.size, 3, "two bills + the merged-away source");
    assert.deepEqual(srv.payments.map((p) => p.amount).sort((x, y) => x - y), [40, 150], "each bill paid exactly once");
    assert.equal(srv.obligation(), 0);
    await secondReconnectIsZero(srv, boundary);
  });
}

// ================================================================ O: server refusal of the merge

test("O merge REFUSED: the source bill is restored and HELD by the captured payment (never collectible twice), the pay is never sent, dependents are blocked BY THE MERGE", async () => {
  const srv = new FakeServer(["A", "B"]);
  await initialMap(srv);
  await sendRoundUI("A", [PIZZA]);
  const b = await sendRoundUI("B", [FRIES]);
  const m = await mergeUI("A", ["B"]);
  const pay = await payUI("A");
  srv.failNext.set("merge_v4", posErr("MERGE_BILL_CHANGED"));
  await drain(srv);
  const mergeOp = await op(m.operationId);
  const payOp = await op(pay.operationId);
  assert.deepEqual([mergeOp.status, mergeOp.last_error_code], ["needs_attention", "merge_bill_changed"]);
  assert.deepEqual([payOp.status, payOp.last_error_code], ["needs_attention", "dependency_failed"]);
  assert.ok(payOp.last_error_message!.includes(m.operationId), "names the real predecessor");
  assert.equal(srv.count("pay_table"), 0, "the pay was never sent");
  assert.equal(srv.payments.length, 0);
  assert.equal(settleHeldByRefusedStructural(payOp, mergeOp), true, "captured while the merge was projected → it collected the source too");
  assert.equal(settleHeldByRefusedStructural({ ...payOp, created_at: "9999-01-01T00:00:00.000Z" }, mergeOp), false, "a pay captured AFTER the refusal never holds the source");
  // the source bill is intact on the server and its local session restored — held by the parked payment
  const srcOrder = [...srv.orders.values()].find((o) => o.table_id === "B")!;
  assert.deepEqual([srcOrder.status, srcOrder.items.length], ["open", 1]);
  const src = (await localdb.dineDrafts.get(b.local_session_id))!;
  assert.deepEqual([src.status, src.closed_reason, src.rounds.length], ["settled", "held_by_payment", 1]);
  await refresh(srv);
  // collectible-balance invariant: Σ collectible + Σ parked-collected == the real remaining obligation
  const parkedCollected = 150; // the cashier took Σ = 100 + 50 inside the parked pay
  assert.equal((await collectible("A")) + (await collectible("B")), 0, "no table is collectible again");
  assert.equal((await collectible("A")) + (await collectible("B")) + parkedCollected, srv.obligation());
  // Sync Center wording
  const diag = buildDiagnostic(await localdb.operations.toArray(), null, { allOps: await localdb.operations.toArray() });
  const payRow = diag.find((x) => x.op === pay.operationId.slice(0, 18))!;
  assert.match(payRow.blocking ?? "", /^Blocked by Merge tables · B → A \(MERGE_BILL_CHANGED/);
  assert.ok(!/waiting/i.test(payRow.blocking ?? ""));
  assert.equal(displayStateOf(mergeOp.status, mergeOp.last_error_code, String(mergeOp.operation_type)), "conflict");
  await secondReconnectIsZero(srv, "O");
});

// ================================================================ P: multi-terminal conflicts

/** A bill on A whose round 1 synced, then the floor refreshed: the session continues the canonical order. */
async function syncedBillOnA(srv: FakeServer) {
  await initialMap(srv);
  const s = await sendRoundUI("A", [PIZZA]);
  await drain(srv);
  await refresh(srv);
  return s;
}

// 1.0.38 G3 — updated intentionally: through G2 this pinned the FINANCIAL GAP (the server booked its NEW
// R = 160 although the cashier collected 120 offline). The pay now always carries expected_amount = R_local.
test("P1 another terminal adds a round to the SAME bill while this one is offline: our round appends to that bill, the pay (pinned to the bill AND the amount collected) is REFUSED, nothing is duplicated or booked", async () => {
  const srv = new FakeServer(["A"]);
  const s = await syncedBillOnA(srv);
  const r2 = await sendRoundUI("A", [COLA]);
  assert.equal(r2.local_session_id, s.local_session_id, "the bill is still open: the same session");
  const pay = await payUI("A");
  assert.equal(((await op(pay.operationId)).payload as { expected_amount?: number }).expected_amount, 100 + 20, "the amount this device collected");
  const order = [...srv.orders.values()][0];
  srv.roundOnline("A", [SALAD]);
  const r = await drain(srv);
  assert.deepEqual(r.needsAttention.map((x) => x.reason), ["pay_amount_changed"]);
  assert.equal((await op(pay.operationId)).status, "needs_attention");
  assert.equal(srv.orders.size, 1);
  assert.deepEqual(order.items.map((i) => i.name), ["Pizza", "Salad", "Cola"], "our round still appended once");
  assert.deepEqual(srv.payments.map((p) => p.amount), [], "no payment at a figure the cashier never collected");
  await secondReconnectIsZero(srv, "P1");
});

for (const remote of ["moves", "pays", "closes"] as const) {
  test(`P2/P3 another terminal ${remote} the SAME bill while offline: our round is refused (stale bill), move / merge / pay are BLOCKED by it, zero effects, audit kept`, async () => {
    const srv = new FakeServer(["A", "B", "C", "X"]);
    const s = await syncedBillOnA(srv);
    const order = [...srv.orders.values()][0];
    await sendRoundUI("B", [FRIES]);
    const r2 = await sendRoundUI("A", [COLA]);
    assert.equal(r2.local_session_id, s.local_session_id);
    const m = await mergeUI("A", ["B"]);
    const pay = await payUI("A");
    if (remote === "moves") srv.moveOnline("A", "X");
    if (remote === "pays") srv.payOnline("A");
    if (remote === "closes") srv.voidOnline("A");
    const before = { items: order.items.length, payments: srv.payments.length };
    await drain(srv);
    const r2op = await op(r2.rounds[1].operation_id);
    assert.deepEqual([r2op.status, r2op.last_error_code], ["needs_attention", "expected_order_mismatch"]);
    assert.deepEqual(classifyOperation(r2op), { category: "STALE_BILL_ROUND", reason: STALE_BILL_ROUND_REASON });
    for (const id of [m.operationId, pay.operationId]) assert.deepEqual([(await op(id)).status, (await op(id)).last_error_code], ["needs_attention", "dependency_failed"]);
    assert.equal(srv.count("merge_v4") + srv.count("pay_table"), 0, "never sent");
    assert.deepEqual({ items: order.items.length, payments: srv.payments.length }, before, "zero effects on the remote bill");
    assert.ok((await localdb.dineDrafts.get(s.local_session_id))!.rounds.length === 2, "audit: the refused round stays on its session");
    const diag = buildDiagnostic(await localdb.operations.toArray(), null, { allOps: await localdb.operations.toArray() });
    const mergeRow = diag.find((x) => x.op === m.operationId.slice(0, 18))!;
    assert.match(mergeRow.blocking ?? "", /^Blocked by Send round 2 · A \(Round captured on a bill that was already closed — needs manager review\)/);
    await secondReconnectIsZero(srv, `P ${remote}`);
  });
}

test("P4 destination occupied by another terminal: the move is refused, the pay blocked by the move, the bill held by the captured pay on its original table — never collectible twice", async () => {
  const srv = new FakeServer(["A", "C"]);
  await initialMap(srv);
  await sendRoundUI("A", [PIZZA]);
  const mv = await moveUI("A", "C");
  const pay = await payUI("C");
  srv.roundOnline("C", [SALAD]); // another terminal opens a bill on C
  await drain(srv);
  assert.deepEqual([(await op(mv.operationId)).status, (await op(mv.operationId)).last_error_code], ["needs_attention", "move_dest_occupied"]);
  assert.deepEqual([(await op(pay.operationId)).status, (await op(pay.operationId)).last_error_code], ["needs_attention", "dependency_failed"]);
  assert.equal(srv.count("pay_table"), 0);
  const ours = [...srv.orders.values()].find((o) => o.table_id === "A")!;
  assert.deepEqual([ours.status, ours.payment_status], ["open", "unpaid"], "our bill never moved and was never paid");
  await refresh(srv);
  assert.equal(await collectible("A"), 0, "held by the parked payment (cash already taken)");
  assert.equal(await collectible("C"), 40, "the other terminal's bill is its own");
  assert.equal((await collectible("A")) + 100 + (await collectible("C")), srv.obligation(), "collectible + parked-collected == real obligation");
  await secondReconnectIsZero(srv, "P4");
});

// ================================================================ F2 / F4 — Sync Center truth + diagnostics pins

test("F2/F4 Sync Center: stale-bill round = Conflict with its specific reason; dependents 'Blocked by …' (not waiting); diagnostics carry the bill pins and no customer data", async () => {
  const srv = new FakeServer(["A", "B"]);
  const s = await syncedBillOnA(srv);
  const order = [...srv.orders.values()][0];
  const r2 = await sendRoundUI("A", [COLA]);
  const mv = await moveUI("A", "B");
  const pay = await payUI("B");
  srv.payOnline("A");
  await drain(srv);
  const all = await localdb.operations.toArray();
  const diag = buildDiagnostic(all, "build-x", { allOps: all });
  const by = (id: string) => diag.find((x) => x.op === id.slice(0, 18))!;
  const round = by(r2.rounds[1].operation_id);
  assert.equal(round.category, "STALE_BILL_ROUND");
  assert.equal(round.reason, STALE_BILL_ROUND_REASON);
  assert.equal(round.disposition, "MANUAL_REVIEW");
  assert.equal(displayStateOf(round.status, round.error_code, round.type), "conflict");
  assert.deepEqual(
    { table: round.pins.table_id, session: round.pins.local_session_id, expected: round.pins.expected_order_id, locals: round.pins.captured_local_ids, status: round.pins.status, code: round.pins.error_code },
    { table: "A", session: s.local_session_id, expected: order.id, locals: [s.local_session_id], status: "needs_attention", code: "expected_order_mismatch" },
  );
  const move = by(mv.operationId);
  assert.match(move.blocking ?? "", /^Blocked by Send round 2 · A/);
  assert.deepEqual([move.pins.tables, move.pins.local_session_id, move.pins.captured_order_ids], [["A", "B"], s.local_session_id, [order.id]]);
  assert.ok(move.pins.dependency_ids.includes(r2.rounds[1].operation_id));
  const payRow = by(pay.operationId);
  assert.match(payRow.blocking ?? "", /^Blocked by /);
  assert.ok(!/waiting for/i.test(payRow.blocking ?? ""));
  assert.equal(displayStateOf(payRow.status, payRow.error_code, payRow.type), "needs_attention");
  assert.deepEqual([payRow.pins.table_id, payRow.pins.local_session_id], ["B", s.local_session_id]);
  const text = JSON.stringify(diag);
  for (const pii of ["Pizza", "Cola", "phone", "customer_name"]) assert.ok(!text.includes(pii), `no ${pii} in the diagnostic`);
  // a genuinely waiting op still says "waiting for"
  const w = { ...all.find((o) => o.operation_id === pay.operationId)!, status: "blocked_dependency" as const, last_error_code: null, last_error_message: null };
  assert.match(buildDiagnostic([w], null, { allOps: all })[0].blocking ?? "", /^waiting for: /);
  // no remediation: nothing was cancelled, deleted or re-targeted
  assert.equal(all.filter((o) => o.status === "cancelled").length, 0);
  await secondReconnectIsZero(srv, "F2");
});
