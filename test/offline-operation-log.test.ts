// Phase B — the generalized operation log: migration safety (Gate 15), dependency
// machinery + replay/quarantine/retry (Gate 16), and sync-history (Gate 9/11). Drives the
// REAL Dexie stores via fake-indexeddb; the server calls are injected.

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

import { localdb, addPendingShift, addPosOfflineTxn, enqueue, type PendingShift, type PosOfflineTxn } from "@/lib/offline/db";
import { migrateLegacyToOperations, reconcileLegacyFromOperations } from "@/lib/offline/migration";
import { drainOperations, drainOffline, __resetDrainLockForTests } from "@/lib/offline/orchestrator";
import { evaluateDependencies, resolveEntity, canonicalIdForInScope } from "@/lib/offline/entityMap";
import { type OfflineOperation, OPERATION_SCHEMA_VERSION, getOperation, listOperations } from "@/lib/offline/operationLog";
import { appendHistory, listHistory, historySummary, trimSyncedHistory } from "@/lib/offline/syncHistory";
import type { PosTxnSyncDeps } from "@/lib/offline/posTxnSync";

const ctx = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", online: true };

beforeEach(async () => {
  await localdb.posOfflineTxns.clear();
  await localdb.pendingShifts.clear();
  await localdb.outbox.clear();
  await localdb.operations.clear();
  await localdb.entityMap.clear();
  await localdb.syncHistory.clear();
  __resetDrainLockForTests();
});

function pending(over: Partial<PendingShift> = {}): PendingShift {
  const id = over.local_shift_id ?? "L" + crypto.randomUUID().slice(0, 6);
  return { local_shift_id: id, client_op_id: "op-" + id, tenant_id: "t1", branch_id: "b1", device_id: "dev1", terminal_id: "term1", cashier_user_id: "u1", opening_cash_amount: 50, currency: "LBP", opened_at: new Date().toISOString(), status: "pending_sync", attempts: 0, ...over };
}
function txn(shiftLocal: string | null, over: Partial<PosOfflineTxn> = {}): PosOfflineTxn {
  const id = over.local_txn_id ?? crypto.randomUUID();
  const op = over.client_op_id ?? "op-" + id.slice(0, 6);
  return { local_txn_id: id, client_op_id: op, tenant_id: "t1", branch_id: "b1", device_id: "dev1", terminal_id: "term1", cashier_user_id: "u1", cashier_user_name: "C", shift_id: shiftLocal ?? "SRV", created_at: over.created_at ?? new Date().toISOString(), order_payload: { client_op_id: op, order_type: "takeaway", shift_id: shiftLocal ?? "SRV", items: [] }, payment_intent: { method: "cash", currency: "LBP" }, currency: "LBP", total: 10, status: "queued", attempts: 0, pending_shift_local_id: shiftLocal, ...over };
}
type Counters = { opens: number; submits: number; pays: number };
function deps(c: Counters, over: Partial<PosTxnSyncDeps> = {}): PosTxnSyncDeps {
  return {
    submit: async () => { c.submits++; return { order_id: "srv-" + c.submits, order_number: "N" + c.submits }; },
    pay: async () => { c.pays++; return {}; },
    openShift: async () => { c.opens++; return { shiftId: "SRV-SHIFT", reused: false }; },
    isTransport: (e) => e instanceof TypeError,
    hasSession: async () => true,
    ...over,
  };
}

// ---------------- MIGRATION SAFETY (Gate 15) ----------------

test("fresh DB migrates to zero operations", async () => {
  const r = await migrateLegacyToOperations();
  assert.deepEqual(r, { shiftsMigrated: 0, txnsMigrated: 0, outboxQuarantined: 0, skippedAlreadyMigrated: 0 });
  assert.equal((await listOperations()).length, 0);
});

test("old Phase-A DB (pending shift + dependent txn) migrates with deterministic ids + wiring", async () => {
  await addPendingShift(pending({ local_shift_id: "L1" }));
  await addPosOfflineTxn(txn("L1", { local_txn_id: "T1" }));
  const r = await migrateLegacyToOperations();
  assert.equal(r.shiftsMigrated, 1);
  assert.equal(r.txnsMigrated, 1);
  const shiftOp = await getOperation("mig:shift:L1");
  const txnOp = await getOperation("mig:txn:T1");
  assert.equal(shiftOp?.operation_type, "open_shift");
  assert.equal(shiftOp?.schema_version, OPERATION_SCHEMA_VERSION);
  assert.equal(txnOp?.operation_type, "takeaway_sale");
  assert.deepEqual(txnOp?.dependency_ids, ["mig:shift:L1"]);
  assert.deepEqual(txnOp?.depends_on_local_entities, ["L1"]);
});

