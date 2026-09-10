// Dual USD/LBP currency for the desktop app. Mirrors the web app's rules exactly:
// USD renders as "$X.XX"; LBP renders as "X LBP" (never a "$" sign).
//
// Conversion helpers exist here so the POS can validate input and show tendered /
// change BEFORE calling the server. They are never the financial authority: order
// and payment totals are always the values returned by the Supabase RPCs.

// LEGACY DUAL-TENDER / CASH type. The two currencies the POS can settle a bill in
// and the unit the cash drawer is denominated in. NOT the general operational
// currency — a third-currency (e.g. AED/JOD) tenant is `OperationalCurrencyCode`,
// never one of these. Keep this narrow: it exists so the USD/LBP dual-tender and
// the USD cash-drawer contract stay exactly what they were. See `OperationalCurrencyCode`.
export type CurrencyCode = "USD" | "LBP";

// The GENERAL operational currency a tenant runs in: the actual server-provided
// `primary_currency` string (USD, LBP, AED, JOD, …). It is deliberately a plain,
// server-sourced string and NOT widened from `CurrencyCode`: widening the bilateral
// tender type to make a third currency compile is the exact mistake this split avoids.
// A third-currency tenant operates in ONE such currency; USD/LBP tenants keep their
// bilateral behaviour. Digits for a code come from the server (`operationalDigitsFor`),
// never a hard-coded local catalog.
export type OperationalCurrencyCode = string;

// Server-provided minor-unit precision for operational currencies, keyed by ISO code.
// Populated ONCE from `get_tenant_currency_and_regional_settings().selectable_currencies`
// at session load (`setOperationalCurrencyDigits`) — it is cached server metadata, not a
// local catalog, and it is consulted ONLY for codes outside USD/LBP (whose precision is
// intrinsic). Empty until a session loads; a third-currency render cannot occur before then.
let operationalDigitsRegistry: Record<string, number> = {};

/**
 * Record the server's per-currency decimal precision for the current session.
 * `entries` is the server's `selectable_currencies` list. Invalid rows are ignored;
 * USD/LBP are never needed here (their precision is intrinsic) but are harmless if present.
 */
export function setOperationalCurrencyDigits(
  entries: ReadonlyArray<{ code?: unknown; decimal_digits?: unknown }> | null | undefined,
): void {
  const next: Record<string, number> = {};
  for (const e of entries ?? []) {
    const code = String(e?.code ?? "").trim().toUpperCase();
    const d = e?.decimal_digits;
    if (/^[A-Z]{3}$/.test(code) && typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 4) {
      next[code] = d;
    }
  }
  operationalDigitsRegistry = next;
}

/**
 * The decimal precision for an operational currency code. USD/LBP are intrinsic (2/0);
 * every other code is resolved from the server-loaded registry, falling back to 2 when
 * the registry has no entry yet (fail-safe — a wrong precision never becomes a "$" leak,
 * and the operational currency's identity is preserved). Never guesses by locale/country.
 */
export function operationalDigitsFor(code: OperationalCurrencyCode | null | undefined): number {
  const c = String(code ?? "").trim().toUpperCase();
  if (c === "USD") return 2;
  if (c === "LBP") return 0;
  const d = operationalDigitsRegistry[c];
  return typeof d === "number" ? d : 2;
}

/** True for the two legacy dual-tender currencies. Gates USD/LBP-only UI (tender/price choosers). */
export function isLegacyDualCurrency(code: OperationalCurrencyCode | null | undefined): code is CurrencyCode {
  return code === "USD" || code === "LBP";
}

/**
 * The USD/LBP client fallback for the Slice-6B receipt resolver. A receipt's real currency
 * comes from the server (`finance_order_financials`); this fallback is used only when that
 * metadata is unavailable, and the resolver's fallback contract is USD/LBP. A third
 * operational currency has NO client-side fallback — its receipt relies on server metadata —
 * so it maps to USD here (the documented Phase-1 compatibility path), never silently
 * printing a third currency at a guessed precision.
 */
