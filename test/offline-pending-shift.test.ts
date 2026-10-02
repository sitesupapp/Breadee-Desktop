// Case 2 - a shift OPENED while offline, and the reconnect dependency chain:
//   LOCAL SHIFT OPEN -> OFFLINE ORDER -> CASH PAYMENT
// must replay as, exactly once:
//   SHIFT OPEN (canonical) -> ORDER SUBMIT -> PAY ORDER
// surviving restart, repeated reconnect and connectivity flap, and adopting any
// shift the server already has open. Exercises the REAL Dexie stores via
// fake-indexeddb; the server open/submit/pay are injected.

import "fake-indexeddb/auto";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  localdb,
  addPendingShift,
  getPendingShift,
  getActivePendingShift,
  addPosOfflineTxn,
  type PendingShift,
  type PosOfflineTxn,
} from "@/lib/offline/db";
import { createLocalPendingShift, pendingShiftToActiveShift } from "@/lib/offline/pendingShift";
import { syncPosTxns, type PosTxnSyncDeps } from "@/lib/offline/posTxnSync";

// device.ts reads localStorage; a Map shim keeps createLocalPendingShift pure here.
class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? (this.m.get(k) as string) : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
(globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage();

const ctx = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", online: true };

function makePending(over: Partial<PendingShift> = {}): PendingShift {
  const localId = over.local_shift_id ?? "local-shift-" + crypto.randomUUID().slice(0, 6);
  return {
    local_shift_id: localId,
    client_op_id: over.client_op_id ?? "op-shift-" + localId.slice(-6),
    tenant_id: "t1",
    branch_id: "b1",
    device_id: "dev1",
    terminal_id: "term1",
    cashier_user_id: "u1",
    opening_cash_amount: 50,
    currency: "LBP",
    opened_at: new Date().toISOString(),
    status: "pending_sync",
    attempts: 0,
    ...over,
  };
}

function makeDependentTxn(localShiftId: string, over: Partial<PosOfflineTxn> = {}): PosOfflineTxn {
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
    shift_id: localShiftId, // the LOCAL shift id at capture
    created_at: over.created_at ?? new Date().toISOString(),
    order_payload: { client_op_id: op, order_type: "takeaway", shift_id: localShiftId, branch_id: "b1", status: "sent_to_kitchen", notes: null, items: [] },
    payment_intent: { method: "cash", currency: "LBP" },
    currency: "LBP",
    total: 10,
    status: "queued",
    attempts: 0,
    pending_shift_local_id: localShiftId,
    ...over,
  };
}

type Counters = { opens: number; submits: number; pays: number; submittedShiftIds: string[] };

function deps(c: Counters, over: Partial<PosTxnSyncDeps> = {}): PosTxnSyncDeps {
  return {
    submit: async (payload) => {
      c.submits++;
      c.submittedShiftIds.push((payload as { shift_id: string }).shift_id);
      return { order_id: "srv-order-" + c.submits, order_number: "N" + c.submits };
    },
    pay: async () => { c.pays++; return { paid: true }; },
    openShift: async () => { c.opens++; return { shiftId: "SRV-SHIFT", reused: false }; },
    isTransport: (e) => e instanceof TypeError,
    hasSession: async () => true,
    ...over,
  };
}

beforeEach(async () => {
  await localdb.posOfflineTxns.clear();
  await localdb.pendingShifts.clear();
});

test("createLocalPendingShift persists; it projects to an OPEN ActiveShift usable by POS", async () => {
  const p = await createLocalPendingShift({ tenantId: "t1", branchId: "b1", cashierUserId: "u1", openingCashAmount: 50, currency: "LBP" });
  assert.equal((await getPendingShift(p.local_shift_id))?.status, "pending_sync");
  const active = pendingShiftToActiveShift(p);
  assert.equal(active.id, p.local_shift_id, "the active shift id is the LOCAL id until reconnect");
  assert.equal(active.status, "open");
  assert.equal(active.opening_cash_amount, 50);
});

test("getActivePendingShift is scoped to this tenant+cashier", async () => {
  await addPendingShift(makePending({ local_shift_id: "mine" }));
  await addPendingShift(makePending({ local_shift_id: "theirs", cashier_user_id: "u2" }));
  assert.equal((await getActivePendingShift("t1", "u1"))?.local_shift_id, "mine");
  assert.equal(await getActivePendingShift("t1", "u2").then((s) => s?.local_shift_id), "theirs");
  assert.equal(await getActivePendingShift("tOther", "u1"), undefined);
});

test("reconnect: open the shift ONCE, remap the order to the canonical id, submit once, pay once", async () => {
  const p = makePending({ local_shift_id: "L1" });
  await addPendingShift(p);
  await addPosOfflineTxn(makeDependentTxn("L1"));
  const c: Counters = { opens: 0, submits: 0, pays: 0, submittedShiftIds: [] };
  const report = await syncPosTxns(ctx, "reconnect", deps(c));
  assert.equal(c.opens, 1, "shift opened exactly once");
  assert.equal(c.submits, 1, "order submitted once");
  assert.equal(c.pays, 1, "paid once");
  assert.equal(c.submittedShiftIds[0], "SRV-SHIFT", "order was remapped to the canonical server shift id");
  assert.equal(report.synced.length, 1);
  // The pending shift is reconciled, and the txn carries the canonical id durably.
  assert.equal((await getPendingShift("L1"))?.status, "synced");
  assert.equal((await getPendingShift("L1"))?.server_shift_id, "SRV-SHIFT");
  const txn = (await localdb.posOfflineTxns.toArray())[0];
  assert.equal(txn.status, "synced");
  assert.equal(txn.pending_shift_local_id ?? null, null, "dependency marker cleared after remap");
  assert.equal((txn.order_payload as { shift_id: string }).shift_id, "SRV-SHIFT");
});

