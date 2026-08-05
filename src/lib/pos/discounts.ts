// Shared POS discount math - ported from the web app's `src/lib/discount.ts`.
//
// The backend RPC (pos_pay_order) re-validates these same rules; this is UX only,
// never the security boundary. Keeping the arithmetic identical means the amount
// the cashier is shown is the amount the server will charge.

import { convertCurrency, type CurrencyCode } from "@/lib/currency";

export type DiscountType = "none" | "percent" | "amount";
export type DiscountResult = { amount: number; finalTotal: number; valid: boolean; error: string | null };

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export function computeDiscount(subtotal: number, type: DiscountType, valueStr: string): DiscountResult {
  const sub = round2(Number(subtotal) || 0);
  if (type === "none") return { amount: 0, finalTotal: sub, valid: true, error: null };

  const raw = (valueStr ?? "").trim();
  const v = Number(raw);
  if (raw === "" || Number.isNaN(v)) return { amount: 0, finalTotal: sub, valid: false, error: "Enter a discount value." };
  if (v < 0) return { amount: 0, finalTotal: sub, valid: false, error: "Discount cannot be negative." };

  if (type === "percent") {
    if (v > 100) return { amount: 0, finalTotal: sub, valid: false, error: "Percentage cannot exceed 100%." };
    const amount = round2((sub * v) / 100);
    return { amount, finalTotal: round2(Math.max(sub - amount, 0)), valid: true, error: null };
  }
  // fixed amount
  if (v > sub) return { amount: 0, finalTotal: sub, valid: false, error: "Discount cannot exceed the subtotal." };
  const amount = round2(v);
  return { amount, finalTotal: round2(Math.max(sub - amount, 0)), valid: true, error: null };
}

/**
 * Build the discount portion of the pay RPC payload. Returns {} when there is no
 * (permitted, valid) discount, so the no-discount payment path is unchanged.
 */
export function discountPayload(
  canDiscount: boolean,
  subtotal: number,
  type: DiscountType,
  valueStr: string,
): Record<string, unknown> {
  if (!canDiscount || type === "none") return {};
  const r = computeDiscount(subtotal, type, valueStr);
  if (!r.valid || r.amount <= 0) return {};
  return { discount_type: type, discount_value: Number(valueStr) };
}

/**
 * Convert a FIXED-amount discount typed in the selected PAYMENT currency into the
 * order's PRIMARY selling currency (the currency the subtotal and pos_pay_order
 * operate in). Percentage / none are currency-independent, and a discount already
 * entered in the primary currency passes through unchanged.
 */
export function fixedDiscountToPrimary(
  type: DiscountType,
  valueStr: string,
  payCurrency: CurrencyCode,
  primaryCurrency: CurrencyCode,
  rate: number | null | undefined,
): string {
  if (type !== "amount" || payCurrency === primaryCurrency) return valueStr;
  const raw = String(valueStr ?? "").replace(/[, _]/g, "").trim();
  if (raw === "") return valueStr;
  const n = Number(raw);
  if (!Number.isFinite(n)) return valueStr;
  try {
    return String(convertCurrency(n, payCurrency, primaryCurrency, rate));
  } catch {
    return valueStr;
  }
}
