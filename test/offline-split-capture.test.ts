// Phase D (D3) — offline SPLIT capture + local projection (hydrated bill). Proves: the cached
// split state drives a restart-safe remaining-qty projection; each captured leg reduces it; local
// over-allocation is refused; double-tap is idempotent; legs chain (leg 2 depends on leg 1);
// capture→drain replays legs in order exactly once; no cache → reconnect.

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
import { getOperation } from "@/lib/offline/operationLog";
import { drainOffline, __resetDrainLockForTests } from "@/lib/offline/orchestrator";
import type { PosTxnSyncDeps } from "@/lib/offline/posTxnSync";
import { cacheSplitForOffline, localSplitRemaining, splitSettleOffline, type SplitScope, type CachedSplit } from "@/lib/offline/splitOffline";

const SCOPE: SplitScope = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1" };
const CTX = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1", online: true };

const SPLIT: CachedSplit = {
  order_id: "ORD-1", order_number: "A-1", table_id: "TBL-1", currency: "USD", pos_entity_version: 3,
  lines: [
    { order_item_id: "itA", name: "Burger", original_qty: 2, allocated_qty: 0, final_unit_price: 10 },
    { order_item_id: "itB", name: "Fries", original_qty: 1, allocated_qty: 0, final_unit_price: 4 },
  ],
};

function deps(order: string[]): PosTxnSyncDeps {
  return {
    submit: async () => ({ order_id: "x", order_number: "y" }),
    pay: async () => ({}),
    openShift: async () => ({ shiftId: "s", reused: false }),
    openTable: async () => ({ table_id: "T", pos_entity_version: 1 }),
    submitRound: async () => ({ order_id: "O", order_number: "N", batch_no: 1, appended: true, idempotent: false }),
    voidRefund: async () => ({ order_id: "O", status: "refunded", refunded: true, refund_usd: 0, refund_id: null, idempotent: false }),
    payTable: async () => ({ ok: true, amount: 5, idempotent: false }),
    payOrderOp: async (a) => ({ order_id: a.orderId, paid: true, amount: 5, idempotent: false }),
    onAccountTable: async () => ({ ok: true, idempotent: false }),
    onAccountOrder: async () => ({ ok: true, idempotent: false }),
    endShiftOp: async (a) => ({ shift_id: a.shiftId, idempotent: false }),
    splitSettle: async (a) => { order.push(a.allocations.map((x) => x.order_item_id).join("+")); return { ok: true, split_no: order.length, parent_completed: false, remaining_qty: 0, idempotent: false }; },
    isTransport: (e) => e instanceof TypeError,
    hasSession: async () => true,
  };
}

beforeEach(async () => {
  await Promise.all([localdb.operations.clear(), localdb.entityMap.clear(), localdb.syncHistory.clear(), localdb.snapshots.clear()]);
  __resetDrainLockForTests();
});

test("projection: cached split state yields remaining = original − server-allocated", async () => {
  await cacheSplitForOffline(SCOPE, SPLIT);
  const r = await localSplitRemaining("ORD-1", SCOPE);
  assert.equal(r?.lines.find((l) => l.order_item_id === "itA")?.remaining, 2);
  assert.equal(r?.lines.find((l) => l.order_item_id === "itB")?.remaining, 1);
});

test("no cache → reconnect", async () => {
  const r = await splitSettleOffline({ scope: SCOPE, orderId: "ORD-X", allocations: [{ order_item_id: "itA", quantity: 1 }], method: "cash", currency: "USD" });
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /reconnect/i);
});

test("capture a leg: reduces the local projection; local over-allocation refused", async () => {
  await cacheSplitForOffline(SCOPE, SPLIT);
  const cap = await splitSettleOffline({ scope: SCOPE, orderId: "ORD-1", allocations: [{ order_item_id: "itA", quantity: 1 }], method: "cash", currency: "USD" });
  assert.equal(cap.ok, true);
  const r = await localSplitRemaining("ORD-1", SCOPE);
  assert.equal(r?.lines.find((l) => l.order_item_id === "itA")?.remaining, 1); // 2 − 1 captured
  // Over-allocate the remaining 1 → refused.
  const bad = await splitSettleOffline({ scope: SCOPE, orderId: "ORD-1", allocations: [{ order_item_id: "itA", quantity: 2 }], method: "cash", currency: "USD" });
  assert.equal(bad.ok, false);
  assert.match((bad as { reason: string }).reason, /only 1 of "Burger"/i);
});

test("double-tap (same selection+method) collapses to ONE leg", async () => {
  await cacheSplitForOffline(SCOPE, SPLIT);
  const a = await splitSettleOffline({ scope: SCOPE, orderId: "ORD-1", allocations: [{ order_item_id: "itA", quantity: 1 }], method: "cash", currency: "USD" });
  const b = await splitSettleOffline({ scope: SCOPE, orderId: "ORD-1", allocations: [{ order_item_id: "itA", quantity: 1 }], method: "cash", currency: "USD" });
  assert.equal((a as { operationId: string }).operationId, (b as { operationId: string }).operationId);
  assert.equal((b as { alreadyCaptured: boolean }).alreadyCaptured, true);
  assert.equal(await localdb.operations.where("operation_type").equals("split_settle").count(), 1);
});

test("second leg chains after the first (strict order)", async () => {
  await cacheSplitForOffline(SCOPE, SPLIT);
  const leg1 = await splitSettleOffline({ scope: SCOPE, orderId: "ORD-1", allocations: [{ order_item_id: "itA", quantity: 2 }], method: "cash", currency: "USD" });
  const leg2 = await splitSettleOffline({ scope: SCOPE, orderId: "ORD-1", allocations: [{ order_item_id: "itB", quantity: 1 }], method: "card", currency: "USD" });
  const op2 = await getOperation((leg2 as { operationId: string }).operationId);
  assert.deepEqual(op2?.dependency_ids, [(leg1 as { operationId: string }).operationId]);
});

test("capture → drain: legs replay in order, exactly once", async () => {
  await cacheSplitForOffline(SCOPE, SPLIT);
  await splitSettleOffline({ scope: SCOPE, orderId: "ORD-1", allocations: [{ order_item_id: "itA", quantity: 2 }], method: "cash", currency: "USD" });
  await splitSettleOffline({ scope: SCOPE, orderId: "ORD-1", allocations: [{ order_item_id: "itB", quantity: 1 }], method: "card", currency: "USD" });
  const order: string[] = [];
  const r = await drainOffline(CTX, "reconnect", deps(order));
  assert.deepEqual(order, ["itA", "itB"]); // leg 1 (itA) before leg 2 (itB)
  assert.equal(r.drained.length, 2);
});
