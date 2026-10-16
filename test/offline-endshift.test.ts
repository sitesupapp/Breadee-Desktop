// Phase D — offline END SHIFT (D6): the canonical close replays LAST, behind a dependency barrier
// of every prior shift op; exactly-once; offline-opened-shift remap; conflict → needs_attention.

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
import { addOperation, getOperation, OPERATION_SCHEMA_VERSION } from "@/lib/offline/operationLog";
import type { OfflineOperation } from "@/lib/offline/operationLog";
import { resolveEntity } from "@/lib/offline/entityMap";
import { drainOffline, __resetDrainLockForTests } from "@/lib/offline/orchestrator";
import type { PosTxnSyncDeps } from "@/lib/offline/posTxnSync";
import { captureEndShiftOffline, findEndShiftOp } from "@/lib/offline/endShiftOffline";

const SCOPE = { tenant_id: "t1", branch_id: "b1", device_id: "dev1", terminal_id: "term1", cashier_user_id: "u1" };
const ESCOPE = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1" };
const CTX = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1", online: true };

function deps(order: string[], over: Partial<PosTxnSyncDeps> = {}): PosTxnSyncDeps {
  return {
    submit: async () => ({ order_id: "x", order_number: "y" }),
    pay: async () => ({}),
    openShift: async () => ({ shiftId: "s", reused: false }),
    openTable: async () => ({ table_id: "T", pos_entity_version: 1 }),
    submitRound: async () => ({ order_id: "O", order_number: "N", batch_no: 1, appended: true, idempotent: false }),
    voidRefund: async () => ({ order_id: "O", status: "refunded", refunded: true, refund_usd: 0, refund_id: null, idempotent: false }),
    payTable: async () => { order.push("pay"); return { ok: true, amount: 5, idempotent: false }; },
    payOrderOp: async (a) => ({ order_id: a.orderId, paid: true, amount: 5, idempotent: false }),
    onAccountTable: async () => ({ ok: true, idempotent: false }),
    onAccountOrder: async () => ({ ok: true, idempotent: false }),
    endShiftOp: async (a) => { order.push("end"); return { shift_id: a.shiftId, idempotent: false }; },
    isTransport: (e) => e instanceof TypeError,
    hasSession: async () => true,
    ...over,
  };
}

function payTableOp(over: Partial<OfflineOperation> = {}): OfflineOperation {
  return {
    operation_id: over.operation_id ?? ("pt-" + Math.random().toString(36).slice(2)),
    operation_type: "pay_table", schema_version: OPERATION_SCHEMA_VERSION, scope: SCOPE,
    created_at: new Date(Date.now() - 1000).toISOString(), client_op_id: "c-" + Math.random().toString(36).slice(2),
    local_entity_id: null, canonical_entity_id: null, dependency_ids: [], depends_on_local_entities: [],
    payload: { table_id: "TBL-1", table_local: null, method: "cash", currency: "USD" },
    status: "pending", retry_count: 0, last_attempt_at: null, last_error_code: null, last_error_message: null, result_meta: null, synced_at: null,
    ...over,
  };
}

beforeEach(async () => {
  await Promise.all([localdb.operations.clear(), localdb.entityMap.clear(), localdb.syncHistory.clear()]);
  __resetDrainLockForTests();
});

test("capture: the dependency barrier snapshots every prior in-scope non-end_shift op", async () => {
  await addOperation(payTableOp());
  await addOperation(payTableOp());
  const cap = await captureEndShiftOffline({ scope: ESCOPE, shiftId: "SHIFT-1", shiftLocal: null, actualCashCounted: 100, notes: null });
  assert.equal(cap.alreadyCaptured, false);
  assert.equal(cap.dependencyCount, 2);
  const es = await getOperation(cap.operationId);
  assert.equal(es?.operation_type, "end_shift");
  assert.equal(es?.dependency_ids.length, 2);
});

