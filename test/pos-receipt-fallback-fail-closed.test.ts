// i18n 5E-1A-D follow-up — the receipt fallback boundary must fail closed for a third
// currency, and the offline session must keep its precision.
//
// REGRESSION GUARDED: 5E-1A-D briefly collapsed a third-currency receipt fallback to USD
// (`receiptFallbackCurrency("AED") → "USD"`), so a third-currency order on a server-metadata
// OUTAGE would have printed as USD 2dp. The hard 6B contract is: a third currency's receipt
// currency + precision come from the server, and if they are unavailable the receipt is
// REFUSED — never USD, never a guessed 2dp. USD/LBP keep their legacy fallback.

import { test } from "node:test";
import assert from "node:assert/strict";

import { fetchReceiptCurrency, ReceiptCurrencyError } from "@/lib/pos/receiptCurrency";
import { operationalDigitsFor, setOperationalCurrencyDigits } from "@/lib/currency";
import {
  DEFAULT_CURRENCY,
  hydrateCachedCurrency,
  resolveCurrencyFromSettings,
} from "@/state/currencySettings";

const CATALOG = [
  { code: "USD", decimal_digits: 2 },
  { code: "LBP", decimal_digits: 0 },
  { code: "AED", decimal_digits: 2 },
  { code: "JOD", decimal_digits: 3 },
];

// --- the single async caller boundary (all 8 callers share fetchReceiptCurrency) ---------
//
// The no-order path is exactly the "no server metadata" outage (the comment in
// fetchReceiptCurrency lists a null/empty orderId alongside a transport failure), and it
// exercises the real async boundary WITHOUT a live server. The server-DTO-present path
// delegates entirely to resolveReceiptCurrency (which ignores the operational arg when meta
// is present) and is covered exhaustively in receipt-currency-resolver.test.ts.

test("USD/LBP receipt fallback is unchanged (no server metadata → own currency)", async () => {
  assert.deepEqual(await fetchReceiptCurrency(null, "USD"), { currency: "USD", decimalDigits: 2 });
  assert.deepEqual(await fetchReceiptCurrency("", "LBP"), { currency: "LBP", decimalDigits: 2 });
  assert.deepEqual(await fetchReceiptCurrency(undefined, "USD"), { currency: "USD", decimalDigits: 2 });
});

test("a third-currency order with NO server metadata fails closed - never USD", async () => {
  await assert.rejects(() => fetchReceiptCurrency(null, "AED"), ReceiptCurrencyError);
  await assert.rejects(() => fetchReceiptCurrency("", "JOD"), ReceiptCurrencyError);
  await assert.rejects(() => fetchReceiptCurrency(undefined, "KWD"), ReceiptCurrencyError);
  // The refusal never substitutes USD.
  await assert.rejects(() => fetchReceiptCurrency(null, "AED"), /not be printed as USD/);
});

// The takeaway / table / delivery reprint callers ALL route through this one boundary with
// their order's operational currency, so proving the boundary once proves all three.

// --- offline session precision (5E-1A-D cache restore) -----------------------------------

test("an online third-currency session resolves + seeds server precision", () => {
  setOperationalCurrencyDigits([]); // fresh process
  const jod = resolveCurrencyFromSettings({
    operational_currency: "JOD",
    selectable_currencies: CATALOG,
    usd_to_lbp_rate: null,
  });
  assert.equal(jod.primary, "JOD");
  assert.equal(jod.decimalDigits, 3);
  assert.equal(operationalDigitsFor("JOD"), 3); // registry seeded from the server catalog
});

test("a valid third-currency code is preserved verbatim, never coerced to USD", () => {
  const aed = resolveCurrencyFromSettings({ operational_currency: "AED", selectable_currencies: CATALOG });
  assert.equal(aed.primary, "AED");
  assert.equal(aed.decimalDigits, 2);
  // Garbage / non-3-letter operational currency fails safe to USD (never a third-currency guess).
  assert.equal(resolveCurrencyFromSettings({ operational_currency: "toolong" }).primary, "USD");
  assert.equal(resolveCurrencyFromSettings(null).primary, DEFAULT_CURRENCY.primary);
});

test("offline restore of a cached JOD session stays 3dp (registry re-seeded)", () => {
  // Simulate an app restart: the module registry is empty until something loads it.
  setOperationalCurrencyDigits([]);
  assert.equal(operationalDigitsFor("JOD"), 2, "empty registry falls back to 2 before restore");

  const restored = hydrateCachedCurrency({ primary: "JOD", decimalDigits: 3, rate: null });
  assert.equal(restored.primary, "JOD");
  assert.equal(restored.decimalDigits, 3);
  assert.equal(operationalDigitsFor("JOD"), 3, "cache restore re-seeds the digit registry");
});

test("offline restore keeps AED 2dp and LBP 0dp", () => {
  setOperationalCurrencyDigits([]);
  const aed = hydrateCachedCurrency({ primary: "AED", decimalDigits: 2, rate: null });
  assert.equal(aed.decimalDigits, 2);
  assert.equal(operationalDigitsFor("AED"), 2);

  setOperationalCurrencyDigits([]);
  const lbp = hydrateCachedCurrency({ primary: "LBP", decimalDigits: 0, rate: 90000 });
  assert.equal(lbp.decimalDigits, 0);
  assert.equal(lbp.rate, 90000);
});

test("a pre-precision cache (USD/LBP era) derives digits without breaking", () => {
  setOperationalCurrencyDigits([]);
  // An old cache written before decimalDigits existed: USD/LBP derive intrinsically.
  const usd = hydrateCachedCurrency({ primary: "USD" } as never);
  assert.equal(usd.decimalDigits, 2);
  const lbp = hydrateCachedCurrency({ primary: "LBP" } as never);
  assert.equal(lbp.decimalDigits, 0);
  // (A third currency could not have a pre-i18n cache — third-currency activation postdates
  // decimalDigits — so that impossible case is intentionally not supported.)
});
