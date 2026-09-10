// Dual USD/LBP currency for the desktop app. Mirrors the web app's rules exactly:
// USD renders as "$X.XX"; LBP renders as "X LBP" (never a "$" sign).
//
// Conversion helpers exist here so the POS can validate input and show tendered /
// change BEFORE calling the server. They are never the financial authority: order
// and payment totals are always the values returned by the Supabase RPCs.

export type CurrencyCode = "USD" | "LBP";

/**
 * The currency the POS **cash / drawer** contract is denominated in: USD, always,
 * whatever the tenant's primary currency is.
 *
 * THIS IS THE SERVER'S CONTRACT, NOT A DISPLAY CHOICE. Every cash figure the POS
 * RPCs exchange is a USD-normalised aggregate:
 *
 *   `_pos_shift_cash.net_cash`   sum(pos_payments.amount) - refunds, and
 *                                `pos_payments.amount` is USD
 *   `pos_shift_expected`         `expected` = opening_cash_amount + net_cash
 *   `pos_cash_box_shift`         `expected_cash`, `total_usd` - same figure
 *   `pos_end_shift`              compares `actual_cash_counted` against that
 *                                expected and stores the difference
 *
 * `pos_end_shift` subtracts the counted cash from the expected cash directly, so
 * the number the cashier types IS compared against USD. Sending anything else -
 * or labelling the field with the tenant's primary currency and letting them
 * type LBP - records a difference that is wrong by the exchange rate.
 *
 * WHY THIS CONSTANT RATHER THAN A CONVERSION. Production showed a drawer reading
 * "114 LBP" for a shift that had taken 10,220,000 LBP: 113.56 USD rendered with
 * the LBP formatter, which rounds to whole units. The fix is to say what the
 * number IS, not to convert it - converting a historical aggregate at today's
 * rate would re-value settled money, which is the one thing a POS must never do.
 *
 * The SALES figures are different and are deliberately NOT covered by this:
 * gross, discounts and net are sums of `pos_orders.total_amount`, which is in the
 * order's own currency. An LBP tenant's end-of-shift report therefore reads sales
 * in LBP and cash in USD. That mix is the existing product contract; rendering it
 * accurately is this constant's whole purpose.
 */
export const CASH_CONTRACT_CURRENCY: CurrencyCode = "USD";

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

/**
 * Normalise a receipt currency code (Slice 6B-1).
 *
 * A receipt's currency is the order's OWN historical currency, which for a future
 * third-currency tenant is not one of the two `CurrencyCode` values. It arrives as a
 * runtime string, so it is validated here (3-letter ISO, upper-cased) and falls back
 * to USD for anything malformed, so a receipt never renders a blank or injected code.
 */
export function normalizeCurrencyCode(input: string | null | undefined): string {
  const c = String(input ?? "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(c) ? c : "USD";
}

/**
 * Format a receipt amount in the order's own currency at a given precision (Slice 6B-1).
 *
 * USD and LBP delegate to `formatMoney`, so existing receipts are BYTE-IDENTICAL
 * ("$10.50" / "900,000 LBP") and `digits` is not consulted for them. Any other
 * currency — a server-provided, gated operational currency — renders as
 * "<amount> <CODE>" at the SERVER-PROVIDED `decimal_digits` (JOD/KWD = 3): no local
 * currency catalog, no hard-coded 2-decimal assumption, and no USD/LBP `$`/`LBP`
 * leakage. Deliberately mirrors the native Rust `format_money` so the on-screen
 * preview and the printed paper agree.
 */
export function formatReceiptMoney(
  amount: number | null | undefined,
  currency: string,
  digits: number,
): string {
  const code = normalizeCurrencyCode(currency);
  if (code === "USD" || code === "LBP") return formatMoney(amount, code as CurrencyCode);
  const d = Number.isFinite(digits) && digits >= 0 ? Math.trunc(digits) : 2;
  return `${Number(amount ?? 0).toFixed(d)} ${code}`;
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
