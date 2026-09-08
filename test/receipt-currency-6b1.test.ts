// Internationalization Slice 6B-1 — Desktop receipt display contract.
//
// The receipt renders in the order's OWN currency at a SERVER-PROVIDED precision
// (`decimal_digits`), with no local currency catalog and no hard-coded 2-decimal
// assumption. USD and LBP are byte-identical to the legacy formatter; a third
// currency (AED/SAR/JOD/KWD, gated) renders "<amount> <CODE>" at its own precision.
// These tests pin the formatter and the model/native-payload layer; the assembly is
// wired to the server contract separately in 6B-2.

import { test } from "node:test";
import assert from "node:assert/strict";

import { formatMoney, formatReceiptMoney, normalizeCurrencyCode } from "@/lib/currency";
import { buildReceipt } from "@/lib/receipt";
import { toReceiptDoc } from "@/lib/nativePrinting";

// --- USD / LBP are byte-identical to the legacy formatter --------------------

test("USD is byte-identical to the legacy formatter (digits ignored)", () => {
  for (const n of [0, 7, 10.5, -2.5, 1234567.5, 45.678]) {
    assert.equal(formatReceiptMoney(n, "USD", 2), formatMoney(n, "USD"));
  }
  assert.equal(formatReceiptMoney(10.5, "USD", 2), "$10.50");
  // The digit count is not consulted for USD — it renders "$x.xx" regardless.
  assert.equal(formatReceiptMoney(10.5, "USD", 3), "$10.50");
});

test("LBP is byte-identical to the legacy formatter (digits ignored)", () => {
  for (const n of [0, 1000, 626500, 89500000, 899999.5]) {
    assert.equal(formatReceiptMoney(n, "LBP", 0), formatMoney(n, "LBP"));
  }
  assert.ok(!formatReceiptMoney(626500, "LBP", 0).includes("$"));
  assert.ok(formatReceiptMoney(626500, "LBP", 0).endsWith("LBP"));
});

// --- third currencies use the server precision, no $/LBP leakage -------------

test("AED / SAR render at 2 decimals with the ISO code", () => {
  assert.equal(formatReceiptMoney(45, "AED", 2), "45.00 AED");
  assert.equal(formatReceiptMoney(45, "SAR", 2), "45.00 SAR");
  assert.equal(formatReceiptMoney(0, "AED", 2), "0.00 AED");
  assert.equal(formatReceiptMoney(-7.5, "AED", 2), "-7.50 AED");
});

test("JOD / KWD render at 3 decimals (never collapsed to 2)", () => {
  assert.equal(formatReceiptMoney(45, "JOD", 3), "45.000 JOD");
  assert.equal(formatReceiptMoney(45.678, "JOD", 3), "45.678 JOD");
  assert.equal(formatReceiptMoney(45, "KWD", 3), "45.000 KWD");
  assert.ok(!formatReceiptMoney(45, "JOD", 3).includes("45.00 "));
});

test("no USD '$' or 'LBP' ever leaks onto a third-currency amount", () => {
  for (const [ccy, digits] of [["AED", 2], ["SAR", 2], ["JOD", 3], ["KWD", 3]] as const) {
    const s = formatReceiptMoney(45, ccy, digits);
    assert.ok(!s.includes("$"), `${ccy} must not contain $`);
    assert.ok(!s.includes("LBP"), `${ccy} must not contain LBP`);
    assert.ok(s.endsWith(` ${ccy}`), `${ccy} renders its own code`);
  }
});

// --- currency is runtime-validated at the boundary ---------------------------

test("normalizeCurrencyCode upper-cases valid 3-letter codes and rejects the rest", () => {
  assert.equal(normalizeCurrencyCode("aed"), "AED");
  assert.equal(normalizeCurrencyCode("  usd "), "USD");
  assert.equal(normalizeCurrencyCode("JOD"), "JOD");
  assert.equal(normalizeCurrencyCode(""), "USD");
  assert.equal(normalizeCurrencyCode("12"), "USD");
  assert.equal(normalizeCurrencyCode("<script>"), "USD"); // no injection into the label
  assert.equal(normalizeCurrencyCode(null), "USD");
  assert.equal(normalizeCurrencyCode(undefined), "USD");
});

test("a malformed currency falls back to USD rendering, never a blank label", () => {
  assert.equal(formatReceiptMoney(10, "zz", 2), "$10.00");
});

