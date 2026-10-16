// Phase F (GAP 2) — offline RECEIVABLE collection: prove an outstanding receivable hydrated online,
// capture a durable collection (never over the proven balance), replay exactly-once via
// pos_receivable_collect, reflect cash in the drawer, surface a stale/over balance as needs_attention,
// and chain an offline-created receivable local→canonical.

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

import { localdb, cacheReceivableProof, readReceivableProof, type ReceivableProof } from "@/lib/offline/db";
import { OPERATION_SCHEMA_VERSION, getOperation, type OfflineOperation } from "@/lib/offline/operationLog";
import { drainOffline, __resetDrainLockForTests } from "@/lib/offline/orchestrator";
import type { PosTxnSyncDeps } from "@/lib/offline/posTxnSync";
import { proveReceivableOffline, captureReceivableCollectOffline, evaluateReceivableCollectOfflineReady, type ReceivableScope } from "@/lib/offline/receivableCollectOffline";
import { extractDrawerMovements, computeDrawerProjection } from "@/lib/offline/drawerProjection";

const SCOPE: ReceivableScope = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1" };
const OPSCOPE = { tenant_id: "t1", branch_id: "b1", device_id: "dev1", terminal_id: "term1", cashier_user_id: "u1" };
const CTX = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1", online: true };

function proof(over: Partial<ReceivableProof> = {}): ReceivableProof {
  return { order_id: "ORD-1", order_number: "R-1", tenant_id: "t1", branch_id: "b1", customer_id: "C1", customer_name: "Sam", outstanding_amount: 100, currency: "USD", cached_at: new Date().toISOString(), ...over };
}

function deps(log: string[], over: Partial<PosTxnSyncDeps> = {}): { deps: Partial<PosTxnSyncDeps>; calls: { orderId: string; amount: number }[] } {
  const calls: { orderId: string; amount: number }[] = [];
  const d: Partial<PosTxnSyncDeps> = {
    receivableCollect: async (a) => { log.push("collect"); calls.push({ orderId: a.orderId, amount: a.amount }); return { ok: true, payment_id: "P1", payment_status: "partial", idempotent: false }; },
    submit: async () => { log.push("submit"); return { order_id: "SRV-ORD", order_number: "N1" }; },
    isTransport: (e) => e instanceof TypeError,
    hasSession: async () => true,
    ...over,
  };
  return { deps: d, calls };
}

beforeEach(async () => {
  await Promise.all([localdb.operations.clear(), localdb.entityMap.clear(), localdb.syncHistory.clear(), localdb.receivableProofs.clear()]);
  __resetDrainLockForTests();
});

test("proof write-through: scope-exact read, evict when settled (outstanding 0)", async () => {
  await cacheReceivableProof(proof());
  assert.ok(await readReceivableProof("ORD-1", { tenantId: "t1", branchId: "b1" }));
  assert.equal(await readReceivableProof("ORD-1", { tenantId: "t1", branchId: "b2" }), null); // sibling OU
  await cacheReceivableProof(proof({ outstanding_amount: 0 })); // settled → evicted
  assert.equal(await readReceivableProof("ORD-1", { tenantId: "t1", branchId: "b1" }), null);
});

test("prove + gate: fail-closed without proof; amount must not exceed proven outstanding", async () => {
  assert.equal((await proveReceivableOffline("NOPE", SCOPE)).ok, false);
  await cacheReceivableProof(proof());
  const p = await proveReceivableOffline("ORD-1", SCOPE);
  assert.equal(p.ok, true);
  assert.equal(evaluateReceivableCollectOfflineReady({ online: true, offlineReady: false, hasScope: false, hasOpenShift: false, proof: null, amount: 0 }).allowed, true); // online unchanged
  assert.equal(evaluateReceivableCollectOfflineReady({ online: false, offlineReady: true, hasScope: true, hasOpenShift: false, proof: p, amount: 50 }).allowed, false); // no shift
  assert.equal(evaluateReceivableCollectOfflineReady({ online: false, offlineReady: true, hasScope: true, hasOpenShift: true, proof: p, amount: 150 }).allowed, false); // over outstanding
  assert.equal(evaluateReceivableCollectOfflineReady({ online: false, offlineReady: true, hasScope: true, hasOpenShift: true, proof: p, amount: 60 }).allowed, true);
});

