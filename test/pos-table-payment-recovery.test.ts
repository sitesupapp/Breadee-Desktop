// Duplicate-payment and lost-response safety. This is the P0 file.
//
// THE SITUATION, stated plainly.
// `pos_pay_table` has no idempotency key. `pos_submit_order` has `client_op_id`
// (m224) and can replay a lost round safely; payment cannot. So when a payment
// request fails, the client genuinely does not know whether the server charged.
//
// The server is nonetheless safe against double-charging, by STATE: the first
// successful call marks every open order paid/completed and frees the table, so
// a second call finds nothing to pay and raises "No open order on this table to
// pay". Nobody is charged twice.
//
// That gives the client exactly one honest move: ASK. An authoritative re-read
// after a failure yields one of three answers, and each has one correct response:
//
//   settled   - the bill is gone and the table is free -> the earlier call
//               landed. Complete it. Do NOT charge again.
//   unpaid    - the bill is still open -> nothing was charged. A retry is safe,
//               but it is the OPERATOR's decision, made against fresh state.
//   ambiguous - the server could not be reached, or says something that does not
//               fit either shape -> stop. Neither retry nor completion, and say
//               so in those words.
//
// The two failure modes this file exists to make impossible:
//   * a second RPC from a second click / F4 / Enter while one is in flight, and
//   * an automatic retry after a timeout, which is precisely how a customer gets
//     charged twice.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  PaymentAmbiguousError,
  PaymentInProgressError,
  StaleBillError,
  classifyRecovery,
  createPaymentLatch,
  isNoOpenOrderRefusal,
  isSafeToRetry,
  performTablePayment,
  type TablePaymentPayload,
  type TablePaymentResult,
} from "@/lib/pos/tablePayment";
import { classifyError } from "@/lib/pos/errors";
import { stripComments } from "./source-helpers.ts";
import type { BillOrder, TableBill, TableSummary } from "@/types/tables";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (...p: string[]) => readFileSync(join(srcRoot, ...p), "utf8");

const order = (over: Partial<BillOrder> = {}): BillOrder => ({
  id: "o1",
  order_number: "A-14",
  status: "sent_to_kitchen",
  payment_status: "unpaid",
  shift_id: "s1",
  branch_id: "b1",
  tenant_id: "t1",
  subtotal: 40,
  discount_amount: 0,
  total_amount: 40,
  currency: "USD",
  exchange_rate: null,
  created_at: "2026-08-07T10:00:00Z",
  lines: [],
  ...over,
});

const bill = (over: Partial<TableBill> = {}): TableBill => ({
  tableId: "tbl1",
  orders: [order()],
  subtotal: 40,
  total: 40,
  currency: "USD",
  mixedCurrency: false,
  splitShift: false,
  batches: [1],
  ...over,
});

const table = (over: Partial<TableSummary> = {}): TableSummary => ({
  id: "tbl1",
  name: "Table 5",
  seats: 4,
  occupied: true,
  status: "occupied",
  canonical: true,
  configured: true,
  sort_order: 5,
  orders: 1,
  order_number: "A-14",
  opened_at: null,
  total: 40,
  currency: "USD",
  mixed_currency: false,
  ...over,
});

const freeTable = () => table({ occupied: false, status: "available", orders: 0, order_number: null, total: null });

const result = (over: Partial<TablePaymentResult> = {}): TablePaymentResult => ({
  ok: true,
  orders: 1,
  subtotal: 40,
  discount: 0,
  amount: 40,
  currency_code: "USD",
  original_amount: 40,
  exchange_rate: null,
  ...over,
});

const payload: TablePaymentPayload = { table_id: "tbl1", method: "cash", currency_code: "USD" };

