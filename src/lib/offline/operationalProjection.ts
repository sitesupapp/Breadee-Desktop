// rc.9 — THE operational projection: ONE locally-authoritative READ view per Dine-In table and per
// Delivery order, derived (never stored) from what this device durably knows:
//
//   1. the last canonical snapshot (cached table bill / cached delivery order lines + row)
//   2. the local dineDraft sent rounds (unsynced, or synced but newer than the snapshot)
//   3. local unsynced item mutations from the op log (edit_order_line / add_order_items)
//   4. local split / settle legs (split_settle, pay_table, on_account_table, pay_order)
//   5. local delivery metadata (delivery_ops / delivery_set_provider / edit_order note)
//
// DETERMINISTIC merge order: canonical → draft rounds (by seq) → item mutations (capture order) →
// split/settle legs. An op already REFLECTED in the canonical snapshot (synced at or before the
// snapshot's fetch time) is skipped, so nothing is ever double-applied. Every surface — Map/List card,
// sidebar bill, Add Items, payment base, split, print — reads THIS one projection, so they can never
// disagree (the rc.8 Table-1 1,800,000 vs 5,455,000 split-brain).
//
// It is a READ projection, NOT financial authority: no store, no queue, no replay loop. Captures still
// go through the existing op-log engines; the server stays authoritative after sync. The ONLY totals
// calculator is `foldBill` (lib/pos/tableBill) over captured line prices.

import { localdb, readAllOperationsMirrored, readCachedBill, readCachedBillsMany, readCachedTableMap, readCachedDeliveryLines, readCachedDeliveryLinesMany, type DineDraft, type DineDraftLine, type PosOfflineTxn } from "@/lib/offline/db";
import type { OfflineOperation } from "@/lib/offline/operationLog";
import type { EditTargetRef } from "@/lib/offline/handlers";
import { foldBill } from "@/lib/pos/tableBill";
import type { BillLine, BillOrder, TableBill, TableSummary } from "@/types/tables";
import type { CurrencyCode } from "@/lib/currency";
import type { DeliveryOrderLine, DeliveryQueueOrder } from "@/lib/pos/deliveryOrderManagement";

// ---------------------------------------------------------------------------
// shared
// ---------------------------------------------------------------------------

export type ProjectionScope = {
  tenantId: string | null;
  branchId: string | null;
  cashierUserId: string | null;
  deviceId: string | null;
  terminalId?: string | null;
};

/** How a projected line maps back to the server for an edit/split. "summary" / "legacy" lines are
 *  display-only (their server ids are not known on this device). 1.0.38 — "merged" lines were folded in
 *  by an offline merge that has not synced yet: display-only until it does (their order changes). */
export type LineRef = EditTargetRef | { kind: "summary" } | { kind: "legacy" } | { kind: "merged"; op_id: string };

// ---------------------------------------------------------------------------
// 1.0.38 (Bugs 5/6) — offline Move / Merge (schema 2 structural ops)
// ---------------------------------------------------------------------------

/** The op schema version of the offline-safe move_table / merge_tables (pos_move_table_v2 /
 *  pos_merge_tables_v4). Schema 1 (rc.4–rc.11) ops stay quarantined: no handler, never replayed. */
export const TABLE_OP_SCHEMA_VERSION = 2;

/** A bill identity reference: a canonical order id, or the local session that creates it. */
export type BillRef = { order_id: string | null; order_local: string | null };
export const billRefKey = (r: BillRef): string => (r.order_id ? r.order_id : `L:${r.order_local ?? ""}`);

/** 1.0.38 — a line folded in by an offline merge that has not synced yet. */
export const MERGED_LINE_LOCKED_MESSAGE = "This item was merged in offline. Wait for the merge to sync before changing or splitting it.";

/** True for a schema-2 (offline-safe) move_table / merge_tables op. */
export function isStructuralOp(o: OfflineOperation): boolean {
  return (o.operation_type === "move_table" || o.operation_type === "merge_tables") && o.schema_version === TABLE_OP_SCHEMA_VERSION;
}

/** The tables a structural op VACATES (move: from; merge: the sources) and the one it FILLS (move: to;
 *  merge: the primary). */
export function structuralTables(o: OfflineOperation): { vacates: string[]; fills: string | null } {
  const p = rec(o.payload);
  if (o.operation_type === "move_table") {
    return { vacates: typeof p.from_table_id === "string" ? [p.from_table_id] : [], fills: typeof p.to_table_id === "string" ? p.to_table_id : null };
  }
  const sources = Array.isArray(p.source_table_ids) ? (p.source_table_ids as unknown[]).filter((x): x is string => typeof x === "string") : [];
  return { vacates: sources, fills: typeof p.primary_table_id === "string" ? p.primary_table_id : null };
}

/** The bill refs a structural op takes OFF `tableId` (empty when it does not vacate that table). */
export function structuralRefsLeaving(o: OfflineOperation, tableId: string): BillRef[] {
  const p = rec(o.payload);
  if (o.operation_type === "move_table") {
    if (p.from_table_id !== tableId) return [];
    return ((rec(p.bill).orders as BillRef[] | undefined) ?? []).filter((r) => r && (r.order_id || r.order_local));
  }
  const sources = (p.source_table_ids as string[] | undefined) ?? [];
  if (!sources.includes(tableId)) return [];
  const r = rec(p.orders)[tableId] as BillRef | undefined;
  return r && (r.order_id || r.order_local) ? [r] : [];
}

/** Every bill ref a structural op involves (move: the moved bill; merge: every table's bill). */
export function structuralAllRefs(o: OfflineOperation): BillRef[] {
  const p = rec(o.payload);
  if (o.operation_type === "move_table") return ((rec(p.bill).orders as BillRef[] | undefined) ?? []).filter((r) => r && (r.order_id || r.order_local));
  return Object.values(rec(p.orders)).filter((r): r is BillRef => !!r && typeof r === "object" && (!!(r as BillRef).order_id || !!(r as BillRef).order_local));
}

/** 1.0.38 — was this offline move / merge AUTHORITATIVELY refused by the server (its own RPC said no)? A
 *  move parked behind a failed prerequisite / an engine fault / exhausted transient retries was never seen
 *  by the server: it is awaiting recovery (still projected, with attention), not refused. */
export function structuralRefusedByServer(o: OfflineOperation): boolean {
  if (o.status !== "needs_attention") return false;
  if (NOT_A_SERVER_REFUSAL.has(o.last_error_code ?? "") || o.last_error_code === "retry_exhausted") return false;
  return !TRANSIENT_FAULT.test(o.last_error_message ?? "");
}

/** A structural op still projected locally: live, not refused by the server (a refused move moved
 *  nothing — the bill shows on its original table, with attention), and not yet inside the map read at
 *  `mapAt`. A cancelled op never projects. */
export function structuralProjected(o: OfflineOperation, mapAt: number | null): boolean {
  return isStructuralOp(o) && o.status !== "cancelled" && !structuralRefusedByServer(o) && !reflectedIn(o, mapAt);
}

export type LineMeta = {
  ref: LineRef;
  /** Key of the projected order the line belongs to. */
  orderKey: string;
  /** The op that created this line on this device (a round / an earlier edit / an add), or null. */
  creatorOpId: string | null;
  /** Quantity already allocated to locally-captured (unsynced) split legs. */
  paidQty: number;
};

/** One projected order (a canonical bill order, or a locally-created one). */
export type ProjectedOrder = {
  key: string;
  /** Canonical server order id, when known. */
  orderId: string | null;
  /** Local entity id that resolves to the canonical order on replay (offline-created order), or null. */
  orderLocal: string | null;
  /** The order's pos_entity_version at the snapshot, or null when unknown on this device. */
  baseVersion: number | null;
  /** This device's unsynced VERSION-BUMPING ops on this order, in capture order. */
  bumpOps: string[];
  /** True when the server already holds part-payment on it (payment_status ≠ unpaid / collected > 0). */
  partiallyPaid: boolean;
  /** Unsynced split legs captured against it. */
  pendingSplitOps: string[];
};

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/** True when this op's effect is already inside a canonical snapshot fetched at `fetchedAt`. */
export function reflectedIn(op: OfflineOperation, fetchedAt: number | null): boolean {
  if (op.status !== "synced" || fetchedAt == null) return false;
  const t = Date.parse(op.synced_at ?? "");
  return Number.isFinite(t) && t <= fetchedAt;
}

function live(op: OfflineOperation): boolean {
  return op.status !== "cancelled";
}

/** rc.13 — a refusal whose text proves the bill is ALREADY closed on the server (paid / settled elsewhere). */
const ALREADY_CLOSED = /already paid|already settled|no open order/i;

/** 1.0.38 (S5 / Bug 9) — the settle handlers' structured bill-binding refusal codes (pay_table / on-account). */
const BILL_BINDING_REFUSALS = new Set(["pay_bill_changed", "pay_amount_changed", "on_account_bill_changed", "on_account_amount_changed", "payment_residue"]);

/** 1.0.38 — needs_attention codes written by the ORCHESTRATOR (never by the settle's own RPC): the server
 *  never saw this settle, so it was not refused — it is parked behind a prerequisite / an engine fault. */
const NOT_A_SERVER_REFUSAL = new Set(["dependency_failed", "missing_dependency", "circular_dependency", "unknown_handler", "engine_error", "awaiting_parked_prerequisite"]);
/** 1.0.38 — transient server / auth faults that 1.0.37 mis-parked as terminal (C1): not a refusal either. */
const TRANSIENT_FAULT =
  /jwt|refresh token|internal server error|bad gateway|service unavailable|gateway time-?out|upstream connect|timed out|deadlock detected|could not serialize|could not obtain lock|too many connections|remaining connection slots|read-only transaction/i;

/**
 * 1.0.38 — was this settle AUTHORITATIVELY refused by the server (its own canonical RPC said no, and not
 * because the bill is already closed)? Only that re-opens a bill the cashier already settled.
 */
export function settleRefusedByServer(o: OfflineOperation): boolean {
  if (o.status !== "needs_attention") return false;
  const msg = o.last_error_message ?? "";
  // 1.0.38 (Bug 9) — a structured bill/amount refusal is a refusal whatever its wording (a server message
  // such as "part of this bill was already paid" must never read as "closed elsewhere" → fake settled).
  if (BILL_BINDING_REFUSALS.has(o.last_error_code ?? "")) return true;
  if (ALREADY_CLOSED.test(msg)) return false;
  if (NOT_A_SERVER_REFUSAL.has(o.last_error_code ?? "")) return false;
  return !TRANSIENT_FAULT.test(msg);
}

/**
 * rc.13 / 1.0.38 — does a captured settle still close the bill it covers? Valid (pending / blocked /
 * retrying / syncing / synced) → yes. Parked (needs_attention) but NOT refused by the server (a failed /
 * missing prerequisite, an engine fault, a transient fault mis-parked by 1.0.37) → yes: the cashier took
 * the money, the settle is awaiting recovery, the bill must never reopen as payable (BUG 1). Refused by the
 * server → only when the refusal proves the bill is already closed; any other authoritative refusal
 * (shift-less order, permission, validation, version drift) means the money was NOT applied → the bill
 * stays ACTIVE (SETTLEMENT_CONFLICT), shown with the refusal, never as paid.
 */
export function settleStillCovers(o: OfflineOperation): boolean {
  if (o.status === "cancelled") return false;
  return !settleRefusedByServer(o);
}

/** 1.0.38 (G1) — a captured op that CLOSES a table's bill: a pay / on-account, or the split leg that paid
 *  everything still open on it (captured with `covers` + `table_id`, see dineinOffline.splitOperationalBillOffline). */
export function isTableSettleOp(o: OfflineOperation): boolean {
  if (o.operation_type === "pay_table" || o.operation_type === "on_account_table") return true;
  const p = rec(o.payload);
  return o.operation_type === "split_settle" && typeof p.table_id === "string" && Object.keys(rec(p.covers)).length > 0;
}

/** 1.0.38 (G1) — a live settle captured on top of an offline move / merge the server then REFUSED, while that
 *  op was still projected (captured before the refusing attempt): the cashier collected the bill the op had
 *  brought over, so that bill is HELD by this settle. A settle captured after the refusal never is (the op's
 *  bill was already back on its own table, outside what was paid). */
export function settleHeldByRefusedStructural(settle: OfflineOperation, s: OfflineOperation): boolean {
  if (settle.operation_type !== "pay_table" && settle.operation_type !== "on_account_table") return false;
  if (!live(settle) || !settleStillCovers(settle) || !isStructuralOp(s) || !structuralRefusedByServer(s)) return false;
  return settle.dependency_ids.includes(s.operation_id) && typeof s.last_attempt_at === "string" && settle.created_at <= s.last_attempt_at;
}

/** 1.0.38 (G1) — a split leg the SERVER reported as having paid its whole order (`parent_completed`). */
export function splitCompletedOrder(o: OfflineOperation): string | null {
  if (o.operation_type !== "split_settle" || o.status !== "synced" || o.result_meta?.parent_completed !== true) return null;
  return typeof o.canonical_entity_id === "string" && o.canonical_entity_id !== "" ? o.canonical_entity_id : null;
}

