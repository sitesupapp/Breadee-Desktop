// Order-level note (takeaway + dine-in) restoration.
//
// The order note is a WHOLE-ORDER instruction ("Customer picking up at 7"),
// distinct from an item's `kitchen_note` ("No onion"). It rides the EXISTING
// plumbing: `orderNote -> buildSubmitPayload -> pos_orders.notes`. Delivery
// already exposed a control; this restores one for takeaway and dine-in.
//
// These tests pin: the payload field (`notes`) receives the order note; it stays
// SEPARATE from each line's `kitchen_note`; the round payload carries it for
// dine-in; and the workspaces wire it in (source assertions), while Delivery's
// existing order-note control is untouched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { stripJsxComments } from "./source-helpers.ts";
import { buildSubmitPayload } from "@/lib/pos/orders";
import { buildRoundPayload } from "@/lib/pos/tableRounds";
import type { CartLine } from "@/types/pos";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

function line(over: Partial<CartLine> = {}): CartLine {
  return {
    key: "line-1",
    menu_item_id: "i-1",
    name: "Burger",
    base_price: 10,
    quantity: 1,
    kitchen_note: null,
    modifiers: [],
    ...over,
  };
}

// =============================================================================
// PAYLOAD: the order note reaches pos_orders.notes
// =============================================================================

test("a takeaway order note reaches the payload's `notes`", () => {
  const payload = buildSubmitPayload({
    branchId: "b", shiftId: "s", orderType: "takeaway", clientOpId: "op",
    orderNote: "Customer picking up at 7",
    lines: [line()],
  });
  assert.equal(payload.notes, "Customer picking up at 7");
});

test("an empty order note is sent as null, not an empty string", () => {
  for (const note of [undefined, null, "", "   "]) {
    const payload = buildSubmitPayload({
      branchId: "b", shiftId: "s", orderType: "takeaway", clientOpId: "op",
      orderNote: note as string | null | undefined,
      lines: [line()],
    });
    assert.equal(payload.notes, null, `${JSON.stringify(note)} must become null`);
  }
});

test("the dine-in ROUND payload carries the order note and the table", () => {
  const payload = buildRoundPayload({
    ctx: { online: true, shiftId: "s", branchId: "b", table: { id: "t-9" } } as never,
    lines: [line()],
    clientOpId: "op",
    orderNote: "Table celebrating a birthday",
  });
  assert.equal(payload.notes, "Table celebrating a birthday");
  assert.equal((payload as { table_id?: string }).table_id, "t-9");
});

// =============================================================================
// SEPARATION: order note vs item kitchen_note
// =============================================================================

test("an order note and an item kitchen note stay in separate fields", () => {
  const payload = buildSubmitPayload({
    branchId: "b", shiftId: "s", orderType: "takeaway", clientOpId: "op",
    orderNote: "Customer picking up at 7",
    lines: [line({ kitchen_note: "No onion" })],
  });
  // The order note is on the ORDER; the item note is on the LINE. Never merged.
  assert.equal(payload.notes, "Customer picking up at 7");
  assert.equal(payload.items[0].kitchen_note, "No onion");
  assert.notEqual(payload.notes, payload.items[0].kitchen_note);
});

test("an order with only an item note carries no order note, and vice versa", () => {
  const itemOnly = buildSubmitPayload({
    branchId: "b", shiftId: "s", orderType: "takeaway", clientOpId: "op",
    lines: [line({ kitchen_note: "Well done" })],
  });
  assert.equal(itemOnly.notes, null);
  assert.equal(itemOnly.items[0].kitchen_note, "Well done");

  const orderOnly = buildSubmitPayload({
    branchId: "b", shiftId: "s", orderType: "takeaway", clientOpId: "op",
    orderNote: "Call when ready",
    lines: [line()],
  });
  assert.equal(orderOnly.notes, "Call when ready");
  assert.equal(orderOnly.items[0].kitchen_note, null);
});

// =============================================================================
// WIRING: the workspaces feed the existing plumbing
// =============================================================================

test("the round payload builder forwards the order note", () => {
  const src = stripJsxComments(read("src/lib/pos/tableRounds.ts"));
  assert.match(src, /orderNote: input\.orderNote/);
});

test("takeaway wires the order note into its submit and kitchen ticket", () => {
  const src = stripJsxComments(read("src/screens/pos/PosWorkspace.tsx"));
  // Fed into buildSubmitPayload via the live ref (unchanged plumbing) and wired
  // into the compact order-note control that now lives in the CartPanel header
  // (v1.0.12 Current Order compaction) rather than a standalone field above it.
  assert.match(src, /orderNote: orderNoteRef\.current\.trim\(\)/);
  assert.match(src, /onOrderNoteChange=\{editOrderNote\}/);
  // The control itself still writes the same note value on change.
  const cart = stripJsxComments(read("src/components/pos/CartPanel.tsx"));
  assert.match(cart, /onChange=\{\(e\) => props\.onOrderNoteChange\?\.\(e\.target\.value\)\}/);
});

test("dine-in wires the order note into performRound", () => {
  const src = stripJsxComments(read("src/screens/pos/DineInWorkspace.tsx"));
  assert.match(src, /orderNote: orderNoteRef\.current\.trim\(\)/);
  assert.match(src, /setOrderNote\(e\.target\.value\)/);
});

test("REGRESSION: Delivery keeps its own order-note control, untouched", () => {
  const src = stripJsxComments(read("src/screens/pos/DeliveryWorkspace.tsx"));
  assert.match(src, /setOrderNote/, "delivery order-note control must remain");
});

test("the order note does not disturb item-level ingredient removals", () => {
  // Both features coexist: a line can carry a removal AND the order carry a note.
  const payload = buildSubmitPayload({
    branchId: "b", shiftId: "s", orderType: "takeaway", clientOpId: "op",
    orderNote: "Deliver to back entrance",
    lines: [line({ removed_ingredients: ["Onion"], kitchen_note: "NO ONION" })],
  });
  assert.equal(payload.notes, "Deliver to back entrance");
  assert.deepEqual(payload.items[0].customization_json, { removed_menu_ingredients: ["Onion"] });
  assert.equal(payload.items[0].kitchen_note, "NO ONION");
});
