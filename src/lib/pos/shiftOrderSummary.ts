// Order Summary: the CURRENT SHIFT's open orders, readable at a glance.
//
// SCOPE IS THE SHIFT, AND NOTHING ELSE. Every row shown here answers one
// operational question - "what has this till started and not yet settled?" - so
// the query is keyed on the ACTIVE shift id and refuses to exist without one.
// Branch-wide open orders, other cashiers' shifts and historical shifts are all
// answers to different questions, and padding this panel with them would make
// the count lie about the drawer the operator is responsible for.
//
// READS ONLY. This module holds the same contracts the delivery queue already
// uses: `pos_orders` / `pos_order_items` / `pos_order_item_modifiers` /
// `pos_customers` under RLS. No RPC, no write, no new backend surface - and
// nothing here can mutate an order, a payment, a shift or a drawer, because no
// function in this file issues anything but a SELECT.
//
// The navigation and selection rules live here as pure functions so the parts
// that can be wrong quietly - wrap-around, and what happens to the selection
// when the list refreshes underneath it - are testable without React.

import { asRecord, num, numOrNull, str, strOrNull } from "@/lib/pos/rpc";
import type { CurrencyCode } from "@/lib/currency";

/**
 * An order that is still OPEN in the existing POS lifecycle.
 *
 * The vocabulary in use across `pos_orders` is `sent_to_kitchen`, `completed`,
 * `voided`, `refunded` (Level 3C established there is no other state), and
 * settlement is what moves an order to `completed`+`paid` in one statement. So
 * "open/unsettled" is exactly: still `sent_to_kitchen`, not yet `paid`.
 * Cancelled, voided, refunded and settled orders all fail one of the two
 * conditions and drop out without being named individually.
 */
export const OPEN_ORDER_STATUS = "sent_to_kitchen";

export type ShiftOpenOrder = {
  id: string;
  order_number: string | null;
  order_type: "takeaway" | "dine_in" | "delivery" | string;
  status: string;
  payment_status: string;
  subtotal: number | null;
  discount_amount: number;
  total_amount: number | null;
  currency: CurrencyCode | null;
  table_id: string | null;
  customer_id: string | null;
  /** Delivery only, resolved separately: the caller's name, nothing else. */
  customer_name: string | null;
  notes: string | null;
  created_at: string | null;
};

/** Operator wording for a route. Matches the receipts and the routing screen. */
export function orderRouteLabel(orderType: string): string {
  switch (orderType) {
    case "takeaway":
      return "Takeaway";
    case "dine_in":
      return "Dine-In";
    case "delivery":
      return "Delivery";
    default:
      return orderType;
  }
}

/**
 * The active shift's open orders, oldest first.
 *
 * Oldest first on purpose: the order that has been waiting longest is the one
 * the operator most needs to see, and a stable sort keeps the arrows meaning
 * the same thing between refreshes.
 *
 * A null/absent shift returns an EMPTY list without touching the network -
 * "no active shift" is a normal state, not a reason to go looking for orders
 * that would necessarily belong to somebody else's till.
 */
export async function loadShiftOpenOrders(input: {
  tenantId: string | null;
  shiftId: string | null;
}): Promise<ShiftOpenOrder[]> {
  if (!input.tenantId || !input.shiftId) return [];
  const { supabase } = await import("@/lib/supabase");
  const { data, error } = await supabase
    .from("pos_orders")
    .select(
      "id, order_number, order_type, status, payment_status, subtotal, discount_amount, total_amount, primary_currency_snapshot, table_id, customer_id, notes, created_at",
    )
    .eq("tenant_id", input.tenantId)
    .eq("shift_id", input.shiftId)
    .eq("status", OPEN_ORDER_STATUS)
    .neq("payment_status", "paid")
    .order("created_at", { ascending: true })
    .limit(100);
  if (error) throw new Error(error.message);

  const rows = ((data ?? []) as unknown[]).map((raw) => {
    const r = asRecord(raw);
    const id = strOrNull(r.id);
    if (!id) return null;
    const currency = strOrNull(r.primary_currency_snapshot);
    return {
      id,
      order_number: strOrNull(r.order_number),
      order_type: str(r.order_type, "takeaway"),
      status: str(r.status),
      payment_status: str(r.payment_status, "unpaid"),
      subtotal: numOrNull(r.subtotal),
      discount_amount: num(r.discount_amount),
      total_amount: numOrNull(r.total_amount),
      currency: currency === "LBP" ? "LBP" : currency === "USD" ? "USD" : null,
      table_id: strOrNull(r.table_id),
      customer_id: strOrNull(r.customer_id),
      customer_name: null,
      notes: strOrNull(r.notes),
      created_at: strOrNull(r.created_at),
    } as ShiftOpenOrder;
  });
  const orders = rows.filter((o): o is ShiftOpenOrder => o !== null);

  // Delivery rows may name their caller - it is already on the POS surface for
  // those orders. One read for all of them; a failure here degrades to numbers
  // only, because a summary that cannot resolve a name is still a summary.
  const customerIds = [...new Set(orders.map((o) => o.customer_id).filter((c): c is string => !!c))];
  if (customerIds.length > 0) {
    try {
      const res = await supabase.from("pos_customers").select("id, name").in("id", customerIds);
      if (!res.error) {
        const names = new Map(
          ((res.data ?? []) as unknown[]).map((raw) => {
            const r = asRecord(raw);
            return [str(r.id), strOrNull(r.name)] as const;
          }),
        );
        for (const o of orders) {
          if (o.customer_id) o.customer_name = names.get(o.customer_id) ?? null;
        }
      }
    } catch {
      /* names are a nicety; the panel works without them */
    }
  }
  return orders;
}

// ----------------------------------------------------------- navigation ------

/** Next index with wrap-around: last → first. A single order stays put. */
export function nextOrderIndex(current: number, count: number): number {
  if (count <= 0) return -1;
  return (Math.max(0, current) + 1) % count;
}

/** Previous index with wrap-around: first → last. A single order stays put. */
export function previousOrderIndex(current: number, count: number): number {
  if (count <= 0) return -1;
  return (Math.max(0, current) - 1 + count) % count;
}

/**
 * Where the selection lands after the list refreshes.
 *
 * The selected order survives if it still exists - an operator reading an order
 * must not have it swapped underneath them because someone else's order closed.
 * A selection that vanished (paid, voided, cleared elsewhere) falls to the
 * nearest remaining index, clamped; an empty list selects nothing. Never throws,
 * whatever the refresh brought back.
 */
export function stableSelectionIndex(
  previousId: string | null,
  previousIndex: number,
  orders: ShiftOpenOrder[],
): number {
  if (orders.length === 0) return -1;
  if (previousId) {
    const kept = orders.findIndex((o) => o.id === previousId);
    if (kept >= 0) return kept;
  }
  if (previousIndex < 0) return 0;
  return Math.min(Math.max(previousIndex, 0), orders.length - 1);
}
