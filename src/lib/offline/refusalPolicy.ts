// 1.0.41 (BUG 03 RC-C / RC-D, Server Off F-REFUSAL) — what a server refusal means for the operator's Retry.
//
// Through 1.0.40 "Retry" was offered for EVERY parked op (syncCenterModel.canRetry: any needs_attention /
// conflict). Most refusals are deterministic for the frozen request the op carries — the bill it was pinned to
// was paid, changed, moved or closed; a round targets a bill that no longer exists; a split was refused on its
// residue — so re-sending the SAME request is refused again, and every Retry re-queued the dependency chain to
// "Pending" until the next pass parked it again ("Retry → Pending, never synced").
//
// Each parked op now gets ONE recovery class:
//   retry       the blocking condition is outside the request and a person can clear it (finish the kitchen
//               ticket, open the collector's shift, decide the pending transfer, grant a permission, a temporary
//               server error). Re-sending the same request (same client_op_id) can then succeed, exactly once.
//   rebase      a table open refused on its table-version CAS: Retry re-checks Breadee and re-arms the open with
//               the current version (openRebase, duplicate-safe).
//   review      the request can never succeed as captured. No Retry. The op stays parked with its evidence
//               (and any cash this device collected stays recorded); the operator reviews it / withdraws it.
//   via_parent  parked only behind a refused prerequisite: recover that prerequisite (its Retry re-opens this
//               chain); this op is never re-sent on its own.
//   legacy      a quarantined pre-1.0.38 outbox record: never sent.
// Unknown / unclassified refusals keep the old behaviour (retry): nothing is stranded by a code this build
// does not know, and a re-send stays exactly-once on its client_op_id.
//
// PURE. Nothing here writes.

import type { OfflineOperation } from "@/lib/offline/operationLog";
import { isCasRefusedOpen } from "@/lib/offline/operationalProjection";

export type RefusalRecovery = "retry" | "rebase" | "review" | "via_parent" | "legacy";

/** 1.0.41 (RC-D) — handler CONFLICT codes the Sync Center's Conflict list was missing (displayStateOf). */
export const CONFLICT_CODES_1041: readonly string[] = [
  "unsupported_state",
  "already_paid_elsewhere",
  "move_dest_unavailable",
  "merge_ambiguous_bill",
  "merge_no_shift",
  "merge_cross_shift",
  "merge_cross_currency",
  "idempotency_payload_mismatch",
];

/** Refusal codes (handlers' lower-case last_error_code) that are deterministic for the frozen request. */
const REVIEW_CODES = new Set([
  // the bill the op was pinned to is already closed / covered / changed
  "already_settled",
  "already_paid",
  "already_paid_elsewhere",
  "pay_bill_changed",
  "pay_amount_changed",
  "payment_residue",
  "on_account_bill_changed",
  "on_account_amount_changed",
  "settle_conflict",
  "split_conflict",
  "split_discount_unsupported",
  // a round / edit targets a bill that is no longer the table's open bill
  "expected_order_mismatch",
  // historical shiftless orders / a shift closed under the op (the request names that shift)
  "shift_missing",
  "shift_closed",
  "shift_mapping_missing",
  // version / pin drift of a frozen request (a table open is handled by the rebase first)
  "version_conflict",
  "idempotency_payload_mismatch",
  "move_source_changed",
  "move_source_empty",
  "move_payment_state_changed",
  "move_dest_occupied",
  "move_dest_unavailable",
  "move_table_conflict",
  "merge_expected_mismatch",
  "merge_bill_changed",
  "merge_payment_state_changed",
  "merge_primary_empty",
  "merge_source_empty",
  "merge_ambiguous_bill",
  "merge_no_shift",
  "merge_cross_shift",
  "merge_cross_currency",
  "merge_tables_conflict",
  "move_no_op",
  "move_same_table",
  "merge_no_op",
  "merge_no_sources",
  // malformed / unresolvable request
  "invalid_request",
  "no_table",
  "no_order",
  // 1.0.41 (S-PAYOUT) — the payout is above what is open on its source, or the source is void / cancelled
  "payout_exceeds_source",
  "payout_source_ineligible",
  "payout_exceeds_expense_balance",
  // the server's line price check (the captured lines are frozen; a reviewed re-entry is the recovery)
  "price_changed",
  "invalid_line_quantity",
  "invalid_line_price",
]);

/** Codes whose cause a person can clear outside the request; the same request may then succeed. */
const RETRY_CODES = new Set([
  "kitchen_active",
  "collector_no_open_shift",
  "collector_shift_closed",
  "order_transfer_pending",
  "permission",
  "price_override_not_permitted",
  "server_transient",
  "auth_expired",
  "retry_exhausted",
]);

/** v3/v4 merge UNSUPPORTED_STATE reasons a person can clear (everything else names the bill itself). */
const RETRYABLE_MERGE_REASONS = new Set(["kitchen_active"]);

/** The `reason:` token of an UNSUPPORTED_STATE refusal (same parse as pos/errors.mergeRefusalReason). */
function unsupportedReason(message: string | null | undefined): string | null {
  const m = /\breason:\s*([a-z_]+)/i.exec(message ?? "");
  return m ? m[1].toLowerCase() : null;
}

