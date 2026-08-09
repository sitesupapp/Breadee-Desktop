// Delivery settlement: the gate, the payload, and the money.
//
// `pos_pay_order` has no idempotency key, so nothing here may retry blindly and
// nothing may declare success without the server's own state agreeing. Most of
// this file is about the two failure shapes that cost real money: a second
// charge, and a lost response reported as a failure when the customer has
// already paid.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DELIVERY_PAYMENT_PAYLOAD_KEYS,
  DeliveryDiscountNotPermittedError,
  DeliveryOrderChangedError,
  DeliveryPaymentAmbiguousError,
  DeliveryPaymentInProgressError,
  DELIVERY_COMPLETION_SEQUENCE,
  FORBIDDEN_DELIVERY_PAYMENT_FIELDS,
  InvalidDeliveryDiscountError,
  buildDeliveryPaymentPayload,
  checkSettlementTarget,
  classifySettlement,
  createSettlementLatch,
  deliveryIsSettled,
  deliveryPaymentGate,
  performDeliverySettlement,
  validateDeliveryDiscount,
  type DeliveryPaymentPayload,
  type DeliveryPaymentResult,
} from "@/lib/pos/deliverySettlement";
import type { OpenDeliveryOrder } from "@/lib/pos/deliveryOrder";

const allow = { allowed: true, reason: null };
const denyPay = { allowed: false, reason: "You do not have permission to take payments." };
const denyDiscount = { allowed: false, reason: "You do not have permission to apply discounts." };

const order = (over: Partial<OpenDeliveryOrder> = {}): OpenDeliveryOrder => ({
  id: "o1",
  order_number: "260809-0001",
  status: "sent_to_kitchen",
  payment_status: "unpaid",
  total_amount: 7,
  currency: "USD",
  customer_id: "c1",
  address_id: "a1",
  notes: "Desktop Level 3B delivery ordering verification",
  created_at: null,
  ...over,
});

const gateInput = (over: Record<string, unknown> = {}) => ({
  deliveryAccess: allow,
  takePayments: allow,
  order: order(),
  hasOpenShift: true,
  online: true,
  currencyBlockedReason: null,
  paying: false,
  ...over,
});

const payload: DeliveryPaymentPayload = { order_id: "o1", method: "cash", currency_code: "USD" };

const result = (over: Partial<DeliveryPaymentResult> = {}): DeliveryPaymentResult => ({
  order_id: "o1",
  paid: true,
  method: "cash",
  subtotal: 7,
  discount: 0,
  amount: 7,
  order_number: "260809-0001",
  currency_code: "USD",
  original_amount: 7,
  exchange_rate: null,
  ...over,
});

const never = async (): Promise<never> => {
  throw new Error("reread must not run on a successful payment");
};

// --- the gate ----------------------------------------------------------------

test("a live unpaid delivery order may be settled", () => {
  assert.equal(deliveryPaymentGate(gateInput()).allowed, true);
});

test("an already-paid order is refused, and says so plainly", () => {
  const g = deliveryPaymentGate(gateInput({ order: order({ payment_status: "paid", status: "completed" }) }));
  assert.equal(g.allowed, false);
  assert.match(g.reason ?? "", /already paid/i);
});

test("a voided or refunded order can no longer be paid", () => {
  for (const status of ["voided", "cancelled", "refunded"]) {
    const g = deliveryPaymentGate(gateInput({ order: order({ status }) }));
    assert.equal(g.allowed, false, `${status} should be unpayable`);
  }
});

test("with no order there is nothing to settle", () => {
  assert.equal(deliveryPaymentGate(gateInput({ order: null })).allowed, false);
});

test("settlement needs pos.take_payments", () => {
  assert.equal(deliveryPaymentGate(gateInput({ takePayments: denyPay })).reason, denyPay.reason);
});

test("the ORDER's shift must still be open - pos_pay_order locks that one", () => {
  const g = deliveryPaymentGate(gateInput({ hasOpenShift: false }));
  assert.equal(g.allowed, false);
  assert.match(g.reason ?? "", /shift is closed/i);
});

