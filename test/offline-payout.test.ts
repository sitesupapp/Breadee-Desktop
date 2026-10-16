// Phase D (D4) — offline CASH PAYOUT: prove a source hydrated online, capture a durable payout
// that reduces the drawer immediately, replay exactly-once via pos_payout_create, remap an
// offline-opened shift, surface source drift as needs_attention, and reverse a still-local payout.

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

import {
  localdb,
  cachePayoutSourceProofs,
  listPayoutSourceProofs,
  readPayoutSourceProof,
  purgeForeignPayoutSourceProofs,
  type PayoutProofScope,
} from "@/lib/offline/db";
import {
  OPERATION_SCHEMA_VERSION,
  getOperation,
  type OfflineOperation,
} from "@/lib/offline/operationLog";
import { drainOffline, __resetDrainLockForTests } from "@/lib/offline/orchestrator";
import type { PosTxnSyncDeps } from "@/lib/offline/posTxnSync";
import {
  provePayoutSourceOffline,
  capturePayoutOffline,
  evaluatePayoutOfflineReady,
  payoutAmountUsd,
  listLocalPayouts,
  withdrawLocalPayout,
  type PayoutScope,
} from "@/lib/offline/payoutOffline";
import { captureEndShiftOffline } from "@/lib/offline/endShiftOffline";
import { computeDrawerProjection, extractDrawerMovements } from "@/lib/offline/drawerProjection";

const SCOPE: PayoutScope = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1" };
const PSCOPE: PayoutProofScope = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1" };
const CTX = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1", online: true };

function payoutDeps(log: string[], over: Partial<PosTxnSyncDeps> = {}): { deps: Partial<PosTxnSyncDeps>; calls: { shiftId: string; amount: number; sourceId: string }[] } {
  const calls: { shiftId: string; amount: number; sourceId: string }[] = [];
  const deps: Partial<PosTxnSyncDeps> = {
    openShift: async () => { log.push("open_shift"); return { shiftId: "SRV-SHIFT", reused: false }; },
    payout: async (a) => { log.push("payout"); calls.push({ shiftId: a.shiftId, amount: a.amount, sourceId: a.sourceId }); return { payout_id: "PO-1", amount: a.amount, amount_usd: a.amount, idempotent: false }; },
    endShiftOp: async (a) => { log.push("end"); return { shift_id: a.shiftId, idempotent: false }; },
    isTransport: (e) => e instanceof TypeError,
    hasSession: async () => true,
    ...over,
  };
  return { deps, calls };
}

async function seedProof() {
  await cachePayoutSourceProofs(PSCOPE, "expense", [{ id: "EXP-1", label: "Driver cash", sublabel: "Delivery · 20 USD" }]);
}

beforeEach(async () => {
  await Promise.all([localdb.operations.clear(), localdb.entityMap.clear(), localdb.syncHistory.clear(), localdb.payoutSourceProofs.clear()]);
  __resetDrainLockForTests();
});

test("payoutAmountUsd: USD passthrough, LBP by rate, unknown otherwise", () => {
  assert.equal(payoutAmountUsd(20, "USD", null), 20);
  assert.equal(payoutAmountUsd(90000, "LBP", 90000), 1);
  assert.equal(payoutAmountUsd(90000, "LBP", null), null); // no rate → unknown
  assert.equal(payoutAmountUsd(20, "EUR", 90000), null); // third ccy → unknown
  assert.equal(payoutAmountUsd(0, "USD", null), null); // non-positive → unknown
});

test("proof write-through: scope-exact read, replace-set eviction, foreign-scope fail-closed", async () => {
  await seedProof();
  const got = await readPayoutSourceProof("expense", "EXP-1", PSCOPE);
  assert.ok(got);
  assert.equal(got?.label, "Driver cash");

  // A sibling OU never reads it (fail-closed 5-D).
  assert.equal(await readPayoutSourceProof("expense", "EXP-1", { ...PSCOPE, branchId: "b2" }), null);
  // A null terminal is NOT a wildcard.
  assert.equal(await readPayoutSourceProof("expense", "EXP-1", { ...PSCOPE, terminalId: null }), null);

  // Replace-set: a re-hydration WITHOUT EXP-1 evicts it (source gone upstream).
  await cachePayoutSourceProofs(PSCOPE, "expense", [{ id: "EXP-2", label: "Other", sublabel: null }]);
  assert.equal(await readPayoutSourceProof("expense", "EXP-1", PSCOPE), null);
  assert.ok(await readPayoutSourceProof("expense", "EXP-2", PSCOPE));
  // A different type is independent (not touched by the expense replace-set).
  const list = await listPayoutSourceProofs(PSCOPE, "expense");
  assert.equal(list.length, 1);
});

