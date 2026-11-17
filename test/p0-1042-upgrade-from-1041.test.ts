// 1.0.42 — a 1.0.41 terminal's EXISTING local queue after the in-place update (same IndexedDB, no schema change).
// The ops below are written exactly as 1.0.41 captured them (no version_unknown flag; expected_version = the
// placeholder 0; a takeaway with a cash intent + an on-account behind it). Production now exposes the real
// table version (S-TABLEMAP_01, ledger 863). Real Dexie + the real orchestrator / rebase / Force sync. Synthetic only.

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
import { getOperation, OPERATION_SCHEMA_VERSION, type OfflineOperation } from "@/lib/offline/operationLog";
import { drainOffline, __resetDrainLockForTests } from "@/lib/offline/orchestrator";
import type { PosTxnSyncDeps } from "@/lib/offline/posTxnSync";
import { rebaseRefusedOpen } from "@/lib/offline/openRebase";
import { forceSync } from "@/lib/offline/syncActions";
import { parseTableMap } from "@/lib/pos/tables";
import { getDeviceIdentity } from "@/lib/device";
import { useShift, shiftNet } from "@/state/shift";
import { clearPosSessionSnapshot } from "@/lib/offline/posSession";
import type { ActiveShift } from "@/types/pos";

const DEV = getDeviceIdentity();
const SC = { tenant_id: "t1", branch_id: "b1", device_id: DEV.device_id, terminal_id: DEV.terminal_id ?? "", cashier_user_id: "u1" };
const CTX = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: DEV.device_id, terminalId: DEV.terminal_id ?? null, online: true };
const SHIFT: ActiveShift = { id: "SRV-SHIFT", status: "open", opened_at: new Date(Date.now() - 3_600_000).toISOString(), opening_cash_amount: 0, branch_id: "b1" } as ActiveShift;
const VERSION_CONFLICT = "This table changed since it was loaded. Reload the table map and retry.";

beforeEach(async () => {
  await Promise.all([localdb.operations.clear(), localdb.entityMap.clear(), localdb.syncHistory.clear(), localdb.dineDrafts.clear(), localdb.posOfflineTxns.clear(), localdb.pendingShifts.clear()]);
  __resetDrainLockForTests();
  clearPosSessionSnapshot();
  useShift.getState().clear();
  useShift.setState({ shift: SHIFT, pendingLocalId: null, loading: false });
  shiftNet.findOpenShift = async () => SHIFT;
  shiftNet.reachable = async () => true;
});

const op = (id: string, over: Partial<OfflineOperation>): OfflineOperation => ({
  operation_id: id, operation_type: "dinein_open_table", schema_version: OPERATION_SCHEMA_VERSION, scope: SC,
  created_at: new Date(Date.now() - 600_000).toISOString(), client_op_id: `11111111-1111-4111-8111-${id.padStart(12, "0").slice(-12)}`,
  local_entity_id: "TBL-A", canonical_entity_id: null, dependency_ids: [], depends_on_local_entities: [],
  payload: { name: "alpha", seats: 4, expected_version: 0 }, // ← exactly the 1.0.41 capture (placeholder 0, no flag)
  status: "pending", retry_count: 0, last_attempt_at: null, last_error_code: null, last_error_message: null, result_meta: null, synced_at: null,
  ...over,
}) as OfflineOperation;

/** Production AFTER S-TABLEMAP_01: the map carries the real version (24); the open CAS is pos_open_table_core's. */
const liveRow = parseTableMap({ tables: [{ id: "TBL-A", name: "alpha", seats: 4, occupied: false, status: "available", canonical: true, configured: true, sort_order: 1, orders: 0, order_number: null, opened_at: null, total: null, currency: null, mixed_currency: false, merged_sources: [], pos_entity_version: 24 }] }).tables[0];
function prod(calls: string[]): PosTxnSyncDeps {
  let v = 24;
  return {
    openTable: async (p: { expected_version?: number | null }) => { calls.push(`open:${p.expected_version ?? "null"}`); if (p.expected_version != null && p.expected_version !== v) throw Object.assign(new Error(VERSION_CONFLICT), { code: "P0001" }); v++; return { table_id: "TBL-A", pos_entity_version: v }; },
    submitRound: async () => { calls.push("round"); return { order_id: "ORD", order_number: "N", batch_no: 1, appended: false, idempotent: false }; },
    payTable: async () => { calls.push("pay_table"); return { ok: true, amount: 1, idempotent: false, pos_entity_version: v + 1 }; },
    submit: async () => { calls.push("submit"); return { order_id: "SRV-ORD-2", order_number: "0002" }; },
    pay: async () => { calls.push("pay"); return {}; },
    onAccountOrder: async () => { calls.push("on_account"); throw Object.assign(new Error("This order is already fully paid"), { code: "P0001" }); },
    tableGuard: { readTable: async () => liveRow, hasReceipt: async () => false },
    isTransport: (e: unknown) => e instanceof TypeError,
    hasSession: async () => true,
  } as unknown as PosTxnSyncDeps;
}
const rebase = { readTable: async () => liveRow, hasReceipt: async () => false, salesSince: async () => [] };

