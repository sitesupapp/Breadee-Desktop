// Sending one delivery order, once.
//
// This level has a safety net Level 2D's payment did not: `pos_submit_order`
// resolves a `client_op_id` against `pos_order_submissions` and REPLAYS the
// stored result rather than creating a second order. So a retry carrying the
// same id is safe by construction.
//
// The re-read still matters. A lost response leaves the client unable to tell
// "never arrived" from "arrived, reply dropped", and those need different words
// on screen. Guessing wrong in the second case tells an operator to re-send food
// the kitchen is already cooking.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DeliveryAmbiguousError,
  DeliveryInProgressError,
  createDeliveryLatch,
  performDeliveryOrder,
  type OpenDeliveryOrder,
} from "@/lib/pos/deliveryOrder";
import type { SubmitOrderPayload } from "@/lib/pos/orders";
import type { SubmitOrderResult } from "@/types/pos";

const payload = {
  branch_id: "b1",
  order_type: "delivery",
  status: "sent_to_kitchen",
  shift_id: "s1",
  client_op_id: "op-1",
  notes: null,
  customer_id: "c1",
  address_id: "a1",
  items: [],
} as unknown as SubmitOrderPayload;

const saved = (over: Partial<SubmitOrderResult> = {}): SubmitOrderResult => ({
  order_id: "o1",
  order_number: "260809-0001",
  subtotal: 7,
  total: 7,
  batch_no: 1,
  appended: false,
  idempotent: false,
  ...over,
});

const openOrder = (over: Partial<OpenDeliveryOrder> = {}): OpenDeliveryOrder => ({
  id: "o1",
  order_number: "260809-0001",
  status: "sent_to_kitchen",
  payment_status: "unpaid",
  total_amount: 7,
  currency: "USD",
  customer_id: "c1",
  address_id: "a1",
  notes: "Desktop Level 3B delivery ordering verification",
  created_at: "2026-08-09T12:00:00Z",
  ...over,
});

const never = async (): Promise<OpenDeliveryOrder[]> => {
  throw new Error("recoverSearch must not run on a successful send");
};
const matchAll = () => true;

// --- the happy path ----------------------------------------------------------

test("a successful send returns the server's order and never re-reads", async () => {
  const outcome = await performDeliveryOrder({
    payload,
    submit: async () => saved(),
    recoverSearch: never,
    matchesIntent: matchAll,
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.ok && outcome.result.order_number, "260809-0001");
  assert.equal(outcome.ok && outcome.recovered, false);
});

test("the payload reaches the server unchanged", async () => {
  let seen: SubmitOrderPayload | null = null;
  await performDeliveryOrder({
    payload,
    submit: async (p) => {
      seen = p;
      return saved();
    },
    recoverSearch: never,
    matchesIntent: matchAll,
  });
  assert.deepEqual(seen, payload);
});

test("a server-side idempotent replay is reported as recovered, not as a new order", async () => {
  // `pos_submit_order` returns `idempotent: true` when it replays a stored
  // submission. That is the server telling us this exact order already exists.
  const outcome = await performDeliveryOrder({
    payload,
    submit: async () => saved({ idempotent: true }),
    recoverSearch: never,
    matchesIntent: matchAll,
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.ok && outcome.recovered, true);
  assert.equal(outcome.ok && outcome.result.order_id, "o1");
});

// --- duplicate submission ----------------------------------------------------

test("a second send in the same tick is refused, not queued", async () => {
  const latch = createDeliveryLatch();
  let calls = 0;
  const submit = async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 5));
    return saved();
  };
  const [first, second] = await Promise.all([
    performDeliveryOrder({ payload, submit, recoverSearch: never, matchesIntent: matchAll, latch }),
    performDeliveryOrder({ payload, submit, recoverSearch: never, matchesIntent: matchAll, latch }),
  ]);
  assert.equal(calls, 1);
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.ok(!second.ok && second.error instanceof DeliveryInProgressError);
  assert.equal(!second.ok && second.retryable, false);
});

