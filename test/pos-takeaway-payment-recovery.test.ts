// Takeaway payment lost-response recovery, plus contract guards proving the
// EXISTING inFlight latch and client_op_id path were reused, not replaced.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { isTransportFailure, recoverTakeawayPayment } from "@/lib/pos/takeawayPayment";
import { stripComments } from "./source-helpers.ts";
import type { OpenDeliveryOrder } from "@/lib/pos/deliveryOrder";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (...p: string[]) => readFileSync(join(srcRoot, ...p), "utf8");

const order = (over: Partial<OpenDeliveryOrder> = {}): OpenDeliveryOrder => ({
  id: "o1",
  order_number: "A-9",
  status: "sent_to_kitchen",
  payment_status: "unpaid",
  subtotal: 40,
  delivery_fee: null,
  total_amount: 40,
  currency: "USD",
  customer_id: null,
  address_id: null,
  notes: null,
  created_at: "2026-09-16T10:00:00Z",
  ...over,
});

test("isTransportFailure: only transport errors qualify, not definitive refusals", () => {
  assert.equal(isTransportFailure(new Error("TypeError: Failed to fetch")), true);
  assert.equal(isTransportFailure(new Error("network request failed")), true);
  assert.equal(isTransportFailure(new Error("This order is already paid")), false);
  assert.equal(isTransportFailure(new Error("tendered amount is less than the amount due")), false);
});

test("gate16/R: commit + lost response -> re-read paid + payment row -> settled (recovered)", async () => {
  const rec = await recoverTakeawayPayment("o1", {
    readOrder: async () => order({ payment_status: "paid", status: "completed" }),
    countRows: async () => 1,
  });
  assert.equal(rec.verdict, "settled");
  assert.equal(rec.verdict === "settled" ? rec.order.order_number : null, "A-9");
});

test("gate17/S: fail before commit -> re-read unpaid + no payment row -> safe retry", async () => {
  const rec = await recoverTakeawayPayment("o1", {
    readOrder: async () => order({ payment_status: "unpaid", status: "sent_to_kitchen" }),
    countRows: async () => 0,
  });
  assert.equal(rec.verdict, "unpaid");
});

test("gate18/T: re-read unavailable -> ambiguous (no auto-retry, no guess)", async () => {
  const rec = await recoverTakeawayPayment("o1", {
    readOrder: async () => {
      throw new Error("Failed to fetch");
    },
    countRows: async () => 0,
  });
  assert.equal(rec.verdict, "ambiguous");
});

test("contradiction (paid but zero payment rows) -> ambiguous, never settled", async () => {
  const rec = await recoverTakeawayPayment("o1", {
    readOrder: async () => order({ payment_status: "paid", status: "completed" }),
    countRows: async () => 0,
  });
  assert.equal(rec.verdict, "ambiguous");
});

// --- contract guards over PosWorkspace source --------------------------------

test("gate15: the ONE existing inFlight latch is preserved and no competing latch is added", () => {
  const src = stripComments(read("screens", "pos", "PosWorkspace.tsx"));
  assert.match(src, /if \(inFlight\.current\) return;/, "existing double-click latch remains");
  assert.match(src, /inFlight\.current = true;/, "existing latch is still acquired");
  assert.ok(
    !/createPaymentLatch\(|createSettlementLatch\(/.test(src),
    "no second latch mechanism was introduced on the takeaway path",
  );
});

test("gate4: ensureOrder journals before submit, retains on transport ambiguity, clears otherwise", () => {
  const src = stripComments(read("screens", "pos", "PosWorkspace.tsx"));
  assert.match(src, /beginInflightSubmit\(\{/, "journal written before the submit");
  assert.match(src, /if \(!isTransportFailure\(e\)\) await clearInflightSubmit\(opId\)/, "cleared only on a certain non-commit");
});

test("gate6/8/9: reconciliation replays the EXACT persisted payload under the SAME id", () => {
  const src = stripComments(read("screens", "pos", "PosWorkspace.tsx"));
  assert.match(src, /submitOrder\(entry\.payload as SubmitOrderPayload\)/, "same immutable payload, not a rebuilt cart");
  assert.match(src, /clearInflightSubmit\(entry\.client_op_id\)/, "cleared only after a successful reconciliation");
});

test("payment recovery is gated on transport + a known order and never auto-retries pos_pay_order", () => {
  const src = stripComments(read("screens", "pos", "PosWorkspace.tsx"));
  assert.match(src, /if \(recoverOrderId && isTransportFailure\(e\)\)/, "recovery only for a lost response on a known order");
  assert.match(src, /recoverTakeawayPayment\(recoverOrderId\)/, "asks the server rather than retrying");
  // a single payOrder call site (the once-only submit); recovery never calls payOrder again
  assert.equal((src.match(/await payOrder\(/g) ?? []).length, 1, "pos_pay_order is submitted at most once");
});