test("U1 a PENDING 1.0.41 open (expected 0) is still refused once, then the operator Retry re-arms it with the REAL version (24) and it syncs once", async () => {
  await localdb.operations.add(op("1", {}));
  const calls: string[] = [];
  await drainOffline(CTX, "reconnect", prod(calls));
  assert.deepEqual(calls, ["open:0"], "1.0.42 never rewrites a 1.0.41 capture by itself");
  assert.equal((await getOperation("1"))!.last_error_code, "version_conflict");
  const r = await rebaseRefusedOpen("1", rebase, "u1", { drain: false });
  assert.deepEqual(r, { kind: "rebased", fromVersion: 0, toVersion: 24 }, "Production now reports the real version");
  __resetDrainLockForTests();
  await drainOffline(CTX, "operator-retry", prod(calls));
  assert.deepEqual(calls, ["open:0", "open:24"]);
  assert.equal((await getOperation("1"))!.status, "synced");
});

test("U2 a 1.0.41 PARKED open + its parked payment: Force sync re-checks the open (rebase) and releases the payment behind it — each sent once", async () => {
  await localdb.operations.add(op("1", { status: "needs_attention", retry_count: 1, last_attempt_at: new Date().toISOString(), last_error_code: "version_conflict", last_error_message: VERSION_CONFLICT }));
  await localdb.operations.add(op("2", { operation_type: "pay_table", dependency_ids: ["1"], payload: { table_id: "TBL-A", table_local: null, method: "cash", currency: "USD" }, status: "needs_attention", last_error_code: "dependency_failed", last_error_message: "1", created_at: new Date(Date.now() - 300_000).toISOString() }));
  const calls: string[] = [];
  const r = await forceSync({ tenantId: "t1", branchId: "b1" }, "u1", {
    hasReceipt: async () => false, rebaseDeps: rebase, drain: async () => { await drainOffline(CTX, "force", prod(calls)); return 1; },
    listParked: async () => localdb.operations.where("status").equals("needs_attention").toArray(), getOp: getOperation,
    requeue: async (id) => { const { requeueOperation } = await import("@/lib/offline/operationLog"); return requeueOperation(id, { drain: false }); }, health: () => "online",
  });
  assert.deepEqual(r.rebased, ["1"]);
  assert.deepEqual(r.dependencyRecovered, ["2"]);
  assert.deepEqual(calls, ["open:24", "pay_table"], "the open uses the real version; the cash is booked exactly once");
  assert.equal((await getOperation("2"))!.status, "synced");
});

test("U3 a 1.0.41 on-account behind a cash-paid takeaway (already refused 'fully paid'): 1.0.42 never re-sends it; it stays for review", async () => {
  await localdb.operations.add(op("10", { operation_type: "takeaway_sale", local_entity_id: "LTX", payload: { order_payload: { items: [] }, payment_intent: { method: "cash", currency: "USD" }, paid: true }, status: "synced", canonical_entity_id: "SRV-ORD-2", result_meta: { order_number: "0002", paid: true }, synced_at: new Date().toISOString() }));
  await localdb.operations.add(op("11", { operation_type: "on_account_order", dependency_ids: ["10"], local_entity_id: null, payload: { order_id: null, order_local: "LTX", customer_id: "C1", amount: 15, method: "on_account" }, status: "needs_attention", retry_count: 16, last_error_code: "conflict", last_error_message: "This order is already fully paid" }));
  const calls: string[] = [];
  const r = await forceSync({ tenantId: "t1", branchId: "b1" }, "u1", {
    hasReceipt: async () => false, rebaseDeps: rebase, drain: async () => 1, listParked: async () => localdb.operations.where("status").equals("needs_attention").toArray(), getOp: getOperation,
    requeue: async () => { calls.push("requeue"); return true; }, health: () => "online",
  });
  assert.deepEqual(r.leftForReview, ["11"]);
  assert.equal(calls.length, 0, "never re-queued, never re-sent");
  assert.equal((await getOperation("11"))!.status, "needs_attention");
});
