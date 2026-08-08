// Server refusal -> cashier-facing guidance.
//
// The POS RPCs raise deliberate, well-worded exceptions (m93 owner block, m149
// shift lock, m216 void/refund rule, m223 branch resolution, m241 modifiers).
// Those messages are already good, so this NEVER replaces them - it classifies
// them, so the UI can decide whether to show a red fault or an amber "expected
// refusal, here is what to do next", and can offer the right recovery action.

export type RefusalKind =
  | "no_shift"
  | "shift_closed"
  | "permission"
  | "owner_blocked"
  | "branch"
  | "exchange_rate"
  | "already_paid"
  | "finalized"
  | "offline"
  // Dine-In tables (Level 2A)
  | "table_not_configured"
  | "table_not_found"
  | "table_occupied"
  | "table_no_open_order"
  | "feature_disabled"
  // Dine-In settlement (Level 2D)
  | "no_open_bill_to_pay"
  | "stale_bill_total"
  | "payment_in_progress"
  | "payment_ambiguous"
  | "payment_recovered"
  | "tender_too_low"
  | "invalid_discount"
  | "discount_permission"
  | "split_shift"
  | "mixed_currency"
  // Dine-In table operations (Level 2C)
  | "close_needs_payment"
  | "same_table"
  | "cross_tenant_table"
  | "clear_reason_required"
  // Dine-In rounds (Level 2B)
  | "empty_round"
  | "modifier_required"
  | "round_in_flight"
  | "stale_bill"
  | "append_refused"
  | "unknown";

export type ClassifiedError = {
  kind: RefusalKind;
  /** The server's own message, unmodified. */
  message: string;
  /** What the cashier should do next, when there is an obvious next step. */
  hint: string | null;
  /** Expected refusals are amber guidance; faults are red. */
  expected: boolean;
};