/** 1.0.38 — a covering settle parked for the operator (not refused): the bill stays closed + HELD. */
export function settleAwaitingRecovery(o: OfflineOperation): boolean {
  return o.status === "needs_attention" && settleStillCovers(o) && !ALREADY_CLOSED.test(o.last_error_message ?? "");
}

/**
 * 1.0.38 — THE payment precedence rule, shared by the Dine-In floor, the Delivery queue and Orders History
 * (one rule, never three). Against a canonical snapshot read at `snapshotAt`, a captured settle is:
 *   "pending"   — valid, not yet confirmed (incl. awaiting recovery): it WINS over the older snapshot;
 *   "confirmed" — synced AFTER the snapshot was read: it WINS (the snapshot predates it);
 *   "reflected" — synced at/before the snapshot read: the snapshot already shows it — the snapshot stands.
 *                 Also a refusal proving the order was ALREADY closed server-side: this device's payment
 *                 was not applied, the canonical row is the truth (never a payment claimed by this device);
 *   "refused"   — cancelled, or authoritatively refused by the server: it never claims payment.
 * (The floor additionally keeps an already-closed bill CLOSED on a stale map — `settleStillCovers`.)
 */
export type SettlePrecedence = "pending" | "confirmed" | "reflected" | "refused";
export function settlePrecedence(o: OfflineOperation, snapshotAt: number | null): SettlePrecedence {
  if (!settleStillCovers(o)) return "refused";
  if (o.status === "needs_attention" && ALREADY_CLOSED.test(o.last_error_message ?? "")) return "reflected";
  if (o.status !== "synced") return "pending";
  return reflectedIn(o, snapshotAt) ? "reflected" : "confirmed";
}

/** 1.0.38 — every order id a dine-in table settle closes: its recorded canonical orders, its local session,
 *  and that session's canonical order (`resolve`: local session id → canonical order id, when known). */
export function settleCoveredIds(s: OfflineOperation, resolve: (localId: string) => string | null | undefined): string[] {
  const cv = rec(rec(s.payload).covers);
  const out = new Set<string>(((cv.order_ids as string[] | undefined) ?? []).filter((x) => typeof x === "string" && x !== ""));
  if (typeof cv.session_local === "string" && cv.session_local !== "") {
    out.add(cv.session_local);
    const c = resolve(cv.session_local);
    if (c) out.add(c);
  }
  return [...out];
}

export function opInScope(op: OfflineOperation, s: ProjectionScope): boolean {
  return (
    op.scope.tenant_id === s.tenantId &&
    (op.scope.branch_id ?? null) === (s.branchId ?? null) &&
    op.scope.cashier_user_id === s.cashierUserId &&
    op.scope.device_id === s.deviceId &&
    (s.terminalId == null || (op.scope.terminal_id || null) === s.terminalId)
  );
}

function unitOf(base: number, mods: { price_delta: number; quantity: number }[]): number {
  return base + mods.reduce((s, m) => s + Number(m.price_delta) * Number(m.quantity ?? 1), 0);
}

type EditPayloadShape = {
  payload?: Record<string, unknown>;
  order_local?: string | null;
  target_ref?: EditTargetRef | null;
  preview_items?: PreviewLine[];
};

/** Display-only preview of lines added offline (the add RPC carries no prices — the server resolves
 *  them; this is the captured menu price shown until sync). */
export type PreviewLine = {
  client_line_id: string;
  menu_item_id: string | null;
  name: string;
  base_price: number;
  quantity: number;
  kitchen_note: string | null;
  modifiers: { group_id: string | null; option_id: string | null; name: string; price_delta: number; quantity: number }[];
};

/** Apply ONE item mutation op to an order's lines (mirrors the server's edit semantics exactly:
 *  an increase keeps the target and appends a delta line; a decrease / removal / modifier change
 *  replaces the target with a new line; an add appends lines). Returns false when the target line is
 *  not in the projection (left untouched — never guessed). */
function applyItemOp(
  op: OfflineOperation,
  order: BillOrder,
  orderKey: string,
  meta: Map<string, LineMeta>,
): boolean {
  const p = rec(op.payload) as EditPayloadShape;
  const body = rec(p.payload);
  const nextBatch = () => order.lines.reduce((m, l) => Math.max(m, l.batch_no), 0) + 1;
  if (op.operation_type === "add_order_items") {
    const items = Array.isArray(p.preview_items) ? p.preview_items : [];
    if (items.length === 0) return false;
    const batch = nextBatch();
    for (const it of items) {
      const unit = unitOf(it.base_price, it.modifiers);
      order.lines.push({
        id: it.client_line_id,
        menu_item_id: it.menu_item_id,
        name: it.name,
        quantity: it.quantity,
        base_price: it.base_price,
        modifiers_total: unit - it.base_price,
        final_unit_price: unit,
        line_total: unit * it.quantity,
        kitchen_note: it.kitchen_note,
        batch_no: batch,
        modifiers: it.modifiers.map((m) => ({ group_id: m.group_id, option_id: m.option_id, name: m.name, price_delta: m.price_delta, quantity: m.quantity })),
      });
      meta.set(it.client_line_id, { ref: { kind: "local", line_local: it.client_line_id, batch_no: null }, orderKey, creatorOpId: op.operation_id, paidQty: 0 });
    }
    return true;
  }
  // edit_order_line
  const ref = p.target_ref;
  const targetId =
    ref?.kind === "canonical" ? ref.order_item_id : ref?.kind === "local" ? ref.line_local : ref?.kind === "after" ? `after:${ref.op_id}` : String(body.target_item_id ?? "");
  const idx = order.lines.findIndex((l) => l.id === targetId);
  if (idx < 0) return false;
  const line = order.lines[idx];
  const newId = `after:${op.operation_id}`;
  const setMeta = () => meta.set(newId, { ref: { kind: "after", op_id: op.operation_id }, orderKey, creatorOpId: op.operation_id, paidQty: 0 });
  if (body.op === "set_quantity") {
    const n = Number(body.new_quantity);
    if (!Number.isFinite(n) || n < 0 || n === line.quantity) return false;
    if (n > line.quantity) {
      const delta = n - line.quantity;
      order.lines.push({ ...line, id: newId, quantity: delta, line_total: line.final_unit_price * delta, batch_no: nextBatch() });
      setMeta();
      return true;
    }
    // rc.11 — a REDUCTION replaces the line IN PLACE (same position / round) on the projection, so the
    // operator sees the quantity drop where the item is — not the item vanish from its round and
    // reappear as a new one (the rc.10 "decrease did nothing" report). The server's own batch numbering
    // takes over after sync; totals, ids and the edit chain are unchanged.
    meta.delete(line.id);
    if (n > 0) {
      order.lines.splice(idx, 1, { ...line, id: newId, quantity: n, line_total: line.final_unit_price * n });
      setMeta();
    } else {
      order.lines.splice(idx, 1);
    }
    return true;
  }
  if (body.op === "change_modifiers") {
    const q = Number(body.quantity ?? line.quantity);
    const mods = (Array.isArray(body.modifiers) ? body.modifiers : []) as { group_id: string | null; option_id: string | null; name: string; price_delta: number; quantity: number }[];
    const unit = unitOf(line.base_price, mods);
    meta.delete(line.id);
    // rc.11 — in place, like a reduction (see above).
    order.lines.splice(idx, 1, {
      ...line,
      id: newId,
      quantity: q,
      modifiers_total: unit - line.base_price,
      final_unit_price: unit,
      line_total: unit * q,
      modifiers: mods.map((m) => ({ group_id: m.group_id ?? null, option_id: m.option_id ?? null, name: m.name, price_delta: Number(m.price_delta), quantity: Number(m.quantity ?? 1) })),
    });
    setMeta();
    return true;
  }
  return false;
}

function recomputeOrder(o: BillOrder): void {
  o.lines.sort((a, b) => a.batch_no - b.batch_no);
  o.subtotal = o.lines.reduce((s, l) => s + l.line_total, 0);
  o.total_amount = Math.max(0, o.subtotal - (o.discount_amount ?? 0));
}

// ---------------------------------------------------------------------------
// Dine-In — one projection per table
// ---------------------------------------------------------------------------

export type OperationalTableBill = {
  tableId: string;
  /** The ONE bill every surface renders (sidebar, Add Items, payment, split, print). */
  bill: TableBill;
  orders: ProjectedOrder[];
  meta: Map<string, LineMeta>;
  /** Gross open-bill total (== the Map/List card total, == bill.total). */
  gross: number | null;
  /** Already collected on the server (paid split legs, from the cached map row). */
  collected: number;
  /** Captured on this device in unsynced split legs. */
  paidPending: number;
  /** What remains to be paid: gross − collected − paidPending (0 once a settle is captured). */
  outstanding: number | null;
  currency: CurrencyCode | null;
  /** Unsynced ops that make up this projection's local delta (display: incl. parked ones). */
  mutationOpIds: string[];
  /** 1.0.38 (C3) — the unsynced, NOT parked mutations: the ONLY ones a new settle may depend on (a
   *  needs_attention edit / leg would make the settle dead at capture — dependency_failed). */
  pendingMutationOpIds: string[];
  /** Ops in this projection parked for the operator (needs_attention). */
  attention: number;
  /** 1.0.38 — the parked (needs_attention) item ops / legs / rounds: shown as attention items, never
   *  applied to the payable bill. */
  attentionOpIds: string[];
  /** 1.0.38 — the server's refusal text of the latest REFUSED settle of this table (SETTLEMENT_CONFLICT). */
  refusedSettleMessage: string | null;
  /** The latest captured, not-yet-reflected settle / on-account of this table (its covered bill is
   *  closed locally; a NEW session on the table chains its open after it). */
  settlingOpId: string | null;
  /** rc.10 — the table's bill was fully settled locally and nothing new is open: the table is
   *  AVAILABLE for a new order (the settled bill stays in history until it syncs). */
  settledLocally: boolean;
  /** rc.13 — a captured settle of this table was REFUSED by the server: the bill is still ACTIVE + unpaid
   *  (SETTLEMENT_CONFLICT) — it needs operator review, never shown as paid. */
  settlementConflict: boolean;
  /** True when part of the bill is known only as a canonical SUMMARY (no cached lines). */
  summaryOnly: boolean;
  /** The local session, when one exists. */
  sessionId: string | null;
  /** 1.0.38 (Bugs 5/6) — the unsynced offline move / merge ops that brought this bill (or part of it) to
   *  this table: every later round / settle / split / edit of it must replay AFTER them (barrier). */
  structuralOpIds: string[];
  /** 1.0.38 — the latest unsynced offline move / merge that took this table's bill AWAY (the table is
   *  free locally); a new bill opened here replays after it. */
  vacatedByOpId: string | null;
  /** 1.0.38 — nothing is open here because an offline move / merge took the bill away: AVAILABLE. */
  vacatedLocally: boolean;
  /** 1.0.38 — the op that freed this table locally (the later of the settle / the vacating move-merge),
   *  or null. A new bill on the table (or a bill moved onto it) replays after it. */
  freedByOpId: string | null;
};

function draftLineToBill(l: DineDraftLine, batch: number): BillLine {
  const mods = l.modifiers.map((m) => ({ group_id: m.group_id ?? null, option_id: m.option_id ?? null, name: m.name, price_delta: Number(m.price_delta), quantity: Number(m.quantity ?? 1) }));
  const unit = unitOf(l.base_price, mods);
  return {
    id: l.line_id,
    menu_item_id: l.menu_item_id,
    name: l.name,
    quantity: l.quantity,
    base_price: l.base_price,
    modifiers_total: unit - l.base_price,
    final_unit_price: unit,
    line_total: unit * l.quantity,
    kitchen_note: l.kitchen_note,
    batch_no: batch,
    modifiers: mods,
  };
}

/**
 * PURE — merge everything this device knows about one table into ONE operational bill.
 * `ops` = this scope's operations (any status; filtered here).
 */
