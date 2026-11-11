// 1.0.41 (Staging 1.0.52 native QA, D-4 + owner requirements 2026-11-11). A delivery order settled OFFLINE on this
// terminal (cash / COD) tells apart, from its settle operation's own state:
//   - cash collected here, pending sync          → "Collected · pending sync", "syncs automatically … do not collect"
//   - paid and confirmed by Breadee (op synced)   → "Paid", no "syncing" wording left on screen
//   - collected, but Breadee refused it           → "Needs attention", review in Sync Center, do not collect
// and Pay is never offered again while a settle is pending or refused (customer half AND queue, online or offline).

import "fake-indexeddb/auto";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? (this.m.get(k) as string) : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
(globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage();

import { localdb } from "@/lib/offline/db";
import { capturePayOrderOffline, unresolvedLocalOrderSettle } from "@/lib/offline/payOrderOffline";
import { resolveEntity } from "@/lib/offline/entityMap";
import { DELIVERY_SETTLE_TEXT, deliverySettleBlockReason, deliverySettleState } from "@/lib/pos/deliverySettleState";

const SCOPE = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "d1", terminalId: "term1" };

beforeEach(async () => {
  await Promise.all([localdb.operations.clear(), localdb.entityMap.clear()]);
});

test("the three states come from the settle op itself", () => {
  for (const s of ["pending", "syncing", "retryable", "blocked_dependency"] as const) assert.equal(deliverySettleState({ status: s }), "pending_sync", s);
  assert.equal(deliverySettleState({ status: "synced" }), "confirmed");
  assert.equal(deliverySettleState({ status: "needs_attention" }), "refused");
  assert.equal(deliverySettleState({ status: "cancelled" }), "refused", "withdrawn after a refusal: never applied by Breadee");
  assert.equal(deliverySettleState(null), null);
});

test("each state has its own words; only the pending one says it will sync", () => {
  assert.match(DELIVERY_SETTLE_TEXT.pending_sync.note, /syncs automatically/);
  assert.match(DELIVERY_SETTLE_TEXT.pending_sync.note, /do not collect it again/);
  assert.match(DELIVERY_SETTLE_TEXT.confirmed.note, /confirmed by Breadee/);
  assert.doesNotMatch(DELIVERY_SETTLE_TEXT.confirmed.note, /sync/i, "no 'syncing' message once Breadee confirmed it");
  assert.equal(DELIVERY_SETTLE_TEXT.confirmed.badge, "Paid");
  assert.match(DELIVERY_SETTLE_TEXT.refused.note, /did not accept/);
  assert.match(DELIVERY_SETTLE_TEXT.refused.note, /Do not collect it again/);
  assert.equal(DELIVERY_SETTLE_TEXT.refused.tone, "red");
});

test("Pay is withheld while a settle is pending or refused, and only then", () => {
  assert.match(deliverySettleBlockReason("pending_sync") ?? "", /do not collect it again/i);
  assert.match(deliverySettleBlockReason("refused") ?? "", /did not accept/);
  assert.equal(deliverySettleBlockReason("confirmed"), null, "a confirmed order is paid on Breadee: the server gate refuses it");
  assert.equal(deliverySettleBlockReason(null), null);
});

test("an unresolved local settle is found under the order's local OR canonical id; synced / withdrawn ones are not", async () => {
  const cap = await capturePayOrderOffline({ scope: SCOPE, orderId: null, orderLocal: "local-order-1", method: "cod", currency: "LBP", clientOpId: "c0d00000-0000-4000-8000-000000000001", orderType: "delivery" });
  assert.equal((await unresolvedLocalOrderSettle(["local-order-1"]))?.operation_id, cap.operationId, "pending, by local id");
  await resolveEntity({ local_entity_id: "local-order-1", entity_type: "order", canonical_id: "order-1", resolved_at: new Date().toISOString(), tenant_id: "t1", branch_id: "b1", device_id: "d1", cashier_user_id: "u1", terminal_id: "term1" });
  assert.equal((await unresolvedLocalOrderSettle(["order-1"]))?.operation_id, cap.operationId, "pending, by the canonical id the queue shows");
  await localdb.operations.update(cap.operationId, { status: "needs_attention", last_error_code: "pay_amount_changed" });
  assert.equal((await unresolvedLocalOrderSettle(["order-1"]))?.status, "needs_attention", "refused: still unresolved");
  await localdb.operations.update(cap.operationId, { status: "cancelled" });
  assert.equal(await unresolvedLocalOrderSettle(["order-1"]), null, "withdrawn by a manager: resolved");
  await localdb.operations.update(cap.operationId, { status: "synced" });
  assert.equal(await unresolvedLocalOrderSettle(["order-1"]), null, "synced: Breadee's own record decides");
  assert.equal(await unresolvedLocalOrderSettle(["another-order"]), null);
  assert.equal(await unresolvedLocalOrderSettle([]), null);
});

test("the workspace reads the settle op's live state and gates Pay on it (customer half and queue)", () => {
  const ws = readFileSync(join(process.cwd(), "src", "screens", "pos", "DeliveryWorkspace.tsx"), "utf8");
  assert.match(ws, /setOfflineSettleOp\(\{ orderId: order\.id, operationId: cap\.operationId \}\)/);
  assert.match(ws, /window\.addEventListener\(OFFLINE_DRAINED_EVENT, read\)/, "re-read after every drain");
  assert.match(ws, /offlineSettle=\{submittedSettle\}/);
  assert.match(ws, /unresolvedLocalOrderSettle\(\[orderId\]\)/, "the queue detail checks for an unresolved local settle");
  assert.match(ws, /if \(g\.allowed && queueBlock\) return \{ allowed: false, reason: queueBlock \};/);
});
