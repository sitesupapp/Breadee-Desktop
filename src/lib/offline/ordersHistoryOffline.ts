// rc.14 — ORDERS HISTORY offline continuity (the top-bar Orders modal + the Current Order carousel).
//
// rc.13 native F3: the Orders modal showed "0 orders" and a raw "TypeError: Failed to fetch" offline — both
// of its loaders (`loadShiftOrders`, `loadOrdersForDay`) are server-only `pos_orders` reads with no cache and
// no local source. Same pattern as the Delivery queue (rc.5), no new store:
//
// ONLINE  -> the production loaders UNCHANGED + a write-through snapshot (snapshots store) per shift / day.
// OFFLINE -> that snapshot (the canonical rows last confirmed) MERGED with what THIS device knows that the
//            snapshot cannot: offline-created Takeaway / Delivery orders (posOfflineTxns), offline Dine-In
//            bills (dineDrafts), and locally-captured payments still pending sync (op log). Never a fetch.
//            `limited` tells the UI the canonical history was never cached here (honest, never a fake empty).
//
// READ ONLY — display continuity. The op log stays the only mutation authority; nothing here writes an
// order, a payment or a shift.

import { isBackendReachable } from "@/lib/offline/reachability";
import { localdb, type DineDraft, type PosOfflineTxn } from "@/lib/offline/db";
import { canonicalIdFor } from "@/lib/offline/entityMap";
import { settleCoveredIds, settlePrecedence, settleStillCovers } from "@/lib/offline/operationalProjection";
import type { OfflineOperation } from "@/lib/offline/operationLog";
import { loadOrdersForDay, loadShiftOrders, toDayKey, type ShiftOpenOrder } from "@/lib/pos/shiftOrderSummary";

export type OrdersHistoryScope =
  | { kind: "shift"; tenantId: string | null; branchId: string | null; shiftId: string | null }
  | { kind: "day"; tenantId: string | null; branchId: string | null; day: string };

export type OrdersHistoryResult = {
  orders: ShiftOpenOrder[];
  /** True when read from this device (no server call was made). */
  offline: boolean;
  /** Offline AND no canonical snapshot for this scope was ever saved here (only local orders shown). */
  limited: boolean;
  /** When the canonical snapshot was last confirmed by the server (offline only). */
  cachedAt: string | null;
};

export const OFFLINE_HISTORY_NOTE = "Offline — showing orders saved on this device.";
export const OFFLINE_HISTORY_LIMITED_NOTE =
  "Offline — showing only orders taken on this device. Earlier orders for this period were not saved here and appear once you reconnect.";

const keyOf = (s: OrdersHistoryScope): string | null =>
  s.kind === "shift" ? (s.shiftId ? `orders:shift:${s.shiftId}` : null) : s.day ? `orders:day:${s.branchId ?? "none"}:${s.day}` : null;

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/** Injectable seams (tests only). */
export type OrdersHistoryDeps = {
  reachable?: () => Promise<boolean>;
  loadShift?: (i: { tenantId: string | null; shiftId: string | null }) => Promise<ShiftOpenOrder[]>;
  loadDay?: (i: { tenantId: string | null; branchId: string | null; day: string }) => Promise<ShiftOpenOrder[]>;
};

export async function loadOrdersHistoryOfflineAware(scope: OrdersHistoryScope, deps: OrdersHistoryDeps = {}): Promise<OrdersHistoryResult> {
  if (!scope.tenantId) return { orders: [], offline: false, limited: false, cachedAt: null };
  if (scope.kind === "shift" && !scope.shiftId) return { orders: [], offline: false, limited: false, cachedAt: null };
  const reachable = deps.reachable ?? isBackendReachable;
  if (await reachable().catch(() => false)) {
    // 1.0.38 (BUG 3) — the read-START time is this canonical snapshot's freshness (a settle synced during
    // the read is NOT in it), and ONLINE rows get the SAME local overlay as offline ones (one rule).
    const readAt = Date.now();
    const rows =
      scope.kind === "shift"
        ? await (deps.loadShift ?? loadShiftOrders)({ tenantId: scope.tenantId, shiftId: scope.shiftId })
        : await (deps.loadDay ?? loadOrdersForDay)({ tenantId: scope.tenantId, branchId: scope.branchId, day: scope.day });
    const key = keyOf(scope);
    if (key) {
      await localdb.snapshots
        .put({ key, tenant_id: scope.tenantId, branch_id: scope.branchId ?? null, data: rows, cached_at: new Date(readAt).toISOString() })
        .catch(() => undefined);
    }
    const locals = await projectLocalOrders(scope).catch(() => [] as ShiftOpenOrder[]);
    const payOverlay = await localPaymentOverlay(scope.tenantId, scope.branchId, readAt).catch(() => new Map<string, string>());
    // Online, only local rows the server does not have yet (still pending sync) join the canonical list.
    return { orders: mergeOrdersHistory(rows, locals.filter((l) => l.local_pending), payOverlay), offline: false, limited: false, cachedAt: null };
  }
  return readOrdersHistoryLocal(scope);
}

