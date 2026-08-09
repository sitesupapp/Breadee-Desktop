// The delivery ordering contract, and the two guards the server does not have.
//
// `pos_save_order` stores `customer_id` and `address_id` exactly as given. It
// does not check that the customer belongs to the tenant, and it does not check
// that the address belongs to the customer. Both facts were read from the
// staging function definition, and between them they are why this file exists:
// every assertion below is a check that only the client can make.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AddressRequiredError,
  CustomerRequiredError,
  ShiftRequiredError,
  buildSubmitPayload,
} from "@/lib/pos/orders";
import {
  DELIVERY_PAYLOAD_KEYS,
  FORBIDDEN_DELIVERY_FIELDS,
  buildDeliveryPayload,
  createDeliveryLatch,
  deliveryOrderGate,
} from "@/lib/pos/deliveryOrder";
import { sameOwner, type CartOwner } from "@/state/cart";
import type { CartLine } from "@/types/pos";

const allow = { allowed: true, reason: null };

const line = (over: Partial<CartLine> = {}): CartLine => ({
  key: "k1",
  menu_item_id: "m1",
  name: "Margherita",
  base_price: 7,
  quantity: 1,
  modifiers: [],
  kitchen_note: null,
  ...over,
});

const base = {
  branchId: "b1",
  shiftId: "s1",
  clientOpId: "op-1",
  lines: [line()],
  customerId: "c1",
  addressId: "a1",
};

// --- cart ownership (P0) -----------------------------------------------------

test("a delivery cart is owned by ONE customer", () => {
  const a: CartOwner = { kind: "delivery", customerId: "cust-a" };
  const b: CartOwner = { kind: "delivery", customerId: "cust-b" };
  assert.equal(sameOwner(a, a), true);
  assert.equal(sameOwner(a, { kind: "delivery", customerId: "cust-a" }), true);
  // THE ONE THAT MATTERS. Before Level 3B the comparison fell through to
  // `a.tableId === b.tableId` for two delivery owners - undefined === undefined -
  // and answered TRUE, which would have let customer A's basket be submitted
  // against customer B's name and address.
  assert.equal(sameOwner(a, b), false);
});

test("delivery never shares a cart with takeaway or a table", () => {
  const delivery: CartOwner = { kind: "delivery", customerId: "c1" };
  assert.equal(sameOwner(delivery, { kind: "takeaway" }), false);
  assert.equal(sameOwner(delivery, { kind: "table", tableId: "t1" }), false);
  assert.equal(sameOwner({ kind: "takeaway" }, delivery), false);
  assert.equal(sameOwner({ kind: "table", tableId: "t1" }, delivery), false);
});

test("the pre-existing owners still behave exactly as they did", () => {
  assert.equal(sameOwner({ kind: "takeaway" }, { kind: "takeaway" }), true);
  assert.equal(sameOwner({ kind: "table", tableId: "t1" }, { kind: "table", tableId: "t1" }), true);
  assert.equal(sameOwner({ kind: "table", tableId: "t1" }, { kind: "table", tableId: "t2" }), false);
  assert.equal(sameOwner(null, null), true);
  assert.equal(sameOwner(null, { kind: "takeaway" }), false);
});

// --- payload -----------------------------------------------------------------

test("a delivery payload carries the customer and address, and the delivery type", () => {
  const p = buildDeliveryPayload({ ...base, orderNote: "Ring twice" });
  assert.equal(p.order_type, "delivery");
  assert.equal(p.customer_id, "c1");
  assert.equal(p.address_id, "a1");
  assert.equal(p.status, "sent_to_kitchen");
  assert.equal(p.shift_id, "s1");
  assert.equal(p.client_op_id, "op-1");
  assert.equal(p.notes, "Ring twice");
});

test("only the keys pos_save_order reads are present", () => {
  const p = buildDeliveryPayload({ ...base, orderNote: "note" });
  for (const key of Object.keys(p)) {
    assert.ok(DELIVERY_PAYLOAD_KEYS.includes(key as never), `unexpected key ${key}`);
  }
});

test("no payment or discount field is ever sent", () => {
  const p = buildDeliveryPayload({ ...base, orderNote: "note" }) as Record<string, unknown>;
  for (const f of FORBIDDEN_DELIVERY_FIELDS) {
    assert.equal(f in p, false, `${f} must not be sent`);
  }
  // discount_amount heads that list because pos_pay_order recomputes and
  // overwrites it at settlement - recording one here would be silently replaced.
  assert.equal(FORBIDDEN_DELIVERY_FIELDS[0], "discount_amount");
});

test("a delivery payload carries no table_id", () => {
  const p = buildDeliveryPayload(base) as Record<string, unknown>;
  assert.equal("table_id" in p, false);
});

