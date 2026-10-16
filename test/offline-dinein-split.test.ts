// Phase D (D3) — FULLY-OFFLINE Dine-In split: open a table, send rounds, and split the bill all
// while offline (local line ids), then on reconnect the rounds canonicalize, pos_order_item_map
// resolves line_local → canonical order_item_id via entityMap, and the split legs settle in order
// exactly-once. Plus: local projection + over-allocation guard + End-Shift waits behind splits.

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
import { openTableOffline, addDraftLine, sendRoundOffline, splitDineDraftOffline, splitDineDraftRemaining } from "@/lib/offline/dineinOffline";
import { captureEndShiftOffline } from "@/lib/offline/endShiftOffline";

const DSCOPE = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1", shiftId: "sh1" };
const CTX = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1", online: true };

function deps(log: string[], over: Partial<PosTxnSyncDeps> = {}): { deps: PosTxnSyncDeps; splitCalls: { order_item_id: string; quantity: number }[][] } {
  const splitCalls: { order_item_id: string; quantity: number }[][] = [];
  const d: PosTxnSyncDeps = {
    submit: async () => ({ order_id: "x", order_number: "y" }),
    pay: async () => ({}),
    openShift: async () => ({ shiftId: "s", reused: false }),
    openTable: async () => { log.push("open"); return { table_id: "SRV-TBL", pos_entity_version: 1 }; },
    submitRound: async () => { log.push("round"); return { order_id: "SRV-ORD", order_number: "N1", batch_no: 1, appended: true, idempotent: false }; },
    orderItemMap: async () => [{ client_line_id: LINE_A, order_item_id: "IT-A" }, { client_line_id: LINE_B, order_item_id: "IT-B" }],
    voidRefund: async () => ({ order_id: "O", status: "refunded", refunded: true, refund_usd: 0, refund_id: null, idempotent: false }),
    payTable: async () => ({ ok: true, amount: 5, idempotent: false }),
    payOrderOp: async (a) => ({ order_id: a.orderId, paid: true, amount: 5, idempotent: false }),
    onAccountTable: async () => ({ ok: true, idempotent: false }),
    onAccountOrder: async () => ({ ok: true, idempotent: false }),
    endShiftOp: async (a) => { log.push("end"); return { shift_id: a.shiftId, idempotent: false }; },
    splitSettle: async (a) => { log.push("split"); splitCalls.push(a.allocations); return { ok: true, split_no: splitCalls.length, parent_completed: false, remaining_qty: 0, idempotent: false }; },
    isTransport: (e) => e instanceof TypeError,
    hasSession: async () => true,
    ...over,
  };
  return { deps: d, splitCalls };
}

let LINE_A = "";
let LINE_B = "";

async function buildSession() {
  const draft = await openTableOffline({ scope: DSCOPE, tableId: "TBL-9", tableName: "9", currency: "USD" });
  const d1 = await addDraftLine(draft.local_session_id, { menu_item_id: "m1", name: "Burger", base_price: 10, quantity: 1, modifiers: [], kitchen_note: null });
  LINE_A = d1.lines[d1.lines.length - 1].line_id;
  const d2 = await addDraftLine(draft.local_session_id, { menu_item_id: "m1", name: "Burger", base_price: 10, quantity: 1, modifiers: [], kitchen_note: null });
  LINE_B = d2.lines[d2.lines.length - 1].line_id;
  await sendRoundOffline(draft.local_session_id);
  return draft.local_session_id;
}

beforeEach(async () => {
  await Promise.all([localdb.operations.clear(), localdb.entityMap.clear(), localdb.syncHistory.clear(), localdb.dineDrafts.clear()]);
  __resetDrainLockForTests();
});

test("projection + capture: two identical sent lines are splittable independently by local id", async () => {
  const sid = await buildSession();
  const rem = await splitDineDraftRemaining(sid);
  assert.equal(rem?.length, 2); // two independent lines even though identical menu item
  const cap = await splitDineDraftOffline({ sessionId: sid, allocations: [{ line_id: LINE_A, quantity: 1 }], method: "cash" });
  assert.equal(cap.ok, true);
  const rem2 = await splitDineDraftRemaining(sid);
  assert.equal(rem2?.find((r) => r.line_id === LINE_A)?.remaining, 0);
  assert.equal(rem2?.find((r) => r.line_id === LINE_B)?.remaining, 1);
});

test("over-allocation refused locally", async () => {
  const sid = await buildSession();
  const bad = await splitDineDraftOffline({ sessionId: sid, allocations: [{ line_id: LINE_A, quantity: 2 }], method: "cash" });
  assert.equal(bad.ok, false);
});

test("E2E fully-offline: open→round→split(local ids) → drain → map → settle canonical, in order, once", async () => {
  const sid = await buildSession();
  await splitDineDraftOffline({ sessionId: sid, allocations: [{ line_id: LINE_A, quantity: 1 }], method: "cash" });
  await splitDineDraftOffline({ sessionId: sid, allocations: [{ line_id: LINE_B, quantity: 1 }], method: "card" });

  const log: string[] = [];
  const { deps: d, splitCalls } = deps(log);
  const r = await drainOffline(CTX, "reconnect", d);
  // Open + round canonicalize BEFORE any split leg; both legs settle, in order.
  assert.ok(log.indexOf("open") < log.indexOf("round"));
  assert.ok(log.indexOf("round") < log.indexOf("split"));
  assert.equal(log.filter((x) => x === "split").length, 2);
  // Each leg settled with the CANONICAL order_item_id resolved from its local line id.
  assert.deepEqual(splitCalls[0], [{ order_item_id: "IT-A", quantity: 1 }]);
  assert.deepEqual(splitCalls[1], [{ order_item_id: "IT-B", quantity: 1 }]);
  assert.equal(r.needsAttention.length, 0);
});

test("End Shift waits behind the split legs (canonical close is last)", async () => {
  const sid = await buildSession();
  await splitDineDraftOffline({ sessionId: sid, allocations: [{ line_id: LINE_A, quantity: 1 }], method: "cash" });
  await captureEndShiftOffline({ scope: DSCOPE, shiftId: "SRV-SHIFT", shiftLocal: null, actualCashCounted: 10, notes: null });
  const log: string[] = [];
  await drainOffline(CTX, "reconnect", deps(log).deps);
  assert.equal(log[log.length - 1], "end"); // End Shift is strictly last
  assert.ok(log.indexOf("split") < log.indexOf("end"));
});

test("split leg BLOCKS (no partial) while item mapping is unavailable", async () => {
  const sid = await buildSession();
  await splitDineDraftOffline({ sessionId: sid, allocations: [{ line_id: LINE_A, quantity: 1 }], method: "cash" });
  const log: string[] = [];
  // Map returns nothing → the leg must not settle.
  const { deps: d, splitCalls } = deps(log, { orderItemMap: async () => [] });
  await drainOffline(CTX, "reconnect", d);
  assert.equal(splitCalls.length, 0);
});