export function projectTableBill(input: {
  tableId: string;
  mapRow: TableSummary | null;
  canonical: { bill: TableBill; fetchedAt: number } | null;
  draft: DineDraft | null;
  ops: OfflineOperation[];
  /** 1.0.38 — when the map that shows this table FREE was read (read START). With no canonical bill, a
   *  synced op at or before it is already inside that (closed) server state — never re-added as a ghost
   *  unpaid balance on a table the server shows free. */
  freeMapAt?: number | null;
  /** 1.0.38 — when the map holding this table was read (read START): an offline move / merge synced at or
   *  before it is inside the canonical floor and is no longer projected. Defaults to the snapshot time. */
  mapAt?: number | null;
}): OperationalTableBill {
  // Final Foundation (PERF) — only the op types this projection ever examines (dine-in open / round /
  // settle / split / move / merge / item edits; every rule below tests one of them). Takeaway sales,
  // payouts, customers, delivery edits … never change a table bill, so dropping them first is EXACT and
  // keeps the per-table cost proportional to dine-in work instead of the whole log.
  // The filtered set and its status-INDEPENDENT orderings (capture order, id lookups) are built once per
  // ops array and shared by every table of a floor pass (see indexTableOps); everything status-dependent is
  // still evaluated per call.
  const ix = indexTableOps(input.ops);
  if (ix.ops !== input.ops) input = { ...input, ops: ix.ops };
  const { tableId, mapRow } = input;
  const fetchedAt = input.canonical?.fetchedAt ?? input.freeMapAt ?? null;
  const structAt = input.mapAt !== undefined ? input.mapAt : fetchedAt;
  const meta = new Map<string, LineMeta>();
  const porders: ProjectedOrder[] = [];
  const bills: BillOrder[] = [];
  let summaryOnly = false;

  // 0b — 1.0.38 OFFLINE MOVE / MERGE that took (part of) this table's bill AWAY: those canonical orders
  // leave this table's active bill (the table is free locally). A REFUSED / parked one moved nothing —
  // the bill stays here, with an attention badge (never silently re-applied).
  const structural = ix.structural; // = [...ops].filter(isStructuralOp).sort(by created_at) (stable)
  const vacatedOrders = new Set<string>();
  let vacatedByOpId: string | null = null;
  let vacatedAt = "";
  const parkedStructural: string[] = [];
  for (const s of structural) {
    const t = structuralTables(s);
    const involved = t.vacates.includes(tableId) || t.fills === tableId;
    if (!involved || s.status === "cancelled") continue;
    if (s.status === "needs_attention") parkedStructural.push(s.operation_id);
    if (!structuralProjected(s, structAt)) continue;
    if (t.fills === tableId) {
      // A LATER move brought (some of) them back here (A→B, then B→A): they are this table's again.
      for (const r of structuralAllRefs(s)) if (r.order_id) vacatedOrders.delete(r.order_id);
      continue;
    }
    for (const r of structuralRefsLeaving(s, tableId)) if (r.order_id) vacatedOrders.add(r.order_id);
    vacatedByOpId = s.operation_id;
    vacatedAt = s.created_at;
  }
  // A move/merge that brought this session's bill HERE and is still unsynced: the bill's barrier.
  const carrier = input.draft?.carried_op_id ? ix.firstById.get(input.draft.carried_op_id) : undefined;
  const carriedActive = !!carrier && structuralProjected(carrier, structAt) && Array.isArray(input.draft?.carried_orders) && structuralTables(carrier).fills === tableId;
  const structuralOpIds = structural
    .filter((s) => structuralProjected(s, structAt) && structuralTables(s).fills === tableId)
    .map((s) => s.operation_id);

  // 0 — LOCAL SETTLEMENT (rc.10). A captured, not-yet-reflected settle / on-account of this table
  // closes EXACTLY the bill it recorded (`covers`): those canonical orders, that local session, the
  // canonical summary. Closed parts leave the ACTIVE bill (the table becomes reusable) but stay in
  // history (the draft + op are durable). Ops captured before rc.10 carry no `covers`: they close the
  // session they depend on and every canonical order already in a snapshot fetched before they were
  // captured (and the summary) — exactly the bill that was on screen when they were taken.
  const tableSettles = (ix.settlesByTable.get(tableId) ?? []).filter((o) => live(o) && !reflectedIn(o, fetchedAt)); // = sorted ∩ isTableSettleOp ∩ table_id === tableId
  // 1.0.38 (G1) — a payment captured AFTER an offline move / merge that the server then REFUSED: the bill
  // that op would have taken off this table never left it server-side, but the cashier already collected it
  // inside that payment (parked behind the refusal, never sent). It is HELD by that payment here too — never
  // collectible a second time (no "source collectible + destination paid" for the same value).
  const heldSessions = new Set<string>();
  const heldSettles: OfflineOperation[] = [];
  for (const s of structural) {
    if (s.status === "cancelled" || !structuralRefusedByServer(s) || !structuralTables(s).vacates.includes(tableId)) continue;
    const sp = rec(s.payload);
    const session = s.operation_type === "move_table" ? sp.session_local : rec(sp.session_locals)[tableId];
    for (const o of input.ops) {
      if (reflectedIn(o, fetchedAt) || !settleHeldByRefusedStructural(o, s)) continue;
      if (!heldSettles.includes(o)) heldSettles.push(o);
      if (typeof session === "string" && session !== "") heldSessions.add(session);
      for (const r of structuralRefsLeaving(s, tableId)) if (r.order_local) heldSessions.add(r.order_local);
    }
  }
  // rc.13 — a settle the SERVER REFUSED never keeps the bill closed (SETTLEMENT_CONFLICT): the money was
  // not applied, so the bill is still the table's active, unpaid bill — shown with attention, never as
  // paid. (rc.12 kept a refused settle covering the bill offline; after reconnect the raw server map then
  // "resurrected" it.) Only a refusal that proves the bill is ALREADY closed server-side still covers it.
  // 1.0.38 — a settle merely PARKED (prerequisite failed / transient fault) still covers it (BUG 1).
  // (= settlePrecedence's pending / confirmed, plus the floor-only rule: a bill proven closed elsewhere
  // stays closed on a stale map — never offered for a second payment.)
  const settleOps = [...tableSettles.filter((o) => settleStillCovers(o)), ...heldSettles.filter((o) => !tableSettles.includes(o))].sort((a, b) =>
    a.created_at.localeCompare(b.created_at),
  );
  const refusedSettles = tableSettles.filter((o) => !settleStillCovers(o));
  const coveredOrders = new Set<string>();
  let coveredSummary = false;
  const coveredSessions = new Set<string>(heldSessions);
  for (const s of structural) {
    if (s.status === "cancelled" || !structuralRefusedByServer(s) || !heldSettles.some((h) => h.dependency_ids.includes(s.operation_id))) continue;
    for (const r of structuralRefsLeaving(s, tableId)) if (r.order_id) coveredOrders.add(r.order_id);
  }
  // 1.0.38 (G1) — an order a split leg PAID IN FULL (server: parent_completed) is closed for good: never
  // this table's open bill again, whatever an older snapshot / map summary still shows (closure is monotonic).
  const completedLegs = ix.splitsInput.filter((o) => splitCompletedOrder(o) != null); // only a split leg can qualify
  const completedOrders = new Set(completedLegs.map((o) => splitCompletedOrder(o) as string));
  const completedNumbers = new Map<string, string>();
  for (const o of completedOrders.size > 0 ? ix.roundsInput : []) {
    const num = o.result_meta?.order_number;
    if (o.operation_type === "dinein_send_round" && o.canonical_entity_id && completedOrders.has(o.canonical_entity_id) && typeof num === "string" && num !== "") {
      completedNumbers.set(num, o.canonical_entity_id);
    }
  }
  for (const id of completedOrders) coveredOrders.add(id);
  for (const s of settleOps) {
    const cv = rec(rec(s.payload).covers);
    if (Object.keys(cv).length > 0) {
      for (const id of (cv.order_ids as string[] | undefined) ?? []) coveredOrders.add(id);
      if (cv.summary === true) coveredSummary = true;
      if (typeof cv.session_local === "string") coveredSessions.add(cv.session_local);
    } else {
      const at = Date.parse(s.created_at);
      if (fetchedAt != null && Number.isFinite(at) && fetchedAt <= at) for (const o of input.canonical?.bill.orders ?? []) coveredOrders.add(o.id);
      coveredSummary = true;
    }
  }
  // rc.13 — a covered session's OWN canonical order (created by its round 1 after the settle was captured:
  // `covers.order_ids` could not name it yet) is closed too. Without this, a canonical bill fetched after
  // the round synced but before the settle synced showed that order UNPAID again — the F1 resurrection.
  if (coveredSessions.size > 0) {
    const sessionOrder = new Map<string, string>();
    const coveredNumbers = new Set<string>();
    for (const o of ix.roundsInput) {
      if (o.operation_type === "dinein_send_round" && o.canonical_entity_id && o.local_entity_id && coveredSessions.has(o.local_entity_id)) {
        sessionOrder.set(o.local_entity_id, o.canonical_entity_id);
        const num = o.result_meta?.order_number;
        if (typeof num === "string" && num !== "") coveredNumbers.add(num);
      }
    }
    for (const s of settleOps) for (const id of settleCoveredIds(s, (l) => sessionOrder.get(l))) coveredOrders.add(id);
    // 1.0.38 (G1) — a session HELD by a payment captured after its refused move / merge: its own order too.
    for (const sid of heldSessions) {
      const c = sessionOrder.get(sid);
      if (c) coveredOrders.add(c);
    }
    // 1.0.38 (E2E-a) — the same F1 rule for a map SUMMARY (no cached bill): an online floor read after the
    // session's round synced but before its settle synced shows that ONE order as the table's open bill. When
    // the summary is exactly one order and its number is the covered session's canonical order (round 1's
    // server-returned order_number), it is closed too — through 1.0.38-dev it reappeared as an unpaid bill.
    if (!coveredSummary && mapRow && mapRow.orders === 1 && typeof mapRow.order_number === "string" && coveredNumbers.has(mapRow.order_number)) coveredSummary = true;
  }
  // rc.11 — the LEGACY rule (a pre-rc.10 settle with no `covers`, matched only by its dependency on the
  // session's open) closes the session ONLY when no round was sent AFTER that settle: a later round is
  // an active bill on the table and must stay visible (never hidden behind an old payment).
  const legacyCovers = (s: OfflineOperation, d: DineDraft): boolean => {
    if (!s.dependency_ids.includes(d.open_operation_id)) return false;
    const at = Date.parse(s.created_at);
    return !d.rounds.some((r) => Number.isFinite(at) && Date.parse(r.sent_at) > at);
  };
  if (!coveredSummary && mapRow && mapRow.orders === 1 && typeof mapRow.order_number === "string" && completedNumbers.has(mapRow.order_number)) coveredSummary = true;
  // 1.0.38 (G1) — a session whose order a split leg paid in full is closed too — unless it holds work still
  // replaying after that (then it is the active bill and stays, with that work's own outcome).
  const opById = (id: string) => ix.firstById.get(id);
  const draftCompleted =
    input.draft != null &&
    completedLegs.some((l) => l.canonical_entity_id === input.draft?.canonical_order_id || rec(l.payload).order_local === input.draft?.local_session_id) &&
    input.draft.rounds.every((r) => {
      const o = opById(r.operation_id);
      return !o || o.status === "synced" || o.status === "cancelled";
    });
  const draftSettled =
    input.draft != null &&
    (draftCompleted ||
      coveredSessions.has(input.draft.local_session_id) ||
      settleOps.some((s) => Object.keys(rec(rec(s.payload).covers)).length === 0 && legacyCovers(s, input.draft as DineDraft)));
  const draft = draftSettled ? null : input.draft;
  // The op that FREED the table locally: the latest settle, or a not-yet-reflected split leg that completed the
  // order on it (a new bill here chains after it and takes no CAS from a stale map — see openTableOffline).
  // Was that order on THIS table? Its snapshot / session / map summary says so, or — on a stale FREE map — the
  // table its rounds were sent to (an offline move / merge that later brought it elsewhere is honoured).
  const orderTable = (id: string): string | null => {
    let at: string | null = null;
    let when = "";
    const sessions = new Set(input.ops.filter((o) => o.operation_type === "dinein_send_round" && o.canonical_entity_id === id && o.local_entity_id).map((o) => o.local_entity_id as string));
    for (const o of input.ops) {
      if (o.status === "cancelled" || o.created_at < when) continue;
      if (o.operation_type === "dinein_send_round" && o.canonical_entity_id === id) {
        const t = rec(rec(o.payload).submit).table_id;
        if (typeof t === "string") [at, when] = [t, o.created_at];
      } else if (isStructuralOp(o) && o.status === "synced" && structuralAllRefs(o).some((r) => r.order_id === id || (r.order_local != null && sessions.has(r.order_local)))) {
        const f = structuralTables(o).fills;
        if (f) [at, when] = [f, o.created_at];
      }
    }
    return at;
  };
  const completedHere = completedLegs.filter((l) => {
    if (reflectedIn(l, fetchedAt)) return false;
    const id = l.canonical_entity_id as string;
    const num = [...completedNumbers.entries()].find(([, v]) => v === id)?.[0];
    return (
      (input.canonical?.bill.orders ?? []).some((o) => o.id === id) ||
      (input.draft != null && (input.draft.canonical_order_id === id || rec(l.payload).order_local === input.draft.local_session_id)) ||
      (mapRow != null && mapRow.orders === 1 && num != null && mapRow.order_number === num) ||
      orderTable(id) === tableId
    );
  });
  const freeing = [...settleOps, ...completedHere].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const lastSettleOpId = freeing.length > 0 ? freeing[freeing.length - 1].operation_id : null;
  // 1.0.38 — a bill moved here offline carries the server-collected amount of its source table.
  const collected = Math.max(0, Number(mapRow?.collected ?? 0) || 0) + (carriedActive ? Math.max(0, Number(input.draft?.carried_collected ?? 0) || 0) : 0);
  // 1.0.38 — after an unsynced offline move / merge the server versions of the bill's orders are not known
  // on this device: line edits wait for the sync (never a guessed CAS). Rounds / splits / settles chain.
  const versionKnown = structuralOpIds.length === 0;

  // 1 — canonical snapshot (cached bill), else the canonical SUMMARY from the cached map row. 1.0.38 — plus
  // the canonical orders a still-unsynced offline move CARRIED here; minus the ones it moved away.
  const canonAll: BillOrder[] = [];
  for (const o of [...(input.canonical?.bill.orders ?? []), ...(carriedActive ? (input.draft?.carried_orders ?? []) : [])]) {
    if (!canonAll.some((x) => x.id === o.id)) canonAll.push(o); // one order once (a bill moved back here)
  }
  const canonOrders = canonAll.filter((o) => !coveredOrders.has(o.id) && !vacatedOrders.has(o.id));
  const canonCoveredAll = canonAll.length > 0 && canonOrders.length === 0;
  if (canonOrders.length > 0) {
    for (const o of canonOrders) {
      const copy: BillOrder = { ...o, lines: o.lines.map((l) => ({ ...l, modifiers: [...l.modifiers] })) };
      bills.push(copy);
      porders.push({ key: o.id, orderId: o.id, orderLocal: null, baseVersion: versionKnown ? o.pos_entity_version : null, bumpOps: [], partiallyPaid: o.payment_status !== "unpaid" || collected > 0, pendingSplitOps: [] });
      for (const l of copy.lines) meta.set(l.id, { ref: { kind: "canonical", order_item_id: l.id }, orderKey: o.id, creatorOpId: null, paidQty: 0 });
    }
  } else if (!canonCoveredAll && !coveredSummary && vacatedByOpId == null && mapRow && mapRow.orders > 0 && mapRow.total != null) {
    summaryOnly = true;
    const key = `summary:${tableId}`;
    const total = Number(mapRow.total);
    bills.push({
      id: key,
      order_number: mapRow.order_number ?? "",
      status: "sent_to_kitchen",
      payment_status: collected > 0 ? "partial" : "unpaid",
      pos_entity_version: 0,
      shift_id: null,
      branch_id: draft?.branch_id ?? null,
      tenant_id: draft?.tenant_id ?? "",
      subtotal: total,
      discount_amount: 0,
      total_amount: total,
      currency: (mapRow.currency ?? draft?.currency ?? "USD") as CurrencyCode,
      exchange_rate: null,
      created_at: mapRow.opened_at,
      lines: [
        { id: key, menu_item_id: null, name: "Items sent before going offline", quantity: 1, base_price: total, modifiers_total: 0, final_unit_price: total, line_total: total, kitchen_note: null, batch_no: 0, modifiers: [] },
      ],
    });
    porders.push({ key, orderId: null, orderLocal: null, baseVersion: null, bumpOps: [], partiallyPaid: collected > 0, pendingSplitOps: [] });
    meta.set(key, { ref: { kind: "summary" }, orderKey: key, creatorOpId: null, paidQty: 0 });
  }

  const opsById = ix.lastById; // = new Map(ops.map((o) => [o.operation_id, o])) (last wins)
  const mutationOpIds: string[] = [];
  const pendingMutationOpIds: string[] = [];
  const attentionOpIds: string[] = [];
  let attention = 0;
  const note = (op: OfflineOperation) => {
    mutationOpIds.push(op.operation_id);
    if (op.status === "needs_attention") {
      attention += 1;
      attentionOpIds.push(op.operation_id);
    } else {
      pendingMutationOpIds.push(op.operation_id);
    }
  };
  // 1.0.38 (C3) — a PARKED item edit / add / split leg was never applied by the server: it is an attention
  // item, never part of the payable bill, the version chain, or a new capture's dependencies.
  const parked = (op: OfflineOperation) => op.status === "needs_attention";

  // 2 — local session rounds (unsynced, or synced after the snapshot was fetched).
  if (draft) {
    const boundIdx = draft.canonical_order_id ? bills.findIndex((b) => b.id === draft.canonical_order_id) : -1;
    // An UNBOUND session on a table that already has a canonical bill (cached or summary) appends its
    // round 1 to THAT existing order on the server, whose version is not 0 → its line edits must stay
    // reconnect-only (never a guessed CAS). Only a table opened fresh by this device starts at 0.
    const hadCanonical = bills.length > 0;
    let localIdx = -1;
    const ensureLocal = (): number => {
      if (localIdx >= 0) return localIdx;
      const shift = bills.find((b) => b.shift_id)?.shift_id ?? null;
      bills.push({
        id: draft.local_session_id,
        order_number: draft.canonical_order_id ? "" : "OFFLINE",
        status: "sent_to_kitchen",
        payment_status: "unpaid",
        pos_entity_version: 0,
        shift_id: shift,
        branch_id: draft.branch_id,
        tenant_id: draft.tenant_id,
        subtotal: 0,
        discount_amount: 0,
        total_amount: 0,
        currency: draft.currency as CurrencyCode,
        exchange_rate: null,
        created_at: draft.created_at,
        lines: [],
      });
      // A local order created by this device's round 1 starts at version 0 (rounds never bump it). If
      // the table ALSO has an unbound canonical summary, round 1 actually appends to that unknown order
      // → its version is unknown here → line edits stay reconnect-only (never a guessed CAS).
      porders.push({
        key: draft.local_session_id,
        orderId: draft.canonical_order_id,
        orderLocal: draft.canonical_order_id ? null : draft.local_session_id,
        baseVersion: hadCanonical || !versionKnown ? null : 0,
        bumpOps: [],
        partiallyPaid: false,
        pendingSplitOps: [],
      });
      localIdx = bills.length - 1;
      return localIdx;
    };
    const canonMaxBatch = boundIdx >= 0 ? bills[boundIdx].lines.reduce((m, l) => Math.max(m, l.batch_no), 0) : 0;
    for (const r of [...draft.rounds].sort((a, b) => a.seq - b.seq)) {
      const rop = opsById.get(r.operation_id);
      if (rop && reflectedIn(rop, fetchedAt)) continue; // already inside the canonical snapshot
      if (rop && !live(rop)) continue;
      const lines = draft.lines.filter((l) => l.sent_round === r.seq);
      if (lines.length === 0) continue;
      const idx = boundIdx >= 0 ? boundIdx : ensureLocal();
      const target = bills[idx];
      const batch = boundIdx >= 0 ? canonMaxBatch + r.seq : r.seq;
      for (const l of lines) {
        if (meta.has(l.line_id)) continue; // a duplicate legacy id — never double-count
        target.lines.push(draftLineToBill(l, batch));
        meta.set(l.line_id, { ref: { kind: "local", line_local: l.line_id, batch_no: null }, orderKey: target.id, creatorOpId: r.operation_id, paidQty: 0 });
      }
      if (rop) note(rop);
    }
    // 1.0.38 — the UNPAID lines an unsynced offline MERGE folded into this (primary) bill. Paid lines of a
    // part-paid source never come here (they stay on the source with its payments). Display-only until the
    // merge syncs (their server order changes); a refused merge folds nothing.
    for (const blk of draft.merged_blocks ?? []) {
      const mop = opsById.get(blk.op_id);
      if (!mop || !structuralProjected(mop, structAt) || blk.lines.length === 0) continue;
      const idx = boundIdx >= 0 ? boundIdx : ensureLocal();
      const target = bills[idx];
      const batch = target.lines.reduce((m, l) => Math.max(m, l.batch_no), 0) + 1;
      for (const l of blk.lines) {
        if (meta.has(l.id)) continue;
        target.lines.push({ ...l, modifiers: [...l.modifiers], batch_no: batch });
        meta.set(l.id, { ref: { kind: "merged", op_id: blk.op_id }, orderKey: target.id, creatorOpId: blk.op_id, paidQty: 0 });
      }
    }
  }

  const keyOfOp = (op: OfflineOperation): string | null => {
    const p = rec(op.payload);
    const body = rec(p.payload);
    const orderLocal = typeof p.order_local === "string" ? p.order_local : null;
    const orderId = typeof body.order_id === "string" ? body.order_id : typeof p.order_id === "string" ? p.order_id : null;
    for (const po of porders) {
      if (orderLocal && (po.orderLocal === orderLocal || po.key === orderLocal)) return po.key;
      if (orderId && po.orderId === orderId) return po.key;
    }
    return null;
  };

  // 3 — item mutations, in capture order.
  for (const op of ix.mutationsSorted) {
    // (type test first: the same verdict, without a Date.parse per op per table — profiled)
    if (op.operation_type !== "edit_order_line" && op.operation_type !== "add_order_items" && op.operation_type !== "edit_order") continue;
    if (!live(op) || reflectedIn(op, fetchedAt)) continue;
    const key = keyOfOp(op);
    if (!key) continue;
    const po = porders.find((x) => x.key === key)!;
    const bo = bills.find((b) => b.id === key)!;
    note(op);
    if (parked(op)) continue;
    if (op.operation_type !== "edit_order") applyItemOp(op, bo, key, meta);
    po.bumpOps.push(op.operation_id);
  }

  // 4 — split legs (unsynced) → paid quantities + amount captured.
  let paidPending = 0;
  for (const op of ix.splitsSorted) {
    if (op.operation_type !== "split_settle" || !live(op) || reflectedIn(op, fetchedAt)) continue;
    const key = keyOfOp(op);
    if (!key) continue;
    const po = porders.find((x) => x.key === key)!;
    const bo = bills.find((b) => b.id === key)!;
    if (parked(op)) {
      note(op); // a refused leg: attention only — never counted as paid, never blocks the full settle
      continue;
    }
    const allocs = (rec(op.payload).allocations as { order_item_id?: string | null; line_local?: string | null; quantity: number }[] | undefined) ?? [];
    for (const a of allocs) {
      const id = a.order_item_id ?? a.line_local ?? "";
      const line = bo.lines.find((l) => l.id === id);
      const m = meta.get(id);
      if (!line || !m) continue;
      m.paidQty += Number(a.quantity) || 0;
      paidPending += line.final_unit_price * (Number(a.quantity) || 0);
    }
    po.pendingSplitOps.push(op.operation_id);
    po.bumpOps.push(op.operation_id);
    note(op);
  }

  // 5 — captured settles / on-accounts of this table (the closed bills are already excluded above).
  for (const s of settleOps) if (s.status === "needs_attention") attention += 1;
  attention += refusedSettles.length;
  // 1.0.38 — an offline move / merge that brought the bill here is part of its unsynced delta (and the
  // barrier every later capture of it depends on); a parked one is an attention item on its tables.
  for (const id of structuralOpIds) {
    if (!mutationOpIds.includes(id)) mutationOpIds.push(id);
    if (!pendingMutationOpIds.includes(id)) pendingMutationOpIds.push(id);
  }
  for (const id of parkedStructural) {
    attention += 1;
    attentionOpIds.push(id);
  }

  for (const b of bills) recomputeOrder(b);
  const nonEmpty = bills.filter((b) => b.lines.length > 0);
  const bill = foldBill(tableId, nonEmpty);
  const settleAt = freeing.length > 0 ? freeing[freeing.length - 1].created_at : "";
  const freedByOpId = nonEmpty.length > 0 ? null : vacatedByOpId && vacatedAt >= settleAt ? vacatedByOpId : lastSettleOpId;
  const gross = bill.total;
  // The map row's server-collected amount belongs to the canonical bill; once that bill is settled
  // locally it no longer reduces the (new) active bill.
  const activeCollected = canonCoveredAll || coveredSummary ? 0 : collected;
  const outstanding = gross == null ? null : Math.max(0, Math.round((gross - activeCollected - paidPending) * 100) / 100);
  return {
    tableId,
    bill,
    orders: porders.filter((p) => nonEmpty.some((b) => b.id === p.key)),
    meta,
    gross,
    collected: activeCollected,
    paidPending,
    outstanding,
    currency: bill.currency,
    mutationOpIds,
    pendingMutationOpIds,
    attention,
    attentionOpIds,
    refusedSettleMessage: refusedSettles.length > 0 ? (refusedSettles[refusedSettles.length - 1].last_error_message ?? "refused by the server") : null,
    settlingOpId: lastSettleOpId,
    settledLocally: lastSettleOpId != null && nonEmpty.length === 0,
    settlementConflict: refusedSettles.length > 0 && nonEmpty.length > 0,
    summaryOnly,
    sessionId: draft?.local_session_id ?? null,
    structuralOpIds,
    vacatedByOpId,
    vacatedLocally: vacatedByOpId != null && nonEmpty.length === 0,
    freedByOpId,
  };
}

