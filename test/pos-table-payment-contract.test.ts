// The `pos_pay_table` contract: exactly what is sent, and what must never be.
//
// The RPC reads FIVE keys - table_id, method, discount_type, discount_value,
// currency_code - and nothing else. Everything a cashier's screen also knows
// (the shift, the branch, the order ids, the tendered cash, the change) is
// either derived server-side from the ORDERS or is a display aid with no column
// to live in.
//
// This file is deliberately paranoid about the two fields most likely to be
// added by a well-meaning edit:
//
//   client_op_id - because `pos_submit_order` has one (m224) and the symmetry is
//     tempting. Sending it would be worse than useless: it would imply an
//     idempotency guarantee the server does not give, and the whole recovery
//     model in `tablePayment.ts` exists precisely because that guarantee is
//     absent.
//
//   tendered / change - because the dialog computes both, hands them back in the
//     same object as the discount, and a `...spread` is all it takes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  DiscountNotPermittedError,
  FORBIDDEN_PAYMENT_FIELDS,
  InvalidDiscountError,
  TABLE_PAYMENT_PAYLOAD_KEYS,
  buildTablePaymentPayload,
  performTablePayment,
  validateTableDiscount,
  type TablePaymentPayload,
  type TablePaymentResult,
} from "@/lib/pos/tablePayment";
import { computeChange } from "@/lib/pos/payments";
import { parseAmount } from "@/lib/currency";
import { stripComments } from "./source-helpers.ts";
import type { BillOrder, TableBill, TableSummary } from "@/types/tables";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (...p: string[]) => readFileSync(join(srcRoot, ...p), "utf8");

const allow = { allowed: true, reason: null };
const deny = { allowed: false, reason: "You do not have permission to apply discounts." };

// --- fixtures ----------------------------------------------------------------

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

const result = (over: Partial<TablePaymentResult> = {}): TablePaymentResult => ({
  ok: true,
  orders: 1,
  subtotal: 40,
  discount: 0,
  amount: 40,
  currency_code: "USD",
  original_amount: 40,
  exchange_rate: null,
  ...over,
});

// --- the allow-list ----------------------------------------------------------

test("the RPC allow-list contains exactly the twelve expected names", () => {
  const source = read("lib", "pos", "rpc.ts").replace(/\/\/.*$/gm, "");
  const decl = /export type PosRpcName\s*=([\s\S]*?);/.exec(source);
  assert.ok(decl, "the PosRpcName union could not be located");
  const members = Array.from(decl[1].matchAll(/"([a-z_]+)"/g)).map((m) => m[1]);

  assert.deepEqual(
    [...members].sort(),
    [
      "pos_cash_box_shift",
      "pos_clear_table",
      "pos_close_table",
      "pos_end_shift",
      "pos_move_table",
      "pos_open_shift",
      "pos_open_table",
      "pos_pay_order",
      "pos_pay_table",
      "pos_shift_expected",
      "pos_submit_order",
      "pos_table_map",
    ],
    `the RPC allow-list changed: ${members.join(", ")}`,
  );
  assert.equal(members.length, 12);
});

test("pos_pay_table is present, and is the only new settlement name", () => {
  const source = read("lib", "pos", "rpc.ts").replace(/\/\/.*$/gm, "");
  const members = Array.from(/export type PosRpcName\s*=([\s\S]*?);/.exec(source)![1].matchAll(/"([a-z_]+)"/g)).map(
    (m) => m[1],
  );
  assert.ok(members.includes("pos_pay_table"));
  assert.equal(members.filter((m) => m.startsWith("pos_pay")).length, 2, "an unexpected pay RPC appeared");
});

// --- the payload -------------------------------------------------------------

test("an undiscounted payload carries exactly three keys", () => {
  const payload = buildTablePaymentPayload({ tableId: "tbl1", method: "cash", currency: "USD" });
  assert.deepEqual(Object.keys(payload), ["table_id", "method", "currency_code"]);
  assert.deepEqual(payload, { table_id: "tbl1", method: "cash", currency_code: "USD" });
});

test("a discounted payload adds exactly the two discount keys", () => {
  const payload = buildTablePaymentPayload({
    tableId: "tbl1",
    method: "cash",
    currency: "USD",
    discount: { discount_type: "percent", discount_value: 10 },
  });
  assert.deepEqual(Object.keys(payload).sort(), ["currency_code", "discount_type", "discount_value", "method", "table_id"]);
  assert.equal(payload.discount_type, "percent");
  assert.equal(payload.discount_value, 10);
});

