// Creating a customer once, and only once.
//
// Level 2D's payment recovery had a safety net this does not: a second
// `pos_pay_table` finds no open unpaid order and refuses. `pos_upsert_customer`
// has no equivalent - a second insert with a differently-typed phone succeeds,
// because the unique constraint is on the RAW string. So the two mechanisms here
// carry the whole weight:
//
//   the LATCH, decided synchronously, for the double-tap, and
//   the RE-READ, for the lost response.
//
// Neither may be replaced by a `saving` boolean in React state: that flag is
// still false for a second click landing in the same tick.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CustomerCreateAmbiguousError,
  CustomerCreateInProgressError,
  DuplicatePhoneError,
  createCustomerLatch,
  performCustomerCreate,
  type CustomerMatch,
  type CustomerUpsertPayload,
  type CustomerUpsertResult,
} from "@/lib/pos/customers";

const payload: CustomerUpsertPayload = { branch_id: "b1", phone: "03123456", name: "Desktop Level 3A QA" };

const created = (id = "c1"): CustomerUpsertResult => ({ customer_id: id, address_id: null, is_new: true });

const match = (over: Partial<CustomerMatch> = {}): CustomerMatch => ({
  id: "c1",
  name: "Desktop Level 3A QA",
  phone: "03123456",
  phone_e164: "+9613123456",
  ...over,
});

const never = async (): Promise<CustomerMatch[]> => {
  throw new Error("recoverSearch must not run on a successful create");
};

// --- the latch ---------------------------------------------------------------

test("the latch admits one holder and refuses the rest synchronously", () => {
  const latch = createCustomerLatch();
  assert.equal(latch.acquire(), true);
  assert.equal(latch.acquire(), false);
  assert.equal(latch.held(), true);
  latch.release();
  assert.equal(latch.held(), false);
  assert.equal(latch.acquire(), true);
});

test("a second create in the same tick is refused, not queued", async () => {
  const latch = createCustomerLatch();
  let calls = 0;
  const submit = async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 5));
    return created();
  };
  const [first, second] = await Promise.all([
    performCustomerCreate({ payload, submit, recoverSearch: never, latch }),
    performCustomerCreate({ payload, submit, recoverSearch: never, latch }),
  ]);
  assert.equal(calls, 1);
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.ok(!second.ok && second.error instanceof CustomerCreateInProgressError);
  assert.equal(!second.ok && second.retryable, false);
});

test("the latch is released after a failure, so a legitimate retry is possible", async () => {
  const latch = createCustomerLatch();
  await performCustomerCreate({
    payload,
    submit: async () => {
      throw new Error("Failed to fetch");
    },
    recoverSearch: async () => [],
    latch,
  });
  assert.equal(latch.held(), false);
});

// --- the happy path ----------------------------------------------------------

test("a successful create returns the id and never re-reads", async () => {
  const outcome = await performCustomerCreate({
    payload,
    submit: async () => created("c7"),
    recoverSearch: never,
  });
  assert.deepEqual(outcome, { ok: true, customerId: "c7", recovered: false });
});

test("the payload reaches the server unchanged", async () => {
  let seen: CustomerUpsertPayload | null = null;
  await performCustomerCreate({
    payload,
    submit: async (p) => {
      seen = p;
      return created();
    },
    recoverSearch: never,
  });
  assert.deepEqual(seen, payload);
});

// --- recovery ----------------------------------------------------------------

test("a lost response whose write LANDED is recovered, not retried", async () => {
  // The one case a blind retry would turn into two customers.
  const outcome = await performCustomerCreate({
    payload,
    submit: async () => {
      throw new Error("Failed to fetch");
    },
    recoverSearch: async () => [match({ id: "c5" })],
  });
  assert.deepEqual(outcome, { ok: true, customerId: "c5", recovered: true });
});

test("recovery matches on the NORMALISED phone, not the string we sent", async () => {
  const outcome = await performCustomerCreate({
    payload,
    submit: async () => {
      throw new Error("network");
    },
    // The server stored what an earlier cashier typed; only normalisation links
    // it back to the number this attempt used.
    recoverSearch: async () => [match({ id: "c6", phone: "+961 3 123 456", phone_e164: "+9613123456" })],
  });
  assert.deepEqual(outcome, { ok: true, customerId: "c6", recovered: true });
});

test("a lost response whose write did NOT land is reported as retryable", async () => {
  const cause = new Error("Failed to fetch");
  const outcome = await performCustomerCreate({
    payload,
    submit: async () => {
      throw cause;
    },
    recoverSearch: async () => [],
  });
  assert.deepEqual(outcome, { ok: false, error: cause, retryable: true });
});

test("a failed re-read is AMBIGUOUS and never retryable", async () => {
  // Not knowing is the dangerous state: a retry here could duplicate, and
  // pretending it succeeded could attach an order to nothing.
  const outcome = await performCustomerCreate({
    payload,
    submit: async () => {
      throw new Error("network");
    },
    recoverSearch: async () => {
      throw new Error("also offline");
    },
  });
  assert.equal(outcome.ok, false);
  assert.ok(!outcome.ok && outcome.error instanceof CustomerCreateAmbiguousError);
  assert.equal(!outcome.ok && outcome.retryable, false);
  assert.match(String(!outcome.ok && (outcome.error as Error).message), /Search for the phone number before trying again/i);
});

test("recovery that finds SEVERAL equivalent rows stops rather than picking one", async () => {
  const outcome = await performCustomerCreate({
    payload,
    submit: async () => {
      throw new Error("network");
    },
    recoverSearch: async () => [match({ id: "a" }), match({ id: "b", phone: "+9613123456" })],
  });
  assert.equal(outcome.ok, false);
  assert.ok(!outcome.ok && outcome.error instanceof DuplicatePhoneError);
  assert.equal(!outcome.ok && outcome.retryable, false);
  const candidates = !outcome.ok && outcome.error instanceof DuplicatePhoneError ? outcome.error.candidates : [];
  assert.deepEqual(candidates.map((c) => c.id), ["a", "b"]);
});

test("a payload with no phone cannot be recovered, and says so by staying retryable", async () => {
  const cause = new Error("network");
  const outcome = await performCustomerCreate({
    payload: { branch_id: "b1", id: "c1", name: "Edit only" },
    submit: async () => {
      throw cause;
    },
    recoverSearch: never,
  });
  assert.deepEqual(outcome, { ok: false, error: cause, retryable: true });
});

test("the recovery search is given the phone that was actually sent", async () => {
  let asked: string | null = null;
  await performCustomerCreate({
    payload: { branch_id: "b1", phone: "03 123 456" },
    submit: async () => {
      throw new Error("network");
    },
    recoverSearch: async (phone) => {
      asked = phone;
      return [];
    },
  });
  assert.equal(asked, "03 123 456");
});