test("three rapid sends reach the server once", async () => {
  const latch = createDeliveryLatch();
  let calls = 0;
  const submit = async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 5));
    return saved();
  };
  const results = await Promise.all(
    [0, 1, 2].map(() =>
      performDeliveryOrder({ payload, submit, recoverSearch: never, matchesIntent: matchAll, latch }),
    ),
  );
  assert.equal(calls, 1);
  assert.equal(results.filter((r) => r.ok).length, 1);
});

test("the latch is released after a failure, so a legitimate retry is possible", async () => {
  const latch = createDeliveryLatch();
  await performDeliveryOrder({
    payload,
    submit: async () => {
      throw new Error("Failed to fetch");
    },
    recoverSearch: async () => [],
    matchesIntent: matchAll,
    latch,
  });
  assert.equal(latch.held(), false);
});

// --- recovery ----------------------------------------------------------------

test("a lost response whose order LANDED is recovered, not re-sent", async () => {
  const outcome = await performDeliveryOrder({
    payload,
    submit: async () => {
      throw new Error("Failed to fetch");
    },
    recoverSearch: async () => [openOrder({ id: "o9", order_number: "260809-0009" })],
    matchesIntent: (o) => o.notes === "Desktop Level 3B delivery ordering verification",
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.ok && outcome.recovered, true);
  assert.equal(outcome.ok && outcome.result.order_id, "o9");
  assert.equal(outcome.ok && outcome.result.order_number, "260809-0009");
});

test("recovery ignores a live order that is not the one we intended to send", async () => {
  // The customer may already have an unrelated open delivery order. Treating it
  // as ours would report success for an order this basket never created.
  const outcome = await performDeliveryOrder({
    payload,
    submit: async () => {
      throw new Error("network");
    },
    recoverSearch: async () => [openOrder({ id: "other", notes: "someone else's order" })],
    matchesIntent: (o) => o.notes === "Desktop Level 3B delivery ordering verification",
  });
  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.retryable, true);
});

test("a lost response whose order did NOT land is retryable", async () => {
  const cause = new Error("Failed to fetch");
  const outcome = await performDeliveryOrder({
    payload,
    submit: async () => {
      throw cause;
    },
    recoverSearch: async () => [],
    matchesIntent: matchAll,
  });
  assert.deepEqual(outcome, { ok: false, error: cause, retryable: true });
});

test("a failed re-read is AMBIGUOUS and never retryable", async () => {
  const outcome = await performDeliveryOrder({
    payload,
    submit: async () => {
      throw new Error("network");
    },
    recoverSearch: async () => {
      throw new Error("also offline");
    },
    matchesIntent: matchAll,
  });
  assert.equal(outcome.ok, false);
  assert.ok(!outcome.ok && outcome.error instanceof DeliveryAmbiguousError);
  assert.equal(!outcome.ok && outcome.retryable, false);
  assert.match(
    String(!outcome.ok && (outcome.error as Error).message),
    /Check the customer's orders before sending again/i,
  );
});

test("submit is called at most once per attempt - there is no retry loop", async () => {
  let calls = 0;
  await performDeliveryOrder({
    payload,
    submit: async () => {
      calls += 1;
      throw new Error("network");
    },
    recoverSearch: async () => [],
    matchesIntent: matchAll,
  });
  assert.equal(calls, 1);
});

test("a recovered order is reported unpaid and un-appended", async () => {
  const outcome = await performDeliveryOrder({
    payload,
    submit: async () => {
      throw new Error("network");
    },
    recoverSearch: async () => [openOrder()],
    matchesIntent: matchAll,
  });
  // Delivery never appends: the batch path is dine-in only, keyed on table_id.
  assert.equal(outcome.ok && outcome.result.appended, false);
  assert.equal(outcome.ok && outcome.result.batch_no, 1);
});
