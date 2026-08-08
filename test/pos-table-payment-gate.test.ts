// The payment gate, and the authoritative re-read that runs behind it.
//
// TWO IDEAS, and they are separate on purpose:
//
//   The GATE answers "may this operator start a payment for this table, right
//   now?" - permission, shift, connection, an unpaid bill, one currency, one
//   shift, one branch, nothing already in flight. It is computed ONCE and every
//   Pay surface renders from that single result.
//
//   The RE-READ answers "is the amount on screen still the amount the server
//   will charge?" It runs immediately before the submit, because a gate that
//   passed thirty seconds ago says nothing about a bill another terminal has
//   since added a round to.
//
// A gate alone would let a stale total be charged. A re-read alone would let an
// unpermitted cashier reach the server. Both are required, and the order matters.

import { test } from "node:test";
import assert from "node:assert/strict";

import { billChangedSincePreview, payTableGate } from "@/lib/pos/tablePayment";
import type { BillOrder, TableBill, TableSummary } from "@/types/tables";
import type { Gate } from "@/components/ui";

const allow: Gate = { allowed: true, reason: null };
const noPay: Gate = { allowed: false, reason: "You do not have permission to take payments." };

const order = (over: Partial<BillOrder> = {}): BillOrder => ({
  id: "o1",
  order_number: "A-14",
  status: "sent_to_kitchen",
  payment_status: "unpaid",
  shift_id: "s1",
  branch_id: "b1",
  tenant_id: "t1",
  subtotal: 40,
  discount_amount: 0,
  total_amount: 40,
  currency: "USD",
  exchange_rate: null,
  created_at: "2026-08-07T10:00:00Z",
  lines: [],
  ...over,
});

const bill = (over: Partial<TableBill> = {}): TableBill => ({
  tableId: "tbl1",
  orders: [order()],
  subtotal: 40,
  total: 40,
  currency: "USD",
  mixedCurrency: false,
  splitShift: false,
  batches: [1],
  ...over,
});

const table = (over: Partial<TableSummary> = {}): TableSummary => ({
  id: "tbl1",
  name: "Table 5",
  seats: 4,
  occupied: true,
  status: "occupied",
  canonical: true,
  configured: true,
  sort_order: 5,
  orders: 1,
  order_number: "A-14",
  opened_at: null,
  total: 40,
  currency: "USD",
  mixed_currency: false,
  ...over,
});

/** The everything-is-fine baseline. Each test spoils exactly one thing. */
const ok = () => ({
  takePayments: allow,
  table: table(),
  bill: bill(),
  hasOpenShift: true,
  online: true,
  settling: false,
  branchId: "b1",
});

// --- the gate ----------------------------------------------------------------

test("the baseline is allowed - otherwise every refusal test below is vacuous", () => {
  assert.deepEqual(payTableGate(ok()), { allowed: true, reason: null });
});

test("payment permission is required, and its own wording is kept", () => {
  const g = payTableGate({ ...ok(), takePayments: noPay });
  assert.equal(g.allowed, false);
  assert.equal(g.reason, noPay.reason, "the permission map's reason was replaced");
});

test("a table must be selected", () => {
  const g = payTableGate({ ...ok(), table: null });
  assert.equal(g.allowed, false);
  assert.match(g.reason!, /select a table/i);
});

test("payment is online-only - there is no queue and no deferral", () => {
  const g = payTableGate({ ...ok(), online: false });
  assert.equal(g.allowed, false);
  assert.match(g.reason!, /connection/i);
});

test("an open shift is required", () => {
  const g = payTableGate({ ...ok(), hasOpenShift: false });
  assert.equal(g.allowed, false);
  assert.match(g.reason!, /open a shift/i);
});

test("there must be a bill to settle", () => {
  for (const b of [null, bill({ orders: [] })]) {
    const g = payTableGate({ ...ok(), bill: b });
    assert.equal(g.allowed, false);
    assert.match(g.reason!, /no open bill/i);
  }
});

test("an already-paid bill cannot be paid again", () => {
  const g = payTableGate({ ...ok(), bill: bill({ orders: [order({ payment_status: "paid" })] }) });
  assert.equal(g.allowed, false);
  assert.match(g.reason!, /already settled/i);
});

