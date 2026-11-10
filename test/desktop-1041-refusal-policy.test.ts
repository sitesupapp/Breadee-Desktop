// 1.0.41 (BUG 03 RC-C / RC-D / RC-B) — refusal classes decide Retry; the 1.0.40 server holds are mapped; a Retry
// never re-sends a deterministic refusal, never re-queues a child of a refused parent, never runs while the
// server is not answering; counts say which work the current sign-in will not send.
//
// Real Dexie (fake-indexeddb) for the op log; synthetic fixtures only. No network, no Staging, no Production.

import "fake-indexeddb/auto";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? (this.m.get(k) as string) : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
(globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage();

import { localdb } from "@/lib/offline/db";
import { getOperation, type OfflineOperation } from "@/lib/offline/operationLog";
import { recoveryOf, retryHelps, effectiveRefusalCode, noRetryText, retryPrecondition } from "@/lib/offline/refusalPolicy";
import { canRetry, canRetryOp, displayStateOf, countOwnedByOthers, ownedByOthersText, ownedByOther } from "@/components/sync/syncCenterModel";
import { serverHoldCode } from "@/lib/offline/handlers";
import { operatorRetry, RETRY_SERVER_OFF } from "@/lib/offline/syncActions";
import { __resetReachabilityForTests, markBackendDegraded, markBackendUnreachable } from "@/lib/offline/reachability";
import { adviceFor } from "@/lib/offline/queueForensics";

const SCOPE = { tenant_id: "t1", branch_id: "b1", device_id: "dev-1", terminal_id: "term-1", cashier_user_id: "u1" };

function op(id: string, over: Partial<OfflineOperation>): OfflineOperation {
  return {
    operation_id: id,
    operation_type: "pay_table",
    schema_version: 1,
    scope: { ...SCOPE },
    created_at: new Date(Date.now() - 60_000).toISOString(),
    client_op_id: `cop-${id}`,
    local_entity_id: null,
    canonical_entity_id: null,
    dependency_ids: [],
    depends_on_local_entities: [],
    payload: {},
    status: "needs_attention",
    retry_count: 1,
    last_attempt_at: null,
    last_error_code: null,
    last_error_message: null,
    result_meta: null,
    synced_at: null,
    ...over,
  };
}

beforeEach(async () => {
  await localdb.operations.clear();
  __resetReachabilityForTests(async () => true);
});

test("deterministic refusals of the frozen request are 'review' — no Retry (RC-C list)", () => {
  for (const code of ["already_settled", "already_paid", "pay_bill_changed", "expected_order_mismatch", "shift_missing", "pay_amount_changed", "on_account_bill_changed", "payment_residue", "merge_bill_changed", "move_dest_occupied", "price_changed", "already_paid_elsewhere"]) {
    const o = op(code, { last_error_code: code, last_error_message: "refused" });
    assert.equal(recoveryOf(o), "review", code);
    assert.equal(retryHelps(o), false, code);
    assert.equal(canRetryOp(displayStateOf(o.status, o.last_error_code, String(o.operation_type)), o), false, code);
    assert.match(noRetryText(o), /cannot succeed/);
  }
});

test("a child parked behind a refused parent is 'via_parent' — never retried on its own", () => {
  const child = op("child", { operation_type: "dinein_send_round", last_error_code: "dependency_failed", last_error_message: "parent-op" });
  assert.equal(recoveryOf(child), "via_parent");
  assert.equal(canRetryOp("needs_attention", child), false);
  assert.match(noRetryText(child), /earlier step/);
});

test("conditions a person can clear stay retryable (kitchen, collector shift, transfer, permission, transient); unknown codes keep the old behaviour", () => {
  const kitchen = op("k", { operation_type: "merge_tables", last_error_code: "unsupported_state", last_error_message: "UNSUPPORTED_STATE: cannot merge (reason: kitchen_active)" });
  assert.equal(effectiveRefusalCode(kitchen), "kitchen_active");
  assert.equal(recoveryOf(kitchen), "retry");
  assert.match(retryPrecondition(kitchen) ?? "", /kitchen/);
  const partial = op("p", { operation_type: "merge_tables", last_error_code: "unsupported_state", last_error_message: "UNSUPPORTED_STATE (reason: partial_line)" });
  assert.equal(recoveryOf(partial), "review", "other merge reasons name the bill itself");
  for (const code of ["collector_no_open_shift", "collector_shift_closed", "order_transfer_pending", "permission", "retry_exhausted", "something_new_from_a_future_server"]) {
    assert.equal(recoveryOf(op(code, { last_error_code: code })), "retry", code);
  }
  assert.equal(recoveryOf(op("legacy", { operation_type: "legacy_outbox:sale", last_error_code: "x" })), "legacy");
  assert.equal(recoveryOf(op("synced", { status: "synced" })), null);
});

test("a CAS-refused table open is 'rebase' (Retry re-checks Breadee)", () => {
  const open = op("open", { operation_type: "dinein_open_table", local_entity_id: "TBL-X", last_error_code: "version_conflict", last_error_message: "This table changed since it was loaded. Reload and try again." });
  assert.equal(recoveryOf(open), "rebase");
  assert.equal(canRetryOp("conflict", open), true);
  // the same code on a frozen move is a review, not a rebase
  assert.equal(recoveryOf(op("mv", { operation_type: "move_table", schema_version: 2, last_error_code: "version_conflict", last_error_message: "VERSION_CONFLICT" })), "review");
});

test("canRetry(state) is unchanged; canRetryOp adds the refusal class on top", () => {
  assert.equal(canRetry("needs_attention"), true);
  assert.equal(canRetry("conflict"), true);
  assert.equal(canRetry("manager_review"), false);
  assert.equal(canRetryOp("pending", op("x", { status: "pending" })), false);
});

test("RC-D: UNSUPPORTED_STATE refusals now display as Conflict (was cosmetic)", () => {
  assert.equal(displayStateOf("needs_attention", "unsupported_state", "merge_tables"), "conflict");
  assert.equal(displayStateOf("needs_attention", "already_paid_elsewhere", "takeaway_sale"), "conflict");
});

test("RC-D: the 1.0.40 server holds map by structured code or by the server's fixed wording", () => {
  const detail = (code: string, message: string) => ({ message, code: "P0001", details: JSON.stringify({ pos_error_code: code }) });
  assert.equal(serverHoldCode("Open your own shift on this branch before taking this payment. Nothing was charged.", detail("COLLECTOR_NO_OPEN_SHIFT", "x")), "collector_no_open_shift");
  assert.equal(serverHoldCode("Open your own shift on this branch before taking this payment. Nothing was charged."), "collector_no_open_shift");
  assert.equal(serverHoldCode("Your shift closed while this payment was being taken. Open a shift and retry. Nothing was charged."), "collector_shift_closed");
  assert.equal(serverHoldCode("This order is waiting for a transfer decision."), "order_transfer_pending");
  assert.equal(serverHoldCode("x", detail("ORDER_TRANSFER_PENDING", "x")), "order_transfer_pending");
  assert.equal(serverHoldCode("Payment amount changed"), null);
});

test("operatorRetry refuses a deterministic refusal and a refused-parent child: nothing re-queued, no drain", async () => {
  await localdb.operations.bulkPut([
    op("root", { last_error_code: "pay_bill_changed", last_error_message: "PAY_BILL_CHANGED" }),
    op("kid", { operation_type: "end_shift", dependency_ids: ["root"], last_error_code: "dependency_failed", last_error_message: "root" }),
  ]);
  let drains = 0;
  const drain = async () => { drains++; return 1; };
  const a = await operatorRetry("root", { actorUserId: "u1", drain });
  assert.equal(a.ok, false);
  assert.match(a.text, /cannot succeed/);
  const b = await operatorRetry("kid", { actorUserId: "u1", drain });
  assert.equal(b.ok, false);
  assert.match(b.text, /earlier step/);
  assert.equal(drains, 0);
  assert.equal((await getOperation("root"))?.status, "needs_attention");
  assert.equal((await getOperation("kid"))?.status, "needs_attention", "the chain is NOT flipped to Pending");
});

test("operatorRetry while the server is not answering re-queues nothing (no 'Retry → Pending, never synced')", async () => {
  await localdb.operations.bulkPut([
    op("k", { operation_type: "merge_tables", last_error_code: "unsupported_state", last_error_message: "UNSUPPORTED_STATE (reason: kitchen_active)" }),
    op("kid", { dependency_ids: ["k"], last_error_code: "dependency_failed", last_error_message: "k" }),
  ]);
  markBackendDegraded();
  let drains = 0;
  const r = await operatorRetry("k", { actorUserId: "u1", drain: async () => { drains++; return 1; } });
  assert.deepEqual(r, { ok: false, text: RETRY_SERVER_OFF });
  markBackendUnreachable();
  assert.deepEqual(await operatorRetry("k", { actorUserId: "u1", drain: async () => { drains++; return 1; } }), { ok: false, text: RETRY_SERVER_OFF });
  assert.equal(drains, 0);
  assert.equal((await getOperation("k"))?.status, "needs_attention");
  assert.equal((await getOperation("kid"))?.status, "needs_attention");
});

test("operatorRetry of a clearable hold re-sends the SAME op (same client_op_id) and cascades its chain once healthy", async () => {
  await localdb.operations.bulkPut([
    op("k", { operation_type: "merge_tables", last_error_code: "unsupported_state", last_error_message: "UNSUPPORTED_STATE (reason: kitchen_active)" }),
    op("kid", { dependency_ids: ["k"], last_error_code: "dependency_failed", last_error_message: "k" }),
  ]);
  let drains = 0;
  const r = await operatorRetry("k", { actorUserId: "u1", drain: async () => { drains++; return 1; } });
  assert.equal(drains, 1);
  assert.equal(r.ok, false, "the fake drain does not sync it");
  const k = await getOperation("k");
  assert.equal(k?.status, "pending");
  assert.equal(k?.client_op_id, "cop-k", "the idempotency key never changes");
  assert.equal((await getOperation("kid"))?.status, "pending");
});

test("advice never tells the operator to Retry a review-class refusal; a clearable hold names what to clear", () => {
  const review = op("r", { operation_type: "pay_table", last_error_code: "already_settled", last_error_message: "already settled" });
  const a = adviceFor(review, new Map([[review.operation_id, review]]));
  assert.match(a?.action ?? "", /Do not press Retry/);
  const hold = op("h", { operation_type: "pay_order", last_error_code: "collector_no_open_shift", last_error_message: "Open your own shift on this branch before taking this payment." });
  assert.match(adviceFor(hold, new Map([[hold.operation_id, hold]]))?.action ?? "", /Open that shift, then press Retry/);
});

test("RC-B: work of another cashier / terminal is counted AND named (it does not drain under this sign-in)", async () => {
  await localdb.operations.bulkPut([
    op("mine", { status: "pending" }),
    op("theirs", { status: "pending", scope: { ...SCOPE, cashier_user_id: "u2" } }),
    op("other-dev", { status: "needs_attention", last_error_code: "permission", scope: { ...SCOPE, device_id: "dev-2" } }),
    op("other-branch", { status: "pending", scope: { ...SCOPE, cashier_user_id: "u2", branch_id: "b2" } }),
    op("done", { status: "synced", scope: { ...SCOPE, cashier_user_id: "u2" } }),
  ]);
  const mine = { cashierUserId: "u1", deviceId: "dev-1" };
  assert.equal(await countOwnedByOthers("t1", "b1", mine), 2);
  assert.equal(await countOwnedByOthers("t1", null, mine), 3, "tenant-wide counts every branch");
  assert.equal(ownedByOther(SCOPE, mine), false);
  assert.match(ownedByOthersText(2) ?? "", /another cashier or on another terminal/);
  assert.equal(ownedByOthersText(0), null);
});
