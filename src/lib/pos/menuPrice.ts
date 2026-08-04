// CANONICAL CURRENT-PRICE RESOLVER - ported from the web app's `src/lib/menuPrice.ts`.
//
// A current selling price has TWO representations on the same row:
//
//   * `price_amount_usd` (+ `price_entered_currency`, `price_exchange_rate_usd_to_lbp`)
//     - the AUTHORITATIVE normalized basis, written server-side by m213.
//   * the legacy monetary column (`menu_items.price`, `modifier_options.extra_price`)
//     - kept populated for COMPATIBILITY only.
//
// Consumers must NEVER independently choose between the two. They call
// `resolveMenuPrice()`, which applies the approved rules in exactly this order:
//
//   1. Complete metadata exists -> calculate/display from normalized USD.
//   2. Metadata incomplete      -> use the legacy compatibility value.
//   3. The two paths are NEVER mixed within one row.
//   4. A value is NEVER converted twice.
//
// Pure + framework-free, so it is trivially testable.

import {
  convertUsdToLbp,
  getEquivalentCurrency,
  hasValidRate,
  isCurrencyCode,
  roundUsd,
  type CurrencyCode,
} from "@/lib/currency";
import type { PriceMetadata } from "@/types/pos";

export type MenuPriceSource = "normalized" | "legacy";

export type ResolvedMenuPrice = {
  /** Amount expressed in the tenant's CURRENT primary currency. */
  amount: number | null;
  currency: CurrencyCode;
  /** Authoritative normalized USD. Null only when no usable basis exists. */
  amountUsd: number | null;
  /** The same money in the opposite currency, or null without a usable rate. */
  equivalent: number | null;
  equivalentCurrency: CurrencyCode;
  source: MenuPriceSource;
};

const num = (v: number | string | null | undefined): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Rule 1's precondition - the exact mirror of the SQL predicate
 * `public.price_metadata_complete()` (m213).
 */
export function hasCompletePriceMetadata(row: PriceMetadata | null | undefined): boolean {
  if (!row) return false;
  const cur = row.price_entered_currency;
  if (!isCurrencyCode(cur)) return false;
  if (num(row.price_amount_usd) === null) return false;
  if (cur === "USD") return true;
  const rate = num(row.price_exchange_rate_usd_to_lbp);
  return rate !== null && rate > 0;
}

/**
 * THE canonical resolver. Every current-price surface in the POS resolves through
 * this and nothing else, so conversion arithmetic exists in exactly one place.
 */
export function resolveMenuPrice(
  row: PriceMetadata | null | undefined,
  legacy: number | string | null | undefined,
  primary: CurrencyCode,
  rate: number | null | undefined,
): ResolvedMenuPrice {
  const equivalentCurrency = getEquivalentCurrency(primary);
  const usable = hasValidRate(rate);

  // ---- Rule 1: complete metadata -> the normalized USD basis is authoritative.
  if (hasCompletePriceMetadata(row)) {
    const amountUsd = num(row!.price_amount_usd) as number;
    if (primary === "USD") {
      return {
        amount: roundUsd(amountUsd),
        currency: primary,
        amountUsd,
        equivalent: usable ? convertUsdToLbp(amountUsd, rate) : null,
        equivalentCurrency,
        source: "normalized",
      };
    }
    // LBP primary: one conversion, from the USD basis, using TODAY's rate.
    // Without a usable rate the amount is not expressible in LBP - report null
    // rather than fall through to the legacy value, which would mix the paths.
    return {
      amount: usable ? convertUsdToLbp(amountUsd, rate) : null,
      currency: primary,
      amountUsd,
      equivalent: roundUsd(amountUsd),
      equivalentCurrency,
      source: "normalized",
    };
  }

  // ---- Rule 2: incomplete metadata -> legacy value, legacy behaviour.
  // The legacy column has always been read as "already in the tenant's primary
  // currency". Nothing here infers, classifies or rewrites it.
  const amount = num(legacy);
  if (amount === null) {
    return { amount: null, currency: primary, amountUsd: null, equivalent: null, equivalentCurrency, source: "legacy" };
  }
  // Mirrors the database helper `_pos_amount_usd(amount, primary, rate)`.
  const amountUsd = primary === "LBP" && usable ? amount / (rate as number) : amount;
  return {
    amount,
    currency: primary,
    amountUsd,
    equivalent: usable ? (primary === "USD" ? convertUsdToLbp(amount, rate) : roundUsd(amountUsd)) : null,
    equivalentCurrency,
    source: "legacy",
  };
}

/**
 * Convenience for cart/total math: the amount in the tenant's primary currency,
 * or 0 when it cannot be expressed.
 */
export function resolvedAmountOrZero(resolved: ResolvedMenuPrice): number {
  return resolved.amount ?? 0;
}

/** The metadata columns every current-price loader must select. */
export const PRICE_METADATA_COLUMNS =
  "price_entered_amount, price_entered_currency, price_exchange_rate_usd_to_lbp, price_amount_usd";
