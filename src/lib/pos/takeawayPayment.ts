// Takeaway payment LOST-RESPONSE recovery.
//
// `confirmPayment` already submits `pos_pay_order` exactly once, guarded by its
// own `inFlight.current` latch — that stays the ONLY latch and is untouched. What
// was missing is the recovery half: `pos_pay_order` has no idempotency key, so a
// lost response leaves the client unable to say whether money changed hands. The
// dine-in (`tablePayment.ts`) and delivery (`deliverySettlement.ts`) paths already
// solve this by ASKING the server rather than retrying; this brings the identical
// model to the single-order takeaway path.
//
// Deliberately reuses the delivery module's GENERIC single-order readers
// (`readSettledOrder`, `countPaymentRows`, `classifySettlement`) instead of
// introducing a second, subtly-different financial query. Those helpers read
// `pos_orders` / `pos_payments` by id under RLS and carry nothing delivery-specific.

import { classifyError } from "@/lib/pos/errors";
import {
  classifySettlement,
  countPaymentRows,
  readSettledOrder,
  type SettlementVerdict,
} from "@/lib/pos/deliverySettlement";
import type { OpenDeliveryOrder } from "@/lib/pos/deliveryOrder";

/**
 * Is this failure a TRANSPORT ambiguity (the response may have been lost after the
 * server committed), as opposed to a definitive server refusal?
 *
 * Reuses the shipped `errors.ts` classifier: the `offline` kind is exactly
 * `failed to fetch | network | offline | ERR_INTERNET`. A definitive refusal
 * (already paid, tender too low, permission, …) is NOT transport and is handled by
 * the existing error path, never by a re-read.
 */
export function isTransportFailure(error: unknown): boolean {
  return classifyError(error).kind === "offline";
}

export type TakeawayRecoveryResult =
  | { verdict: "settled"; order: OpenDeliveryOrder }
  | { verdict: "unpaid" }
  | { verdict: "ambiguous" };

/**
 * Authoritative re-read + classification for a takeaway order whose `pos_pay_order`
 * response was lost. NEVER guesses from local state.
 *
 *   settled   — the order reports paid + completed AND a payment row exists. The
 *               original charge landed; the response was simply lost. Recovered.
 *   unpaid    — the order is still open/unpaid AND no payment row exists. Nothing
 *               was charged; a retry is a safe, explicit operator decision.
 *   ambiguous — the server could not be read, or the two halves disagree. Neither
 *               retry nor completion is permitted.
 */
export async function recoverTakeawayPayment(
  orderId: string,
  // Injectable ONLY for testing the decision without a network; production uses
  // the shipped RLS-scoped readers.
  deps: {
    readOrder?: (id: string) => Promise<OpenDeliveryOrder | null>;
    countRows?: (id: string) => Promise<number>;
  } = {},
): Promise<TakeawayRecoveryResult> {
  const readOrder = deps.readOrder ?? readSettledOrder;
  const countRows = deps.countRows ?? countPaymentRows;
  let order: OpenDeliveryOrder | null;
  let paymentRows: number;
  try {
    order = await readOrder(orderId);
    paymentRows = await countRows(orderId);
  } catch {
    return { verdict: "ambiguous" };
  }
  const verdict: SettlementVerdict = classifySettlement({ order, paymentRows });
  if (verdict === "settled" && order) return { verdict: "settled", order };
  if (verdict === "unpaid") return { verdict: "unpaid" };
  return { verdict: "ambiguous" };
}
