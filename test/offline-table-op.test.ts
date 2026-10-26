// Phase E — offline dine-in TABLE RESTRUCTURE (move / merge of canonical tables).
//
// 1.0.38 (Bugs 5/6) — INTENTIONAL CHANGE: the rc.4–rc.11 schema-1 capture / replay this file pinned
// (op id from the table pair only, no barrier, no projection, a floor-map CAS, pos_move_table /
// pos_merge_tables_v3 straight from the floor) is RETIRED. Its ops are quarantined: no handler is
// registered for schema 1, so a parked legacy op can never be replayed (no RPC), even on an operator
// retry. The offline-safe schema-2 path (pos_move_table_v2 / pos_merge_tables_v4) is covered end-to-end in
// test/offline-1038-movemerge.test.ts. The gate policy below is unchanged.

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
import { getOperation, requeueOperation, type OfflineOperation } from "@/lib/offline/operationLog";
import { drainOffline, __resetDrainLockForTests } from "@/lib/offline/orchestrator";
import { handlerFor } from "@/lib/offline/handlers";
import type { PosTxnSyncDeps } from "@/lib/offline/posTxnSync";
import { evaluateTableOpOfflineReady } from "@/lib/offline/tableOpOffline";
import { tableOpGate } from "@/lib/pos/tableOps";

const OPSCOPE = { tenant_id: "t1", branch_id: "b1", device_id: "dev1", terminal_id: "term1", cashier_user_id: "u1" };
const CTX = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1", online: true };

function deps(calls: string[]): Partial<PosTxnSyncDeps> {
  return {
    moveTableV2: async () => { calls.push("move_v2"); return { ok: true, orders_moved: 1, order_ids: [], table_versions: {}, idempotent: false }; },
    mergeTablesV4: async () => { calls.push("merge_v4"); return { ok: true, merge_id: "M1", primary_order_id: "O", sources_merged: 1, pos_entity_version: 1, table_versions: {}, idempotent: false }; },
    isTransport: (e) => e instanceof TypeError,
    hasSession: async () => true,
  };
}

function legacy(over: Partial<OfflineOperation> & Pick<OfflineOperation, "operation_id" | "operation_type">): OfflineOperation {
  return { schema_version: 1, scope: OPSCOPE, created_at: new Date().toISOString(), client_op_id: crypto.randomUUID(), local_entity_id: null, canonical_entity_id: null, dependency_ids: [], depends_on_local_entities: [], payload: {}, status: "pending", retry_count: 0, last_attempt_at: null, last_error_code: null, last_error_message: null, result_meta: null, synced_at: null, ...over } as OfflineOperation;
}

beforeEach(async () => {
  await Promise.all([localdb.operations.clear(), localdb.entityMap.clear(), localdb.syncHistory.clear()]);
  __resetDrainLockForTests();
});

test("gate: offline move/merge allowed only when offline-ready + scope; online always", () => {
  assert.equal(evaluateTableOpOfflineReady({ online: true, offlineReady: false, hasScope: false }), true);
  assert.equal(evaluateTableOpOfflineReady({ online: false, offlineReady: false, hasScope: true }), false);
  assert.equal(evaluateTableOpOfflineReady({ online: false, offlineReady: true, hasScope: false }), false);
  assert.equal(evaluateTableOpOfflineReady({ online: false, offlineReady: true, hasScope: true }), true);
});

test("tableOpGate policy: offlineCapable unwalls move/merge offline but NOT close/clear", () => {
  const allow = { allowed: true as const, reason: null };
  const tbl = { id: "T1", name: "1", orders: 1, status: "occupied", pos_entity_version: 2 } as never;
  const base = { permitted: allow, table: tbl, hasOpenShift: true, online: false, offlineCapable: true };
  assert.equal(tableOpGate({ kind: "move", ...base }).allowed, true);
  assert.equal(tableOpGate({ kind: "merge", ...base }).allowed, true);
  // Close/Clear stay walled offline even with offlineCapable.
  assert.equal(tableOpGate({ kind: "close", ...base }).allowed, false);
  assert.equal(tableOpGate({ kind: "clear", ...base }).allowed, false);
  // Without offlineCapable, even move is walled offline (base gate unchanged).
  assert.equal(tableOpGate({ kind: "move", ...base, offlineCapable: false }).allowed, false);
});

test("1.0.38: schema-1 move/merge have NO handler — only the schema-2 offline-safe replay is registered", () => {
  assert.equal(handlerFor("move_table", 1), undefined);
  assert.equal(handlerFor("merge_tables", 1), undefined);
  assert.ok(handlerFor("move_table", 2));
  assert.ok(handlerFor("merge_tables", 2));
});

test("1.0.38: a pending legacy (schema 1) move / merge is QUARANTINED at drain — never replayed (no RPC)", async () => {
  await localdb.operations.bulkAdd([
    legacy({ operation_id: "movetable:legacy", operation_type: "move_table", payload: { from_table_id: "T-A", to_table_id: "T-B", expected_version: 5 } }),
    legacy({ operation_id: "mergetables:legacy", operation_type: "merge_tables", payload: { primary_table_id: "T-P", source_table_ids: ["T-S1"], expected: {} } }),
  ]);
  const calls: string[] = [];
  const r = await drainOffline(CTX, "reconnect", deps(calls));
  assert.deepEqual(calls, []);
  assert.equal(r.needsAttention.length, 2);
  for (const id of ["movetable:legacy", "mergetables:legacy"]) {
    const o = await getOperation(id);
    assert.equal(o?.status, "needs_attention");
    assert.equal(o?.last_error_code, "unknown_handler");
  }
});

test("1.0.38: an operator RETRY of a parked legacy move re-quarantines it — still no RPC", async () => {
  await localdb.operations.add(legacy({ operation_id: "movetable:old", operation_type: "move_table", status: "needs_attention", last_error_code: "move_conflict", last_error_message: "The destination table already has an open order", payload: { from_table_id: "T-A", to_table_id: "T-B", expected_version: 5 } }));
  assert.equal(await requeueOperation("movetable:old"), true);
  const calls: string[] = [];
  await drainOffline(CTX, "operator-retry", deps(calls));
  assert.deepEqual(calls, []);
  assert.equal((await getOperation("movetable:old"))?.last_error_code, "unknown_handler");
});
