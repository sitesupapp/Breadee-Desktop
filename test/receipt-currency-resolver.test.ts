// Internationalization Slice 6B-2 — the receipt-currency resolver.
//
// The historical order snapshot (finance_order_financials) is authoritative for what a
// receipt displays. This resolver is the fail-closed gate: a third currency whose server
// precision is missing/invalid is REFUSED, never printed at a guessed 2 decimals; a
// malformed server currency is refused, never coerced to USD. USD/LBP keep an intrinsic
// precision the formatter ignores, and an absent DTO falls back to the client USD/LBP
// currency (the one documented default-2 path, justified for USD/LBP only).

import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveReceiptCurrency, ReceiptCurrencyError } from "@/lib/pos/receiptCurrency";

test("USD/LBP from the server resolve to themselves", () => {
  assert.deepEqual(resolveReceiptCurrency({ currency: "USD", decimal_digits: 2 }, "USD"), {
    currency: "USD",
    decimalDigits: 2,
  });
  assert.deepEqual(resolveReceiptCurrency({ currency: "LBP", decimal_digits: 0 }, "USD"), {
    currency: "LBP",
    decimalDigits: 0,
  });
});

test("an absent DTO falls back to the client USD/LBP currency (the documented default)", () => {
  assert.deepEqual(resolveReceiptCurrency(null, "USD"), { currency: "USD", decimalDigits: 2 });
  assert.deepEqual(resolveReceiptCurrency(undefined, "LBP"), { currency: "LBP", decimalDigits: 2 });
});

test("USD/LBP with an absent server precision still resolve (the formatter renders them by code)", () => {
  assert.deepEqual(resolveReceiptCurrency({ currency: "USD", decimal_digits: null }, "LBP"), {
    currency: "USD",
    decimalDigits: 2,
  });
});

test("AED/SAR use the server precision (2 decimals)", () => {
  assert.deepEqual(resolveReceiptCurrency({ currency: "AED", decimal_digits: 2 }, "USD"), {
    currency: "AED",
    decimalDigits: 2,
  });
  assert.deepEqual(resolveReceiptCurrency({ currency: "SAR", decimal_digits: 2 }, "USD"), {
    currency: "SAR",
    decimalDigits: 2,
  });
});

test("JOD/KWD use the server precision (3 decimals)", () => {
  assert.deepEqual(resolveReceiptCurrency({ currency: "JOD", decimal_digits: 3 }, "USD"), {
    currency: "JOD",
    decimalDigits: 3,
  });
  assert.deepEqual(resolveReceiptCurrency({ currency: "KWD", decimal_digits: 3 }, "USD"), {
    currency: "KWD",
    decimalDigits: 3,
  });
  // Lower-case / padded codes from the wire are normalised.
  assert.deepEqual(resolveReceiptCurrency({ currency: " jod ", decimal_digits: 3 }, "USD"), {
    currency: "JOD",
    decimalDigits: 3,
  });
});

// --- fail closed: a third currency must never silently become 2dp ------------

test("JOD with a MISSING decimal_digits is REFUSED (no 2dp default)", () => {
  assert.throws(() => resolveReceiptCurrency({ currency: "JOD", decimal_digits: null }, "USD"), ReceiptCurrencyError);
  assert.throws(() => resolveReceiptCurrency({ currency: "JOD", decimal_digits: undefined }, "USD"), ReceiptCurrencyError);
});

test("KWD with an INVALID decimal_digits is REFUSED", () => {
  assert.throws(() => resolveReceiptCurrency({ currency: "KWD", decimal_digits: "abc" }, "USD"), ReceiptCurrencyError);
  assert.throws(() => resolveReceiptCurrency({ currency: "KWD", decimal_digits: 2.5 }, "USD"), ReceiptCurrencyError); // non-integer
  assert.throws(() => resolveReceiptCurrency({ currency: "KWD", decimal_digits: -1 }, "USD"), ReceiptCurrencyError);
  assert.throws(() => resolveReceiptCurrency({ currency: "KWD", decimal_digits: 7 }, "USD"), ReceiptCurrencyError); // out of range
});

test("a malformed server currency is REFUSED, never coerced to USD", () => {
  assert.throws(() => resolveReceiptCurrency({ currency: "US", decimal_digits: 2 }, "USD"), ReceiptCurrencyError);
  assert.throws(() => resolveReceiptCurrency({ currency: "12", decimal_digits: 2 }, "USD"), ReceiptCurrencyError);
  assert.throws(() => resolveReceiptCurrency({ currency: "", decimal_digits: 2 }, "USD"), ReceiptCurrencyError);
  assert.throws(() => resolveReceiptCurrency({ currency: null, decimal_digits: 2 }, "USD"), ReceiptCurrencyError);
});

test("a real but non-catalog 3-letter currency renders at the server precision (server is authoritative)", () => {
  // finance_order_financials only ever returns a currency from the order snapshot; if it
  // supplies a valid precision, we honour it rather than inventing a client-side catalog.
  assert.deepEqual(resolveReceiptCurrency({ currency: "AED", decimal_digits: 3 }, "USD"), {
    currency: "AED",
    decimalDigits: 3,
  });
});