/**
 * rc.13 — PURE. The canonical orders of an operational bill that the server holds WITHOUT a shift
 * (created by an rc.4–rc.11 offline round). `_pos_lock_open_shift` refuses every settle / split /
 * on-account / move / merge / void of such an order, so a local settle of it can never apply — it must
 * NOT be presented as settled offline (LOCAL SUCCESS RULE). Exempt: an order this device is about to
 * attach to its shift — a bound local session with a shift reference whose round appends to it (the
 * server's append sets shift_id = coalesce(round shift, shift_id)).
 */
export function shiftlessCanonicalOrders(bill: { orders: { id: string; order_number?: string | null; shift_id?: string | null }[] }, draft: DineDraft | null): { id: string; order_number: string }[] {
  return bill.orders
    .filter((o) => !o.shift_id)
    .filter((o) => !o.id.startsWith("summary:"))
    .filter((o) => !(draft && draft.local_session_id === o.id))
    .filter((o) => !(draft && draft.canonical_order_id === o.id && (draft.shift_id || draft.shift_local) && draft.rounds.length > 0))
    .map((o) => ({ id: o.id, order_number: o.order_number ?? "" }));
}

/** rc.13 — the controlled refusal for a bill held without a shift (never a fake local settlement). */
export function shiftlessRefusal(orders: { order_number: string }[]): string {
  const nums = orders.map((o) => (o.order_number ? `#${o.order_number}` : "")).filter(Boolean).join(", ");
  return `This bill${nums ? ` (${nums})` : ""} is not attached to a shift on the server, so it cannot be settled — offline or online. A manager must resolve it online first.`;
}

