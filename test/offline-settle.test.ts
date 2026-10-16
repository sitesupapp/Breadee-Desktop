// Phase D — offline SETTLE engine (pay_table / pay_order) through the ONE orchestrator + its
// pos_pay_table / pos_pay_order deps. Proves exactly-once replay (client_op_id), the already-
// settled-by-another-action CONFLICT (never a silent second charge), transport retryability,
// dependency remap of an offline-created table/order, and 5-dim scope exactness. Real Dexie
// (fake-indexeddb) + fake deps, no network.

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

type PayTableCall = { tableId: string; method: string; clientOpId: string };
type PayOrderCall = { orderId: string; method: string; clientOpId: string; expectedVersion: number | null };

function deps(over: Partial<PosTxnSyncDeps> = {}): { deps: PosTxnSyncDeps; tableCalls: PayTableCall[]; orderCalls: PayOrderCall[] } {
  const tableCalls: PayTableCall[] = [];
  const orderCalls: PayOrderCall[] = [];
  const d: PosTxnSyncDeps = {
    submit: async () => ({ order_id: "x", order_number: "y" }),
    pay: async () => ({}),
    openShift: async () => ({ shiftId: "s", reused: false }),
    openTable: async () => ({ table_id: "T", pos_entity_version: 1 }),
    submitRound: async () => ({ order_id: "O", order_number: "N", batch_no: 1, appended: true, idempotent: false }),
    voidRefund: async () => ({ order_id: "O", status: "refunded", refunded: true, refund_usd: 0, refund_id: null, idempotent: false }),
    payTable: async (a) => { tableCalls.push({ tableId: a.tableId, method: a.method, clientOpId: a.clientOpId }); return { ok: true, amount: 5, idempotent: false }; },
    payOrderOp: async (a) => { orderCalls.push({ orderId: a.orderId, method: a.method, clientOpId: a.clientOpId, expectedVersion: a.expectedVersion }); return { order_id: a.orderId, paid: true, amount: 5, idempotent: false }; },
    isTransport: (e) => e instanceof TypeError,
    hasSession: async () => true,
    ...over,
  };
  return { deps: d, tableCalls, orderCalls };
}

function op(type: "pay_table" | "pay_order", payload: Record<string, unknown>, over: Partial<OfflineOperation> = {}): OfflineOperation {
  return {
    operation_id: over.operation_id ?? ("op-" + Math.random().toString(36).slice(2)),
    operation_type: type,
    schema_version: OPERATION_SCHEMA_VERSION,
    scope: over.scope ?? SCOPE,
    created_at: new Date().toISOString(),
    client_op_id: over.client_op_id ?? ("cop-" + Math.random().toString(36).slice(2)),
    local_entity_id: null,
    canonical_entity_id: null,
    dependency_ids: over.dependency_ids ?? [],
    depends_on_local_entities: over.depends_on_local_entities ?? [],
    payload,
    status: "pending",
    retry_count: 0,
    last_attempt_at: null,
    last_error_code: null,
    last_error_message: null,
    result_meta: null,
    synced_at: null,
    ...over,
  };
}

beforeEach(async () => {
  await Promise.all([localdb.operations.clear(), localdb.entityMap.clear(), localdb.syncHistory.clear()]);
  __resetDrainLockForTests();
});

test("pay_table: a configured table settles once; client_op_id threaded", async () => {
  const o = op("pay_table", { table_id: "TBL-1", table_local: null, method: "cash", currency: "LBP", table_name: "5" }, { client_op_id: "cop-pt" });
  await addOperation(o);
  const { deps: d, tableCalls } = deps();
  const r = await drainOffline(CTX, "test", d);
  assert.deepEqual(r.drained, [o.operation_id]);
  assert.equal(tableCalls.length, 1);
  assert.deepEqual(tableCalls[0], { tableId: "TBL-1", method: "cash", clientOpId: "cop-pt" });
  assert.equal((await getOperation(o.operation_id))?.status, "synced");
});

test("pay_table: idempotent replay settles (exactly once)", async () => {
  const o = op("pay_table", { table_id: "TBL-1", table_local: null, method: "cash", currency: "USD" });
  await addOperation(o);
  const { deps: d } = deps({ payTable: async () => ({ ok: true, amount: 5, idempotent: true }) });
  const r = await drainOffline(CTX, "test", d);
  assert.deepEqual(r.drained, [o.operation_id]);
  assert.equal((await getOperation(o.operation_id))?.result_meta?.idempotent, true);
});

