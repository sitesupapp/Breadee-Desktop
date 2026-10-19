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

import { localdb, readCachedBill, readCachedDeliveryLines, readCachedDeliveryLinesMany, type DineDraft, type DineDraftLine, type PosOfflineTxn } from "@/lib/offline/db";
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
 *  display-only (their server ids are not known on this device). */
export type LineRef = EditTargetRef | { kind: "summary" } | { kind: "legacy" };

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
  /** Unsynced ops that make up this projection's local delta (settle must replay after them). */
  mutationOpIds: string[];
  /** Ops in this projection parked for the operator (needs_attention). */
  attention: number;
  /** The latest captured, not-yet-reflected settle / on-account of this table (its covered bill is
   *  closed locally; a NEW session on the table chains its open after it). */
  settlingOpId: string | null;
  /** rc.10 — the table's bill was fully settled locally and nothing new is open: the table is
   *  AVAILABLE for a new order (the settled bill stays in history until it syncs). */
  settledLocally: boolean;
  /** True when part of the bill is known only as a canonical SUMMARY (no cached lines). */
  summaryOnly: boolean;
  /** The local session, when one exists. */
  sessionId: string | null;
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
}): OperationalTableBill {
  const { tableId, mapRow } = input;
  const fetchedAt = input.canonical?.fetchedAt ?? null;
  const meta = new Map<string, LineMeta>();
  const porders: ProjectedOrder[] = [];
  const bills: BillOrder[] = [];
  let summaryOnly = false;

  // 0 — LOCAL SETTLEMENT (rc.10). A captured, not-yet-reflected settle / on-account of this table
  // closes EXACTLY the bill it recorded (`covers`): those canonical orders, that local session, the
  // canonical summary. Closed parts leave the ACTIVE bill (the table becomes reusable) but stay in
  // history (the draft + op are durable). Ops captured before rc.10 carry no `covers`: they close the
  // session they depend on and every canonical order already in a snapshot fetched before they were
  // captured (and the summary) — exactly the bill that was on screen when they were taken.
  const settleOps = [...input.ops]
    .filter((o) => (o.operation_type === "pay_table" || o.operation_type === "on_account_table") && live(o) && !reflectedIn(o, fetchedAt) && rec(o.payload).table_id === tableId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const coveredOrders = new Set<string>();
  let coveredSummary = false;
  const coveredSessions = new Set<string>();
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
  // rc.11 — the LEGACY rule (a pre-rc.10 settle with no `covers`, matched only by its dependency on the
  // session's open) closes the session ONLY when no round was sent AFTER that settle: a later round is
  // an active bill on the table and must stay visible (never hidden behind an old payment).
  const legacyCovers = (s: OfflineOperation, d: DineDraft): boolean => {
    if (!s.dependency_ids.includes(d.open_operation_id)) return false;
    const at = Date.parse(s.created_at);
    return !d.rounds.some((r) => Number.isFinite(at) && Date.parse(r.sent_at) > at);
  };
  const draftSettled =
    input.draft != null &&
    (coveredSessions.has(input.draft.local_session_id) ||
      settleOps.some((s) => Object.keys(rec(rec(s.payload).covers)).length === 0 && legacyCovers(s, input.draft as DineDraft)));
  const draft = draftSettled ? null : input.draft;
  const lastSettleOpId = settleOps.length > 0 ? settleOps[settleOps.length - 1].operation_id : null;
  const collected = Math.max(0, Number(mapRow?.collected ?? 0) || 0);

  // 1 — canonical snapshot (cached bill), else the canonical SUMMARY from the cached map row.
  const canonOrders = (input.canonical?.bill.orders ?? []).filter((o) => !coveredOrders.has(o.id));
  const canonCoveredAll = (input.canonical?.bill.orders ?? []).length > 0 && canonOrders.length === 0;
  if (canonOrders.length > 0) {
    for (const o of canonOrders) {
      const copy: BillOrder = { ...o, lines: o.lines.map((l) => ({ ...l, modifiers: [...l.modifiers] })) };
      bills.push(copy);
      porders.push({ key: o.id, orderId: o.id, orderLocal: null, baseVersion: o.pos_entity_version, bumpOps: [], partiallyPaid: o.payment_status !== "unpaid" || collected > 0, pendingSplitOps: [] });
      for (const l of copy.lines) meta.set(l.id, { ref: { kind: "canonical", order_item_id: l.id }, orderKey: o.id, creatorOpId: null, paidQty: 0 });
    }
  } else if (!canonCoveredAll && !coveredSummary && mapRow && mapRow.orders > 0 && mapRow.total != null) {
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

  const opsById = new Map(input.ops.map((o) => [o.operation_id, o]));
  const mutationOpIds: string[] = [];
  let attention = 0;
  const note = (op: OfflineOperation) => {
    mutationOpIds.push(op.operation_id);
    if (op.status === "needs_attention") attention += 1;
  };

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
        baseVersion: hadCanonical ? null : 0,
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
  const sorted = [...input.ops].sort((a, b) => a.created_at.localeCompare(b.created_at));
  for (const op of sorted) {
    if (!live(op) || reflectedIn(op, fetchedAt)) continue;
    if (op.operation_type !== "edit_order_line" && op.operation_type !== "add_order_items" && op.operation_type !== "edit_order") continue;
    const key = keyOfOp(op);
    if (!key) continue;
    const po = porders.find((x) => x.key === key)!;
    const bo = bills.find((b) => b.id === key)!;
    if (op.operation_type !== "edit_order") applyItemOp(op, bo, key, meta);
    po.bumpOps.push(op.operation_id);
    note(op);
  }

  // 4 — split legs (unsynced) → paid quantities + amount captured.
  let paidPending = 0;
  for (const op of sorted) {
    if (op.operation_type !== "split_settle" || !live(op) || reflectedIn(op, fetchedAt)) continue;
    const key = keyOfOp(op);
    if (!key) continue;
    const po = porders.find((x) => x.key === key)!;
    const bo = bills.find((b) => b.id === key)!;
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

  for (const b of bills) recomputeOrder(b);
  const nonEmpty = bills.filter((b) => b.lines.length > 0);
  const bill = foldBill(tableId, nonEmpty);
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
    attention,
    settlingOpId: lastSettleOpId,
    settledLocally: lastSettleOpId != null && nonEmpty.length === 0,
    summaryOnly,
    sessionId: draft?.local_session_id ?? null,
  };
}

/** Load this scope's operations once (the projection filters by entity itself). */
export async function scopedOperations(scope: ProjectionScope): Promise<OfflineOperation[]> {
  if (!scope.tenantId) return [];
  const all = await localdb.operations.toArray();
  return all.filter((o) => opInScope(o, scope));
}

/** This scope's OPEN local dine-in sessions (one indexed read). */
async function openDraftsInScope(scope: ProjectionScope): Promise<DineDraft[]> {
  if (!scope.tenantId) return [];
  const all = await localdb.dineDrafts.where("tenant_id").equals(scope.tenantId).toArray();
  return all.filter(
    (d) =>
      d.status === "open" &&
      (d.branch_id ?? null) === (scope.branchId ?? null) &&
      d.cashier_user_id === scope.cashierUserId &&
      d.device_id === scope.deviceId &&
      (scope.terminalId == null || (d.terminal_id ?? null) === scope.terminalId),
  );
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
): Promise<OperationalTableBill> {
  const [cached, draft, ops] = await Promise.all([
    readCachedBill(table.id, scope.tenantId, scope.branchId).catch(() => null),
    preloadedDrafts ? Promise.resolve(preloadedDrafts.find((d) => d.table_id === table.id) ?? null) : openDraftForTable(scope, table.id),
    preloadedOps ? Promise.resolve(preloadedOps) : scopedOperations(scope),
  ]);
  const canonical = cached ? { bill: cached.bill as TableBill, fetchedAt: cached.cachedAt } : null;
  // A cached bill for a table the (newer) map shows as FREE belongs to a bill that has since closed.
  const fresh = canonical && table.orders > 0 ? canonical : null;
  return projectTableBill({ tableId: table.id, mapRow: table, canonical: fresh, draft, ops });
}

/** The Map/List card totals for every table, from the SAME projection (card == detail == payment). */
export async function getOperationalTableTotals(
  scope: ProjectionScope,
  tables: TableSummary[],
): Promise<Map<string, { total: number | null; currency: CurrencyCode | null; orders: number; pending: boolean }>> {
  const out = new Map<string, { total: number | null; currency: CurrencyCode | null; orders: number; pending: boolean }>();
  if (!scope.tenantId) return out;
  // rc.12 — ONE read of the ops and ONE of the sessions for the whole floor (was one sessions read per
  // table), and a free table with no local session is skipped without any read: it can have no bill
  // (the projection would return an empty bill for it — the result is identical).
  const [ops, drafts] = await Promise.all([scopedOperations(scope), openDraftsInScope(scope)]);
  const withSession = new Set(drafts.map((d) => d.table_id));
  for (const t of tables) {
    if (t.orders === 0 && !withSession.has(t.id)) continue;
    const p = await getOperationalTableBill(scope, t, ops, drafts);
    if (p.bill.orders.length === 0 && t.orders === 0) continue;
    if (p.bill.orders.length === 0) {
      // rc.10 — the canonical bill the map still shows was SETTLED locally: the table is available.
      if (p.settledLocally) out.set(t.id, { total: null, currency: t.currency, orders: 0, pending: true });
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
    return { ...t, total: o.total, currency: o.currency ?? t.currency, orders: o.orders, occupied: true };
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
        settlingOpId = op.operation_id;
        // rc.11 — PAYMENT PRECEDENCE: an unresolved local settlement > a newer confirmed canonical
        // settlement > an older cached row. A valid (pending / blocked / retrying / synced-after-the-row)
        // settle overlays the status, so a stale snapshot can never show a paid order as Unpaid. A
        // REFUSED settle (needs_attention) never claims payment — the server row stands, flagged.
        if (op.status !== "needs_attention") {
          const pending = op.status !== "synced";
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
  const rows = await localdb.entityMap.filter((m) => m.canonical_id === canonicalId).toArray().catch(() => []);
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
  const maps = await localdb.entityMap.toArray().catch(() => []);
  const aliasOf = new Map<string, string[]>();
  for (const m of maps) aliasOf.set(m.canonical_id, [...(aliasOf.get(m.canonical_id) ?? []), m.local_entity_id]);
  // rc.12 — index the ops by the order they reference ONCE (measured: rows × all-ops re-scan + re-sort
  // took 1.75 s median for 200 rows / 900 ops — the slow Delivery Orders open). Each row's projection
  // then receives only ITS ops; projectDeliveryOrder only ever applies ops that reference the row, so the
  // result is identical.
  const keysOf = (o: OfflineOperation): string[] => {
    const p = rec(o.payload);
    return [p.order_local, p.order_id, rec(p.payload).order_id].filter((x): x is string => typeof x === "string" && x !== "");
  };
  const byOrder = new Map<string, OfflineOperation[]>();
  for (const o of all) for (const k of new Set(keysOf(o))) byOrder.set(k, [...(byOrder.get(k) ?? []), o]);
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