/** rc.14 — ONLINE: the actionable explanation for a historical shift-less bill (pay / move / merge are
 *  refused by the server; its ownership is never re-attributed to a current shift automatically). */
export function historicalShiftlessNotice(orders: { order_number: string }[]): string {
  const nums = orders.map((o) => (o.order_number ? `#${o.order_number}` : "")).filter(Boolean).join(", ");
  return `This bill${nums ? ` (${nums})` : ""} was created without a valid shift and cannot be paid, moved or merged automatically. Use an online manager reconciliation for it.`;
}

/** rc.13 (Konan) — the controlled refusal for a bill known only as a map summary (shift unprovable). */
export const SUMMARY_ONLY_SETTLE_MESSAGE =
  "Part of this bill was sent before this device went offline, so it can't be confirmed as settleable offline. Reconnect to settle it.";

/** Final Foundation (PERF) — the op types the table-bill projection reads (see projectTableBill). */
const TABLE_PROJECTION_TYPES = new Set([
  "dinein_open_table",
  "dinein_send_round",
  "pay_table",
  "on_account_table",
  "split_settle",
  "move_table",
  "merge_tables",
  "edit_order_line",
  "add_order_items",
  "edit_order",
]);
function isTableProjectionOp(o: OfflineOperation): boolean {
  return TABLE_PROJECTION_TYPES.has(String(o.operation_type));
}

/** Final Foundation (PERF) — per ops-ARRAY (identity + length) derived data of the table projection that
 *  does not depend on any op's mutable status: the table-type subset, its capture-order sort and its id maps.
 *  Profiled (90-day profile, 45 projected tables): re-sorting the whole op set with localeCompare for every
 *  table was the dominant floor cost. Built once, shared by every table of one floor pass, read-only. */
type TableOpsIndex = {
  len: number;
  ops: OfflineOperation[];
  sorted: OfflineOperation[];
  structural: OfflineOperation[];
  firstById: Map<string, OfflineOperation>;
  lastById: Map<string, OfflineOperation>;
  /** Table settle ops (isTableSettleOp) by payload.table_id, capture order. (type + payload are immutable) */
  settlesByTable: Map<unknown, OfflineOperation[]>;
  /** Item mutations (edit_order_line / add_order_items / edit_order) and split legs, capture order. */
  mutationsSorted: OfflineOperation[];
  splitsSorted: OfflineOperation[];
  /** Split legs and rounds in INPUT order (the order the per-table loops iterated before). */
  splitsInput: OfflineOperation[];
  roundsInput: OfflineOperation[];
};
const tableOpsIndexCache = new WeakMap<OfflineOperation[], TableOpsIndex>();
function indexTableOps(raw: OfflineOperation[]): TableOpsIndex {
  const hit = tableOpsIndexCache.get(raw);
  if (hit && hit.len === raw.length) return hit;
  const ops = raw.some((o) => !isTableProjectionOp(o)) ? raw.filter(isTableProjectionOp) : raw;
  const sorted = [...ops].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const firstById = new Map<string, OfflineOperation>();
  const lastById = new Map<string, OfflineOperation>();
  for (const o of ops) {
    if (!firstById.has(o.operation_id)) firstById.set(o.operation_id, o);
    lastById.set(o.operation_id, o);
  }
  // Stable sort: filtering the sorted list == sorting the filtered list.
  const settlesByTable = new Map<unknown, OfflineOperation[]>();
  for (const o of sorted) {
    if (!isTableSettleOp(o)) continue;
    const t = rec(o.payload).table_id;
    const list = settlesByTable.get(t);
    if (list) list.push(o);
    else settlesByTable.set(t, [o]);
  }
  const isMutation = (o: OfflineOperation) => o.operation_type === "edit_order_line" || o.operation_type === "add_order_items" || o.operation_type === "edit_order";
  const ix: TableOpsIndex = {
    len: raw.length,
    ops,
    sorted,
    structural: sorted.filter(isStructuralOp),
    firstById,
    lastById,
    settlesByTable,
    mutationsSorted: sorted.filter(isMutation),
    splitsSorted: sorted.filter((o) => o.operation_type === "split_settle"),
    splitsInput: ops.filter((o) => o.operation_type === "split_settle"),
    roundsInput: ops.filter((o) => o.operation_type === "dinein_send_round"),
  };
  tableOpsIndexCache.set(raw, ix);
  return ix;
}

/** Load this scope's operations once (the projection filters by entity itself). Final Foundation (PERF):
 *  served from the incremental operations mirror (db.ts readAllOperationsMirrored — invalidated per touched
 *  row by EVERY write), so the floor's two passes, a table detail and the delivery overlay share one copy
 *  and a write costs a re-read of only the rows it touched. A fresh filtered array is returned each call;
 *  the op objects are shared and are treated as read-only by every projection (they never were mutated here). */
export async function scopedOperations(scope: ProjectionScope): Promise<OfflineOperation[]> {
  if (!scope.tenantId) return [];
  // The incrementally maintained mirror (db.ts): after a capture only the touched rows are re-read.
  const all = await readAllOperationsMirrored();
  return all.filter((o) => opInScope(o, scope));
}

/** This scope's OPEN local dine-in sessions (one indexed read). 1.0.38 (G1) — NEWEST first, so a per-table
 *  `find` always picks the table's latest session (an older one is never its bill: see sessionClosure). */
export async function openDraftsInScope(scope: ProjectionScope): Promise<DineDraft[]> {
  if (!scope.tenantId) return [];
  // Final Foundation (PERF): the tenant's OPEN sessions only ([tenant_id+status]), not its closed history.
  const all = await localdb.dineDrafts.where("[tenant_id+status]").equals([scope.tenantId, "open"]).toArray();
  return all
    .filter(
      (d) =>
        d.status === "open" &&
        (d.branch_id ?? null) === (scope.branchId ?? null) &&
        d.cashier_user_id === scope.cashierUserId &&
        d.device_id === scope.deviceId &&
        (scope.terminalId == null || (d.terminal_id ?? null) === scope.terminalId),
    )
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.local_session_id.localeCompare(a.local_session_id));
}

// ---------------------------------------------------------------------------
// 1.0.38 (G1) — local SESSION LIFECYCLE TRUTH
// ---------------------------------------------------------------------------

/** Every live op that is part of a local session's bill: its open / rounds / the move-merge that placed it
 *  (barrier, carried snapshot, merged blocks) and every leg / edit / settle / move / merge that names the
 *  session or its canonical order. `missing` counts barrier ops no longer in the log (GC only ever removes
 *  SYNCED ops older than its retention). */
export function sessionWorkOps(d: DineDraft, ops: OfflineOperation[]): { work: OfflineOperation[]; missing: number } {
  const ids = new Set<string>([
    d.open_operation_id,
    ...d.rounds.map((r) => r.operation_id),
    ...(d.structural_op_id ? [d.structural_op_id] : []),
    ...(d.carried_op_id ? [d.carried_op_id] : []),
    ...(d.merged_blocks ?? []).map((b) => b.op_id),
  ]);
  const sid = d.local_session_id;
  const canonical = d.canonical_order_id;
  const touches = (o: OfflineOperation): boolean => {
    const p = rec(o.payload);
    const body = rec(p.payload);
    if (p.order_local === sid || p.session_local === sid || rec(p.covers).session_local === sid) return true;
    if (canonical && (p.order_id === canonical || body.order_id === canonical)) return true;
    if (isStructuralOp(o)) return structuralAllRefs(o).some((r) => r.order_local === sid || (canonical != null && r.order_id === canonical));
    return false;
  };
  const known = new Set(ops.map((o) => o.operation_id));
  const work = ops.filter((o) => o.status !== "cancelled" && (ids.has(o.operation_id) || touches(o)));
  return { work, missing: [...ids].filter((id) => !known.has(id)).length };
}

export type SessionClosure = { status: "settled" | "closed"; reason: "split_completed" | "canonical_closed"; evidenceOpId: string | null };

/**
 * PURE — is this OPEN local session's bill AUTHORITATIVELY closed (so it must never take new work)? A
 * session leaves `open` through this device's own settle capture; this covers everything else:
 *   (a) a SYNCED split leg of its order that the server reported as paying it in full (`parent_completed`);
 *   (b) a canonical floor read that STARTED after every op of the bill had synced no longer shows its order
 *       as the table's open bill — the table is free, its single bill is another order, or a bill read as
 *       fresh does not list it (paid online, closed / voided / moved / merged elsewhere).
 * Never for a session with ANY work still unsynced or parked (recoverable or not): that bill is still the
 * table's active one and keeps its own outcome. Never without a known canonical order (nothing to prove).
 */
export function sessionClosure(
  d: DineDraft,
  ops: OfflineOperation[],
  canon: { row: TableSummary | null; mapAt: number | null; bill?: { bill: TableBill; fetchedAt: number } | null },
): SessionClosure | null {
  if (d.status !== "open") return null;
  const { work, missing } = sessionWorkOps(d, ops);
  if (work.some((o) => o.status !== "synced")) return null;
  const r1 = d.rounds.find((r) => r.seq === 1);
  const r1op = r1 ? work.find((o) => o.operation_id === r1.operation_id) : undefined;
  const canonical = d.canonical_order_id ?? r1op?.canonical_entity_id ?? null;
  if (!canonical) return null;
  const legs = work.filter((o) => splitCompletedOrder(o) === canonical).sort((a, b) => a.created_at.localeCompare(b.created_at));
  if (legs.length > 0) return { status: "settled", reason: "split_completed", evidenceOpId: legs[legs.length - 1].operation_id };
  const { row, mapAt } = canon;
  if (!row || mapAt == null || (work.length === 0 && missing === 0)) return null;
  if (!work.every((o) => reflectedIn(o, mapAt))) return null;
  if (missing > 0 && !(Date.parse(d.updated_at) <= mapAt)) return null;
  const closed: SessionClosure = { status: "closed", reason: "canonical_closed", evidenceOpId: null };
  if (Number(row.orders) === 0) return closed;
  const num = r1op?.result_meta?.order_number;
  if (Number(row.orders) === 1 && typeof row.order_number === "string" && row.order_number !== "" && typeof num === "string" && num !== "" && row.order_number !== num) return closed;
  const b = canon.bill;
  if (b && work.every((o) => reflectedIn(o, b.fetchedAt)) && !(b.bill.orders ?? []).some((o) => o.id === canonical)) return closed;
  return null;
}

/** PURE — does this split leg pay EVERYTHING still open on the table's (single) bill? Then it closes the bill
 *  locally exactly like a settle (the table becomes reusable; a new customer opens a NEW session). Only for a
 *  bill fully known on this device (no summary, no server-held part-payment, every line splittable). */
export function splitCompletesBill(p: OperationalTableBill, orderKey: string, allocations: { order_item_id: string; quantity: number }[]): boolean {
  if (p.summaryOnly || p.collected > 0 || p.orders.length !== 1 || p.bill.orders.length !== 1) return false;
  const order = p.bill.orders[0];
  if (order.id !== orderKey || p.orders[0].key !== orderKey || order.lines.length === 0) return false;
  const alloc = new Map<string, number>();
  for (const a of allocations) alloc.set(a.order_item_id, (alloc.get(a.order_item_id) ?? 0) + (Number(a.quantity) || 0));
  return order.lines.every((l) => {
    const m = p.meta.get(l.id);
    if (!m || (m.ref.kind !== "canonical" && m.ref.kind !== "local")) return false;
    return l.quantity - m.paidQty - (alloc.get(l.id) ?? 0) <= 0;
  });
}

