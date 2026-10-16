// Phase D (D3) — offline SPLIT settle engine (split_settle through the orchestrator + its
// pos_split_settle dep). Proves: a leg drains with its captured item allocations; sequential legs
// replay strictly in order (chained deps); over-allocation / NOT_SPLITTABLE / version drift →
// needs_attention (never overpayment/double-settle); transport retryable; order_local remap;
// 5-dim scope isolation. Real Dexie (fake-indexeddb) + fake deps, no network.

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

const SCOPE = { tenant_id: "t1", branch_id: "b1", device_id: "dev1", terminal_id: "term1", cashier_user_id: "u1" };
const CTX = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1", online: true };

type SplitCall = { orderId: string; allocations: { order_item_id: string; quantity: number }[]; clientOpId: string; expectedVersion: number | null };

function deps(order: string[], over: Partial<PosTxnSyncDeps> = {}): { deps: PosTxnSyncDeps; calls: SplitCall[] } {
  const calls: SplitCall[] = [];
  const d: PosTxnSyncDeps = {
    submit: async () => ({ order_id: "x", order_number: "y" }),
    pay: async () => ({}),
    openShift: async () => ({ shiftId: "s", reused: false }),
    openTable: async () => ({ table_id: "T", pos_entity_version: 1 }),
    submitRound: async () => ({ order_id: "O", order_number: "N", batch_no: 1, appended: true, idempotent: false }),
    orderItemMap: async () => [],
    voidRefund: async () => ({ order_id: "O", status: "refunded", refunded: true, refund_usd: 0, refund_id: null, idempotent: false }),
    payTable: async () => ({ ok: true, amount: 5, idempotent: false }),
    payOrderOp: async (a) => ({ order_id: a.orderId, paid: true, amount: 5, idempotent: false }),
    onAccountTable: async () => ({ ok: true, idempotent: false }),
    onAccountOrder: async () => ({ ok: true, idempotent: false }),
    endShiftOp: async (a) => ({ shift_id: a.shiftId, idempotent: false }),
    splitSettle: async (a) => {
      order.push("split");
      calls.push({ orderId: a.orderId, allocations: a.allocations, clientOpId: a.clientOpId, expectedVersion: a.expectedVersion });
      return { ok: true, split_no: calls.length, parent_completed: false, remaining_qty: 1, idempotent: false };
    },
    isTransport: (e) => e instanceof TypeError,
    hasSession: async () => true,
    ...over,
  };
  return { deps: d, calls };
}

function splitOp(payload: Record<string, unknown>, over: Partial<OfflineOperation> = {}): OfflineOperation {
  return {
    operation_id: over.operation_id ?? ("sp-" + Math.random().toString(36).slice(2)),
    operation_type: "split_settle", schema_version: OPERATION_SCHEMA_VERSION, scope: over.scope ?? SCOPE,
    created_at: new Date().toISOString(), client_op_id: over.client_op_id ?? ("c-" + Math.random().toString(36).slice(2)),
    local_entity_id: null, canonical_entity_id: null,
    dependency_ids: over.dependency_ids ?? [], depends_on_local_entities: over.depends_on_local_entities ?? [],
    payload, status: "pending", retry_count: 0, last_attempt_at: null, last_error_code: null, last_error_message: null, result_meta: null, synced_at: null,
    ...over,
  };
}

beforeEach(async () => {
  await Promise.all([localdb.operations.clear(), localdb.entityMap.clear(), localdb.syncHistory.clear()]);
  __resetDrainLockForTests();
});

test("one leg: drains with its captured item allocations + method; expected_version NULL offline", async () => {
  const o = splitOp({ order_id: "ORD-1", order_local: null, method: "cash", currency: "USD", allocations: [{ order_item_id: "it1", quantity: 2 }], expected_version: null }, { client_op_id: "c-sp1" });
  await addOperation(o);
  const log: string[] = [];
  const { deps: d, calls } = deps(log);
  const r = await drainOffline(CTX, "t", d);
  assert.deepEqual(r.drained, [o.operation_id]);
  assert.deepEqual(calls[0], { orderId: "ORD-1", allocations: [{ order_item_id: "it1", quantity: 2 }], clientOpId: "c-sp1", expectedVersion: null });
});

