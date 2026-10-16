// Phase E — offline ORDER ITEM EDIT: capture a durable edit_order_line / add_order_items, replay
// exactly-once with the CAS payload, surface a version drift as needs_attention, and remap an
// offline-created target order (order_local → canonical) before the edit.

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
import { captureEditOrderLineOffline, captureAddOrderItemsOffline, type ItemEditScope } from "@/lib/offline/itemEditOffline";

const SCOPE: ItemEditScope = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1" };
const OPSCOPE = { tenant_id: "t1", branch_id: "b1", device_id: "dev1", terminal_id: "term1", cashier_user_id: "u1" };
const CTX = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1", online: true };

function deps(log: string[], over: Partial<PosTxnSyncDeps> = {}): { deps: Partial<PosTxnSyncDeps>; edits: Record<string, unknown>[]; adds: Record<string, unknown>[] } {
  const edits: Record<string, unknown>[] = [];
  const adds: Record<string, unknown>[] = [];
  const d: Partial<PosTxnSyncDeps> = {
    editOrderLine: async (a) => { log.push("edit"); edits.push(a.payload); return { ok: true, idempotent: false }; },
    addOrderItems: async (a) => { log.push("add"); adds.push(a.payload); return { ok: true, idempotent: false }; },
    submit: async () => { log.push("submit"); return { order_id: "SRV-ORD", order_number: "N1" }; },
    isTransport: (e) => e instanceof TypeError,
    hasSession: async () => true,
    ...over,
  };
  return { deps: d, edits, adds };
}

beforeEach(async () => {
  await Promise.all([localdb.operations.clear(), localdb.entityMap.clear(), localdb.syncHistory.clear(), localdb.posOfflineTxns.clear()]);
  __resetDrainLockForTests();
});

const EDIT_PAYLOAD = { order_id: "ORD-1", op: "set_quantity", order_item_id: "LINE-1", quantity: 2, expected_version: 7, reason: null, client_op_id: "e1" };

test("capture + E2E edit_order_line: drain → pos_edit_order_line with the CAS payload, once", async () => {
  const cap = await captureEditOrderLineOffline({ scope: SCOPE, orderId: "ORD-1", payload: { ...EDIT_PAYLOAD }, clientOpId: "e1" });
  assert.equal(cap.alreadyCaptured, false);
  const dup = await captureEditOrderLineOffline({ scope: SCOPE, orderId: "ORD-1", payload: { ...EDIT_PAYLOAD }, clientOpId: "e1" });
  assert.equal(dup.alreadyCaptured, true); // double-tap idempotent

  const log: string[] = [];
  const { deps: d, edits } = deps(log);
  const r = await drainOffline(CTX, "reconnect", d);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].expected_version, 7);
  assert.equal(edits[0].order_id, "ORD-1");
  assert.equal(edits[0].client_op_id, "e1");
  assert.equal(r.needsAttention.length, 0);
});

test("version drift on replay → needs_attention (CONFLICT), never a blind re-apply", async () => {
  const cap = await captureEditOrderLineOffline({ scope: SCOPE, orderId: "ORD-1", payload: { ...EDIT_PAYLOAD }, clientOpId: "e1" });
  const log: string[] = [];
  const { deps: d } = deps(log, { editOrderLine: async () => { throw new Error("version_conflict: bill changed since it was loaded"); } });
  const r = await drainOffline(CTX, "reconnect", d);
  assert.equal(r.needsAttention.length, 1);
  assert.equal((await getOperation(cap.operationId))?.status, "needs_attention");
});

test("capture + E2E add_order_items: drain → pos_add_order_items once", async () => {
  await captureAddOrderItemsOffline({ scope: SCOPE, orderId: "ORD-1", payload: { order_id: "ORD-1", items: [{ menu_item_id: "m1", quantity: 1 }], expected_version: 3, client_op_id: "a1" }, clientOpId: "a1" });
  const log: string[] = [];
  const { deps: d, adds } = deps(log);
  const r = await drainOffline(CTX, "reconnect", d);
  assert.equal(adds.length, 1);
  assert.equal(adds[0].expected_version, 3);
  assert.equal(r.needsAttention.length, 0);
});

test("order_local: editing an OFFLINE-CREATED order waits for it to sync, then edits the canonical id", async () => {
  // The offline-created order (takeaway_sale), local id "ord-local".
  const createOp: OfflineOperation = {
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
    payload: { order_payload: { order_type: "delivery", shift_id: "SRV-SHIFT" }, payment_intent: null, paid: false },
    status: "pending",
    retry_count: 0,
    last_attempt_at: null,
    last_error_code: null,
    last_error_message: null,
    result_meta: null,
    synced_at: null,
  };
  await localdb.operations.add(createOp);
  // The edit against the LOCAL order id.
  await captureEditOrderLineOffline({ scope: SCOPE, orderId: null, orderLocal: "ord-local", payload: { order_id: "ord-local", op: "set_quantity", order_item_id: "L1", quantity: 0, expected_version: 1, client_op_id: "e1" }, clientOpId: "e1" });

  const log: string[] = [];
  const { deps: d, edits } = deps(log);
  const r = await drainOffline(CTX, "reconnect", d);
  // The order is created first; the edit then targets the CANONICAL order id.
  assert.ok(log.indexOf("submit") < log.indexOf("edit"));
  assert.equal(edits.length, 1);
  assert.equal(edits[0].order_id, "SRV-ORD");
  assert.equal(r.needsAttention.length, 0);
});
