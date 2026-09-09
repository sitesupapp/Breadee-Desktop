// Customer Receivables / Customer Accounts — the Wave 3C contract and boundary.
//
// Three things are asserted here, in rising order of importance.
//
// 1. THE GATES. Viewing an account and collecting against it are two separate
//    authorities, refused in the order the server would refuse them - and a
//    view-only operator can never reach the collect action.
//
// 2. THE BOUNDARY. The receivables library moves money through EXACTLY ONE RPC
//    (`pos_receivable_collect`); the other two are reads. A collection is
//    ONLINE-ONLY - it is never enqueued to the offline outbox, and the source
//    cannot reach one. The confirmation is a label/value slip, not a sale
//    receipt, and NOTHING was added to the native (Rust) layer for it.
//
// 3. THE REGRESSION GUARD. A completed on-account order is a RECEIVABLE and must
//    never expose the plain Pay path - `canSettleOrder` still withholds it. Debt
//    is settled only through `pos_receivable_collect`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { stripComments, stripJsxComments } from "./source-helpers.ts";
import {
  canCollectReceivables,
  canViewReceivables,
  POS_PERMISSIONS,
  type PosAccessContext,
} from "@/lib/pos/access";
import { FEATURES } from "@/lib/features";
import {
  COLLECT_PAYLOAD_KEYS,
  InvalidCollectionAmountError,
  CollectionInProgressError,
  CollectionAmbiguousError,
  assertCollectionAmount,
  buildCollectPayload,
  createCollectLatch,
  newClientOpId,
  performCollect,
  type CollectResult,
} from "@/lib/pos/receivables";
import { buildReceivableConfirmation, toReceivableReport } from "@/lib/pos/receivableReceipt";
import { canSettleOrder } from "@/lib/pos/orderActions";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const tauriRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri");
const read = (...p: string[]) => readFileSync(join(srcRoot, ...p), "utf8");

const receivablesSrc = read("lib", "pos", "receivables.ts");
const confirmationSrc = read("lib", "pos", "receivableReceipt.ts");
const screenSrc = read("screens", "CustomerAccounts.tsx");

// --- gates -------------------------------------------------------------------

const FULL_FEATURES = { [FEATURES.POS]: true, [FEATURES.POS_RECEIVABLES]: true };
const FULL_PERMS = {
  "pos.access": true,
  "pos.receivables.view": true,
  "pos.receivables.collect": true,
};

function ctx(overrides: Partial<PosAccessContext> = {}): PosAccessContext {
  return {
    membership: { role: "cashier", status: "active" },
    permissions: { ...FULL_PERMS },
    features: { ...FULL_FEATURES },
    ...overrides,
  };
}

test("the permission keys are the ones the server checks", () => {
  assert.equal(POS_PERMISSIONS.RECEIVABLES_VIEW, "pos.receivables.view");
  assert.equal(POS_PERMISSIONS.RECEIVABLES_COLLECT, "pos.receivables.collect");
});

test("viewing needs POS access, the feature, and pos.receivables.view", () => {
  assert.equal(canViewReceivables(ctx()).allowed, true);
  // Owner is blocked from operational POS, mirroring pos_assert_operator.
  assert.equal(canViewReceivables(ctx({ membership: { role: "owner", status: "active" } })).allowed, false);
  // Feature dark → refused, before any permission is consulted.
  assert.equal(canViewReceivables(ctx({ features: { [FEATURES.POS]: true } })).allowed, false);
  // Missing the view permission → refused.
  assert.equal(
    canViewReceivables(ctx({ permissions: { "pos.access": true, "pos.receivables.collect": true } })).allowed,
    false,
  );
});

test("collecting is a DISTINCT authority - a view-only operator cannot collect", () => {
  const viewOnly = ctx({ permissions: { "pos.access": true, "pos.receivables.view": true } });
  assert.equal(canViewReceivables(viewOnly).allowed, true);
  assert.equal(canCollectReceivables(viewOnly).allowed, false);
  // With the collect permission too, both pass.
  assert.equal(canCollectReceivables(ctx()).allowed, true);
});

test("collecting inherits every view prerequisite - never looser", () => {
  // No feature: collect is refused for the SAME reason view is, not with a
  // permission message that implies the user merely lacks a grant.
  const noFeature = ctx({ features: { [FEATURES.POS]: true } });
  assert.equal(canCollectReceivables(noFeature).allowed, false);
  assert.equal(canCollectReceivables(noFeature).reason, canViewReceivables(noFeature).reason);
});

