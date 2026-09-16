// What happens after the money is taken: the ordered completion, the receipt,
// and the cash box.
//
// Three rules are asserted here, and each one is a defect that has already been
// paid for once:
//
//   1. THE ORDER IS FIXED. The table map is refreshed and checked BEFORE
//      anything is presented as settled, and the receipt is presented BEFORE the
//      dialog closes. On staging, a takeaway payment produced correct data and
//      cleared the cart while the receipt never appeared - because presentation
//      raced teardown. The dine-in sequence is built so it cannot.
//
//   2. THE SERVER'S FIGURES WIN. `pos_pay_table` returns subtotal, discount and
//      amount; those are what the receipt prints. Local arithmetic is used only
//      when the response was LOST, and is marked provisional rather than passed
//      off as authoritative.
//
//   3. `pos_close_table` IS NOT CALLED. `pos_pay_table` completes the orders and
//      frees the table itself. A follow-up Close would be a second mutation
//      chasing a state the server is already in - and, if the pay response was
//      lost, a mutation against a table someone else may have re-opened.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  TABLE_COMPLETION_SEQUENCE,
  billIsCleared,
  buildTablePaymentReceipt,
  completeTablePayment,
  paymentFigures,
} from "@/lib/pos/tablePaymentCompletion";
import { performTablePayment, type TablePaymentPayload, type TablePaymentResult } from "@/lib/pos/tablePayment";
import { stripComments } from "./source-helpers.ts";
import type { BillLine, BillOrder, TableBill, TableSummary } from "@/types/tables";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (...p: string[]) => readFileSync(join(srcRoot, ...p), "utf8");

const line = (over: Partial<BillLine> = {}): BillLine => ({
  id: "l1",
  name: "Chicken Sandwich",
  quantity: 2,
  base_price: 5,
  modifiers_total: 0.5,
  final_unit_price: 5.5,
  line_total: 11,
  kitchen_note: "no pickles",
  batch_no: 1,
  modifiers: [{ group_id: "g1", option_id: "op1", name: "Extra cheese", price_delta: 0.5, quantity: 1 }],
  ...over,
});

