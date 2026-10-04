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

const ctx = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", online: true };

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

test("getActivePendingShift is scoped to this tenant+cashier+branch/OU+device", async () => {
  await addPendingShift(makePending({ local_shift_id: "mine" }));
  await addPendingShift(makePending({ local_shift_id: "theirs", cashier_user_id: "u2" }));
  await addPendingShift(makePending({ local_shift_id: "otherBranch", branch_id: "b2" }));
  await addPendingShift(makePending({ local_shift_id: "otherDevice", device_id: "dev2" }));
  assert.equal((await getActivePendingShift("t1", "u1", "b1", "dev1"))?.local_shift_id, "mine");
  assert.equal(await getActivePendingShift("t1", "u2", "b1", "dev1").then((s) => s?.local_shift_id), "theirs");
  // Wrong tenant, branch/OU, or device never surfaces another context's shift.
  assert.equal(await getActivePendingShift("tOther", "u1", "b1", "dev1"), undefined);
  assert.equal(await getActivePendingShift("t1", "u1", "b2", "dev1").then((s) => s?.local_shift_id), "otherBranch");
  assert.equal(await getActivePendingShift("t1", "u1", "b9", "dev1"), undefined, "no shift for an unknown branch");
  assert.equal(await getActivePendingShift("t1", "u1", "b1", "dev2").then((s) => s?.local_shift_id), "otherDevice");
  assert.equal(await getActivePendingShift("t1", "u1", "b1", "dev9"), undefined, "no shift for an unknown device");
  // A null branch (single-OU tenant) is distinct from a concrete branch id.
  assert.equal(await getActivePendingShift("t1", "u1", null, "dev1"), undefined, "null branch never matches branch b1");
});

