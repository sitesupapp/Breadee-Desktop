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
  cacheDeliveryQueue,
  readCachedDeliveryQueue,
  listPosOfflineTxns,
  type PosOfflineTxn,
} from "@/lib/offline/db";
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
  return txns
    .filter((t) => t.tenant_id === tenantId && (t.branch_id ?? null) === (branchId ?? null))
    .filter((t) => rec(t.order_payload).order_type === "delivery")
    .filter((t) => (shiftId ? t.shift_id === shiftId : true))
    .filter((t) => t.status !== "synced")
    .map(projectTxnToQueueOrder);
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
};

export async function loadDeliveryQueueOfflineAware(
  input: DeliveryQueueInput,
  deps: DeliveryQueueDeps = {},
): Promise<{ orders: DeliveryQueueOrder[]; offline: boolean }> {
  const reachable = deps.reachable ?? isBackendReachable;
  const load = deps.load ?? loadDeliveryQueue;
  if (await reachable()) {
    const rows = await load(input);
    await cacheDeliveryQueue(rows, input.tenantId, input.branchId, input.shiftId).catch(() => {});
    return { orders: rows, offline: false };
  }
  const cachedRaw = await readCachedDeliveryQueue(input.tenantId, input.branchId, input.shiftId).catch(() => null);
  const cached = Array.isArray(cachedRaw?.rows) ? (cachedRaw?.rows as DeliveryQueueOrder[]) : [];
  const locals = await projectLocalDeliveryOrders(input.tenantId, input.branchId, input.shiftId);
  return { orders: mergeDeliveryQueue(cached, locals), offline: true };
}

/** Pre-warm the delivery queue snapshot during normal online POS hydration, so the Orders tab is
 *  offline-ready WITHOUT the operator opening it online first. Online-only; never throws. */
export async function prewarmDeliveryQueue(input: DeliveryQueueInput): Promise<boolean> {
  if (!input.tenantId || !input.branchId) return false;
  try {
    if (!(await isBackendReachable())) return false;
    const rows = await loadDeliveryQueue(input);
    await cacheDeliveryQueue(rows, input.tenantId, input.branchId, input.shiftId);
    return true;
  } catch {
    return false;
  }
}
