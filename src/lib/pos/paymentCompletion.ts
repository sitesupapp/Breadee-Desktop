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
  /** The tenant's primary (selling) currency — kept for the tender math below. */
  primaryCurrency: CurrencyCode;
  /**
   * The order's HISTORICAL currency and display precision, from the server contract
   * `finance_order_financials` (Slice 6B-2). Authoritative for what the receipt shows —
   * never today's tenant currency, `finance_base_currency`, or a local catalog. For a
   * third-currency order the caller must obtain a valid `decimalDigits` from the server
   * (see `fetchReceiptCurrency`), never the 2-decimal default.
   */
  receiptCurrency: string;
  decimalDigits: number;
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
    currency: input.receiptCurrency,
    decimalDigits: input.decimalDigits,
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

// --- Customer Receivables / On Account ---------------------------------------
//
// A receivable receipt is NOT a paid receipt. The full-pay builder above
// hardcodes `paid: true` and a tendered/change pair; an on-account sale has an
// outstanding balance, so this sibling carries `paid: false`, the SERVER's
// payment status, and the paid/balance split instead. Every figure is the
// server's - nothing here is recomputed - and the full-pay path is untouched.

export type OnAccountCompletionInput = {
  /** The server's answer, whose figures win outright. */
  result: {
    payment_status: "unpaid" | "partial";
    paid_usd: number;
    outstanding_usd: number;
    order_number: string;
    subtotal: number;
    discount: number;
  };
  lines: CartLine[];
  receiptLines?: ReceiptLine[] | null;
  existingOrder?: boolean;
  fallbackOrderNumber: string;
  method: string | null;
  tenantName: string;
  branchName: string;
  operatorName: string;
  /** The order's primary (selling) currency - the currency every figure is in. */
  primaryCurrency: CurrencyCode;
  /** The order's HISTORICAL currency + precision from finance_order_financials (6B-2). */
  receiptCurrency: string;
  decimalDigits: number;
  shiftId: string | null;
  at: string;
};

export function buildOnAccountReceipt(input: OnAccountCompletionInput): ReceiptData {
  const { result } = input;
  return buildReceipt({
    businessName: input.tenantName,
    branchName: input.branchName,
    staffName: input.operatorName,
    orderSource: "takeaway",
    orderNumber: result.order_number || input.fallbackOrderNumber,
    at: input.at,
    // Not paid - there is a balance. `paymentStatus` says how much.
    paid: false,
    paymentStatus: result.payment_status,
    paidAmount: result.paid_usd,
    balanceDue: result.outstanding_usd,
    method: input.method,
    currency: input.receiptCurrency,
    decimalDigits: input.decimalDigits,
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
    subtotal: result.subtotal,
    discount: result.discount,
    // The bill total owed, before what was paid now.
    total: result.subtotal - result.discount,
    // A receivable takes no cash tender at the drawer, so no tender/change block.
    tenderCurrency: null,
    shiftRef: input.shiftId ? input.shiftId.slice(0, 8) : null,
  });
}

/** The receivable receipt plus the ordered steps the caller must apply. */
export function completeOnAccountReceipt(input: OnAccountCompletionInput): PaymentCompletion {
  return {
    receipt: buildOnAccountReceipt(input),
    steps: input.existingOrder ? EXISTING_ORDER_COMPLETION_SEQUENCE : COMPLETION_SEQUENCE,
  };
}