const order = (over: Partial<BillOrder> = {}): BillOrder => ({
  id: "o1",
  order_number: "A-14",
  status: "sent_to_kitchen",
  payment_status: "unpaid",
  shift_id: "shift-abcdef123456",
  branch_id: "b1",
  tenant_id: "t1",
  subtotal: 40,
  discount_amount: 0,
  total_amount: 40,
  currency: "USD",
  exchange_rate: null,
  created_at: "2026-08-07T10:00:00Z",
  lines: [line()],
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
  name: "Terrace 2",
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

const freeTable = () => table({ occupied: false, status: "available", orders: 0, order_number: null, total: null });

const result = (over: Partial<TablePaymentResult> = {}): TablePaymentResult => ({
  ok: true,
  orders: 1,
  subtotal: 40,
  discount: 4,
  amount: 36,
  currency_code: "USD",
  original_amount: 36,
  exchange_rate: null,
  ...over,
});

const receiptInput = (over: Record<string, unknown> = {}) =>
  ({
    bill: bill(),
    table: table(),
    result: result(),
    requestedDiscount: 4,
    method: "cash" as const,
    tenantName: "Dominos Pizza",
    branchName: "Main Branch",
    operatorName: "QA Cashier",
    primaryCurrency: "USD" as const,
    tenderCurrency: "USD" as const,
    rate: 89_000,
    tenderedInput: 40,
    shiftId: "shift-abcdef123456",
    at: "07/08/2026, 14:32",
    ...over,
  }) as Parameters<typeof buildTablePaymentReceipt>[0];

// --- the ordered sequence ----------------------------------------------------

test("the completion sequence is fixed, and refreshes the server before it claims success", () => {
  assert.deepEqual(TABLE_COMPLETION_SEQUENCE, [
    "refresh-table-map",
    "verify-bill-cleared",
    "refresh-cash-box",
    "present-receipt",
    "close-payment-dialog",
    "clear-payment-state",
  ]);
});

test("the map refresh and the verification precede every presentation step", () => {
  const i = (s: string) => TABLE_COMPLETION_SEQUENCE.indexOf(s as never);
  assert.ok(i("refresh-table-map") < i("verify-bill-cleared"));
  assert.ok(i("verify-bill-cleared") < i("present-receipt"), "a receipt could be shown before the bill was proven gone");
  assert.ok(i("refresh-cash-box") < i("present-receipt"));
  // Presentation before teardown - the staging defect this ordering encodes.
  assert.ok(i("present-receipt") < i("close-payment-dialog"), "the dialog closes before the receipt is presented");
  assert.ok(i("close-payment-dialog") < i("clear-payment-state"));
});

test("completeTablePayment returns the receipt AND the steps, performing neither", () => {
  const c = completeTablePayment(receiptInput());
  assert.deepEqual(c.steps, TABLE_COMPLETION_SEQUENCE);
  assert.equal(c.receipt.total, 36);
});

test("the bill is only 'cleared' when BOTH the bill and the table say so", () => {
  assert.equal(billIsCleared(null, freeTable()), true);
  assert.equal(billIsCleared(bill({ orders: [] }), freeTable()), true);
  assert.equal(billIsCleared(bill(), freeTable()), false, "an open bill was treated as cleared");
  assert.equal(billIsCleared(null, table({ orders: 1 })), false, "an occupied table was treated as cleared");
});

test("completion runs exactly once for a directly confirmed payment", async () => {
  let completions = 0;
  await performTablePayment({
    shownBill: bill(),
    table: table(),
    payload: { table_id: "tbl1", method: "cash", currency_code: "USD" } as TablePaymentPayload,
    reReadBill: async () => ({ bill: bill(), table: table() }),
    submit: async () => result(),
    recoverRead: async () => ({ bill: null, table: freeTable() }),
    complete: () => {
      completions++;
    },
    refresh: async () => {},
  });
  assert.equal(completions, 1);
});

test("completion runs exactly once for a RECOVERED payment too", async () => {
  let completions = 0;
  const outcome = await performTablePayment({
    shownBill: bill(),
    table: table(),
    payload: { table_id: "tbl1", method: "cash", currency_code: "USD" } as TablePaymentPayload,
    reReadBill: async () => ({ bill: bill(), table: table() }),
    submit: async () => {
      throw new Error("Failed to fetch");
    },
    recoverRead: async () => ({ bill: null, table: freeTable() }),
    complete: () => {
      completions++;
    },
    refresh: async () => {},
  });
  assert.equal(outcome.ok, true);
  assert.equal(completions, 1);
});

test("the completion is awaited, so the refresh cannot overlap it", async () => {
  const seq: string[] = [];
  await performTablePayment({
    shownBill: bill(),
    table: table(),
    payload: { table_id: "tbl1", method: "cash", currency_code: "USD" } as TablePaymentPayload,
    reReadBill: async () => ({ bill: bill(), table: table() }),
    submit: async () => result(),
    recoverRead: async () => ({ bill: null, table: freeTable() }),
    complete: async () => {
      await new Promise((r) => setTimeout(r, 5));
      seq.push("complete-finished");
    },
    refresh: async () => {
      seq.push("refresh-started");
    },
  });
  assert.deepEqual(seq, ["complete-finished", "refresh-started"]);
});

// --- the server's figures ----------------------------------------------------

test("the server's subtotal, discount and amount are what the receipt prints", () => {
  const f = paymentFigures({ result: result({ subtotal: 40, discount: 4, amount: 36 }), billSubtotal: 999, requestedDiscount: 999 });
  assert.deepEqual(f, { subtotal: 40, discount: 4, amount: 36, provisional: false });
});

test("a recovered payment falls back to the pre-payment bill, and says it is provisional", () => {
  const f = paymentFigures({ result: null, billSubtotal: 40, requestedDiscount: 4 });
  assert.deepEqual(f, { subtotal: 40, discount: 4, amount: 36, provisional: true });
});

test("a recovered payment never prints a negative total", () => {
  const f = paymentFigures({ result: null, billSubtotal: 10, requestedDiscount: 25 });
  assert.equal(f.amount, 0);
});

// --- the receipt -------------------------------------------------------------

test("the receipt carries the table and its seats", () => {
  const r = buildTablePaymentReceipt(receiptInput());
  assert.equal(r.tableName, "Terrace 2");
  assert.equal(r.seats, 4);
  assert.equal(r.orderType, "Dine-in");
});

test("the order number comes from the PRE-payment bill, because pos_pay_table returns none", () => {
  const r = buildTablePaymentReceipt(receiptInput());
  assert.equal(r.orderNumber, "A-14");
  // The result type genuinely has no order_number to fall back on.
  assert.equal("order_number" in result(), false);
});

test("a bill spanning more than one order prints every number", () => {
  const r = buildTablePaymentReceipt(
    receiptInput({ bill: bill({ orders: [order(), order({ id: "o2", order_number: "A-15" })] }) }),
  );
  assert.equal(r.orderNumber, "A-14, A-15");
});

test("items, quantities, modifiers and notes come from the server's bill", () => {
  const r = buildTablePaymentReceipt(receiptInput());
  assert.equal(r.lines.length, 1);
  assert.equal(r.lines[0].name, "Chicken Sandwich");
  assert.equal(r.lines[0].qty, 2);
  assert.equal(r.lines[0].lineTotal, 11);
  assert.deepEqual(r.lines[0].modifiers, [{ name: "Extra cheese", price_delta: 0.5, quantity: 1 }]);
  assert.equal(r.lines[0].note, "no pickles");
});

test("the receipt's money is the server's, not the bill's", () => {
  const r = buildTablePaymentReceipt(receiptInput({ bill: bill({ subtotal: 999, total: 999 }) }));
  assert.equal(r.subtotal, 40);
  assert.equal(r.discount, 4);
  assert.equal(r.total, 36);
  assert.equal(r.currency, "USD");
});

test("tendered and change appear on the receipt, where they belong", () => {
  const r = buildTablePaymentReceipt(receiptInput({ tenderedInput: 50 }));
  assert.equal(r.tendered, 50);
  assert.equal(r.change, 14);
  assert.equal(r.tenderCurrency, "USD");
});

test("an exact tender prints zero change", () => {
  const r = buildTablePaymentReceipt(receiptInput({ tenderedInput: 36 }));
  assert.equal(r.tendered, 36);
  assert.equal(r.change, 0);
});

test("a tender below the amount is printed as paid exactly, never as negative change", () => {
  // Under-tender is refused before submission; if one reaches here it must not
  // produce a receipt claiming the customer is owed money.
  const r = buildTablePaymentReceipt(receiptInput({ tenderedInput: 5 }));
  assert.equal(r.tendered, 36);
  assert.equal(r.change, 0);
});

test("an LBP tender against a USD bill converts at the tenant rate", () => {
  const r = buildTablePaymentReceipt(
    receiptInput({ tenderCurrency: "LBP", rate: 89_000, tenderedInput: 3_300_000 }),
  );
  assert.equal(r.currency, "USD", "the bill's own currency must remain the receipt currency");
  assert.equal(r.tenderCurrency, "LBP");
  assert.equal(r.tenderTotal, 36 * 89_000);
  assert.equal(r.tendered, 3_300_000);
  assert.equal(r.change, 3_300_000 - 36 * 89_000);
});

test("with no usable rate the tender block is omitted rather than converted at zero", () => {
  const r = buildTablePaymentReceipt(receiptInput({ tenderCurrency: "LBP", rate: null }));
  assert.equal(r.tenderTotal, null);
  assert.equal(r.tendered, null);
  assert.equal(r.change, null);
});

test("the receipt names the cashier, the branch and the business", () => {
  const r = buildTablePaymentReceipt(receiptInput());
  assert.equal(r.staffName, "QA Cashier");
  assert.equal(r.branchName, "Main Branch");
  assert.equal(r.businessName, "Dominos Pizza");
  assert.equal(r.method, "cash");
  assert.equal(r.paid, true);
  assert.equal(r.at, "07/08/2026, 14:32");
});

test("the receipt carries a shift reference so paper can be tied back to a till", () => {
  const r = buildTablePaymentReceipt(receiptInput());
  assert.equal(r.shiftRef, "shift-ab");
});

// --- structural guarantees ---------------------------------------------------

test("pos_close_table is NOT called after a payment", () => {
  // The payment modules must not CALL Close. Comments are stripped: both files
  // document that `pos_close_table` is deliberately not called after payment,
  // and saying so must not be mistaken for doing it.
  const modules = stripComments(
    [read("lib", "pos", "tablePayment.ts"), read("lib", "pos", "tablePaymentCompletion.ts")].join("\n"),
  );
  assert.doesNotMatch(modules, /closeTable/, "the payment modules reference Close");
  assert.doesNotMatch(modules, /pos_close_table/, "the payment modules reference pos_close_table");

  // The workspace still owns the Level 2C Close ACTION, so the assertion there
  // is scoped to the payment path: nothing from the confirm through the
  // completion may reach it.
  const workspace = read("screens", "pos", "DineInWorkspace.tsx");
  const start = workspace.indexOf("const runCompletion = useCallback(");
  const end = workspace.indexOf("// A payment dialog left open");
  assert.ok(start > 0 && end > start, "the payment path could not be located");
  // Sliced FIRST (the boundaries are comments), then stripped - the payment path
  // documents that it does not call Close, which must not read as calling it.
  const payPath = stripComments(workspace.slice(start, end));
  assert.doesNotMatch(payPath, /closeTable|pos_close_table/, "the payment path calls Close after settling");
  assert.doesNotMatch(payPath, /confirmClose|requestOp\("close"\)/, "the payment path triggers the Close action");
});

test("the completion never marks the table available locally", () => {
  const completion = read("lib", "pos", "tablePaymentCompletion.ts");
  assert.doesNotMatch(completion, /status:\s*"available"/, "the completion sets a table state itself");
  assert.doesNotMatch(completion, /occupied\s*=/, "the completion mutates occupancy");
});

test("the cash box is re-read from the server, never incremented locally", () => {
  const workspace = read("screens", "pos", "DineInWorkspace.tsx");
  assert.match(workspace, /refreshCashBox\(\)/, "the cash box is not refreshed after a table payment");
  assert.doesNotMatch(workspace, /cashBox\s*[+]=|setCashBox|cashBox:\s*\{/, "the cash box is being mutated locally");
  // And it is the SAME authoritative reader takeaway uses.
  const shiftStore = read("state", "shift.ts");
  assert.match(shiftStore, /refreshCashBox: async \(\) => \{/);
  assert.match(shiftStore, /cashBox: await getCashBox\(shift\.id\)/, "the cash box is no longer read from the server");
});

test("the receipt goes through the store-owned presentation layer", () => {
  // RETARGETED BY POS v1. Dine-in used to be handed an inline
  // `(receipt) => receiptStore.present(receipt)`. It is now handed
  // `presentReceipt`, the single call site takeaway and delivery also use,
  // which does the same store presentation and then attempts the automatic
  // print. The property being defended is unchanged - dine-in does not present
  // for itself, it goes through the store-owned layer - and is now stronger,
  // because all three routes are provably passed the SAME function.
  const workspace = read("screens", "pos", "PosWorkspace.tsx");
  assert.match(workspace, /onPresentReceipt: presentReceipt/);
  assert.match(workspace, /const presentReceipt = useCallback\(/);
  assert.match(workspace, /receiptStore\.present\(receipt\)/);
  // `present` sets data AND visibility in one update - that is why it is used.
  assert.match(read("state", "receipt.ts"), /present: \(receipt\) => set\(\{ receipt, visible: true \}\)/);
});
