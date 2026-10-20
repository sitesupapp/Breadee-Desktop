// Server refusal -> cashier-facing guidance.
//
// The POS RPCs raise deliberate, well-worded exceptions (m93 owner block, m149
// shift lock, m216 void/refund rule, m223 branch resolution, m241 modifiers).
// Those messages are already good, so this NEVER replaces them - it classifies
// them, so the UI can decide whether to show a red fault or an amber "expected
// refusal, here is what to do next", and can offer the right recovery action.

export type RefusalKind =
  | "no_shift"
  // rc.14 — a historical bill the server holds WITHOUT a shift (never re-attributed automatically).
  | "historical_shiftless"
  | "shift_closed"
  // End Shift blocked because open orders remain (Part 6 — offer Transfer).
  | "open_orders_block"
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
  // Delivery customers (Level 3A)
  | "customer_permission"
  | "customer_offline"
  | "invalid_phone"
  | "duplicate_phone"
  | "customer_in_progress"
  | "customer_ambiguous"
  | "customer_missing"
  | "address_invalid"
  // Dine-In table operations (Level 2C)
  | "close_needs_payment"
  | "same_table"
  | "cross_tenant_table"
  | "clear_reason_required"
  // Dine-In line edits (1.0.31 Phase 2)
  | "reason_required"
  | "version_conflict"
  // Merge Tables v3 (1.0.36) — folding partially-paid bills
  | "merge_unsupported"
  | "merge_shift_busy"
  | "merge_cross_shift"
  | "merge_cross_currency"
  | "merge_ambiguous_bill"
  | "merge_primary_empty"
  | "merge_source_empty"
  // Open-Orders Transfer (Part 6)
  | "transfer_conflict"
  // Force End Shift (R4 1.0.36)
  | "force_end_has_paid_orders"
  | "force_end_snapshot_changed"
  | "force_end_not_accepted"
  | "force_end_recipient_ineligible"
  | "force_end_conflict"
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

/**
 * pos_merge_tables_v3 refuses an ineligible source bill with an UNSUPPORTED_STATE
 * whose message carries a `reason:` token naming WHY that bill cannot be folded.
 * Each token maps to one plain sentence a cashier can act on; an unrecognised token
 * falls back to the server's own wording. These replace the cryptic token the
 * server sends with guidance, they never override a refusal.
 */
export const MERGE_REASON_HINTS: Record<string, string> = {
  partial_line:
    "One of the selected tables has a part-paid line. Finish settling or split that bill before merging it in.",
  combo_partial:
    "A combo on one of the selected tables is only part paid. Settle it as a whole before merging.",
  settled_with_adjustments:
    "A selected bill was settled with adjustments, so it can no longer be folded into another table.",
  on_account:
    "A selected bill is on a customer account. Collect or clear the account first — on-account bills are not merged.",
  consumed:
    "One of the selected tables was already merged or settled. Reload the floor to see where its bill went.",
  amount_mismatch:
    "The amount already paid on a selected table does not match its bill. Reload the floor and review that bill first.",
  tender_mismatch:
    "The payments on a selected table do not reconcile with its bill. Review that table before merging.",
  over_allocation:
    "A selected table has more paid against it than its bill. Review that payment before merging.",
  nothing_to_merge:
    "There is nothing left to merge — the selected tables have no open amount to fold in.",
  kitchen_active:
    "A selected table still has items active in the kitchen. Wait for the kitchen, or fire/void them, before merging.",
  payment_residue:
    "A selected table has leftover payment that must be resolved before its bill can be merged.",
};

/** Pull the `reason:` token out of a v3 UNSUPPORTED_STATE merge refusal, if present. */
export function mergeRefusalReason(message: string): string | null {
  const m = /\breason:\s*([a-z_]+)/i.exec(message);
  return m ? m[1].toLowerCase() : null;
}