test("purgeForeign drops other-tenant/branch proofs only", async () => {
  await seedProof();
  await cachePayoutSourceProofs({ ...PSCOPE, tenantId: "t2" }, "expense", [{ id: "X", label: "X", sublabel: null }]);
  const removed = await purgeForeignPayoutSourceProofs("t1", "b1");
  assert.equal(removed, 1);
  assert.ok(await readPayoutSourceProof("expense", "EXP-1", PSCOPE));
});

test("prove + gate: fail-closed without a proof, open when proven", async () => {
  const miss = await provePayoutSourceOffline("expense", "NOPE", SCOPE);
  assert.equal(miss.ok, false);
  assert.match(miss.ok ? "" : miss.reason, /offline/i);

  await seedProof();
  const hit = await provePayoutSourceOffline("expense", "EXP-1", SCOPE);
  assert.equal(hit.ok, true);

  assert.equal(evaluatePayoutOfflineReady({ online: true, offlineReady: false, hasOpenShift: false, proof: null }).allowed, true); // online unchanged
  assert.equal(evaluatePayoutOfflineReady({ online: false, offlineReady: false, hasOpenShift: true, proof: hit }).allowed, false);
  assert.equal(evaluatePayoutOfflineReady({ online: false, offlineReady: true, hasOpenShift: false, proof: hit }).allowed, false);
  assert.equal(evaluatePayoutOfflineReady({ online: false, offlineReady: true, hasOpenShift: true, proof: miss }).allowed, false);
  assert.equal(evaluatePayoutOfflineReady({ online: false, offlineReady: true, hasOpenShift: true, proof: hit }).allowed, true);
});

test("capture is idempotent on the client_op_id and rejects a non-positive amount", async () => {
  await seedProof();
  const proof = await provePayoutSourceOffline("expense", "EXP-1", SCOPE);
  assert.ok(proof.ok);
  const p = proof.ok ? proof.proof : (undefined as never);

  await assert.rejects(() => capturePayoutOffline({ scope: SCOPE, shiftId: "SRV-SHIFT", proof: p, amount: 0, currency: "USD", note: null, clientOpId: "c1" }));

  const a = await capturePayoutOffline({ scope: SCOPE, shiftId: "SRV-SHIFT", proof: p, amount: 20, currency: "USD", note: "driver", amountUsd: 20, clientOpId: "c1" });
  assert.equal(a.alreadyCaptured, false);
  const b = await capturePayoutOffline({ scope: SCOPE, shiftId: "SRV-SHIFT", proof: p, amount: 20, currency: "USD", note: "driver", amountUsd: 20, clientOpId: "c1" });
  assert.equal(b.alreadyCaptured, true); // double-tap → one durable op
  assert.equal(b.operationId, a.operationId);

  const op = await getOperation(a.operationId);
  const payload = (op?.payload ?? {}) as Record<string, unknown>;
  assert.equal(payload.source_id, "EXP-1");
  assert.equal(payload.amount, 20);
  assert.equal(payload.amount_usd, 20);
  assert.equal(payload.method, "cash");
});