/** A harness that counts every effect, so "exactly once" is measurable. */
function harness(
  over: Partial<{
    submit: (p: TablePaymentPayload) => Promise<TablePaymentResult>;
    reRead: () => Promise<{ bill: TableBill | null; table: TableSummary | null }>;
    recover: () => Promise<{ bill: TableBill | null; table: TableSummary | null }>;
    shownBill: TableBill | null;
  }> = {},
) {
  const calls = { submit: 0, reRead: 0, recover: 0, complete: 0, refresh: 0 };
  const latch = createPaymentLatch();
  const shownBill = over.shownBill === undefined ? bill() : over.shownBill;
  const run = () =>
    performTablePayment({
      shownBill,
      table: table(),
      payload,
      latch,
      reReadBill: async () => {
        calls.reRead++;
        return over.reRead ? over.reRead() : { bill: bill(), table: table() };
      },
      submit: async (p) => {
        calls.submit++;
        if (over.submit) return over.submit(p);
        return result();
      },
      recoverRead: async () => {
        calls.recover++;
        return over.recover ? over.recover() : { bill: null, table: freeTable() };
      },
      complete: () => {
        calls.complete++;
      },
      refresh: async () => {
        calls.refresh++;
      },
    });
  return { calls, latch, run };
}

// --- the happy path ----------------------------------------------------------

test("a successful payment submits exactly once and completes once", async () => {
  const h = harness();
  const outcome = await h.run();

  assert.equal(outcome.ok, true);
  assert.equal(h.calls.submit, 1);
  assert.equal(h.calls.complete, 1);
  assert.equal(h.calls.refresh, 1);
  assert.equal(h.calls.recover, 0, "the recovery read ran on a successful payment");
  if (outcome.ok) {
    assert.equal(outcome.recovered, false);
    assert.equal(outcome.result?.amount, 40);
  }
});

test("the re-read happens BEFORE the submit, never after", async () => {
  const steps: string[] = [];
  await performTablePayment({
    shownBill: bill(),
    table: table(),
    payload,
    reReadBill: async () => {
      steps.push("re-read");
      return { bill: bill(), table: table() };
    },
    submit: async () => {
      steps.push("submit");
      return result();
    },
    recoverRead: async () => ({ bill: null, table: null }),
    complete: () => steps.push("complete"),
    refresh: async () => {
      steps.push("refresh");
    },
  });
  assert.deepEqual(steps, ["re-read", "submit", "complete", "refresh"]);
});

// --- duplicate submission ----------------------------------------------------

test("two clicks in the same tick produce ONE RPC", async () => {
  const h = harness({ submit: async () => new Promise((r) => setTimeout(() => r(result()), 10)) });
  const [first, second] = await Promise.all([h.run(), h.run()]);

  assert.equal(h.calls.submit, 1, "a second payment request reached the server");
  assert.equal(first.ok !== second.ok, true, "both attempts reported the same outcome");
  const refused = first.ok ? second : first;
  assert.equal(refused.ok, false);
  assert.ok((refused as { error: unknown }).error instanceof PaymentInProgressError);
});

test("a click followed by F4-then-Enter still produces ONE RPC", async () => {
  // F4 only opens the dialog, so the duplicate that matters is confirm-again.
  const h = harness({ submit: async () => new Promise((r) => setTimeout(() => r(result()), 10)) });
  const button = h.run();
  const keyboard = h.run();
  await Promise.all([button, keyboard]);
  assert.equal(h.calls.submit, 1);
});

test("three rapid confirmations produce ONE RPC and two refusals", async () => {
  const h = harness({ submit: async () => new Promise((r) => setTimeout(() => r(result()), 10)) });
  const outcomes = await Promise.all([h.run(), h.run(), h.run()]);
  assert.equal(h.calls.submit, 1);
  assert.equal(outcomes.filter((o) => o.ok).length, 1);
  assert.equal(outcomes.filter((o) => !o.ok).length, 2);
});

test("the latch is released, so a legitimate later payment is not blocked forever", async () => {
  const h = harness();
  await h.run();
  assert.equal(h.latch.held(), false, "the latch stayed held after the payment finished");
  await h.run();
  assert.equal(h.calls.submit, 2, "a subsequent payment was refused by a stuck latch");
});

