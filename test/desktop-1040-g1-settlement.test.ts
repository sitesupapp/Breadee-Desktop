// Desktop 1.0.40 — G1 settlement: BUG 01 (part-paid bill shows / prints / charges what is still due),
// BUG 06 (Pay Full Bill of a part-paid bill pinned T while production charges R = T − P →
// PAY_AMOUNT_CHANGED shown as "changed on another terminal"), BUG 02 (partial_line merge refusal names
// the remedy) and the guest-level split receipt.
//
// Production `pos_table_map` reports no `collected` (staging does). The desktop now derives it from the
// PAID `pos_split_settlements` (+ allocations) it may read under tenant RLS. The fakes below model the
// production `pos_pay_table_core`: it charges R = T − P and refuses a pin ≠ R with PAY_AMOUNT_CHANGED.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  applyPaidSettlements,
  billCollected,
  billDue,
  billItemCount,
  findPartlyPaidLine,
  foldBill,
  partlyPaidLine,
  unpaidBillView,
  unpaidQuantity,
} from "@/lib/pos/tableBill";
import {
  BillChangedElsewhereError,
  PART_PAID_FULL_PAY_MESSAGE,
  PART_PAID_UNKNOWN_MESSAGE,
  PartPaidUnknownError,
  billIsPartPaid,
  collectedUnknown,
  effectiveCollected,
  payTableGate,
  performTablePayment,
  setServerDeductsPriorPayments,
  settleAmountDue,
  tableSettlePins,
  type TablePaymentPayload,
  type TablePaymentResult,
} from "@/lib/pos/tablePayment";
import { completeTableOnAccount, type TableOnAccountPayload } from "@/lib/pos/onAccount";
import { billIsCleared, buildSplitSettlementReceipt, buildTableBillReceipt } from "@/lib/pos/tablePaymentCompletion";
import { MERGE_REASON_HINTS, MergePartialLineError, classifyError, mergePartialLineMessage } from "@/lib/pos/errors";
import { PosRpcError } from "@/lib/pos/rpc";
import type { BillLine, BillOrder, TableBill, TableSummary } from "@/types/tables";
import type { CurrencyCode } from "@/lib/currency";

afterEach(() => setServerDeductsPriorPayments(null));

// --- fixtures ----------------------------------------------------------------

const line = (id: string, name: string, quantity: number, unit: number, batch = 1): BillLine => ({
  id,
  menu_item_id: null,
  name,
  quantity,
  base_price: unit,
  modifiers_total: 0,
  final_unit_price: unit,
  line_total: Math.round(unit * quantity * 100) / 100,
  kitchen_note: null,
  batch_no: batch,
  modifiers: [],
});

const order = (id: string, lines: BillLine[], currency: CurrencyCode = "USD", over: Partial<BillOrder> = {}): BillOrder => {
  const total = Math.round(lines.reduce((s, l) => s + l.line_total, 0) * 100) / 100;
  return {
    id,
    order_number: "1042",
    status: "sent_to_kitchen",
    // Production: an open part-paid order stays payment_status 'unpaid' (verified read-only).
    payment_status: "unpaid",
    pos_entity_version: 3,
    shift_id: "s1",
    branch_id: "b1",
    tenant_id: "t1",
    subtotal: total,
    discount_amount: 0,
    total_amount: total,
    currency,
    exchange_rate: currency === "LBP" ? 89500 : null,
    created_at: "2026-11-05T10:00:00Z",
    lines,
    ...over,
  };
};

/** A production map row: NO collected / outstanding. */
const prodTable = (total: number, currency: CurrencyCode = "USD", over: Partial<TableSummary> = {}): TableSummary => ({
  id: "tbl-l41",
  name: "l4/1",
  seats: 4,
  occupied: true,
  status: "occupied",
  canonical: true,
  configured: true,
  sort_order: 1,
  orders: 1,
  order_number: "1042",
  opened_at: null,
  total,
  collected: null,
  outstanding: null,
  currency,
  mixed_currency: false,
  pos_entity_version: 7,
  ...over,
});

