// Delivery operations (Delivery Management): the contract, and the firewall.
//
// The internal Delivered-By / Delivery-Cost editor and the delivery report add a
// write and a read, and NOTHING that can move the customer's money. This file
// pins that: `pos_set_delivery_ops` sends only its own five parameters and never
// a fee/total/payment; the delivery COST and MARGIN are shown in the operations
// panel and the report but NEVER on the customer receipt; and the null-vs-zero
// and margin arithmetic is exactly the server's.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DELIVERY_OPS_PARAM_KEYS,
  FORBIDDEN_DELIVERY_OPS_FIELDS,
  isCollected,
  parseDeliveryCost,
  recordedMargin,
} from "@/lib/pos/deliveryOrderManagement";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url).pathname.replace(/^\//, ""), "utf8");

// --- the parameter contract --------------------------------------------------

test("pos_set_delivery_ops takes exactly its five parameters, and nothing that moves money", () => {
  assert.deepEqual([...DELIVERY_OPS_PARAM_KEYS], [
    "p_order_id",
    "p_delivery_handler_type",
    "p_delivered_by_user_id",
    "p_delivery_person_ref",
    "p_delivery_cost",
  ]);
  // No forbidden field is smuggled into the accepted set.
  for (const forbidden of FORBIDDEN_DELIVERY_OPS_FIELDS) {
    assert.equal(
      (DELIVERY_OPS_PARAM_KEYS as readonly string[]).includes(forbidden),
      false,
      `${forbidden} must never be an accepted delivery-ops parameter`,
    );
  }
  // The forbidden list actually names the customer-money fields, so a future edit
  // that reached for one would trip this rather than pass silently.
  for (const f of ["delivery_fee", "subtotal", "total_amount", "payment_status"]) {
    assert.ok((FORBIDDEN_DELIVERY_OPS_FIELDS as readonly string[]).includes(f), `${f} should be forbidden`);
  }
});

test("the writer sends ONLY the five parameters - never a fee, total, payment or tax", () => {
  const src = read("../src/lib/pos/deliveryOrderManagement.ts");
  // The one call site that writes the ops. Isolate its argument object.
  const call = /callPosRpc\("pos_set_delivery_ops",\s*\{([\s\S]*?)\}\s*\)/.exec(src);
  assert.ok(call, "the pos_set_delivery_ops call site could not be located");
  const args = call[1];
  for (const key of DELIVERY_OPS_PARAM_KEYS) {
    assert.ok(args.includes(`${key}:`), `${key} must be sent`);
  }
  for (const forbidden of FORBIDDEN_DELIVERY_OPS_FIELDS) {
    assert.equal(args.includes(`${forbidden}:`), false, `${forbidden} must never be sent to pos_set_delivery_ops`);
  }
  // And the desktop never writes these columns directly - the RPC is the sole path.
  assert.equal(
    /\.from\("pos_orders"\)\s*\.update\(/.test(src),
    false,
    "delivery ops must go through pos_set_delivery_ops, never a direct pos_orders update",
  );
});

// --- null vs zero, and the margin --------------------------------------------

test("parseDeliveryCost keeps UNKNOWN (null) distinct from an explicit 0", () => {
  assert.deepEqual(parseDeliveryCost(""), { valid: true, value: null, provided: false });
  assert.deepEqual(parseDeliveryCost("   "), { valid: true, value: null, provided: false });
  assert.deepEqual(parseDeliveryCost("0"), { valid: true, value: 0, provided: true });
  assert.deepEqual(parseDeliveryCost("2.5"), { valid: true, value: 2.5, provided: true });
  assert.equal(parseDeliveryCost("-1").valid, false);
  assert.equal(parseDeliveryCost("abc").valid, false);
});

test("recordedMargin is fee - cost ONLY where a cost is known - never fee-as-profit", () => {
  assert.equal(recordedMargin({ delivery_fee: 10, delivery_cost: null }), null, "no cost => no margin");
  assert.equal(recordedMargin({ delivery_fee: 10, delivery_cost: 4 }), 6);
  assert.equal(recordedMargin({ delivery_fee: 5, delivery_cost: 0 }), 5, "a free fulfilment is full margin");
  assert.equal(recordedMargin({ delivery_fee: null, delivery_cost: 3 }), -3, "a cost with no fee is a loss");
});

test("collection follows payment status - it is not a separate flag", () => {
  assert.equal(isCollected({ payment_status: "paid" }), true);
  assert.equal(isCollected({ payment_status: "unpaid" }), false);
  assert.equal(isCollected({ payment_status: "refunded" }), false);
});

// --- the receipt firewall ----------------------------------------------------

test("the customer receipt shows the delivery FEE but never the internal cost or margin", () => {
  // The fee is the customer's charge and belongs on the receipt; the cost and the
  // recorded margin are the business's own record and must never be printed.
  for (const rel of ["../src/lib/receipt.ts", "../src/lib/nativePrinting.ts", "../src/screens/pos/ReceiptPreview.tsx"]) {
    const src = read(rel);
    for (const banned of ["delivery_cost", "deliveryCost", "delivery_margin", "deliveryMargin", "recordedMargin"]) {
      assert.equal(src.includes(banned), false, `${rel} must not reference ${banned} - it is not customer-facing`);
    }
  }
});

test("the operations panel shows the cost and margin - that is where they belong", () => {
  // The counterpart to the firewall above: the internal panel DOES surface them,
  // so the check above is proving isolation, not that the fields are unused.
  const detail = read("../src/components/pos/DeliveryOrderDetail.tsx");
  assert.ok(detail.includes("recordedMargin"), "the detail panel should compute the recorded margin");
  assert.ok(/Delivery cost/i.test(detail), "the detail panel should label the delivery cost");
  assert.ok(/Recorded margin/i.test(detail), "the detail panel should label the recorded margin");
});
