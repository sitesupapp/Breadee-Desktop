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

import { buildReceipt, type ReceiptData, type ReceiptLine } from "@/lib/receipt";
import { lineTotals } from "@/lib/pos/modifiers";
import { computeChange } from "@/lib/pos/payments";
import { convertCurrency, hasValidRate, type CurrencyCode } from "@/lib/currency";
import type { CartLine, PayOrderResult } from "@/types/pos";

export type PaymentCompletionInput = {
  result: PayOrderResult;
  /** The lines as they were at payment time - captured before the cart resets. */
  lines: CartLine[];
  /**
   * The SERVER's lines, when the order being settled already existed (1.0.4).
   *
   * Paying a saved order from the Current Order carousel is the same payment,
   * through the same `pos_pay_order` authority, with one difference: there is no
   * cart behind it. The lines are read from `pos_order_items` and handed in
   * here, and they take precedence over `lines` when present - which is also why
   * `lines` may legitimately be empty on that path. Nothing else about the
   * receipt changes, so a reprint of a carousel settlement and a reprint of a
   * till settlement are the same document.
   */
  receiptLines?: ReceiptLine[] | null;
  /**
   * True when the order already existed before this payment.
   *
   * The ONLY thing it changes is whether the cart is reset afterwards: the cart
   * holds a different, unsaved draft in that case, and clearing it would throw
   * away a basket the cashier is still building for the next customer.
   */
  existingOrder?: boolean;
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

/**
 * The same sequence, minus the cart reset, for settling an order that already
 * existed. The cart was never this order's cart; resetting it would discard an
 * unrelated draft. Everything else - receipt first, dialog second - is identical
 * for the reason the ordering exists at all.
 */
export const EXISTING_ORDER_COMPLETION_SEQUENCE: CompletionStep[] = [
  "present-receipt",
  "close-payment-dialog",
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
    // `orderType` is left to default to "Takeaway" for display; the SOURCE is
    // stated explicitly, because print routing must not read a display string.
    orderSource: "takeaway",
    orderNumber: result.order_number || input.fallbackOrderNumber,
    at: input.at,
    paid: true,
    method: result.method,
    currency: input.primaryCurrency,
    lines:
      input.receiptLines ??
      input.lines.map((l) => ({
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
  return {
    receipt: buildPaymentReceipt(input),
    steps: input.existingOrder ? EXISTING_ORDER_COMPLETION_SEQUENCE : COMPLETION_SEQUENCE,
  };
}
