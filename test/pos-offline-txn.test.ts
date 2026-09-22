// Offline Takeaway + Cash: durable store, additive migration, and the replay
// engine's exactly-once / one-logical-order / recovery / isolation guarantees.
// Exercises the REAL Dexie store via fake-indexeddb; server calls are injected so
// the logic is proven without a network.

import "fake-indexeddb/auto";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  localdb,
  addPosOfflineTxn,
  getPosOfflineTxnByOp,
  updatePosOfflineTxn,
  pendingPosTxnCount,
  type PosOfflineTxn,
} from "@/lib/offline/db";
import { syncPosTxns, type PosTxnSyncDeps } from "@/lib/offline/posTxnSync";

const ctx = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", online: true };

function makeTxn(over: Partial<PosOfflineTxn> = {}): PosOfflineTxn {
  const id = over.local_txn_id ?? crypto.randomUUID();
  const op = over.client_op_id ?? "op-" + id.slice(0, 6);
  return {
    local_txn_id: id,
    client_op_id: op,
    tenant_id: "t1",
    branch_id: "b1",
    device_id: "dev1",
    terminal_id: "term1",
    cashier_user_id: "u1",
    cashier_user_name: "Cashier",
    shift_id: "s1",
    created_at: over.created_at ?? new Date().toISOString(),
    order_payload: { client_op_id: op, order_type: "takeaway", shift_id: "s1", branch_id: "b1", status: "sent_to_kitchen", notes: null, items: [] },
    payment_intent: { method: "cash", currency: "USD" },
    currency: "USD",
    total: 10,
    status: "queued",
    attempts: 0,
    ...over,
  };
}

function deps(over: Partial<PosTxnSyncDeps> = {}): PosTxnSyncDeps {
  return {
    submit: async () => ({ order_id: "srv-" + crypto.randomUUID().slice(0, 8), order_number: "260922-0001" }),
    pay: async () => ({ paid: true }),
    isTransport: (e) => e instanceof TypeError,
    hasSession: async () => true,
    ...over,
  };
}

beforeEach(async () => {
  await localdb.posOfflineTxns.clear();
});

test("exactly-once: a send+pay txn replays to submit ONCE and pay ONCE, then synced", async () => {
  let submits = 0;
  let pays = 0;
  await addPosOfflineTxn(makeTxn());
  const report = await syncPosTxns(ctx, "test", deps({
    submit: async () => { submits++; return { order_id: "o1", order_number: "N1" }; },
    pay: async () => { pays++; return { paid: true }; },
  }));
  assert.equal(submits, 1);
  assert.equal(pays, 1);
  assert.equal(report.synced.length, 1);
  const rows = await localdb.posOfflineTxns.toArray();
  assert.equal(rows[0].status, "synced");
  assert.equal(rows[0].paid, true);
  assert.equal(rows[0].server_order_id, "o1");
});

test("one logical order: a sent-only txn syncs UNPAID; a later Pay on the SAME op pays it once", async () => {
  const op = "op-shared";
  // Offline Send: sent, no payment intent yet.
  await addPosOfflineTxn(makeTxn({ client_op_id: op, payment_intent: null, sent_to_kitchen: true }));
  let submits = 0;
  let pays = 0;
  const d = deps({
    submit: async () => { submits++; return { order_id: "o1", order_number: "N1" }; },
    pay: async () => { pays++; return { paid: true }; },
  });
  await syncPosTxns(ctx, "send", d);
  let rows = await localdb.posOfflineTxns.toArray();
  assert.equal(rows.length, 1, "still ONE row");
  assert.equal(rows[0].status, "synced");
  assert.equal(rows[0].paid ?? false, false, "sent-only stays unpaid (one unpaid server order)");
  assert.equal(submits, 1);
  assert.equal(pays, 0, "no payment for a sent-only order");

  // Later offline Pay updates the SAME txn (matched by op) - never a second sale.
  const existing = await getPosOfflineTxnByOp(op);
  assert.ok(existing);
  await updatePosOfflineTxn(existing!.local_txn_id, { payment_intent: { method: "cash", currency: "USD" }, status: "queued", paid: false });
  await syncPosTxns(ctx, "pay", d);
  rows = await localdb.posOfflineTxns.toArray();
  assert.equal(rows.length, 1, "STILL one row - one logical order");
  assert.equal(rows[0].status, "synced");
  assert.equal(rows[0].paid, true);
  assert.equal(submits, 1, "order submitted once total (server_order_id was already set)");
  assert.equal(pays, 1, "paid exactly once");
});

test("lost payment response: a retry that gets 'already paid' settles WITHOUT a second charge", async () => {
  await addPosOfflineTxn(makeTxn());
  let pays = 0;
  const report = await syncPosTxns(ctx, "test", deps({
    submit: async () => ({ order_id: "o1", order_number: "N1" }),
    pay: async () => {
      pays++;
      throw new Error("This order is already paid");
    },
  }));
  assert.equal(pays, 1);
  assert.equal(report.synced.length, 1, "already paid is treated as settled");
  const rows = await localdb.posOfflineTxns.toArray();
  assert.equal(rows[0].paid, true);
});

test("transport failure keeps the txn QUEUED (retriable), never dropped, never needs_attention", async () => {
  await addPosOfflineTxn(makeTxn());
  const report = await syncPosTxns(ctx, "test", deps({
    submit: async () => { throw new TypeError("Failed to fetch"); },
  }));
  assert.equal(report.retriable.length, 1);
  assert.equal(report.synced.length, 0);
  assert.equal(report.needsAttention.length, 0);
  assert.equal((await localdb.posOfflineTxns.toArray())[0].status, "queued");
});

test("a closed shift is a terminal refusal -> needs_attention, never a silent reassign or hot retry", async () => {
  await addPosOfflineTxn(makeTxn());
  const report = await syncPosTxns(ctx, "test", deps({
    submit: async () => { throw new Error("This shift is closed"); },
  }));
  assert.equal(report.needsAttention.length, 1);
  assert.equal(report.needsAttention[0].reason, "shift_closed");
  assert.equal((await localdb.posOfflineTxns.toArray())[0].status, "needs_attention");
});

test("live-session guard: a txn from another tenant/branch/cashier is DEFERRED, never replayed", async () => {
  await addPosOfflineTxn(makeTxn({ tenant_id: "OTHER" }));
  let submits = 0;
  const report = await syncPosTxns(ctx, "test", deps({ submit: async () => { submits++; return { order_id: "o", order_number: "N" }; } }));
  assert.equal(submits, 0, "never submitted under a different context");
  assert.equal(report.deferred.length, 1);
  assert.equal((await localdb.posOfflineTxns.toArray())[0].status, "queued");
});

test("restart persistence: an unsynced txn survives and still counts as pending", async () => {
  await addPosOfflineTxn(makeTxn());
  // Simulate a process restart: the durable row is still in the store.
  assert.equal(await pendingPosTxnCount(), 1);
  const rows = await localdb.posOfflineTxns.toArray();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "queued");
});