/** OFFLINE: the canonical snapshot for the scope merged with this device's local orders. Never a fetch. */
export async function readOrdersHistoryLocal(scope: OrdersHistoryScope): Promise<OrdersHistoryResult> {
  const key = keyOf(scope);
  const snap = key ? await localdb.snapshots.get(key).catch(() => undefined) : undefined;
  const ok = snap && snap.tenant_id === scope.tenantId && (scope.kind === "shift" || (snap.branch_id ?? null) === (scope.branchId ?? null));
  const cached = ok && Array.isArray(snap.data) ? (snap.data as ShiftOpenOrder[]) : [];
  const snapAt = ok ? Date.parse(snap.cached_at) : NaN;
  const locals = await projectLocalOrders(scope).catch(() => [] as ShiftOpenOrder[]);
  const payOverlay = await localPaymentOverlay(scope.tenantId, scope.branchId, Number.isFinite(snapAt) ? snapAt : null).catch(() => new Map<string, string>());
  return {
    orders: mergeOrdersHistory(cached, locals, payOverlay),
    offline: true,
    limited: !ok,
    cachedAt: ok ? snap.cached_at : null,
  };
}

/** 1.0.38 — overlay marker: a payment captured here that the SERVER REFUSED (never shown as Paid). */
export const PAYMENT_REFUSED = "refused";

/** PURE — canonical rows + local rows (a local row that already has its canonical id REPLACES nothing: the
 *  canonical row wins, carrying the local pending payment overlay), oldest first (the carousel order).
 *  `payOverlay` comes from the ONE precedence rule (settlePrecedence): "paid" / "on_account" = a local
 *  settlement the snapshot does not show yet (it wins); PAYMENT_REFUSED = the server refused it — a LOCAL
 *  row never claims Paid for it (a canonical row is the server's own word and stands). */
export function mergeOrdersHistory(cached: ShiftOpenOrder[], locals: ShiftOpenOrder[], payOverlay: Map<string, string>): ShiftOpenOrder[] {
  const byId = new Map<string, ShiftOpenOrder>();
  const canonical = new Set<string>();
  for (const o of cached) {
    byId.set(o.id, { ...o });
    canonical.add(o.id);
  }
  for (const l of locals) if (!byId.has(l.id)) byId.set(l.id, l);
  for (const [id, status] of payOverlay) {
    const o = byId.get(id);
    if (!o || o.status === "voided" || o.status === "refunded") continue;
    if (status === PAYMENT_REFUSED) {
      if (!canonical.has(id) && o.payment_status === "paid") byId.set(id, { ...o, payment_status: "unpaid" });
      continue;
    }
    // A payment captured on this device and not yet in the snapshot: never let an older UNPAID snapshot hide it.
    if (o.payment_status !== "paid") byId.set(id, { ...o, payment_status: status, ...(status === "on_account" ? { status: "completed" } : {}), local_pending: true });
  }
  return [...byId.values()].sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));
}

/** The shift ids equivalent to `shiftId` on this device: itself + its offline-local ↔ canonical twin. */
async function shiftAliases(shiftId: string): Promise<Set<string>> {
  const out = new Set([shiftId]);
  const pend = await localdb.pendingShifts.toArray().catch(() => []);
  for (const p of pend) {
    const canonical = p.server_shift_id ?? (await canonicalIdFor(p.local_shift_id).catch(() => null));
    if (p.local_shift_id === shiftId && canonical) out.add(canonical);
    if (canonical === shiftId) out.add(p.local_shift_id);
  }
  return out;
}

