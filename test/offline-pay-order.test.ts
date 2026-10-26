// Phase F (GAP 3) — offline single-ORDER cash settlement (delivery COD): capture a pay_order op
// (reuses the replay-safe pos_pay_order engine), replay exactly-once, remap an offline-created
// order local→canonical, and surface a settle conflict as needs_attention. Plus the DeliveryWorkspace
// COD wiring asserted against source (non-provider only; provider orders stay online).

import "fake-indexeddb/auto";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./source-helpers.ts";

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
import { capturePayOrderOffline, payOrderClientOpId, type PayOrderScope } from "@/lib/offline/payOrderOffline";

const here = dirname(fileURLToPath(import.meta.url));
const srcOf = (rel: string) => stripComments(readFileSync(join(here, "..", rel), "utf8"));

const SCOPE: PayOrderScope = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1" };
const OPSCOPE = { tenant_id: "t1", branch_id: "b1", device_id: "dev1", terminal_id: "term1", cashier_user_id: "u1" };
const CTX = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1", online: true };

function deps(log: string[], over: Partial<PosTxnSyncDeps> = {}): { deps: Partial<PosTxnSyncDeps>; calls: { orderId: string }[] } {
  const calls: { orderId: string }[] = [];
  const d: Partial<PosTxnSyncDeps> = {
    payOrderOp: async (a) => { log.push("pay"); calls.push({ orderId: a.orderId }); return { order_id: a.orderId, paid: true, amount: 25, idempotent: false }; },
    submit: async () => { log.push("submit"); return { order_id: "SRV-ORD", order_number: "N1" }; },
    isTransport: (e) => e instanceof TypeError,
    hasSession: async () => true,
    ...over,
  };
  return { deps: d, calls };
}

beforeEach(async () => {
  await Promise.all([localdb.operations.clear(), localdb.entityMap.clear(), localdb.syncHistory.clear(), localdb.posOfflineTxns.clear()]);
  __resetDrainLockForTests();
});

test("deterministic client_op_id per order+method+currency; capture idempotent", async () => {
  const id1 = payOrderClientOpId(SCOPE, "ORD-1", "cash", "USD");
  const id2 = payOrderClientOpId(SCOPE, "ORD-1", "cash", "USD");
  assert.equal(id1, id2);
  const a = await capturePayOrderOffline({ scope: SCOPE, orderId: "ORD-1", method: "cash", currency: "USD", clientOpId: id1, cashAmountUsd: 25 });
  const b = await capturePayOrderOffline({ scope: SCOPE, orderId: "ORD-1", method: "cash", currency: "USD", clientOpId: id1, cashAmountUsd: 25 });
  assert.equal(b.alreadyCaptured, true);
  assert.equal(b.operationId, a.operationId);
});

test("E2E hydrated order: capture → drain → pos_pay_order once", async () => {
  await capturePayOrderOffline({ scope: SCOPE, orderId: "ORD-1", method: "cash", currency: "USD", clientOpId: "c1", cashAmountUsd: 25 });
  const log: string[] = [];
  const { deps: d, calls } = deps(log);
  const r = await drainOffline(CTX, "reconnect", d);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].orderId, "ORD-1");
  assert.equal(r.needsAttention.length, 0);
});

test("offline-created delivery order: COD settle waits for the order to sync, then pays canonical", async () => {
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
    payload: { order_payload: { order_type: "delivery" }, payment_intent: null, paid: false },
    status: "pending",
    retry_count: 0,
    last_attempt_at: null,
    last_error_code: null,
    last_error_message: null,
    result_meta: null,
    synced_at: null,
  } as OfflineOperation);
  await capturePayOrderOffline({ scope: SCOPE, orderId: null, orderLocal: "ord-local", method: "cash", currency: "USD", clientOpId: "c1", cashAmountUsd: 25 });
  const log: string[] = [];
  const { deps: d, calls } = deps(log);
  const r = await drainOffline(CTX, "reconnect", d);
  assert.ok(log.indexOf("submit") < log.indexOf("pay"));
  assert.equal(calls[0].orderId, "SRV-ORD");
  assert.equal(r.needsAttention.length, 0);
});

test("settle conflict on replay → needs_attention, never a second charge", async () => {
  await capturePayOrderOffline({ scope: SCOPE, orderId: "ORD-1", method: "cash", currency: "USD", clientOpId: "c1" });
  const log: string[] = [];
  const { deps: d } = deps(log, { payOrderOp: async () => { throw new Error("already paid"); } });
  const r = await drainOffline(CTX, "reconnect", d);
  assert.equal(r.needsAttention.length, 1);
  assert.equal((await getOperation("payorder:c1"))?.status, "needs_attention");
});

test("DeliveryWorkspace source: offline settle captures pay_order (rc.9: provider rule checked locally)", () => {
  const dw = srcOf("src/screens/pos/DeliveryWorkspace.tsx");
  assert.match(dw, /if \(!online && itemEditOfflineScope\)/, "offline settle gated on offline + scope");
  // rc.9 — a provider-mode order settles offline only once the provider-before-pay rule passes against
  // the projection (provider chosen offline from the cached authorized catalog); the server re-checks.
  assert.match(dw, /if \(providerModeOn\) \{[\s\S]{0,400}deliveryProviderFinalizeBlock\(/);
  assert.match(dw, /online: online \|\| \(itemEditOfflineScope != null && \(!providersFeatureOn \|\| providersKnown\)\)/);
  // 1.0.38 (C3 + D4) — after every LIVE pending mutation (never a parked one) and after the order's
  // own create op while it is still local.
  assert.match(dw, /const dependencyIds = \[\.\.\.ref\.dependencyIds, \.\.\.\(await liveCaptureDependencies\(proj\?\.mutationOpIds \?\? \[\]\)\)\]/, "settle replays after every live pending mutation");
  assert.match(dw, /await capturePayOrderOffline\(/, "captures a pay_order op offline");
  assert.match(dw, /await performDeliverySettlement\(/, "the ONLINE settlement path is preserved");
});
