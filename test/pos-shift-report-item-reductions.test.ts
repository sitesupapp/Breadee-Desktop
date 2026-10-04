// W2 / Part 1 — the End-Shift "Items reduced / removed" section (desktop render).
//
// Pins: the snake_case->typed mapper (tolerant of absence/bad data), and that
// buildShiftReportLines renders a DISTINCT section (never merged with REVERSED
// orders), only when the server supplied it AND something was reduced.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildShiftReportLines,
  itemReductionsFromReport,
  type ShiftReportDetail,
} from "@/lib/pos/shiftReport";
import type { CurrencyCode } from "@/lib/currency";

const fmt = (n: number, c: CurrencyCode) => `${n} ${c}`;
const emptyDetail: ShiftReportDetail = {
  routes: [],
  reversals: { voided: 0, cancelled: 0, refunded: 0, amount: 0 },
  items: [],
  successfulOrders: 0,
  successfulTotal: 0,
  currency: "USD",
};
const baseMoney = {
  orders: 1, grossSales: 10, discounts: 0, netSales: 10, cashSales: 10, cashUsd: 10,
  cashLbpOriginal: 0, openingCash: 0, expectedCash: 10, actualCash: 10, difference: 0,
};
function lines(itemReductions: Parameters<typeof buildShiftReportLines>[0]["itemReductions"]) {
  return buildShiftReportLines({
    businessName: "B", branchName: "Main", staffName: "Sam", shiftRef: "abc",
    openedAt: "x", closedAt: "y", currency: "USD" as CurrencyCode,
    money: baseMoney, detail: emptyDetail, payments: null, itemReductions, note: null, fmt,
  }).map((l) => `${l.label}${l.value != null ? "=" + l.value : ""}`);
}

test("the mapper reads snake_case and tolerates absence / bad data", () => {
  assert.equal(itemReductionsFromReport(null), null);
  assert.equal(itemReductionsFromReport("nope"), null);
  const m = itemReductionsFromReport({
    removal_events_count: 2, reduction_events_count: 1, total_removed_quantity: 3,
    removed_value_known_subtotal: 150, value_unavailable_count: 1, currency: "USD",
  });
  assert.deepEqual(m, {
    removalEventsCount: 2, reductionEventsCount: 1, totalRemovedQuantity: 3,
    removedValueKnownSubtotal: 150, valueUnavailableCount: 1, currency: "USD",
  });
  // Non-numeric / missing fields coerce to 0, currency falls back to null.
  const bad = itemReductionsFromReport({ removal_events_count: "x", currency: 7 });
  assert.equal(bad?.removalEventsCount, 0);
  assert.equal(bad?.currency, null);
});

test("the section renders ONLY when present and something was reduced", () => {
  assert.equal(lines(null).some((l) => l.includes("ITEMS REDUCED")), false, "absent => no section");
  assert.equal(
    lines(itemReductionsFromReport({ removal_events_count: 0, reduction_events_count: 0 })).some((l) => l.includes("ITEMS REDUCED")),
    false, "zero events => no section",
  );
  const out = lines(itemReductionsFromReport({
    removal_events_count: 2, reduction_events_count: 1, total_removed_quantity: 3,
    removed_value_known_subtotal: 150, value_unavailable_count: 0, currency: "USD",
  }));
  assert.ok(out.includes("ITEMS REDUCED / REMOVED"));
  assert.ok(out.includes("Items removed=2"));
  assert.ok(out.includes("Items reduced=1"));
  assert.ok(out.includes("Quantity removed=3"));
  assert.ok(out.includes("Value removed=150 USD"));
});

test("unpriced events are surfaced, not hidden; section stays separate from REVERSED", () => {
  const out = lines(itemReductionsFromReport({
    removal_events_count: 1, reduction_events_count: 0, total_removed_quantity: 1,
    removed_value_known_subtotal: 0, value_unavailable_count: 2, currency: "USD",
  }));
  assert.ok(out.some((l) => l.startsWith("Value removed (2 unpriced)=")));
  // REVERSED (orders) and ITEMS REDUCED (lines) are both present and distinct.
  assert.ok(out.includes("REVERSED"));
  assert.ok(out.includes("ITEMS REDUCED / REMOVED"));
  assert.notEqual(out.indexOf("REVERSED"), out.indexOf("ITEMS REDUCED / REMOVED"));
});
