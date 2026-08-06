// The shared cart, used as a dine-in round buffer.
//
// Level 2B deliberately reuses ONE cart store rather than adding a second one.
// That makes ownership the safety mechanism: without it, half-built takeaway
// lines would appear inside a table's round and be sent to that table's kitchen
// ticket. These cases pin ownership, and the operation-id lifecycle that makes a
// retry a replay rather than a second batch.

import { test } from "node:test";
import assert from "node:assert/strict";

import { sameOwner, selectItemCount, selectSubtotal, useCart, type CartOwner } from "@/state/cart";

const TAKEAWAY: CartOwner = { kind: "takeaway" };
const TABLE_5: CartOwner = { kind: "table", tableId: "table-5" };
const TABLE_9: CartOwner = { kind: "table", tableId: "table-9" };

const fresh = () => {
  useCart.getState().reset();
  return useCart.getState();
};

const add = (name = "Margherita", price = 7) =>
  useCart.getState().addLine({ menuItemId: `item-${name}`, name, basePrice: price });

test("ownership compares tables by id, not by kind alone", () => {
  assert.equal(sameOwner(TABLE_5, TABLE_5), true);
  assert.equal(sameOwner(TABLE_5, TABLE_9), false);
  assert.equal(sameOwner(TAKEAWAY, TAKEAWAY), true);
  assert.equal(sameOwner(TAKEAWAY, TABLE_5), false);
  assert.equal(sameOwner(null, null), true);
  assert.equal(sameOwner(null, TABLE_5), false);
});

test("an empty buffer can be claimed by anyone", () => {
  fresh();
  assert.equal(useCart.getState().claim(TAKEAWAY), true);
  assert.equal(useCart.getState().claim(TABLE_5), true, "still empty, so the claim moves freely");
  assert.deepEqual(useCart.getState().owner, TABLE_5);
});

test("a non-empty buffer refuses a different owner", () => {
  fresh();
  useCart.getState().claim(TABLE_5);
  add();
  assert.equal(useCart.getState().claim(TABLE_5), true, "the same table may keep adding");
  assert.equal(useCart.getState().claim(TABLE_9), false, "another table must not join this round");
  assert.equal(useCart.getState().claim(TAKEAWAY), false, "takeaway must not join a table's round");
});

test("takeaway lines can never be absorbed into a table round", () => {
  fresh();
  useCart.getState().claim(TAKEAWAY);
  add("Pepsi", 1.5);
  assert.equal(useCart.getState().claim(TABLE_5), false);
  assert.deepEqual(useCart.getState().owner, TAKEAWAY, "the refused claim left ownership alone");
});

test("reset releases ownership, so the next context starts clean", () => {
  fresh();
  useCart.getState().claim(TABLE_5);
  add();
  useCart.getState().reset();
  assert.equal(useCart.getState().owner, null);
  assert.equal(useCart.getState().lines.length, 0);
  assert.equal(useCart.getState().claim(TAKEAWAY), true);
});

// --- operation id lifecycle --------------------------------------------------

test("an operation id is minted when the first line lands in an empty round", () => {
  fresh();
  assert.equal(useCart.getState().clientOpId, null, "an empty round has no id to replay");
  add();
  const id = useCart.getState().clientOpId;
  assert.ok(id, "adding the first line must mint the round's id");
  assert.equal(typeof id, "string");
});

test("the same id survives every edit to that round", () => {
  fresh();
  add("Margherita");
  const id = useCart.getState().clientOpId;
  add("Pepsi", 1.5);
  const key = useCart.getState().lines[0].key;
  useCart.getState().adjustQuantity(key, 1);
  useCart.getState().setNote(key, "no basil");
  useCart.getState().removeLine(useCart.getState().lines[1].key);
  assert.equal(useCart.getState().clientOpId, id, "editing a round must not change which round it is");
});

test("ensureOpId is stable - repeated calls return one id", () => {
  fresh();
  add();
  const a = useCart.getState().ensureOpId();
  const b = useCart.getState().ensureOpId();
  assert.equal(a, b);
  assert.equal(a, useCart.getState().clientOpId);
});

test("only reset mints a new round - this is what separates round 1 from round 2", () => {
  fresh();
  add();
  const round1 = useCart.getState().ensureOpId();
  // Accepted by the server -> the buffer clears.
  useCart.getState().reset();
  add();
  const round2 = useCart.getState().ensureOpId();
  assert.notEqual(round1, round2, "round 2 reused round 1's id - the server would replay instead of appending");
});

test("minted ids are unique across many rounds", () => {
  const ids = new Set<string>();
  for (let i = 0; i < 25; i += 1) {
    fresh();
    add();
    ids.add(useCart.getState().ensureOpId());
  }
  assert.equal(ids.size, 25);
});

// --- buffer arithmetic -------------------------------------------------------

test("the round subtotal is the sum the server will compute", () => {
  fresh();
  useCart.getState().addLine({
    menuItemId: "i1",
    name: "Margherita",
    basePrice: 7,
    quantity: 2,
    modifiers: [{ group_id: "g1", option_id: "o1", name: "Large", price_delta: 1, quantity: 1 }],
  });
  useCart.getState().addLine({ menuItemId: "i2", name: "Pepsi", basePrice: 1.5 });
  // (7 + 1) * 2 + 1.5
  assert.equal(selectSubtotal(useCart.getState().lines), 17.5);
  assert.equal(selectItemCount(useCart.getState().lines), 3);
});

test("identical configurations merge, differing notes do not", () => {
  fresh();
  add("Margherita");
  add("Margherita");
  assert.equal(useCart.getState().lines.length, 1);
  assert.equal(useCart.getState().lines[0].quantity, 2);

  useCart.getState().addLine({ menuItemId: "item-Margherita", name: "Margherita", basePrice: 7, note: "well done" });
  assert.equal(useCart.getState().lines.length, 2, "a different kitchen note is a different line");
});

test("a removed line can be undone without disturbing the round id", () => {
  fresh();
  add("Margherita");
  const id = useCart.getState().clientOpId;
  const key = useCart.getState().lines[0].key;
  useCart.getState().removeLine(key);
  assert.equal(useCart.getState().lines.length, 0);
  useCart.getState().undoRemove();
  assert.equal(useCart.getState().lines.length, 1);
  assert.equal(useCart.getState().clientOpId, id);
});