test("sequential legs replay STRICTLY in order (leg 2 depends on leg 1)", async () => {
  const leg1 = splitOp({ order_id: "ORD-1", order_local: null, method: "cash", currency: "USD", allocations: [{ order_item_id: "it1", quantity: 1 }], expected_version: null }, { operation_id: "leg1", created_at: new Date(Date.now() - 2000).toISOString() });
  const leg2 = splitOp({ order_id: "ORD-1", order_local: null, method: "card", currency: "USD", allocations: [{ order_item_id: "it2", quantity: 1 }], expected_version: null }, { operation_id: "leg2", dependency_ids: ["leg1"], created_at: new Date(Date.now() - 1000).toISOString() });
  await addOperation(leg1);
  await addOperation(leg2);
  const log: string[] = [];
  const { deps: d, calls } = deps(log);
  const r = await drainOffline(CTX, "t", d);
  assert.equal(r.drained.length, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].orderId, "ORD-1");
  assert.equal(calls[0].allocations[0].order_item_id, "it1"); // leg 1 first
  assert.equal(calls[1].allocations[0].order_item_id, "it2"); // then leg 2
});

test("later leg CANNOT replay before its predecessor (dependency gate)", async () => {
  const leg1 = splitOp({ order_id: "ORD-1", order_local: null, method: "cash", currency: "USD", allocations: [{ order_item_id: "it1", quantity: 1 }], expected_version: null }, { operation_id: "leg1" });
  const leg2 = splitOp({ order_id: "ORD-1", order_local: null, method: "cash", currency: "USD", allocations: [{ order_item_id: "it2", quantity: 1 }], expected_version: null }, { operation_id: "leg2", dependency_ids: ["leg1"] });
  await addOperation(leg1);
  await addOperation(leg2);
  const log: string[] = [];
  // Leg 1 fails (transport) → leg 2 must NOT run.
  const { deps: d, calls } = deps(log, { splitSettle: async (a) => { if (a.allocations[0].order_item_id === "it1") throw new TypeError("Failed to fetch"); log.push("split2"); return { ok: true, split_no: 2, parent_completed: false, remaining_qty: 0, idempotent: false }; } });
  await drainOffline(CTX, "t", d);
  assert.ok(!log.includes("split2"), "leg 2 must not replay while leg 1 is unresolved");
  assert.equal((await getOperation("leg1"))?.status, "retryable");
  assert.notEqual((await getOperation("leg2"))?.status, "synced");
});

for (const [label, msg] of [
  ["over-allocation", 'Cannot allocate 3 of "Burger": only 2 remaining'],
  ["not splittable", 'This order is not an open, unpaid dine-in bill and cannot be split. {"pos_error_code":"NOT_SPLITTABLE"}'],
  ["version drift", 'This bill changed since it was loaded. {"pos_error_code":"VERSION_CONFLICT"}'],
] as const) {
  test(`conflict → needs_attention (no overpayment / double settle): ${label}`, async () => {
    const o = splitOp({ order_id: "ORD-1", order_local: null, method: "cash", currency: "USD", allocations: [{ order_item_id: "it1", quantity: 3 }], expected_version: null });
    await addOperation(o);
    const { deps: d } = deps([], { splitSettle: async () => { throw new Error(msg); } });
    const r = await drainOffline(CTX, "t", d);
    assert.equal(r.drained.length, 0);
    assert.equal(r.needsAttention.length, 1);
    const saved = await getOperation(o.operation_id);
    assert.equal(saved?.status, "needs_attention");
    assert.equal(saved?.last_error_code, "split_conflict");
  });
}