async function openDraftForTable(scope: ProjectionScope, tableId: string): Promise<DineDraft | null> {
  return (await openDraftsInScope(scope)).find((d) => d.table_id === tableId) ?? null;
}

/** `getOperationalTableBill` — the ONE operational bill for a table (async loader over Dexie).
 *  rc.12 — `preloadedDrafts` lets a whole-floor caller read the sessions ONCE (not once per table). */
export async function getOperationalTableBill(
  scope: ProjectionScope,
  table: TableSummary,
  preloadedOps?: OfflineOperation[],
  preloadedDrafts?: DineDraft[],
  /** 1.0.38 — when the map holding `table` was read (read START). Omitted → the cached map's stamp. */
  mapLoadedAt?: number | null,
  /** Final Foundation (PERF) — the table's cached bill, read in bulk by a whole-floor caller (null = none). */
  preloadedBill?: { bill: unknown; cachedAt: number } | null,
): Promise<OperationalTableBill> {
  const free = table.orders === 0;
  const [cached, draft, ops, mapAt] = await Promise.all([
    preloadedBill !== undefined ? Promise.resolve(preloadedBill) : readCachedBill(table.id, scope.tenantId, scope.branchId).catch(() => null),
    preloadedDrafts ? Promise.resolve(preloadedDrafts.find((d) => d.table_id === table.id) ?? null) : openDraftForTable(scope, table.id),
    preloadedOps ? Promise.resolve(preloadedOps) : scopedOperations(scope),
    mapLoadedAt !== undefined
      ? Promise.resolve(mapLoadedAt ?? null)
      : readCachedTableMap(scope.tenantId, scope.branchId).then((m) => m?.cachedAt ?? null).catch(() => null),
  ]);
  const canonical = cached ? { bill: cached.bill as TableBill, fetchedAt: cached.cachedAt } : null;
  // A cached bill for a table the (newer) map shows as FREE belongs to a bill that has since closed.
  const fresh = canonical && !free ? canonical : null;
  // 1.0.38 (BUG 1 ghost balance) — the FREE map is itself a canonical statement: work synced before it was
  // read is inside that closed server state, never re-added as an unpaid balance.
  // 1.0.38 (Bugs 5/6) — an offline move / merge is projected until the MAP (read at mapAt) reflects it.
  return projectTableBill({ tableId: table.id, mapRow: table, canonical: fresh, draft, ops, freeMapAt: free ? mapAt : null, mapAt });
}

/** rc.13 — the tables a dine-in op acts on (open: its entity; round: its submit; settle: its payload).
 *  1.0.38 — an offline move / merge acts on EVERY table it involves (from + to; primary + sources), so the
 *  online floor keeps projecting all of them until the canonical map reflects it. */
export function tablesOfOp(o: OfflineOperation): string[] {
  const p = rec(o.payload);
  const one = (v: unknown) => (typeof v === "string" && v !== "" ? [v] : []);
  if (o.operation_type === "dinein_open_table") return one(o.local_entity_id);
  if (o.operation_type === "dinein_send_round") return one(rec(p.submit).table_id);
  if (o.operation_type === "pay_table" || o.operation_type === "on_account_table") return one(p.table_id);
  // 1.0.38 (G1) — only a split leg that CLOSES the bill records its table (isTableSettleOp).
  if (o.operation_type === "split_settle") return one(p.table_id);
  if (isStructuralOp(o)) {
    const t = structuralTables(o);
    return [...t.vacates, ...one(t.fills)];
  }
  return [];
}

/**
 * rc.13 — CANONICAL REFRESH IS A MERGE. Online, the floor shows the server map — but a map loaded BEFORE
 * this device's dine-in work reached the server (or an offline-cached map still on screen after reconnect)
 * would show a settled bill as unpaid again. Returns:
 *   `touched` — tables with local dine-in work NOT yet reflected in the map (pending, or synced after the
 *               map was loaded): these keep the operational projection online too;
 *   `syncingSettle` — tables whose local settle has NOT reached the server yet: online actions on them are
 *               held until it lands (never append to / pay a bill that is mid-settle).
 *               1.0.38 — this includes a settle PARKED but not refused (`attentionSettle`): its bill was
 *               paid by the customer; no second payment / new round until it is resolved (BUG 1).
 *   `refusedSettle` — table → the server's refusal of its latest REFUSED settle (shown to the cashier;
 *               the bill is active and payable again, never a fake Paid).
 */
export async function tablesWithUnreflectedWork(
  scope: ProjectionScope,
  mapLoadedAt: number | null,
): Promise<{ touched: Set<string>; syncingSettle: Set<string>; attentionSettle: Set<string>; refusedSettle: Map<string, string>; structuralHold: Set<string> }> {
  const touched = new Set<string>();
  const syncingSettle = new Set<string>();
  const attentionSettle = new Set<string>();
  const refusedSettle = new Map<string, string>();
  const structuralHold = new Set<string>();
  // Final Foundation (PERF): only ops that act on a table, sorted (the same relative order as sorting all of
  // them first), and one reflectedIn per op.
  const ops = (await scopedOperations(scope)).filter((o) => o.status !== "cancelled" && tablesOfOp(o).length > 0).sort((a, b) => a.created_at.localeCompare(b.created_at));
  for (const o of ops) {
    if (o.status === "cancelled") continue;
    const ts = tablesOfOp(o);
    if (ts.length === 0) continue;
    const unreflected = !reflectedIn(o, mapLoadedAt);
    if (unreflected) for (const x of ts) touched.add(x);
    if (unreflected && workStillReplays(o)) for (const x of ts) structuralHold.add(x);
    const t = ts[0];
    const settle = isTableSettleOp(o);
    if (!settle) continue;
    if (settleRefusedByServer(o)) {
      refusedSettle.set(t, o.last_error_message ?? "refused by the server");
      continue;
    }
    refusedSettle.delete(t); // a LATER settle of the table supersedes an earlier refusal
    if (o.status === "synced") continue;
    if (o.status !== "needs_attention" || settleAwaitingRecovery(o)) {
      syncingSettle.add(t);
      if (o.status === "needs_attention") attentionSettle.add(t);
    }
  }
  return { touched, syncingSettle, attentionSettle, refusedSettle, structuralHold };
}

/** 1.0.38 — local work that WILL still reach the server (or already did, after the map was read): live,
 *  or parked only behind a prerequisite / an engine or transient fault (it re-opens / is retried). Work the
 *  server authoritatively refused, or a settle proven closed elsewhere, replays nothing more. */
function workStillReplays(o: OfflineOperation): boolean {
  if (o.status !== "needs_attention") return true;
  const code = o.last_error_code ?? "";
  if (NOT_A_SERVER_REFUSAL.has(code) || code === "retry_exhausted") return true;
  if (ALREADY_CLOSED.test(o.last_error_message ?? "") || BILL_BINDING_REFUSALS.has(code)) return false;
  return TRANSIENT_FAULT.test(o.last_error_message ?? "");
}

/** 1.0.38 — the ONLINE Move / Merge hold: a table whose offline work has not reached (or is not yet
 *  reflected in) the canonical map. An online move / merge of it now would race the offline replay (the
 *  replay's bill pins would then refuse, or a round would land on a table the bill already left). */
export const STRUCTURAL_UNSYNCED_HOLD_MESSAGE =
  "This table has offline work that hasn't synced yet. Move and Merge wait until it reaches the server — check the Sync Center if it doesn't clear.";

/** Pure — the hold reason for an online Move / Merge involving `tableIds`, or null. */
export function structuralHoldReason(tableIds: readonly (string | null | undefined)[], held: ReadonlySet<string>): string | null {
  return tableIds.some((t) => typeof t === "string" && held.has(t)) ? STRUCTURAL_UNSYNCED_HOLD_MESSAGE : null;
}

/** 1.0.38 — an offline full settle / on-account of a bill with a part-payment that cannot be deducted. */
export const PART_PAID_OFFLINE_SETTLE_MESSAGE = "Part of this bill is already paid. Settle the remaining items with Split, or reconnect.";

/**
 * 1.0.38 (Bug 9) — PURE, the ONE offline full-settle / on-account amount rule for a table bill (Pay and On
 * Account alike). A locally captured, unsynced split leg (paidPending) → refused (R is not known here). A
 * SERVER-held part-payment (collected = P) → refused unless the server deducts prior payments
 * (`serverDeductsPrior`, see lib/pos/tablePayment serverDeductsPriorPayments).
 * 1.0.38 G3 (amount pin) — `exactAmount` = the amount THIS DEVICE PRESENTED / COLLECTED: R_local = gross − P in
 * the order currency, computed like the server computes R (Σ order totals − Σ paid split settlements, numeric
 * rounding — `roundNumeric`). It is ALWAYS recorded (canonical bill or local rounds / edits / move / merge
 * alike) and replayed as `expected_amount`: when another terminal appended a round meanwhile, the server's R
 * differs and the settle is REFUSED (PAY_AMOUNT_CHANGED / ON_ACCOUNT_AMOUNT_CHANGED → conflict), never booked
 * at a figure the cashier never collected. Null only when no single figure exists (mixed currencies).
 */
export function offlineSettleAmount(p: OperationalTableBill, serverDeductsPrior: boolean): { ok: false; reason: string } | { ok: true; exactAmount: number | null } {
  if (p.paidPending > 0 || (p.collected > 0 && !serverDeductsPrior)) return { ok: false, reason: PART_PAID_OFFLINE_SETTLE_MESSAGE };
  if (p.bill.mixedCurrency || p.gross == null) return { ok: true, exactAmount: null };
  return { ok: true, exactAmount: Math.max(0, roundNumeric(p.gross - p.collected, 2)) };
}

/** 1.0.38 — an offline discount on a bill the server already holds part-payment for (SPLIT_DISCOUNT_UNSUPPORTED). */
export const PART_PAID_DISCOUNT_MESSAGE = "A discount cannot be applied to a bill that is already part-paid.";

/**
 * PURE — Postgres `round(numeric, d)` (half away from zero) of a JS float, without binary noise: the float sum
 * 1.1 + 2.2 rounds like the numeric 3.3 and 4.995 rounds to 5.00 (Math.round(4.995 * 100) gives 4.99).
 */
export function roundNumeric(x: number, d: number): number {
  if (!Number.isFinite(x)) return x;
  const s = Math.abs(x).toPrecision(15);
  const r = s.includes("e") ? Math.round(Math.abs(x) * 10 ** d) / 10 ** d : Number(`${Math.round(Number(`${s}e${d}`))}e-${d}`);
  return x < 0 ? -r : r;
}

/** An exact decimal (as the server's numeric reads the JSON number) → integer n with v = n / scale. */
function decimalOf(v: number): { n: bigint; scale: bigint } {
  const s = Math.abs(v).toPrecision(15).includes("e") ? Math.abs(v).toFixed(10) : String(Math.abs(v));
  const [i, f = ""] = s.split(".");
  return { n: BigInt(`${i}${f}`), scale: 10n ** BigInt(f.length) };
}

/**
 * 1.0.38 G3 — PURE, the amount pin of an offline settle / on-account WITH the cashier's bill discount, exactly as
 * `pos_pay_table_core` / `pos_complete_table_on_account_core` compute it: bill_sub = Σ order subtotals,
 * discount = round(bill_sub × pct / 100, 2) (percent) or round(value, 2) (amount) — 2 dp in every currency —
 * allocated across the orders (Σ = discount), so the charged R = bill_sub − discount. No discount → `amount`
 * (R_local from offlineSettleAmount) unchanged. A discount on a bill with server-held part-payment is refused
 * here (the server refuses it: SPLIT_DISCOUNT_UNSUPPORTED) — never captured.
 */
export function offlineSettlePin(
  amount: number | null,
  bill: { subtotal: number | null; collected: number },
  discount: { discount_type?: string; discount_value?: number } | null | undefined,
): { ok: true; amount: number | null } | { ok: false; reason: string } {
  const type = discount?.discount_type;
  const value = Number(discount?.discount_value);
  if ((type !== "percent" && type !== "amount") || !(value > 0)) return { ok: true, amount };
  if (bill.collected > 0) return { ok: false, reason: PART_PAID_DISCOUNT_MESSAGE };
  if (amount == null || bill.subtotal == null) return { ok: true, amount: null };
  const subCents = BigInt(Math.round(roundNumeric(bill.subtotal, 2) * 100));
  const v = decimalOf(value);
  const discCents =
    type === "percent"
      ? (2n * subCents * v.n + 100n * v.scale) / (2n * 100n * v.scale) // round(sub × v / 100, 2), half away from zero
      : BigInt(Math.round(roundNumeric(value, 2) * 100));
  const r = subCents - discCents;
  return { ok: true, amount: r > 0n ? Number(r) / 100 : 0 };
}