test("the latch is released even when the payment throws", async () => {
  const h = harness({
    submit: async () => {
      throw new Error("boom");
    },
  });
  await h.run();
  assert.equal(h.latch.held(), false);
});

test("the latch decides synchronously - it is not React state", () => {
  const latch = createPaymentLatch();
  assert.equal(latch.acquire(), true);
  assert.equal(latch.acquire(), false, "the latch let a second holder in within the same tick");
  latch.release();
  assert.equal(latch.acquire(), true);
});

// --- lost response -----------------------------------------------------------

test("a lost response over a settled table is recovered as SUCCESS, with no second charge", async () => {
  const h = harness({
    submit: async () => {
      throw new Error("Failed to fetch");
    },
    recover: async () => ({ bill: null, table: freeTable() }),
  });
  const outcome = await h.run();

  assert.equal(outcome.ok, true);
  assert.equal(h.calls.submit, 1, "the payment was submitted a second time");
  assert.equal(h.calls.recover, 1);
  assert.equal(h.calls.complete, 1, "the recovered settlement did not complete");
  if (outcome.ok) assert.equal(outcome.recovered, true);
});

test('"no open order to pay" over a free table is the recovery success signal', async () => {
  const h = harness({
    submit: async () => {
      throw new Error("No open order on this table to pay");
    },
    recover: async () => ({ bill: bill({ orders: [] }), table: freeTable() }),
  });
  const outcome = await h.run();
  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.recovered, true);
  assert.equal(h.calls.submit, 1);
});

test("a bill that is still unpaid after a failure is safe to retry - but is NOT retried here", async () => {
  const h = harness({
    submit: async () => {
      throw new Error("Failed to fetch");
    },
    recover: async () => ({ bill: bill(), table: table() }),
  });
  const outcome = await h.run();

  assert.equal(outcome.ok, false);
  assert.equal(isSafeToRetry(outcome), true, "a provably unpaid bill was not offered as retryable");
  assert.equal(h.calls.submit, 1, "the module retried by itself - a retry is the operator's decision");
  assert.equal(h.calls.complete, 0);
});

test("a recovery read that itself fails is AMBIGUOUS - never retried, never completed", async () => {
  const h = harness({
    submit: async () => {
      throw new Error("Failed to fetch");
    },
    recover: async () => {
      throw new Error("Failed to fetch");
    },
  });
  const outcome = await h.run();

  assert.equal(outcome.ok, false);
  assert.equal(isSafeToRetry(outcome), false);
  assert.equal(h.calls.complete, 0);
  assert.ok((outcome as { error: unknown }).error instanceof PaymentAmbiguousError);
});

test("a contradictory recovery - no bill but the table still occupied - is AMBIGUOUS", async () => {
  const h = harness({
    submit: async () => {
      throw new Error("Failed to fetch");
    },
    // No bill readable, yet the map still shows an open order. Nothing may be
    // concluded from that, so nothing is.
    recover: async () => ({ bill: null, table: table({ orders: 1 }) }),
  });
  const outcome = await h.run();
  assert.equal(outcome.ok, false);
  assert.equal(isSafeToRetry(outcome), false);
  assert.ok((outcome as { error: unknown }).error instanceof PaymentAmbiguousError);
});

test('"no open order to pay" while the bill is STILL open is ambiguous, not success', async () => {
  // The two facts contradict each other. Completing here would print a receipt
  // for money that may never have been collected.
  const h = harness({
    submit: async () => {
      throw new Error("No open order on this table to pay");
    },
    recover: async () => ({ bill: bill(), table: table() }),
  });
  const outcome = await h.run();
  assert.equal(outcome.ok, false);
  assert.equal(isSafeToRetry(outcome), false);
  assert.equal(h.calls.complete, 0);
});