test("transport stays retryable", async () => {
  const o = splitOp({ order_id: "ORD-1", order_local: null, method: "cash", currency: "USD", allocations: [{ order_item_id: "it1", quantity: 1 }], expected_version: null });
  await addOperation(o);
  const { deps: d } = deps([], { splitSettle: async () => { throw new TypeError("Failed to fetch"); } });
  const r = await drainOffline(CTX, "t", d);
  assert.equal(r.needsAttention.length, 0);
  assert.equal((await getOperation(o.operation_id))?.status, "retryable");
});

test("order_local remap: an offline session's split leg resolves to the canonical order", async () => {
  const o = splitOp({ order_id: null, order_local: "sess-local", method: "cash", currency: "USD", allocations: [{ order_item_id: "it1", quantity: 1 }], expected_version: null }, { depends_on_local_entities: ["sess-local"] });
  await addOperation(o);
  const log: string[] = [];
  let r = await drainOffline(CTX, "t", deps(log).deps);
  assert.equal((await getOperation(o.operation_id))?.status, "blocked_dependency");
  await resolveEntity({ local_entity_id: "sess-local", entity_type: "order", canonical_id: "SRV-ORD", resolved_at: new Date().toISOString(), tenant_id: "t1", branch_id: "b1", device_id: "dev1", cashier_user_id: "u1", terminal_id: "term1" });
  const { deps: d, calls } = deps(log);
  r = await drainOffline(CTX, "t", d);
  assert.deepEqual(r.drained, [o.operation_id]);
  assert.equal(calls[0].orderId, "SRV-ORD");
});

// ---------------- Fully-offline line mapping (local line id → canonical order_item_id) ----------------

test("fully-offline leg: resolves local line ids via pos_order_item_map, then settles with canonical ids", async () => {
  const o = splitOp({ order_id: "ORD-1", order_local: null, method: "cash", currency: "USD", allocations: [{ line_local: "L1", quantity: 1 }, { line_local: "L2", quantity: 1 }], expected_version: null, batch_no: 1 });
  await addOperation(o);
  const log: string[] = [];
  const { deps: d, calls } = deps(log, {
    orderItemMap: async () => [{ client_line_id: "L1", order_item_id: "IT-1" }, { client_line_id: "L2", order_item_id: "IT-2" }],
  });
  const r = await drainOffline(CTX, "t", d);
  assert.deepEqual(r.drained, [o.operation_id]);
  // The server got CANONICAL order_item_ids, resolved from the local line ids.
  assert.deepEqual(calls[0].allocations, [{ order_item_id: "IT-1", quantity: 1 }, { order_item_id: "IT-2", quantity: 1 }]);
});

test("fully-offline leg: WAITING_FOR_DEPENDENCY (never partial) while any line mapping is missing", async () => {
  const o = splitOp({ order_id: "ORD-1", order_local: null, method: "cash", currency: "USD", allocations: [{ line_local: "L1", quantity: 1 }, { line_local: "L2", quantity: 1 }], expected_version: null, batch_no: 1 });
  await addOperation(o);
  const log: string[] = [];
  // The map only knows L1 → the leg must NOT settle a partial allocation; it blocks.
  const { deps: d, calls } = deps(log, { orderItemMap: async () => [{ client_line_id: "L1", order_item_id: "IT-1" }] });
  await drainOffline(CTX, "t", d);
  assert.equal(calls.length, 0, "no split call while a mapping is missing (no partial allocation)");
  assert.equal((await getOperation(o.operation_id))?.status, "blocked_dependency");
});

test("scope-exact: a split op from another terminal is NOT drained here", async () => {
  const o = splitOp({ order_id: "ORD-1", order_local: null, method: "cash", currency: "USD", allocations: [{ order_item_id: "it1", quantity: 1 }], expected_version: null }, { scope: { ...SCOPE, terminal_id: "OTHER" } });
  await addOperation(o);
  const log: string[] = [];
  const { deps: d, calls } = deps(log);
  await drainOffline(CTX, "t", d);
  assert.equal(calls.length, 0);
  assert.equal((await getOperation(o.operation_id))?.status, "pending");
});