test("capture: double-tap collapses to ONE end_shift op (deterministic id)", async () => {
  const a = await captureEndShiftOffline({ scope: ESCOPE, shiftId: "SHIFT-1", shiftLocal: null, actualCashCounted: 100, notes: null });
  const b = await captureEndShiftOffline({ scope: ESCOPE, shiftId: "SHIFT-1", shiftLocal: null, actualCashCounted: 100, notes: null });
  assert.equal(a.operationId, b.operationId);
  assert.equal(b.alreadyCaptured, true);
  assert.equal(await localdb.operations.where("operation_type").equals("end_shift").count(), 1);
  assert.ok(await findEndShiftOp(ESCOPE));
});

test("drain: End Shift replays LAST — only after every shift dependency has synced", async () => {
  await addOperation(payTableOp());
  const cap = await captureEndShiftOffline({ scope: ESCOPE, shiftId: "SHIFT-1", shiftLocal: null, actualCashCounted: 100, notes: "z" });
  const order: string[] = [];
  const r = await drainOffline(CTX, "reconnect", deps(order));
  assert.equal(order[0], "pay");
  assert.equal(order[order.length - 1], "end"); // close is last
  assert.ok(r.drained.includes(cap.operationId));
  assert.equal((await getOperation(cap.operationId))?.status, "synced");
});

test("drain: End Shift stays BLOCKED while a shift dependency is unresolved", async () => {
  // A dependency that never syncs (a conflict op) must keep End Shift from closing.
  const stuck = payTableOp();
  await addOperation(stuck);
  const cap = await captureEndShiftOffline({ scope: ESCOPE, shiftId: "SHIFT-1", shiftLocal: null, actualCashCounted: 100, notes: null });
  const order: string[] = [];
  await drainOffline(CTX, "r", deps(order, { payTable: async () => { throw new Error("This order is already paid."); } }));
  // The invariant: the canonical close did NOT happen while a shift dependency is unresolved.
  assert.ok(!order.includes("end"), "End Shift must NOT close while a dependency is unresolved");
  const es = await getOperation(cap.operationId);
  // It is NOT synced. (A dependency stuck in needs_attention correctly propagates to the dependent;
  // the exact non-synced status — blocked_dependency / needs_attention / pending / retryable — is
  // an orchestrator detail. What matters is that it never closed.)
  assert.notEqual(es?.status, "synced");
});

test("remap: an offline-opened shift's local id resolves to canonical before close", async () => {
  const cap = await captureEndShiftOffline({ scope: ESCOPE, shiftId: null, shiftLocal: "shift-local", actualCashCounted: 50, notes: null });
  // Unresolved → blocked.
  let order: string[] = [];
  await drainOffline(CTX, "r", deps(order));
  assert.ok(!order.includes("end"));
  assert.equal((await getOperation(cap.operationId))?.status, "blocked_dependency");
  // Resolve the open-shift mapping (as the open_shift op would) → close proceeds to the canonical id.
  await resolveEntity({ local_entity_id: "shift-local", entity_type: "shift", canonical_id: "SRV-SHIFT", resolved_at: new Date().toISOString(), tenant_id: "t1", branch_id: "b1", device_id: "dev1", cashier_user_id: "u1", terminal_id: "term1" });
  order = [];
  let captured = "";
  await drainOffline(CTX, "r", deps(order, { endShiftOp: async (a) => { captured = a.shiftId; order.push("end"); return { shift_id: a.shiftId, idempotent: false }; } }));
  assert.equal(captured, "SRV-SHIFT");
  assert.equal((await getOperation(cap.operationId))?.status, "synced");
});

test("conflict: a shift changed/closed on the server → needs_attention (never silent reclose)", async () => {
  const cap = await captureEndShiftOffline({ scope: ESCOPE, shiftId: "SHIFT-1", shiftLocal: null, actualCashCounted: 100, notes: null });
  const order: string[] = [];
  const r = await drainOffline(CTX, "r", deps(order, { endShiftOp: async () => { throw new Error("This shift changed since it was loaded."); } }));
  assert.equal(r.needsAttention.length, 1);
  assert.equal((await getOperation(cap.operationId))?.status, "needs_attention");
});
