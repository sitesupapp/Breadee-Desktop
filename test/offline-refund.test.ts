// Phase D — offline refund/void ENGINE contract (the void_refund operation through the ONE
// Phase-B orchestrator + its pos_void_order dep). Proves: exactly-once replay; the refundable
// -amount guard is threaded (expected_refund_usd on refund, NULL on cancel); a duplicate replay
// of OUR op settles idempotently; a balance/version/already-settled drift becomes needs_attention
// (never a silent second refund); transport stays retryable. Uses the REAL Dexie stores
// (fake-indexeddb) and fake deps — no network.

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
import { addOperation, getOperation, OPERATION_SCHEMA_VERSION } from "@/lib/offline/operationLog";
import type { OfflineOperation } from "@/lib/offline/operationLog";
import { drainOffline, __resetDrainLockForTests } from "@/lib/offline/orchestrator";
import type { PosTxnSyncDeps } from "@/lib/offline/posTxnSync";
import {
  cacheRefundProof, proveOfflineReversible, captureOfflineRefund,
  evaluateRefundOfflineReady, findRefundOp, refundableUsdOf, hydrationProofDecision,
  applyProofRow, type RefundScope, type ProofSourceRow,
} from "@/lib/offline/refundOffline";
import { readPaidOrderProof } from "@/lib/offline/db";

const proofRow = (over: Partial<ProofSourceRow> = {}): ProofSourceRow => ({
  id: "SRV-ORDER", order_number: "A-1", shift_id: "sh1", pos_entity_version: 4,
  payment_status: "paid", status: "completed", total_amount: 90000, total_amount_usd: 0.5,
  primary_currency_snapshot: "LBP", usd_to_lbp_rate_snapshot: 90000, ...over,
});

const RSCOPE: RefundScope = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1" };
const paidOrder = (over: Record<string, unknown> = {}) => ({
  order_id: "SRV-ORDER", order_number: "A-1", shift_id: "sh1", pos_entity_version: 4,
  payment_status: "paid", status: "completed", refundable_usd: 0.5, currency: "LBP", ...over,
});

const SCOPE = { tenant_id: "t1", branch_id: "b1", device_id: "dev1", terminal_id: "term1", cashier_user_id: "u1" };
const CTX = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1", online: true };

type VoidCall = {
  orderId: string; reason: string; refund: boolean;
  clientOpId: string; expectedVersion: number | null; expectedRefundUsd: number | null;
};

function deps(onVoid: (a: VoidCall) => Promise<ReturnType<PosTxnSyncDeps["voidRefund"]> extends Promise<infer R> ? R : never>): { deps: PosTxnSyncDeps; calls: VoidCall[] } {
  const calls: VoidCall[] = [];
  const d: PosTxnSyncDeps = {
    submit: async () => ({ order_id: "x", order_number: "y" }),
    pay: async () => ({}),
    openShift: async () => ({ shiftId: "s", reused: false }),
    openTable: async () => ({ table_id: "T", pos_entity_version: 1 }),
    submitRound: async () => ({ order_id: "O", order_number: "N", batch_no: 1, appended: true, idempotent: false }),
    voidRefund: async (a) => { calls.push(a); return onVoid(a); },
    isTransport: (e) => e instanceof TypeError,
    hasSession: async () => true,
  };
  return { deps: d, calls };
}