test("every payload key is one the RPC declares", () => {
  for (const discount of [undefined, { discount_type: "amount" as const, discount_value: 5 }]) {
    const payload = buildTablePaymentPayload({ tableId: "tbl1", method: "cash", currency: "LBP", discount });
    for (const key of Object.keys(payload)) {
      assert.ok(
        (TABLE_PAYMENT_PAYLOAD_KEYS as readonly string[]).includes(key),
        `${key} is not part of the pos_pay_table contract`,
      );
    }
  }
});

// The named-field cases, each asserted individually so a failure says WHICH
// field leaked rather than "a forbidden field was present".
for (const forbidden of ["shift_id", "branch_id", "order_id", "order_number", "client_op_id", "tendered", "change", "batch_no"]) {
  test(`the payload never carries ${forbidden}`, () => {
    const payload = buildTablePaymentPayload({
      tableId: "tbl1",
      method: "cash",
      currency: "USD",
      discount: { discount_type: "percent", discount_value: 10 },
    });
    assert.equal(forbidden in payload, false, `${forbidden} reached the pos_pay_table payload`);
  });
}

test("the forbidden list itself is the documented one", () => {
  assert.deepEqual([...FORBIDDEN_PAYMENT_FIELDS].sort(), [
    "batch_no",
    "branch_id",
    "change",
    "client_op_id",
    "order_id",
    "order_number",
    "shift_id",
    "tendered",
  ]);
});

test("the builder names each field - it does not spread whatever it is handed", () => {
  // The regression this prevents: `...(discount as Partial<Payload>)` happily
  // forwards `tendered` because the dialog returns it in the same object.
  const source = read("lib", "pos", "tablePayment.ts");
  const fn = /export function buildTablePaymentPayload\(([\s\S]*?)\n\}/.exec(source)?.[1] ?? "";
  assert.notEqual(fn, "", "buildTablePaymentPayload could not be located");
  assert.doesNotMatch(fn, /\.\.\./, "the payload builder spreads a record again");
});

test("payTable posts the payload verbatim under p_payload, adding nothing", () => {
  const source = read("lib", "pos", "tablePayment.ts");
  assert.match(source, /callPosRpc\("pos_pay_table",\s*\{\s*p_payload:\s*payload\s*\}\)/, "payTable no longer sends the payload as-is");
});

test("what actually reaches the wire is the exact payload, end to end", async () => {
  // `submit` is the real seam: whatever performTablePayment hands it is what
  // `payTable` would post. Captured here so the guarantee covers the whole path,
  // not just the builder in isolation.
  let sent: TablePaymentPayload | null = null;
  const payload = buildTablePaymentPayload({ tableId: "tbl1", method: "cash", currency: "USD" });
  const shown = bill();

  await performTablePayment({
    shownBill: shown,
    table: table(),
    payload,
    reReadBill: async () => ({ bill: shown, table: table() }),
    submit: async (p) => {
      sent = p;
      return result();
    },
    recoverRead: async () => ({ bill: null, table: null }),
    complete: () => {},
    refresh: async () => {},
  });

  assert.ok(sent, "nothing was submitted");
  assert.deepEqual(Object.keys(sent!).sort(), ["currency_code", "method", "table_id"]);
  for (const f of FORBIDDEN_PAYMENT_FIELDS) {
    assert.equal(f in sent!, false, `${f} reached the server`);
  }
});

// --- discounts ---------------------------------------------------------------

test("no discount sends no discount fields", () => {
  const d = validateTableDiscount({ canDiscount: deny, subtotal: 40, type: "none", value: "" });
  assert.deepEqual(d.fields, {});
  assert.equal(d.amount, 0);
});

test("a percent discount is sent as type + value, never as a computed amount", () => {
  const d = validateTableDiscount({ canDiscount: allow, subtotal: 40, type: "percent", value: "10" });
  assert.deepEqual(d.fields, { discount_type: "percent", discount_value: 10 });
  // The client's own figure is for display; the SERVER allocates and charges.
  assert.equal(d.amount, 4);
});

test("a fixed discount is sent as type + value", () => {
  const d = validateTableDiscount({ canDiscount: allow, subtotal: 40, type: "amount", value: "7.5" });
  assert.deepEqual(d.fields, { discount_type: "amount", discount_value: 7.5 });
  assert.equal(d.amount, 7.5);
});

test("percent above 100 is refused", () => {
  assert.throws(
    () => validateTableDiscount({ canDiscount: allow, subtotal: 40, type: "percent", value: "101" }),
    InvalidDiscountError,
  );
});