test("the bill on screen must belong to the table on screen", () => {
  const g = payTableGate({ ...ok(), bill: bill({ tableId: "someone-else" }) });
  assert.equal(g.allowed, false);
  assert.match(g.reason!, /not this table's/i);
});

test("a mixed-currency bill is refused, because the server refuses to sum it", () => {
  const g = payTableGate({ ...ok(), bill: bill({ mixedCurrency: true, total: null, currency: null }) });
  assert.equal(g.allowed, false);
  assert.match(g.reason!, /different currency settings/i);
});

test("a split-shift bill is refused", () => {
  const g = payTableGate({ ...ok(), bill: bill({ splitShift: true }) });
  assert.equal(g.allowed, false);
  assert.match(g.reason!, /multiple shifts/i);
});

test("a bill from another branch is refused, and says so", () => {
  const g = payTableGate({ ...ok(), bill: bill({ orders: [order({ branch_id: "other-branch" })] }) });
  assert.equal(g.allowed, false);
  assert.match(g.reason!, /another branch/i);
});

test("a payment already in flight closes every Pay surface at once", () => {
  const g = payTableGate({ ...ok(), settling: true });
  assert.equal(g.allowed, false);
  assert.match(g.reason!, /already being sent/i);
});

test("discount permission is NOT required to settle a bill at full price", () => {
  // The gate takes no discount permission at all - a cashier who cannot discount
  // can still take the money, which is the common case and must not be blocked.
  const g = payTableGate(ok());
  assert.equal(g.allowed, true);
  assert.equal(Object.keys(ok()).some((k) => /discount/i.test(k)), false, "the gate grew a discount input");
});

test("refusals are ordered the way the server would refuse", () => {
  // Permission before state: a cashier without the permission is told that,
  // not "no open bill", which would send them hunting for the wrong problem.
  const g = payTableGate({ ...ok(), takePayments: noPay, bill: null, hasOpenShift: false, online: false });
  assert.equal(g.reason, noPay.reason);
});

// --- the authoritative re-read ----------------------------------------------

test("an unchanged bill allows the payment to proceed", () => {
  assert.equal(billChangedSincePreview(bill(), bill(), table()), null);
});

test("a changed total stops the payment and names both figures", () => {
  const changed = billChangedSincePreview(bill(), bill({ total: 55 }), table());
  assert.ok(changed);
  assert.match(changed!, /total changed from 40 to 55/);
});

test("a changed order set stops the payment", () => {
  const fresh = bill({ orders: [order(), order({ id: "o2", order_number: "A-15" })] });
  const changed = billChangedSincePreview(bill(), fresh, table());
  assert.match(changed!, /orders on this table changed/);
});

test("a bill that disappeared stops the payment", () => {
  for (const gone of [null, bill({ orders: [] })]) {
    const changed = billChangedSincePreview(bill(), gone, table());
    assert.match(changed!, /the bill is gone/i);
  }
});

test("a table that is already free stops the payment", () => {
  // The table map has been refreshed and the selection is gone.
  const changed = billChangedSincePreview(bill(), bill(), null);
  assert.match(changed!, /table selection was lost/i);
});

test("a bill that moved to another table stops the payment", () => {
  const changed = billChangedSincePreview(bill(), bill({ tableId: "tbl9" }), table());
  assert.match(changed!, /selected table changed/i);
});

test("a currency change stops the payment", () => {
  const changed = billChangedSincePreview(bill(), bill({ currency: "LBP" }), table());
  assert.match(changed!, /currency changed/i);
});

test("a bill that became mixed-currency or split-shift stops the payment", () => {
  assert.match(billChangedSincePreview(bill(), bill({ mixedCurrency: true }), table())!, /more than one currency/i);
  assert.match(billChangedSincePreview(bill(), bill({ splitShift: true }), table())!, /more than one shift/i);
});

test("a bill whose shift moved stops the payment", () => {
  const fresh = bill({ orders: [order({ shift_id: "s2" })] });
  assert.match(billChangedSincePreview(bill(), fresh, table())!, /shift this bill belongs to changed/i);
});

test("a bill settled by someone else in the meantime stops the payment", () => {
  const fresh = bill({ orders: [order({ payment_status: "paid" })] });
  assert.match(billChangedSincePreview(bill(), fresh, table())!, /already been settled/i);
});

test("a bill that was never loaded is not payable", () => {
  assert.match(billChangedSincePreview(null, bill(), table())!, /not loaded/i);
});
