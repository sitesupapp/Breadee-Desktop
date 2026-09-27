// READY POS Phase C — desktop End Shift dynamic payment breakdown.
// The DB helper _pos_shift_payment_breakdown is proven server-side; these tests
// lock the desktop display normalizer and the printed PAYMENTS block.

import { test } from "node:test";
import assert from "node:assert/strict";

import { paymentSummary } from "@/lib/pos/paymentBreakdown";
import { buildShiftReportLines } from "@/lib/pos/shiftReport";

test("paymentSummary: cash-only (dynamic)", () => {
  const s = paymentSummary({ payment_methods: [{ key: "cash", label: "Cash", is_cash: true, amount: 98.35 }], cash_total: 98.35, non_cash_total: 0, grand_payment_total: 98.35 });
  assert.equal(s.dynamic, true);
  assert.equal(s.rows.length, 1);
  assert.equal(s.cashTotal, 98.35);
  assert.equal(s.nonCashTotal, 0);
  assert.equal(s.grandTotal, 98.35);
});

test("paymentSummary: cash + card + renamed whish; totals from server; label passthrough", () => {
  const s = paymentSummary({
    payment_methods: [
      { key: "cash", label: "Cash", is_cash: true, amount: 98.35 },
      { key: "card", label: "Card", is_cash: false, amount: 2 },
      { key: "whish_qa_test", label: "Whish QA Renamed", is_cash: false, amount: 2 },
    ],
    cash_total: 98.35, non_cash_total: 4, grand_payment_total: 102.35,
  });
  assert.equal(s.cashTotal, 98.35);
  assert.equal(s.nonCashTotal, 4);
  assert.equal(s.grandTotal, 102.35);
  assert.equal(s.rows.find((r) => r.key === "whish_qa_test")?.label, "Whish QA Renamed");
});

test("paymentSummary: server order preserved; grand == cash + non_cash when totals omitted", () => {
  const s = paymentSummary({ payment_methods: [
    { key: "cash", label: "Cash", is_cash: true, amount: 10 },
    { key: "omt", label: "OMT", is_cash: false, amount: 3 },
    { key: "card", label: "Card", is_cash: false, amount: 5 },
  ] });
  assert.deepEqual(s.rows.map((r) => r.key), ["cash", "omt", "card"]);
  assert.equal(s.cashTotal, 10);
  assert.equal(s.nonCashTotal, 8);
  assert.equal(s.grandTotal, 18);
});

test("paymentSummary: unknown custom method falls back to key as label", () => {
  const s = paymentSummary({ payment_methods: [{ key: "store_credit_x", label: "store_credit_x", is_cash: false, amount: 7 }] });
  assert.equal(s.rows[0].label, "store_credit_x");
  assert.equal(s.rows[0].is_cash, false);
});

test("paymentSummary: refunds are pre-netted server-side; passed through, not re-netted", () => {
  const s = paymentSummary({ payment_methods: [{ key: "cash", label: "Cash", is_cash: true, amount: 20 }, { key: "card", label: "Card", is_cash: false, amount: 7 }], cash_total: 20, non_cash_total: 7, grand_payment_total: 27 });
  assert.equal(s.rows.find((r) => r.key === "card")?.amount, 7);
  assert.equal(s.grandTotal, 27);
});

test("paymentSummary: legacy fallback for pre-Phase-C report_json", () => {
  const s = paymentSummary({ payments: { cash: 289, card: 11 } });
  assert.equal(s.dynamic, false);
  assert.equal(s.cashTotal, 289);
  assert.equal(s.nonCashTotal, 11);
  assert.equal(s.grandTotal, 300);
  assert.equal(s.rows.find((r) => r.key === "cash")?.is_cash, true);
  assert.equal(s.rows.find((r) => r.key === "card")?.is_cash, false);
});

test("paymentSummary: empty / missing payload never throws", () => {
  assert.equal(paymentSummary(null).rows.length, 0);
  assert.equal(paymentSummary(undefined).grandTotal, 0);
  assert.equal(paymentSummary({}).rows.length, 0);
  assert.equal(paymentSummary({ payment_methods: [] }).rows.length, 0);
});

// --- printed report lines --------------------------------------------------

const baseInput = {
  businessName: "Franks", branchName: "Main", staffName: "QA", shiftRef: "5148a99e",
  openedAt: "x", closedAt: "y",
  currency: "USD" as const,
  money: { orders: 3, grossSales: 100, discounts: 0, netSales: 100, cashSales: 98.35, cashUsd: 0.75, cashLbpOriginal: 8783760, openingCash: 0, expectedCash: 98.35, actualCash: 98.35, difference: 0 },
  detail: { routes: [], reversals: { voided: 0, cancelled: 0, refunded: 0, amount: 0 }, items: [], successfulOrders: 3, successfulTotal: 100, currency: "USD" as const },
  note: null,
  fmt: (n: number, c: string) => `${c} ${n.toFixed(2)}`,
};

test("buildShiftReportLines: renders each tender + Total non-cash + Total payments", () => {
  const lines = buildShiftReportLines({
    ...baseInput,
    payments: {
      rows: [
        { label: "Cash", is_cash: true, amount: 98.35 },
        { label: "Card", is_cash: false, amount: 2 },
        { label: "Whish QA Renamed", is_cash: false, amount: 2 },
      ],
      nonCashTotal: 4, grandTotal: 102.35,
    },
  });
  const labels = lines.map((l) => l.label);
  assert.ok(labels.includes("Cash"));
  assert.ok(labels.includes("Card (non-cash)"));
  assert.ok(labels.includes("Whish QA Renamed (non-cash)"));
  assert.ok(labels.includes("Total non-cash"));
  assert.ok(labels.includes("Total payments"));
  // separate DRAWER block still present and distinct from PAYMENTS
  assert.ok(labels.some((l) => l.startsWith("DRAWER")));
  assert.ok(labels.includes("Expected"));
});

test("buildShiftReportLines: pre-Phase-C fallback keeps the cash-only PAYMENTS view", () => {
  const lines = buildShiftReportLines({ ...baseInput, payments: null });
  const labels = lines.map((l) => l.label);
  assert.ok(labels.includes("Cash sales"));
  assert.ok(!labels.includes("Total payments"));
});
