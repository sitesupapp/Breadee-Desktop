// Operational-currency generalization (i18n 5E-1A-D).
//
// The desktop must run a third-currency tenant (AED/JOD/…) in its ONE operational
// currency across menu/cart/table/delivery/payment/shift, at the currency's own
// precision, WITHOUT coercing it to USD and WITHOUT a USD/LBP tender/price chooser.
// USD/LBP tenants keep their exact dual-tender behaviour, and the receipt engine
// (Slice 6B) and the USD cash-drawer contract are untouched.
//
// These are unit + source assertions: no persistent third-currency tenant exists.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  formatMoney,
  isKnownOperationalCurrency,
  isLegacyDualCurrency,
  operationalDigitsFor,
  receiptFallbackCurrency,
  roundForCurrency,
  setOperationalCurrencyDigits,
} from "@/lib/currency";
import { computeChange, paymentBlockedReason } from "@/lib/pos/payments";
import { resolveMenuPrice } from "@/lib/pos/menuPrice";
import { stripComments, stripJsxComments } from "./source-helpers.ts";

const root = dirname(fileURLToPath(import.meta.url));
const readSrc = (...p: string[]) => readFileSync(join(root, "..", "src", ...p), "utf8");

// The server's `selectable_currencies` shape, as the session loads it. Kept small; the
// point is that digits come from HERE (server metadata), never a hard-coded local table.
const CATALOG = [
  { code: "USD", decimal_digits: 2 },
  { code: "LBP", decimal_digits: 0 },
  { code: "AED", decimal_digits: 2 },
  { code: "SAR", decimal_digits: 2 },
  { code: "JOD", decimal_digits: 3 },
  { code: "KWD", decimal_digits: 3 },
];

// --- the digit registry (server-sourced, no local catalog) -------------------

test("USD and LBP precision is intrinsic - it needs no registry", () => {
  setOperationalCurrencyDigits([]); // empty: nothing loaded yet
  assert.equal(operationalDigitsFor("USD"), 2);
  assert.equal(operationalDigitsFor("LBP"), 0);
  // A third currency with no loaded catalog falls back to 2 (fail-safe) but is NOT known.
  assert.equal(operationalDigitsFor("JOD"), 2);
  assert.equal(isKnownOperationalCurrency("JOD"), false);
  assert.equal(isKnownOperationalCurrency("USD"), true);
});

test("once the server catalog is loaded, a third currency uses the server precision", () => {
  setOperationalCurrencyDigits(CATALOG);
  assert.equal(operationalDigitsFor("AED"), 2);
  assert.equal(operationalDigitsFor("JOD"), 3);
  assert.equal(operationalDigitsFor("KWD"), 3);
  assert.equal(isKnownOperationalCurrency("AED"), true);
  assert.equal(isKnownOperationalCurrency("JOD"), true);
});

test("a well-formed but unknown code is never treated as real money", () => {
  setOperationalCurrencyDigits(CATALOG);
  // "XXX" is a valid ISO shape but not in the catalog - it must be dropped, not shown.
  assert.equal(isKnownOperationalCurrency("XXX"), false);
  assert.equal(isKnownOperationalCurrency("ab"), false);
  assert.equal(isKnownOperationalCurrency("aed"), false); // lower-case is not a stored code
});

// --- formatting: no "$" leakage, correct digits ------------------------------

test("USD and LBP formatting is byte-identical to before", () => {
  setOperationalCurrencyDigits(CATALOG);
  assert.equal(formatMoney(12.5, "USD"), "$12.50");
  assert.equal(formatMoney(1000, "LBP"), "1,000 LBP");
  assert.equal(formatMoney(12.34, "USD").includes("USD"), false);
});

test("AED renders at 2 decimals with its code and never a dollar sign", () => {
  setOperationalCurrencyDigits(CATALOG);
  assert.equal(formatMoney(12.3, "AED"), "12.30 AED");
  assert.equal(formatMoney(12.34, "AED").includes("$"), false);
});

test("JOD renders at 3 decimals - never collapsed to 2 or shown as dollars", () => {
  setOperationalCurrencyDigits(CATALOG);
  assert.equal(formatMoney(45.678, "JOD"), "45.678 JOD");
  assert.equal(formatMoney(45.6, "JOD"), "45.600 JOD");
  assert.equal(formatMoney(45.678, "JOD").includes("$"), false);
});

// --- rounding for change follows the currency, not a universal 2dp -----------

test("change rounding honours the currency's real precision", () => {
  setOperationalCurrencyDigits(CATALOG);
  assert.equal(roundForCurrency(1.006, "USD"), 1.01);
  assert.equal(roundForCurrency(1.6, "LBP"), 2); // 0dp, whole units
  assert.equal(roundForCurrency(1.239, "AED"), 1.24); // 2dp
  assert.equal(roundForCurrency(1.2344, "JOD"), 1.234); // 3dp, not 1.23
  assert.equal(roundForCurrency(1.2346, "JOD"), 1.235);
});

test("JOD cash change is computed at 3 decimals", () => {
  setOperationalCurrencyDigits(CATALOG);
  const r = computeChange(45.678, 50, "JOD");
  assert.equal(r.change, 4.322);
  assert.equal(r.short, false);
});

// --- the legacy / third-currency split ---------------------------------------

