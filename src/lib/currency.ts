// Dual USD/LBP currency for the desktop app. Mirrors the web app's rules exactly:
// USD renders as "$X.XX"; LBP renders as "X LBP" (never a "$" sign).
//
// Conversion helpers exist here so the POS can validate input and show tendered /
// change BEFORE calling the server. They are never the financial authority: order
// and payment totals are always the values returned by the Supabase RPCs.

export type CurrencyCode = "USD" | "LBP";

/** Transaction-boundary precision for a normalized USD amount. */
export const USD_STORE_DP = 4;

export function isCurrencyCode(v: unknown): v is CurrencyCode {
  return v === "USD" || v === "LBP";
}

export function hasValidRate(rate: number | null | undefined): rate is number {
  return typeof rate === "number" && Number.isFinite(rate) && rate > 0;
}

export function roundTo(value: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round((Number(value) || 0) * f) / f;
}

export const roundUsd = (value: number | null | undefined): number => roundTo(Number(value) || 0, 2);

/** The other side of the pair - what an amount is also worth. */
export function getEquivalentCurrency(primary: CurrencyCode): CurrencyCode {
  return primary === "USD" ? "LBP" : "USD";
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

// LBP -> USD using the tenant's exchange rate. Returns 0 when no valid rate is set.
export function convertLbpToUsd(lbp: number | null | undefined, rate: number | null | undefined): number {
  if (!hasValidRate(rate)) return 0;
  return roundUsd(Number(lbp ?? 0) / rate);
}

/**
 * Convert between the pair. Same-currency passes through untouched; a missing or
 * invalid rate throws so a caller can surface a refusal instead of silently
 * producing a wrong number.
 */
export function convertCurrency(
  amount: number,
  from: CurrencyCode,
  to: CurrencyCode,
  rate: number | null | undefined,
): number {
  const n = Number(amount) || 0;
  if (from === to) return n;
  if (!hasValidRate(rate)) {
    throw new Error("Set the USD to LBP exchange rate on the dashboard before using this currency.");
  }
  return from === "USD" ? convertUsdToLbp(n, rate) : convertLbpToUsd(n, rate);
}

// Optional secondary line for a USD amount, only when a rate is available.
export function equivalentLbp(usd: number | null | undefined, rate: number | null | undefined): string | null {
  if (!hasValidRate(rate)) return null;
  return formatMoney(convertUsdToLbp(usd, rate), "LBP");
}

/** Parse a typed money string, tolerating grouping separators and spaces. */
export function parseAmount(input: string | null | undefined): number {
  const raw = String(input ?? "").replace(/[, _]/g, "").trim();
  if (raw === "") return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/** Smallest meaningful unit for a currency - used to round tendered/change. */
export function roundForCurrency(amount: number, code: CurrencyCode): number {
  return code === "LBP" ? Math.round(Number(amount) || 0) : roundUsd(amount);
}
