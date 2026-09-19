// Phase B1 — offline Takeaway + Cash: durable store, additive migration, and the
// replay engine's exactly-once / recovery / isolation guarantees. Exercises the
// real Dexie store via fake-indexeddb; the server calls are injected so the logic
// is proven without a network.

import "fake-indexeddb/auto";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  localdb,
  addPosOfflineTxn,
  getPosOfflineTxnByOp,
  listPosOfflineTxns,
  pendingPosTxnCount,
  updatePosOfflineTxn,
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
    paid: false,
    ...over,
  };
}

function transport(msg = "Failed to fetch"): Error {
  return Object.assign(new Error(msg), { transport: true });
}

/** A happy-path dependency set with call counters. */
function happyDeps() {
  const calls = { submit: 0, pay: 0, recover: 0, submittedOps: [] as string[] };
  const deps: PosTxnSyncDeps = {
    submit: async (payload) => {
      calls.submit++;
      calls.submittedOps.push((payload as { client_op_id: string }).client_op_id);
      return { order_id: "srv-" + calls.submit, order_number: "260919-000" + calls.submit };
    },
    pay: async () => {
      calls.pay++;
      return {};
    },
    recover: async () => {
      calls.recover++;
      return { verdict: "settled" as const };
    },
    isTransport: (e) => Boolean((e as { transport?: boolean } | null)?.transport),
    hasSession: async () => true,
  };
  return { deps, calls };
}

beforeEach(async () => {
  await localdb.posOfflineTxns.clear();
});

test("store: durable commit, pending count, and listing", async () => {
  await addPosOfflineTxn(makeTxn({ local_txn_id: "L1" }));
  await addPosOfflineTxn(makeTxn({ local_txn_id: "L2" }));
  assert.equal(await pendingPosTxnCount(), 2);
  const list = await listPosOfflineTxns();
  assert.equal(list.length, 2);
});

test("migration: additive v3 preserves Phase-A journal + outbox across a restart", async () => {
  // Prior data in the stores that MUST survive a v3 upgrade.
  await localdb.inflightSubmits.put({
    client_op_id: "opX", payload: { keep: true }, tenant_id: "t1", branch_id: "b1",
    terminal_id: "term1", device_id: "dev1", status: "submitting", created_at: new Date().toISOString(),
  });
  await localdb.outbox.add({
    kind: "pos.save_order", payload: { keep: true }, user_id: "u1", user_name: "C", tenant_id: "t1",
    branch_id: "b1", device_id: "dev1", terminal_id: "term1", created_at: new Date().toISOString(),
    status: "queued", attempts: 0,
  });
  await addPosOfflineTxn(makeTxn({ local_txn_id: "L1" }));
  localdb.close();
  await localdb.open();
  assert.equal(localdb.verno, 3, "database is at schema v3");
  assert.ok(await localdb.inflightSubmits.get("opX"), "Phase-A journal preserved");
  assert.equal(await localdb.outbox.count(), 1, "outbox preserved");
  assert.ok(await localdb.posOfflineTxns.get("L1"), "offline transaction survived restart");
});

test("exactly-once: order + payment each replay once, then the row is synced", async () => {
  await addPosOfflineTxn(makeTxn({ local_txn_id: "L1" }));
  const { deps, calls } = happyDeps();
  const rep = await syncPosTxns(ctx, "test", deps);
  assert.deepEqual(rep.synced, ["L1"]);
  assert.equal(calls.submit, 1, "order submitted once");
  assert.equal(calls.pay, 1, "payment taken once");
  const row = await localdb.posOfflineTxns.get("L1");
  assert.equal(row!.status, "synced");
  assert.equal(row!.paid, true);
  assert.equal(row!.server_order_id, "srv-1");
  assert.equal(row!.server_order_number, "260919-0001");
});

test("exactly-once: a synced transaction is never replayed again", async () => {
  await addPosOfflineTxn(makeTxn({ local_txn_id: "L1" }));
  const first = happyDeps();
  await syncPosTxns(ctx, "test", first.deps);
  const second = happyDeps();
  const rep = await syncPosTxns(ctx, "test", second.deps);
  assert.equal(second.calls.submit, 0, "no second order");
  assert.equal(second.calls.pay, 0, "no second charge");
  assert.equal(rep.synced.length, 0);
});

