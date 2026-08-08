// What happens after `pos_pay_table` returns, as pure data.
//
// The takeaway equivalent is `paymentCompletion.ts`; this is its dine-in sibling
// rather than an extension of it, because the two differ in the things that
// matter: a table receipt is built from the SERVER's pre-payment bill (not from
// a local cart buffer), it carries table identity, and its completion has to
// prove the table was actually freed before anything is presented as settled.
//
// THE ORDER MATTERS and is asserted by tests:
//   1. refresh the table map        - the server's view of the table
//   2. verify the bill is cleared   - proof, before anything claims success
//   3. refresh the cash box         - read from the server, never incremented
//   4. present the receipt          - data and visibility together
//   5. close the payment dialog
//   6. clear the payment state      - the dialog's method/tender/discount
//
// The map is refreshed FIRST so a receipt is never shown for a table the server
// still reports as carrying an unpaid bill; the receipt is presented BEFORE the
// dialog closes so the presentation can never race the teardown - the same rule
// the takeaway sequence learned on staging.
//
// `pos_close_table` is deliberately absent. `pos_pay_table` completes the orders
// and frees the table itself; calling Close afterwards would be a second
// mutation attempting to reach a state the server is already in.

import { buildReceipt, type ReceiptData } from "@/lib/receipt";
import { computeChange } from "@/lib/pos/payments";
import { tenderTotalFor } from "@/lib/pos/paymentCompletion";
import type { CurrencyCode } from "@/lib/currency";
import type { PaymentMethod } from "@/lib/pos/payments";
import type { TablePaymentResult } from "@/lib/pos/tablePayment";
import type { TableBill, TableSummary } from "@/types/tables";

export type TableCompletionStep =
  | "refresh-table-map"
  | "verify-bill-cleared"
  | "refresh-cash-box"
  | "present-receipt"
  | "close-payment-dialog"
  | "clear-payment-state";

export const TABLE_COMPLETION_SEQUENCE: TableCompletionStep[] = [
  "refresh-table-map",
  "verify-bill-cleared",
  "refresh-cash-box",
  "present-receipt",
  "close-payment-dialog",
  "clear-payment-state",
];

/**
 * Whether the server now agrees the table is settled.
 *
 * Used as step 2. A table that still reports an open unpaid bill after a
 * "successful" payment is not a cosmetic problem - it is the one shape that
 * would let a second payment be taken - so the caller surfaces it rather than
 * completing quietly.
 */
export function billIsCleared(bill: TableBill | null, table: TableSummary | null): boolean {
  const noBill = !bill || bill.orders.length === 0;
  const tableFree = !table || table.orders === 0;
  return noBill && tableFree;
}

/**
 * The financial figures for the receipt.
 *
 * When the server answered, its numbers win outright - that is the whole reason
 * `pos_pay_table` returns them. The fallback exists only for a RECOVERED
 * payment, where the response was lost: there the pre-payment bill (itself read
 * from the server) plus the discount the client asked for is the best honest
 * account available, and `provisional` says so rather than pretending.
 */
export function paymentFigures(input: {
  result: TablePaymentResult | null;
  billSubtotal: number;
  requestedDiscount: number;
}): { subtotal: number; discount: number; amount: number; provisional: boolean } {
  if (input.result) {
    return {
      subtotal: input.result.subtotal,
      discount: input.result.discount,
      amount: input.result.amount,
      provisional: false,
    };
  }
  const discount = Math.max(0, input.requestedDiscount);
  return {
    subtotal: input.billSubtotal,
    discount,
    amount: Math.max(0, input.billSubtotal - discount),
    provisional: true,
  };
}

export type TableReceiptInput = {
  /** The bill as it stood immediately before payment - the ONLY source of identity. */
  bill: TableBill;
  table: TableSummary;
  /** Null when the payment was recovered rather than directly confirmed. */
  result: TablePaymentResult | null;
  /** The discount amount the client asked for. Only used on the recovered path. */
  requestedDiscount: number;
  method: PaymentMethod;
  tenantName: string;
  branchName: string;
  operatorName: string;
  /** The bill's selling currency. */
  primaryCurrency: CurrencyCode;
  /** The currency actually tendered at the drawer. */
  tenderCurrency: CurrencyCode;
  rate: number | null;
  tenderedInput: number | null;
  shiftId: string | null;
  at: string;
};

/**
 * Build the Dine-In receipt.
 *
 * `pos_pay_table` returns NO order_number - it settles every open order on the
 * table at once - so the number comes from the pre-payment bill. That is why the
 * bill snapshot is captured before submitting rather than re-read afterwards:
 * once the payment lands there is no open bill left to read it from.
 */
export function buildTablePaymentReceipt(input: TableReceiptInput): ReceiptData {
  const figures = paymentFigures({
    result: input.result,
    billSubtotal: input.bill.subtotal ?? 0,
    requestedDiscount: input.requestedDiscount,
  });

  const tenderTotal = tenderTotalFor(figures.amount, input.primaryCurrency, input.tenderCurrency, input.rate);

  // A tender below the bill is refused before submission, so anything short here
  // is treated as "paid exactly" rather than printing negative change.
  const tendered =
    tenderTotal === null
      ? null
      : input.tenderedInput != null && input.tenderedInput >= tenderTotal
        ? input.tenderedInput
        : tenderTotal;
  const change =
    tenderTotal === null || tendered === null
      ? null
      : computeChange(tenderTotal, tendered, input.tenderCurrency).change;

  const orderNumbers = input.bill.orders.map((o) => o.order_number).filter(Boolean);

  return buildReceipt({
    businessName: input.tenantName,
    branchName: input.branchName,
    staffName: input.operatorName,
    orderType: "Dine-in",
    tableName: input.table.name,
    seats: input.table.seats,
    // Normally one order per table (m218); if a bill genuinely spans more, every
    // number is printed rather than silently dropping the others.
    orderNumber: orderNumbers.join(", ") || input.table.name,
    at: input.at,
    paid: true,
    method: input.method,
    currency: input.primaryCurrency,
    lines: input.bill.orders.flatMap((order) =>
      order.lines.map((l) => ({
        name: l.name,
        qty: l.quantity,
        unitPrice: l.final_unit_price,
        lineTotal: l.line_total,
        modifiers: l.modifiers.map((m) => ({ name: m.name, price_delta: m.price_delta, quantity: m.quantity })),
        note: l.kitchen_note,
      })),
    ),
    subtotal: figures.subtotal,
    discount: figures.discount,
    total: figures.amount,
    tenderCurrency: input.tenderCurrency,
    tenderTotal,
    tendered,
    change,
    exchangeRate: input.result?.exchange_rate ?? input.bill.orders[0]?.exchange_rate ?? null,
    shiftRef: input.shiftId ? input.shiftId.slice(0, 8) : null,
  });
}

/** The receipt plus the ordered steps the caller must apply. */
export function completeTablePayment(input: TableReceiptInput): {
  receipt: ReceiptData;
  steps: TableCompletionStep[];
} {
  return { receipt: buildTablePaymentReceipt(input), steps: TABLE_COMPLETION_SEQUENCE };
}