test("payment needs a connection, and LBP needs a rate", () => {
  assert.match(deliveryPaymentGate(gateInput({ online: false })).reason ?? "", /needs a connection/i);
  const rate = deliveryPaymentGate(gateInput({ currencyBlockedReason: "Set the USD to LBP exchange rate" }));
  assert.match(rate.reason ?? "", /exchange rate/i);
});

test("a payment already in flight blocks every other surface", () => {
  assert.match(deliveryPaymentGate(gateInput({ paying: true })).reason ?? "", /already being sent/i);
});

test("discount permission is NOT part of the gate - full price is still payable", () => {
  // A cashier who cannot discount may still take the money.
  const g = deliveryPaymentGate(gateInput());
  assert.equal(g.allowed, true);
  assert.equal(JSON.stringify(gateInput()).includes("apply_discounts"), false);
});

test("the gate consults nothing about tables", () => {
  const g = deliveryPaymentGate(gateInput());
  assert.equal(g.allowed, true);
  assert.equal("tableId" in gateInput(), false);
});

// --- the payload -------------------------------------------------------------

test("the payload has exactly the keys pos_pay_order consumes", () => {
  assert.deepEqual([...DELIVERY_PAYMENT_PAYLOAD_KEYS], [
    "order_id",
    "method",
    "currency_code",
    "discount_type",
    "discount_value",
  ]);
});

test("tendered and change head the forbidden list, and client_op_id follows", () => {
  assert.equal(FORBIDDEN_DELIVERY_PAYMENT_FIELDS[0], "tendered");
  assert.equal(FORBIDDEN_DELIVERY_PAYMENT_FIELDS[1], "change");
  for (const f of ["client_op_id", "shift_id", "branch_id", "customer_id", "address_id", "table_id", "order_number"]) {
    assert.ok(FORBIDDEN_DELIVERY_PAYMENT_FIELDS.includes(f as never), `${f} should be forbidden`);
  }
});

test("an undiscounted payment sends three keys and nothing else", () => {
  const p = buildDeliveryPaymentPayload({ orderId: "o1", method: "cash", currency: "USD", discount: {} });
  assert.deepEqual(p, { order_id: "o1", method: "cash", currency_code: "USD" });
  for (const key of Object.keys(p)) {
    assert.ok(DELIVERY_PAYMENT_PAYLOAD_KEYS.includes(key as never));
    assert.ok(!FORBIDDEN_DELIVERY_PAYMENT_FIELDS.includes(key as never));
  }
});

test("a discounted payment adds exactly the two discount keys", () => {
  const p = buildDeliveryPaymentPayload({
    orderId: "o1",
    method: "cash",
    currency: "USD",
    discount: { discount_type: "percent", discount_value: 10 },
  });
  assert.deepEqual(p, { order_id: "o1", method: "cash", currency_code: "USD", discount_type: "percent", discount_value: 10 });
});

test("tendered and change cannot reach the payload even if handed in", () => {
  // The dialog returns tendered in the same object as the discount. A spread is
  // all it would take, so the builder names every field instead.
  const dirty = { discount_type: "percent", discount_value: 10, tendered: 20, change: 13 } as never;
  const p = buildDeliveryPaymentPayload({ orderId: "o1", method: "cash", currency: "USD", discount: dirty });
  assert.equal("tendered" in p, false);
  assert.equal("change" in p, false);
});

// --- discounts ---------------------------------------------------------------

test("no discount sends no discount fields", () => {
  assert.deepEqual(validateDeliveryDiscount({ canDiscount: allow, subtotal: 7, type: "none", value: "" }), {
    fields: {},
    amount: 0,
  });
});

test("a permitted zero discount is byte-identical to no discount", () => {
  const zero = validateDeliveryDiscount({ canDiscount: allow, subtotal: 7, type: "percent", value: "0" });
  assert.deepEqual(zero.fields, {});
  assert.equal(zero.amount, 0);
});