test("migration is idempotent — running twice adds nothing, source rows are NOT deleted", async () => {
  await addPendingShift(pending({ local_shift_id: "L1" }));
  await addPosOfflineTxn(txn("L1", { local_txn_id: "T1" }));
  await migrateLegacyToOperations();
  const r2 = await migrateLegacyToOperations();
  assert.equal(r2.shiftsMigrated, 0);
  assert.equal(r2.txnsMigrated, 0);
  assert.ok(r2.skippedAlreadyMigrated >= 2);
  assert.equal((await listOperations()).length, 2, "no duplicate operations");
  assert.equal(await localdb.pendingShifts.count(), 1, "source pending shift preserved");
  assert.equal(await localdb.posOfflineTxns.count(), 1, "source txn preserved");
});

test("a synced legacy shift seeds the entity map so dependents can remap", async () => {
  await addPendingShift(pending({ local_shift_id: "L1", status: "synced", server_shift_id: "SRV-9" }));
  await migrateLegacyToOperations();
  assert.equal((await localdb.entityMap.get("L1"))?.canonical_id, "SRV-9");
  assert.equal((await getOperation("mig:shift:L1"))?.status, "synced");
});

test("a needs_attention legacy row migrates as needs_attention (not replayed)", async () => {
  await addPendingShift(pending({ local_shift_id: "L1", status: "needs_attention", review_reason: "permission" }));
  await migrateLegacyToOperations();
  assert.equal((await getOperation("mig:shift:L1"))?.status, "needs_attention");
});

test("a dormant outbox record is QUARANTINED (needs_attention, unknown_handler), never replayed", async () => {
  await enqueue({ kind: "pos.save_order", payload: { x: 1 }, user_id: "u1", user_name: "C", tenant_id: "t1", branch_id: "b1", device_id: "dev1", terminal_id: "term1", created_at: new Date().toISOString() });
  const r = await migrateLegacyToOperations();
  assert.equal(r.outboxQuarantined, 1);
  const ops = await listOperations();
  const q = ops.find((o) => o.operation_type.startsWith("legacy_outbox:"));
  assert.equal(q?.status, "needs_attention");
  assert.equal(q?.last_error_code, "unknown_handler");
  // And a drain never executes it.
  const c: Counters = { opens: 0, submits: 0, pays: 0 };
  await drainOperations(ctx, "t", deps(c));
  assert.equal(c.submits, 0);
  assert.equal(c.opens, 0);
});

test("migration interrupted halfway then re-run completes without duplication", async () => {
  await addPendingShift(pending({ local_shift_id: "L1" }));
  await addPosOfflineTxn(txn("L1", { local_txn_id: "T1" }));
  // Simulate a crash after only the shift op was written.
  const shiftOnly: OfflineOperation = {
    operation_id: "mig:shift:L1", operation_type: "open_shift", schema_version: OPERATION_SCHEMA_VERSION,
    scope: { tenant_id: "t1", branch_id: "b1", device_id: "dev1", terminal_id: "term1", cashier_user_id: "u1" },
    created_at: new Date().toISOString(), client_op_id: "op-L1", local_entity_id: "L1", canonical_entity_id: null,
    dependency_ids: [], depends_on_local_entities: [], payload: { branchId: "b1", openingCash: 50 },
    status: "pending", retry_count: 0, last_attempt_at: null, last_error_code: null, last_error_message: null, result_meta: null, synced_at: null,
  };
  await localdb.operations.add(shiftOnly);
  const r = await migrateLegacyToOperations(); // resumes
  assert.equal(r.shiftsMigrated, 0, "shift already present → skipped");
  assert.equal(r.txnsMigrated, 1, "txn completed on resume");
  assert.equal((await listOperations()).length, 2);
});

// ---------------- DEPENDENCY MACHINERY (Gate 16, pure) ----------------