for (const msg of ["This order is already paid.", "No open order on this table to pay."]) {
  test(`pay_table: already-settled-by-another-action is a CONFLICT (never a silent second charge): ${msg.slice(0, 24)}`, async () => {
    const o = op("pay_table", { table_id: "TBL-1", table_local: null, method: "cash", currency: "USD" });
    await addOperation(o);
    const { deps: d } = deps({ payTable: async () => { throw new Error(msg); } });
    const r = await drainOffline(CTX, "test", d);
    assert.equal(r.drained.length, 0);
    assert.equal(r.needsAttention.length, 1);
    const saved = await getOperation(o.operation_id);
    assert.equal(saved?.status, "needs_attention");
    assert.equal(saved?.last_error_code, "settle_conflict");
  });
}

test("pay_table: transport failure stays retryable", async () => {
  const o = op("pay_table", { table_id: "TBL-1", table_local: null, method: "cash", currency: "USD" });
  await addOperation(o);
  const { deps: d } = deps({ payTable: async () => { throw new TypeError("Failed to fetch"); } });
  const r = await drainOffline(CTX, "test", d);
  assert.equal(r.needsAttention.length, 0);
  assert.equal((await getOperation(o.operation_id))?.status, "retryable");
});

test("pay_table: an offline-created ad-hoc table is DEPENDENCY_BLOCKED until its open-table op resolves", async () => {
  const o = op("pay_table", { table_id: null, table_local: "sess-local", method: "cash", currency: "USD" }, { depends_on_local_entities: ["sess-local"] });
  await addOperation(o);
  // No mapping yet → blocked, the settle is not sent.
  const { deps: d, tableCalls } = deps();
  let r = await drainOffline(CTX, "test", d);
  assert.equal(tableCalls.length, 0);
  assert.equal((await getOperation(o.operation_id))?.status, "blocked_dependency");
  // Resolve the session's canonical table (as the open-table op would) → the settle now remaps + sends.
  await resolveEntity({ local_entity_id: "sess-local", entity_type: "table", canonical_id: "SRV-TBL", resolved_at: new Date().toISOString(), tenant_id: "t1", branch_id: "b1", device_id: "dev1", cashier_user_id: "u1", terminal_id: "term1" });
  r = await drainOffline(CTX, "test", d);
  assert.deepEqual(r.drained, [o.operation_id]);
  assert.equal(tableCalls[0].tableId, "SRV-TBL");
});

test("pay_table: a foreign-OU mapping NEVER satisfies the dependency (fail-closed remap)", async () => {
  const o = op("pay_table", { table_id: null, table_local: "sess-local", method: "cash", currency: "USD" }, { depends_on_local_entities: ["sess-local"] });
  await addOperation(o);
  // Mapping exists but under a DIFFERENT OU → must not resolve.
  await resolveEntity({ local_entity_id: "sess-local", entity_type: "table", canonical_id: "SRV-TBL", resolved_at: new Date().toISOString(), tenant_id: "t1", branch_id: "OTHER-OU", device_id: "dev1", cashier_user_id: "u1", terminal_id: "term1" });
  const { deps: d, tableCalls } = deps();
  const r = await drainOffline(CTX, "test", d);
  assert.equal(tableCalls.length, 0);
  assert.equal((await getOperation(o.operation_id))?.status, "blocked_dependency");
  assert.equal(r.drained.length, 0);
});

test("pay_order: settles once; client_op_id + expected_version threaded", async () => {
  const o = op("pay_order", { order_id: "ORD-1", order_local: null, method: "visa", currency: "USD", expected_version: 7, order_number: "A-9" }, { client_op_id: "cop-po" });
  await addOperation(o);
  const { deps: d, orderCalls } = deps();
  const r = await drainOffline(CTX, "test", d);
  assert.deepEqual(r.drained, [o.operation_id]);
  assert.deepEqual(orderCalls[0], { orderId: "ORD-1", method: "visa", clientOpId: "cop-po", expectedVersion: 7 });
});

test("scope-exact: a settle op from another terminal is NOT drained here", async () => {
  const o = op("pay_table", { table_id: "TBL-1", table_local: null, method: "cash", currency: "USD" }, { scope: { ...SCOPE, terminal_id: "OTHER" } });
  await addOperation(o);
  let called = 0;
  const { deps: d } = deps({ payTable: async () => { called++; return { ok: true, amount: 5, idempotent: false }; } });
  const r = await drainOffline(CTX, "test", d);
  assert.equal(called, 0);
  assert.equal((await getOperation(o.operation_id))?.status, "pending");
});
