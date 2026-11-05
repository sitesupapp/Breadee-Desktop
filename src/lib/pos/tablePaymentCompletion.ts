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
import { billCollected, billDue, unpaidBillView } from "@/lib/pos/tableBill";

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
    orderSource: "dine_in",
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

// --- Unpaid table bill (print before payment) --------------------------------
//
// A guest asks for the bill at the table before paying. This builds the SAME
// document the payment receipt does - from the server's bill, with table
// identity and every round of every order on the table - but marks it UNPAID:
// no tender, no change, no discount (a discount is chosen at payment, which has
// not happened), and `paid: false` so the receipt prints "Unpaid". It creates
// no payment and mutates nothing; it is presented through the MANUAL receipt
// layer exactly like a takeaway saved-order reprint.
//
// COMPLETENESS: the lines are `bill.orders.flatMap(...)`, i.e. every line of
// every order on the table, so a multi-order bill is represented in full - the
// same aggregation the payment receipt uses. A bill that spans currencies has
// no single subtotal/total (the fold leaves them null); the caller refuses to
// print such a bill rather than inventing a total, so this builder is only ever
// called with a single-currency bill.

export type TableBillReceiptInput = {
  /** The table's current bill, read from the server. */
  bill: TableBill;
  table: TableSummary;
  tenantName: string;
  branchName: string;
  operatorName: string;
  /** The bill's own selling currency (same source the payment / on-account receipts use). */
  primaryCurrency: CurrencyCode;
  shiftId: string | null;
  at: string;
};

export function buildTableBillReceipt(input: TableBillReceiptInput): ReceiptData {
  // 1.0.40 (BUG 01) — a bill part-paid by split prints what is still OPEN: only the unpaid quantities and
  // the amount due (T − P, the figure Pay will charge). A bill with nothing paid prints exactly as before.
  const paid = billCollected(input.bill);
  const bill = unpaidBillView(input.bill);
  const due = paid > 0 ? billDue(input.bill) : null;
  const subtotal = due ?? input.bill.subtotal ?? 0;
  const total = due ?? input.bill.total ?? subtotal;
  const orderNumbers = input.bill.orders.map((o) => o.order_number).filter(Boolean);

  return buildReceipt({
    businessName: input.tenantName,
    branchName: input.branchName,
    staffName: input.operatorName,
    orderType: "Dine-in",
    orderSource: "dine_in",
    tableName: input.table.name,
    seats: input.table.seats,
    orderNumber: orderNumbers.join(", ") || input.table.name,
    at: input.at,
    // The bill has not been paid; the receipt says so and carries no tender.
    paid: false,
    method: null,
    currency: input.primaryCurrency,
    lines: bill.orders.flatMap((order) =>
      order.lines.map((l) => ({
        name: l.name,
        qty: l.quantity,
        unitPrice: l.final_unit_price,
        lineTotal: l.line_total,
        modifiers: l.modifiers.map((m) => ({ name: m.name, price_delta: m.price_delta, quantity: m.quantity })),
        note: l.kitchen_note,
      })),
    ),
    subtotal,
    // No discount on an unpaid bill preview - a discount is applied at payment.
    discount: 0,
    total,
    tenderCurrency: null,
    exchangeRate: input.bill.orders[0]?.exchange_rate ?? null,
    shiftRef: input.shiftId ? input.shiftId.slice(0, 8) : null,
  });
}

// --- 1.0.40 guest-level split: the receipt of ONE paid split ------------------
//
// A split is a settlement of SOME items of the parent order by one guest. Its receipt lists only what that
// guest paid for (the allocated quantities, priced at the server's unit price), carries the server's
// amount as the total, and is numbered `<order_number>-<split_no>` (the server's display_no), which links
// it to the parent order. It never prints the parent bill. Through 1.0.39 an online split printed nothing.

export type SplitSettlementReceiptInput = {
  /** The server's answer to `pos_split_settle`. */
  result: { split_no: number; display_no: string; amount: number; method: string; currency_code: string; order_number: string };
  /** The parent order's number as the split screen showed it (fallback when the server omits it). */
  parentOrderNumber: string;
  /** What the guest paid for: the allocated quantities. */
  allocations: { order_item_id: string; quantity: number }[];
  /** The split screen's lines (server-priced) the allocations refer to. */
  lines: { order_item_id: string; name: string; final_unit_price: number; kitchen_note: string | null }[];
  tableName: string;
  seats: number | null;
  tenantName: string;
  branchName: string;
  operatorName: string;
  /** The parent order's selling currency. */
  primaryCurrency: CurrencyCode;
  rate: number | null;
  shiftId: string | null;
  at: string;
};

