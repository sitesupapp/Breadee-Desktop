// What may be done to a shift order, and what it is called.
//
// ONE LIFECYCLE, SHARED BY EVERY SURFACE. The Current Order panel, the Orders
// modal and the Delivery modal all offer actions on the same orders, and the
// rules for which action is legal are the server's, not each screen's. They are
// stated once here so three UIs cannot drift into three opinions about whether
// a paid order may be "cancelled".
//
// NOTHING IS INVENTED. Every action below maps to an RPC the desktop already
// calls. In particular there is deliberately no "mark collected": Level 3C
// established that `pos_pay_order` sets `payment_status = 'paid'` AND
// `status = 'completed'` in one statement, and that no `collected` state exists
// anywhere in the schema. Payment IS the completion of a delivery, so a
// collection action here would be a status the server cannot represent - see
// `deliveryHistory.ts`, which refuses to invent "awaiting collection" for the
// same reason.

import { voidActionFor, type VoidAction } from "@/lib/pos/deliveryOrderManagement";
import type { ShiftOpenOrder } from "@/lib/pos/shiftOrderSummary";

/** States from which nothing further can be done. */
export const TERMINAL_STATUSES = ["voided", "cancelled", "refunded"] as const;

export function isTerminalOrder(order: Pick<ShiftOpenOrder, "status">): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(order.status);
}

/**
 * The reversal this order's state permits, or null when none does.
 *
 * Delegates to the Level 3D rule rather than restating it: an unpaid order is
 * CANCELLED, a paid one is REFUNDED, and the server refuses `p_refund = false`
 * on a paid order outright. Returned as a name so no caller decides for itself.
 */
export function reversalActionFor(order: Pick<ShiftOpenOrder, "status" | "payment_status">): VoidAction | null {
  if (isTerminalOrder(order)) return null;
  return voidActionFor({ payment_status: order.payment_status } as Parameters<typeof voidActionFor>[0]);
}

/**
 * The destructive control on a SAVED order, in one wording for every surface.
 *
 * Deliberately one label rather than two. The panel that carries it sits where
 * an unsaved draft shows "Clear cart", and the operator has to be able to tell
 * those two apart at a glance without first reading the order's payment status:
 * "Clear cart" throws away something nobody else knows about, this one reaches
 * an order the server is holding. Which reversal it actually performs - a
 * cancellation or a refund - is named by `reversalLabel` on the hint beneath it
 * and again in the confirmation, so nothing is hidden; it is simply not the
 * thing the button has to say from across a counter.
 */
export const DESTRUCTIVE_ORDER_CTA = "Delete / Void";

/** The button's words. A refund is never called a cancellation. */
export function reversalLabel(action: VoidAction): string {
  return action === "refund" ? "Refund order" : "Cancel order";
}

/** The confirmation's title, naming the order it will actually affect. */
export function reversalTitle(action: VoidAction, orderNumber: string): string {
  return action === "refund" ? `Refund order #${orderNumber}` : `Cancel order #${orderNumber}`;
}

/**
 * What the operator is agreeing to, in plain words.
 *
 * A refund moves money and says so; a cancellation of an unpaid order does not,
 * and saying it does would make a cashier hesitate over something harmless.
 */
export function reversalWarning(action: VoidAction): string {
  return action === "refund"
    ? "This writes a negative payment and a refund record against the shift that took the money. It cannot be undone from the desktop."
    : "This voids the order. No money is involved because it was never paid. The reason is recorded against your account.";
}

// --- what each surface may offer ---------------------------------------------

/**
 * Whether an order may still be EDITED.
 *
 * `pos_edit_order` refuses a terminal order outright, and refuses a discount
 * change on a paid one while still allowing the note. So "editable" here means
 * "the server would accept something", and the edit screen decides which
 * fields it offers.
 */
export function canEditOrder(order: Pick<ShiftOpenOrder, "status">): boolean {
  return !isTerminalOrder(order);
}

/**
 * Whether SETTLEMENT is still available.
 *
 * This is the action a screen might be tempted to call "mark collected". It is
 * payment, it is the existing `pos_pay_order` flow, and it is only offered
 * while the order is unpaid and not terminal.
 *
 * ON-ACCOUNT IS DELIBERATELY EXCLUDED. Before receivables, `completed` always
 * meant `paid` - settlement was one atomic statement - so a completed order was
 * never unpaid. `pos_complete_on_account` is the only thing that now produces a
 * `completed` order that is still `unpaid`/`partial`, and that order is a
 * RECEIVABLE: it is collected through the receivables flow, never re-paid here.
 * Routing it back through `pos_pay_order` would take the full total a second
 * time on top of any partial already recorded, so this rule withholds Pay from
 * a completed-but-unpaid order. A genuinely open order awaiting settlement is
 * `sent_to_kitchen`, not `completed`, and is unaffected.
 */
export function canSettleOrder(order: Pick<ShiftOpenOrder, "status" | "payment_status">): boolean {
  if (isTerminalOrder(order)) return false;
  if (order.payment_status === "paid") return false;
  if (order.status === "completed") return false;
  return true;
}

/** Printing is always available: it reads an order and changes nothing. */
export function canPrintOrder(): boolean {
  return true;
}

// --- display helpers ---------------------------------------------------------

/** The payment cell. An unpaid order shows no method, because it has none. */
export function paymentLabel(order: Pick<ShiftOpenOrder, "payment_status" | "payment_method">): string {
  if (order.payment_status === "refunded") return "refunded";
  if (order.payment_status !== "paid") return order.payment_status || "unpaid";
  return order.payment_method ? `paid · ${order.payment_method}` : "paid";
}

/** The type cell: the route, plus the table when a dine-in order names one. */
export function typeLabel(order: Pick<ShiftOpenOrder, "order_type">, tableName: string | null): string {
  const route = order.order_type === "dine_in" ? "dine-in" : order.order_type;
  return order.order_type === "dine_in" && tableName ? `${route} · ${tableName}` : route;
}