export function receiptFallbackCurrency(code: OperationalCurrencyCode | null | undefined): CurrencyCode {
  return isLegacyDualCurrency(code) ? code : "USD";
}

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

/**
 * Runtime shape validator for an operational currency code: a 3-letter upper-case
 * string (ISO-4217 shape). This is the ONLY local "catalog" allowed — a shape check,
 * not a hard-coded list of currencies or their digits. Use it to narrow an untrusted
 * server value (e.g. an order's stored currency) so a third currency (AED/JOD) is
 * accepted rather than dropped, without pretending every 3-letter string is real money.
 */
export function isOperationalCurrencyCode(v: unknown): v is OperationalCurrencyCode {
  return typeof v === "string" && /^[A-Z]{3}$/.test(v);
}

/**
 * True only for a currency the app actually KNOWS: USD/LBP, or a code the server catalog
 * declared this session (`setOperationalCurrencyDigits`). Use it to parse a currency out of
 * stored data — it accepts a real third currency (AED/JOD) once the catalog is loaded, but
 * drops a well-formed-but-unknown code (e.g. "XXX") rather than displaying money in a
 * currency whose precision the server never vouched for.
 */
export function isKnownOperationalCurrency(v: unknown): v is OperationalCurrencyCode {
  return isOperationalCurrencyCode(v) && (v === "USD" || v === "LBP" || v in operationalDigitsRegistry);
}

export function hasValidRate(rate: number | null | undefined): rate is number {
  return typeof rate === "number" && Number.isFinite(rate) && rate > 0;
}

export function roundTo(value: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round((Number(value) || 0) * f) / f;
}

export const roundUsd = (value: number | null | undefined): number => roundTo(Number(value) || 0, 2);

/**
 * The other side of the USD/LBP pair — what a USD/LBP amount is ALSO worth. Only
 * meaningful for the two legacy dual-tender currencies; a third operational currency has
 * no second side, so callers must gate on `isLegacyDualCurrency` before showing an
 * equivalent. Kept typed `CurrencyCode` in/out precisely because it is a USD/LBP concept.
 */
export function getEquivalentCurrency(primary: CurrencyCode): CurrencyCode {
  return primary === "USD" ? "LBP" : "USD";
}

// Primary display formatter, generalized to the tenant's operational currency.
//
// USD is "$" + 2dp and LBP is a whole number + " LBP" — BYTE-IDENTICAL to before, so
// every USD/LBP surface and its tests are unchanged. Any OTHER operational currency
// (AED/JOD/…) renders as "<amount> <CODE>" at its SERVER-PROVIDED precision
// (`operationalDigitsFor`): no "$" leakage, no hard-coded 2-decimal assumption, and the
// currency's own identity preserved. This mirrors the receipt formatter’s non-USD/LBP
// branch so screen and paper agree.
export function formatMoney(amount: number | null | undefined, code: OperationalCurrencyCode = "USD"): string {
  const n = Number(amount ?? 0);
  if (code === "LBP") return `${Math.round(n).toLocaleString()} LBP`;
  if (code === "USD") return `$${n.toFixed(2)}`;
  return `${n.toFixed(operationalDigitsFor(code))} ${String(code).trim().toUpperCase()}`;
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
  from: OperationalCurrencyCode,
  to: OperationalCurrencyCode,
  rate: number | null | undefined,
): number {
  const n = Number(amount) || 0;
  // Same currency passes straight through — the ONLY path a third-currency tenant
  // ever takes here, since its tender is always its single operational currency.
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

/**
 * Round a tendered/change amount to the currency's smallest meaningful unit.
 * LBP is whole-number and USD is 2dp — unchanged. Any other operational currency
 * rounds to its SERVER-PROVIDED precision (JOD/KWD = 3dp), so change for a
 * third-currency cash sale lands on a real minor unit rather than a coerced 2dp.
 */
export function roundForCurrency(amount: number, code: OperationalCurrencyCode): number {
  if (code === "LBP") return Math.round(Number(amount) || 0);
  if (code === "USD") return roundUsd(amount);
  return roundTo(Number(amount) || 0, operationalDigitsFor(code));
}