type ParkedLike = Pick<OfflineOperation, "status" | "operation_type" | "last_error_code" | "last_error_message"> &
  Partial<Pick<OfflineOperation, "canonical_entity_id" | "synced_at">>;

/** The effective refusal code: an UNSUPPORTED_STATE merge refusal is named by its reason token. */
export function effectiveRefusalCode(o: Pick<OfflineOperation, "last_error_code" | "last_error_message">): string {
  const code = (o.last_error_code ?? "").toLowerCase();
  if (code.startsWith("unsupported_state")) {
    const reason = unsupportedReason(o.last_error_message);
    if (reason) return reason;
  }
  return code;
}

/** PURE — the recovery class of a parked op (null when the op is not parked). */
export function recoveryOf(o: ParkedLike): RefusalRecovery | null {
  if (o.status !== "needs_attention") return null;
  const type = String(o.operation_type ?? "");
  if (type.startsWith("legacy_outbox:")) return "legacy";
  const raw = (o.last_error_code ?? "").toLowerCase();
  if (raw === "dependency_failed" || raw === "awaiting_parked_prerequisite") return "via_parent";
  if (raw === "circular_dependency") return "review";
  if (
    type === "dinein_open_table" &&
    isCasRefusedOpen({ canonical_entity_id: null, synced_at: null, ...o } as OfflineOperation)
  ) {
    return "rebase";
  }
  const code = effectiveRefusalCode(o);
  if (RETRY_CODES.has(code)) return "retry";
  if (raw.startsWith("unsupported_state")) {
    const reason = unsupportedReason(o.last_error_message);
    return reason && RETRYABLE_MERGE_REASONS.has(reason) ? "retry" : "review";
  }
  if (REVIEW_CODES.has(code)) return "review";
  return "retry";
}

/** PURE — does Retry have a chance to help this op? (retry or rebase only.) */
export function retryHelps(o: ParkedLike): boolean {
  const r = recoveryOf(o);
  return r === "retry" || r === "rebase";
}

/** Operator guidance for a retry-class refusal: what to clear first. Null = the generic wording. */
export function retryPrecondition(o: Pick<OfflineOperation, "last_error_code" | "last_error_message">): string | null {
  switch (effectiveRefusalCode(o)) {
    case "kitchen_active":
      return "A selected table still has items active in the kitchen. Mark them ready (or fire / void them) in the kitchen screen, then press Retry.";
    case "collector_no_open_shift":
      return "Breadee needs the person taking this payment to have their own open shift on this branch. Open that shift, then press Retry. Nothing was charged.";
    case "collector_shift_closed":
      return "The shift of the person taking this payment closed before Breadee received it. Open a shift, then press Retry. Nothing was charged.";
    case "order_transfer_pending":
      return "This order is waiting for a transfer decision. Accept or decline the transfer first, then press Retry.";
    case "permission":
    case "price_override_not_permitted":
      return "Breadee refused this for the signed-in user's permissions. A manager can grant the permission (or sign in), then press Retry.";
    default:
      return null;
  }
}

/** The operator sentence when Retry is NOT offered / refused for a parked op. */
export function noRetryText(o: ParkedLike): string {
  switch (recoveryOf(o)) {
    case "via_parent":
      return "This step waits on an earlier step that Breadee refused. Resolve that step first; this one follows it automatically.";
    case "legacy":
      return "This record was kept from an older version of Breadee for review only. It is never sent.";
    case "review":
      return `Sending this again cannot succeed: Breadee refused it because ${reviewReason(o)} It stays on this device with its details (and any money this terminal collected for it stays recorded). Review it with a manager; do not collect again.`;
    default:
      return "Retry is not available for this item.";
  }
}

function reviewReason(o: ParkedLike): string {
  const code = effectiveRefusalCode(o);
  switch (code) {
    case "already_settled":
    case "already_paid":
    case "already_paid_elsewhere":
      return "the bill was already paid on Breadee.";
    case "pay_bill_changed":
    case "pay_amount_changed":
    case "on_account_bill_changed":
    case "on_account_amount_changed":
    case "payment_residue":
    case "settle_conflict":
    case "split_conflict":
      return "the bill changed on Breadee after this terminal took the payment.";
    case "expected_order_mismatch":
      return "the bill it was added to was already closed or moved on Breadee.";
    case "shift_missing":
    case "shift_closed":
    case "shift_mapping_missing":
      return "the shift it belongs to is closed or unknown on Breadee.";
    case "price_changed":
    case "invalid_line_quantity":
    case "invalid_line_price":
      return "a line's price or quantity was refused.";
    case "circular_dependency":
      return "its steps wait for each other.";
    default:
      if (code.startsWith("move_") || code.startsWith("merge_") || code === "version_conflict" || code === "idempotency_payload_mismatch") {
        return "the tables changed on Breadee after this terminal captured it.";
      }
      return "the request no longer matches Breadee.";
  }
}
