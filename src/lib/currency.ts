// Dual USD/LBP currency DISPLAY for the desktop app. Mirrors the web app's display
// rules exactly: USD renders as "$X.XX"; LBP renders as "X LBP" (never a "$" sign).
// Display-only — this module performs NO POS pricing math (order/payment totals stay
// server-authoritative via the Supabase RPCs). Safe to use anywhere.

export type CurrencyCode = "USD" | "LBP";

export function isCurrencyCode(v: unknown): v is CurrencyCode {
  return v === "USD" || v === "LBP";
}

export function hasValidRate(rate: number | null | undefined): rate is number {
  return typeof rate === "number" && Number.isFinite(rate) && rate > 0;
}

// Primary formatter. LBP is whole-number with a trailing " LBP"; USD is "$" + 2dp.
export function formatMoney(amount: number | null | undefined, code: CurrencyCode = "USD"): string {
  const n = Number(amount ?? 0);
  if (code === "LBP") return `${Math.round(n).toLocaleString()} LBP`;
  return `$${n.toFixed(2)}`;
}

// USD -> LBP using the tenant's exchange rate. Returns 0 when no valid rate is set.
export function convertUsdToLbp(usd: number | null | undefined, rate: number | null | undefined): number {
  if (!hasValidRate(rate)) return 0;
  return Math.round(Number(usd ?? 0) * rate);
}

// Optional "≈ X LBP" secondary line for a USD amount, only when a rate is available.
export function equivalentLbp(usd: number | null | undefined, rate: number | null | undefined): string | null {
  if (!hasValidRate(rate)) return null;
  return formatMoney(convertUsdToLbp(usd, rate), "LBP");
}
