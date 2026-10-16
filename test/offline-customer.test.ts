// Phase E (E1/E2) — offline CUSTOMER (+ address) create/edit: capture a durable customer_upsert,
// resolve the local customer id → canonical on reconnect (and the address id), surface a same-OU
// identity clash as needs_attention, and prove the keystone chain: a dependent on_account_order
// remaps customer_local → canonical once the offline-created customer syncs.

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

import { localdb, listPendingLocalCustomers, listCachedCustomers, type CachedCustomer } from "@/lib/offline/db";
import { OPERATION_SCHEMA_VERSION, getOperation, type OfflineOperation } from "@/lib/offline/operationLog";
import { drainOffline, __resetDrainLockForTests } from "@/lib/offline/orchestrator";
import { canonicalIdForInScope } from "@/lib/offline/entityMap";
import type { PosTxnSyncDeps } from "@/lib/offline/posTxnSync";
import { captureCustomerUpsertOffline, evaluateCustomerWriteOfflineReady, type CustomerOpScope } from "@/lib/offline/customerOffline";
import { matchCachedCustomers } from "@/lib/offline/customerCache";

const SCOPE: CustomerOpScope = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1" };
const OPSCOPE = { tenant_id: "t1", branch_id: "b1", device_id: "dev1", terminal_id: "term1", cashier_user_id: "u1" };
const CTX = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1", online: true };

function deps(log: string[], over: Partial<PosTxnSyncDeps> = {}): { deps: Partial<PosTxnSyncDeps>; upserts: Record<string, unknown>[]; onAccount: { orderId: string; customerId: string }[] } {
  const upserts: Record<string, unknown>[] = [];
  const onAccount: { orderId: string; customerId: string }[] = [];
  const deps: Partial<PosTxnSyncDeps> = {
    upsertCustomer: async (a) => { log.push("upsert"); upserts.push({ ...a.payload, client_op_id: a.clientOpId }); return { customer_id: "SRV-CUST", address_id: a.payload.address ? "SRV-ADDR" : null, is_new: true }; },
    onAccountOrder: async (a) => { log.push("on_account"); onAccount.push({ orderId: a.orderId, customerId: a.customerId }); return { ok: true, idempotent: false }; },
    isTransport: (e) => e instanceof TypeError,
    hasSession: async () => true,
    ...over,
  };
  return { deps, upserts, onAccount };
}

beforeEach(async () => {
  await Promise.all([localdb.operations.clear(), localdb.entityMap.clear(), localdb.syncHistory.clear(), localdb.posCustomers.clear()]);
  __resetDrainLockForTests();
});

test("gate: permission required; online unchanged; offline needs ready + scope", () => {
  const noPerm = evaluateCustomerWriteOfflineReady({ online: false, offlineReady: true, hasScope: true, canManageCustomers: false, canCreateOrders: false });
  assert.equal(noPerm.allowed, false);
  assert.equal(evaluateCustomerWriteOfflineReady({ online: true, offlineReady: false, hasScope: false, canManageCustomers: false, canCreateOrders: true }).allowed, true);
  assert.equal(evaluateCustomerWriteOfflineReady({ online: false, offlineReady: false, hasScope: true, canManageCustomers: true, canCreateOrders: false }).allowed, false);
  assert.equal(evaluateCustomerWriteOfflineReady({ online: false, offlineReady: true, hasScope: true, canManageCustomers: true, canCreateOrders: false }).allowed, true);
});

test("capture create: mints a local id, caches a pending-local customer, idempotent on client_op_id", async () => {
  const a = await captureCustomerUpsertOffline({ scope: SCOPE, upsert: { branch_id: "b1", name: "Sam", phone: "03111222" }, clientOpId: "c1" });
  assert.ok(a.localCustomerId);
  assert.equal(a.localAddressId, null); // no address in payload
  assert.equal(a.alreadyCaptured, false);

  const b = await captureCustomerUpsertOffline({ scope: SCOPE, upsert: { branch_id: "b1", name: "Sam", phone: "03111222" }, clientOpId: "c1" });
  assert.equal(b.alreadyCaptured, true);
  assert.equal(b.localCustomerId, a.localCustomerId); // deterministic

  const pending = await listPendingLocalCustomers("t1", "b1");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, a.localCustomerId);
  assert.equal(pending[0].pending_local, true);

  // The offline picker can find it.
  const matches = matchCachedCustomers(await listCachedCustomers("t1", "b1"), "Sam");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].id, a.localCustomerId);
});

