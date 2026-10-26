// 1.0.38 (Bugs 5/6) — offline dine-in TABLE RESTRUCTURE: Move Table + Merge Tables (schema 2).
//
// SUPERSEDES the rc.12–1.0.37 "online only" restriction and the dormant rc.4–rc.11 capture (schema 1),
// whose five defects are fixed here:
//   1. op identity — the client_op_id is derived from the full 5-D scope + the tables + the BILL IDENTITY
//      (canonical order ids / the local session that creates the order) + a structural-generation counter,
//      so a later legitimate A→B move of a different bill (or of the same bill after B→A) is a NEW op —
//      never a cached server result that silently moves nothing.
//   2. barriers — the op depends on the bill's open / rounds / edits / split legs, on any earlier move /
//      merge of the involved bills, and on whatever freed the destination locally; every LATER round /
//      settle / split of the bill depends on it (the session's `structural_op_id`).
//   3. projection — captured ATOMICALLY with the local session update (one Dexie transaction): the bill
//      shows on its new table at once, the source is free; a refused op restores it (reconcile).
//   4. versions — table CAS only from THIS device's own prior results (handlers.tableVersionAfter); when
//      unknown the CAS is omitted, never guessed. Bill pins (order ids) + paid-settlement pins always.
//   5. close barrier — move / merge are close-relevant (endShiftOffline.CLOSE_RELEVANT_TYPES).
//
// Replay: handlers.moveTableV2Handler → pos_move_table_v2; mergeTablesV2Handler → pos_merge_tables_v4
// (prod_1038 contract §5.1 / §5.2), exactly-once on client_op_id, request frozen before the first send.
// This module holds NO authority — it captures intent + identity pins; the server re-derives every figure.

import { localdb, readCachedBill, readCachedTableMap, type DineDraft } from "@/lib/offline/db";
import { type OfflineOperation, type OperationScope, getOperation } from "@/lib/offline/operationLog";
import { deterministicUuid, sessionBarrier } from "@/lib/offline/dineinOffline";
import { canonicalIdForInScope } from "@/lib/offline/entityMap";
import {
  type BillRef,
  type OperationalTableBill,
  type ProjectionScope,
  TABLE_OP_SCHEMA_VERSION,
  billRefKey,
  getOperationalTableBill,
  isStructuralOp,
  openDraftsInScope,
  reflectedIn,
  scopedOperations,
  shiftlessCanonicalOrders,
  shiftlessRefusal,
  structuralAllRefs,
  structuralRefusedByServer,
  tablesOfOp,
} from "@/lib/offline/operationalProjection";
import type { BillLine, BillOrder, TableBill, TableSummary } from "@/types/tables";

/** The immutable 5-dimensional scope a table-restructure op is captured + replayed under. */
export type TableOpScope = {
  tenantId: string;
  branchId: string | null; // OU
  cashierUserId: string;
  deviceId: string;
  terminalId: string | null;
};

function opScope(s: TableOpScope): OperationScope {
  return { tenant_id: s.tenantId, branch_id: s.branchId, device_id: s.deviceId, terminal_id: s.terminalId ?? "", cashier_user_id: s.cashierUserId };
}

function projScope(s: TableOpScope): ProjectionScope {
  return { tenantId: s.tenantId, branchId: s.branchId, cashierUserId: s.cashierUserId, deviceId: s.deviceId, terminalId: s.terminalId };
}

export const MOVE_OP_PREFIX = "movetable:";
export const MERGE_OP_PREFIX = "mergetables:";

export type CaptureTableOpResult =
  | { ok: true; operationId: string; clientOpId: string; alreadyCaptured: boolean; outstanding?: number | null }
  | { ok: false; reason: string };

// --- controlled capture refusals (fail closed, never a silent no-op) ----------------------------------