const RULES: { kind: RefusalKind; test: RegExp; hint: string | null; expected: boolean }[] = [
  // --- Dine-In settlement (Level 2D). Listed first: several of these contain
  // words the generic payment/permission rules further down would swallow.
  {
    kind: "no_open_bill_to_pay",
    // After a successful payment this is what a duplicate call gets. On its own
    // it is NOT proof of anything - `tablePayment.ts` pairs it with an
    // authoritative re-read before calling a payment settled.
    test: /no open order on this table to pay/i,
    hint: "This table has nothing left to settle. Refresh the map - the bill may already have been paid.",
    expected: true,
  },
  {
    kind: "stale_bill_total",
    test: /the bill changed before payment/i,
    hint: "Review the refreshed bill before taking payment. The amount on screen was out of date.",
    expected: true,
  },
  {
    kind: "payment_in_progress",
    test: /payment is already being sent/i,
    hint: "Wait for the current payment to finish. Do not send it again.",
    expected: true,
  },
  {
    kind: "payment_ambiguous",
    test: /could not confirm whether the payment/i,
    hint: "Do NOT take payment again. Refresh the table map and check whether the bill is already settled.",
    expected: false,
  },
  {
    kind: "payment_recovered",
    // Raised by nothing - matched when the recovery path reports a settlement it
    // proved after the fact, so the toast reads as success rather than failure.
    test: /was already settled|no second payment was taken/i,
    hint: "The bill is settled. Do not take payment again.",
    expected: true,
  },
  {
    kind: "tender_too_low",
    test: /tendered amount is less than the amount due|does not cover the bill/i,
    hint: "Collect the full amount, or enter the correct tendered value.",
    expected: true,
  },
  {
    kind: "discount_permission",
    // Listed ABOVE the generic permission rule so a discount refusal keeps its
    // own hint: the payment itself is still allowed, at full price.
    test: /permission to apply discounts/i,
    hint: "Take the payment at full price, or ask a manager to apply the discount.",
    expected: true,
  },
  {
    kind: "invalid_discount",
    test: /this discount cannot be applied|percentage cannot exceed|discount cannot exceed the subtotal|discount cannot be negative/i,
    hint: "Percent must be 0-100, and a fixed amount cannot be more than the subtotal.",
    expected: true,
  },
  {
    kind: "split_shift",
    test: /span multiple shifts or branches/i,
    hint: "Settle each order separately - a bill cannot straddle two shifts.",
    expected: true,
  },
  {
    kind: "mixed_currency",
    test: /different currency settings/i,
    hint: "Settle or clear each order separately - the server will not add raw USD to raw LBP.",
    expected: true,
  },
  // --- Dine-In table operations (Level 2C). The server's own wording is good
  // here, so these only add the next step - and, for Close, the honest fact that
  // paying a table from the desktop is not possible yet.
  {
    kind: "close_needs_payment",
    test: /pay the table bill first/i,
    hint: "Settle the bill first, or clear the table with a reason. Paying a table from the desktop arrives in Level 2D.",
    expected: true,
  },
  {
    kind: "same_table",
    test: /choose a different destination table/i,
    hint: "Pick a free table other than this one.",
    expected: true,
  },
  {
    kind: "cross_tenant_table",
    test: /tables belong to different tenants/i,
    hint: "Both tables must belong to this business. Refresh the table map.",
    expected: true,
  },
  {
    kind: "clear_reason_required",
    test: /a reason is required to clear a table/i,
    hint: "Say why the bill is being voided - it is recorded against your account.",
    expected: true,
  },
  // --- Dine-In rounds (Level 2B). These are client-side refusals raised before
  // a request is made, so they are listed first and matched on our own wording.
  {
    kind: "empty_round",
    test: /this round has no items/i,
    hint: "Add at least one item before sending the round.",
    expected: true,
  },
  {
    kind: "modifier_required",
    test: /choose a |choose at least |choose only one |choose at most |is not available for this item/i,
    hint: "Open the item and complete its required options.",
    expected: true,
  },
  {
    kind: "round_in_flight",
    test: /round is already being sent/i,
    hint: "Wait for the current round to finish before sending again.",
    expected: true,
  },
  {
    kind: "stale_bill",
    test: /bill changed|table's bill was settled|open order changed/i,
    hint: "The bill was refreshed. Check what changed, then send the round again.",
    expected: true,
  },
  {
    kind: "append_refused",
    // The server refuses to append to a bill it cannot lock or resolve.
    test: /cannot append|could not resolve the active bill|order is not open/i,
    hint: "Refresh the table map. Do NOT retry against a different table - the bill may have moved.",
    expected: true,
  },
  // --- Dine-In tables. Listed before the generic rules because several of these
  // also contain the words matched by the permission/branch rules further down.
  {
    kind: "table_not_configured",
    // pos_open_table raises this with errcode 22023 on a configured branch.
    test: /uses its configured tables|not part of the current table configuration/i,
    hint: "Pick a table from the map. Table configuration is managed in the web POS settings.",
    expected: true,
  },
  {
    kind: "table_not_found",
    // The last alternative is our own TableRequiredError: a dine-in round that
    // reached submission without a table would have opened a SECOND bill.
    test: /table not found|enter a table number or name|not attached to a table/i,
    hint: "Refresh the table map and try again.",
    expected: true,
  },
  {
    kind: "table_occupied",
    test: /destination table already has an open order/i,
    hint: "Choose a free table.",
    expected: true,
  },
  {
    kind: "table_no_open_order",
    test: /no open order on this table|has no open order to move/i,
    hint: "This table has no open bill. Refresh the map.",
    expected: true,
  },
  {
    kind: "permission",
    test: /pos\.tables\.view required/i,
    hint: "Ask a manager to grant table access.",
    expected: true,
  },
  {
    kind: "feature_disabled",
    test: /not enabled for this plan/i,
    hint: "This module is not part of the current plan.",
    expected: true,
  },
  {
    kind: "no_shift",
    test: /not attached to an open shift/i,
    hint: "Open a shift, then place the order again.",
    expected: true,
  },
  {
    // The desktop's OWN shift gates, which refuse before a request is made.
    // Listed after the server's wording so the server keeps precedence, and
    // given a hint that fits any of them rather than assuming an order.
    kind: "no_shift",
    test: /open a shift before/i,
    hint: "Open a shift from the status bar, then try again.",
    expected: true,
  },
  {
    kind: "shift_closed",
    test: /shift is closed|already closed|shift not found/i,
    hint: "This shift is no longer open. Refresh the shift and try again.",
    expected: true,
  },
  {
    kind: "owner_blocked",
    test: /owners cannot perform pos operations/i,
    hint: "Sign in with a manager or cashier account to operate the POS.",
    expected: true,
  },
  {
    kind: "permission",
    test: /do not have permission|are not allowed to|only a manager/i,
    hint: "Ask a manager to grant this permission, or have them perform the action.",
    expected: true,
  },
  {
    kind: "branch",
    test: /not assigned to a branch|wrong tenant context|branch/i,
    hint: "Your account is not scoped to this branch. Ask an admin to check your branch assignment.",
    expected: true,
  },
  {
    kind: "exchange_rate",
    test: /exchange rate/i,
    hint: "Set the USD to LBP rate on the web dashboard, or take this payment in USD.",
    expected: true,
  },
  {
    kind: "already_paid",
    test: /already paid/i,
    hint: "This order is already settled. Start a new order.",
    expected: true,
  },
  {
    kind: "finalized",
    test: /voided or refunded|already voided|already paid or finalized/i,
    hint: "This order can no longer be changed.",
    expected: true,
  },
  {
    kind: "offline",
    test: /failed to fetch|network|offline|ERR_INTERNET/i,
    hint: "Reconnect to the internet - POS orders cannot be saved offline yet.",
    expected: true,
  },
];

export function classifyError(error: unknown): ClassifiedError {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "Something went wrong.";
  for (const rule of RULES) {
    if (rule.test.test(message)) {
      return { kind: rule.kind, message, hint: rule.hint, expected: rule.expected };
    }
  }
  return { kind: "unknown", message, hint: null, expected: false };
}

/** Convenience for toasts: one line combining the server message and the hint. */
export function errorText(error: unknown): string {
  const c = classifyError(error);
  return c.hint ? `${c.message} ${c.hint}` : c.message;
}
