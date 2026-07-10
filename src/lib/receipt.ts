// Cashier receipt DATA model + builder (foundation). Pure and framework-agnostic.
// Drives the on-screen receipt preview now; the SAME shape will feed the native
// printer path in a later phase. No printing here, no side effects.

import type { CurrencyCode } from "@/lib/currency";

export type ReceiptLine = {
  name: string;
  qty: number;
  unitPrice: number;
  lineTotal: number;
};

export type ReceiptData = {
  businessName: string;
  branchLabel: string;
  orderNumber: string;
  orderType: string; // "Takeaway" for this increment
  paid: boolean;
  method: string | null; // "cash" once paid
  at: string; // human-readable timestamp captured at print time
  currency: CurrencyCode;
  lines: ReceiptLine[];
  subtotal: number;
  discount: number;
  total: number;
};

export type BuildReceiptInput = {
  businessName: string | null | undefined;
  branchLabel: string;
  orderNumber: string;
  paid: boolean;
  method?: string | null;
  currency: CurrencyCode;
  lines: ReceiptLine[];
  subtotal: number;
  discount?: number;
  total: number;
  at: string;
};

export function buildReceipt(input: BuildReceiptInput): ReceiptData {
  const discount = input.discount ?? 0;
  return {
    businessName: input.businessName?.trim() || "Breadee",
    branchLabel: input.branchLabel,
    orderNumber: input.orderNumber,
    orderType: "Takeaway",
    paid: input.paid,
    method: input.method ?? null,
    at: input.at,
    currency: input.currency,
    lines: input.lines,
    subtotal: input.subtotal,
    discount,
    total: input.total,
  };
}

// A deterministic sample used by the Settings → Receipt design preview (no real data).
export function sampleReceipt(businessName: string | null | undefined, currency: CurrencyCode): ReceiptData {
  const lines: ReceiptLine[] = [
    { name: "Chicken Sandwich", qty: 2, unitPrice: 4.5, lineTotal: 9.0 },
    { name: "Fries", qty: 1, unitPrice: 2.5, lineTotal: 2.5 },
    { name: "Soft Drink", qty: 2, unitPrice: 1.25, lineTotal: 2.5 },
  ];
  const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
  return buildReceipt({
    businessName,
    branchLabel: "Main Branch",
    orderNumber: "SAMPLE-0001",
    paid: true,
    method: "cash",
    currency,
    lines,
    subtotal,
    total: subtotal,
    at: "Sample receipt · layout preview",
  });
}
