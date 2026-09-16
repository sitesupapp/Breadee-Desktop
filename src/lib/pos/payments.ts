// Payment against the staging `pos_pay_order` contract (m216 / m68 / m113).
//
// Server rules this mirrors (and never re-implements):
//   * requires an OPEN shift on the order  (_pos_lock_open_shift, m149)
//   * requires `pos.take_payments`
//   * a discount requires `pos.apply_discounts`; percent 0-100; amount <= subtotal
//   * LBP requires a valid tenant rate, else the payment is refused
//   * the CHARGED amount is derived server-side from the order - never from the
//     client. `amount` in the response is the truth, and it is what the receipt
//     prints.
//
// Tendered / change are a cash-handling aid computed locally from the server's
// amount. They are never sent and never posted.

import { callPosRpc, asRecord, bool, num, numOrNull, requireId, str } from "@/lib/pos/rpc";
import { hasValidRate, roundForCurrency, type CurrencyCode } from "@/lib/currency";
import type { PayOrderResult } from "@/types/pos";

/** The only method the current POS contract exercises; kept as a field, not a literal. */
export type PaymentMethod = "cash";

export const PAYMENT_METHODS: { value: PaymentMethod; label: string }[] = [{ value: "cash", label: "Cash" }];

export type PayOrderInput = {
  orderId: string;
  method: PaymentMethod;
  currency: CurrencyCode;
  /** Already converted to the order's PRIMARY currency by the caller. */
  discount?: Record<string, unknown>;
};

/**
 * Client-side pre-check for the one refusal that is worth catching before the
 * request: LBP with no usable rate. Everything else is left to the server so the
 * desktop can never be more permissive than the database.
 */
export function paymentBlockedReason(currency: CurrencyCode, rate: number | null | undefined): string | null {
  if (currency === "LBP" && !hasValidRate(rate)) {
    return "Set the USD to LBP exchange rate on the dashboard before accepting LBP payments";
  }
  return null;
}

export async function payOrder(input: PayOrderInput): Promise<PayOrderResult> {
  const row = asRecord(
    await callPosRpc("pos_pay_order", {
      p_payload: {
        order_id: input.orderId,
        method: input.method,
        currency_code: input.currency,
        ...(input.discount ?? {}),
      },
    }),
  );
  const currency = str(row.currency_code, "USD");
  return {
    order_id: requireId(row.order_id, "pos_pay_order", "order_id"),
    paid: bool(row.paid),
    method: str(row.method, input.method),
    subtotal: num(row.subtotal),
    discount: num(row.discount),
    amount: num(row.amount),
    order_number: str(row.order_number),
    currency_code: currency === "LBP" ? "LBP" : "USD",
    original_amount: num(row.original_amount),
    exchange_rate: numOrNull(row.exchange_rate),
  };
}

/**
 * Change due for a cash tender, in the tender currency. Negative "change" means
 * the tender does not cover the bill, which the UI blocks rather than submits.
 */
export function computeChange(
  amountDue: number,
  tendered: number,
  currency: CurrencyCode,
): { change: number; short: boolean } {
  const due = roundForCurrency(amountDue, currency);
  const paid = roundForCurrency(tendered, currency);
  const change = roundForCurrency(paid - due, currency);
  return { change: Math.max(change, 0), short: paid > 0 && paid < due };
}
