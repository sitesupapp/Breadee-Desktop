// Order submission contract: shift binding, idempotency key, and the exact
// payload shape pos_save_order parses.
//
// These are the checks that would have caught the two defects this level fixes:
// an order with a null shift (unpayable AND invisible to the cash box), and a
// submit path with no client_op_id (three clicks, three orders).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildSubmitPayload,
  cartSubtotal,
  newClientOpId,
  ShiftRequiredError,
  TableRequiredError,
} from "@/lib/pos/orders";
import { lineTotals, modifiersTotal } from "@/lib/pos/modifiers";
import type { CartLine } from "@/types/pos";

const line = (over: Partial<CartLine> = {}): CartLine => ({
  key: "line-1",
  menu_item_id: "item-1",
  name: "Chicken Sandwich",
  base_price: 5,
  quantity: 1,
  kitchen_note: null,
  modifiers: [],
  ...over,
});

const base = {
  branchId: "branch-1",
  shiftId: "shift-1",
  orderType: "takeaway" as const,
  clientOpId: "op-1",
  lines: [line()],
};

test("a payload can never be built without a shift", () => {
  assert.throws(() => buildSubmitPayload({ ...base, shiftId: null }), ShiftRequiredError);
  assert.throws(() => buildSubmitPayload({ ...base, shiftId: "" }), ShiftRequiredError);
});

test("the shift id is always present on a built payload", () => {
  const payload = buildSubmitPayload(base);
  assert.equal(payload.shift_id, "shift-1");
  assert.notEqual(payload.shift_id, null);
});

test("the payload carries the client operation id for server-side idempotency", () => {
  const payload = buildSubmitPayload(base);
  assert.equal(payload.client_op_id, "op-1");
});

test("a retry reuses the same operation id, so the server returns the same order", () => {
  const first = buildSubmitPayload(base);
  const retry = buildSubmitPayload(base);
  assert.equal(first.client_op_id, retry.client_op_id);
  assert.deepEqual(first, retry);
});

test("minted operation ids are unique per logical order", () => {
  const ids = new Set(Array.from({ length: 50 }, () => newClientOpId()));
  assert.equal(ids.size, 50);
});

test("the payload matches the shape pos_save_order parses", () => {
  const payload = buildSubmitPayload({
    ...base,
    lines: [
      line({
        kitchen_note: "  no pickles  ",
        modifiers: [
          { group_id: "g1", option_id: "o1", name: "Extra cheese", price_delta: 0.5, quantity: 1 },
          { group_id: "g2", option_id: "o2", name: "Large", price_delta: 1.25, quantity: 2 },
        ],
      }),
    ],
  });

  assert.deepEqual(Object.keys(payload).sort(), [
    "branch_id",
    "client_op_id",
    "items",
    "notes",
    "order_type",
    "shift_id",
    "status",
  ]);
  assert.equal(payload.order_type, "takeaway");
  assert.equal(payload.status, "sent_to_kitchen");

  const item = payload.items[0];
  assert.deepEqual(Object.keys(item).sort(), ["base_price", "kitchen_note", "menu_item_id", "modifiers", "name", "quantity"]);
  assert.equal(item.kitchen_note, "no pickles", "notes are trimmed, never sent as padded strings");
  assert.deepEqual(item.modifiers[0], {
    group_id: "g1",
    option_id: "o1",
    name: "Extra cheese",
    price_delta: 0.5,
    quantity: 1,
  });
});

test("an empty note is sent as null rather than an empty string", () => {
  const payload = buildSubmitPayload({ ...base, lines: [line({ kitchen_note: "   " })] });
  assert.equal(payload.items[0].kitchen_note, null);
  assert.equal(payload.notes, null);
});

test("modifier totals mirror the server: sum(price_delta * quantity)", () => {
  const mods = [
    { group_id: "g1", option_id: "o1", name: "Extra cheese", price_delta: 0.5, quantity: 1 },
    { group_id: "g2", option_id: "o2", name: "Double patty", price_delta: 2, quantity: 2 },
  ];
  assert.equal(modifiersTotal(mods), 4.5);

  const totals = lineTotals(5, mods, 3);
  assert.equal(totals.finalUnitPrice, 9.5);
  assert.equal(totals.lineTotal, 28.5);
});

test("the cart subtotal is the sum the server will compute", () => {
  const lines = [
    line({ key: "a", base_price: 5, quantity: 2, modifiers: [{ group_id: "g", option_id: "o", name: "X", price_delta: 1, quantity: 1 }] }),
    line({ key: "b", base_price: 2.5, quantity: 1 }),
  ];
  // (5 + 1) * 2 + 2.5
  assert.equal(cartSubtotal(lines), 14.5);
});

test("quantity changes flow straight into the payload", () => {
  const payload = buildSubmitPayload({ ...base, lines: [line({ quantity: 7 })] });
  assert.equal(payload.items[0].quantity, 7);
});

// --- Dine-in table binding (Level 2A) ----------------------------------------
//
// m218 keys the single-active-bill lookup on `table_id`. A dine-in submit that
// omits it does not fail loudly - it silently opens a SECOND bill on the same
// table, which then cannot be settled with the first. That defect is made
// unrepresentable here: the payload cannot be built at all.

test("a dine-in payload can never be built without a table", () => {
  assert.throws(() => buildSubmitPayload({ ...base, orderType: "dine_in" }), TableRequiredError);
  assert.throws(() => buildSubmitPayload({ ...base, orderType: "dine_in", tableId: null }), TableRequiredError);
  assert.throws(() => buildSubmitPayload({ ...base, orderType: "dine_in", tableId: "" }), TableRequiredError);
});

test("the shift is still required for dine-in, and is checked first", () => {
  assert.throws(
    () => buildSubmitPayload({ ...base, orderType: "dine_in", shiftId: null, tableId: "table-1" }),
    ShiftRequiredError,
  );
});

test("a dine-in payload carries table_id so the round joins the table's one open bill", () => {
  const payload = buildSubmitPayload({ ...base, orderType: "dine_in", tableId: "table-1" });
  assert.equal(payload.order_type, "dine_in");
  assert.equal(payload.table_id, "table-1");
  assert.equal(payload.shift_id, "shift-1");
  assert.deepEqual(Object.keys(payload).sort(), [
    "branch_id",
    "client_op_id",
    "items",
    "notes",
    "order_type",
    "shift_id",
    "status",
    "table_id",
  ]);
});

test("the takeaway payload is byte-for-byte unchanged - table_id is absent, not null", () => {
  const takeaway = buildSubmitPayload(base);
  assert.equal("table_id" in takeaway, false);
  // Even when a table id is supplied by mistake, a takeaway order never carries it.
  const stray = buildSubmitPayload({ ...base, tableId: "table-1" });
  assert.equal("table_id" in stray, false);
  assert.deepEqual(stray, takeaway);
});

test("a dine-in retry reuses the operation id, so m224 replays instead of duplicating the round", () => {
  const input = { ...base, orderType: "dine_in" as const, tableId: "table-1" };
  assert.deepEqual(buildSubmitPayload(input), buildSubmitPayload(input));
});