test("takeaway and dine-in payloads gain no delivery fields", () => {
  const takeaway = buildSubmitPayload({
    branchId: "b1",
    shiftId: "s1",
    orderType: "takeaway",
    clientOpId: "op-1",
    lines: [line()],
  }) as Record<string, unknown>;
  assert.equal("customer_id" in takeaway, false);
  assert.equal("address_id" in takeaway, false);
  assert.equal("table_id" in takeaway, false);

  const dineIn = buildSubmitPayload({
    branchId: "b1",
    shiftId: "s1",
    orderType: "dine_in",
    clientOpId: "op-1",
    lines: [line()],
    tableId: "t1",
  }) as Record<string, unknown>;
  assert.equal("customer_id" in dineIn, false);
  assert.equal("address_id" in dineIn, false);
  assert.equal(dineIn.table_id, "t1");
});

test("items and modifiers keep the shape the server iterates over", () => {
  const p = buildDeliveryPayload({
    ...base,
    lines: [
      line({
        quantity: 2,
        kitchen_note: "  no onions  ",
        modifiers: [{ group_id: "g1", option_id: "o1", name: "Large", price_delta: 1.5, quantity: 1 }],
      }),
    ],
  });
  assert.equal(p.items.length, 1);
  assert.deepEqual(p.items[0], {
    menu_item_id: "m1",
    name: "Margherita",
    base_price: 7,
    quantity: 2,
    kitchen_note: "no onions",
    modifiers: [{ group_id: "g1", option_id: "o1", name: "Large", price_delta: 1.5, quantity: 1 }],
  });
});

test("an order-level note and an item note stay separate fields", () => {
  // `pos_save_order` reads `notes` on the order and `kitchen_note` per item.
  // Concatenating them would put the driver's instructions on the kitchen ticket.
  const p = buildDeliveryPayload({
    ...base,
    orderNote: "Leave at the gate",
    lines: [line({ kitchen_note: "extra spicy" })],
  });
  assert.equal(p.notes, "Leave at the gate");
  assert.equal(p.items[0].kitchen_note, "extra spicy");
});

test("a blank order note is sent as null, not an empty string", () => {
  assert.equal(buildDeliveryPayload({ ...base, orderNote: "   " }).notes, null);
  assert.equal(buildDeliveryPayload(base).notes, null);
});

// --- refusals before the request exists --------------------------------------

test("a delivery order without a customer is refused", () => {
  assert.throws(() => buildDeliveryPayload({ ...base, customerId: null }), CustomerRequiredError);
});

test("a delivery order without an address is refused", () => {
  // The web POS refuses the same case, so this matches the product rather than
  // inventing a stricter desktop rule.
  assert.throws(() => buildDeliveryPayload({ ...base, addressId: null }), AddressRequiredError);
});

test("a delivery order without a shift is refused", () => {
  // Server-optional, but an order with a null shift can never be paid:
  // `_pos_lock_open_shift` raises on it, and the cash box filters by shift_id.
  assert.throws(() => buildDeliveryPayload({ ...base, shiftId: null }), ShiftRequiredError);
});

// --- the gate ----------------------------------------------------------------

const gateBase = {
  deliveryAccess: allow,
  createOrders: allow,
  hasOpenShift: true,
  online: true,
  customerId: "c1",
  addressId: "a1",
  lineCount: 1,
  sending: false,
};

test("the gate opens only when every precondition holds", () => {
  assert.equal(deliveryOrderGate(gateBase).allowed, true);
});

test("the gate refuses in the order an operator can act on", () => {
  assert.match(deliveryOrderGate({ ...gateBase, customerId: null }).reason ?? "", /Choose a customer/i);
  assert.match(deliveryOrderGate({ ...gateBase, addressId: null }).reason ?? "", /delivery address/i);
  assert.match(deliveryOrderGate({ ...gateBase, lineCount: 0 }).reason ?? "", /at least one item/i);
  assert.match(deliveryOrderGate({ ...gateBase, hasOpenShift: false }).reason ?? "", /Open a shift/i);
  assert.match(deliveryOrderGate({ ...gateBase, online: false }).reason ?? "", /needs a connection/i);
  assert.match(deliveryOrderGate({ ...gateBase, sending: true }).reason ?? "", /already being sent/i);
});

test("access and order-creation refusals come first, with the server's wording", () => {
  const noDelivery = { allowed: false, reason: "Delivery is not enabled for this plan." };
  assert.equal(deliveryOrderGate({ ...gateBase, deliveryAccess: noDelivery }).reason, noDelivery.reason);
  const noCreate = { allowed: false, reason: "You do not have permission to create orders." };
  assert.equal(deliveryOrderGate({ ...gateBase, createOrders: noCreate }).reason, noCreate.reason);
});

test("taking payments is NOT required to send a delivery order", () => {
  // A cashier who may take orders but not money must still be able to work here.
  // The gate has no payment input at all, which is the strongest form of that.
  assert.equal("takePayments" in gateBase, false);
  assert.equal(deliveryOrderGate(gateBase).allowed, true);
});

// --- the latch ---------------------------------------------------------------

test("the latch admits one sender and refuses the rest synchronously", () => {
  const latch = createDeliveryLatch();
  assert.equal(latch.acquire(), true);
  assert.equal(latch.acquire(), false);
  assert.equal(latch.held(), true);
  latch.release();
  assert.equal(latch.acquire(), true);
});