test("captured payout reduces the local drawer projection immediately (cash out)", async () => {
  await seedProof();
  const proof = await provePayoutSourceOffline("expense", "EXP-1", SCOPE);
  const p = proof.ok ? proof.proof : (undefined as never);
  await capturePayoutOffline({ scope: SCOPE, shiftId: "SRV-SHIFT", proof: p, amount: 15, currency: "USD", note: null, amountUsd: 15, clientOpId: "c1" });

  const ops = await localdb.operations.toArray();
  const { movements, unknownAmountCount } = extractDrawerMovements(ops, { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1" });
  assert.equal(unknownAmountCount, 0);
  const proj = computeDrawerProjection(100, movements);
  assert.equal(proj.cashOutUsd, 15);
  assert.equal(proj.expectedCashUsd, 85); // 100 opening − 15 payout
});

test("E2E online shift: capture → drain → pos_payout_create once with the resolved source", async () => {
  await seedProof();
  const proof = await provePayoutSourceOffline("expense", "EXP-1", SCOPE);
  const p = proof.ok ? proof.proof : (undefined as never);
  await capturePayoutOffline({ scope: SCOPE, shiftId: "SRV-SHIFT", proof: p, amount: 20, currency: "USD", note: "driver", amountUsd: 20, clientOpId: "c1" });

  const log: string[] = [];
  const { deps, calls } = payoutDeps(log);
  const r = await drainOffline(CTX, "reconnect", deps);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { shiftId: "SRV-SHIFT", amount: 20, sourceId: "EXP-1" });
  assert.equal(r.needsAttention.length, 0);
  assert.equal(r.drained.length, 1);
});

test("offline-opened shift: payout remaps shift_local → canonical, blocks until the shift syncs", async () => {
  await seedProof();
  const proof = await provePayoutSourceOffline("expense", "EXP-1", SCOPE);
  const p = proof.ok ? proof.proof : (undefined as never);

  // An offline-opened shift op the payout depends on (local id "sh-local").
  const openOp: OfflineOperation = {
    operation_id: "openshift:op1",
    operation_type: "open_shift",
    schema_version: OPERATION_SCHEMA_VERSION,
    scope: { tenant_id: "t1", branch_id: "b1", device_id: "dev1", terminal_id: "term1", cashier_user_id: "u1" },
    created_at: new Date(Date.now() - 1000).toISOString(),
    client_op_id: "openc1",
    local_entity_id: "sh-local",
    canonical_entity_id: null,
    dependency_ids: [],
    depends_on_local_entities: [],
    payload: { branchId: "b1", openingCash: 50 },
    status: "pending",
    retry_count: 0,
    last_attempt_at: null,
    last_error_code: null,
    last_error_message: null,
    result_meta: null,
    synced_at: null,
  };
  await localdb.operations.add(openOp);
  await capturePayoutOffline({ scope: SCOPE, shiftId: null, shiftLocalId: "sh-local", proof: p, amount: 20, currency: "USD", note: null, amountUsd: 20, clientOpId: "c1" });

  const log: string[] = [];
  const { deps, calls } = payoutDeps(log);
  const r = await drainOffline(CTX, "reconnect", deps);
  // Shift opens first, then the payout settles against the CANONICAL shift id.
  assert.ok(log.indexOf("open_shift") < log.indexOf("payout"));
  assert.equal(calls[0].shiftId, "SRV-SHIFT");
  assert.equal(r.needsAttention.length, 0);
});

test("source drift on replay → needs_attention (CONFLICT), local op preserved, not a hot retry", async () => {
  await seedProof();
  const proof = await provePayoutSourceOffline("expense", "EXP-1", SCOPE);
  const p = proof.ok ? proof.proof : (undefined as never);
  const cap = await capturePayoutOffline({ scope: SCOPE, shiftId: "SRV-SHIFT", proof: p, amount: 20, currency: "USD", note: null, amountUsd: 20, clientOpId: "c1" });

  const log: string[] = [];
  const { deps } = payoutDeps(log, {
    payout: async () => { throw new Error("payout source not found or no longer valid"); },
  });
  const r = await drainOffline(CTX, "reconnect", deps);
  assert.equal(r.needsAttention.length, 1);
  const op = await getOperation(cap.operationId);
  assert.equal(op?.status, "needs_attention"); // parked, preserved — never dropped, never a silent cash-out
});

test("End Shift waits behind the payout (canonical close is last)", async () => {
  await seedProof();
  const proof = await provePayoutSourceOffline("expense", "EXP-1", SCOPE);
  const p = proof.ok ? proof.proof : (undefined as never);
  await capturePayoutOffline({ scope: SCOPE, shiftId: "SRV-SHIFT", proof: p, amount: 20, currency: "USD", note: null, amountUsd: 20, clientOpId: "c1" });
  await captureEndShiftOffline({ scope: SCOPE, shiftId: "SRV-SHIFT", shiftLocal: null, actualCashCounted: 80, notes: null });

  const log: string[] = [];
  const { deps } = payoutDeps(log);
  await drainOffline(CTX, "reconnect", deps);
  assert.equal(log[log.length - 1], "end");
  assert.ok(log.indexOf("payout") < log.indexOf("end"));
});

test("withdraw: an unsynced local payout is reversible (excluded from drawer); a sent one is refused", async () => {
  await seedProof();
  const proof = await provePayoutSourceOffline("expense", "EXP-1", SCOPE);
  const p = proof.ok ? proof.proof : (undefined as never);
  const cap = await capturePayoutOffline({ scope: SCOPE, shiftId: "SRV-SHIFT", proof: p, amount: 20, currency: "USD", note: null, amountUsd: 20, clientOpId: "c1" });

  assert.equal((await listLocalPayouts(SCOPE)).length, 1);
  const w = await withdrawLocalPayout(cap.operationId, SCOPE);
  assert.equal(w.ok, true);
  const op = await getOperation(cap.operationId);
  assert.equal(op?.status, "cancelled");

  // The cancelled payout no longer affects the drawer.
  const ops = await localdb.operations.toArray();
  const { movements } = extractDrawerMovements(ops, { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1" });
  assert.equal(movements.length, 0);

  // A withdraw is idempotent; a SYNCED payout cannot be proven-unsent offline → refused.
  assert.equal((await withdrawLocalPayout(cap.operationId, SCOPE)).ok, true);
  const cap2 = await capturePayoutOffline({ scope: SCOPE, shiftId: "SRV-SHIFT", proof: p, amount: 5, currency: "USD", note: null, amountUsd: 5, clientOpId: "c2" });
  await localdb.operations.update(cap2.operationId, { status: "synced" });
  assert.equal((await withdrawLocalPayout(cap2.operationId, SCOPE)).ok, false);
});