const settlementRow = (id: string, orderId: string, splitNo: number, amount: number, allocs: [string, number, number][], status = "paid") => ({
  id,
  parent_order_id: orderId,
  split_no: splitNo,
  status,
  amount_order_ccy: amount,
  payment_method: "cash",
  currency_code: "USD",
  paid_at: "2026-11-05T10:30:00Z",
  payment_id: `pay-${id}`,
  pos_split_allocations: allocs.map(([order_item_id, allocated_quantity, allocated_amount_order_ccy]) => ({
    order_item_id,
    allocated_quantity,
    allocated_amount_order_ccy,
  })),
});

/** The production l4/1 case: total 22, one guest already paid a 5.00 burger by split. */
function l41Bill(): TableBill {
  const o = order("o1", [line("i-burger", "Burger", 1, 5), line("i-pizza", "Pizza", 1, 12), line("i-cola", "Cola", 2, 2.5)]);
  return applyPaidSettlements(foldBill("tbl-l41", [o]), { ok: true, rows: [settlementRow("s1", "o1", 1, 5, [["i-burger", 1, 5]])] });
}

const okResult = (amount: number, ccy: CurrencyCode = "USD"): TablePaymentResult => ({
  ok: true,
  orders: 1,
  subtotal: amount,
  discount: 0,
  amount,
  currency_code: ccy,
  original_amount: amount,
  exchange_rate: null,
});

/** The PRODUCTION pos_pay_table_core: charges R = T − P and refuses a pin that is not R. */
function prodPayServer(T: number, P: number) {
  const calls: TablePaymentPayload[] = [];
  return {
    calls,
    submit: async (p: TablePaymentPayload): Promise<TablePaymentResult> => {
      calls.push(p);
      const R = Math.round((T - P) * 100) / 100;
      if (p.expected_amount != null && Math.abs(p.expected_amount - R) >= 0.005) {
        throw new PosRpcError("pos_pay_table", "The amount due on this table changed since the payment was captured.", {
          status: 400,
          code: "P0001",
          details: JSON.stringify({ pos_error_code: "PAY_AMOUNT_CHANGED" }),
        });
      }
      return okResult(R);
    },
  };
}

// --- BUG 01: the settlement read folded into the bill -------------------------

test("settlement read: paid quantities, per-order and bill collected, settlements numbered <order>-<split>", () => {
  const bill = l41Bill();
  assert.equal(bill.collectedKnown, true);
  assert.equal(bill.collected, 5);
  assert.equal(bill.orders[0].collected, 5);
  assert.equal(bill.total, 22, "total stays the server's gross T");
  assert.equal(bill.orders[0].lines.find((l) => l.id === "i-burger")?.paid_quantity, 1);
  assert.equal(bill.orders[0].lines.find((l) => l.id === "i-pizza")?.paid_quantity, undefined);
  assert.equal(bill.settlements?.length, 1);
  assert.equal(bill.settlements?.[0].display_no, "1042-1");
  assert.deepEqual(bill.settlements?.[0].allocations, [{ order_item_id: "i-burger", quantity: 1, amount: 5 }]);
  assert.equal(billCollected(bill), 5);
  assert.equal(billDue(bill), 17);
});

test("settlement read: rows of another order or not PAID are ignored; mixed currency → collected null", () => {
  const o = order("o1", [line("a", "A", 2, 4)]);
  const bill = applyPaidSettlements(foldBill("t", [o]), {
    ok: true,
    rows: [
      settlementRow("s1", "o1", 1, 4, [["a", 1, 4]]),
      settlementRow("s2", "o-other", 1, 9, [["x", 1, 9]]),
      settlementRow("s3", "o1", 2, 4, [["a", 1, 4]], "void"),
    ],
  });
  assert.equal(bill.collected, 4);
  assert.equal(bill.orders[0].lines[0].paid_quantity, 1);
  const mixed = applyPaidSettlements(foldBill("t", [order("o1", [line("a", "A", 1, 4)]), order("o2", [line("b", "B", 1, 90000)], "LBP")]), {
    ok: true,
    rows: [settlementRow("s1", "o1", 1, 4, [["a", 1, 4]])],
  });
  assert.equal(mixed.collected, null);
  assert.equal(billCollected(mixed), 0);
});

