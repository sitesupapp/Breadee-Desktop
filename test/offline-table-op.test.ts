// Phase E — offline dine-in TABLE RESTRUCTURE (move / merge of canonical tables): capture a durable
// op, replay exactly-once with the CAS, and surface a floor/version drift as needs_attention (never
// a silent destructive move/merge).

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
import { captureMoveTableOffline, captureMergeTablesOffline, evaluateTableOpOfflineReady, type TableOpScope } from "@/lib/offline/tableOpOffline";
import { tableOpGate } from "@/lib/pos/tableOps";

const SCOPE: TableOpScope = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1" };
const CTX = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1", online: true };

function deps(log: string[], over: Partial<PosTxnSyncDeps> = {}): { deps: Partial<PosTxnSyncDeps>; moves: Record<string, unknown>[]; merges: Record<string, unknown>[] } {
  const moves: Record<string, unknown>[] = [];
  const merges: Record<string, unknown>[] = [];
  const d: Partial<PosTxnSyncDeps> = {
    moveTable: async (a) => { log.push("move"); moves.push(a); return { ok: true, orders_moved: 1, idempotent: false }; },
    mergeTables: async (a) => { log.push("merge"); merges.push(a); return { ok: true, merge_id: "M1", sources_merged: a.sourceTableIds.length, idempotent: false }; },
    isTransport: (e) => e instanceof TypeError,
    hasSession: async () => true,
    ...over,
  };
  return { deps: d, moves, merges };
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

test("move: capture (idempotent) → drain → pos_move_table with client_op_id + CAS, once", async () => {
  const a = await captureMoveTableOffline({ scope: SCOPE, fromTableId: "T-A", toTableId: "T-B", expectedVersion: 5 });
  const b = await captureMoveTableOffline({ scope: SCOPE, fromTableId: "T-A", toTableId: "T-B", expectedVersion: 5 });
  assert.equal(b.alreadyCaptured, true); // deterministic from the from/to pair
  assert.equal(b.clientOpId, a.clientOpId);

  const log: string[] = [];
  const { deps: d, moves } = deps(log);
  const r = await drainOffline(CTX, "reconnect", d);
  assert.equal(moves.length, 1);
  assert.equal(moves[0].fromTableId, "T-A");
  assert.equal(moves[0].toTableId, "T-B");
  assert.equal(moves[0].expectedVersion, 5);
  assert.equal(moves[0].clientOpId, a.clientOpId);
  assert.equal(r.needsAttention.length, 0);
});

test("merge: capture (content-addressed id) → drain → pos_merge_tables_v3 with expected map, once", async () => {
  const sig = "T-P|T-S1|T-S2";
  await captureMergeTablesOffline({ scope: SCOPE, primaryTableId: "T-P", sourceTableIds: ["T-S1", "T-S2"], expected: { "T-P": 3, "T-S1": 2, "T-S2": 4 }, clientOpId: sig });
  const log: string[] = [];
  const { deps: d, merges } = deps(log);
  const r = await drainOffline(CTX, "reconnect", d);
  assert.equal(merges.length, 1);
  assert.equal(merges[0].primaryTableId, "T-P");
  assert.deepEqual(merges[0].sourceTableIds, ["T-S1", "T-S2"]);
  assert.deepEqual(merges[0].expected, { "T-P": 3, "T-S1": 2, "T-S2": 4 });
  assert.equal(merges[0].clientOpId, sig);
  assert.equal(r.needsAttention.length, 0);
});

test("move drift → needs_attention (CONFLICT), never a silent move", async () => {
  const cap = await captureMoveTableOffline({ scope: SCOPE, fromTableId: "T-A", toTableId: "T-B", expectedVersion: 5 });
  const log: string[] = [];
  const { deps: d } = deps(log, { moveTable: async () => { throw new Error("version_conflict: the floor changed since it was loaded"); } });
  const r = await drainOffline(CTX, "reconnect", d);
  assert.equal(r.needsAttention.length, 1);
  assert.equal((await getOperation(cap.operationId))?.status, "needs_attention");
});

test("merge drift (a source already settled) → needs_attention, never a silent destructive merge", async () => {
  const cap = await captureMergeTablesOffline({ scope: SCOPE, primaryTableId: "T-P", sourceTableIds: ["T-S1"], expected: { "T-P": 3, "T-S1": 2 }, clientOpId: "T-P|T-S1" });
  const log: string[] = [];
  const { deps: d } = deps(log, { mergeTables: async () => { throw new Error("a source is no longer eligible: already settled"); } });
  const r = await drainOffline(CTX, "reconnect", d);
  assert.equal(r.needsAttention.length, 1);
  assert.equal((await getOperation(cap.operationId))?.status, "needs_attention");
});
