// Phase D (D7) — full offline-shift INTEGRATION across the Phase-D op set, proving the single
// orchestrator sequences them correctly and the End-Shift barrier spans EVERY op type (D6).
//
// Scenario: a whole shift serviced OFFLINE — open a dine-in table, send a round, settle it for
// cash, pay out petty cash, then end the shift — all captured through the real capture helpers and
// drained once on reconnect. Asserts: strict dependency order (open → round → settle), exactly-once
// per op, the canonical close replays LAST after every sale/payout, zero needs_attention, and a
// coherent local drawer projection (cash settle in, payout out).

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

import { localdb, cachePayoutSourceProofs, type PayoutProofScope } from "@/lib/offline/db";
import { drainOffline, __resetDrainLockForTests } from "@/lib/offline/orchestrator";
import type { PosTxnSyncDeps } from "@/lib/offline/posTxnSync";
import { openTableOffline, addDraftLine, sendRoundOffline, settleTableOffline } from "@/lib/offline/dineinOffline";
import { provePayoutSourceOffline, capturePayoutOffline, type PayoutScope } from "@/lib/offline/payoutOffline";
import { captureEndShiftOffline } from "@/lib/offline/endShiftOffline";
import { extractDrawerMovements, computeDrawerProjection } from "@/lib/offline/drawerProjection";

const SCOPE = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1" };
const DSCOPE = { ...SCOPE, shiftId: "SRV-SHIFT" };
const PSCOPE: PayoutProofScope = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1" };
const PAYSCOPE: PayoutScope = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1" };
const CTX = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1", online: true };

function deps(log: string[]): Partial<PosTxnSyncDeps> {
  return {
    openTable: async () => { log.push("open_table"); return { table_id: "SRV-TBL", pos_entity_version: 1 }; },
    submitRound: async () => { log.push("round"); return { order_id: "SRV-ORD", order_number: "N1", batch_no: 1, appended: true, idempotent: false }; },
    payTable: async () => { log.push("pay_table"); return { ok: true, amount: 40, idempotent: false }; },
    payout: async (a) => { log.push("payout"); return { payout_id: "PO-1", amount: a.amount, amount_usd: a.amount, idempotent: false }; },
    endShiftOp: async (a) => { log.push("end"); return { shift_id: a.shiftId, idempotent: false }; },
    isTransport: (e) => e instanceof TypeError,
    hasSession: async () => true,
  };
}

beforeEach(async () => {
  await Promise.all([localdb.operations.clear(), localdb.entityMap.clear(), localdb.syncHistory.clear(), localdb.dineDrafts.clear(), localdb.payoutSourceProofs.clear()]);
  __resetDrainLockForTests();
});

test("full offline shift: open→round→settle + payout, End Shift last, exactly-once, drawer coherent", async () => {
  // Hydrate a payout source (as if read while online earlier in the shift).
  await cachePayoutSourceProofs(PSCOPE, "expense", [{ id: "EXP-1", label: "Driver", sublabel: null }]);

  // 1) Dine-in table serviced offline.
  const draft = await openTableOffline({ scope: DSCOPE, tableId: "TBL-1", tableName: "1", currency: "USD" });
  await addDraftLine(draft.local_session_id, { menu_item_id: "m1", name: "Burger", base_price: 40, quantity: 1, modifiers: [], kitchen_note: null });
  await sendRoundOffline(draft.local_session_id);
  await settleTableOffline({ sessionId: draft.local_session_id, method: "cash", cashAmountUsd: 40 });

  // 2) A cash payout against the proven source.
  const proof = await provePayoutSourceOffline("expense", "EXP-1", PAYSCOPE);
  assert.ok(proof.ok);
  await capturePayoutOffline({ scope: PAYSCOPE, shiftId: "SRV-SHIFT", proof: proof.ok ? proof.proof : (undefined as never), amount: 9, currency: "USD", note: null, amountUsd: 9, clientOpId: "pc1" });

  // 3) End the shift — the barrier spans the open, round, settle AND payout.
  const es = await captureEndShiftOffline({ scope: SCOPE, shiftId: "SRV-SHIFT", shiftLocal: null, actualCashCounted: 131, notes: null });
  assert.equal(es.dependencyCount, 4); // open_table + round + pay_table + payout

  // Drawer BEFORE sync: cash settle in (40), payout out (9), over a 100 float.
  const preOps = await localdb.operations.toArray();
  const { movements } = extractDrawerMovements(preOps, SCOPE);
  const proj = computeDrawerProjection(100, movements);
  assert.equal(proj.cashInUsd, 40);
  assert.equal(proj.cashOutUsd, 9);
  assert.equal(proj.expectedCashUsd, 131);

  // Reconnect drain.
  const log: string[] = [];
  const r = await drainOffline(CTX, "reconnect", deps(log));

  // Strict order: open before round before settle; End Shift strictly LAST (after payout too).
  assert.ok(log.indexOf("open_table") < log.indexOf("round"));
  assert.ok(log.indexOf("round") < log.indexOf("pay_table"));
  assert.ok(log.indexOf("payout") < log.indexOf("end"));
  assert.equal(log[log.length - 1], "end");
  // Exactly-once each; nothing parked.
  assert.equal(log.filter((x) => x === "end").length, 1);
  assert.equal(log.filter((x) => x === "payout").length, 1);
  assert.equal(log.filter((x) => x === "pay_table").length, 1);
  assert.equal(r.needsAttention.length, 0);
  assert.equal(r.drained.length, 5); // open + round + settle + payout + end

  // Every captured op reached terminal success.
  const after = await localdb.operations.toArray();
  assert.ok(after.every((o) => o.status === "synced"));
});

test("End-Shift barrier excludes a WITHDRAWN payout (cancelled op is not a prerequisite)", async () => {
  await cachePayoutSourceProofs(PSCOPE, "expense", [{ id: "EXP-1", label: "Driver", sublabel: null }]);
  const draft = await openTableOffline({ scope: DSCOPE, tableId: "TBL-1", tableName: "1", currency: "USD" });
  await addDraftLine(draft.local_session_id, { menu_item_id: "m1", name: "Burger", base_price: 40, quantity: 1, modifiers: [], kitchen_note: null });
  await sendRoundOffline(draft.local_session_id);
  const proof = await provePayoutSourceOffline("expense", "EXP-1", PAYSCOPE);
  const cap = await capturePayoutOffline({ scope: PAYSCOPE, shiftId: "SRV-SHIFT", proof: proof.ok ? proof.proof : (undefined as never), amount: 9, currency: "USD", note: null, amountUsd: 9, clientOpId: "pc1" });
  await localdb.operations.update(cap.operationId, { status: "cancelled" }); // operator withdrew it

  const es = await captureEndShiftOffline({ scope: SCOPE, shiftId: "SRV-SHIFT", shiftLocal: null, actualCashCounted: 100, notes: null });
  assert.equal(es.dependencyCount, 2); // open_table + round only — the cancelled payout is excluded

  const log: string[] = [];
  const r = await drainOffline(CTX, "reconnect", deps(log));
  assert.equal(log.includes("payout"), false); // the withdrawn payout never replays
  assert.equal(log[log.length - 1], "end");
  assert.equal(r.needsAttention.length, 0);
});