test("a fixed discount above the subtotal is refused", () => {
  assert.throws(
    () => validateTableDiscount({ canDiscount: allow, subtotal: 40, type: "amount", value: "41" }),
    InvalidDiscountError,
  );
});

test("a negative discount is refused", () => {
  for (const type of ["percent", "amount"] as const) {
    assert.throws(
      () => validateTableDiscount({ canDiscount: allow, subtotal: 40, type, value: "-1" }),
      InvalidDiscountError,
      `a negative ${type} discount was accepted`,
    );
  }
});

test("a non-zero discount requires the discount permission", () => {
  assert.throws(
    () => validateTableDiscount({ canDiscount: deny, subtotal: 40, type: "percent", value: "10" }),
    DiscountNotPermittedError,
  );
});

test("a zero discount and no discount produce byte-identical payloads", () => {
  const none = buildTablePaymentPayload({
    tableId: "tbl1",
    method: "cash",
    currency: "USD",
    discount: validateTableDiscount({ canDiscount: allow, subtotal: 40, type: "none", value: "" }).fields,
  });
  const zero = buildTablePaymentPayload({
    tableId: "tbl1",
    method: "cash",
    currency: "USD",
    discount: validateTableDiscount({ canDiscount: allow, subtotal: 40, type: "percent", value: "0" }).fields,
  });
  assert.deepEqual(zero, none);
});

test("the client never prorates a discount across the table's orders", () => {
  // The server allocates proportionally with the remainder on the last order.
  // Any per-order arithmetic here would be a second, competing allocation.
  // Comments are stripped: the module DOCUMENTS that the server prorates, and
  // saying so must not be mistaken for doing so.
  const code = stripComments(read("lib", "pos", "tablePayment.ts"));
  assert.doesNotMatch(code, /prorate|allocate/i, "the client allocates a discount itself");
  // No per-order discount arithmetic. Scoped to the discount function, because
  // the module DOES walk `orders` elsewhere - `billChangedSincePreview` compares
  // order ids and shift ids, which is comparison, not allocation.
  const fn = /export function validateTableDiscount\(([\s\S]*?)\n\}/.exec(code)?.[1] ?? "";
  assert.notEqual(fn, "", "validateTableDiscount could not be located");
  assert.doesNotMatch(fn, /orders/, "the discount path looks at the bill's individual orders");

  // And the discount VALUE the server receives is the one number the cashier
  // typed, produced in exactly one place.
  const produced = code.match(/discount_value:/g) ?? [];
  assert.equal(produced.length, 1, `discount_value is constructed ${produced.length} times, expected once`);

  // A multi-order bill still sends a single type/value pair.
  const many = validateTableDiscount({ canDiscount: allow, subtotal: 100, type: "percent", value: "10" });
  assert.deepEqual(many.fields, { discount_type: "percent", discount_value: 10 });
});

// --- tendered / change -------------------------------------------------------

test("an exact tender leaves no change and is not short", () => {
  const c = computeChange(40, 40, "USD");
  assert.deepEqual(c, { change: 0, short: false });
});

test("an over-tender calculates the change", () => {
  assert.deepEqual(computeChange(40, 50, "USD"), { change: 10, short: false });
  // LBP is a whole-unit currency; change rounds to the unit, not to cents.
  assert.deepEqual(computeChange(3_500_000, 4_000_000, "LBP"), { change: 500_000, short: false });
});

test("an under-tender is flagged short and never yields negative change", () => {
  const c = computeChange(40, 35, "USD");
  assert.equal(c.short, true);
  assert.equal(c.change, 0);
});

test("malformed tender input parses to zero, which is not treated as short", () => {
  // Zero means "nothing typed yet" - the dialog shows the full amount due rather
  // than accusing the cashier of under-paying before they have started.
  for (const raw of ["abc", "--", "1.2.3", ""]) {
    assert.equal(parseAmount(raw), 0, `${raw} did not parse to 0`);
    assert.equal(computeChange(40, parseAmount(raw), "USD").short, false);
  }
  // And a parseable one still works.
  assert.equal(parseAmount("1,250"), 1250);
});

test("tendered and change exist only in the UI - the payment module never posts them", () => {
  // They may be discussed in the header comment; what must not exist is a field.
  const code = stripComments(read("lib", "pos", "tablePayment.ts"));
  assert.doesNotMatch(code, /tendered\s*:/, "tendered became a field in the payment module");
  assert.doesNotMatch(code, /\bchange\s*:/, "change became a field in the payment module");
});
