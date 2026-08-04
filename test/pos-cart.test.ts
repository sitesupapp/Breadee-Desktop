// Cart behaviour, including the two things that protect money:
//   * one client_op_id per logical order, cleared only on definitive completion,
//   * a saved order is invalidated the moment the cart changes, so a payment can
//     never settle a stale order.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { selectItemCount, selectSubtotal, useCart } from "@/state/cart";
import type { SelectedModifier, SubmitOrderResult } from "@/types/pos";

const savedOrder: SubmitOrderResult = {
  order_id: "order-1",
  order_number: "260804-0001",
  subtotal: 10,
  total: 10,
};

const cheese: SelectedModifier[] = [
  { group_id: "g1", option_id: "o1", name: "Extra cheese", price_delta: 0.5, quantity: 1 },
];

beforeEach(() => {
  useCart.getState().reset();
});

test("adding an item mints exactly one operation id for the cart", () => {
  const cart = useCart.getState();
  assert.equal(cart.clientOpId, null);
  cart.addLine({ menuItemId: "i1", name: "Fries", basePrice: 2.5 });
  const opId = useCart.getState().clientOpId;
  assert.ok(opId);

  useCart.getState().addLine({ menuItemId: "i2", name: "Cola", basePrice: 1.5 });
  assert.equal(useCart.getState().clientOpId, opId, "a second item must not mint a new operation id");
});

test("ensureOpId is stable across repeated calls", () => {
  useCart.getState().addLine({ menuItemId: "i1", name: "Fries", basePrice: 2.5 });
  const a = useCart.getState().ensureOpId();
  const b = useCart.getState().ensureOpId();
  assert.equal(a, b);
});

test("reset clears the operation id so the NEXT order is a new logical order", () => {
  useCart.getState().addLine({ menuItemId: "i1", name: "Fries", basePrice: 2.5 });
  const first = useCart.getState().clientOpId;
  useCart.getState().reset();
  assert.equal(useCart.getState().clientOpId, null);

  useCart.getState().addLine({ menuItemId: "i1", name: "Fries", basePrice: 2.5 });
  assert.notEqual(useCart.getState().clientOpId, first);
});

test("editing the cart invalidates a saved order so payment cannot settle a stale one", () => {
  const cart = useCart.getState();
  cart.addLine({ menuItemId: "i1", name: "Fries", basePrice: 2.5 });
  useCart.getState().setSavedOrder(savedOrder);
  assert.deepEqual(useCart.getState().savedOrder, savedOrder);

  useCart.getState().adjustQuantity(useCart.getState().lines[0].key, 1);
  assert.equal(useCart.getState().savedOrder, null);
});

test("identical configurations merge; different modifiers stay separate lines", () => {
  const cart = useCart.getState();
  cart.addLine({ menuItemId: "i1", name: "Burger", basePrice: 5 });
  cart.addLine({ menuItemId: "i1", name: "Burger", basePrice: 5 });
  assert.equal(useCart.getState().lines.length, 1);
  assert.equal(useCart.getState().lines[0].quantity, 2);

  useCart.getState().addLine({ menuItemId: "i1", name: "Burger", basePrice: 5, modifiers: cheese });
  assert.equal(useCart.getState().lines.length, 2);
});

test("a line with a different note is a different line", () => {
  const cart = useCart.getState();
  cart.addLine({ menuItemId: "i1", name: "Burger", basePrice: 5, note: "well done" });
  cart.addLine({ menuItemId: "i1", name: "Burger", basePrice: 5 });
  assert.equal(useCart.getState().lines.length, 2);
});

test("removing a line is undoable and restores it in place", () => {
  const cart = useCart.getState();
  cart.addLine({ menuItemId: "a", name: "A", basePrice: 1 });
  cart.addLine({ menuItemId: "b", name: "B", basePrice: 2 });
  cart.addLine({ menuItemId: "c", name: "C", basePrice: 3 });

  const middle = useCart.getState().lines[1].key;
  useCart.getState().removeLine(middle);
  assert.deepEqual(
    useCart.getState().lines.map((l) => l.name),
    ["A", "C"],
  );

  useCart.getState().undoRemove();
  assert.deepEqual(
    useCart.getState().lines.map((l) => l.name),
    ["A", "B", "C"],
    "the restored line returns to its original position",
  );
});

test("a note stays attached to the line it was written for", () => {
  const cart = useCart.getState();
  cart.addLine({ menuItemId: "a", name: "A", basePrice: 1 });
  cart.addLine({ menuItemId: "b", name: "B", basePrice: 2 });

  const second = useCart.getState().lines[1].key;
  useCart.getState().setNote(second, "no ice");

  const lines = useCart.getState().lines;
  assert.equal(lines[0].kitchen_note, null);
  assert.equal(lines[1].kitchen_note, "no ice");

  // ...and survives a quantity change on the OTHER line.
  useCart.getState().adjustQuantity(lines[0].key, 1);
  assert.equal(useCart.getState().lines[1].kitchen_note, "no ice");
});

test("quantity never drops below one via adjust", () => {
  const cart = useCart.getState();
  cart.addLine({ menuItemId: "a", name: "A", basePrice: 1 });
  const key = useCart.getState().lines[0].key;
  useCart.getState().adjustQuantity(key, -5);
  assert.equal(useCart.getState().lines[0].quantity, 1);
});

test("selection moves within bounds", () => {
  const cart = useCart.getState();
  cart.addLine({ menuItemId: "a", name: "A", basePrice: 1 });
  cart.addLine({ menuItemId: "b", name: "B", basePrice: 2 });

  useCart.getState().select(useCart.getState().lines[0].key);
  useCart.getState().moveSelection(-1);
  assert.equal(useCart.getState().selectedKey, useCart.getState().lines[0].key);

  useCart.getState().moveSelection(1);
  assert.equal(useCart.getState().selectedKey, useCart.getState().lines[1].key);

  useCart.getState().moveSelection(5);
  assert.equal(useCart.getState().selectedKey, useCart.getState().lines[1].key);
});

test("subtotal and item count include modifiers and quantities", () => {
  const cart = useCart.getState();
  cart.addLine({ menuItemId: "a", name: "A", basePrice: 5, quantity: 2, modifiers: cheese });
  cart.addLine({ menuItemId: "b", name: "B", basePrice: 2.5 });

  const lines = useCart.getState().lines;
  assert.equal(selectSubtotal(lines), 13.5); // (5 + 0.5) * 2 + 2.5
  assert.equal(selectItemCount(lines), 3);
});