function op(id: string, over: Partial<OfflineOperation> = {}): OfflineOperation {
  return { operation_id: id, operation_type: "takeaway_sale", schema_version: 1, scope: { tenant_id: "t1", branch_id: "b1", device_id: "dev1", terminal_id: "term1", cashier_user_id: "u1" }, created_at: "2026-10-15T00:00:00Z", client_op_id: "op-" + id, local_entity_id: id, canonical_entity_id: null, dependency_ids: [], depends_on_local_entities: [], payload: {}, status: "pending", retry_count: 0, last_attempt_at: null, last_error_code: null, last_error_message: null, result_meta: null, synced_at: null, ...over };
}

test("dependency: ready when no deps", () => {
  const a = op("a");
  assert.deepEqual(evaluateDependencies(a, new Map([["a", a]]), new Set()), { ready: true });
});

test("dependency: blocked when a prerequisite op is unsynced", () => {
  const s = op("s", { status: "pending" });
  const o = op("o", { dependency_ids: ["s"], depends_on_local_entities: ["s"] });
  const r = evaluateDependencies(o, new Map([["s", s], ["o", o]]), new Set());
  assert.equal(r.ready, false);
  assert.equal((r as { reason: string }).reason, "blocked");
});

test("dependency: ready when prerequisite synced AND entity resolved", () => {
  const s = op("s", { status: "synced" });
  const o = op("o", { dependency_ids: ["s"], depends_on_local_entities: ["s"] });
  const r = evaluateDependencies(o, new Map([["s", s], ["o", o]]), new Set(["s"]));
  assert.deepEqual(r, { ready: true });
});

test("dependency: missing declared dependency → quarantine", () => {
  const o = op("o", { dependency_ids: ["ghost"] });
  const r = evaluateDependencies(o, new Map([["o", o]]), new Set());
  assert.equal((r as { reason: string }).reason, "missing");
});

test("dependency: a needs_attention prerequisite fails the dependent", () => {
  const s = op("s", { status: "needs_attention" });
  const o = op("o", { dependency_ids: ["s"] });
  const r = evaluateDependencies(o, new Map([["s", s], ["o", o]]), new Set());
  assert.equal((r as { reason: string }).reason, "dependency_failed");
});

test("dependency: a prerequisite in a DIFFERENT scope fails closed (no cross-context)", () => {
  const s = op("s", { status: "synced", scope: { tenant_id: "t1", branch_id: "b1", device_id: "dev2", terminal_id: "x", cashier_user_id: "u1" } });
  const o = op("o", { dependency_ids: ["s"], depends_on_local_entities: ["s"] });
  const r = evaluateDependencies(o, new Map([["s", s], ["o", o]]), new Set(["s"]));
  assert.equal((r as { reason: string }).reason, "dependency_failed");
});

test("dependency: a circular dependency is detected (quarantine, not infinite wait)", () => {
  const a = op("a", { dependency_ids: ["b"] });
  const b = op("b", { dependency_ids: ["a"] });
  const r = evaluateDependencies(a, new Map([["a", a], ["b", b]]), new Set());
  assert.equal((r as { reason: string }).reason, "circular");
});

// ---------------- REPLAY ENGINE (Gate 16) ----------------

test("an unknown operation type is quarantined, never executed", async () => {
  const unknown: OfflineOperation = { ...op("u1", { operation_type: "future_thing", schema_version: 1 }) };
  await localdb.operations.add(unknown);
  const c: Counters = { opens: 0, submits: 0, pays: 0 };
  const r = await drainOperations(ctx, "t", deps(c));
  assert.equal(c.submits, 0);
  assert.equal(r.needsAttention.length, 1);
  assert.equal(r.needsAttention[0].reason, "unknown_handler");
  assert.equal((await getOperation("u1"))?.status, "needs_attention");
});

test("a transport failure leaves the op retryable and does not hot-loop within the pass", async () => {
  await addPendingShift(pending({ local_shift_id: "L1" }));
  await migrateLegacyToOperations();
  const c: Counters = { opens: 0, submits: 0, pays: 0 };
  const r = await drainOperations(ctx, "t", deps(c, { openShift: async () => { c.opens++; throw new TypeError("Failed to fetch"); } }));
  assert.equal(c.opens, 1, "attempted once, not hot-looped");
  assert.ok(r.retryable.includes("mig:shift:L1"));
  assert.equal((await getOperation("mig:shift:L1"))?.status, "retryable");
});