/** 1.0.38 — the parked-settle hold text (the payment was taken; the settle needs the operator). */
export const SETTLE_ATTENTION_HOLD_MESSAGE =
  "This table's offline payment needs attention in the Sync Center. It was already collected — don't take payment or add a new round until it is resolved.";

/** 1.0.38 — the cashier-facing notice for a settle the server REFUSED (the bill is unpaid again). */
export function refusedSettleNotice(message: string): string {
  return `The server refused this table's offline payment (${message}). The bill is still unpaid — check the Sync Center before collecting payment again.`;
}

/** The Map/List card totals for every table, from the SAME projection (card == detail == payment). */
export async function getOperationalTableTotals(
  scope: ProjectionScope,
  tables: TableSummary[],
  /** rc.13 — ONLINE: project only these tables (local work the server map does not reflect yet). */
  onlyTables?: Set<string>,
  /** 1.0.38 — when `tables` was read (read START); omitted → the cached map's stamp. */
  mapLoadedAt?: number | null,
): Promise<Map<string, { total: number | null; currency: CurrencyCode | null; orders: number; pending: boolean }>> {
  if (onlyTables) tables = tables.filter((t) => onlyTables.has(t.id));
  const out = new Map<string, { total: number | null; currency: CurrencyCode | null; orders: number; pending: boolean }>();
  if (!scope.tenantId) return out;
  // rc.12 — ONE read of the ops and ONE of the sessions for the whole floor (was one sessions read per
  // table), and a free table with no local session is skipped without any read: it can have no bill
  // (the projection would return an empty bill for it — the result is identical).
  const [ops, drafts, mapAt] = await Promise.all([
    scopedOperations(scope),
    openDraftsInScope(scope),
    mapLoadedAt !== undefined ? Promise.resolve(mapLoadedAt) : readCachedTableMap(scope.tenantId, scope.branchId).then((m) => m?.cachedAt ?? null).catch(() => null),
  ]);
  const withSession = new Set(drafts.map((d) => d.table_id));
  // Final Foundation (PERF) — filter to the table-projection op types ONCE for the whole floor (exact: the
  // per-table projection ignores every other type), and the projected tables' cached bills in ONE bulk read.
  const floorOps = ops.filter(isTableProjectionOp);
  const projected = tables.filter((t) => !(t.orders === 0 && !withSession.has(t.id)));
  const bills = await readCachedBillsMany(projected.map((t) => t.id), scope.tenantId, scope.branchId).catch(() => null);
  for (const t of projected) {
    const p = await getOperationalTableBill(scope, t, floorOps, drafts, mapAt, bills ? (bills.get(t.id) ?? null) : undefined);
    if (p.bill.orders.length === 0 && t.orders === 0) continue;
    if (p.bill.orders.length === 0) {
      // rc.10 — the canonical bill the map still shows was SETTLED locally: the table is available.
      // 1.0.38 — likewise when an unsynced offline move / merge took the bill to another table.
      if (p.settledLocally || p.vacatedLocally) out.set(t.id, { total: null, currency: t.currency, orders: 0, pending: true });
      continue;
    }
    out.set(t.id, { total: p.gross, currency: p.currency, orders: Math.max(t.orders, 1), pending: p.mutationOpIds.length > 0 });
  }
  return out;
}

/** Overlay the operational totals onto the cached map rows (offline). Pure. A row with `orders: 0`
 *  is a table whose bill was settled locally: it renders (and gates) as AVAILABLE for a new order. */
export function overlayTableTotals(
  tables: TableSummary[],
  totals: Map<string, { total: number | null; currency: CurrencyCode | null; orders: number }>,
): TableSummary[] {
  if (totals.size === 0) return tables;
  return tables.map((t) => {
    const o = totals.get(t.id);
    if (!o) return t;
    if (o.orders === 0) {
      return { ...t, total: null, collected: null, outstanding: null, orders: 0, order_number: null, opened_at: null, status: "available", occupied: false, mixed_currency: false };
    }
    // 1.0.38 — a table whose bill exists only on this device (opened / moved / merged offline) is OCCUPIED on
    // the projected floor, so the Merge picker (mergeableSources) offers it and Move never targets it.
    return { ...t, total: o.total, currency: o.currency ?? t.currency, orders: o.orders, occupied: true, ...(t.status === "available" ? { status: "occupied" as const } : {}) };
  });
}

// ---------------------------------------------------------------------------
// Edit targets (shared by Dine-In + Delivery) — the version chain + paid-item wall
// ---------------------------------------------------------------------------

export type EditTarget = {
  orderId: string | null;
  orderLocal: string | null;
  /** Placeholder order id for the payload builders (replaced at replay when orderLocal is set). */
  payloadOrderId: string;
  ref: EditTargetRef;
  expectedVersion: number;
  versionAfterOp: string | null;
  dependencyIds: string[];
};

export type EditTargetResult = { ok: true; target: EditTarget } | { ok: false; reason: string };

/** Resolve a projected line into an exact, replay-safe edit target, or a controlled reason. */
export function editTargetFor(
  proj: { orders: ProjectedOrder[]; meta: Map<string, LineMeta> },
  lineId: string,
): EditTargetResult {
  const m = proj.meta.get(lineId);
  if (!m) return { ok: false, reason: "This item isn't available offline. Reconnect to change it." };
  if (m.ref.kind === "merged") return { ok: false, reason: MERGED_LINE_LOCKED_MESSAGE };
  if (m.ref.kind === "summary" || m.ref.kind === "legacy") {
    return { ok: false, reason: "This item was sent before this device went offline. Reconnect to change it." };
  }
  const po = proj.orders.find((o) => o.key === m.orderKey);
  if (!po) return { ok: false, reason: "This item isn't available offline. Reconnect to change it." };
  return chainFor(po, m.ref, m.creatorOpId, m.paidQty);
}

/** The order-level chain (for an add: no target line). */
export function orderChainFor(po: ProjectedOrder): EditTargetResult {
  return chainFor(po, null, null, 0);
}

function chainFor(po: ProjectedOrder, ref: EditTargetRef | null, creatorOpId: string | null, paidQty: number): EditTargetResult {
  // Paid-item wall — the SAME rule the server enforces (an edit needs payment_status 'unpaid'): a bill
  // with ANY part-payment (server-collected or a captured split leg) is never edited offline.
  if (po.partiallyPaid || po.pendingSplitOps.length > 0 || paidQty > 0) {
    return { ok: false, reason: "Part of this bill is already paid. Changing its items needs a connection." };
  }
  if (po.baseVersion == null) {
    return { ok: false, reason: "This bill's latest version isn't known on this device. Reconnect to change its items." };
  }
  // (1.0.38 — a bill moved / merged offline has baseVersion null until that op syncs: edits wait for it.)
  const last = po.bumpOps.length > 0 ? po.bumpOps[po.bumpOps.length - 1] : null;
  const deps = [last, creatorOpId].filter((x): x is string => typeof x === "string" && x !== "");
  return {
    ok: true,
    target: {
      orderId: po.orderId,
      orderLocal: po.orderId ? null : po.orderLocal,
      payloadOrderId: po.orderId ?? po.orderLocal ?? po.key,
      ref: ref ?? { kind: "canonical", order_item_id: "" },
      // Each of this device's unsynced bumping ops raises the version by exactly one (server-proven:
      // edit_order_line / add_order_items / edit_order / split_settle each bump +1; a round append and
      // delivery ops never bump). At replay the predecessor's RETURNED version supersedes this when known.
      expectedVersion: po.baseVersion + po.bumpOps.length,
      versionAfterOp: last,
      dependencyIds: Array.from(new Set(deps)),
    },
  };
}

// ---------------------------------------------------------------------------
// Delivery — one projection per order
// ---------------------------------------------------------------------------

export type OperationalDeliveryOrder = {
  /** The order row as every Delivery surface should show it (totals / provider / ops / note overlaid). */
  row: DeliveryQueueOrder;
  lines: DeliveryOrderLine[];
  /** False when no line snapshot exists on this device (canonical order never opened online). */
  linesKnown: boolean;
  orders: ProjectedOrder[];
  meta: Map<string, LineMeta>;
  mutationOpIds: string[];
  attention: number;
  /** A captured, unsynced settle of this order (Pay must not be offered twice). */
  settlingOpId: string | null;
  /** A captured, unsynced provider selection (its op id — Pay replays after it). */
  providerOpId: string | null;
  /** True when this order is a locally-created (not yet synced) offline order. */
  localPending: boolean;
};

function deliveryLineToBill(l: DeliveryOrderLine, batch: number): BillLine {
  const modTotal = l.modifiers.reduce((s, m) => s + m.priceDelta * m.quantity, 0);
  const unit = l.quantity > 0 ? l.lineTotal / l.quantity : 0;
  return {
    id: l.id,
    menu_item_id: l.menuItemId,
    name: l.name,
    quantity: l.quantity,
    base_price: unit - modTotal,
    modifiers_total: modTotal,
    final_unit_price: unit,
    line_total: l.lineTotal,
    kitchen_note: l.kitchenNote,
    batch_no: batch,
    modifiers: l.modifiers.map((m) => ({ group_id: m.groupId, option_id: m.optionId, name: m.name, price_delta: m.priceDelta, quantity: m.quantity })),
  };
}

function billLineToDelivery(l: BillLine): DeliveryOrderLine {
  return {
    id: l.id,
    menuItemId: l.menu_item_id,
    name: l.name,
    quantity: l.quantity,
    lineTotal: l.line_total,
    kitchenNote: l.kitchen_note,
    modifiers: l.modifiers.map((m) => ({ groupId: m.group_id, optionId: m.option_id, name: m.name, priceDelta: m.price_delta, quantity: m.quantity })),
  };
}

/**
 * PURE — merge everything this device knows about one delivery order into ONE operational order.
 * `txn` = the local offline-created order (OFF-*), when this order was created on this device and is
 * not yet synced; `cachedLines` = the last online line snapshot for a canonical order.
 */
