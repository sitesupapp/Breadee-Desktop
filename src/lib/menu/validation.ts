// Menu Builder validation - a CLIENT MIRROR of rules the server already holds.
//
// Every rule below exists to explain a refusal before the round trip, never to
// be the refusal. The authorities are:
//
//   * `_price_write_prepare` (m213)  - amount required, non-negative, currency
//                                      must be USD or LBP, a usable USD->LBP
//                                      rate is required whenever either the
//                                      entered currency or the tenant's primary
//                                      currency is LBP, and |amount| < 1e14.
//   * `modifier_groups_canonical_selection_chk` - see `modifierGroupConfig.ts`.
//   * `menu_items.name` / `menu_categories.name` - NOT NULL.
//
// WHAT IS DELIBERATELY NOT VALIDATED: duplicate item or category names. There is
// no unique index on either table and the web Menu Builder does not check, so a
// desktop check would refuse a save the web app accepts - which is divergence,
// not safety. Two "Espresso" rows are legal in this schema and stay legal here.

import { hasValidRate, type CurrencyCode } from "@/lib/currency";

/** The largest magnitude the legacy numeric(18,4) price columns can hold. */
export const PRICE_MAX_SAFE = 1e14;

/** True when an amount would overflow a price column - mirrors m213's `c_max`. */
export function exceedsPriceLimit(amount: number | null | undefined): boolean {
  const n = Number(amount);
  return Number.isFinite(n) && Math.abs(n) >= PRICE_MAX_SAFE;
}

/**
 * Why a price cannot be saved, or null.
 *
 * `amount` null means "no price" - legal for a menu item (the column is
 * nullable and the web app leaves drafts unpriced), so it is not an error here.
 * A modifier option is different: `extra_price` is NOT NULL, so its caller
 * passes 0 rather than null.
 */
export function priceError(
  amount: number | null,
  entered: CurrencyCode,
  primary: CurrencyCode,
  rate: number | null | undefined,
): string | null {
  if (amount === null) return null;
  if (!Number.isFinite(amount)) return "Enter a valid amount.";
  if (amount < 0) return "Price cannot be negative.";
  if (exceedsPriceLimit(amount)) return "This price is too large to be stored safely.";
  // An LBP amount - or any amount for an LBP-primary tenant - cannot be
  // normalised to its USD basis without a rate. The server raises here too.
  if ((entered === "LBP" || primary === "LBP") && !hasValidRate(rate)) {
    return "Set a USD to LBP exchange rate in Currency Settings before saving this price.";
  }
  return null;
}

export type ItemDraftInput = {
  name?: string | null;
  price?: number | null;
};

/** Field-keyed errors for the item drawer. Empty object means "saveable". */
export function itemDraftErrors(
  draft: ItemDraftInput,
  entered: CurrencyCode,
  primary: CurrencyCode,
  rate: number | null | undefined,
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!draft.name || draft.name.trim() === "") errors.name = "An item name is required.";
  const price = priceError(draft.price ?? null, entered, primary, rate);
  if (price) errors.price = price;
  return errors;
}

/** Why a category cannot be saved, or null. */
export function categoryNameError(name: string | null | undefined): string | null {
  return !name || name.trim() === "" ? "A category name is required." : null;
}

/** Why a modifier option cannot be added, or null. */
export function optionErrors(
  name: string | null | undefined,
  extra: number | null,
  entered: CurrencyCode,
  primary: CurrencyCode,
  rate: number | null | undefined,
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!name || name.trim() === "") errors.name = "An option name is required.";
  // extra_price is NOT NULL, so an option always carries an amount.
  const price = priceError(extra ?? 0, entered, primary, rate);
  if (price) errors.extra = price;
  return errors;
}

/** Whether an error map permits a save. */
export const isSaveable = (errors: Record<string, string>): boolean => Object.keys(errors).length === 0;
