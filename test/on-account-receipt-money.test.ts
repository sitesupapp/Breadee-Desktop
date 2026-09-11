// Customer Receivables / On Account — receipt money is EXACT and never zero.
//
// Production defect (Franks #260910-0005, an LBP order at rate 90,000; total
// 300,000 LBP, paid 200,000, balance 100,000): a partial on-account TAKEAWAY sale
// printed a receipt with the item at 300,000 but Subtotal/Total at 0, because
// `pos_complete_on_account` returns no operational subtotal/total and the builder
// computed total = subtotal(0) - discount(0) = 0. It also fed paid/balance from
// the USD figures (paid_usd/outstanding_usd), which print e.g. 2.22 / 1.11 on an
// LBP receipt.
//
// The builder now takes the SERVER's operational figures: `total` (delivery fee
// already folded in), `outstanding` (exact operational balance) and
// `delivery_fee`; paid now = total - outstanding. No USD round-trip, and a real
// order never prints a 0 grand total.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildOnAccountReceipt, buildPaymentReceipt, type OnAccountCompletionInput } from "@/lib/pos/paymentCompletion";
import type { CurrencyCode } from "@/lib/currency";

function onAccountInput(over: {
  result: OnAccountCompletionInput["result"];
  currency: CurrencyCode;
  lineTotal: number;
}): OnAccountCompletionInput {
  return {
    result: over.result,
    lines: [],
    receiptLines: [{ name: "French Fries", qty: 1, unitPrice: over.lineTotal, lineTotal: over.lineTotal }],
    existingOrder: false,
    fallbackOrderNumber: "FALLBACK",
    method: "cash",
    tenantName: "Franks",
    branchName: "Main Branch(Dahie)",
    operatorName: "Ali",
    primaryCurrency: over.currency,
    shiftId: "388b321a",
    at: "2026-09-10 22:31:01",
  };
}

// Case B — LBP partial on account: the exact reported case.
test("on-account receipt: LBP partial prints 300,000 / paid 200,000 / balance 100,000, never 0", () => {
  const r = buildOnAccountReceipt(
    onAccountInput({
      currency: "LBP",
      lineTotal: 300000,
      result: {
        payment_status: "partial",
        paid_usd: 2.2222, // USD accounting figure — must NOT reach the receipt
        outstanding_usd: 1.11,
        order_number: "260910-0005",
        subtotal: 300000,
        discount: 0,
        total: 300000,
        outstanding: 100000,
        delivery_fee: 0,
      },
    }),
  );
  assert.equal(r.subtotal, 300000);
  assert.equal(r.total, 300000);
  assert.notEqual(r.total, 0);
  assert.equal(r.paidAmount, 200000); // total - outstanding, NOT the USD 2.2222
  assert.equal(r.balanceDue, 100000); // NOT the USD 1.11
  assert.equal(r.paid, false);
  assert.equal(r.paymentStatus, "partial");
});

// Case C — full on account (nothing paid now).
test("on-account receipt: full on account still prints Total 300,000 with Paid 0 / Balance 300,000", () => {
  const r = buildOnAccountReceipt(
    onAccountInput({
      currency: "LBP",
      lineTotal: 300000,
      result: {
        payment_status: "unpaid",
        paid_usd: 0,
        outstanding_usd: 3.3333,
        order_number: "260910-0006",
        subtotal: 300000,
        discount: 0,
        total: 300000,
        outstanding: 300000,
        delivery_fee: 0,
      },
    }),
  );
  assert.equal(r.total, 300000);
  assert.equal(r.paidAmount, 0);
  assert.equal(r.balanceDue, 300000);
  assert.equal(r.paymentStatus, "unpaid");
});

// Case E — delivery fee + partial on account: fee once, folded into total.
test("on-account receipt: delivery fee is included once and folded into total", () => {
  const r = buildOnAccountReceipt(
    onAccountInput({
      currency: "LBP",
      lineTotal: 300000,
      result: {
        payment_status: "partial",
        paid_usd: 2.2222,
        outstanding_usd: 1.67,
        order_number: "260910-0007",
        subtotal: 300000, // items only
        discount: 0,
        total: 350000, // items + 50,000 delivery fee (server folds it in)
        outstanding: 150000,
        delivery_fee: 50000,
      },
    }),
  );
  assert.equal(r.subtotal, 300000);
  assert.equal(r.deliveryFee, 50000);
  assert.equal(r.total, 350000);
  // Subtotal + fee - discount reconciles to Total (fee counted exactly once).
  assert.equal(r.subtotal + (r.deliveryFee ?? 0) - r.discount, r.total);
  assert.equal(r.paidAmount, 200000); // 350,000 - 150,000
  assert.equal(r.balanceDue, 150000);
});

// Phase 11 — a USD order stays exact, no LBP-specific distortion.
test("on-account receipt: USD order stays exact (10 / 6 / 4)", () => {
  const r = buildOnAccountReceipt(
    onAccountInput({
      currency: "USD",
      lineTotal: 10,
      result: {
        payment_status: "partial",
        paid_usd: 6,
        outstanding_usd: 4,
        order_number: "USD-0001",
        subtotal: 10,
        discount: 0,
        total: 10,
        outstanding: 4,
        delivery_fee: 0,
      },
    }),
  );
  assert.equal(r.total, 10);
  assert.equal(r.paidAmount, 6);
  assert.equal(r.balanceDue, 4);
  assert.equal(r.deliveryFee, null);
});

// Case D — a normal fully-paid receipt is untouched.
test("full-pay receipt is unchanged: total from the server amount, marked paid", () => {
  const r = buildPaymentReceipt({
    result: {
      order_number: "260901-0001",
      method: "cash",
      amount: 720000,
      subtotal: 720000,
      discount: 0,
      exchange_rate: 90000,
    } as never,
    lines: [],
    receiptLines: [{ name: "Frank's Fries Chicken", qty: 1, unitPrice: 720000, lineTotal: 720000 }],
    existingOrder: false,
    fallbackOrderNumber: "FALLBACK",
    tenantName: "Franks",
    branchName: "Main Branch(Dahie)",
    operatorName: "Ali",
    primaryCurrency: "LBP",
    tenderCurrency: "LBP",
    rate: 90000,
    tenderedInput: 720000,
    shiftId: "388b321a",
    at: "2026-09-01 07:25:44",
  });
  assert.equal(r.paid, true);
  assert.equal(r.total, 720000);
  assert.equal(r.paymentStatus, undefined);
});