test("settlement read FAILURE never fails the bill: collected unknown, lines and totals untouched", () => {
  const base = foldBill("t", [order("o1", [line("a", "A", 2, 4)])]);
  const bill = applyPaidSettlements(base, { ok: false });
  assert.equal(bill.collectedKnown, false);
  assert.equal(bill.collected, null);
  assert.deepEqual(bill.orders, base.orders);
  assert.equal(bill.total, 8);
  assert.equal(billCollected(bill), 0);
  assert.equal(billDue(bill), 8);
});

test("panel view: fully paid lines hidden, part-paid lines at their unpaid quantity; nothing paid → identical", () => {
  const o = order("o1", [line("a", "Burger", 1, 5), line("b", "Cola", 3, 2), line("c", "Fries", 1, 3, 2)]);
  const bill = applyPaidSettlements(foldBill("t", [o]), { ok: true, rows: [settlementRow("s1", "o1", 1, 9, [["a", 1, 5], ["b", 2, 4]])] });
  const view = unpaidBillView(bill);
  const lines = view.orders[0].lines;
  assert.deepEqual(lines.map((l) => [l.name, l.quantity, l.line_total]), [["Cola", 1, 2], ["Fries", 1, 3]]);
  assert.equal(billItemCount(view), 2);
  assert.equal(unpaidQuantity(bill.orders[0].lines[1]), 1);
  assert.equal(billDue(bill), 5);
  const plain = foldBill("t", [order("o1", [line("a", "Burger", 1, 5)])]);
  assert.equal(unpaidBillView(plain), plain, "no paid quantity → the very same bill object");
  assert.equal(unpaidBillView(applyPaidSettlements(plain, { ok: true, rows: [] })).orders[0].lines.length, 1);
});

test("the last split settles the whole bill: nothing left to show, due 0; the server's paid order leaves an empty bill and a free table", () => {
  const o = order("o1", [line("a", "Burger", 1, 5), line("b", "Cola", 2, 2)]);
  const bill = applyPaidSettlements(foldBill("t", [o]), {
    ok: true,
    rows: [settlementRow("s1", "o1", 1, 5, [["a", 1, 5]]), settlementRow("s2", "o1", 2, 4, [["b", 2, 4]])],
  });
  assert.equal(unpaidBillView(bill).orders[0].lines.length, 0);
  assert.equal(billDue(bill), 0);
  // pos_split_settle completes the parent (payment_status paid) → loadTableBill reads no open order.
  const after = foldBill("t", []);
  assert.equal(after.orders.length, 0);
  assert.equal(billIsCleared(after, prodTable(0, "USD", { orders: 0, occupied: false, status: "available", total: null })), true);
});

// --- BUG 06: the pin is R ------------------------------------------------------

test("BUG 06 l4/1: production map (collected null) + bill settlement read → pin 17 (= 22 − 5), not 22", () => {
  setServerDeductsPriorPayments(true);
  const bill = l41Bill();
  const table = prodTable(22);
  assert.equal(effectiveCollected(table, bill), 5);
  const pinned = tableSettlePins(bill, table, {});
  assert.ok(pinned.ok);
  assert.equal(pinned.pins.expectedAmount, 17);
  assert.equal(settleAmountDue(bill.subtotal ?? 0, effectiveCollected(table, bill)), 17, "payment dialog amount = R");
});