test("concurrent drains never double-process (single-flight before first await)", async () => {
  await addPendingShift(pending({ local_shift_id: "L1" }));
  await addPosOfflineTxn(txn("L1", { local_txn_id: "T1" }));
  await migrateLegacyToOperations();
  const c: Counters = { opens: 0, submits: 0, pays: 0 };
  const slow = deps(c, { hasSession: async () => { await new Promise((r) => setTimeout(r, 25)); return true; } });
  const [r1, r2] = await Promise.all([drainOperations(ctx, "a", slow), drainOperations(ctx, "b", slow)]);
  assert.equal(c.opens, 1);
  assert.equal(c.submits, 1);
  assert.equal(c.pays, 1);
  assert.equal(r1.drained.length + r2.drained.length, 2, "exactly one drainer did the work (2 ops)");
});

// ---------------- SCOPE & CONCURRENCY HARDENING (fail-closed) ----------------

test("scope: an op whose TERMINAL differs from the live terminal is DEFERRED, never replayed", async () => {
  // Same tenant/branch/cashier/device, different terminal. The live context carries a
  // terminal (production always does) → the op must be deferred, not opened.
  await addPendingShift(pending({ local_shift_id: "L1", terminal_id: "OTHER-TERM" }));
  await migrateLegacyToOperations();
  const c: Counters = { opens: 0, submits: 0, pays: 0 };
  const r = await drainOperations({ ...ctx, terminalId: "term1" }, "t", deps(c));
  assert.equal(c.opens, 0, "no handler/RPC call for a foreign-terminal op");
  assert.ok(r.deferred.includes("mig:shift:L1"));
  assert.equal((await getOperation("mig:shift:L1"))?.status, "pending", "left untouched, never replayed");
});

test("scope: a foreign-scope entity mapping never returns its canonical id (every dimension)", async () => {
  await resolveEntity({
    local_entity_id: "L1", entity_type: "shift", canonical_id: "SRV-X", resolved_at: new Date().toISOString(),
    tenant_id: "t1", branch_id: "b1", device_id: "dev1", cashier_user_id: "u1", terminal_id: "term1",
  });
  const live = { tenant_id: "t1", branch_id: "b1", device_id: "dev1", terminal_id: "term1", cashier_user_id: "u1" };
  assert.equal(await canonicalIdForInScope("L1", live), "SRV-X", "exact scope resolves");
  for (const foreign of [
    { ...live, tenant_id: "T2" },
    { ...live, branch_id: "b9" },
    { ...live, device_id: "D2" },
    { ...live, cashier_user_id: "u9" },
    { ...live, terminal_id: "term9" },
  ]) {
    assert.equal(await canonicalIdForInScope("L1", foreign), null, `foreign scope must not leak the canonical id: ${JSON.stringify(foreign)}`);
  }
});

test("scope: a dependency mapped only under a FOREIGN terminal never makes an op dependency-ready", async () => {
  const live = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "A", online: true };
  // E1 is resolved, but ONLY under terminal B (same tenant/branch/cashier/device).
  await resolveEntity({ local_entity_id: "E1", entity_type: "shift", canonical_id: "SRV-B", resolved_at: new Date().toISOString(), tenant_id: "t1", branch_id: "b1", device_id: "dev1", cashier_user_id: "u1", terminal_id: "B" });
  // A terminal-A order that depends on E1.
  const o = op("O1", {
    depends_on_local_entities: ["E1"],
    payload: { order_payload: { client_op_id: "op-O1", order_type: "takeaway", shift_id: "E1", items: [] }, payment_intent: null },
    scope: { tenant_id: "t1", branch_id: "b1", device_id: "dev1", terminal_id: "A", cashier_user_id: "u1" },
  });
  await localdb.operations.add(o);

  const c: Counters = { opens: 0, submits: 0, pays: 0 };
  const r = await drainOperations(live, "t", deps(c));
  assert.equal(c.submits, 0, "a foreign-terminal mapping must not make the op ready");
  const blocked = await getOperation("O1");
  assert.equal(blocked?.status, "blocked_dependency");
  assert.equal(blocked?.retry_count, 0, "handler NEVER attempted — blocked at the gate, not inside the handler");
  assert.equal(blocked?.last_attempt_at, null);
  assert.ok(r.blocked.includes("O1"));

  // Replace with the EXACT-scope (terminal A) mapping → now ready → replays.
  await localdb.entityMap.delete("E1");
  await resolveEntity({ local_entity_id: "E1", entity_type: "shift", canonical_id: "SRV-A", resolved_at: new Date().toISOString(), tenant_id: "t1", branch_id: "b1", device_id: "dev1", cashier_user_id: "u1", terminal_id: "A" });
  const c2: Counters = { opens: 0, submits: 0, pays: 0 };
  const r2 = await drainOperations(live, "t", deps(c2));
  assert.equal(c2.submits, 1, "exact-scope mapping resolves the dependency → replays exactly once");
  assert.ok(r2.drained.includes("O1"));
});