test("getActivePendingShift ignores needs_attention and synced shifts (pending_sync only)", async () => {
  await addPendingShift(makePending({ local_shift_id: "parked", status: "needs_attention" }));
  await addPendingShift(makePending({ local_shift_id: "done", status: "synced", server_shift_id: "SRV" }));
  assert.equal(await getActivePendingShift("t1", "u1", "b1", "dev1"), undefined, "a refused/synced shift is never active");
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

// --- scope isolation: the sync engine must never open another context's shift ---

test("reconnect does NOT open a pending shift from another branch/OU", async () => {
  // A shift opened offline for branch b2, while the live session is branch b1.
  await addPendingShift(makePending({ local_shift_id: "L-b2", branch_id: "b2" }));
  const c: Counters = { opens: 0, submits: 0, pays: 0, submittedShiftIds: [] };
  const report = await syncPosTxns(ctx, "reconnect", deps(c));
  assert.equal(c.opens, 0, "a sibling-branch pending shift is never opened by this session");
  assert.equal(report.shiftsSynced.length, 0);
  assert.equal(report.shiftsNeedsAttention.length, 0, "it is simply out of scope, not parked");
  assert.equal((await getPendingShift("L-b2"))?.status, "pending_sync", "left untouched for its own session");
});

test("reconnect does NOT open a pending shift from another device", async () => {
  await addPendingShift(makePending({ local_shift_id: "L-dev2", device_id: "dev2" }));
  const c: Counters = { opens: 0, submits: 0, pays: 0, submittedShiftIds: [] };
  const report = await syncPosTxns(ctx, "reconnect", deps(c));
  assert.equal(c.opens, 0, "another device's pending shift is never opened here");
  assert.equal(report.shiftsSynced.length, 0);
  assert.equal((await getPendingShift("L-dev2"))?.status, "pending_sync");
});

test("a dependent order whose pending shift is out of scope is parked, never opened under this context", async () => {
  // The order's shift belongs to another device; the engine must refuse to open it.
  await addPendingShift(makePending({ local_shift_id: "L-x", device_id: "dev2" }));
  await addPosOfflineTxn(makeDependentTxn("L-x"));
  const c: Counters = { opens: 0, submits: 0, pays: 0, submittedShiftIds: [] };
  const report = await syncPosTxns(ctx, "reconnect", deps(c));
  assert.equal(c.opens, 0, "scope mismatch must not open the shift");
  assert.equal(c.submits, 0, "and must not submit the order against a foreign shift");
  assert.equal(report.needsAttention.length, 1);
  assert.equal(report.needsAttention[0].reason, "shift_scope_mismatch");
  assert.equal((await localdb.posOfflineTxns.toArray())[0].status, "needs_attention");
});

// --- saleless reconcile: an offline shift with no order must still open once ---

test("reconnect opens an in-scope offline shift even with NO dependent sale (saleless)", async () => {
  await addPendingShift(makePending({ local_shift_id: "L-solo" }));
  const c: Counters = { opens: 0, submits: 0, pays: 0, submittedShiftIds: [] };
  const report = await syncPosTxns(ctx, "reconnect", deps(c));
  assert.equal(c.opens, 1, "a shift opened offline is reconciled on reconnect independent of any sale");
  assert.equal(c.submits, 0);
  assert.deepEqual(report.shiftsSynced, ["L-solo"]);
  assert.equal((await getPendingShift("L-solo"))?.status, "synced");
  assert.equal((await getPendingShift("L-solo"))?.server_shift_id, "SRV-SHIFT");
});

test("a needs_attention offline shift is NOT auto-reopened by the saleless reconcile", async () => {
  await addPendingShift(makePending({ local_shift_id: "L-parked", status: "needs_attention", review_reason: "permission" }));
  const c: Counters = { opens: 0, submits: 0, pays: 0, submittedShiftIds: [] };
  const report = await syncPosTxns(ctx, "reconnect", deps(c));
  assert.equal(c.opens, 0, "a definitively refused shift awaits human reconciliation, never an auto-reopen");
  assert.equal(report.shiftsSynced.length, 0);
  assert.equal((await getPendingShift("L-parked"))?.status, "needs_attention");
});

// --- exactly-once offline open under concurrency ---

test("concurrent offline Open-Shift for the same context yields exactly ONE pending shift", async () => {
  const args = { tenantId: "t1", branchId: "b1" as string | null, cashierUserId: "u1", openingCashAmount: 50, currency: "LBP" };
  const results = await Promise.all([
    createLocalPendingShift(args),
    createLocalPendingShift(args),
    createLocalPendingShift(args),
  ]);
  const ids = new Set(results.map((r) => r.local_shift_id));
  assert.equal(ids.size, 1, "all concurrent opens resolve to the one durable pending shift");
  const rows = await localdb.pendingShifts.where("status").equals("pending_sync").toArray();
  assert.equal(rows.length, 1, "exactly one pending_sync row exists for the context");
});

test("a second Open-Shift after one already exists returns the SAME shift (no duplicate)", async () => {
  const args = { tenantId: "t1", branchId: "b1" as string | null, cashierUserId: "u1", openingCashAmount: 50, currency: "LBP" };
  const first = await createLocalPendingShift(args);
  const second = await createLocalPendingShift(args);
  assert.equal(second.local_shift_id, first.local_shift_id);
  assert.equal((await localdb.pendingShifts.count()), 1);
});

// --- the canonicalization-race invariant (Fix 6) at the engine boundary ---

test("an already-synced pending shift is STILL rejected on a device/OU mismatch (scope before reuse)", async () => {
  // The shift is already synced and carries a canonical server id, but it belongs to
  // another device. Its canonical id must NOT leak into this context's replay: the
  // scope check runs BEFORE the synced fast-path.
  await addPendingShift(makePending({ local_shift_id: "L-synced-foreign", status: "synced", server_shift_id: "LEAK-SRV", device_id: "dev2" }));
  // A dependent sale that passes the txn tenant/branch/cashier guard (device is not
  // part of that guard) but whose shift is the out-of-scope synced one above.
  await addPosOfflineTxn(makeDependentTxn("L-synced-foreign"));
  const c: Counters = { opens: 0, submits: 0, pays: 0, submittedShiftIds: [] };
  const report = await syncPosTxns(ctx, "reconnect", deps(c));
  assert.equal(c.submits, 0, "a foreign synced shift id is never submitted");
  assert.ok(!c.submittedShiftIds.includes("LEAK-SRV"), "the foreign canonical id never leaks into replay");
  assert.equal(report.needsAttention.length, 1);
  assert.equal(report.needsAttention[0].reason, "shift_scope_mismatch");
});

test("post-switch context: replay under a NEW branch/OU never opens or submits the old OU's work", async () => {
  // Simulates reconnect AFTER loadContextOnline() moved the session to branch b2:
  // the offline shift + sale captured under b1 must be left for the b1 context, never
  // replayed under b2 (the component now derives ctx fresh, so ctx.branchId === b2).
  await addPendingShift(makePending({ local_shift_id: "L-b1", branch_id: "b1" }));
  await addPosOfflineTxn(makeDependentTxn("L-b1")); // branch_id b1
  const b2ctx = { tenantId: "t1", branchId: "b2", cashierUserId: "u1", deviceId: "dev1", online: true };
  const c: Counters = { opens: 0, submits: 0, pays: 0, submittedShiftIds: [] };
  const report = await syncPosTxns(b2ctx, "backend-returned", deps(c));
  assert.equal(c.opens, 0, "the b1 shift is not opened under the b2 context");
  assert.equal(c.submits, 0, "the b1 sale is not submitted under the b2 context");
  assert.deepEqual(report.deferred, [(await localdb.posOfflineTxns.toArray())[0].local_txn_id], "the b1 sale is deferred, not parked");
  assert.equal((await getPendingShift("L-b1"))?.status, "pending_sync", "the b1 shift is left intact for its own context");
});

test("two concurrent syncPosTxns never process the financial queue twice (single-flight BEFORE the first await)", async () => {
  await addPendingShift(makePending({ local_shift_id: "L1" }));
  await addPosOfflineTxn(makeDependentTxn("L1"));
  const c: Counters = { opens: 0, submits: 0, pays: 0, submittedShiftIds: [] };
  // A slow hasSession() means that if the single-flight lock were acquired only AFTER
  // this await, both concurrent calls would pass the guard and replay the queue
  // together. With the lock taken before the first await, the second call no-ops.
  const slow = deps(c, { hasSession: async () => { await new Promise((r) => setTimeout(r, 25)); return true; } });
  const [r1, r2] = await Promise.all([
    syncPosTxns(ctx, "concurrent-a", slow),
    syncPosTxns(ctx, "concurrent-b", slow),
  ]);
  assert.equal(c.opens, 1, "shift opened exactly once despite concurrent reconnects");
  assert.equal(c.submits, 1, "order submitted exactly once");
  assert.equal(c.pays, 1, "paid exactly once");
  assert.equal(r1.synced.length + r2.synced.length, 1, "exactly one pass did the work; the other no-op'd on the lock");
});

test("a remapped sale NEVER keeps a local shift id, and a non-pending sale is submitted as captured", async () => {
  // Pending (Case 2) sale: must be remapped to the canonical id before submit.
  await addPendingShift(makePending({ local_shift_id: "L1" }));
  await addPosOfflineTxn(makeDependentTxn("L1"));
  // A normal sale against a REAL server shift: no pending marker, submitted verbatim.
  await addPosOfflineTxn(
    makeDependentTxn("SRV-REAL", {
      local_txn_id: "plain",
      client_op_id: "op-plain",
      pending_shift_local_id: null,
      shift_id: "SRV-REAL",
      order_payload: { client_op_id: "op-plain", order_type: "takeaway", shift_id: "SRV-REAL", branch_id: "b1", status: "sent_to_kitchen", notes: null, items: [] },
      created_at: "2026-09-30T11:00:00Z",
    }),
  );
  const c: Counters = { opens: 0, submits: 0, pays: 0, submittedShiftIds: [] };
  await syncPosTxns(ctx, "reconnect", deps(c));
  assert.equal(c.opens, 1, "only the Case-2 shift is opened");
  // Neither submitted order may carry a LOCAL pending shift id.
  assert.ok(!c.submittedShiftIds.includes("L1"), "the local shift id is never submitted to the server");
  assert.ok(c.submittedShiftIds.includes("SRV-SHIFT"), "the Case-2 sale was remapped to canonical");
  assert.ok(c.submittedShiftIds.includes("SRV-REAL"), "the real-shift sale was submitted as captured");
});