function voidRefundOp(over: Partial<OfflineOperation> & { payload: Record<string, unknown> }): OfflineOperation {
  return {
    operation_id: over.operation_id ?? ("op-" + Math.random().toString(36).slice(2)),
    operation_type: "void_refund",
    schema_version: OPERATION_SCHEMA_VERSION,
    scope: SCOPE,
    created_at: new Date().toISOString(),
    client_op_id: over.client_op_id ?? ("cop-" + Math.random().toString(36).slice(2)),
    local_entity_id: null,
    canonical_entity_id: null,
    dependency_ids: [],
    depends_on_local_entities: [],
    payload: over.payload,
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

const okResult = (over: Record<string, unknown> = {}) => ({
  order_id: "SRV-ORDER", status: "refunded", refunded: true, refund_usd: 0.5, refund_id: "rf1", idempotent: false, ...over,
});

beforeEach(async () => {
  await Promise.all([localdb.operations.clear(), localdb.entityMap.clear(), localdb.syncHistory.clear(), localdb.paidOrderProofs.clear()]);
  __resetDrainLockForTests();
});

test("refund success: drains once; threads client_op_id + expected_version + expected_refund_usd", async () => {
  const op = voidRefundOp({ client_op_id: "cop-1", payload: { order_id: "SRV-ORDER", reason: "spill", refund: true, expected_version: 3, expected_refund_usd: 0.5, tender: "cash" } });
  await addOperation(op);
  const { deps: d, calls } = deps(async () => okResult());
  const r = await drainOffline(CTX, "test", d);
  assert.deepEqual(r.drained, [op.operation_id]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { orderId: "SRV-ORDER", reason: "spill", refund: true, clientOpId: "cop-1", expectedVersion: 3, expectedRefundUsd: 0.5 });
  const saved = await getOperation(op.operation_id);
  assert.equal(saved?.status, "synced");
  assert.equal(saved?.result_meta?.refunded, true);
});

test("cancel (refund=false): expected_refund_usd is NOT threaded as a positive guard (null)", async () => {
  const op = voidRefundOp({ payload: { order_id: "SRV-ORDER", reason: "mistake", refund: false, expected_version: 1, expected_refund_usd: null, tender: "other" } });
  await addOperation(op);
  const { deps: d, calls } = deps(async () => okResult({ status: "voided", refunded: false, refund_usd: 0, refund_id: null }));
  const r = await drainOffline(CTX, "test", d);
  assert.deepEqual(r.drained, [op.operation_id]);
  assert.equal(calls[0].refund, false);
  assert.equal(calls[0].expectedRefundUsd, null);
});

test("duplicate replay of OUR op settles idempotently (exactly once)", async () => {
  const op = voidRefundOp({ payload: { order_id: "SRV-ORDER", reason: "x", refund: true, expected_version: 2, expected_refund_usd: 0.5, tender: "cash" } });
  await addOperation(op);
  // The server already recorded this client_op_id -> returns the original result idempotently.
  const { deps: d } = deps(async () => okResult({ idempotent: true }));
  const r = await drainOffline(CTX, "test", d);
  assert.deepEqual(r.drained, [op.operation_id]);
  const saved = await getOperation(op.operation_id);
  assert.equal(saved?.status, "synced");
  assert.equal(saved?.result_meta?.idempotent, true);
});

for (const msg of [
  'The refundable amount changed since this refund was captured offline. {"pos_error_code":"REFUND_AMOUNT_MISMATCH"}',
  'This order is no longer in a refundable paid state. {"pos_error_code":"REFUND_BALANCE_CHANGED"}',
  'This order changed since it was loaded. {"pos_error_code":"VERSION_CONFLICT"}',
  'This order is already voided. {"pos_error_code":"ALREADY_SETTLED"}',
]) {
  test(`conflict -> needs_attention (never a silent second refund): ${msg.slice(0, 40)}`, async () => {
    const op = voidRefundOp({ payload: { order_id: "SRV-ORDER", reason: "x", refund: true, expected_version: 2, expected_refund_usd: 0.5, tender: "cash" } });
    await addOperation(op);
    const { deps: d } = deps(async () => { throw new Error(msg); });
    const r = await drainOffline(CTX, "test", d);
    assert.equal(r.drained.length, 0);
    assert.equal(r.needsAttention.length, 1);
    const saved = await getOperation(op.operation_id);
    assert.equal(saved?.status, "needs_attention");
    assert.equal(saved?.last_error_code, "refund_conflict");
  });
}

test("transport failure stays retryable (never needs_attention)", async () => {
  const op = voidRefundOp({ payload: { order_id: "SRV-ORDER", reason: "x", refund: true, expected_version: 2, expected_refund_usd: 0.5, tender: "cash" } });
  await addOperation(op);
  const { deps: d } = deps(async () => { throw new TypeError("Failed to fetch"); });
  const r = await drainOffline(CTX, "test", d);
  assert.equal(r.needsAttention.length, 0);
  const saved = await getOperation(op.operation_id);
  assert.equal(saved?.status, "retryable");
});

test("scope-exact: a refund op from another terminal is NOT drained in this session", async () => {
  const op = voidRefundOp({ scope: { ...SCOPE, terminal_id: "OTHER-TERM" }, payload: { order_id: "SRV-ORDER", reason: "x", refund: true, expected_version: 2, expected_refund_usd: 0.5, tender: "cash" } });
  await addOperation(op);
  let called = 0;
  const { deps: d } = deps(async () => { called++; return okResult(); });
  const r = await drainOffline(CTX, "test", d);
  assert.equal(called, 0);
  assert.equal(r.drained.length, 0);
  const saved = await getOperation(op.operation_id);
  assert.equal(saved?.status, "pending"); // untouched — not ours to replay
});

// ---------------- Phase D capture + PROOF GATE ----------------

test("proof gate: unprovable order is BLOCKED offline (reconnect required) — rule 8", async () => {
  const r = await proveOfflineReversible("UNKNOWN-ORDER", RSCOPE);
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /reconnect/i);
});

test("proof gate: a paid hydrated order is refundable with its locally-known balance", async () => {
  await cacheRefundProof({ scope: RSCOPE, order: paidOrder() });
  const r = await proveOfflineReversible("SRV-ORDER", RSCOPE);
  assert.equal(r.ok, true);
  assert.equal((r as { action: string }).action, "refund");
  assert.equal((r as { proof: { refundable_usd: number } }).proof.refundable_usd, 0.5);
});

test("proof gate: an unpaid hydrated order is a CANCEL (no balance needed)", async () => {
  await cacheRefundProof({ scope: RSCOPE, order: paidOrder({ payment_status: "unpaid", status: "sent_to_kitchen", refundable_usd: 0 }) });
  const r = await proveOfflineReversible("SRV-ORDER", RSCOPE);
  assert.equal(r.ok, true);
  assert.equal((r as { action: string }).action, "cancel");
});

test("proof gate: a paid order with unknown ($0) balance is BLOCKED (rule 2/8)", async () => {
  await cacheRefundProof({ scope: RSCOPE, order: paidOrder({ refundable_usd: 0 }) });
  const r = await proveOfflineReversible("SRV-ORDER", RSCOPE);
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /refundable amount isn't known/i);
});

test("proof gate: a terminal (already refunded) order is blocked", async () => {
  await cacheRefundProof({ scope: RSCOPE, order: paidOrder({ status: "completed" }) });
  // Re-cache as refunded: cacheRefundProof drops the proof for a terminal status.
  await cacheRefundProof({ scope: RSCOPE, order: paidOrder({ status: "refunded" }) });
  const r = await proveOfflineReversible("SRV-ORDER", RSCOPE);
  assert.equal(r.ok, false);
});

test("proof gate: scope-exact — a proof from a sibling OU is never read", async () => {
  await cacheRefundProof({ scope: RSCOPE, order: paidOrder() });
  const r = await proveOfflineReversible("SRV-ORDER", { ...RSCOPE, branchId: "OTHER-OU" });
  assert.equal(r.ok, false); // fail-closed across OU
});

test("capture: durably enqueues a void_refund op with the proven balance + version", async () => {
  await cacheRefundProof({ scope: RSCOPE, order: paidOrder() });
  const proof = await proveOfflineReversible("SRV-ORDER", RSCOPE);
  assert.equal(proof.ok, true);
  const cap = await captureOfflineRefund({ scope: RSCOPE, proof: (proof as { proof: never }).proof, action: "refund", reason: "spill", tender: "cash" });
  assert.equal(cap.alreadyCaptured, false);
  const op = await getOperation(cap.operationId);
  assert.equal(op?.operation_type, "void_refund");
  assert.equal(op?.status, "pending");
  assert.equal(op?.client_op_id, cap.clientOpId);
  const p = op?.payload as Record<string, unknown>;
  assert.equal(p.order_id, "SRV-ORDER");
  assert.equal(p.refund, true);
  assert.equal(p.expected_version, 4);
  assert.equal(p.expected_refund_usd, 0.5);
  assert.equal(p.tender, "cash");
});

test("capture: double-tap collapses to ONE op (deterministic id, idempotent)", async () => {
  await cacheRefundProof({ scope: RSCOPE, order: paidOrder() });
  const proof = await proveOfflineReversible("SRV-ORDER", RSCOPE);
  const a = await captureOfflineRefund({ scope: RSCOPE, proof: (proof as { proof: never }).proof, action: "refund", reason: "x", tender: "cash" });
  const b = await captureOfflineRefund({ scope: RSCOPE, proof: (proof as { proof: never }).proof, action: "refund", reason: "x", tender: "cash" });
  assert.equal(a.operationId, b.operationId);
  assert.equal(b.alreadyCaptured, true);
  const count = await localdb.operations.where("operation_type").equals("void_refund").count();
  assert.equal(count, 1);
  const found = await findRefundOp("SRV-ORDER", RSCOPE);
  assert.ok(found);
});

test("capture → drain: a captured refund replays exactly once and syncs", async () => {
  await cacheRefundProof({ scope: RSCOPE, order: paidOrder() });
  const proof = await proveOfflineReversible("SRV-ORDER", RSCOPE);
  const cap = await captureOfflineRefund({ scope: RSCOPE, proof: (proof as { proof: never }).proof, action: "refund", reason: "spill", tender: "cash" });
  const calls: VoidCall[] = [];
  const { deps: d } = deps(async (a) => { calls.push(a); return okResult(); });
  // Drain uses the capture scope (tenant/branch/cashier/device/terminal) as the live session.
  const r = await drainOffline({ tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1", online: true }, "reconnect", d);
  assert.deepEqual(r.drained, [cap.operationId]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].clientOpId, cap.clientOpId);
  assert.equal(calls[0].expectedRefundUsd, 0.5);
  assert.equal(calls[0].expectedVersion, 4);
});

test("refundableUsdOf: USD basis, LBP conversion, and fail-closed on the unknowable", () => {
  // total_amount_usd wins when present + positive.
  assert.equal(refundableUsdOf({ total_amount: 90000, total_amount_usd: 1.25, primary_currency_snapshot: "LBP", usd_to_lbp_rate_snapshot: 90000 }), 1.25);
  // USD order with no usd column → the order total.
  assert.equal(refundableUsdOf({ total_amount: 7.5, total_amount_usd: null, primary_currency_snapshot: "USD", usd_to_lbp_rate_snapshot: null }), 7.5);
  // LBP order → converted by the snapshot rate.
  assert.equal(refundableUsdOf({ total_amount: 90000, total_amount_usd: null, primary_currency_snapshot: "LBP", usd_to_lbp_rate_snapshot: 90000 }), 1);
  // LBP with NO rate → unknowable → 0 (not offline-refundable).
  assert.equal(refundableUsdOf({ total_amount: 90000, total_amount_usd: null, primary_currency_snapshot: "LBP", usd_to_lbp_rate_snapshot: null }), 0);
  // A third currency with no USD snapshot → unknowable → 0.
  assert.equal(refundableUsdOf({ total_amount: 10, total_amount_usd: null, primary_currency_snapshot: "AED", usd_to_lbp_rate_snapshot: null }), 0);
  // Zero/negative totals → 0.
  assert.equal(refundableUsdOf({ total_amount: 0, total_amount_usd: 0, primary_currency_snapshot: "USD", usd_to_lbp_rate_snapshot: null }), 0);
});

test("capture: CONCURRENT double-tap (Promise.all) yields ONE op; one false/one true; no reject", async () => {
  await cacheRefundProof({ scope: RSCOPE, order: paidOrder() });
  const proof = await proveOfflineReversible("SRV-ORDER", RSCOPE);
  const p = (proof as { proof: never }).proof;
  // Promise.all rejects if EITHER capture throws; reaching the asserts proves neither rejected.
  const [a, b] = await Promise.all([
    captureOfflineRefund({ scope: RSCOPE, proof: p, action: "refund", reason: "x", tender: "cash" }),
    captureOfflineRefund({ scope: RSCOPE, proof: p, action: "refund", reason: "x", tender: "cash" }),
  ]);
  assert.equal(a.operationId, b.operationId);
  assert.equal(a.clientOpId, b.clientOpId);
  // Exactly one performed the durable write; the other saw it already captured.
  assert.deepEqual([a.alreadyCaptured, b.alreadyCaptured].sort(), [false, true]);
  const count = await localdb.operations.where("operation_type").equals("void_refund").count();
  assert.equal(count, 1); // the deterministic id collapses the race to one durable op
});

// ---------------- Fail-closed 5-dim scope exactness (null is NOT a wildcard) ----------------

test("scope exactness: a proof with a terminal is NEVER read by a scope with no terminal", async () => {
  await cacheRefundProof({ scope: RSCOPE, order: paidOrder() }); // terminal_id = "term1"
  const r = await proveOfflineReversible("SRV-ORDER", { ...RSCOPE, terminalId: null });
  assert.equal(r.ok, false); // null-vs-value → no match
  assert.equal(await readPaidOrderProof("SRV-ORDER", { ...RSCOPE, terminalId: null }), null);
});

test("scope exactness: a proof with NO terminal is NEVER read by a scope with a terminal", async () => {
  await cacheRefundProof({ scope: { ...RSCOPE, terminalId: null }, order: paidOrder() }); // terminal_id = null
  const r = await proveOfflineReversible("SRV-ORDER", RSCOPE); // terminalId "term1"
  assert.equal(r.ok, false); // value-vs-null → no match
});

test("scope exactness: cashier and device mismatches fail closed", async () => {
  await cacheRefundProof({ scope: RSCOPE, order: paidOrder() });
  assert.equal((await proveOfflineReversible("SRV-ORDER", { ...RSCOPE, cashierUserId: "OTHER" })).ok, false);
  assert.equal((await proveOfflineReversible("SRV-ORDER", { ...RSCOPE, deviceId: "OTHER" })).ok, false);
  // The exact scope still reads it.
  assert.equal((await proveOfflineReversible("SRV-ORDER", RSCOPE)).ok, true);
});

// ---------------- Eviction decision (pure; covers every hydration transition) ----------------

test("hydrationProofDecision: cache a paid refundable order; EVICT once terminal/unpaid/unknowable", () => {
  const base = { status: "completed", payment_status: "paid", total_amount: 90000, total_amount_usd: 1.0, primary_currency_snapshot: "LBP", usd_to_lbp_rate_snapshot: 90000 };
  assert.deepEqual(hydrationProofDecision(base), { evict: false, refundableUsd: 1.0 });
  assert.deepEqual(hydrationProofDecision({ ...base, status: "refunded" }), { evict: true });
  assert.deepEqual(hydrationProofDecision({ ...base, status: "voided" }), { evict: true });
  assert.deepEqual(hydrationProofDecision({ ...base, payment_status: "unpaid" }), { evict: true });
  assert.deepEqual(hydrationProofDecision({ ...base, total_amount_usd: null, usd_to_lbp_rate_snapshot: null }), { evict: true });
});

test("cacheRefundProof: re-caching a now-terminal order EVICTS the existing proof", async () => {
  await cacheRefundProof({ scope: RSCOPE, order: paidOrder() });
  assert.ok(await readPaidOrderProof("SRV-ORDER", RSCOPE));
  await cacheRefundProof({ scope: RSCOPE, order: paidOrder({ status: "refunded" }) });
  assert.equal(await readPaidOrderProof("SRV-ORDER", RSCOPE), null); // stale proof dropped
});

test("applyProofRow: an existing proof is EVICTED when the order's status becomes null/unknowable", async () => {
  // Seed a valid proof as the write-through would.
  assert.equal(await applyProofRow(RSCOPE, proofRow()), "cached");
  assert.ok(await readPaidOrderProof("SRV-ORDER", RSCOPE));
  // The same order comes back with an unknowable (null) status → MUST evict, not survive.
  assert.equal(await applyProofRow(RSCOPE, proofRow({ status: null })), "evicted");
  assert.equal(await readPaidOrderProof("SRV-ORDER", RSCOPE), null);
});

test("applyProofRow: evicts on terminal / unpaid / unknowable-USD; caches a paid refundable order", async () => {
  assert.equal(await applyProofRow(RSCOPE, proofRow()), "cached");
  assert.equal(await applyProofRow(RSCOPE, proofRow({ status: "refunded" })), "evicted");
  assert.equal(await readPaidOrderProof("SRV-ORDER", RSCOPE), null);
  assert.equal(await applyProofRow(RSCOPE, proofRow({ payment_status: "unpaid" })), "evicted");
  assert.equal(await applyProofRow(RSCOPE, proofRow({ total_amount_usd: null, usd_to_lbp_rate_snapshot: null })), "evicted");
});

test("evaluateRefundOfflineReady: online allowed; offline+proof-ok allowed; unprovable blocked", async () => {
  assert.deepEqual(evaluateRefundOfflineReady({ online: true, offlineReady: false, proof: null }), { allowed: true, reason: null });
  assert.equal(evaluateRefundOfflineReady({ online: false, offlineReady: false, proof: null }).allowed, false);
  assert.equal(evaluateRefundOfflineReady({ online: false, offlineReady: true, proof: null }).allowed, false);
  assert.equal(evaluateRefundOfflineReady({ online: false, offlineReady: true, proof: { ok: true, proof: paidOrder() as never, action: "refund" } }).allowed, true);
  const blocked = evaluateRefundOfflineReady({ online: false, offlineReady: true, proof: { ok: false, reason: "Reconnect to refund it." } });
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason!, /reconnect/i);
});