// --- model / native payload parity -------------------------------------------

test("the model carries currency + decimalDigits through to the native payload", () => {
  const receipt = buildReceipt({
    businessName: "Test",
    branchName: "Main",
    staffName: null,
    orderNumber: "A-1",
    at: "now",
    paid: true,
    method: "cash",
    currency: "JOD",
    decimalDigits: 3,
    lines: [{ name: "Mansaf", qty: 1, unitPrice: 45, lineTotal: 45 }],
    subtotal: 45,
    discount: 0,
    total: 45,
  });
  assert.equal(receipt.currency, "JOD");
  assert.equal(receipt.decimalDigits, 3);
  const doc = toReceiptDoc(receipt);
  // Screen and paper read the SAME currency + precision — no drift between renderers.
  assert.equal(doc.currency, "JOD");
  assert.equal(doc.decimalDigits, 3);
  // Formatting either side of the boundary agrees on the third-currency string.
  assert.equal(formatReceiptMoney(doc.total, doc.currency, doc.decimalDigits), "45.000 JOD");
});

test("decimalDigits defaults to 2 when a caller omits it (6B-1 pre-wiring)", () => {
  const receipt = buildReceipt({
    businessName: "Test",
    branchName: "Main",
    staffName: null,
    orderNumber: "A-2",
    at: "now",
    paid: true,
    method: "cash",
    currency: "USD",
    lines: [],
    subtotal: 0,
    discount: 0,
    total: 0,
  });
  assert.equal(receipt.decimalDigits, 2);
});

test("the delivery fee cannot be double-counted: it lives inside `total`, and the fee line is a breakdown, never an addition", () => {
  // The server folds the fee into the order total. The receipt now shows a Delivery
  // Fee breakdown line (Delivery Fee lifecycle), but that line is DISPLAY only: the
  // doc's `total` is the server total verbatim, and `deliveryFee` is a view of a
  // component already inside it - it is never added on top. Two properties pin this:
  //   1. with NO fee supplied, `deliveryFee` is null (the line prints nothing), so
  //      total stands alone exactly as before the feature existed; and
  //   2. surfacing the fee as a breakdown line does NOT inflate `total`: the same
  //      server total (45) stands whether `deliveryFee` is null or 5 - the line is
  //      a view of a component already inside it, never a second charge added on top.
  const noFee = toReceiptDoc(
    buildReceipt({
      businessName: "Test",
      branchName: "Main",
      staffName: null,
      orderNumber: "A-3",
      at: "now",
      paid: true,
      method: "cash",
      currency: "JOD",
      decimalDigits: 3,
      lines: [{ name: "Item", qty: 1, unitPrice: 40, lineTotal: 40 }],
      subtotal: 40,
      discount: 0,
      total: 45, // includes a 5 delivery fee, folded in by the server
    }),
  );
  assert.equal(noFee.total, 45);
  // The field exists (the native ReceiptDoc always carries it) but is INERT: null,
  // so nothing prints and there is nothing to double-count.
  assert.equal(noFee.deliveryFee, null, "an unsupplied fee is null/inert, not additive");
  assert.equal(formatReceiptMoney(noFee.total, noFee.currency, noFee.decimalDigits), "45.000 JOD");

  // Same order, now WITH the fee surfaced as a breakdown line.
  const withFee = toReceiptDoc(
    buildReceipt({
      businessName: "Test",
      branchName: "Main",
      staffName: null,
      orderNumber: "A-3",
      at: "now",
      paid: true,
      method: "cash",
      currency: "JOD",
      decimalDigits: 3,
      lines: [{ name: "Item", qty: 1, unitPrice: 40, lineTotal: 40 }],
      subtotal: 40,
      discount: 0,
      deliveryFee: 5,
      total: 45, // STILL the server total - the fee is inside it, not added to it
    }),
  );
  // The decisive anti-double-count assertion: surfacing the fee line leaves `total`
  // exactly as the server sent it - the SAME 45 as the no-fee doc, never 50.
  assert.equal(withFee.total, 45);
  assert.equal(withFee.total, noFee.total, "showing the fee line must not inflate the total");
  assert.equal(withFee.deliveryFee, 5);
  assert.equal(formatReceiptMoney(withFee.total, withFee.currency, withFee.decimalDigits), "45.000 JOD");
});
