// Delivery ORDERS offline continuity (rc.5).
//
// ONLINE  -> the production `loadDeliveryQueue` authority is used UNCHANGED, and its result is written
//            through to a durable per-(tenant,branch,shift) snapshot so the same list is readable offline.
// OFFLINE -> the snapshot is merged with locally-known offline-created delivery orders (from the
//            posOfflineTxns outbox), so the Orders tab shows real data instead of raising a raw
//            "TypeError: Failed to fetch". If nothing is on this device yet, the caller shows a clean
//            "none saved" state.
//
// This is a READ / CONTINUITY projection only. The operation log + posOfflineTxns outbox remain the
// mutation authority for pending writes; nothing here creates, settles or dedups a write. A local
// order whose send has fully synced is dropped from the projection (its canonical row is in the
// snapshot), so local and canonical never double-count.

import { isBackendReachable } from "@/lib/offline/reachability";
import {
  cacheDeliveryLines,
  cacheDeliveryQueue,
  readCachedDeliveryQueue,
  listPosOfflineTxns,
  type PosOfflineTxn,
} from "@/lib/offline/db";
import { canonicalIds } from "@/lib/offline/entityMap";
import { loadDeliveryQueue, type DeliveryQueueOrder } from "@/lib/pos/deliveryOrderManagement";

export type DeliveryQueueInput = {
  tenantId: string | null;
  branchId: string | null;
  shiftId: string | null;
  now: Date;
};

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/** Project a locally-captured offline delivery txn into a queue row for display continuity. */
export function projectTxnToQueueOrder(txn: PosOfflineTxn): DeliveryQueueOrder {
  const p = rec(txn.order_payload);
  const fee = typeof p.delivery_fee === "number" ? p.delivery_fee : null;
  const total = typeof txn.total === "number" ? txn.total : 0;
  return {
    id: txn.server_order_id ?? txn.local_txn_id,
    order_number: txn.server_order_number ?? `OFF-${txn.local_txn_id.slice(0, 6).toUpperCase()}`,
    status: "sent_to_kitchen",
    payment_status: txn.paid ? "paid" : "unpaid",
    payment_method: txn.payment_intent?.method ?? null,
    subtotal: fee != null ? Math.max(0, total - fee) : total,
    discount_amount: null,
    delivery_fee: fee,
    total_amount: total,
    currency: null,
    customer_id: typeof p.customer_id === "string" ? p.customer_id : null,
    address_id: typeof p.address_id === "string" ? p.address_id : null,
    notes: typeof p.notes === "string" ? p.notes : null,
    shift_id: txn.shift_id ?? null,
    created_at: txn.created_at ?? null,
    pos_entity_version: null,
  };
}

/** Locally-known offline delivery orders for this scope that are NOT yet fully synced (a synced order's
 *  truth is the canonical snapshot, so it is excluded here to avoid double-counting). */
export async function projectLocalDeliveryOrders(
  tenantId: string | null,
  branchId: string | null,
  shiftId: string | null,
): Promise<DeliveryQueueOrder[]> {
  if (!tenantId) return [];
  const txns = await listPosOfflineTxns().catch(() => [] as PosOfflineTxn[]);
  const inOu = txns
    .filter((t) => t.tenant_id === tenantId && (t.branch_id ?? null) === (branchId ?? null))
    .filter((t) => rec(t.order_payload).order_type === "delivery")
    .filter((t) => t.status !== "synced");
  // 1.0.38 (D7a) — an order captured under an OFFLINE-opened shift carries that shift's LOCAL id. Once
  // the shift syncs, the workspace asks for the CANONICAL shift id while the order (not yet synced) still
  // holds the local one — it vanished from the list. Match on either side's entity-map resolution.
  const shiftLocals = new Set<string>();
  if (shiftId) shiftLocals.add(shiftId);
  for (const t of inOu) {
    if (t.shift_id) shiftLocals.add(t.shift_id);
    if (t.pending_shift_local_id) shiftLocals.add(t.pending_shift_local_id);
  }
  const shiftCanon = shiftId ? await canonicalIds(Array.from(shiftLocals)).catch(() => ({}) as Record<string, string | null>) : {};
  const same = (id: string | null | undefined) => (id ? shiftCanon[id] ?? id : null);
  const wanted = same(shiftId);
  const scoped = inOu.filter((t) => !shiftId || t.shift_id === shiftId || same(t.shift_id) === wanted || (t.pending_shift_local_id != null && same(t.pending_shift_local_id) === wanted));
  // rc.11 — an order whose submit already synced (entity map resolved) but whose legacy row is not yet
  // reconciled projects under its CANONICAL id, so the merge de-dups it against the server row instead
  // of showing it twice in the window between the op sync and the legacy reconcile.
  const resolved = await canonicalIds(scoped.map((t) => t.local_txn_id)).catch(() => ({}) as Record<string, string | null>);
  return scoped.map((t) => projectTxnToQueueOrder(resolved[t.local_txn_id] ? { ...t, server_order_id: resolved[t.local_txn_id] } : t));
}

/** Merge a canonical snapshot with local projections, de-duped by id (a synced local order projects its
 *  canonical id, which the snapshot already carries → dropped), newest first. Pure. */
export function mergeDeliveryQueue(cached: DeliveryQueueOrder[], locals: DeliveryQueueOrder[]): DeliveryQueueOrder[] {
  const ids = new Set(cached.map((o) => o.id));
  const extra = locals.filter((l) => !ids.has(l.id));
  return [...cached, ...extra].sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
}