test("repeated reconnect / flap adds nothing: 1 shift, 1 order, 1 payment total", async () => {
  await addPendingShift(makePending({ local_shift_id: "L1" }));
  await addPosOfflineTxn(makeDependentTxn("L1"));
  const c: Counters = { opens: 0, submits: 0, pays: 0, submittedShiftIds: [] };
  await syncPosTxns(ctx, "reconnect-1", deps(c));
  await syncPosTxns(ctx, "reconnect-2", deps(c));
  await syncPosTxns(ctx, "reconnect-3", deps(c));
  assert.equal(c.opens, 1, "shift opened exactly once across repeated reconnects");
  assert.equal(c.submits, 1);
  assert.equal(c.pays, 1);
});

test("two offline orders against the SAME offline shift open it only once", async () => {
  await addPendingShift(makePending({ local_shift_id: "L1" }));
  await addPosOfflineTxn(makeDependentTxn("L1", { created_at: "2026-09-30T10:00:00Z" }));
  await addPosOfflineTxn(makeDependentTxn("L1", { created_at: "2026-09-30T10:05:00Z" }));
  const c: Counters = { opens: 0, submits: 0, pays: 0, submittedShiftIds: [] };
  await syncPosTxns(ctx, "reconnect", deps(c));
  assert.equal(c.opens, 1, "one shift open for two dependent orders");
  assert.equal(c.submits, 2);
  assert.equal(c.pays, 2);
  assert.deepEqual(c.submittedShiftIds, ["SRV-SHIFT", "SRV-SHIFT"]);
});

test("conflict: a shift already open on the server is ADOPTED (reused), never duplicated", async () => {
  await addPendingShift(makePending({ local_shift_id: "L1" }));
  await addPosOfflineTxn(makeDependentTxn("L1"));
  const c: Counters = { opens: 0, submits: 0, pays: 0, submittedShiftIds: [] };
  await syncPosTxns(ctx, "reconnect", deps(c, {
    openShift: async () => { c.opens++; return { shiftId: "EXISTING-SRV", reused: true }; },
  }));
  assert.equal(c.opens, 1);
  assert.equal(c.submittedShiftIds[0], "EXISTING-SRV", "orders bind to the server's existing open shift");
  assert.equal((await getPendingShift("L1"))?.server_shift_id, "EXISTING-SRV");
});

test("shift-open transport failure keeps the dependent order QUEUED (retriable), shift still pending", async () => {
  await addPendingShift(makePending({ local_shift_id: "L1" }));
  await addPosOfflineTxn(makeDependentTxn("L1"));
  const c: Counters = { opens: 0, submits: 0, pays: 0, submittedShiftIds: [] };
  const report = await syncPosTxns(ctx, "reconnect", deps(c, {
    openShift: async () => { c.opens++; throw new TypeError("Failed to fetch"); },
  }));
  assert.equal(c.submits, 0, "no order submitted without a canonical shift");
  assert.equal(report.retriable.length, 1);
  assert.equal(report.needsAttention.length, 0);
  assert.equal((await localdb.posOfflineTxns.toArray())[0].status, "queued");
  assert.equal((await getPendingShift("L1"))?.status, "pending_sync", "shift stays pending for a later retry");
});

test("shift-open definitive refusal parks BOTH the shift and its orders for a human", async () => {
  await addPendingShift(makePending({ local_shift_id: "L1" }));
  await addPosOfflineTxn(makeDependentTxn("L1"));
  const c: Counters = { opens: 0, submits: 0, pays: 0, submittedShiftIds: [] };
  const report = await syncPosTxns(ctx, "reconnect", deps(c, {
    openShift: async () => { c.opens++; throw new Error("You do not have permission to open a shift"); },
  }));
  assert.equal(c.submits, 0);
  assert.equal(report.needsAttention.length, 1);
  assert.equal((await localdb.posOfflineTxns.toArray())[0].status, "needs_attention");
  assert.equal((await getPendingShift("L1"))?.status, "needs_attention");
});

test("a dependent order whose pending shift row is missing goes to needs_attention, never silently", async () => {
  await addPosOfflineTxn(makeDependentTxn("GONE"));
  const c: Counters = { opens: 0, submits: 0, pays: 0, submittedShiftIds: [] };
  const report = await syncPosTxns(ctx, "reconnect", deps(c));
  assert.equal(c.opens, 0);
  assert.equal(c.submits, 0);
  assert.equal(report.needsAttention.length, 1);
  assert.equal((await localdb.posOfflineTxns.toArray())[0].status, "needs_attention");
});
