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
 * The status that means "still working on it" in the existing POS lifecycle.
 *
 * The vocabulary across `pos_orders` is `sent_to_kitchen`, `completed`,
 * `voided`, `refunded` - Level 3C established there is no other state, and
 * settlement moves an order to `completed`+`paid` in one statement.
 *
 * This constant is now only used to LABEL an order as open. It is deliberately
 * NOT a filter any more: the Current Order carousel reviews everything this
 * shift produced, settled and voided included, because a cashier closing a
 * till needs to see what happened, not only what is outstanding.
 */
export const OPEN_ORDER_STATUS = "sent_to_kitchen";

/** Is this order still outstanding? Used for labels and counts, never to hide. */
export function isOpenOrder(order: Pick<ShiftOpenOrder, "status" | "payment_status">): boolean {
  return order.status === OPEN_ORDER_STATUS && order.payment_status !== "paid";
}

/**
 * The lifecycle in the operator's words.
 *
 * Derived from the two stored fields and nothing else - no state is invented,
 * and an unrecognised status falls through to itself rather than being coerced
 * into a label that would be a guess.
 */
export function orderLifecycleLabel(order: Pick<ShiftOpenOrder, "status" | "payment_status">): string {
  switch (order.status) {
    case "voided":
      return "Voided";
    case "refunded":
      return "Refunded";
    case "cancelled":
      return "Cancelled";
    case "completed":
      return order.payment_status === "paid" ? "Paid" : "Completed";
    case OPEN_ORDER_STATUS:
      return order.payment_status === "paid" ? "Paid" : "Open";
    default:
      return order.status.replaceAll("_", " ");
  }
}

/** Badge tone per lifecycle: money in green, reversal in red, work in amber. */
export function orderLifecycleTone(order: Pick<ShiftOpenOrder, "status" | "payment_status">): "green" | "amber" | "red" | "slate" {
  if (order.status === "voided" || order.status === "cancelled" || order.status === "refunded") return "red";
  if (order.payment_status === "paid") return "green";
  if (order.status === OPEN_ORDER_STATUS) return "amber";
  return "slate";
}

export type ShiftOpenOrder = {
  id: string;
  order_number: string | null;
  order_type: "takeaway" | "dine_in" | "delivery" | string;
  status: string;
  payment_status: string;
  /** Stored only once a payment exists - never inferred for an unpaid order. */
  payment_method: string | null;
  subtotal: number | null;
  discount_amount: number;
  total_amount: number | null;
  currency: CurrencyCode | null;
  table_id: string | null;
  customer_id: string | null;
  /** Delivery only, resolved separately: the caller's name, nothing else. */
  customer_name: string | null;
  /** Delivery only, and only where the POS already shows it. */
  customer_phone: string | null;
  /** Who rang it up. Resolved to a display name where readable. */
  cashier_user_id: string | null;
  staff_name: string | null;
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
 * EVERY order belonging to the active shift, oldest first.
 *
 * Deliberately unfiltered by lifecycle. An earlier revision returned only
 * outstanding orders, which made the panel useless for the thing a cashier
 * actually does at the end of a shift: look back over what this till produced.
 * Paid, completed, voided, cancelled and refunded orders are all part of that
 * history, and the count beside "End shift" is only trustworthy if it counts
 * the same collection the list shows.
 *
 * Oldest first, so the arrows mean the same thing between refreshes; the panel
 * selects the NEWEST by default, which is the one just created.
 *
 * A null/absent shift returns an EMPTY list without touching the network -
 * "no active shift" is a normal state, not a reason to go looking for orders
 * that would necessarily belong to somebody else's till.
 */
export async function loadShiftOrders(input: {
  tenantId: string | null;
  shiftId: string | null;
}): Promise<ShiftOpenOrder[]> {
  if (!input.tenantId || !input.shiftId) return [];
  const { supabase } = await import("@/lib/supabase");
  const { data, error } = await supabase
    .from("pos_orders")
    .select(
      "id, order_number, order_type, status, payment_status, payment_method, subtotal, discount_amount, total_amount, primary_currency_snapshot, table_id, customer_id, cashier_user_id, notes, created_at",
    )
    .eq("tenant_id", input.tenantId)
    .eq("shift_id", input.shiftId)
    .order("created_at", { ascending: true })
    .limit(200);
  if (error) throw new Error(error.message);
  return await hydrate(((data ?? []) as unknown[]).map(parseOrderRow).filter((o): o is ShiftOpenOrder => o !== null));
}

/** One row of `pos_orders`, defensively. A malformed row is dropped, not guessed. */
function parseOrderRow(raw: unknown): ShiftOpenOrder | null {
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
    payment_method: strOrNull(r.payment_method),
    subtotal: numOrNull(r.subtotal),
    discount_amount: num(r.discount_amount),
    total_amount: numOrNull(r.total_amount),
    currency: currency === "LBP" ? "LBP" : currency === "USD" ? "USD" : null,
    table_id: strOrNull(r.table_id),
    customer_id: strOrNull(r.customer_id),
    customer_name: null,
    customer_phone: null,
    cashier_user_id: strOrNull(r.cashier_user_id),
    staff_name: null,
    notes: strOrNull(r.notes),
    created_at: strOrNull(r.created_at),
  };
}

/**
 * Fill in the names behind the ids - the customer for delivery rows, and the
 * cashier for every row. Two reads for the whole page rather than per order.
 *
 * Both are best-effort by design: a lookup that fails leaves the field null, so
 * the column is blank rather than wrong. A summary that cannot resolve a name is
 * still a correct summary; a summary showing the WRONG name is not.
 */
