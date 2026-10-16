// Phase D — ONLINE write-through of refund-proofs for paid orders.
//
// An offline refund is only allowed against an order whose refund-proof was cached while ONLINE
// (policy rules 1/8/9). This is the producer side: when connected, it reads the authoritative
// paid orders of a shift and writes their proof into the local cache, so a later offline refund
// can prove the original + refundable balance. It runs ONLY online and is best-effort — a failure
// never blocks the UI; it just means those orders stay online-only to refund (fail-closed).
//
// refundable_usd is the client's best local knowledge of the refundable balance, derived exactly
// as the server derives the order's USD total (total_amount_usd, else converted from the order
// currency + snapshot rate). The server re-verifies it under the row lock via p_expected_refund_usd,
// so any drift (e.g. a partial payment) is caught as a conflict, never a wrong-amount refund.

import { supabase } from "@/lib/supabase";
import { applyProofRow, type RefundScope, type ProofSourceRow } from "@/lib/offline/refundOffline";

export { refundableUsdOf } from "@/lib/offline/refundOffline";

/**
 * Write through refund-proofs for every PAID, non-terminal order of a shift. Online-only,
 * best-effort. Returns the number of proofs cached. Safe to call on every orders refresh while
 * connected — it is idempotent per order (a newer proof replaces the prior one).
 */
export async function hydrateRefundProofs(scope: RefundScope, shiftId: string | null): Promise<number> {
  if (!scope.tenantId || !shiftId) return 0;
  // Read EVERY order of the shift (not just paid ones) so a proof can be EVICTED the moment its
  // order is no longer offline-refundable — refunded/voided/cancelled elsewhere, or no longer
  // paid. Without eviction a stale proof would let the operator start an offline refund that can
  // only conflict on sync; the server guard still blocks the money, but evicting avoids the
  // dead-end entirely.
  const { data, error } = await supabase
    .from("pos_orders")
    .select(
      "id, order_number, payment_status, status, shift_id, pos_entity_version, total_amount, total_amount_usd, primary_currency_snapshot, usd_to_lbp_rate_snapshot",
    )
    .eq("tenant_id", scope.tenantId)
    .eq("shift_id", shiftId);
  if (error || !data) return 0;

  // `database.types.ts` predates m216/m224 and does not know `pos_entity_version` on pos_orders
  // (same staleness documented in lib/pos/rpc.ts), so the select's inferred row type is a
  // SelectQueryError. The column exists in the live schema; cast through unknown to the real shape.
  // EVERY row (including a null/unknowable status) is applied — applyProofRow evicts a stale proof
  // whenever the order is no longer paid/non-terminal/knowable, so none can outlive refundability.
  let cached = 0;
  for (const raw of data as unknown as ProofSourceRow[]) {
    if ((await applyProofRow(scope, raw)) === "cached") cached++;
  }
  return cached;
}
