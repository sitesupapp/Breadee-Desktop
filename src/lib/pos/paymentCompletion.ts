// What happens after `pos_pay_order` returns, as pure data.
//
// Extracted from the payment handler so the post-payment sequence is testable
// without mounting React: the receipt is built from the SERVER response, and the
// ordered completion steps are returned rather than performed. The caller applies
// them; the rules live here.
//
// The ordering matters and is asserted by tests:
//   1. store + present the receipt   (data and visibility together)
//   2. close the payment dialog
//   3. reset the logical cart
// The receipt is stored FIRST so clearing the cart can never race the data it
// was built from.

import { buildReceipt, type ReceiptData } from "@/lib/receipt";
import { lineTotals } from "@/lib/pos/modifiers";
import { computeChange } from "@/lib/pos/payments";
import { convertCurrency, hasValidRate, type CurrencyCode } from "@/lib/currency";
import type { CartLine, PayOrderResult } from "@/types/pos";

export type PaymentCompletionInput = {
  result: PayOrderResult;
  /** The lines as they were at payment time - captured before the cart resets. */
  lines: CartLine[];
  /** Fallback order number when the server response omits one. */
  fallbackOrderNumber: string;
  tenantName: string;
  branchName: string;
  operatorName: string;
  /** The tenant's primary (selling) currency. */
  primaryCurrency: CurrencyCode;
  /** The currency actually tendered. */
  tenderCurrency: CurrencyCode;
  rate: number | null;
  tenderedInput: number | null;
  shiftId: string | null;
  at: string;
};

export type CompletionStep = "present-receipt" | "close-payment-dialog" | "reset-cart";

export const COMPLETION_SEQUENCE: CompletionStep[] = [
  "present-receipt",
  "close-payment-dialog",
  "reset-cart",
];

export type PaymentCompletion = {
  receipt: ReceiptData;
  steps: CompletionStep[];
};

/**
 * Amount due in the TENDER currency. Returns null when the tender currency
 * differs from the selling currency and no usable rate exists - the receipt then
 * omits the tender block rather than printing a converted-at-zero figure.
 */
export function tenderTotalFor(
  amount: number,
  primaryCurrency: CurrencyCode,
  tenderCurrency: CurrencyCode,
  rate: number | null,
): number | null {
  if (tenderCurrency === primaryCurrency) return amount;
  if (!hasValidRate(rate)) return null;
  try {
    return convertCurrency(amount, primaryCurrency, tenderCurrency, rate);
  } catch {
    return null;
  }
}

export function buildPaymentReceipt(input: PaymentCompletionInput): ReceiptData {
  const { result } = input;
  const tenderTotal = tenderTotalFor(result.amount, input.primaryCurrency, input.tenderCurrency, input.rate);

  // A tender below the bill is refused before submission, so anything short here
  // is treated as "paid exactly" rather than printing negative change.
  const tendered =
    tenderTotal === null
      ? null
      : input.tenderedInput != null && input.tenderedInput >= tenderTotal
        ? input.tenderedInput
        : tenderTotal;
  const change = tenderTotal === null || tendered === null ? null : computeChange(tenderTotal, tendered, input.tenderCurrency).change;

  return buildReceipt({
    businessName: input.tenantName,
    branchName: input.branchName,
    staffName: input.operatorName,
    orderNumber: result.order_number || input.fallbackOrderNumber,
    at: input.at,
    paid: true,
    method: result.method,
    currency: input.primaryCurrency,
    lines: input.lines.map((l) => ({
      name: l.name,
      qty: l.quantity,
      unitPrice: lineTotals(l.base_price, l.modifiers, 1).finalUnitPrice,
      lineTotal: lineTotals(l.base_price, l.modifiers, l.quantity).lineTotal,
      modifiers: l.modifiers.map((m) => ({ name: m.name, price_delta: m.price_delta, quantity: m.quantity })),
      note: l.kitchen_note,
    })),
    // Every monetary figure is the server's, never recomputed here.
    subtotal: result.subtotal,
    discount: result.discount,
    total: result.amount,
    tenderCurrency: input.tenderCurrency,
    tenderTotal,
    tendered,
    change,
    exchangeRate: result.exchange_rate,
    shiftRef: input.shiftId ? input.shiftId.slice(0, 8) : null,
  });
}

/** The receipt plus the ordered steps the caller must apply. */
export function completePayment(input: PaymentCompletionInput): PaymentCompletion {
  return { receipt: buildPaymentReceipt(input), steps: COMPLETION_SEQUENCE };
}