test("BUG 06: USD 35.50 − 21.00 = 14.50 and LBP 1,483,200 − 1,169,100 = 314,100", () => {
  setServerDeductsPriorPayments(true);
  const usd = applyPaidSettlements(foldBill("t", [order("o1", [line("a", "Steak", 1, 21), line("b", "Wine", 1, 14.5)])]), {
    ok: true,
    rows: [settlementRow("s1", "o1", 1, 21, [["a", 1, 21]])],
  });
  const p1 = tableSettlePins(usd, prodTable(35.5), {});
  assert.ok(p1.ok);
  assert.equal(p1.pins.expectedAmount, 14.5);
  const lbp = applyPaidSettlements(foldBill("t", [order("o1", [line("a", "Mezze", 1, 1169100), line("b", "Dessert", 1, 314100)], "LBP")]), {
    ok: true,
    rows: [{ ...settlementRow("s1", "o1", 1, 1169100, [["a", 1, 1169100]]), currency_code: "LBP" }],
  });
  const p2 = tableSettlePins(lbp, prodTable(1483200, "LBP"), {});
  assert.ok(p2.ok);
  assert.equal(p2.pins.expectedAmount, 314100);
});

test("BUG 06: staging map collected still honoured; the larger of map and bill figures wins", () => {
  setServerDeductsPriorPayments(true);
  const bill = l41Bill();
  assert.equal(effectiveCollected(prodTable(22, "USD", { collected: 5, outstanding: 17 }), bill), 5);
  assert.equal(effectiveCollected(prodTable(22, "USD", { collected: 5 }), applyPaidSettlements(foldBill("t", bill.orders), { ok: false })), 5);
  assert.equal(effectiveCollected(prodTable(22), foldBill("t", bill.orders)), 0, "a bill built without the read → map only (as before)");
});

test("BUG 06 end-to-end: Pay Full Bill of the part-paid l4/1 bill is charged R by the production server", async () => {
  setServerDeductsPriorPayments(true);
  const bill = l41Bill();
  const table = prodTable(22);
  const server = prodPayServer(22, 5);
  const outcome = await performTablePayment({
    shownBill: bill,
    table,
    payload: { table_id: table.id, method: "cash", currency_code: "USD" },
    reReadBill: async () => ({ bill, table }),
    submit: server.submit,
    recoverRead: async () => ({ bill: null, table: null }),
    complete: () => {},
    refresh: async () => {},
  });
  assert.equal(outcome.ok, true);
  assert.equal(server.calls[0].expected_amount, 17);
});

test("BUG 06: a real change on another terminal still yields the bill-changed refusal (mapping untouched)", async () => {
  setServerDeductsPriorPayments(true);
  const bill = l41Bill();
  const table = prodTable(22);
  // Another terminal took a further 2.50 split after the bill was read: the server's R is now 14.50.
  const server = prodPayServer(22, 7.5);
  const outcome = await performTablePayment({
    shownBill: bill,
    table,
    payload: { table_id: table.id, method: "cash", currency_code: "USD" },
    reReadBill: async () => ({ bill, table }),
    submit: server.submit,
    recoverRead: async () => ({ bill, table }),
    complete: () => {},
    refresh: async () => {},
  });
  assert.equal(outcome.ok, false);
  assert.ok(!outcome.ok && outcome.error instanceof BillChangedElsewhereError);
});