test("order transport loss: retriable (stays queued), then a retry completes it", async () => {
  await addPosOfflineTxn(makeTxn({ local_txn_id: "L1" }));
  const failing = happyDeps();
  failing.deps.submit = async () => {
    throw transport();
  };
  const r1 = await syncPosTxns(ctx, "test", failing.deps);
  assert.ok(r1.retriable.includes("L1"));
  const mid = await localdb.posOfflineTxns.get("L1");
  assert.equal(mid!.status, "queued", "kept for retry");
  assert.equal(mid!.server_order_id ?? null, null, "no order id recorded yet");

  const ok = happyDeps();
  const r2 = await syncPosTxns(ctx, "test", ok.deps);
  assert.ok(r2.synced.includes("L1"));
  assert.equal(ok.calls.submit, 1);
  assert.equal(ok.calls.pay, 1);
});

test("payment lost response: authoritative re-read settled → synced, no second charge", async () => {
  await addPosOfflineTxn(makeTxn({ local_txn_id: "L1" }));
  const d = happyDeps();
  d.deps.pay = async () => {
    d.calls.pay++;
    throw transport();
  };
  const rep = await syncPosTxns(ctx, "test", d.deps);
  assert.ok(rep.synced.includes("L1"));
  assert.equal(d.calls.recover, 1, "asked the server");
  const row = await localdb.posOfflineTxns.get("L1");
  assert.equal(row!.paid, true);
});

test("payment 'already paid' is treated as success (state-based dedup)", async () => {
  await addPosOfflineTxn(makeTxn({ local_txn_id: "L1" }));
  const d = happyDeps();
  d.deps.pay = async () => {
    throw new Error("This order is already paid");
  };
  const rep = await syncPosTxns(ctx, "test", d.deps);
  assert.ok(rep.synced.includes("L1"));
  assert.equal(d.calls.recover, 1);
});

test("payment transport → re-read UNPAID → retriable, never auto-charged twice", async () => {
  await addPosOfflineTxn(makeTxn({ local_txn_id: "L1" }));
  const d = happyDeps();
  d.deps.pay = async () => {
    throw transport();
  };
  d.deps.recover = async () => ({ verdict: "unpaid" as const });
  const rep = await syncPosTxns(ctx, "test", d.deps);
  assert.ok(rep.retriable.includes("L1"));
  const row = await localdb.posOfflineTxns.get("L1");
  assert.equal(row!.status, "queued");
  assert.equal(row!.paid ?? false, false);
});

test("shift closed at order replay → needs_attention, payment never attempted", async () => {
  await addPosOfflineTxn(makeTxn({ local_txn_id: "L1" }));
  const d = happyDeps();
  d.deps.submit = async () => {
    throw new Error("This shift is closed");
  };
  const rep = await syncPosTxns(ctx, "test", d.deps);
  assert.equal(rep.needsAttention[0]?.id, "L1");
  assert.equal(rep.needsAttention[0]?.reason, "shift_closed");
  assert.equal(d.calls.pay, 0, "no payment on an unposted order");
  const row = await localdb.posOfflineTxns.get("L1");
  assert.equal(row!.status, "needs_attention");
});

test("shift closed at payment replay → needs_attention", async () => {
  await addPosOfflineTxn(makeTxn({ local_txn_id: "L1" }));
  const d = happyDeps();
  d.deps.pay = async () => {
    throw new Error("Use your own open shift for this order");
  };
  const rep = await syncPosTxns(ctx, "test", d.deps);
  assert.equal(rep.needsAttention[0]?.reason, "shift_closed");
  const row = await localdb.posOfflineTxns.get("L1");
  assert.equal(row!.status, "needs_attention");
});

test("isolation: a different tenant / branch / cashier is deferred, never replayed", async () => {
  await addPosOfflineTxn(makeTxn({ local_txn_id: "T", tenant_id: "t2" }));
  await addPosOfflineTxn(makeTxn({ local_txn_id: "B", branch_id: "b2" }));
  await addPosOfflineTxn(makeTxn({ local_txn_id: "U", cashier_user_id: "u2" }));
  const d = happyDeps();
  const rep = await syncPosTxns(ctx, "test", d.deps);
  assert.equal(d.calls.submit, 0, "nothing from another context is replayed");
  assert.deepEqual(rep.deferred.sort(), ["B", "T", "U"]);
  for (const id of ["T", "B", "U"]) {
    assert.equal((await localdb.posOfflineTxns.get(id))!.status, "queued", "left untouched");
  }
});