export const MOVE_NO_BILL_MESSAGE = "This table has no open bill to move. Send a round first.";
export const MOVE_DEST_NOT_FREE_MESSAGE = "The destination table is not free on this device. Choose a free table.";
export const TABLE_OP_SUMMARY_MESSAGE = "Part of this bill was sent before this device went offline, so it can't be moved or merged offline. Reconnect to do it.";
export const TABLE_OP_ATTENTION_MESSAGE = "This bill has an offline change that needs attention. Resolve it in the Sync Center first.";
export const TABLE_OP_MIXED_CURRENCY_MESSAGE = "This bill mixes currencies, so it can't be moved or merged offline. Reconnect to do it.";
export const TABLE_OP_CHANGED_MESSAGE = "This table changed on this device while you were choosing. Try again.";
export const MERGE_CROSS_SHIFT_MESSAGE = "These bills belong to different shifts, so they can't be merged.";
export const MERGE_CROSS_CURRENCY_MESSAGE = "These bills are in different currencies, so they can't be merged.";
export const MERGE_ADJUSTED_MESSAGE = "A bill with a discount or other adjustment can't be merged. Remove it, or reconnect to merge.";
export const MERGE_ONLINE_PART_PAID_MESSAGE = "A bill that was part-paid online can't be merged offline (its paid items aren't known on this device). Reconnect to merge it.";
export const MERGE_PARTIAL_LINE_MESSAGE = "An item on this bill is only partly paid, so it can't be merged. Settle the whole item first, or reconnect.";
export const MERGE_SINGLE_BILL_MESSAGE = "Each table must hold exactly one open bill to merge offline.";

/** Pure readiness for the offline table-op gate — ALLOWS a move/merge offline when the POS is
 *  offline-ready + scope present (the base tableOpGate blocks offline entirely). Close/Clear and
 *  order Transfer stay online-only (not covered here). */
export function evaluateTableOpOfflineReady(input: {
  online: boolean;
  offlineReady: boolean;
  hasScope: boolean;
}): boolean {
  if (input.online) return true;
  return input.offlineReady && input.hasScope;
}

// --- shared helpers ------------------------------------------------------------------------------

/** The bill identity of a projected table: one ref per projected order. */
function billRefsOf(p: OperationalTableBill): BillRef[] {
  return p.orders.map((po) => ({ order_id: po.orderId, order_local: po.orderId ? null : po.orderLocal }));
}

/** Non-structural attention items (a parked earlier move/merge of the table does not block redoing it). */
function blockingAttention(p: OperationalTableBill, ops: OfflineOperation[]): boolean {
  const byId = new Map(ops.map((o) => [o.operation_id, o]));
  if (p.attentionOpIds.some((id) => !isStructuralOp(byId.get(id) ?? ({} as OfflineOperation)))) return true;
  // a refused settle of the table (its bill is active again, the refusal unresolved)
  return p.settlementConflict;
}

/** Earlier (non-cancelled, not refused) structural ops of these bills: their count is the structural
 *  generation (op identity) and the latest one is a dependency. */