async function hydrate(orders: ShiftOpenOrder[]): Promise<ShiftOpenOrder[]> {
  if (orders.length === 0) return orders;
  const { supabase } = await import("@/lib/supabase");

  const customerIds = [...new Set(orders.map((o) => o.customer_id).filter((c): c is string => !!c))];
  if (customerIds.length > 0) {
    try {
      const res = await supabase.from("pos_customers").select("id, name, phone").in("id", customerIds);
      if (!res.error) {
        const byId = new Map(
          ((res.data ?? []) as unknown[]).map((raw) => {
            const r = asRecord(raw);
            return [str(r.id), { name: strOrNull(r.name), phone: strOrNull(r.phone) }] as const;
          }),
        );
        for (const o of orders) {
          if (!o.customer_id) continue;
          const found = byId.get(o.customer_id);
          o.customer_name = found?.name ?? null;
          o.customer_phone = found?.phone ?? null;
        }
      }
    } catch {
      /* names are a nicety; the list works without them */
    }
  }

  const staffIds = [...new Set(orders.map((o) => o.cashier_user_id).filter((c): c is string => !!c))];
  if (staffIds.length > 0) {
    try {
      const res = await supabase.from("profiles").select("id, full_name").in("id", staffIds);
      if (!res.error) {
        const names = new Map(
          ((res.data ?? []) as unknown[]).map((raw) => {
            const r = asRecord(raw);
            return [str(r.id), strOrNull(r.full_name)] as const;
          }),
        );
        for (const o of orders) {
          if (o.cashier_user_id) o.staff_name = names.get(o.cashier_user_id) ?? null;
        }
      }
    } catch {
      /* a missing staff name is a blank column, never a wrong one */
    }
  }
  return orders;
}

/**
 * A local calendar day as `YYYY-MM-DD`, which is what a date input speaks.
 *
 * Deliberately built from the LOCAL date parts rather than `toISOString()`: a
 * shift that runs past midnight belongs to the day the cashier says it does,
 * and slicing a UTC string would move orders across that line for anyone east
 * or west of UTC.
 */
export function toDayKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Walk the calendar by whole days, letting `Date` handle month/year rollover. */
export function shiftDay(dayKey: string, deltaDays: number): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  const next = new Date(y, (m ?? 1) - 1, d ?? 1);
  next.setDate(next.getDate() + deltaDays);
  return toDayKey(next);
}

/**
 * Every order this terminal can read for one calendar DAY.
 *
 * The Orders workspace's widest scope. Deliberately branch-scoped as well as
 * tenant-scoped: RLS already limits what comes back, and asking narrowly means
 * a cashier reviewing "the day" sees their own branch rather than a list they
 * have to mentally filter.
 *
 * Day boundaries are LOCAL, computed from the calendar date the operator picked
 * rather than from UTC - a shift that ends after midnight belongs to the day the
 * cashier says it does, and guessing a timezone here would put orders on the
 * wrong side of that line.
 */
export async function loadOrdersForDay(input: {
  tenantId: string | null;
  branchId: string | null;
  /** `YYYY-MM-DD`, as the date input speaks it. */
  day: string;
}): Promise<ShiftOpenOrder[]> {
  if (!input.tenantId || !input.day) return [];
  const [y, m, d] = input.day.split("-").map(Number);
  if (!y || !m || !d) return [];
  const from = new Date(y, m - 1, d, 0, 0, 0, 0);
  const to = new Date(y, m - 1, d + 1, 0, 0, 0, 0);

  const { supabase } = await import("@/lib/supabase");
  let query = supabase
    .from("pos_orders")
    .select(
      "id, order_number, order_type, status, payment_status, payment_method, subtotal, discount_amount, total_amount, primary_currency_snapshot, table_id, customer_id, cashier_user_id, notes, created_at",
    )
    .eq("tenant_id", input.tenantId)
    .gte("created_at", from.toISOString())
    .lt("created_at", to.toISOString())
    .order("created_at", { ascending: true })
    .limit(500);
  if (input.branchId) query = query.eq("branch_id", input.branchId);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return await hydrate(((data ?? []) as unknown[]).map(parseOrderRow).filter((o): o is ShiftOpenOrder => o !== null));
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
 * Three rules, in order:
 *
 *   1. A `preferId` wins outright. That is the "an order was just created"
 *      signal - the new order becomes the Current Order without a reload, a
 *      route switch or a manual refresh.
 *   2. Otherwise the selected order survives if it is still in this shift. An
 *      operator reading an order must not have it swapped underneath them
 *      because a different order was paid.
 *   3. Otherwise select the MOST RECENT order - the list is oldest-first, so
 *      that is the last index. This is also the first-load default, which is
 *      what a cashier wants on screen when they walk up to the till.
 *
 * Never throws, whatever the refresh brought back; an empty list selects
 * nothing.
 */
export function stableSelectionIndex(
  previousId: string | null,
  previousIndex: number,
  orders: ShiftOpenOrder[],
  preferId?: string | null,
): number {
  if (orders.length === 0) return -1;
  if (preferId) {
    const preferred = orders.findIndex((o) => o.id === preferId);
    if (preferred >= 0) return preferred;
  }
  if (previousId) {
    const kept = orders.findIndex((o) => o.id === previousId);
    if (kept >= 0) return kept;
  }
  // No prior selection, or it left the shift: the newest order.
  if (previousIndex < 0) return orders.length - 1;
  return Math.min(Math.max(previousIndex, 0), orders.length - 1);
}