function inDay(iso: string | null | undefined, day: string): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) && toDayKey(d) === day;
}

/** Local orders of this scope (indexed by tenant; bounded by branch + shift/day). */
async function projectLocalOrders(scope: OrdersHistoryScope): Promise<ShiftOpenOrder[]> {
  const tenantId = scope.tenantId as string;
  const shifts = scope.kind === "shift" && scope.shiftId ? await shiftAliases(scope.shiftId) : null;
  const inScope = (branch: string | null, shift: (string | null | undefined)[], created: string | null | undefined) =>
    (branch ?? null) === (scope.branchId ?? null) &&
    (shifts ? shift.some((s) => !!s && shifts.has(s)) : scope.kind === "day" ? inDay(created, scope.day) : false);

  const [txns, drafts] = await Promise.all([
    localdb.posOfflineTxns.where("tenant_id").equals(tenantId).toArray().catch(() => [] as PosOfflineTxn[]),
    localdb.dineDrafts.where("tenant_id").equals(tenantId).toArray().catch(() => [] as DineDraft[]),
  ]);
  const out: ShiftOpenOrder[] = [];
  const scopedTxns = txns.filter((t) => inScope(t.branch_id, [t.shift_id, t.pending_shift_local_id, rec(t.order_payload).shift_id as string | undefined], t.created_at));
  const scopedDrafts = drafts.filter((d) => d.rounds.length > 0 && inScope(d.branch_id, [d.shift_id, d.shift_local], d.created_at));
  // ONE bulk read of the local → canonical order ids still unknown on the rows (no per-row lookup).
  // 1.0.38 — offline-created Dine-In sessions too (round 1 resolves session → canonical order).
  const unmapped = [
    ...scopedTxns.filter((t) => !t.server_order_id).map((t) => t.local_txn_id),
    ...scopedDrafts.filter((d) => !d.canonical_order_id).map((d) => d.local_session_id),
  ];
  const maps = unmapped.length > 0 ? await localdb.entityMap.bulkGet(unmapped).catch(() => []) : [];
  const canonicalOf = new Map<string, string>();
  unmapped.forEach((id, i) => {
    const m = maps[i];
    if (m?.canonical_id) canonicalOf.set(id, m.canonical_id);
  });
  for (const t of scopedTxns) {
    const p = rec(t.order_payload);
    const canonical = t.server_order_id ?? canonicalOf.get(t.local_txn_id) ?? null;
    out.push({
      id: canonical ?? t.local_txn_id,
      order_number: t.server_order_number ?? `OFF-${t.local_txn_id.slice(0, 6).toUpperCase()}`,
      order_type: typeof p.order_type === "string" ? p.order_type : "takeaway",
      status: "sent_to_kitchen",
      payment_status: t.payment_intent || t.paid ? "paid" : "unpaid",
      payment_method: t.payment_intent?.method ?? null,
      subtotal: typeof t.total === "number" ? t.total : null,
      discount_amount: 0,
      total_amount: typeof t.total === "number" ? t.total : null,
      currency: t.currency === "LBP" ? "LBP" : t.currency === "USD" ? "USD" : null,
      table_id: null,
      customer_id: typeof p.customer_id === "string" ? p.customer_id : null,
      customer_name: t.party_snapshot?.customer_name ?? null,
      customer_phone: t.party_snapshot?.customer_phone ?? null,
      cashier_user_id: t.cashier_user_id,
      staff_name: t.cashier_user_name ?? null,
      notes: typeof p.notes === "string" ? p.notes : null,
      created_at: t.created_at,
      local_pending: t.status !== "synced",
    });
  }
  // The settles these sessions recorded, by exact id (bounded by the sessions in scope — no op-log scan).
  const settleIds = [...new Set(drafts.map((d) => d.settled_operation_id).filter((x): x is string => !!x))];
  const settleRows = settleIds.length > 0 ? await localdb.operations.bulkGet(settleIds).catch(() => [] as (OfflineOperation | undefined)[]) : [];
  const settleById = new Map(settleRows.filter((o): o is OfflineOperation => !!o).map((o) => [o.operation_id, o]));
  for (const d of scopedDrafts) {
    const sent = d.lines.filter((l) => l.sent_round !== null);
    const total = sent.reduce((s, l) => s + (l.base_price + l.modifiers.reduce((m, x) => m + Number(x.price_delta) * Number(x.quantity ?? 1), 0)) * l.quantity, 0);
    const settle = d.settled_operation_id ? settleById.get(d.settled_operation_id) : undefined;
    const settledHere = d.status === "settled" && settle != null && settleStillCovers(settle);
    out.push({
      id: d.canonical_order_id ?? canonicalOf.get(d.local_session_id) ?? d.local_session_id,
      order_number: `OFF-${d.local_session_id.slice(0, 6).toUpperCase()}`,
      order_type: "dine_in",
      status: settledHere ? "completed" : "sent_to_kitchen",
      payment_status: settledHere ? (settle!.operation_type === "on_account_table" ? "on_account" : "paid") : "unpaid",
      payment_method: null,
      subtotal: total,
      discount_amount: 0,
      total_amount: total,
      currency: d.currency === "LBP" ? "LBP" : d.currency === "USD" ? "USD" : null,
      table_id: d.table_id,
      customer_id: null,
      customer_name: null,
      customer_phone: null,
      cashier_user_id: d.cashier_user_id,
      staff_name: null,
      notes: d.notes,
      created_at: d.created_at,
      local_pending: true,
    });
  }
  return out;
}