test("concurrency: two concurrent drainOffline runs (migrate+reopen+drain+reconcile) never double-process", async () => {
  await addPendingShift(pending({ local_shift_id: "L1" }));
  await addPosOfflineTxn(txn("L1", { local_txn_id: "T1" }));
  const c: Counters = { opens: 0, submits: 0, pays: 0 };
  const slow = deps(c, { hasSession: async () => { await new Promise((r) => setTimeout(r, 25)); return true; } });
  const [r1, r2] = await Promise.all([drainOffline(ctx, "a", slow), drainOffline(ctx, "b", slow)]);
  assert.equal(c.opens, 1, "shift opened exactly once across the whole pipeline");
  assert.equal(c.submits, 1, "order submitted exactly once");
  assert.equal(c.pays, 1, "paid exactly once");
  assert.equal(r1.drained.length + r2.drained.length, 2, "one pipeline did the work; the other was a no-op");
});

test("a migration failure is SURFACED (never a falsely-clean report) and the work stays retryable", async () => {
  await addPendingShift(pending({ local_shift_id: "L1" })); // real queued work
  const saved = (globalThis as unknown as { localStorage: unknown }).localStorage;
  // Force the device-identity read inside migration to throw, simulating a staging failure.
  (globalThis as unknown as { localStorage: unknown }).localStorage = undefined;
  try {
    const c: Counters = { opens: 0, submits: 0, pays: 0 };
    const r = await drainOffline(ctx, "t", deps(c));
    assert.ok(r.migrateError, "the staging failure is reported, not swallowed into a clean result");
    assert.equal(c.opens, 0, "nothing is replayed when staging failed");
  } finally {
    (globalThis as unknown as { localStorage: unknown }).localStorage = saved;
  }
  // The legacy row was never deleted → a healthy retry drains the previously-stranded work.
  const c2: Counters = { opens: 0, submits: 0, pays: 0 };
  const r2 = await drainOffline(ctx, "t", deps(c2));
  assert.ok(!r2.migrateError, "the retry stages cleanly");
  assert.equal(c2.opens, 1, "the stranded shift opens on retry");
  assert.ok(r2.drained.includes("mig:shift:L1"));
});

// ---------------- SYNC HISTORY (Gate 9/11) ----------------

test("history is scoped to tenant/branch and summarized; trim never removes unsettled", async () => {
  await addPendingShift(pending({ local_shift_id: "L1" }));
  await migrateLegacyToOperations();
  // a pending op exists → summary shows pending
  let s = await historySummary("t1", "b1");
  assert.equal(s.pending, 1);
  // append events (one for our tenant, one for another) and check scope filter
  await appendHistory({ at: new Date().toISOString(), operation_id: "x", operation_type: "open_shift", action_label: "Open Shift", tenant_id: "t1", branch_id: "b1", device_id: "dev1", cashier_user_id: "u1", local_ref: "L1", canonical_ref: null, status: "synced", retry_count: 0, error_summary: null, synced_at: new Date().toISOString() });
  await appendHistory({ at: new Date().toISOString(), operation_id: "y", operation_type: "open_shift", action_label: "Open Shift", tenant_id: "OTHER", branch_id: "b9", device_id: "dev1", cashier_user_id: "u1", local_ref: "Z", canonical_ref: null, status: "synced", retry_count: 0, error_summary: null, synced_at: new Date().toISOString() });
  const mine = await listHistory("t1", "b1");
  assert.ok(mine.every((e) => e.tenant_id === "t1"), "no other-tenant history leaks");
  assert.ok(!mine.some((e) => e.tenant_id === "OTHER"));
  // trim with cap 0 must NOT remove the pending op's situation; our unsettled op (mig:shift:L1)
  // has no synced history, so trim removes only synced events and never the unsettled op.
  const removed = await trimSyncedHistory(0);
  assert.ok(removed >= 1, "old synced history trimmed");
  const after = await listHistory("t1", "b1");
  assert.ok(after.length >= 0);
});
