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

/**
 * The order sources a receipt can be routed for.
 *
 * Deliberately the same three strings `resolve_print_route` accepts for
 * `p_order_source` (minus `e_menu`, which the desktop does not take orders
 * for). Declared here rather than imported from the routing module so the
 * receipt model stays free of the printing stack.
 */
export type ReceiptOrderSource = "takeaway" | "dine_in" | "delivery";

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
  /**
   * What the receipt SAYS the order is - "Takeaway", "Dine-in", "Delivery".
   *
   * Presentation only. It is written in whatever case and wording each route
   * chose, so nothing may branch on it. See `orderSource` for the value that
   * decides where the paper goes.
   */
  orderType: string;
  /**
   * What the order actually IS, in the server's vocabulary.
   *
   * Separate from `orderType` because printing has to ask the routing resolver
   * "where does a `takeaway` receipt go", and a display string that one route
   * spells "Takeaway" and another spells "takeaway" is not an answer to that
   * question. Optional so a receipt built before this field existed still
   * renders; the print path refuses rather than guessing when it is absent.
   */
  orderSource?: ReceiptOrderSource;
  /** Human-readable time captured when the receipt was built. */
  at: string;
  paid: boolean;
  method: string | null;
  currency: CurrencyCode;
  lines: ReceiptLine[];
  subtotal: number;
  discount: number;
  /**
   * Delivery orders only: the manually-entered delivery fee, already folded into
   * `total` by the server's finance engine. Carried on its own so the receipt can
   * show it as a line between Subtotal and Total. Absent/0 prints nothing, and it
   * never appears on takeaway/dine-in. Passed IN from the server response, never
   * computed here.
   */
  deliveryFee?: number | null;
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
  /**
   * Delivery identity (Level 3C). Optional for the same reason as the dine-in
   * pair: takeaway and dine-in receipts are untouched. The address is what makes
   * a delivery receipt useful to a driver, so it is printed as stored.
   */
  customerName?: string | null;
  customerPhone?: string | null;
  deliveryAddress?: string | null;
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
