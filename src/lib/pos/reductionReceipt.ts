// The item reduction/cancellation RECORD receipt (Part 2). Pure, no side effects.
//
// WHAT IT IS. A short slip the RECEIPT printer produces when a cashier reduces or
// cancels an already-submitted Dine-In item, if this terminal has the setting on.
// It is a record - business, branch, order number, table, who did it and when,
// and the one removed line with the audited reason - NOT a sale receipt: it
// carries no subtotal, discount, total or payment line, so it can never be read
// as money taken.
//
// WHY IT REUSES ReceiptData. The slip goes to the same RECEIPT destination and
// the same thermal renderer as a customer receipt, so it is expressed as a
// ReceiptData with a fixed, restrictive `sections` render that shows only the
// header and the single removed line. No new document type, no new native command,
// no schema. Every value is passed IN from the committed edit and the line the
// cashier acted on; nothing here is recomputed from a live read.

import type { CurrencyCode } from "@/lib/currency";
import { buildReceipt, type ReceiptData } from "@/lib/receipt";
import { type ReceiptRenderOptions } from "@/lib/pos/receiptRender";

/**
 * The slip shows the header and the removed line only. Deliberately omits
 * `discount`, `total` and `payment_method` so no money summary is drawn - a
 * reduction record is not a sale. Fixed here (not read from the tenant's receipt
 * design) because this is a fixed-format operational record, not a designed
 * customer receipt.
 */
export const REDUCTION_RECEIPT_SECTIONS: string[] = [
  "business_name",
  "branch_name",
  "order_type",
  "order_number",
  "table_info",
  "datetime",
  "staff",
  "items",
];

export const REDUCTION_RECEIPT_RENDER: ReceiptRenderOptions = {
  sections: REDUCTION_RECEIPT_SECTIONS,
  address: null,
  phone: null,
  welcome: null,
  footer: null,
  qr: null,
};

export type ReductionReceiptInput = {
  businessName: string | null | undefined;
  branchName: string;
  staffName: string | null;
  orderNumber: string;
  tableName: string | null;
  /** The order's own selling currency - never a display currency. */
  currency: CurrencyCode;
  /** Human-readable time captured when the slip was built. */
  at: string;
  /** The line the cashier acted on. */
  itemName: string;
  previousQuantity: number;
  newQuantity: number;
  /** final_unit_price from the line - the value of one unit removed. */
  unitPrice: number;
  /** The audited reason the server required and recorded. */
  reason: string | null;
};

/**
 * Build the reduction/cancellation slip as a ReceiptData plus the fixed
 * restrictive render. `newQuantity === 0` is a cancellation; anything above zero
 * is a partial reduction. The single line shows the quantity REMOVED and its
 * value, with the reason and the before/after quantities as its note.
 */
export function buildReductionReceipt(input: ReductionReceiptInput): {
  receipt: ReceiptData;
  render: ReceiptRenderOptions;
} {
  const removedQty = Math.max(input.previousQuantity - input.newQuantity, 0);
  const cancelled = input.newQuantity <= 0;
  const reason = input.reason?.trim() ? input.reason.trim() : null;
  const note =
    `From ${input.previousQuantity} to ${input.newQuantity}` + (reason ? ` · Reason: ${reason}` : "");

  const receipt = buildReceipt({
    businessName: input.businessName,
    branchName: input.branchName,
    // Presentation-only label; `orderSource` below is what routes the slip.
    orderType: cancelled ? "Item cancelled" : "Item reduced",
    orderSource: "dine_in",
    staffName: input.staffName,
    orderNumber: input.orderNumber,
    at: input.at,
    // Not a sale: no payment is drawn (payment_method is not in the sections),
    // but keep the values unambiguous regardless.
    paid: false,
    method: null,
    currency: input.currency,
    lines: [
      {
        name: input.itemName,
        qty: removedQty,
        unitPrice: input.unitPrice,
        lineTotal: removedQty * input.unitPrice,
        note,
      },
    ],
    subtotal: removedQty * input.unitPrice,
    discount: 0,
    total: removedQty * input.unitPrice,
    tableName: input.tableName,
  });

  return { receipt, render: REDUCTION_RECEIPT_RENDER };
}