/**
 * Offline-aware delivery queue load. ONLINE: the server authority + write-through to the snapshot.
 * OFFLINE: the snapshot merged with local offline orders — never a raw fetch error. Returns `offline`
 * so the UI can show a precise empty state ("none saved on this device" vs "no orders yet").
 */
/** Injectable seams (tests only); production uses the real reachability probe + server reader. */
export type DeliveryQueueDeps = {
  reachable?: () => Promise<boolean>;
  load?: (input: DeliveryQueueInput) => Promise<DeliveryQueueOrder[]>;
  locals?: (tenantId: string | null, branchId: string | null, shiftId: string | null) => Promise<DeliveryQueueOrder[]>;
};

export async function loadDeliveryQueueOfflineAware(
  input: DeliveryQueueInput,
  deps: DeliveryQueueDeps = {},
): Promise<{ orders: DeliveryQueueOrder[]; offline: boolean; fetchedAt: number | null }> {
  const reachable = deps.reachable ?? isBackendReachable;
  const load = deps.load ?? loadDeliveryQueue;
  const locals = () => (deps.locals ?? projectLocalDeliveryOrders)(input.tenantId, input.branchId, input.shiftId).catch(() => [] as DeliveryQueueOrder[]);
  if (await reachable()) {
    const fetchedAt = Date.now();
    const rows = await load(input);
    // The snapshot holds SERVER rows only (locals are re-derived from the outbox on every read).
    await cacheDeliveryQueue(rows, input.tenantId, input.branchId, input.shiftId).catch(() => {});
    // rc.10 — every online queue read also keeps the open orders' LINES (+ their customers' profiles)
    // offline-ready, so an order created/changed online after hydration is still editable offline.
    if (!deps.load) void prewarmOpenDeliveryLines(input.tenantId, input.branchId, rows);
    // rc.11 — ONLINE also merges the offline-created orders that have NOT synced yet (e.g. waiting on a
    // dependency): a reconnect must never make a created/paid offline order vanish from the list.
    return { orders: mergeDeliveryQueue(rows, await locals()), offline: false, fetchedAt };
  }
  const cachedRaw = await readCachedDeliveryQueue(input.tenantId, input.branchId, input.shiftId).catch(() => null);
  const cached = Array.isArray(cachedRaw?.rows) ? (cachedRaw?.rows as DeliveryQueueOrder[]) : [];
  return { orders: mergeDeliveryQueue(cached, await locals()), offline: true, fetchedAt: cachedRaw?.cachedAt ?? null };
}

/** Pre-warm the delivery queue snapshot during normal online POS hydration, so the Orders tab is
 *  offline-ready WITHOUT the operator opening it online first. Online-only; never throws. */
export async function prewarmDeliveryQueue(input: DeliveryQueueInput): Promise<boolean> {
  if (!input.tenantId || !input.branchId) return false;
  try {
    if (!(await isBackendReachable())) return false;
    const rows = await loadDeliveryQueue(input);
    await cacheDeliveryQueue(rows, input.tenantId, input.branchId, input.shiftId);
    // rc.9 — also pre-hydrate the LINES of the open, unpaid orders (bounded) so the offline operational
    // projection can show + edit them without the operator having opened each one online first.
    void prewarmOpenDeliveryLines(input.tenantId, input.branchId, rows);
    return true;
  } catch {
    return false;
  }
}

/** rc.9 — per-session signature of the last line snapshot pre-warmed per order (version + total). */
const linesSig = new Map<string, string>();

/** Bounded (≤ 40 orders, 3 at a time) write-through of open unpaid delivery orders' lines. Read-only;
 *  never throws. The loader is injectable for tests. */
export async function prewarmOpenDeliveryLines(
  tenantId: string | null,
  branchId: string | null,
  rows: DeliveryQueueOrder[],
  load?: (orderId: string) => Promise<unknown>,
): Promise<number> {
  if (!tenantId) return 0;
  const reader = load ?? (async (id: string) => (await import("@/lib/pos/deliveryOrderManagement")).loadDeliveryOrderLines(id));
  const todo = rows
    .filter((r) => r.status === "sent_to_kitchen" && r.payment_status === "unpaid")
    .filter((r) => linesSig.get(r.id) !== `${r.pos_entity_version ?? ""}|${r.total_amount ?? ""}`)
    .slice(0, 40);
  let done = 0;
  const worker = async () => {
    for (let r = todo.shift(); r; r = todo.shift()) {
      const fetchedAt = Date.now();
      try {
        const lines = await reader(r.id);
        await cacheDeliveryLines(r.id, lines, tenantId, branchId, fetchedAt);
        linesSig.set(r.id, `${r.pos_entity_version ?? ""}|${r.total_amount ?? ""}`);
        done += 1;
      } catch {
        /* best-effort */
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  if (!load) void prewarmQueueCustomerProfiles(rows);
  return done;
}

const profileSeen = new Set<string>();

/** rc.10 — cache the FULL profile (addresses) of the customers on open delivery orders, so they can be
 *  selected for a NEW delivery order offline (a search hit alone caches only a compact match). Bounded,
 *  once per customer per session, read-only, never throws. */
async function prewarmQueueCustomerProfiles(rows: DeliveryQueueOrder[]): Promise<void> {
  try {
    const ids = Array.from(new Set(rows.map((r) => r.customer_id).filter((x): x is string => typeof x === "string" && x !== "" && !profileSeen.has(x)))).slice(0, 40);
    if (ids.length === 0) return;
    const { loadCustomerProfileOfflineAware } = await import("@/lib/offline/customerCache");
    for (const id of ids) {
      profileSeen.add(id);
      await loadCustomerProfileOfflineAware(id).catch(() => undefined);
    }
  } catch {
    /* best-effort */
  }
}