test("BUG 06 hardening: settlement read failed + no map figure → refused up front (gate, pin, pay, on-account)", async () => {
  setServerDeductsPriorPayments(true);
  const bill = applyPaidSettlements(l41Bill(), { ok: false });
  const table = prodTable(22);
  assert.equal(collectedUnknown(table, bill), true);
  assert.equal(collectedUnknown(prodTable(22, "USD", { collected: 5 }), bill), false, "staging map figure is known");
  const pinned = tableSettlePins(bill, table, {});
  assert.equal(pinned.ok, false);
  const gate = payTableGate({ takePayments: { allowed: true, reason: null }, table, bill, hasOpenShift: true, online: true, settling: false });
  assert.deepEqual(gate, { allowed: false, reason: PART_PAID_UNKNOWN_MESSAGE });
  let submitted = 0;
  const outcome = await performTablePayment({
    shownBill: bill,
    table,
    payload: { table_id: table.id, method: "cash", currency_code: "USD" },
    reReadBill: async () => ({ bill, table }),
    submit: async () => {
      submitted += 1;
      return okResult(17);
    },
    recoverRead: async () => ({ bill, table }),
    complete: () => {},
    refresh: async () => {},
  });
  assert.equal(submitted, 0);
  assert.ok(!outcome.ok && outcome.error instanceof PartPaidUnknownError);
  let rpcCalls = 0;
  await assert.rejects(
    completeTableOnAccount({
      tableId: table.id,
      customerId: "c1",
      amount: 0,
      method: "cash",
      shown: { bill, table },
      rpc: async () => {
        rpcCalls += 1;
        return {};
      },
    }),
    PartPaidUnknownError,
  );
  assert.equal(rpcCalls, 0);
});

test("BUG 06: without the server contracts the F1 guard now also sees a part-paid bill on production", () => {
  setServerDeductsPriorPayments(false);
  const bill = l41Bill();
  const table = prodTable(22);
  assert.equal(billIsPartPaid(table, bill), true);
  const gate = payTableGate({ takePayments: { allowed: true, reason: null }, table, bill, hasOpenShift: true, online: true, settling: false });
  assert.deepEqual(gate, { allowed: false, reason: PART_PAID_FULL_PAY_MESSAGE });
  // An unknown read is not "part-paid" on its own and does not block an old server.
  const unknown = applyPaidSettlements(foldBill("tbl-l41", bill.orders.map((o) => ({ ...o, lines: o.lines.map(({ paid_quantity: _p, ...l }) => l) }))), { ok: false });
  assert.equal(payTableGate({ takePayments: { allowed: true, reason: null }, table, bill: unknown, hasOpenShift: true, online: true, settling: false }).allowed, true);
});

test("BUG 06: on account of the part-paid l4/1 bill pins R", async () => {
  setServerDeductsPriorPayments(true);
  const bill = l41Bill();
  const table = prodTable(22);
  const sent: TableOnAccountPayload[] = [];
  await completeTableOnAccount({
    tableId: table.id,
    customerId: "c1",
    amount: 0,
    method: "cash",
    shown: { bill, table },
    rpc: async (p) => {
      sent.push(p);
      return { bill_total: 17, paid_usd: 0, outstanding_primary: 17, orders: 1, subtotal: 22, discount: 0, currency_code: "USD" };
    },
  });
  assert.equal(sent[0].expected_amount, 17);
});

// --- BUG 01 print + guest-level split receipt -----------------------------------

const receiptCommon = { tenantName: "Hush", branchName: "Main", operatorName: "Cashier", shiftId: "shift-123456789", at: "now" };

test("pre-payment Print bill of a part-paid bill: only unpaid lines, total = due (T − P)", () => {
  const r = buildTableBillReceipt({ ...receiptCommon, bill: l41Bill(), table: prodTable(22), primaryCurrency: "USD" });
  assert.deepEqual(r.lines.map((l) => [l.name, l.qty]), [["Pizza", 1], ["Cola", 2]]);
  assert.equal(r.total, 17);
  assert.equal(r.subtotal, 17);
  assert.equal(r.paid, false);
});

test("pre-payment Print bill with nothing paid is unchanged (gross lines, gross total)", () => {
  const plain = foldBill("tbl-l41", l41Bill().orders.map((o) => ({ ...o, lines: o.lines.map(({ paid_quantity: _p, ...l }) => l) })));
  const before = buildTableBillReceipt({ ...receiptCommon, bill: plain, table: prodTable(22), primaryCurrency: "USD" });
  const read = buildTableBillReceipt({ ...receiptCommon, bill: applyPaidSettlements(plain, { ok: true, rows: [] }), table: prodTable(22), primaryCurrency: "USD" });
  assert.equal(before.total, 22);
  assert.equal(before.lines.length, 3);
  assert.deepEqual(read, before);
});