test("capture idempotent + amount guard; payload carries the collection + drawer fields", async () => {
  await assert.rejects(() => captureReceivableCollectOffline({ scope: SCOPE, orderId: "ORD-1", amount: 0, method: "cash", currency: "USD", clientOpId: "c1" }));
  const a = await captureReceivableCollectOffline({ scope: SCOPE, orderId: "ORD-1", amount: 60, method: "cash", currency: "USD", clientOpId: "c1", cashAmountUsd: 60 });
  const b = await captureReceivableCollectOffline({ scope: SCOPE, orderId: "ORD-1", amount: 60, method: "cash", currency: "USD", clientOpId: "c1", cashAmountUsd: 60 });
  assert.equal(b.alreadyCaptured, true);
  const op = await getOperation(a.operationId);
  const p = (op?.payload ?? {}) as Record<string, unknown>;
  assert.equal(p.order_id, "ORD-1");
  assert.equal(p.amount, 60);
  assert.equal(p.method, "cash");
  assert.equal(p.cash_amount_usd, 60);
});

test("drawer: a cash collection is cash IN", async () => {
  await captureReceivableCollectOffline({ scope: SCOPE, orderId: "ORD-1", amount: 40, method: "cash", currency: "USD", clientOpId: "c1", cashAmountUsd: 40 });
  const ops = await localdb.operations.toArray();
  const { movements } = extractDrawerMovements(ops, { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1" });
  const d = computeDrawerProjection(100, movements);
  assert.equal(d.cashInUsd, 40);
  assert.equal(d.expectedCashUsd, 140);
});

test("E2E: capture → drain → pos_receivable_collect once with the order + amount", async () => {
  await cacheReceivableProof(proof());
  await captureReceivableCollectOffline({ scope: SCOPE, orderId: "ORD-1", amount: 60, method: "cash", currency: "USD", clientOpId: "c1", cashAmountUsd: 60 });
  const log: string[] = [];
  const { deps: d, calls } = deps(log);
  const r = await drainOffline(CTX, "reconnect", d);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { orderId: "ORD-1", amount: 60 });
  assert.equal(r.needsAttention.length, 0);
});

test("stale/over balance on replay → needs_attention, never an over-collection", async () => {
  await captureReceivableCollectOffline({ scope: SCOPE, orderId: "ORD-1", amount: 60, method: "cash", currency: "USD", clientOpId: "c1" });
  const log: string[] = [];
  const { deps: d } = deps(log, { receivableCollect: async () => { throw new Error("Payment exceeds the outstanding balance (outstanding 20.00 USD)"); } });
  const r = await drainOffline(CTX, "reconnect", d);
  assert.equal(r.needsAttention.length, 1);
  const op = await getOperation("receivable:c1");
  assert.equal(op?.status, "needs_attention");
});

test("offline-created receivable: collection waits for the order to sync, then collects canonical", async () => {
  // The offline-created on-account order (takeaway_sale), local id "ord-local".
  await localdb.operations.add({
    operation_id: "mig:txn:ord-local",
    operation_type: "takeaway_sale",
    schema_version: OPERATION_SCHEMA_VERSION,
    scope: OPSCOPE,
    created_at: new Date(Date.now() - 1000).toISOString(),
    client_op_id: "oc1",
    local_entity_id: "ord-local",
    canonical_entity_id: null,
    dependency_ids: [],
    depends_on_local_entities: [],
    payload: { order_payload: { order_type: "takeaway" }, payment_intent: null, paid: false },
    status: "pending",
    retry_count: 0,
    last_attempt_at: null,
    last_error_code: null,
    last_error_message: null,
    result_meta: null,
    synced_at: null,
  } as OfflineOperation);
  await captureReceivableCollectOffline({ scope: SCOPE, orderId: null, orderLocal: "ord-local", amount: 30, method: "cash", currency: "USD", clientOpId: "c1" });
  const log: string[] = [];
  const { deps: d, calls } = deps(log);
  const r = await drainOffline(CTX, "reconnect", d);
  assert.ok(log.indexOf("submit") < log.indexOf("collect"));
  assert.equal(calls[0].orderId, "SRV-ORD");
  assert.equal(r.needsAttention.length, 0);
});
