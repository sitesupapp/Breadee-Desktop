// Phase E (E3) — a DELIVERY (takeaway_sale) order placed OFFLINE against an OFFLINE-CREATED
// customer/address: the order carries LOCAL customer/address ids, and on reconnect the customer_upsert
// resolves them so the order submits with the CANONICAL ids — blocked until then, never a local id
// on the wire, exactly-once.

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
import { OPERATION_SCHEMA_VERSION, getOperation, type OfflineOperation } from "@/lib/offline/operationLog";
import { drainOffline, __resetDrainLockForTests } from "@/lib/offline/orchestrator";
import type { PosTxnSyncDeps } from "@/lib/offline/posTxnSync";

const OPSCOPE = { tenant_id: "t1", branch_id: "b1", device_id: "dev1", terminal_id: "term1", cashier_user_id: "u1" };
const CTX = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1", online: true };

function op(over: Partial<OfflineOperation>): OfflineOperation {
  return {
    operation_id: over.operation_id ?? "op",
    operation_type: over.operation_type ?? "takeaway_sale",
    schema_version: OPERATION_SCHEMA_VERSION,
    scope: OPSCOPE,
    created_at: over.created_at ?? new Date().toISOString(),
    client_op_id: over.client_op_id ?? "c",
    local_entity_id: over.local_entity_id ?? null,
    canonical_entity_id: null,
    dependency_ids: over.dependency_ids ?? [],
    depends_on_local_entities: over.depends_on_local_entities ?? [],
    payload: over.payload ?? {},
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

function deps(log: string[]): { deps: Partial<PosTxnSyncDeps>; submits: Record<string, unknown>[] } {
  const submits: Record<string, unknown>[] = [];
  const d: Partial<PosTxnSyncDeps> = {
    upsertCustomer: async () => { log.push("upsert"); return { customer_id: "SRV-CUST", address_id: "SRV-ADDR", is_new: true }; },
    submit: async (payload) => { log.push("submit"); submits.push(payload as unknown as Record<string, unknown>); return { order_id: "SRV-ORD", order_number: "N1" }; },
    isTransport: (e) => e instanceof TypeError,
    hasSession: async () => true,
  };
  return { deps: d, submits };
}

beforeEach(async () => {
  await Promise.all([localdb.operations.clear(), localdb.entityMap.clear(), localdb.syncHistory.clear(), localdb.posOfflineTxns.clear(), localdb.posCustomers.clear()]);
  __resetDrainLockForTests();
});

test("delivery against an offline-created customer: submit waits, then uses the CANONICAL customer+address", async () => {
  // The offline customer create (with an address), mirroring captureCustomerUpsertOffline's op shape.
  await localdb.operations.add(op({
    operation_id: "customer:cc1",
    operation_type: "customer_upsert",
    client_op_id: "cc1",
    local_entity_id: "cust-local",
    created_at: new Date(Date.now() - 1000).toISOString(),
    payload: { upsert: { branch_id: "b1", name: "Ava", phone: "03999888", address: { street: "Main St" } }, local_address_id: "addr-local" },
  }));
  // The delivery order carrying the LOCAL customer/address ids (as the DeliveryWorkspace offline send
  // + migration produce it).
  await localdb.operations.add(op({
    operation_id: "mig:txn:d1",
    operation_type: "takeaway_sale",
    client_op_id: "oc1",
    local_entity_id: "d1",
    depends_on_local_entities: ["cust-local"],
    payload: {
      order_payload: { order_type: "delivery", customer_id: "cust-local", address_id: "addr-local", shift_id: "SRV-SHIFT" },
      payment_intent: null,
      paid: false,
      shift_local: null,
      customer_local: "cust-local",
      address_local: "addr-local",
    },
  }));

  const log: string[] = [];
  const { deps: d, submits } = deps(log);
  const r = await drainOffline(CTX, "reconnect", d);

  // The customer syncs first; the order then submits with the CANONICAL ids.
  assert.ok(log.indexOf("upsert") < log.indexOf("submit"));
  assert.equal(submits.length, 1);
  assert.equal(submits[0].customer_id, "SRV-CUST");
  assert.equal(submits[0].address_id, "SRV-ADDR");
  assert.equal(submits[0].order_type, "delivery");
  assert.equal(r.needsAttention.length, 0);
});

test("the order BLOCKS (never submits a local id) while the customer is unresolved", async () => {
  // Only the order op, its customer dependency never resolves (no customer_upsert present).
  await localdb.operations.add(op({
    operation_id: "mig:txn:d1",
    operation_type: "takeaway_sale",
    client_op_id: "oc1",
    local_entity_id: "d1",
    depends_on_local_entities: ["cust-local"],
    payload: {
      order_payload: { order_type: "delivery", customer_id: "cust-local", address_id: "SRV-ADDR", shift_id: "SRV-SHIFT" },
      payment_intent: null,
      paid: false,
      shift_local: null,
      customer_local: "cust-local",
      address_local: null,
    },
  }));
  const log: string[] = [];
  const { deps: d, submits } = deps(log);
  await drainOffline(CTX, "reconnect", d);
  assert.equal(submits.length, 0); // never submitted a local customer id
  const o = await getOperation("mig:txn:d1");
  assert.ok(o?.status === "blocked_dependency" || o?.status === "pending" || o?.status === "retryable");
});

test("back-compat: a pre-E takeaway op (shift dep only, no explicit fields) still remaps the shift", async () => {
  await localdb.operations.add(op({
    operation_id: "openshift:s1",
    operation_type: "open_shift",
    client_op_id: "os1",
    local_entity_id: "sh-local",
    created_at: new Date(Date.now() - 1000).toISOString(),
    payload: { branchId: "b1", openingCash: 0 },
  }));
  // No shift_local / customer_local fields — the legacy shape, shift dep in depends_on_local_entities.
  await localdb.operations.add(op({
    operation_id: "mig:txn:t1",
    operation_type: "takeaway_sale",
    client_op_id: "oc1",
    local_entity_id: "t1",
    depends_on_local_entities: ["sh-local"],
    payload: { order_payload: { order_type: "takeaway", shift_id: "sh-local" }, payment_intent: null, paid: false },
  }));
  const log: string[] = [];
  const openShift: Partial<PosTxnSyncDeps> = { openShift: async () => { log.push("open"); return { shiftId: "SRV-SHIFT", reused: false }; } };
  const { deps: d, submits } = deps(log);
  const r = await drainOffline(CTX, "reconnect", { ...d, ...openShift });
  assert.equal(submits.length, 1);
  assert.equal(submits[0].shift_id, "SRV-SHIFT"); // legacy shift remap still works
  assert.equal(r.needsAttention.length, 0);
});
