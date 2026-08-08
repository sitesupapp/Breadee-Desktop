// Receipt DATA model + builder. Pure and framework-agnostic.
//
// This drives the on-screen preview today. The shape is deliberately close to the
// web app's `ReceiptData` (items with modifiers and notes, subtotal/discount/total,
// tendered/change, staff, branch, payment status) so the web's template renderer
// can be ported onto it during the printing phase without changing callers.
//
// No printing here, no side effects. Every monetary figure is passed IN from the
// server response - nothing on a receipt is calculated by this module.

import type { CurrencyCode } from "@/lib/currency";

export type ReceiptModifier = {
  name: string;
  price_delta: number;
  quantity: number;
};

export type ReceiptLine = {
  name: string;
  qty: number;
  unitPrice: number;
  lineTotal: number;
  modifiers?: ReceiptModifier[];
  note?: string | null;
};

export type ReceiptData = {
  businessName: string;
  branchName: string;
  staffName: string | null;
  orderNumber: string;
  orderType: string;
  /** Human-readable time captured when the receipt was built. */
  at: string;
  paid: boolean;
  method: string | null;
  currency: CurrencyCode;
  lines: ReceiptLine[];
  subtotal: number;
  discount: number;
  total: number;
  /** Cash handling, in the TENDER currency. Null when not a cash tender. */
  tenderCurrency?: CurrencyCode | null;
  tenderTotal?: number | null;
  tendered?: number | null;
  change?: number | null;
  exchangeRate?: number | null;
  /** Operational reference so a paper receipt can be tied back to a shift. */
  shiftRef?: string | null;
  /**
   * Dine-In identity. Absent on a takeaway receipt, which is why both are
   * optional rather than nullable-required: the takeaway path is untouched.
   * `tableName` is the tenant's own stored label, printed verbatim (m256).
   */
  tableName?: string | null;
  seats?: number | null;
};

export type BuildReceiptInput = Omit<ReceiptData, "businessName" | "orderType"> & {
  businessName: string | null | undefined;
  orderType?: string;
};

export function buildReceipt(input: BuildReceiptInput): ReceiptData {
  return {
    ...input,
    businessName: input.businessName?.trim() || "Breadee",
    orderType: input.orderType ?? "Takeaway",
  };
}

/** A deterministic sample used by Settings -> Receipt design (no real data). */
export function sampleReceipt(businessName: string | null | undefined, currency: CurrencyCode): ReceiptData {
  const lines: ReceiptLine[] = [
    {
      name: "Chicken Sandwich",
      qty: 2,
      unitPrice: 5.0,
      lineTotal: 10.0,
      modifiers: [{ name: "Extra cheese", price_delta: 0.5, quantity: 1 }],
      note: "no pickles",
    },
    { name: "Fries", qty: 1, unitPrice: 2.5, lineTotal: 2.5 },
    { name: "Soft Drink", qty: 2, unitPrice: 1.25, lineTotal: 2.5 },
  ];
  const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
  return buildReceipt({
    businessName,
    branchName: "Main Branch",
    staffName: "Sample Cashier",
    orderNumber: "SAMPLE-0001",
    at: "Sample receipt - layout preview",
    paid: true,
    method: "cash",
    currency,
    lines,
    subtotal,
    discount: 0,
    total: subtotal,
    tenderCurrency: currency,
    tenderTotal: subtotal,
    tendered: subtotal,
    change: 0,
    shiftRef: null,
  });
}