test("FIFO: transactions replay oldest-first", async () => {
  await addPosOfflineTxn(makeTxn({ local_txn_id: "NEW", client_op_id: "opNew", created_at: "2026-09-19T10:00:00.000Z" }));
  await addPosOfflineTxn(makeTxn({ local_txn_id: "OLD", client_op_id: "opOld", created_at: "2026-09-19T09:00:00.000Z" }));
  const { deps, calls } = happyDeps();
  await syncPosTxns(ctx, "test", deps);
  assert.deepEqual(calls.submittedOps, ["opOld", "opNew"], "older transaction submitted first");
});

test("guard: no live session → nothing replays", async () => {
  await addPosOfflineTxn(makeTxn({ local_txn_id: "L1" }));
  const d = happyDeps();
  d.deps.hasSession = async () => false;
  const rep = await syncPosTxns(ctx, "test", d.deps);
  assert.equal(d.calls.submit, 0);
  assert.equal(rep.synced.length, 0);
  assert.equal((await localdb.posOfflineTxns.get("L1"))!.status, "queued");
});

// --- Phase B1 offline Send-to-kitchen (shared transaction) ------------------

test("sent-only txn (payment_intent null) replays as an unpaid order, never pays", async () => {
  await addPosOfflineTxn(makeTxn({ local_txn_id: "S1", client_op_id: "opSent", payment_intent: null, sent_to_kitchen: true }));
  const { deps, calls } = happyDeps();
  const rep = await syncPosTxns(ctx, "test", deps);
  assert.ok(rep.synced.includes("S1"));
  assert.equal(calls.submit, 1, "order created");
  assert.equal(calls.pay, 0, "a sent-only order is never paid on replay");
  const row = await localdb.posOfflineTxns.get("S1");
  assert.equal(row!.status, "synced");
  assert.equal(row!.paid ?? false, false);
});

test("getPosOfflineTxnByOp finds the row by client_op_id (send↔pay join key)", async () => {
  await addPosOfflineTxn(makeTxn({ local_txn_id: "L1", client_op_id: "opJoin", payment_intent: null }));
  const found = await getPosOfflineTxnByOp("opJoin");
  assert.equal(found?.local_txn_id, "L1");
  assert.equal(await getPosOfflineTxnByOp("nope"), undefined);
});

test("send-then-pay is ONE transaction per client_op_id → one order + one payment", async () => {
  // Offline Send: durable, unpaid.
  await addPosOfflineTxn(makeTxn({ local_txn_id: "L1", client_op_id: "opX", payment_intent: null, sent_to_kitchen: true }));
  // Offline Pay (same cart op): UPSERT into the same row, not a second sale.
  const existing = await getPosOfflineTxnByOp("opX");
  assert.ok(existing, "the sent order is found");
  await updatePosOfflineTxn(existing!.local_txn_id, { payment_intent: { method: "cash", currency: "USD" }, status: "queued", paid: false });
  const all = await localdb.posOfflineTxns.where("client_op_id").equals("opX").toArray();
  assert.equal(all.length, 1, "still exactly ONE transaction for the order");
  const { deps, calls } = happyDeps();
  await syncPosTxns(ctx, "test", deps);
  assert.equal(calls.submit, 1, "exactly one order");
  assert.equal(calls.pay, 1, "exactly one payment");
  const row = await localdb.posOfflineTxns.get("L1");
  assert.equal(row!.status, "synced");
  assert.equal(row!.paid, true);
});

test("restart after Send, before Pay: sent-only txn persists and is still payable", async () => {
  await addPosOfflineTxn(makeTxn({ local_txn_id: "L1", client_op_id: "opR", payment_intent: null, sent_to_kitchen: true }));
  localdb.close();
  await localdb.open();
  const found = await getPosOfflineTxnByOp("opR");
  assert.ok(found, "sent order survived restart");
  assert.equal(found!.payment_intent, null, "still unpaid, still one transaction");
});