// --- the boundary: one money RPC, two reads ----------------------------------

test("the receivables library calls exactly its three RPCs, one of them money", () => {
  const calls = [...stripComments(receivablesSrc).matchAll(/callPosRpc\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(calls)].sort(),
    ["pos_receivable_collect", "pos_receivables_customer", "pos_receivables_search"],
  );
  // Only the collection write moves money; the two reads match none of the
  // money-name words the allow-list guard uses.
  const money = calls.filter((m) => /submit|pay|void|refund|complete|collect/.test(m));
  assert.deepEqual([...new Set(money)], ["pos_receivable_collect"]);
});

test("the collect payload is exactly the four keys the RPC reads", () => {
  assert.deepEqual([...COLLECT_PAYLOAD_KEYS], ["order_id", "amount", "method", "client_op_id"]);
  const p = buildCollectPayload({ orderId: "o1", amount: 5, method: "cash", clientOpId: "op-1" });
  assert.deepEqual(Object.keys(p).sort(), ["amount", "client_op_id", "method", "order_id"]);
  assert.equal(p.client_op_id, "op-1");
});

// --- online-only -------------------------------------------------------------

test("a collection is online-only and never touches the offline outbox", () => {
  // The library imports nothing from the offline database and enqueues nothing.
  assert.doesNotMatch(receivablesSrc, /offline\/db|localdb/, "receivables must not reach the offline database");
  assert.doesNotMatch(receivablesSrc, /enqueue\s*\(/, "a collection must never be queued offline");
  // The screen refuses to collect while offline rather than deferring it, and it
  // too never enqueues or shows a local financial success.
  assert.doesNotMatch(screenSrc, /enqueue\s*\(/, "the screen must never queue a collection");
  assert.doesNotMatch(screenSrc, /offline\/db|localdb/, "the screen must not reach the offline database");
  assert.match(screenSrc, /needs a connection/i, "the screen must explain the offline refusal");
});

// --- amount validation -------------------------------------------------------

test("a collection amount must be a real, positive number", () => {
  assert.throws(() => assertCollectionAmount(0), InvalidCollectionAmountError);
  assert.throws(() => assertCollectionAmount(-1), InvalidCollectionAmountError);
  assert.throws(() => assertCollectionAmount(Number.NaN), InvalidCollectionAmountError);
  assert.doesNotThrow(() => assertCollectionAmount(0.01));
  assert.doesNotThrow(() => assertCollectionAmount(1000));
});

// --- the latch + recovery (mirrors the payment paths) ------------------------

test("the latch admits one holder, and a busy latch refuses the second submit", async () => {
  const latch = createCollectLatch();
  assert.equal(latch.acquire(), true);
  assert.equal(latch.acquire(), false);
  latch.release();
  assert.equal(latch.acquire(), true);
  latch.release();

  // A submit attempted while the latch is held is refused, not sent.
  const held = createCollectLatch();
  held.acquire();
  const outcome = await performCollect({
    latch: held,
    submit: async () => {
      throw new Error("must not be called while the latch is held");
    },
    reread: async () => "open",
  });
  assert.equal(outcome.ok, false);
  assert.ok(!outcome.ok && outcome.error instanceof CollectionInProgressError);
});

test("recovery: a lost response resolves by an authoritative re-read", async () => {
  const result: CollectResult = {
    ok: true,
    paymentId: "p1",
    orderNumber: "1001",
    paymentStatus: "partial",
    collectedUsd: 5,
    outstandingUsd: 5,
    idempotentReplay: false,
  };
  // Happy path: submit succeeds, no re-read needed.
  const ok = await performCollect({ submit: async () => result, reread: async () => "open" });
  assert.ok(ok.ok && ok.recovered === false && ok.result?.orderNumber === "1001");

  // Lost response, re-read says COMMITTED → recovered, no retry.
  const committed = await performCollect({
    submit: async () => {
      throw new Error("lost");
    },
    reread: async () => "committed",
  });
  assert.ok(committed.ok && committed.recovered === true && committed.result === null);

  // Lost response, re-read says OPEN → retryable (same client_op_id is safe).
  const open = await performCollect({
    submit: async () => {
      throw new Error("lost");
    },
    reread: async () => "open",
  });
  assert.ok(!open.ok && open.retryable === true);

  // Lost response, re-read cannot decide → ambiguous, never retry.
  const ambiguous = await performCollect({
    submit: async () => {
      throw new Error("lost");
    },
    reread: async () => "ambiguous",
  });
  assert.ok(!ambiguous.ok && ambiguous.retryable === false && ambiguous.error instanceof CollectionAmbiguousError);
});

test("one client_op_id is minted per collection and is a distinct value", () => {
  const a = newClientOpId();
  const b = newClientOpId();
  assert.equal(typeof a, "string");
  assert.ok(a.length > 0);
  assert.notEqual(a, b, "each collection gets its own id");
});

// --- the confirmation: a debt-payment slip, NOT a sale receipt ---------------

test("the confirmation echoes the server's figures and carries no item lines", () => {
  const c = buildReceivableConfirmation({
    businessName: "Breadee",
    branchName: "Main",
    cashierName: "Sam",
    customerName: "Dana",
    customerPhone: "03 000 000",
    previousBalanceUsd: 12,
    paidAmount: 7,
    paidCurrency: "USD",
    method: "cash",
    at: "now",
    result: {
      ok: true,
      paymentId: "p1",
      orderNumber: "1001",
      paymentStatus: "partial",
      collectedUsd: 7,
      outstandingUsd: 5,
      idempotentReplay: false,
    },
  });
  // Every balance figure is the server's, unrecomputed.
  assert.equal(c.collectedUsd, 7);
  assert.equal(c.previousBalanceUsd, 12);
  assert.equal(c.remainingBalanceUsd, 5);
  // Structurally not a sale receipt: no item-line array anywhere on the type.
  assert.equal("lines" in (c as Record<string, unknown>), false);

  const report = toReceivableReport(c);
  assert.equal(report.title, "RECEIVABLE COLLECTION");
  // It is rendered as a label/value report, so no priced item line can appear.
  assert.equal(JSON.stringify(report).includes("lineTotal"), false);
});

test("the confirmation reuses the report renderer - nothing was added to the native layer", () => {
  // It prints through the generic `printReport`, never the receipt command, and
  // never imports the sale-receipt model.
  assert.match(confirmationSrc, /printReport/);
  assert.doesNotMatch(confirmationSrc, /printReceipt\s*\(/, "a debt slip must not print as a sale receipt");
  assert.doesNotMatch(confirmationSrc, /print_receipt/);
  assert.doesNotMatch(confirmationSrc, /@\/lib\/receipt\b/, "the confirmation is not built on ReceiptData");

  // The Rust receipt renderer knows nothing about receivables - proof the native
  // layer was not touched to add this document.
  const receiptRs = join(tauriRoot, "src", "printing", "receipt.rs");
  if (existsSync(receiptRs)) {
    const rust = readFileSync(receiptRs, "utf8").toLowerCase();
    assert.equal(rust.includes("receivable"), false, "receipt.rs must not gain a receivable concept");
  }
});

// --- the regression guard ----------------------------------------------------

test("a completed on-account order is a receivable, never re-paid via pos_pay_order", () => {
  // The one producer of a completed-but-unpaid order is on-account completion.
  // It must NOT show the plain Pay control (which routes to pos_pay_order and
  // would take the full total again). Debt is collected through the receivables
  // flow only. This is the Wave 2C fix, retained and re-asserted here.
  assert.equal(canSettleOrder({ status: "completed", payment_status: "unpaid" }), false);
  assert.equal(canSettleOrder({ status: "completed", payment_status: "partial" }), false);
  assert.equal(canSettleOrder({ status: "completed", payment_status: "paid" }), false);
  // A genuinely open order awaiting settlement is sent_to_kitchen, not completed.
  assert.equal(canSettleOrder({ status: "sent_to_kitchen", payment_status: "unpaid" }), true);
  // And the plain-pay path never learns the collection RPC's name.
  assert.equal(read("lib", "pos", "orderActions.ts").includes("pos_receivable_collect"), false);
});

test("the screen collects only through the receivables library, never a raw pay RPC", () => {
  const s = stripJsxComments(screenSrc);
  // No direct RPC names in the screen - it goes through the library adapter.
  assert.equal(s.includes("callPosRpc"), false, "the screen must not reach an RPC directly");
  assert.equal(s.includes("pos_pay_order"), false, "the screen must not settle debt via the plain pay path");
  assert.equal(s.includes("pos_pay_table"), false);
  // It uses the collection entry point.
  assert.match(s, /collectReceivable|performCollect/);
});
