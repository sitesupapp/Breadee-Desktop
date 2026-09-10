// The tenant's OPERATIONAL currency + precision, resolved from server metadata or the
// offline cache. Pure (no supabase, no browser globals) so it is unit-testable in isolation
// — the session store composes it. Never used for POS math; the server owns every figure.
//
// `primary` is the tenant's ACTUAL operational currency — USD, LBP, or a third currency
// (AED/JOD/…), preserved verbatim and NEVER coerced to USD. `decimalDigits` is that
// currency's server-provided precision, so keypads and displays honour it. `rate` is the
// legacy USD→LBP rate, relevant only to USD/LBP dual-tender.

import {
  operationalDigitsFor,
  setOperationalCurrencyDigits,
  type OperationalCurrencyCode,
} from "@/lib/currency";

export type CurrencySettings = {
  primary: OperationalCurrencyCode;
  decimalDigits: number;
  rate: number | null;
};

export const DEFAULT_CURRENCY: CurrencySettings = { primary: "USD", decimalDigits: 2, rate: null };

/**
 * Resolve the operational currency + precision from the server's currency/regional DTO
 * (`get_tenant_currency_and_regional_settings`). It ALSO loads the per-currency digit
 * registry so `formatMoney`/keypads can render any operational currency this session.
 *
 * Fail-safe: a null/blocked payload, or an `operational_currency` that is not a plausible
 * 3-letter code, resolves to USD — but a valid third-currency code (AED/JOD/…) is preserved
 * verbatim and NEVER coerced to USD. Digits come only from the server catalog (or the
 * intrinsic USD=2 / LBP=0), never from a locale/country guess or a hard-coded table.
 */
export function resolveCurrencyFromSettings(payload: unknown): CurrencySettings {
  const p = (payload ?? null) as
    | { operational_currency?: unknown; usd_to_lbp_rate?: unknown; selectable_currencies?: unknown }
    | null;
  if (!p || typeof p !== "object") return DEFAULT_CURRENCY;

  const selectable = Array.isArray(p.selectable_currencies)
    ? (p.selectable_currencies as ReadonlyArray<{ code?: unknown; decimal_digits?: unknown }>)
    : [];
  setOperationalCurrencyDigits(selectable);

  const opRaw = String(p.operational_currency ?? "").trim().toUpperCase();
  const primary: OperationalCurrencyCode = /^[A-Z]{3}$/.test(opRaw) ? opRaw : "USD";
  const rate = typeof p.usd_to_lbp_rate === "number" ? p.usd_to_lbp_rate : null;
  return { primary, decimalDigits: operationalDigitsFor(primary), rate };
}

/**
 * Restore the operational currency from the offline cache. The module digit registry is
 * empty on a fresh app start, so this re-seeds it from the cached operational currency and
 * its precision — otherwise a JOD tenant would render at the 2dp fallback until it got back
 * online. Tolerates a cache written before `decimalDigits` existed (derives it).
 */
export function hydrateCachedCurrency(c: CurrencySettings | undefined | null): CurrencySettings {
  if (!c || typeof c !== "object") return DEFAULT_CURRENCY;
  const opRaw = String((c as CurrencySettings).primary ?? "").trim().toUpperCase();
  const primary: OperationalCurrencyCode = /^[A-Z]{3}$/.test(opRaw) ? opRaw : "USD";
  const cachedDigits = (c as CurrencySettings).decimalDigits;
  const decimalDigits =
    typeof cachedDigits === "number" && Number.isInteger(cachedDigits) && cachedDigits >= 0 && cachedDigits <= 4
      ? cachedDigits
      : operationalDigitsFor(primary);
  setOperationalCurrencyDigits([{ code: primary, decimal_digits: decimalDigits }]);
  return { primary, decimalDigits, rate: typeof c.rate === "number" ? c.rate : null };
}
