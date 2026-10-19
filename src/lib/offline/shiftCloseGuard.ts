// rc.12 — OFFLINE End Shift guard: the same rule the server applies, evaluated from what this device
// knows, BEFORE an offline close is captured.
//
// pos_end_shift refuses to close a shift that still has UNRESOLVED orders (pos_shift_unresolved_orders:
// anything not finalized — completed+paid / on-account — and not voided/cancelled/refunded): "Cannot
// close this shift: N order(s) still open. Resolve them before ending the shift." Through rc.11 an offline
// End Shift was captured regardless, so a shift with an open table or an unpaid delivery queued a close
// the server could only refuse — the server shift stayed open and the next Open Shift "succeeded" onto
// it (F1). Now the offline close is refused up-front with the SAME message (so the existing
// open_orders_block UI path applies), listing the orders.
//
// READ ONLY. Orders this device cannot attribute to the shift (no cached data, a pre-rc.12 dine-in draft
// without a shift reference) are NOT counted: the server stays the authority and still refuses then.

import { localdb, readCachedDeliveryQueue, readCachedTableMap, type DineDraft } from "@/lib/offline/db";
import { getOperationalTableBill, overlayDeliveryQueue, scopedOperations, type ProjectionScope } from "@/lib/offline/operationalProjection";
import { mergeDeliveryQueue, projectLocalDeliveryOrders } from "@/lib/offline/deliveryQueueOffline";
import type { DeliveryQueueOrder } from "@/lib/pos/deliveryOrderManagement";
import type { TableSummary } from "@/types/tables";

export type UnresolvedOrder = { kind: "dine_in" | "delivery"; label: string };

const RESOLVED_TERMINAL = new Set(["voided", "cancelled", "refunded"]);

/** PURE — a delivery/takeaway row is resolved when finalized (completed) or terminal. */
export function deliveryRowResolved(r: Pick<DeliveryQueueOrder, "status">): boolean {
  return r.status === "completed" || RESOLVED_TERMINAL.has(r.status);
}

/** The orders of `shiftId` this device knows to be unresolved (open dine-in bills, unsettled deliveries). */
export async function unresolvedOrdersForShift(
  scope: ProjectionScope & { tenantId: string; branchId: string | null },
  shiftId: string,
): Promise<UnresolvedOrder[]> {
  const out: UnresolvedOrder[] = [];
  const ops = await scopedOperations(scope).catch(() => []);

  // Delivery — the cached queue for this shift + this device's unsynced offline orders, through the ONE
  // operational projection (a locally captured settle counts as resolved).
  const cached = await readCachedDeliveryQueue(scope.tenantId, scope.branchId, shiftId).catch(() => null);
  const rows = Array.isArray(cached?.rows) ? (cached?.rows as DeliveryQueueOrder[]) : [];
  const locals = await projectLocalDeliveryOrders(scope.tenantId, scope.branchId, shiftId).catch(() => [] as DeliveryQueueOrder[]);
  const projected = await overlayDeliveryQueue(scope, mergeDeliveryQueue(rows, locals), { rowFetchedAt: cached?.cachedAt ?? null }).catch(() => [] as DeliveryQueueOrder[]);
  for (const r of projected) {
    if ((r.shift_id ?? null) !== shiftId || deliveryRowResolved(r)) continue;
    out.push({ kind: "delivery", label: `Delivery #${r.order_number ?? r.id.slice(0, 8)}` });
  }

  // Dine-In — every table with an ACTIVE bill in the operational projection whose orders belong to this
  // shift (canonical orders carry shift_id; local sessions carry the rc.12 shift reference).
  const drafts = (await localdb.dineDrafts.where("tenant_id").equals(scope.tenantId).toArray().catch(() => [] as DineDraft[])).filter(
    (d) => (d.branch_id ?? null) === (scope.branchId ?? null) && d.status === "open",
  );
  const draftShift = new Map(drafts.map((d) => [d.local_session_id, d.shift_id ?? d.shift_local ?? null]));
  const map = await readCachedTableMap(scope.tenantId, scope.branchId).catch(() => null);
  const tables = ((map?.map as { tables?: TableSummary[] } | null)?.tables ?? []) as TableSummary[];
  const seen = new Set<string>();
  for (const t of tables) {
    const p = await getOperationalTableBill(scope, t, ops).catch(() => null);
    if (!p || p.bill.orders.length === 0) continue;
    const mine = p.bill.orders.some((o) => (o.shift_id ?? null) === shiftId || draftShift.get(o.id) === shiftId);
    if (mine) {
      out.push({ kind: "dine_in", label: `Table ${t.name}` });
      seen.add(t.id);
    }
  }
  // A local session on a table the cached map does not list (e.g. map not cached yet).
  for (const d of drafts) {
    if (seen.has(d.table_id) || d.rounds.length === 0) continue;
    if ((d.shift_id ?? d.shift_local ?? null) !== shiftId) continue;
    const t = tables.find((x) => x.id === d.table_id) ?? ({ id: d.table_id, name: d.table_name, orders: 0 } as TableSummary);
    const p = await getOperationalTableBill(scope, t, ops).catch(() => null);
    if (p && p.bill.orders.length > 0) out.push({ kind: "dine_in", label: `Table ${d.table_name}` });
  }
  return out;
}

/** The refusal, worded EXACTLY like pos_end_shift so the existing open_orders_block UI path applies. */
export function openOrdersRefusal(orders: UnresolvedOrder[]): string {
  const list = orders.slice(0, 6).map((o) => o.label).join(", ");
  const more = orders.length > 6 ? ` and ${orders.length - 6} more` : "";
  return `Cannot close this shift: ${orders.length} order(s) still open (${list}${more}). Resolve them before ending the shift.`;
}
