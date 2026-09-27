// READY POS Phase D — desktop Open Dine-In sent-line editing.
// The server op (pos_edit_order_line) is proven on staging. These tests lock the
// desktop request shaping and the safety-relevant client wiring.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { buildSetQuantityPayload, buildChangeModifiersPayload } from "@/lib/pos/orders";

const here = dirname(fileURLToPath(import.meta.url));
const src = (p: string) => readFileSync(join(here, "..", "src", p), "utf8").replace(/\r\n/g, "\n");

test("buildSetQuantityPayload: set_quantity shape with version + op id", () => {
  const p = buildSetQuantityPayload({ orderId: "o1", lineId: "l1", newQuantity: 3, expectedVersion: 5, clientOpId: "op1" });
  assert.equal(p.op, "set_quantity");
  assert.equal(p.order_id, "o1");
  assert.equal(p.target_item_id, "l1");
  assert.equal(p.new_quantity, 3);
  assert.equal(p.expected_version, 5);
  assert.equal(p.client_op_id, "op1");
  assert.equal("modifiers" in p, false);
});

test("buildSetQuantityPayload: 0 is a full remove (still set_quantity)", () => {
  const p = buildSetQuantityPayload({ orderId: "o1", lineId: "l1", newQuantity: 0, expectedVersion: 2, clientOpId: "op2" });
  assert.equal(p.op, "set_quantity");
  assert.equal(p.new_quantity, 0);
});

test("buildChangeModifiersPayload: change_modifiers maps the new configuration", () => {
  const p = buildChangeModifiersPayload({
    orderId: "o1", lineId: "l1", quantity: 2,
    modifiers: [{ group_id: "g", option_id: "opt", name: "No Cheese", price_delta: 0, quantity: 1 }],
    expectedVersion: 7, clientOpId: "op3",
  });
  assert.equal(p.op, "change_modifiers");
  assert.equal(p.quantity, 2);
  assert.equal(p.expected_version, 7);
  assert.deepEqual(p.modifiers, [{ group_id: "g", option_id: "opt", name: "No Cheese", price_delta: 0, quantity: 1 }]);
});

test("orders.ts: editOrderLine calls the pos_edit_order_line RPC", () => {
  const s = src("lib/pos/orders.ts");
  assert.match(s, /callPosRpc\("pos_edit_order_line", \{ p_payload: payload \}\)/);
});

test("rpc.ts: pos_edit_order_line is on the allow-list", () => {
  const s = src("lib/pos/rpc.ts");
  assert.match(s, /"pos_edit_order_line"/);
});

test("tableBill.ts: loads pos_entity_version and menu_item_id for editing", () => {
  const s = src("lib/pos/tableBill.ts");
  assert.match(s, /pos_entity_version/);
  assert.match(s, /menu_item_id/);
});

test("DineInWorkspace: gates sent-line edit on pos.edit_orders and sends expected_version", () => {
  const s = src("screens/pos/DineInWorkspace.tsx");
  assert.match(s, /canEditOrders\(pos\.access\)/);
  assert.match(s, /expectedVersion: order\.pos_entity_version/);
  assert.match(s, /clientOpId: crypto\.randomUUID\(\)/);
  // re-reads the authoritative bill after an edit (and on failure)
  assert.match(s, /tables\.loadBill\(ctx\)/);
});

test("DineInRoundPanel: sent-line edit controls only render under canEditSent", () => {
  const s = src("components/pos/DineInRoundPanel.tsx");
  assert.match(s, /props\.canEditSent &&/);
  assert.match(s, /onEditSentQty\?\.\(l, -1\)/);
  assert.match(s, /onEditSentQty\?\.\(l, 1\)/);
  assert.match(s, /onRemoveSentLine\?\.\(l\)/);
  // decrease is disabled at qty 1 (full removal is the explicit ✕)
  assert.match(s, /l\.quantity <= 1/);
});

test("ModifierDialog pre-fill props are backward compatible (add flow unchanged by default)", () => {
  const s = src("components/pos/ModifierDialog.tsx");
  assert.match(s, /setSelected\(props\.initialModifiers \?\? \[\]\)/);
  assert.match(s, /props\.confirmLabel \?\? "Add to order"/);
});