/**
 * Order id (canonical AND local) → the payment state this device knows that a canonical snapshot read at
 * `snapshotAt` may not show. 1.0.38 (BUG 3) — the SAME precedence rule as the floor and the Delivery queue
 * (`settlePrecedence`): a pending local settlement wins over an older snapshot; a settlement synced AFTER
 * the snapshot wins; one synced BEFORE it is already in it (the snapshot stands); a server-refused one is
 * PAYMENT_REFUSED. Covers takeaway cash sales (takeaway_sale + payment_intent) and offline-created orders
 * (local ids resolved to canonical through the entity map / the covered session's round 1).
 */
async function localPaymentOverlay(tenantId: string | null, branchId: string | null, snapshotAt: number | null): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!tenantId) return out;
  const PAY_TYPES = ["pay_order", "on_account_order", "pay_table", "on_account_table", "takeaway_sale"];
  const [ops, maps] = await Promise.all([
    localdb.operations.where("operation_type").anyOf(PAY_TYPES).toArray(),
    localdb.entityMap.where("tenant_id").equals(tenantId).toArray().catch(() => []),
  ]);
  const canonicalOf = new Map(maps.map((m) => [m.local_entity_id, m.canonical_id]));
  const resolve = (local: string) => canonicalOf.get(local) ?? null;
  const refused = new Set<string>();
  for (const o of ops) {
    if (o.scope.tenant_id !== tenantId || (o.scope.branch_id ?? null) !== (branchId ?? null)) continue;
    const p = rec(o.payload);
    const ids = new Set<string>();
    if (o.operation_type === "takeaway_sale") {
      if (!p.payment_intent && p.paid !== true) continue; // a send-only sale carries no payment
      for (const id of [o.canonical_entity_id, o.local_entity_id]) if (id) ids.add(id);
      if (o.local_entity_id && resolve(o.local_entity_id)) ids.add(resolve(o.local_entity_id) as string);
    } else if (o.operation_type === "pay_table" || o.operation_type === "on_account_table") {
      for (const id of settleCoveredIds(o, resolve)) ids.add(id);
    } else {
      if (typeof p.order_id === "string") ids.add(p.order_id);
      if (typeof p.order_local === "string") {
        ids.add(p.order_local);
        if (resolve(p.order_local)) ids.add(resolve(p.order_local) as string);
      }
    }
    const prec = settlePrecedence(o, snapshotAt);
    if (prec === "reflected") continue;
    if (prec === "refused") {
      if (o.status !== "cancelled") for (const id of ids) refused.add(id);
      continue;
    }
    const status = o.operation_type.startsWith("on_account") ? "on_account" : "paid";
    for (const id of ids) out.set(id, status);
  }
  // A valid settlement of an order outranks a refused one of the same order (e.g. a refused leg, then Pay).
  for (const id of refused) if (!out.has(id)) out.set(id, PAYMENT_REFUSED);
  return out;
}