function priorStructural(ops: OfflineOperation[], refKeys: Set<string>, sessions: Set<string>): OfflineOperation[] {
  return ops
    .filter((o) => isStructuralOp(o) && o.status !== "cancelled")
    .filter((o) => {
      const refs = structuralAllRefs(o);
      return refs.some((r) => refKeys.has(billRefKey(r)) || (r.order_local != null && sessions.has(r.order_local)));
    })
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

const VERSION_RETURNING = new Set(["pay_table", "dinein_open_table", "move_table", "merge_tables"]);

/**
 * This device's own LAST unreflected op on `tableId` (or on the bill sitting there), when that op's
 * result carries the table's version — the CAS chains from it at replay. Anything later that bumps the
 * version without returning it (a round, a split leg, an on-account) → unknown → no CAS (never guessed).
 */
function versionAfterFor(tableId: string, ops: OfflineOperation[], billOpIds: string[], mapAt: number | null): string | null {
  const bill = new Set(billOpIds);
  const candidates = ops
    .filter((o) => o.status !== "cancelled" && !reflectedIn(o, mapAt))
    .filter((o) => !(isStructuralOp(o) && structuralRefusedByServer(o)))
    .filter((o) => bill.has(o.operation_id) || tablesOfOp(o).includes(tableId))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const last = candidates[candidates.length - 1];
  if (!last) return null;
  if (!VERSION_RETURNING.has(String(last.operation_type))) return null;
  if ((last.operation_type === "move_table" || last.operation_type === "merge_tables") && !isStructuralOp(last)) return null;
  return last.operation_id;
}

/** A free destination on the projected floor (no active bill, no open local session, in service). */
function destinationFree(row: TableSummary, p: OperationalTableBill, draft: DineDraft | null): boolean {
  if (draft) return false;
  if (p.bill.orders.length > 0) return false;
  if (row.status === "inactive" || row.status === "reserved") return false;
  if (row.orders === 0) return row.status === "available";
  return p.settledLocally || p.vacatedLocally;
}

/** The canonical BillOrders of a projection's canonical orders, as SERVER data (no local round lines):
 *  from the table's cached bill, else a snapshot an earlier offline move carried with the session. */
async function canonicalSnapshot(scope: TableOpScope, tableId: string, p: OperationalTableBill, draft: DineDraft | null): Promise<BillOrder[]> {
  const ids = p.orders.filter((o) => o.orderId && !o.orderLocal).map((o) => o.orderId as string);
  if (ids.length === 0) return [];
  const cached = await readCachedBill(tableId, scope.tenantId, scope.branchId).catch(() => null);
  const pool: BillOrder[] = [...((cached?.bill as TableBill | undefined)?.orders ?? []), ...(draft?.carried_orders ?? [])];
  const out: BillOrder[] = [];
  for (const id of ids) {
    const o = pool.find((x) => x.id === id);
    if (o) out.push({ ...o, lines: o.lines.map((l) => ({ ...l, modifiers: [...l.modifiers] })) });
  }
  return out;
}

/** The shift a projected (single-order) bill belongs to, normalized for comparison, or null (unknown). */
async function shiftKeyOf(scope: TableOpScope, p: OperationalTableBill, draft: DineDraft | null): Promise<string | null> {
  const po = p.orders[0];
  const order = po ? p.bill.orders.find((b) => b.id === po.key) : undefined;
  if (po?.orderId && order?.shift_id) return order.shift_id;
  if (draft?.shift_id) return draft.shift_id;
  if (draft?.shift_local) return (await canonicalIdForInScope(draft.shift_local, opScope(scope))) ?? `L:${draft.shift_local}`;
  return order?.shift_id ?? null;
}

function newCarrierDraft(scope: TableOpScope, args: { tableId: string; tableName: string; currency: string; opId: string; canonicalOrderId: string | null; shiftId: string | null }): DineDraft {
  const now = new Date().toISOString();
  return {
    local_session_id: crypto.randomUUID(),
    tenant_id: scope.tenantId,
    branch_id: scope.branchId,
    cashier_user_id: scope.cashierUserId,
    device_id: scope.deviceId,
    terminal_id: scope.terminalId ?? null,
    floor_id: null,
    section_id: null,
    table_id: args.tableId,
    table_name: args.tableName,
    currency: args.currency,
    // The move / merge op IS this session's "open": its rounds / settles / splits chain after it.
    open_operation_id: args.opId,
    canonical_order_id: args.canonicalOrderId,
    origin: "online",
    base_order_version: null,
    status: "open",
    shift_id: args.shiftId,
    shift_local: null,
    structural_op_id: args.opId,
    carrier: true,
    lines: [],
    rounds: [],
    draft_revision: 0,
    notes: null,
    created_at: now,
    updated_at: now,
  };
}

async function loadContext(scope: TableOpScope, mapLoadedAt: number | null | undefined) {
  const ps = projScope(scope);
  const [ops, drafts, mapAt] = await Promise.all([
    scopedOperations(ps),
    openDraftsInScope(ps),
    mapLoadedAt !== undefined ? Promise.resolve(mapLoadedAt) : readCachedTableMap(scope.tenantId, scope.branchId).then((m) => m?.cachedAt ?? null).catch(() => null),
  ]);
  const project = (row: TableSummary) => getOperationalTableBill(ps, row, ops, drafts, mapAt);
  const draftOf = (p: OperationalTableBill) => (p.sessionId ? (drafts.find((d) => d.local_session_id === p.sessionId) ?? null) : null);
  return { ops, drafts, mapAt, project, draftOf };
}

function newOp(scope: TableOpScope, type: "move_table" | "merge_tables", operationId: string, clientOpId: string, canonicalEntityId: string, deps: string[], locals: string[], payload: unknown): OfflineOperation {
  return {
    operation_id: operationId,
    operation_type: type,
    schema_version: TABLE_OP_SCHEMA_VERSION,
    scope: opScope(scope),
    created_at: new Date().toISOString(),
    client_op_id: clientOpId,
    local_entity_id: null,
    canonical_entity_id: canonicalEntityId,
    dependency_ids: Array.from(new Set(deps.filter((x) => typeof x === "string" && x !== "" && x !== operationId))),
    depends_on_local_entities: Array.from(new Set(locals)),
    payload,
    status: "pending",
    retry_count: 0,
    last_attempt_at: null,
    last_error_code: null,
    last_error_message: null,
    result_meta: null,
    synced_at: null,
  };
}

// --- MOVE ------------------------------------------------------------------------------------------

/**
 * Durably capture an offline MOVE of the bill on `from` to the free table `to`. `from` / `to` are the RAW
 * map rows (never the overlaid ones). Atomic with the local session update; idempotent on its
 * deterministic op id. A part-paid bill MAY move (payments and settlements stay attached server-side).
 */
export async function captureMoveTableOffline(input: {
  scope: TableOpScope;
  from: TableSummary;
  to: TableSummary;
  /** When the map holding `from`/`to` was read (read START); omitted → the cached map's stamp. */
  mapLoadedAt?: number | null;
}): Promise<CaptureTableOpResult> {
  const { scope, from, to } = input;
  if (from.id === to.id) return { ok: false, reason: "Choose a different table to move to." };
  const ctx = await loadContext(scope, input.mapLoadedAt);
  const fp = await ctx.project(from);
  const tp = await ctx.project(to);
  const fromDraft = ctx.draftOf(fp);
  const toDraft = ctx.drafts.find((d) => d.table_id === to.id) ?? null;

  if (fp.bill.orders.length === 0) return { ok: false, reason: MOVE_NO_BILL_MESSAGE };
  if (fp.summaryOnly) return { ok: false, reason: TABLE_OP_SUMMARY_MESSAGE };
  if (fp.bill.mixedCurrency) return { ok: false, reason: TABLE_OP_MIXED_CURRENCY_MESSAGE };
  if (blockingAttention(fp, ctx.ops)) return { ok: false, reason: TABLE_OP_ATTENTION_MESSAGE };
  const shiftless = shiftlessCanonicalOrders(fp.bill, fromDraft);
  if (shiftless.length > 0) return { ok: false, reason: shiftlessRefusal(shiftless) };
  if (!destinationFree(to, tp, toDraft)) return { ok: false, reason: MOVE_DEST_NOT_FREE_MESSAGE };

  const refs = billRefsOf(fp);
  if (refs.length === 0 || refs.some((r) => !r.order_id && !r.order_local)) return { ok: false, reason: TABLE_OP_SUMMARY_MESSAGE };
  const keys = refs.map(billRefKey).sort();
  const sessions = new Set<string>(refs.map((r) => r.order_local).filter((x): x is string => !!x));
  if (fromDraft) sessions.add(fromDraft.local_session_id);
  const prior = priorStructural(ctx.ops, new Set(keys), sessions);
  const priorLive = prior.filter((o) => !structuralRefusedByServer(o));
  const gen = prior.length;

  const s = scope;
  const clientOpId = deterministicUuid([s.tenantId, s.branchId ?? "", s.cashierUserId, s.deviceId, s.terminalId ?? "", "move_table", from.id, to.id, ...keys, String(gen)]);
  const operationId = MOVE_OP_PREFIX + clientOpId;

  // Paid-settlement pin: server-known (nothing collected online) + this device's legs. A bill part-paid
  // online has an unknown server count → the pin is omitted (the order pin + server lock still guard).
  const onlinePart = fp.collected > 0 || fp.orders.some((po) => po.partiallyPaid);
  const paidPins: Record<string, number> | null = onlinePart ? null : Object.fromEntries(fp.orders.map((po) => [billRefKey({ order_id: po.orderId, order_local: po.orderId ? null : po.orderLocal }), po.pendingSplitOps.length]));

  const billOpIds = [...(fromDraft ? sessionBarrier(fromDraft) : []), ...fp.mutationOpIds];
  const deps = [
    ...(fromDraft ? sessionBarrier(fromDraft) : []),
    ...fp.pendingMutationOpIds,
    ...(priorLive.length > 0 ? [priorLive[priorLive.length - 1].operation_id] : []),
    ...(tp.freedByOpId ? [tp.freedByOpId] : []),
  ];
  const carried = await canonicalSnapshot(scope, from.id, fp, fromDraft);
  const payload = {
    from_table_id: from.id,
    to_table_id: to.id,
    from_table_name: from.name,
    to_table_name: to.name,
    bill: { orders: refs },
    session_local: fromDraft?.local_session_id ?? null,
    paid_pins: paidPins,
    version_after: {
      from: versionAfterFor(from.id, ctx.ops, billOpIds, ctx.mapAt),
      to: versionAfterFor(to.id, ctx.ops, tp.freedByOpId ? [tp.freedByOpId] : [], ctx.mapAt),
    },
    // Projection-only (never sent): what the bill looked like when it was moved.
    preview: { gross: fp.gross, collected: fp.collected, paid_pending: fp.paidPending, outstanding: fp.outstanding },
  };
  const op = newOp(scope, "move_table", operationId, clientOpId, to.id, deps, [...sessions].filter((x) => refs.some((r) => r.order_local === x)), payload);

  return localdb.transaction("rw", localdb.operations, localdb.dineDrafts, async (): Promise<CaptureTableOpResult> => {
    if (await getOperation(operationId)) return { ok: true, operationId, clientOpId, alreadyCaptured: true, outstanding: fp.outstanding };
    // Re-validate inside the transaction: the session still sits on `from`, nothing opened on `to`.
    if (fromDraft) {
      const cur = await localdb.dineDrafts.get(fromDraft.local_session_id);
      if (!cur || cur.status !== "open" || cur.table_id !== from.id) return { ok: false, reason: TABLE_OP_CHANGED_MESSAGE };
    }
    const openOnTo = await localdb.dineDrafts
      .where("tenant_id")
      .equals(s.tenantId)
      .filter((d) => d.status === "open" && d.table_id === to.id && (d.branch_id ?? null) === (s.branchId ?? null) && d.device_id === s.deviceId && d.cashier_user_id === s.cashierUserId)
      .count();
    if (openOnTo > 0) return { ok: false, reason: MOVE_DEST_NOT_FREE_MESSAGE };
    await localdb.operations.add(op);
    const now = new Date().toISOString();
    const carry = { carried_orders: carried, carried_collected: fp.collected, carried_op_id: operationId };
    if (fromDraft) {
      await localdb.dineDrafts.update(fromDraft.local_session_id, { table_id: to.id, table_name: to.name, moved_from: from.id, structural_op_id: operationId, ...carry, updated_at: now });
    } else {
      // A canonical-only bill (no local session): the move creates the session that carries it.
      const first = carried[0] ?? null;
      await localdb.dineDrafts.add({
        ...newCarrierDraft(scope, { tableId: to.id, tableName: to.name, currency: fp.currency ?? first?.currency ?? "USD", opId: operationId, canonicalOrderId: first?.id ?? null, shiftId: first?.shift_id ?? null }),
        moved_from: from.id,
        ...carry,
      });
    }
    return { ok: true, operationId, clientOpId, alreadyCaptured: false, outstanding: fp.outstanding };
  });
}

// --- MERGE -----------------------------------------------------------------------------------------

type MergeLeg = { row: TableSummary; p: OperationalTableBill; draft: DineDraft | null; ref: BillRef; unpaid: BillLine[]; retained: BillLine[]; outstanding: number };

/**
 * Durably capture an offline MERGE of `sources` into `primary` (RAW map rows). Only the UNPAID whole items
 * of each bill fold into the primary; prior payments stay on their source (a part-paid source completes for
 * exactly what it paid, server-side); no payment is created, the drawer is untouched. UNPAID + UNPAID,
 * PARTIAL + UNPAID and PARTIAL + PARTIAL are accepted when every part-payment is known on this device at
 * WHOLE-ITEM granularity (this device's split legs). Refused (with a reason): a partly-paid line, a bill
 * part-paid online (its paid items are not known here), cross-shift, cross-currency, adjusted, summary-only
 * or shift-less bills, and a table that does not hold exactly one bill.
 */
export async function captureMergeTablesOffline(input: {
  scope: TableOpScope;
  primary: TableSummary;
  sources: TableSummary[];
  mapLoadedAt?: number | null;
}): Promise<CaptureTableOpResult> {
  const { scope, primary } = input;
  const sources = input.sources.filter((t, i, a) => t.id !== primary.id && a.findIndex((x) => x.id === t.id) === i);
  if (sources.length === 0) return { ok: false, reason: "Select at least one other table to merge in." };
  const ctx = await loadContext(scope, input.mapLoadedAt);

  const legs: MergeLeg[] = [];
  for (const row of [primary, ...sources]) {
    const p = await ctx.project(row);
    const draft = ctx.draftOf(p);
    const name = row.name;
    if (p.bill.orders.length === 0) return { ok: false, reason: `Table ${name} has no open bill to merge.` };
    if (p.summaryOnly) return { ok: false, reason: TABLE_OP_SUMMARY_MESSAGE };
    if (p.orders.length !== 1 || p.bill.mixedCurrency) return { ok: false, reason: MERGE_SINGLE_BILL_MESSAGE };
    if (blockingAttention(p, ctx.ops)) return { ok: false, reason: TABLE_OP_ATTENTION_MESSAGE };
    const shiftless = shiftlessCanonicalOrders(p.bill, draft);
    if (shiftless.length > 0) return { ok: false, reason: shiftlessRefusal(shiftless) };
    const po = p.orders[0];
    const order = p.bill.orders.find((b) => b.id === po.key) as BillOrder;
    // Server-held part-payment: its per-item allocation is not cached on this device.
    if (p.collected > 0 || (po.orderId && !po.orderLocal && order.payment_status !== "unpaid")) return { ok: false, reason: MERGE_ONLINE_PART_PAID_MESSAGE };
    if ((Number(order.discount_amount) || 0) > 0 || Math.abs((Number(order.total_amount) || 0) - (Number(order.subtotal) || 0)) > 0.005) return { ok: false, reason: MERGE_ADJUSTED_MESSAGE };
    const unpaid: BillLine[] = [];
    const retained: BillLine[] = [];
    for (const l of order.lines) {
      const paid = p.meta.get(l.id)?.paidQty ?? 0;
      if (paid > 0 && paid < l.quantity) return { ok: false, reason: MERGE_PARTIAL_LINE_MESSAGE };
      (paid >= l.quantity && paid > 0 ? retained : unpaid).push(l);
    }
    const outstanding = Math.round(unpaid.reduce((sum, l) => sum + l.line_total, 0) * 100) / 100;
    if (unpaid.length === 0) return { ok: false, reason: `Every item on table ${name} is already paid — there is nothing left to merge.` };
    legs.push({ row, p, draft, ref: { order_id: po.orderId, order_local: po.orderId ? null : po.orderLocal }, unpaid, retained, outstanding });
  }
  const currencies = new Set(legs.map((l) => l.p.currency ?? ""));
  if (currencies.size !== 1 || currencies.has("")) return { ok: false, reason: MERGE_CROSS_CURRENCY_MESSAGE };
  const shifts = await Promise.all(legs.map((l) => shiftKeyOf(scope, l.p, l.draft)));
  if (shifts.some((x) => !x)) return { ok: false, reason: shiftlessRefusal([]) };
  if (new Set(shifts).size !== 1) return { ok: false, reason: MERGE_CROSS_SHIFT_MESSAGE };

  const [pl, ...sl] = legs;
  const keyOf = (l: MergeLeg) => `${l.row.id}:${billRefKey(l.ref)}`;
  const sessions = new Set<string>();
  for (const l of legs) {
    if (l.ref.order_local) sessions.add(l.ref.order_local);
    if (l.draft) sessions.add(l.draft.local_session_id);
  }
  const prior = priorStructural(ctx.ops, new Set(legs.map((l) => billRefKey(l.ref))), sessions);
  const priorLive = prior.filter((o) => !structuralRefusedByServer(o));
  const gen = prior.length;
  const s = scope;
  const clientOpId = deterministicUuid([s.tenantId, s.branchId ?? "", s.cashierUserId, s.deviceId, s.terminalId ?? "", "merge_tables", keyOf(pl), ...sl.map(keyOf).sort(), String(gen)]);
  const operationId = MERGE_OP_PREFIX + clientOpId;

  const deps: string[] = [];
  const versionAfter: Record<string, string> = {};
  for (const l of legs) {
    const barrier = l.draft ? sessionBarrier(l.draft) : [];
    deps.push(...barrier, ...l.p.pendingMutationOpIds);
    const v = versionAfterFor(l.row.id, ctx.ops, [...barrier, ...l.p.mutationOpIds], ctx.mapAt);
    if (v) versionAfter[l.row.id] = v;
  }
  if (priorLive.length > 0) deps.push(priorLive[priorLive.length - 1].operation_id);
  const totalOutstanding = Math.round(legs.reduce((sum, l) => sum + l.outstanding, 0) * 100) / 100;
  const payload = {
    primary_table_id: primary.id,
    source_table_ids: sl.map((l) => l.row.id).sort(),
    primary_table_name: primary.name,
    source_table_names: Object.fromEntries(sl.map((l) => [l.row.id, l.row.name])),
    orders: Object.fromEntries(legs.map((l) => [l.row.id, l.ref])),
    session_locals: Object.fromEntries(legs.map((l) => [l.row.id, l.draft?.local_session_id ?? null])),
    paid_pins: Object.fromEntries(legs.map((l) => [billRefKey(l.ref), l.p.orders[0].pendingSplitOps.length])),
    version_after: versionAfter,
    // Projection-only (never sent): per table gross / collected / pending / outstanding R and the lines
    // that fold (R) vs stay on the source with its payments (P).
    preview: Object.fromEntries(
      legs.map((l) => [
        l.row.id,
        { gross: l.p.gross, collected: l.p.collected, paid_pending: l.p.paidPending, outstanding: l.outstanding, moved_line_ids: l.unpaid.map((x) => x.id), retained_line_ids: l.retained.map((x) => x.id) },
      ]),
    ),
    outstanding_after: totalOutstanding,
  };
  const locals = legs.map((l) => l.ref.order_local).filter((x): x is string => !!x);
  const op = newOp(scope, "merge_tables", operationId, clientOpId, primary.id, deps, locals, payload);

  return localdb.transaction("rw", localdb.operations, localdb.dineDrafts, async (): Promise<CaptureTableOpResult> => {
    if (await getOperation(operationId)) return { ok: true, operationId, clientOpId, alreadyCaptured: true, outstanding: totalOutstanding };
    for (const l of legs) {
      if (!l.draft) continue;
      const cur = await localdb.dineDrafts.get(l.draft.local_session_id);
      if (!cur || cur.status !== "open" || cur.table_id !== l.row.id) return { ok: false, reason: TABLE_OP_CHANGED_MESSAGE };
    }
    await localdb.operations.add(op);
    const now = new Date().toISOString();
    const blocks = sl.map((l) => ({ op_id: operationId, source_table_id: l.row.id, source_table_name: l.row.name, lines: l.unpaid.map((x) => ({ ...x, modifiers: [...x.modifiers] })) }));
    for (const l of sl) {
      if (l.draft) await localdb.dineDrafts.update(l.draft.local_session_id, { status: "merged", merged_into_table: primary.id, merged_op_id: operationId, updated_at: now });
    }
    if (pl.draft) {
      const cur = (await localdb.dineDrafts.get(pl.draft.local_session_id)) as DineDraft;
      await localdb.dineDrafts.update(pl.draft.local_session_id, { structural_op_id: operationId, merged_blocks: [...(cur.merged_blocks ?? []), ...blocks], updated_at: now });
    } else {
      const order = pl.p.bill.orders[0];
      await localdb.dineDrafts.add({
        ...newCarrierDraft(scope, { tableId: primary.id, tableName: primary.name, currency: pl.p.currency ?? order.currency, opId: operationId, canonicalOrderId: pl.ref.order_id, shiftId: order.shift_id ?? null }),
        merged_blocks: blocks,
      });
    }
    return { ok: true, operationId, clientOpId, alreadyCaptured: false, outstanding: totalOutstanding };
  });
}
