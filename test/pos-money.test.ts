// Discounts, currency and cash handling.
//
// Every rule below is also enforced by pos_pay_order. Keeping them identical is
// what makes the figure on screen the figure that gets charged.

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeDiscount, discountPayload, fixedDiscountToPrimary } from "@/lib/pos/discounts";
import { computeChange, paymentBlockedReason } from "@/lib/pos/payments";
import { convertCurrency, convertLbpToUsd, convertUsdToLbp, formatMoney, parseAmount, roundForCurrency } from "@/lib/currency";
import { resolveMenuPrice } from "@/lib/pos/menuPrice";

// --- discounts ---------------------------------------------------------------

test("a percentage discount below zero is rejected", () => {
  const r = computeDiscount(100, "percent", "-5");
  assert.equal(r.valid, false);
  assert.match(r.error ?? "", /cannot be negative/);
});

test("a percentage discount above 100 is rejected", () => {
  const r = computeDiscount(100, "percent", "101");
  assert.equal(r.valid, false);
  assert.match(r.error ?? "", /cannot exceed 100/);
});

test("exactly 100 percent is allowed and zeroes the total", () => {
  const r = computeDiscount(80, "percent", "100");
  assert.equal(r.valid, true);
  assert.equal(r.amount, 80);
  assert.equal(r.finalTotal, 0);
});

test("a fixed discount above the subtotal is rejected", () => {
  const r = computeDiscount(20, "amount", "20.01");
  assert.equal(r.valid, false);
  assert.match(r.error ?? "", /cannot exceed the subtotal/);
});

test("a valid fixed discount subtracts exactly", () => {
  const r = computeDiscount(20, "amount", "4.55");
  assert.equal(r.valid, true);
  assert.equal(r.amount, 4.55);
  assert.equal(r.finalTotal, 15.45);
});

test("a blank discount value is a validation error, not a silent zero", () => {
  const r = computeDiscount(20, "percent", "");
  assert.equal(r.valid, false);
  assert.match(r.error ?? "", /Enter a discount value/);
});

test("an unauthorized user contributes no discount to the payload", () => {
  assert.deepEqual(discountPayload(false, 100, "percent", "10"), {});
  assert.deepEqual(discountPayload(true, 100, "percent", "10"), { discount_type: "percent", discount_value: 10 });
});

test("an invalid discount never reaches the payload", () => {
  assert.deepEqual(discountPayload(true, 100, "percent", "150"), {});
  assert.deepEqual(discountPayload(true, 100, "amount", "500"), {});
});

test("a fixed discount typed in LBP is converted to the primary currency", () => {
  // 89,500 LBP at 89,500 = 1 USD
  assert.equal(fixedDiscountToPrimary("amount", "89500", "LBP", "USD", 89500), "1");
  // percentages are currency-independent
  assert.equal(fixedDiscountToPrimary("percent", "10", "LBP", "USD", 89500), "10");
  // same currency passes through untouched
  assert.equal(fixedDiscountToPrimary("amount", "5", "USD", "USD", 89500), "5");
});

// --- currency ----------------------------------------------------------------

test("LBP payment is refused when no exchange rate is set", () => {
  assert.match(paymentBlockedReason("LBP", null) ?? "", /exchange rate/);
  assert.match(paymentBlockedReason("LBP", 0) ?? "", /exchange rate/);
  assert.equal(paymentBlockedReason("LBP", 89500), null);
});

test("USD payment never depends on the exchange rate", () => {
  assert.equal(paymentBlockedReason("USD", null), null);
});

test("conversion is symmetric and rounds per currency", () => {
  assert.equal(convertUsdToLbp(1, 89500), 89500);
  assert.equal(convertLbpToUsd(89500, 89500), 1);
  assert.equal(convertUsdToLbp(0.5, 89500), 44750);
  // LBP has no sub-unit: any conversion must land on a whole number.
  assert.ok(Number.isInteger(convertUsdToLbp(1.005, 89500)));
  assert.ok(Number.isInteger(convertUsdToLbp(3.33, 89500)));
  assert.equal(roundForCurrency(1.006, "USD"), 1.01);
  assert.equal(roundForCurrency(1.4, "LBP"), 1);
  assert.equal(roundForCurrency(1.6, "LBP"), 2);
});

test("converting without a rate throws rather than returning a wrong number", () => {
  assert.throws(() => convertCurrency(10, "USD", "LBP", null), /exchange rate/);
  assert.equal(convertCurrency(10, "USD", "USD", null), 10);
});

test("money formatting never puts a dollar sign on LBP", () => {
  assert.equal(formatMoney(12.5, "USD"), "$12.50");
  assert.ok(!formatMoney(1000, "LBP").includes("$"));
  assert.ok(formatMoney(1000, "LBP").endsWith("LBP"));
});

test("typed amounts tolerate grouping separators", () => {
  assert.equal(parseAmount("1,234.50"), 1234.5);
  assert.equal(parseAmount(" 500 000 "), 500000);
  assert.equal(parseAmount("abc"), 0);
  assert.equal(parseAmount(""), 0);
});

// --- tendered / change -------------------------------------------------------

test("change is the tender minus the bill, never negative", () => {
  const exact = computeChange(15.45, 20, "USD");
  assert.equal(exact.change, 4.55);
  assert.equal(exact.short, false);
});

test("a short tender is flagged and yields no change", () => {
  const short = computeChange(20, 15, "USD");
  assert.equal(short.change, 0);
  assert.equal(short.short, true);
});

test("an empty tender is not treated as short", () => {
  const none = computeChange(20, 0, "USD");
  assert.equal(none.short, false);
});

test("LBP change is whole-number", () => {
  const r = computeChange(89500, 100000, "LBP");
  assert.equal(r.change, 10500);
});

// --- price resolution --------------------------------------------------------

test("complete price metadata is authoritative over the legacy column", () => {
  const row = {
    price_entered_amount: 5,
    price_entered_currency: "USD",
    price_exchange_rate_usd_to_lbp: null,
    price_amount_usd: 5,
  };
  // The legacy column deliberately disagrees; metadata must win.
  const r = resolveMenuPrice(row, 999, "USD", 89500);
  assert.equal(r.source, "normalized");
  assert.equal(r.amount, 5);
});

test("an LBP-primary tenant sees the USD basis converted once, at today's rate", () => {
  const row = {
    price_entered_amount: 5,
    price_entered_currency: "USD",
    price_exchange_rate_usd_to_lbp: null,
    price_amount_usd: 5,
  };
  const r = resolveMenuPrice(row, 5, "LBP", 89500);
  assert.equal(r.source, "normalized");
  assert.equal(r.amount, 447500);
});

test("an LBP-primary tenant with no rate reports no price rather than the legacy value", () => {
  const row = {
    price_entered_amount: 5,
    price_entered_currency: "USD",
    price_exchange_rate_usd_to_lbp: null,
    price_amount_usd: 5,
  };
  const r = resolveMenuPrice(row, 5, "LBP", null);
  assert.equal(r.amount, null, "mixing the normalized and legacy paths is what produces wrong prices");
});

test("incomplete metadata falls back to the legacy value, unchanged", () => {
  const r = resolveMenuPrice({ price_entered_currency: null }, 7.25, "USD", 89500);
  assert.equal(r.source, "legacy");
  assert.equal(r.amount, 7.25);
});
