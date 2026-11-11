// 1.0.41 (S-PAYORDER_01) — Staging 1.0.55 native QA finding: an offline delivery COD settle captured for
// 98,901 LBP replayed after ANOTHER device added an item, and pos_pay_order charged the order's NEW total
// (198,901 LBP) with no warning. The settle is now pinned to the order total Breadee gave this terminal
// (expected_order_total); a changed total is refused (PAY_AMOUNT_CHANGED → needs_attention, nothing charged).
//
// Real Dexie (fake-indexeddb), the REAL capture helper + orchestrator + handler; only the RPC is injected.

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
import { getOperation } from "@/lib/offline/operationLog";
import { drainOffline, __resetDrainLockForTests } from "@/lib/offline/orchestrator";
import type { PosTxnSyncDeps } from "@/lib/offline/posTxnSync";
import { capturePayOrderOffline, offlineSettleTotalPin } from "@/lib/offline/payOrderOffline";
import { deliverySettleState } from "@/lib/pos/deliverySettleState";

const PSCOPE = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1" };
const CTX = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1", online: true };

beforeEach(async () => {
  await Promise.all([localdb.operations.clear(), localdb.entityMap.clear(), localdb.syncHistory.clear(), localdb.posOfflineTxns.clear()]);
  __resetDrainLockForTests();
});

function deps(over: Partial<PosTxnSyncDeps> & { calls: Record<string, unknown>[] }): PosTxnSyncDeps {
  const { calls, ...rest } = over;
  return {
    submit: async () => ({}),
    pay: async () => ({}),
    openShift: async () => ({ shiftId: "SRV-SHIFT", reused: false }),
    orderItemMap: async () => [],
    payOrderOp: async (a: Record<string, unknown>) => { calls.push(a); return { order_id: String(a.orderId), paid: true, amount: 98901, idempotent: false }; },
    isTransport: (e: unknown) => e instanceof TypeError,
    hasSession: async () => true,
    ...rest,
  } as unknown as PosTxnSyncDeps;
}

/** The PostgREST shape of a pos_op_error refusal (structured code in `details`). */
function refusal(code: string, message: string): Error {
  return Object.assign(new Error(message), { code: "P0001", details: JSON.stringify({ pos_error_code: code }) });
}

test("the pin is sent only when the order total is exact", () => {
  const base = { orderId: "SRV-1", canonicalOrderId: "SRV-1", orderLocal: null, liveMutationCount: 0, totalAmount: 98901 };
  assert.equal(offlineSettleTotalPin(base), 98901, "Breadee's own row, nothing unsynced");
  assert.equal(offlineSettleTotalPin({ ...base, orderLocal: "LOCAL-1", canonicalOrderId: null }), null, "created offline here: total not Breadee's");
  assert.equal(offlineSettleTotalPin({ ...base, orderId: "LOCAL-1" }), null, "synced offline order still held under its local id");
  assert.equal(offlineSettleTotalPin({ ...base, liveMutationCount: 1 }), null, "an unsynced local edit changes Breadee's total legitimately");
  assert.equal(offlineSettleTotalPin({ ...base, totalAmount: null }), null);
  assert.equal(offlineSettleTotalPin({ ...base, totalAmount: Number.NaN }), null);
  assert.equal(offlineSettleTotalPin({ ...base, totalAmount: 0 }), 0, "a zero total is still exact");
});

test("capture records expected_order_total only when given; replay sends it to pos_pay_order", async () => {
  const pinned = await capturePayOrderOffline({ scope: PSCOPE, orderId: "SRV-1", method: "cod", currency: "LBP", clientOpId: "b016725c-0000-4000-8000-000000000001", orderType: "delivery", expectedOrderTotal: 98901 });
  const plain = await capturePayOrderOffline({ scope: PSCOPE, orderId: "SRV-2", method: "cod", currency: "LBP", clientOpId: "b016725c-0000-4000-8000-000000000002", orderType: "delivery" });
  assert.equal((await getOperation(pinned.operationId))?.payload.expected_order_total, 98901);
  assert.equal("expected_order_total" in ((await getOperation(plain.operationId))?.payload ?? {}), false, "absent, never null: the pre-1.0.56 request");
  const calls: Record<string, unknown>[] = [];
  await drainOffline(CTX, "t", deps({ calls }));
  const byOrder = Object.fromEntries(calls.map((c) => [String(c.orderId), c]));
  assert.equal(byOrder["SRV-1"]?.expectedOrderTotal, 98901);
  assert.equal("expectedOrderTotal" in (byOrder["SRV-2"] ?? {}), false);
});

test("a total changed on another device → refused (needs attention), never charged; the order shows Needs attention", async () => {
  const cap = await capturePayOrderOffline({ scope: PSCOPE, orderId: "SRV-1", method: "cod", currency: "LBP", clientOpId: "b016725c-0000-4000-8000-000000000003", orderType: "delivery", expectedOrderTotal: 98901 });
  const calls: Record<string, unknown>[] = [];
  await drainOffline(CTX, "t", deps({
    calls,
    payOrderOp: async (a: Record<string, unknown>) => {
      calls.push(a);
      throw refusal("PAY_AMOUNT_CHANGED", "This order changed on Breadee since the payment was captured on this terminal, so it was not charged. Review it before settling.");
    },
  }));
  const after = await getOperation(cap.operationId);
  assert.equal(after?.status, "needs_attention");
  assert.equal(after?.last_error_code, "pay_amount_changed");
  assert.equal(deliverySettleState(after ?? null), "refused", "the Delivery panel says Needs attention, not Paid");
  // A second drain does not re-send a refused settle (no second charge attempt behind the operator's back).
  const before = calls.length;
  await drainOffline(CTX, "t", deps({ calls }));
  assert.equal(calls.length, before);
});

test("the workspace passes the pin and the RPC client forwards it", () => {
  const sync = readFileSync(join(process.cwd(), "src", "lib", "offline", "posTxnSync.ts"), "utf8");
  assert.match(sync, /expected_order_total: args\.expectedOrderTotal/);
  const ws = readFileSync(join(process.cwd(), "src", "screens", "pos", "DeliveryWorkspace.tsx"), "utf8");
  assert.match(ws, /const expectedOrderTotal = offlineSettleTotalPin\(\{/);
  assert.match(ws, /liveMutationCount: liveMutations\.length/);
  assert.match(ws, /orderType: "delivery",\s*expectedOrderTotal,/);
});