test("the ambiguous error tells the operator NOT to take payment again", () => {
  const c = classifyError(new PaymentAmbiguousError(new Error("Failed to fetch")));
  assert.equal(c.kind, "payment_ambiguous");
  assert.match(c.message, /could not confirm whether the payment/i);
  assert.match(c.hint!, /do not take payment again/i);
  // It is a fault, not a routine refusal - it must render red, not amber.
  assert.equal(c.expected, false);
});

// --- the verdict function in isolation --------------------------------------

test("classifyRecovery: no bill + free table = settled", () => {
  assert.equal(classifyRecovery({ reReadSucceeded: true, billAfter: null, tableAfter: freeTable() }), "settled");
  assert.equal(
    classifyRecovery({ reReadSucceeded: true, billAfter: bill({ orders: [] }), tableAfter: freeTable() }),
    "settled",
  );
});

test("classifyRecovery: a bill that is still there = unpaid", () => {
  assert.equal(classifyRecovery({ reReadSucceeded: true, billAfter: bill(), tableAfter: table() }), "unpaid");
});

test("classifyRecovery: a failed read is always ambiguous, whatever the stale state said", () => {
  assert.equal(classifyRecovery({ reReadSucceeded: false, billAfter: null, tableAfter: freeTable() }), "ambiguous");
});

test("isNoOpenOrderRefusal matches the server's wording and nothing broader", () => {
  assert.equal(isNoOpenOrderRefusal(new Error("No open order on this table to pay")), true);
  assert.equal(isNoOpenOrderRefusal(new Error("no open order on this table to pay")), true);
  assert.equal(isNoOpenOrderRefusal(new Error("That table has no open order to move")), false);
  assert.equal(isNoOpenOrderRefusal(null), false);
});

// --- stale bill --------------------------------------------------------------

test("a bill that changed during the re-read is never submitted", async () => {
  const h = harness({ reRead: async () => ({ bill: bill({ total: 65 }), table: table() }) });
  const outcome = await h.run();

  assert.equal(outcome.ok, false);
  assert.equal(h.calls.submit, 0, "a stale total was charged");
  assert.ok((outcome as { error: unknown }).error instanceof StaleBillError);
  // Stale is not retryable: the operator must READ the new bill first.
  assert.equal(isSafeToRetry(outcome), false);
});

test("a re-read that fails outright blocks the payment and IS retryable", async () => {
  const h = harness({
    reRead: async () => {
      throw new Error("Failed to fetch");
    },
  });
  const outcome = await h.run();
  assert.equal(h.calls.submit, 0);
  assert.equal(isSafeToRetry(outcome), true, "a failed pre-flight read should be retryable - nothing was charged");
});

// --- no blind retry, structurally -------------------------------------------

test("the payment module contains no retry loop", () => {
  const code = stripComments(read("lib", "pos", "tablePayment.ts"));
  assert.doesNotMatch(code, /\bfor\s*\(|\bwhile\s*\(|setTimeout|setInterval/, "a loop or timer appeared in the payment path");
  // And `submit` is referenced exactly once, so there is one call site.
  assert.equal(code.split("input.submit(").length - 1, 1, "submit is called from more than one place");
});

test("no offline queue and no replay exist on the payment path", () => {
  const sources = stripComments(
    [read("lib", "pos", "tablePayment.ts"), read("lib", "pos", "tablePaymentCompletion.ts")].join("\n"),
  );
  assert.doesNotMatch(sources, /enqueue|offline\/db|localdb/i, "a queue entered the payment path");

  // `client_op_id` may appear ONLY as a name on the forbidden list. Anywhere
  // else it would be an invented idempotency key the server does not honour.
  const opIdHits = sources.split("client_op_id").length - 1;
  assert.equal(opIdHits, 1, "client_op_id appears outside the forbidden-field list");
  const forbidden = /FORBIDDEN_PAYMENT_FIELDS = \[([\s\S]*?)\]/.exec(sources)?.[1] ?? "";
  assert.match(forbidden, /"client_op_id"/, "the one client_op_id mention is not the forbidden-list entry");
});