const RULES: { kind: RefusalKind; test: RegExp; hint: string | null; expected: boolean }[] = [
  // rc.14 — a HISTORICAL bill created without a shift (rc.4–rc.11 offline rounds). The server refuses to
  // pay / move / merge / transfer it; nothing can attach it to a shift automatically (by design — its
  // ownership is never rewritten). Listed first so no generic shift / merge rule swallows it.
  {
    kind: "historical_shiftless",
    test: /primary bill is not attached to a shift|selected orders are not attached to a shift|is not attached to a shift on the server/i,
    hint: "This bill was created without a valid shift and cannot be paid, moved or merged automatically. Use an online manager reconciliation for it, and use a different table for new orders.",
    expected: true,
  },
  // --- Delivery customers (Level 3A). Listed first: several contain words the
  // generic permission/offline rules further down would swallow.
  {
    kind: "duplicate_phone",
    // The gap this whole flow is built around: the server is unique on the RAW
    // phone only, so an equivalent number is a duplicate waiting to happen.
    test: /customer with this phone number already exists/i,
    hint: "Open the existing customer instead of creating a second record for the same number.",
    expected: true,
  },
  {
    kind: "customer_ambiguous",
    test: /could not confirm whether the customer/i,
    hint: "Search for the phone number first. Do NOT create the customer again until you know.",
    expected: false,
  },
  {
    kind: "customer_in_progress",
    test: /customer is already being saved/i,
    hint: "Wait for the current save to finish.",
    expected: true,
  },
  {
    kind: "customer_offline",
    test: /saving a customer needs a connection/i,
    hint: "Reconnect before adding or editing a customer - customer records are never queued offline.",
    expected: true,
  },
  {
    kind: "invalid_phone",
    test: /valid phone number|phone number is not valid|phone number is required to create/i,
    hint: "Use a local number (7-8 digits) or an international one with its country code.",
    expected: true,
  },
  {
    kind: "address_invalid",
    test: /address needs at least a street/i,
    hint: "Enter the street. Area, building and floor are optional.",
    expected: true,
  },
  {
    kind: "customer_missing",
    test: /customer not found|customer is no longer available/i,
    hint: "Search for the customer again - they may belong to another branch.",
    expected: true,
  },
  {
    kind: "customer_permission",
    test: /permission to (view|add or edit) customers|pos\.customers\.manage required/i,
    hint: "Ask a manager for customer access, or have them capture the customer.",
    expected: true,
  },
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
  // --- Dine-In line edits (1.0.31 Phase 2). Both are server refusals raised by
  // pos_edit_order_line via pos_op_error; the desktop prompts for the reason up
  // front, so REASON_REQUIRED is a backstop, and VERSION_CONFLICT is the standard
  // optimistic-concurrency refusal shared with the paid-removal path.
  {
    kind: "reason_required",
    test: /a reason is required to remove or reduce an item/i,
    hint: "Choose or type why the item is being removed or reduced - it is recorded against your account.",
    expected: true,
  },
  {
    kind: "version_conflict",
    test: /this order changed since it was loaded/i,
    hint: "The bill was reloaded with the latest changes. Review it, then make the edit again.",
    expected: true,
  },
  {
    // POS Final W3 (Part 5) — the payment-method editor's OWN optimistic-concurrency
    // refusal. A SEPARATE rule (not a broadened one) so the dine-in bill's established
    // wording and hint above are left exactly as they were.
    kind: "version_conflict",
    test: /this payment method changed since it was loaded/i,
    hint: "The payment method was reloaded with the latest changes. Review it, then save again.",
    expected: true,
  },
  {
    // POS Final W4/W5 (Part 6) — Open-Orders Transfer optimistic-concurrency refusal (the
    // transfer row, or an order, moved under the operator). Its OWN rule so the bill and
    // payment-method wordings above are untouched.
    kind: "version_conflict",
    test: /this transfer changed since it was loaded|one or more orders changed since the transfer/i,
    hint: "The transfer was reloaded with the latest state. Review it, then try again.",
    expected: true,
  },
  {
    // The transfer already reached a terminal state (approved/rejected), or a re-approval was
    // attempted on a non-rejected transfer — a stale view, not a fault. Reload to see its state.
    kind: "transfer_conflict",
    test: /this transfer (was|is) already|only a rejected transfer can be re-approved/i,
    hint: "This transfer already moved on. Reload the transfers list to see its current state.",
    expected: true,
  },
  // --- Force End Shift (R4 1.0.36). Listed BEFORE the generic branch / shift / permission rules
  // because several messages contain "branch" or "shift" that those rules would otherwise swallow.
  // These match the server's HUMAN wording (pos_op_error puts the FORCE_END_* code in `detail`, not
  // in the message the client reads), grouped into one plain next step the operator can act on.
  {
    kind: "force_end_not_accepted",
    test: /recipient has not accepted this hand-over/i,
    hint: "Wait for the recipient to accept the hand-over, then finalize the force-end.",
    expected: true,
  },
  {
    kind: "force_end_has_paid_orders",
    test: /paid or part-paid orders that must be settled or voided before a force-end/i,
    hint: "Settle, void or refund the paid and part-paid orders first — only fully-unpaid orders can be handed over.",
    expected: true,
  },
  {
    kind: "force_end_snapshot_changed",
    test: /open orders changed since the hand-over was requested/i,
    hint: "The shift's open orders changed. Cancel this hand-over and start a new force-end with the current orders.",
    expected: true,
  },
  {
    kind: "force_end_recipient_ineligible",
    test: /recipient (has no |is not |is no longer |can no longer |no longer has |has more than one )|recipient shift (is no longer open|no longer belongs|must differ)/i,
    hint: "Pick a recipient who is active in this branch and has exactly one open shift, then try again.",
    expected: true,
  },
  {
    kind: "force_end_conflict",
    test: /cannot hand orders to yourself/i,
    hint: "Choose another cashier as the recipient — you cannot hand your own orders to yourself.",
    expected: true,
  },
  {
    kind: "force_end_conflict",
    test: /end it normally instead of forcing|no transferable open orders found/i,
    hint: "This shift has no unpaid open orders to hand over — end it the normal way instead.",
    expected: true,
  },
  {
    kind: "force_end_conflict",
    test: /source shift is no longer open|that shift is not open|this hand-over is no longer pending|this hand-over can no longer be cancelled/i,
    hint: "This hand-over already moved on. Reload the force-end list to see its current state.",
    expected: true,
  },
  // --- Merge Tables v3 (1.0.36). The server raises these when a source bill cannot
  // be folded into the primary. The UNSUPPORTED_STATE `reason:` tokens are mapped
  // separately in classifyError via MERGE_REASON_HINTS; the rules here cover the
  // coded, reason-less refusals. VERSION_CONFLICT is a SEPARATE merge rule (its own
  // wording and hint) so the dine-in bill / payment-method / transfer version rules
  // above are left exactly as they were.
  {
    kind: "version_conflict",
    test: /changed since the merge was opened|a table changed since the merge/i,
    hint: "The floor was reloaded with the latest table state. Review it, then open the merge again.",
    expected: true,
  },
  {
    kind: "merge_shift_busy",
    test: /MERGE_SHIFT_BUSY/i,
    hint: "A table in this merge is being changed on another till right now. Try again in a moment.",
    expected: true,
  },
  {
    kind: "merge_cross_shift",
    test: /MERGE_CROSS_SHIFT/i,
    hint: "These bills belong to different shifts. A bill cannot be merged across two shifts — settle them separately.",
    expected: true,
  },
  {
    kind: "merge_cross_currency",
    test: /MERGE_CROSS_CURRENCY/i,
    hint: "These bills use different currencies. The server will not fold raw USD into raw LBP — settle them separately.",
    expected: true,
  },
  {
    kind: "merge_ambiguous_bill",
    test: /MERGE_AMBIGUOUS_BILL/i,
    hint: "A selected table has more than one open bill, so the merge is ambiguous. Reload the floor and review that table.",
    expected: true,
  },
  {
    kind: "merge_primary_empty",
    test: /MERGE_PRIMARY_EMPTY/i,
    hint: "The table you are merging into has no open bill. Open or seat it first, or merge into a different table.",
    expected: true,
  },
  {
    kind: "merge_source_empty",
    test: /MERGE_SOURCE_EMPTY/i,
    hint: "One of the selected tables has no open bill to merge. Reload the floor and pick an occupied table.",
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
    // POS Final W4/W5 (Part 6) — End Shift refused because open orders remain. Classified so
    // the UI can offer the Transfer action instead of just showing the refusal.
    kind: "open_orders_block",
    // The canonical pos_end_shift refusal is "... N order(s) still open. Resolve them before
    // ending the shift." Match that specifically — do NOT broadly match "cannot close this shift",
    // which other refusals could also use and would wrongly offer the Transfer action.
    test: /order\(s\) still open/i,
    hint: "Transfer or resolve the open orders, then end your shift.",
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
  // Merge Tables v3: an UNSUPPORTED_STATE refusal carries a `reason:` token naming
  // WHY a source bill could not be folded. Map it to one plain sentence; an
  // unrecognised token still shows the server's own message. Guarded so a stray
  // "reason:" elsewhere is not swallowed: the message must be an UNSUPPORTED_STATE
  // or the token must be one we recognise.
  const reason = mergeRefusalReason(message);
  if (reason && (/unsupported_state/i.test(message) || reason in MERGE_REASON_HINTS)) {
    return { kind: "merge_unsupported", message, hint: MERGE_REASON_HINTS[reason] ?? null, expected: true };
  }
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