export function buildSplitSettlementReceipt(input: SplitSettlementReceiptInput): ReceiptData {
  const parent = input.result.order_number || input.parentOrderNumber;
  const number = input.result.display_no || `${parent}-${input.result.split_no}`;
  const lines = input.allocations
    .filter((a) => Number(a.quantity) > 0)
    .map((a) => {
      const l = input.lines.find((x) => x.order_item_id === a.order_item_id);
      const unit = l?.final_unit_price ?? 0;
      return {
        name: l?.name ?? "Item",
        qty: a.quantity,
        unitPrice: unit,
        lineTotal: Math.round(unit * a.quantity * 100) / 100,
        modifiers: [],
        note: l?.kitchen_note ?? null,
      };
    });
  return buildReceipt({
    businessName: input.tenantName,
    branchName: input.branchName,
    staffName: input.operatorName,
    orderType: "Dine-in",
    orderSource: "dine_in",
    tableName: input.tableName,
    seats: input.seats,
    orderNumber: number,
    at: input.at,
    paid: true,
    method: input.result.method,
    currency: input.primaryCurrency,
    lines,
    // The server priced the split; its amount is the receipt's figure.
    subtotal: input.result.amount,
    discount: 0,
    total: input.result.amount,
    tenderCurrency: null,
    exchangeRate: input.rate,
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

// --- Customer Receivables / On Account (dine-in) -----------------------------
//
// The sibling of `buildTablePaymentReceipt` for a table put on account. It is not
// an extension of it: a receivable receipt carries `paid: false`, the paid/balance
// split and no tendered/change pair, where the full-pay one carries `paid: true`
// and a cash tender. The IDENTITY still comes from the pre-payment bill, and every
// figure still comes from the server; the full-pay builder is untouched.
//
// Classic USD/LBP presentation: the receipt currency is the bill's own selling
// currency (`primaryCurrency`), formatted by the shared `formatMoney` in the
// preview - no separate historical-currency or decimal-digits input.

export type TableOnAccountReceiptInput = {
  /** The bill as it stood immediately before completion - the ONLY source of identity. */
  bill: TableBill;
  table: TableSummary;
  /** Null when the completion was recovered rather than directly confirmed. */
  result: {
    bill_total: number;
    paid_usd: number;
    outstanding_primary: number;
    subtotal: number;
    discount: number;
  } | null;
  /** The discount amount the client asked for. Only used on the recovered path. */
  requestedDiscount: number;
  /** What the customer paid now, as the client asked. Only used on the recovered path. */
  requestedPaidNow: number;
  method: PaymentMethod;
  tenantName: string;
  branchName: string;
  operatorName: string;
  /** The bill's selling currency. */
  primaryCurrency: CurrencyCode;
  shiftId: string | null;
  at: string;
};

export function buildTableOnAccountReceipt(input: TableOnAccountReceiptInput): ReceiptData {
  // Server figures win outright; the fallback is the honest best account for a
  // recovered completion whose response was lost, from the pre-payment bill.
  const subtotal = input.result?.subtotal ?? input.bill.subtotal ?? 0;
  const discount = input.result ? input.result.discount : Math.max(0, input.requestedDiscount);
  const total = input.result?.bill_total ?? Math.max(0, subtotal - discount);
  // Paid now in the bill's OWN (operational) currency: bill total minus what is
  // still owed. `paid_usd` is the USD accounting figure and would print e.g. 2.22
  // on an LBP receipt - both operational figures are the server's, so derive from
  // them and never show the USD amount as if it were local money.
  const balance = input.result ? input.result.outstanding_primary : Math.max(0, total - Math.max(0, input.requestedPaidNow));
  const paidNow = input.result ? Math.max(0, total - balance) : Math.max(0, input.requestedPaidNow);

  const orderNumbers = input.bill.orders.map((o) => o.order_number).filter(Boolean);

  return buildReceipt({
    businessName: input.tenantName,
    branchName: input.branchName,
    staffName: input.operatorName,
    orderType: "Dine-in",
    orderSource: "dine_in",
    tableName: input.table.name,
    seats: input.table.seats,
    orderNumber: orderNumbers.join(", ") || input.table.name,
    at: input.at,
    paid: false,
    paymentStatus: paidNow > 0 ? "partial" : "unpaid",
    paidAmount: paidNow,
    balanceDue: balance,
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
    subtotal,
    discount,
    total,
    // A receivable takes no cash tender at the drawer, so no tender/change block.
    tenderCurrency: null,
    exchangeRate: input.bill.orders[0]?.exchange_rate ?? null,
    shiftRef: input.shiftId ? input.shiftId.slice(0, 8) : null,
  });
}
