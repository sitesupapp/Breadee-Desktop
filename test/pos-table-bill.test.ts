// The server-owned table bill.
//
// The bill belongs to the SERVER. These cases pin the two refusals the desktop
// must inherit rather than paper over:
//   * mixed currency - the server will not add raw USD to raw LBP (m214), so the
//     folded bill has no total at all; showing a confident number would be a lie,
//   * split shift   - pos_pay_table refuses a bill straddling shifts, so the
//     panel must be able to say so before the cashier reaches payment.
// Rounds are grouped by the SERVER's batch_no (m218), never by a client guess.

import { test } from "node:test";
import assert from "node:assert/strict";

import { billItemCount, foldBill, linesByBatch } from "@/lib/pos/tableBill";
import { EMPTY_BILL, type BillLine, type BillOrder } from "@/types/tables";

const line = (over: Partial<BillLine> = {}): BillLine => ({
  id: "l1",
  name: "Chicken Sandwich",
  quantity: 1,
  base_price: 5,
  modifiers_total: 0,
  final_unit_price: 5,
  line_total: 5,
  kitchen_note: null,
  batch_no: 1,
  modifiers: [],
  ...over,
});

const order = (over: Partial<BillOrder> = {}): BillOrder => ({
  id: "o1",
  order_number: "A-14",
  status: "sent_to_kitchen",
  payment_status: "unpaid",
  shift_id: "shift-1",
  branch_id: "branch-1",
  tenant_id: "tenant-1",
  subtotal: 10,
  discount_amount: 0,
  total_amount: 10,
  currency: "USD",
  exchange_rate: null,
  created_at: "2026-01-01T10:00:00.000Z",
  lines: [line()],
  ...over,
});

test("an empty bill carries no total at all, rather than a confident zero", () => {
  const bill = foldBill("t1", []);
  assert.deepEqual(bill, EMPTY_BILL("t1"));
  assert.equal(bill.total, null);
  assert.equal(bill.subtotal, null);
  assert.equal(bill.currency, null);
});

test("a single-currency bill sums the server's own order totals", () => {
  const bill = foldBill("t1", [order({ subtotal: 10, total_amount: 12 }), order({ id: "o2", subtotal: 5, total_amount: 6 })]);
  assert.equal(bill.subtotal, 15);
  assert.equal(bill.total, 18);
  assert.equal(bill.currency, "USD");
  assert.equal(bill.mixedCurrency, false);
});

test("a mixed-currency bill has NO total - the desktop inherits the server's refusal", () => {
  const bill = foldBill("t1", [order({ currency: "USD" }), order({ id: "o2", currency: "LBP", total_amount: 900_000 })]);
  assert.equal(bill.mixedCurrency, true);
  assert.equal(bill.total, null);
  assert.equal(bill.subtotal, null);
  assert.equal(bill.currency, null, "no single currency can label a mixed bill");
});

test("a bill spanning two shifts is flagged, because pos_pay_table would refuse it", () => {
  const bill = foldBill("t1", [order({ shift_id: "shift-1" }), order({ id: "o2", shift_id: "shift-2" })]);
  assert.equal(bill.splitShift, true);
  // The total still sums: the currency is consistent, only settlement is blocked.
  assert.equal(bill.total, 20);
});

test("one shift across several orders is not a split shift", () => {
  const bill = foldBill("t1", [order(), order({ id: "o2" })]);
  assert.equal(bill.splitShift, false);
});

test("orders with no shift are still consistent with each other", () => {
  const bill = foldBill("t1", [order({ shift_id: null }), order({ id: "o2", shift_id: null })]);
  assert.equal(bill.splitShift, false);
});

test("batches come from the server's batch_no, ascending and deduplicated", () => {
  const bill = foldBill("t1", [
    order({ lines: [line({ id: "a", batch_no: 2 }), line({ id: "b", batch_no: 1 }), line({ id: "c", batch_no: 2 })] }),
  ]);
  assert.deepEqual(bill.batches, [1, 2]);
});

test("rounds are grouped by the server's batch number, not by insertion order", () => {
  const bill = foldBill("t1", [
    order({
      lines: [
        line({ id: "a", batch_no: 3, name: "Coffee" }),
        line({ id: "b", batch_no: 1, name: "Soup" }),
        line({ id: "c", batch_no: 3, name: "Tea" }),
      ],
    }),
  ]);
  const grouped = linesByBatch(bill);
  assert.deepEqual(grouped.map((g) => g.batch), [1, 3]);
  assert.deepEqual(grouped[0].lines.map((l) => l.name), ["Soup"]);
  assert.deepEqual(grouped[1].lines.map((l) => l.name), ["Coffee", "Tea"]);
});

test("rounds spanning several orders merge into one round, as m218 intends", () => {
  const bill = foldBill("t1", [
    order({ lines: [line({ id: "a", batch_no: 1 })] }),
    order({ id: "o2", lines: [line({ id: "b", batch_no: 1 })] }),
  ]);
  const grouped = linesByBatch(bill);
  assert.equal(grouped.length, 1);
  assert.deepEqual(grouped[0].lines.map((l) => l.id), ["a", "b"]);
});

test("the item count counts QUANTITIES, not lines", () => {
  const bill = foldBill("t1", [order({ lines: [line({ id: "a", quantity: 3 }), line({ id: "b", quantity: 2 })] })]);
  assert.equal(billItemCount(bill), 5);
  assert.equal(billItemCount(foldBill("t1", [])), 0);
});

test("an empty bill has no rounds to group", () => {
  assert.deepEqual(linesByBatch(foldBill("t1", [])), []);
});