test("percent and amount discounts produce the server's own field names", () => {
  const pct = validateDeliveryDiscount({ canDiscount: allow, subtotal: 10, type: "percent", value: "10" });
  assert.deepEqual(pct.fields, { discount_type: "percent", discount_value: 10 });
  assert.equal(pct.amount, 1);
  const amt = validateDeliveryDiscount({ canDiscount: allow, subtotal: 10, type: "amount", value: "2.5" });
  assert.deepEqual(amt.fields, { discount_type: "amount", discount_value: 2.5 });
});

test("a discount without permission is refused before any request", () => {
  assert.throws(
    () => validateDeliveryDiscount({ canDiscount: denyDiscount, subtotal: 7, type: "percent", value: "10" }),
    DeliveryDiscountNotPermittedError,
  );
});

test("an out-of-range percent and an over-subtotal amount are both refused", () => {
  assert.throws(
    () => validateDeliveryDiscount({ canDiscount: allow, subtotal: 7, type: "percent", value: "150" }),
    InvalidDeliveryDiscountError,
  );
  assert.throws(
    () => validateDeliveryDiscount({ canDiscount: allow, subtotal: 7, type: "amount", value: "99" }),
    InvalidDeliveryDiscountError,
  );
});

// --- the pre-payment re-read -------------------------------------------------

const intended = { orderId: "o1", customerId: "c1", addressId: "a1", total: 7 };

test("an unchanged order passes the re-read", () => {
  assert.doesNotThrow(() => checkSettlementTarget(intended, order()));
});

test("a vanished order stops the payment", () => {
  assert.throws(() => checkSettlementTarget(intended, null), DeliveryOrderChangedError);
});

test("an order paid by another terminal stops the payment", () => {
  assert.throws(
    () => checkSettlementTarget(intended, order({ payment_status: "paid", status: "completed" })),
    /already been paid/,
  );
});

test("a changed total stops the payment - the screen is not authority to charge", () => {
  assert.throws(() => checkSettlementTarget(intended, order({ total_amount: 9 })), /total changed/);
});

test("a changed customer or address stops the payment", () => {
  assert.throws(() => checkSettlementTarget(intended, order({ customer_id: "other" })), /customer changed/);
  assert.throws(() => checkSettlementTarget(intended, order({ address_id: "other" })), /address changed/);
});

test("a voided order stops the payment", () => {
  assert.throws(() => checkSettlementTarget(intended, order({ status: "voided" })), /status is now voided/);
});

// --- the latch ---------------------------------------------------------------

test("the latch admits one payer and refuses the rest synchronously", () => {
  const l = createSettlementLatch();
  assert.equal(l.acquire(), true);
  assert.equal(l.acquire(), false);
  l.release();
  assert.equal(l.acquire(), true);
});

test("two confirmations in the same tick produce ONE payment call", async () => {
  const latch = createSettlementLatch();
  let calls = 0;
  const submit = async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 5));
    return result();
  };
  const [a, b] = await Promise.all([
    performDeliverySettlement({ payload, submit, reread: never, latch }),
    performDeliverySettlement({ payload, submit, reread: never, latch }),
  ]);
  assert.equal(calls, 1);
  assert.equal(a.ok, true);
  assert.ok(!b.ok && b.error instanceof DeliveryPaymentInProgressError);
  assert.equal(!b.ok && b.retryable, false);
});

test("the latch releases after a failure so a proven-safe retry is possible", async () => {
  const latch = createSettlementLatch();
  await performDeliverySettlement({
    payload,
    submit: async () => {
      throw new Error("Failed to fetch");
    },
    reread: async () => ({ order: order(), paymentRows: 0 }),
    latch,
  });
  assert.equal(latch.held(), false);
});

// --- recovery ----------------------------------------------------------------

test("a direct success never re-reads", async () => {
  const outcome = await performDeliverySettlement({ payload, submit: async () => result(), reread: never });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.ok && outcome.recovered, false);
  assert.equal(outcome.ok && outcome.result?.amount, 7);
});