test("capture create WITH address mints a local address id; edit targets the canonical id", async () => {
  const create = await captureCustomerUpsertOffline({ scope: SCOPE, upsert: { branch_id: "b1", name: "Ava", phone: "03999888", address: { street: "Main St" } }, clientOpId: "c2" });
  assert.ok(create.localAddressId);
  const op = await getOperation(create.operationId);
  assert.equal(op?.local_entity_id, create.localCustomerId);
  assert.equal((op?.payload as { local_address_id: string }).local_address_id, create.localAddressId);

  const edit = await captureCustomerUpsertOffline({ scope: SCOPE, upsert: { branch_id: "b1", id: "SRV-EXISTING", name: "Renamed" }, clientOpId: "c3" });
  assert.equal(edit.localCustomerId, null); // edit → no local entity
  const eop = await getOperation(edit.operationId);
  assert.equal(eop?.local_entity_id, null);
  assert.equal(eop?.canonical_entity_id, "SRV-EXISTING");
});

test("E2E create: drain → pos_upsert_customer with client_op_id; local customer + address resolve to canonical", async () => {
  const cap = await captureCustomerUpsertOffline({ scope: SCOPE, upsert: { branch_id: "b1", name: "Ava", phone: "03999888", address: { street: "Main St" } }, clientOpId: "c1" });
  const log: string[] = [];
  const { deps: d, upserts } = deps(log);
  const r = await drainOffline(CTX, "reconnect", d);
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].client_op_id, "c1");
  assert.equal(upserts[0].name, "Ava");
  assert.equal(r.needsAttention.length, 0);
  // The orchestrator resolved the local customer id; the handler resolved the local address id.
  assert.equal(await canonicalIdForInScope(cap.localCustomerId as string, OPSCOPE), "SRV-CUST");
  assert.equal(await canonicalIdForInScope(cap.localAddressId as string, OPSCOPE), "SRV-ADDR");
});

test("KEYSTONE: a dependent on_account_order remaps customer_local → canonical after the customer syncs", async () => {
  const cap = await captureCustomerUpsertOffline({ scope: SCOPE, upsert: { branch_id: "b1", name: "Ava", phone: "03999888" }, clientOpId: "c1" });
  // An on-account op against a CANONICAL order but the OFFLINE-CREATED customer (local id).
  const onAcctOp: OfflineOperation = {
    operation_id: "onaccountorder:oa1",
    operation_type: "on_account_order",
    schema_version: OPERATION_SCHEMA_VERSION,
    scope: OPSCOPE,
    created_at: new Date().toISOString(),
    client_op_id: "oac1",
    local_entity_id: null,
    canonical_entity_id: null,
    dependency_ids: [],
    depends_on_local_entities: [cap.localCustomerId as string],
    payload: { order_id: "SRV-ORD", order_local: null, customer_id: null, customer_local: cap.localCustomerId, amount: 10, method: "on_account" },
    status: "pending",
    retry_count: 0,
    last_attempt_at: null,
    last_error_code: null,
    last_error_message: null,
    result_meta: null,
    synced_at: null,
  };
  await localdb.operations.add(onAcctOp);

  const log: string[] = [];
  const { deps: d, onAccount } = deps(log);
  const r = await drainOffline(CTX, "reconnect", d);
  // The customer syncs first, then the on-account chains to the CANONICAL customer id.
  assert.ok(log.indexOf("upsert") < log.indexOf("on_account"));
  assert.equal(onAccount.length, 1);
  assert.equal(onAccount[0].customerId, "SRV-CUST");
  assert.equal(r.needsAttention.length, 0);
});

test("same-OU identity conflict on replay → needs_attention (CONFLICT), op preserved", async () => {
  const cap = await captureCustomerUpsertOffline({ scope: SCOPE, upsert: { branch_id: "b1", name: "Dup", phone: "03000000" }, clientOpId: "c1" });
  const log: string[] = [];
  const { deps: d } = deps(log, {
    upsertCustomer: async () => { throw new Error("CUSTOMER_IDENTITY_CONFLICT: a different customer already has this number"); },
  });
  const r = await drainOffline(CTX, "reconnect", d);
  assert.equal(r.needsAttention.length, 1);
  const op = await getOperation(cap.operationId);
  assert.equal(op?.status, "needs_attention"); // parked for the operator — never a silent duplicate / re-link
});