test("guest split receipt: only that split's items and amount, numbered <order_number>-<split_no>", () => {
  const r = buildSplitSettlementReceipt({
    ...receiptCommon,
    result: { split_no: 2, display_no: "1042-2", amount: 17, method: "card", currency_code: "USD", order_number: "1042" },
    parentOrderNumber: "1042",
    allocations: [
      { order_item_id: "i-pizza", quantity: 1 },
      { order_item_id: "i-cola", quantity: 2 },
    ],
    lines: [
      { order_item_id: "i-burger", name: "Burger", final_unit_price: 5, kitchen_note: null },
      { order_item_id: "i-pizza", name: "Pizza", final_unit_price: 12, kitchen_note: null },
      { order_item_id: "i-cola", name: "Cola", final_unit_price: 2.5, kitchen_note: null },
    ],
    tableName: "l4/1",
    seats: 4,
    primaryCurrency: "USD",
    rate: null,
  });
  assert.equal(r.orderNumber, "1042-2");
  assert.deepEqual(r.lines.map((l) => [l.name, l.qty, l.lineTotal]), [["Pizza", 1, 12], ["Cola", 2, 5]]);
  assert.equal(r.total, 17);
  assert.equal(r.paid, true);
  assert.equal(r.method, "card");
  assert.equal(r.tableName, "l4/1");
  assert.ok(!r.lines.some((l) => l.name === "Burger"), "never the parent bill");
  // Server omits display_no → built from the parent number.
  const fallback = buildSplitSettlementReceipt({
    ...receiptCommon,
    result: { split_no: 3, display_no: "", amount: 5, method: "cash", currency_code: "USD", order_number: "" },
    parentOrderNumber: "1042",
    allocations: [{ order_item_id: "i-burger", quantity: 1 }],
    lines: [{ order_item_id: "i-burger", name: "Burger", final_unit_price: 5, kitchen_note: null }],
    tableName: "l4/1",
    seats: null,
    primaryCurrency: "USD",
    rate: null,
  });
  assert.equal(fallback.orderNumber, "1042-3");
});

// --- BUG 02: partial_line keeps the guard, names the remedy ---------------------

test("BUG 02: partial_line refusal names the item, the table and the remedy", async () => {
  const src = order("o9", [line("p1", "Margherita", 2, 10)]);
  const bill = applyPaidSettlements(foldBill("tbl-9", [src]), { ok: true, rows: [settlementRow("s1", "o9", 1, 10, [["p1", 1, 10]])] });
  assert.equal(partlyPaidLine(bill)?.name, "Margherita");
  assert.equal(partlyPaidLine(l41Bill()), null, "whole-line part-paid bills merge fine");
  const where = await findPartlyPaidLine({
    tenantId: "t1",
    branchId: "b1",
    tables: [{ id: "tbl-l41", name: "l4/1" }, { id: "tbl-9", name: "Terrace 9" }],
    load: async ({ tableId }) => (tableId === "tbl-9" ? bill : l41Bill()),
  });
  assert.deepEqual(where, { itemName: "Margherita", tableName: "Terrace 9" });
  const c = classifyError(new MergePartialLineError(where, new Error("reason: partial_line")));
  assert.equal(c.kind, "merge_unsupported");
  assert.match(c.message, /Settle the rest of Margherita on Terrace 9 with Split, then merge\./);
  assert.match(mergePartialLineMessage(null), /Settle the rest of that item on its table with Split, then merge\./);
});

test("BUG 02: the raw server refusal still classifies as merge_unsupported with the remedy hint", () => {
  const c = classifyError(new Error("UNSUPPORTED_STATE: A line on this bill is only partly paid (reason: partial_line). Settle whole items to merge."));
  assert.equal(c.kind, "merge_unsupported");
  assert.equal(c.hint, MERGE_REASON_HINTS.partial_line);
  assert.match(c.hint ?? "", /with Split, then merge/);
});