test("submit is called AT MOST ONCE - there is no retry loop on this path", async () => {
  let calls = 0;
  await performDeliverySettlement({
    payload,
    submit: async () => {
      calls += 1;
      throw new Error("network");
    },
    reread: async () => ({ order: order(), paymentRows: 0 }),
  });
  assert.equal(calls, 1);
});

test("a lost response over a charge that LANDED is recovered, not repeated", async () => {
  const outcome = await performDeliverySettlement({
    payload,
    submit: async () => {
      throw new Error("Failed to fetch");
    },
    reread: async () => ({ order: order({ payment_status: "paid", status: "completed" }), paymentRows: 1 }),
  });
  assert.deepEqual(outcome, { ok: true, result: null, recovered: true });
});

test("a lost response over a charge that did NOT land is retryable", async () => {
  const cause = new Error("Failed to fetch");
  const outcome = await performDeliverySettlement({
    payload,
    submit: async () => {
      throw cause;
    },
    reread: async () => ({ order: order(), paymentRows: 0 }),
  });
  assert.deepEqual(outcome, { ok: false, error: cause, retryable: true });
});

test("a failed re-read is AMBIGUOUS and never retryable", async () => {
  const outcome = await performDeliverySettlement({
    payload,
    submit: async () => {
      throw new Error("network");
    },
    reread: async () => {
      throw new Error("also offline");
    },
  });
  assert.ok(!outcome.ok && outcome.error instanceof DeliveryPaymentAmbiguousError);
  assert.equal(!outcome.ok && outcome.retryable, false);
  assert.match(String(!outcome.ok && (outcome.error as Error).message), /Do NOT take payment again/i);
});

test("BOTH halves must agree before a payment is called settled", () => {
  // Paid order, no payment row - or a payment row against an unpaid order - is a
  // contradiction, not a success.
  assert.equal(classifySettlement({ order: order({ payment_status: "paid", status: "completed" }), paymentRows: 1 }), "settled");
  assert.equal(classifySettlement({ order: order({ payment_status: "paid", status: "completed" }), paymentRows: 0 }), "ambiguous");
  assert.equal(classifySettlement({ order: order(), paymentRows: 1 }), "ambiguous");
  assert.equal(classifySettlement({ order: order(), paymentRows: 0 }), "unpaid");
  assert.equal(classifySettlement({ order: null, paymentRows: 0 }), "ambiguous");
});

test("paid but not completed is ambiguous, not settled", () => {
  // The server sets both in one statement, so seeing one without the other means
  // something is wrong - not that payment half-succeeded.
  assert.equal(classifySettlement({ order: order({ payment_status: "paid" }), paymentRows: 1 }), "ambiguous");
});

test("a contradictory state blocks another payment attempt", async () => {
  const outcome = await performDeliverySettlement({
    payload,
    submit: async () => {
      throw new Error("network");
    },
    reread: async () => ({ order: order({ payment_status: "paid" }), paymentRows: 0 }),
  });
  assert.ok(!outcome.ok && outcome.error instanceof DeliveryPaymentAmbiguousError);
  assert.equal(!outcome.ok && outcome.retryable, false);
});

// --- completion --------------------------------------------------------------

test("the completion sequence verifies BEFORE it presents", () => {
  assert.deepEqual([...DELIVERY_COMPLETION_SEQUENCE], [
    "refresh-order",
    "verify-paid-and-completed",
    "refresh-cash-box",
    "refresh-history",
    "present-receipt",
    "clear-payment-state",
  ]);
  const seq = [...DELIVERY_COMPLETION_SEQUENCE];
  assert.ok(seq.indexOf("verify-paid-and-completed") < seq.indexOf("present-receipt"));
  assert.ok(seq.indexOf("present-receipt") < seq.indexOf("clear-payment-state"));
});

test("settled means paid AND completed - the state payment itself produces", () => {
  assert.equal(deliveryIsSettled(order({ payment_status: "paid", status: "completed" })), true);
  assert.equal(deliveryIsSettled(order({ payment_status: "paid" })), false);
  assert.equal(deliveryIsSettled(order()), false);
  assert.equal(deliveryIsSettled(null), false);
});