export function projectDeliveryOrder(input: {
  row: DeliveryQueueOrder;
  txn: PosOfflineTxn | null;
  cachedLines: { lines: DeliveryOrderLine[]; fetchedAt: number } | null;
  ops: OfflineOperation[];
  /** rc.11 — when the ROW (status / payment_status) was read from the server. A settle synced AFTER it
   *  is not in the row yet (a stale snapshot must never downgrade a confirmed payment). Defaults to
   *  the line snapshot time (pre-rc.11 behaviour). */
  rowFetchedAt?: number | null;
  /** rc.11 — local ids that resolved to this canonical order (entity map / synced txn): ops captured
   *  against the offline-created order (order_local) still belong to its canonical row. */
  aliases?: string[];
}): OperationalDeliveryOrder {
  const { row, txn } = input;
  const localPending = txn != null && txn.status !== "synced";
  const fetchedAt = localPending ? null : (input.cachedLines?.fetchedAt ?? null);
  const rowFetchedAt = localPending ? null : input.rowFetchedAt !== undefined ? input.rowFetchedAt : fetchedAt;
  const ids = new Set<string>([row.id, ...(input.aliases ?? []), ...(txn ? [txn.local_txn_id] : [])]);
  const meta = new Map<string, LineMeta>();
  const key = row.id;
  const base: BillOrder = {
    id: key,
    order_number: row.order_number ?? "",
    status: row.status,
    payment_status: row.payment_status,
    pos_entity_version: row.pos_entity_version ?? 0,
    shift_id: row.shift_id,
    branch_id: row.branch_id ?? null,
    tenant_id: txn?.tenant_id ?? "",
    subtotal: 0,
    discount_amount: Number(row.discount_amount ?? 0) || 0,
    total_amount: 0,
    currency: (row.currency ?? txn?.currency ?? "USD") as CurrencyCode,
    exchange_rate: null,
    created_at: row.created_at,
    lines: [],
  };
  let linesKnown = false;
  if (localPending && txn) {
    const items = (rec(txn.order_payload).items as Record<string, unknown>[] | undefined) ?? [];
    items.forEach((it, i) => {
      const mods = ((it.modifiers as PreviewLine["modifiers"] | undefined) ?? []).map((m) => ({ group_id: m.group_id ?? null, option_id: m.option_id ?? null, name: m.name, price_delta: Number(m.price_delta), quantity: Number(m.quantity ?? 1) }));
      const bp = Number(it.base_price) || 0;
      const q = Number(it.quantity) || 0;
      const unit = unitOf(bp, mods);
      const cli = typeof it.client_line_id === "string" && it.client_line_id !== "" ? it.client_line_id : null;
      const id = cli ?? `legacy:${txn.local_txn_id}:${i}`;
      base.lines.push({ id, menu_item_id: (it.menu_item_id as string) ?? null, name: String(it.name ?? "Item"), quantity: q, base_price: bp, modifiers_total: unit - bp, final_unit_price: unit, line_total: unit * q, kitchen_note: (it.kitchen_note as string | null) ?? null, batch_no: 1, modifiers: mods });
      meta.set(id, { ref: cli ? { kind: "local", line_local: cli, batch_no: null } : { kind: "legacy" }, orderKey: key, creatorOpId: null, paidQty: 0 });
    });
    linesKnown = true;
  } else if (input.cachedLines) {
    for (const l of input.cachedLines.lines) {
      base.lines.push(deliveryLineToBill(l, 1));
      meta.set(l.id, { ref: { kind: "canonical", order_item_id: l.id }, orderKey: key, creatorOpId: null, paidQty: 0 });
    }
    linesKnown = true;
  }
  const po: ProjectedOrder = {
    key,
    orderId: localPending ? null : row.id,
    orderLocal: localPending ? row.id : null,
    // A locally-created order starts at version 0 on the server (submit never bumps it).
    baseVersion: localPending ? 0 : (row.pos_entity_version ?? null),
    bumpOps: [],
    partiallyPaid: row.payment_status !== "unpaid",
    pendingSplitOps: [],
  };
  const baseSubtotal = base.lines.reduce((s, l) => s + l.line_total, 0);

  const mutationOpIds: string[] = [];
  let attention = 0;
  let settlingOpId: string | null = null;
  let providerOpId: string | null = null;
  const overlay: Partial<DeliveryQueueOrder> = {};
  let payOverlay: Partial<DeliveryQueueOrder> | null = null;
  let itemsChanged = false;
  const sorted = [...input.ops].sort((a, b) => a.created_at.localeCompare(b.created_at));
  for (const op of sorted) {
    const settle = op.operation_type === "pay_order" || op.operation_type === "on_account_order";
    // Item/metadata ops are judged against the LINE snapshot; a settle against the ROW snapshot.
    if (!live(op) || reflectedIn(op, settle ? rowFetchedAt : fetchedAt)) continue;
    const p = rec(op.payload);
    const body = rec(p.payload);
    const mine =
      (typeof p.order_local === "string" && ids.has(p.order_local)) ||
      (typeof body.order_id === "string" && ids.has(body.order_id) && !p.order_local) ||
      (typeof p.order_id === "string" && ids.has(p.order_id));
    if (!mine) continue;
    switch (op.operation_type) {
      case "edit_order_line":
      case "add_order_items":
        if (applyItemOp(op, base, key, meta)) itemsChanged = true;
        po.bumpOps.push(op.operation_id);
        break;
      case "edit_order":
        if (typeof body.note === "string" || body.note === null) overlay.notes = (body.note as string | null) ?? null;
        po.bumpOps.push(op.operation_id);
        break;
      case "delivery_ops":
        overlay.delivery_handler_type = (body.handler_type as string | null) ?? null;
        overlay.delivery_person_ref = (body.person_ref as string | null) ?? null;
        overlay.delivery_cost = body.cost == null ? null : Number(body.cost);
        break;
      case "delivery_set_provider":
        overlay.delivery_provider_id = (body.provider_id as string | null) ?? null;
        if (body.cost_provided === true) overlay.delivery_cost = body.cost == null ? null : Number(body.cost);
        providerOpId = op.operation_id;
        break;
      case "pay_order":
      case "on_account_order":
        // 1.0.38 — a settle the server REFUSED (or a cancelled one) no longer blocks Pay: the money was not
        // applied. A still-unresolved one (pending / retrying / parked behind a prerequisite / proven
        // already-closed) keeps blocking it — never a second payment.
        if (settlePrecedence(op, rowFetchedAt) !== "refused") settlingOpId = op.operation_id;
        // rc.11 — PAYMENT PRECEDENCE: an unresolved local settlement > a newer confirmed canonical
        // settlement > an older cached row. A valid (pending / blocked / retrying / synced-after-the-row)
        // settle overlays the status, so a stale snapshot can never show a paid order as Unpaid. A
        // REFUSED settle (needs_attention) never claims payment — the server row stands, flagged.
        // 1.0.38 — the ONE shared rule (settlePrecedence): a settle merely PARKED behind a prerequisite /
        // a transient fault is not a refusal — the money was taken, it still wins (pending sync).
        const prec = settlePrecedence(op, rowFetchedAt);
        if (prec === "pending" || prec === "confirmed") {
          const pending = prec === "pending";
          if (op.operation_type === "pay_order") {
            payOverlay = { payment_status: "paid", status: "completed", settlement_mode: null, local_pending_sync: pending };
          } else {
            const paidNow = Number(p.amount) || 0;
            payOverlay = { payment_status: paidNow > 0 ? "partial" : "unpaid", status: "completed", settlement_mode: "on_account", local_pending_sync: pending };
          }
        }
        break;
      default:
        continue;
    }
    mutationOpIds.push(op.operation_id);
    if (op.status === "needs_attention") attention += 1;
  }

  recomputeOrder(base);
  const fee = Number(row.delivery_fee ?? 0) || 0;
  const projected: DeliveryQueueOrder = { ...row, ...overlay };
  // A server row already refunded / voided is never re-labelled by a local settle.
  // A row the server already shows PAID is the confirmed truth (never downgraded, nothing to add).
  if (payOverlay && !["refunded", "voided", "cancelled"].includes(row.status) && !["paid", "refunded"].includes(row.payment_status)) {
    Object.assign(projected, payOverlay);
  }
  if (linesKnown && itemsChanged) {
    // Item edits are only captured on an UNDISCOUNTED order (see deliveryEditBlock), so the payable is
    // exactly items + fee — the same arithmetic the server's finance layer applies.
    projected.subtotal = base.subtotal;
    projected.total_amount = Math.round((base.subtotal + fee) * 100) / 100;
  } else if (linesKnown && localPending) {
    projected.subtotal = baseSubtotal;
  }
  return {
    row: projected,
    lines: base.lines.map(billLineToDelivery),
    linesKnown,
    orders: [po],
    meta,
    mutationOpIds,
    attention,
    settlingOpId,
    providerOpId,
    localPending,
  };
}

const DELIVERY_MUTATIONS = new Set(["edit_order_line", "add_order_items", "edit_order", "delivery_ops", "delivery_set_provider", "pay_order", "on_account_order"]);

/** `getOperationalOrderProjection` — the ONE operational projection of a delivery order (async). */
export async function getOperationalOrderProjection(
  scope: ProjectionScope,
  row: DeliveryQueueOrder,
  preloadedOps?: OfflineOperation[],
  opts?: { rowFetchedAt?: number | null; aliases?: string[] },
): Promise<OperationalDeliveryOrder> {
  const [txn, cached, ops, aliases] = await Promise.all([
    localdb.posOfflineTxns.get(row.id).catch(() => undefined),
    readCachedDeliveryLines(row.id, scope.tenantId, scope.branchId).catch(() => null),
    preloadedOps ? Promise.resolve(preloadedOps) : scopedOperations(scope),
    opts?.aliases ? Promise.resolve(opts.aliases) : localAliasesOf(row.id),
  ]);
  return projectDeliveryOrder({
    row,
    txn: txnInScope(txn, scope),
    cachedLines: cached ? { lines: cached.lines as DeliveryOrderLine[], fetchedAt: cached.cachedAt } : null,
    ops,
    aliases,
    ...(opts && "rowFetchedAt" in opts ? { rowFetchedAt: opts.rowFetchedAt ?? null } : {}),
  });
}

/** rc.12 — a local offline txn may only feed a projection inside its own tenant + operating unit. */
export function txnInScope(txn: PosOfflineTxn | null | undefined, scope: ProjectionScope): PosOfflineTxn | null {
  if (!txn) return null;
  return txn.tenant_id === scope.tenantId && (txn.branch_id ?? null) === (scope.branchId ?? null) ? txn : null;
}

/** rc.11 — the local ids (offline-created order / txn) that resolved to this canonical order. */
export async function localAliasesOf(canonicalId: string): Promise<string[]> {
  // Final Foundation (PERF): the v12 canonical_id INDEX (was a full entity-map scan per call).
  const rows = await localdb.entityMap.where("canonical_id").equals(canonicalId).toArray().catch(() => []);
  return rows.map((m) => m.local_entity_id);
}

/** Overlay every queue row with its operational projection, so the Orders LIST shows the SAME total /
 *  provider / note / payment state as the detail and the payment base (list == detail == pay). Rows no
 *  local mutation touches are returned as-is. Never mutates the input. rc.11 — also ONLINE: a fresh
 *  server row (rowFetchedAt = read time) is only overlaid by ops NOT yet reflected in it, so a
 *  just-captured settlement awaiting sync is not lost behind the canonical refresh. */
export async function overlayDeliveryQueue(
  scope: ProjectionScope,
  rows: DeliveryQueueOrder[],
  opts?: { rowFetchedAt?: number | null },
): Promise<DeliveryQueueOrder[]> {
  const rowAt = opts?.rowFetchedAt;
  const all = (await scopedOperations(scope)).filter((o) => live(o) && DELIVERY_MUTATIONS.has(o.operation_type));
  // Only ops the row does not already reflect decide WHETHER a row is projected; the projection itself
  // still judges every op against its own snapshot (lines vs row), so nothing applies twice.
  const ops = rowAt == null ? all : all.filter((o) => !reflectedIn(o, rowAt));
  if (ops.length === 0) return rows;
  // Reverse entity map (canonical → local ids) once, so ops captured against an offline-created order
  // still touch its canonical row after the order itself synced.
  // Final Foundation (PERF): only the mappings of THESE rows (canonical_id index), not the whole map.
  const rowIds = [...new Set(rows.map((r) => r.id))];
  const maps = rowIds.length > 0 ? await localdb.entityMap.where("canonical_id").anyOf(rowIds).toArray().catch(() => []) : [];
  const aliasOf = new Map<string, string[]>();
  for (const m of maps) {
    const list = aliasOf.get(m.canonical_id);
    if (list) list.push(m.local_entity_id);
    else aliasOf.set(m.canonical_id, [m.local_entity_id]);
  }
  // rc.12 — index the ops by the order they reference ONCE (measured: rows × all-ops re-scan + re-sort
  // took 1.75 s median for 200 rows / 900 ops — the slow Delivery Orders open). Each row's projection
  // then receives only ITS ops; projectDeliveryOrder only ever applies ops that reference the row, so the
  // result is identical.
  const keysOf = (o: OfflineOperation): string[] => {
    const p = rec(o.payload);
    return [p.order_local, p.order_id, rec(p.payload).order_id].filter((x): x is string => typeof x === "string" && x !== "");
  };
  const byOrder = new Map<string, OfflineOperation[]>();
  for (const o of all) {
    for (const k of new Set(keysOf(o))) {
      const list = byOrder.get(k);
      if (list) list.push(o);
      else byOrder.set(k, [o]);
    }
  }
  const deciding = new Set(ops.map((o) => o.operation_id));
  const touched: { r: DeliveryQueueOrder; aliases: string[]; mine: OfflineOperation[] }[] = [];
  for (const r of rows) {
    const aliases = aliasOf.get(r.id) ?? [];
    const mine = new Map<string, OfflineOperation>();
    for (const id of [r.id, ...aliases]) for (const o of byOrder.get(id) ?? []) mine.set(o.operation_id, o);
    if ([...mine.keys()].some((id) => deciding.has(id))) touched.push({ r, aliases, mine: [...mine.values()] });
  }
  if (touched.length === 0) return rows;
  // ONE batched read each for the offline txns and the cached line snapshots of the touched rows
  // (was two keyed reads per row), then the same pure projection.
  const ids = touched.map((t) => t.r.id);
  const [txns, lines] = await Promise.all([
    localdb.posOfflineTxns.bulkGet(ids).catch(() => ids.map(() => undefined)),
    readCachedDeliveryLinesMany(ids, scope.tenantId, scope.branchId).catch(() => new Map<string, { lines: unknown; cachedAt: number }>()),
  ]);
  const projectedById = new Map<string, DeliveryQueueOrder>();
  touched.forEach((t, i) => {
    const cached = lines.get(t.r.id);
    const proj = projectDeliveryOrder({
      row: t.r,
      // OU wall: a local txn is only ever projected inside its own tenant + operating unit (an id match
      // is not an authorization boundary).
      txn: txnInScope(txns[i], scope),
      cachedLines: cached ? { lines: cached.lines as DeliveryOrderLine[], fetchedAt: cached.cachedAt } : null,
      ops: t.mine,
      aliases: t.aliases,
      ...(opts && "rowFetchedAt" in opts ? { rowFetchedAt: rowAt ?? null } : {}),
    });
    projectedById.set(t.r.id, proj.row);
  });
  return rows.map((r) => projectedById.get(r.id) ?? r);
}

/** Controlled refusals for offline delivery ITEM edits (beyond the paid-item wall in the chain). */
export function deliveryEditBlock(p: OperationalDeliveryOrder): string | null {
  if (!p.linesKnown) return "This order's items aren't saved on this device yet. Reconnect to change them.";
  if (Number(p.row.discount_amount ?? 0) > 0) {
    return "This order has a discount — its total is recomputed by the server. Reconnect to change its items.";
  }
  if (p.settlingOpId) return "This order was settled offline and is waiting to sync.";
  return null;
}