test("only USD and LBP are legacy dual-tender currencies", () => {
  assert.equal(isLegacyDualCurrency("USD"), true);
  assert.equal(isLegacyDualCurrency("LBP"), true);
  assert.equal(isLegacyDualCurrency("AED"), false);
  assert.equal(isLegacyDualCurrency("JOD"), false);
});

test("a third-currency payment is never rate-blocked; LBP still is", () => {
  assert.equal(paymentBlockedReason("AED", null), null);
  assert.equal(paymentBlockedReason("JOD", null), null);
  assert.equal(paymentBlockedReason("USD", null), null);
  assert.match(paymentBlockedReason("LBP", null) ?? "", /exchange rate/);
  assert.equal(paymentBlockedReason("LBP", 89500), null);
});

test("the receipt fallback is USD/LBP only - a third currency relies on server metadata", () => {
  assert.equal(receiptFallbackCurrency("USD"), "USD");
  assert.equal(receiptFallbackCurrency("LBP"), "LBP");
  assert.equal(receiptFallbackCurrency("AED"), "USD");
  assert.equal(receiptFallbackCurrency("JOD"), "USD");
});

// --- menu price for a third currency reads the operational amount directly ----

test("a third-currency menu price is read from its own column, with no USD conversion", () => {
  setOperationalCurrencyDigits(CATALOG);
  // A price authored in AED: the server stored the AED amount in the legacy column and
  // marked the entered currency AED (so the normalized-USD metadata is 'incomplete' for
  // the USD/LBP resolver). The resolver must return the AED amount as-is, in AED.
  const row = {
    price_entered_amount: 18.5,
    price_entered_currency: "AED",
    price_exchange_rate_usd_to_lbp: null,
    price_amount_usd: 5.03,
  };
  const r = resolveMenuPrice(row, 18.5, "AED", null);
  assert.equal(r.amount, 18.5);
  assert.equal(r.currency, "AED");
  assert.equal(r.source, "legacy");
  // No USD/LBP equivalent line for a currency with no second side.
  assert.equal(r.equivalent, null);
  assert.equal(r.equivalentCurrency, null);
});

test("USD/LBP menu-price resolution is unchanged by the generalization", () => {
  const row = {
    price_entered_amount: 5,
    price_entered_currency: "USD",
    price_exchange_rate_usd_to_lbp: null,
    price_amount_usd: 5,
  };
  const usd = resolveMenuPrice(row, 999, "USD", 89500);
  assert.equal(usd.source, "normalized");
  assert.equal(usd.amount, 5);
  assert.equal(usd.equivalentCurrency, "LBP");
  const lbp = resolveMenuPrice(row, 5, "LBP", 89500);
  assert.equal(lbp.amount, 447500);
  assert.equal(lbp.equivalentCurrency, "USD");
});

// --- source assertions: the choosers are operational-aware -------------------

const paymentDialog = stripJsxComments(readSrc("components", "pos", "PaymentDialog.tsx"));
const priceField = stripJsxComments(readSrc("components", "menu", "PriceField.tsx"));
const keypad = stripComments(readSrc("components", "pos", "NumericKeypad.tsx"));
const session = stripComments(readSrc("state", "session.ts"));

test("the payment tender chooser is shown ONLY for a USD/LBP tenant", () => {
  // The hard-coded USD/LBP chooser must sit behind the legacy-currency gate.
  assert.match(paymentDialog, /isLegacyDualCurrency\(props\.primaryCurrency\)\s*&&/);
  // And the keypad precision follows the tender currency, not a USD-only decimal flag.
  assert.match(paymentDialog, /decimalDigits=\{operationalDigitsFor\(currency\)\}/);
  assert.equal(/allowDecimal=\{currency === "USD"\}/.test(paymentDialog), false);
});

test("the payment tender defaults and resets to the operational currency, never USD", () => {
  // Initial state and the on-open reset both use primaryCurrency (the operational currency).
  assert.match(paymentDialog, /useState<OperationalCurrencyCode>\(props\.primaryCurrency\)/);
  assert.match(paymentDialog, /setCurrency\(props\.primaryCurrency\)/);
});

test("the menu price-currency toggle is USD/LBP only for a USD/LBP tenant", () => {
  assert.match(priceField, /isLegacyDualCurrency\(value\)\s*\?\s*\["USD", "LBP"\]\s*:\s*\[value\]/);
  // No USD/LBP equivalent hint for a third currency.
  assert.match(priceField, /if \(!isLegacyDualCurrency\(currency\)\) return null;/);
});

test("the keypad enforces the currency's decimal precision", () => {
  assert.match(keypad, /decimalDigits\?: number/);
  assert.match(keypad, /decimals\.length \+ key\.length > maxDecimals/);
});

test("the session reads the operational currency from the server, and never coerces it to USD", () => {
  // The authoritative read-path.
  assert.match(session, /get_tenant_currency_and_regional_settings/);
  // The old bilateral coercion (isCurrencyCode(...) ? ... : "USD") must be gone.
  assert.equal(/isCurrencyCode\([^)]*\)\s*\?\s*[^:]*:\s*"USD"/.test(session), false);
  // A plausible 3-letter operational code is preserved verbatim.
  assert.match(session, /\/\^\[A-Z\]\{3\}\$\/\.test\(opRaw\) \? opRaw : "USD"/);
});
