// 1.0.38 — Workstream D (Bug 7): the two Sync Centers disagreed.
//
// Settings → Sync Center read the legacy `outbox` (nothing writes it) and always said "All changes
// are synced"; the POS Sync Center read the live operations log. Both now render ONE shared
// SyncCenterPanel over ONE read model (syncCenterModel), scoped to tenant + branch, and the Shell /
// Dashboard badges read the same summary. These tests pin: identical state/counts from one fixture,
// never "all synced" while work is pending or parked, tenant/branch scope, legacy quarantine stays
// visible, and opening a Sync Center performs no writes.

import "fake-indexeddb/auto";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./source-helpers.ts";

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? (this.m.get(k) as string) : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
(globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage();

import { localdb, enqueue, addPosOfflineTxn, type PosOfflineTxn } from "@/lib/offline/db";
import { migrateLegacyToOperations } from "@/lib/offline/migration";
import { OPERATION_SCHEMA_VERSION, summarizeOperations, type OfflineOperation, type OperationStatus } from "@/lib/offline/operationLog";
import { appendHistory, listHistory } from "@/lib/offline/syncHistory";
import { loadSyncCenterRows } from "@/lib/offline/queueForensics";
import { syncNow } from "@/lib/offline/sync";
import {
  SYNC_STATE_DEFS,
  SYNC_STATE_ORDER,
  canRetry,
  chipOf,
  displayStateOf,
  loadSyncSummary,
  statusLabel,
  summarize,
} from "@/components/sync/syncCenterModel";

const here = dirname(fileURLToPath(import.meta.url));
const srcOf = (rel: string) => stripComments(readFileSync(join(here, "..", rel), "utf8"));

function op(id: string, status: OperationStatus, over: Partial<OfflineOperation> & { tenant?: string; branch?: string | null } = {}): OfflineOperation {
  const { tenant = "t1", branch = "b1", ...rest } = over;
  return {
    operation_id: id,
    operation_type: "payout",
    schema_version: OPERATION_SCHEMA_VERSION,
    scope: { tenant_id: tenant, branch_id: branch, device_id: "dev1", terminal_id: "term1", cashier_user_id: "u1" },
    created_at: new Date().toISOString(),
    client_op_id: id,
    local_entity_id: null,
    canonical_entity_id: null,
    dependency_ids: [],
    depends_on_local_entities: [],
    payload: {},
    status,
    retry_count: 0,
    last_attempt_at: null,
    last_error_code: null,
    last_error_message: null,
    result_meta: null,
    synced_at: status === "synced" ? new Date().toISOString() : null,
    ...rest,
  };
}

function txn(id: string, over: Partial<PosOfflineTxn> = {}): PosOfflineTxn {
  return {
    local_txn_id: id, client_op_id: "op-" + id, tenant_id: "t1", branch_id: "b1", device_id: "dev1", terminal_id: "term1",
    cashier_user_id: "u1", cashier_user_name: "C", shift_id: "SRV", created_at: new Date().toISOString(),
    order_payload: { order_type: "takeaway", items: [] }, payment_intent: { method: "cash", currency: "LBP" },
    currency: "LBP", total: 10, status: "queued", attempts: 0, pending_shift_local_id: null, ...over,
  } as PosOfflineTxn;
}

beforeEach(async () => {
  for (const t of [localdb.operations, localdb.syncHistory, localdb.outbox, localdb.posOfflineTxns, localdb.pendingShifts, localdb.entityMap, localdb.audit]) await t.clear();
});

/** The shared fixture: every state in t1/b1, plus another branch and another tenant, a legacy
 *  quarantined outbox record (via the real migration), synced history and an un-staged offline sale. */
async function seed() {
  await enqueue({ kind: "pos.save_order", payload: { x: 1 }, user_id: "u1", user_name: "C", tenant_id: "t1", branch_id: "b1", device_id: "dev1", terminal_id: "term1", created_at: new Date().toISOString() });
  await migrateLegacyToOperations(); // quarantines the outbox row as a needs_attention legacy_outbox:* op
  await localdb.operations.bulkAdd([
    op("p1", "pending"),
    op("w1", "blocked_dependency"),
    op("r1", "retryable", { last_error_code: "TRANSPORT_RETRYABLE" }),
    op("s1", "syncing"),
    op("na1", "needs_attention", { last_error_code: "VALIDATION_TERMINAL" }),
    op("cf1", "needs_attention", { last_error_code: "CONFLICT" }),
    op("ok1", "synced"),
    op("ok2", "synced"),
    op("cx1", "cancelled"),
    // other OU + other tenant: must never be counted for t1/b1
    op("b2p", "pending", { branch: "b2" }),
    op("b2na", "needs_attention", { branch: "b2" }),
    op("t2p", "pending", { tenant: "t2" }),
    op("t2na", "needs_attention", { tenant: "t2" }),
  ]);
  await appendHistory({ at: new Date().toISOString(), operation_id: "ok1", operation_type: "payout", action_label: "Payout", tenant_id: "t1", branch_id: "b1", device_id: "dev1", cashier_user_id: "u1", local_ref: null, canonical_ref: "X", status: "synced", retry_count: 0, error_summary: null, synced_at: new Date().toISOString() });
  await appendHistory({ at: new Date().toISOString(), operation_id: "t2p", operation_type: "payout", action_label: "Payout", tenant_id: "t2", branch_id: "b1", device_id: "dev1", cashier_user_id: "u9", local_ref: null, canonical_ref: null, status: "pending", retry_count: 0, error_summary: null, synced_at: null });
  // An offline sale captured while offline: the next drain has not staged it into the log yet.
  await addPosOfflineTxn(txn("T-unstaged"));
  await addPosOfflineTxn(txn("T-other-branch", { branch_id: "b2" }));
}

const EXPECTED_T1_B1 = {
  pending: 2, // p1 + the un-staged offline sale
  waiting: 1,
  syncing: 1,
  retrying: 1,
  needsAttention: 1,
  conflict: 1,
  managerReview: 1, // quarantined legacy outbox record
  synced: 2,
  notYetQueued: 1,
  toSync: 5,
  parked: 3,
};

// ---------------------------------------------------------------------------------------------
// One label/definition map
// ---------------------------------------------------------------------------------------------

test("one shared label map covers every operation status with the agreed operator labels", () => {
  assert.deepEqual(
    SYNC_STATE_ORDER.map((s) => SYNC_STATE_DEFS[s].label),
    ["Pending", "Waiting for dependency", "Syncing", "Will retry", "Synced", "Needs attention", "Conflict", "Manager review", "Cancelled"],
  );
  for (const s of ["pending", "blocked_dependency", "syncing", "synced", "retryable", "needs_attention", "cancelled"] as OperationStatus[]) {
    assert.ok(SYNC_STATE_DEFS[displayStateOf(s)].definition.length > 10, `${s} has a definition`);
  }
  assert.equal(statusLabel("needs_attention", "CONFLICT"), "Conflict");
  assert.equal(statusLabel("needs_attention", "unknown_handler", "legacy_outbox:pos.save_order"), "Manager review");
  assert.equal(statusLabel("needs_attention", "VALIDATION_TERMINAL"), "Needs attention");
  assert.equal(statusLabel("retryable"), "Will retry");
  // An unknown future status is never presented as synced.
  assert.equal(displayStateOf("something_new"), "needs_attention");
  // Retry is offered for parked work a retry can help — never for a quarantined legacy record.
  assert.equal(canRetry("needs_attention"), true);
  assert.equal(canRetry("conflict"), true);
  assert.equal(canRetry("manager_review"), false);
  assert.equal(canRetry("pending"), false);
});

// ---------------------------------------------------------------------------------------------
// Both entry points: identical counts/states from one fixture
// ---------------------------------------------------------------------------------------------

test("both entry points render the SAME shared panel; neither reads the legacy outbox", () => {
  const pos = srcOf("src/components/pos/SyncCenter.tsx");
  const settings = srcOf("src/screens/settings/SyncCenter.tsx");
  for (const [name, src] of [["pos", pos], ["settings", settings]] as const) {
    assert.match(src, /<SyncCenterPanel tenantId=\{tenantId\} branchId=\{branchId\} currentShiftId=\{currentShiftId\} \/>/, `${name} renders the shared panel`);
    assert.match(src, /currentShiftId = useCurrentShiftId\(\)/, `${name} uses the shared shift selector`);
    for (const forbidden of ["outbox", "localdb", "syncNow", "pendingCount", "historySummary"]) {
      assert.ok(!src.includes(forbidden), `${name} SyncCenter must not use ${forbidden}`);
    }
  }
  // Settings scope = session tenant + the POS operational branch resolver with the session pin.
  assert.match(settings, /useSyncScope\(\)/);
  const panel = srcOf("src/components/sync/SyncCenterPanel.tsx");
  assert.match(panel, /resolveBranchId\(tenant, membership, pinned\)/);
  assert.match(panel, /s\.sel\[`\$\{tenantId\}:\$\{userId\}`\]/, "same pin key as usePosContext");
  // The POS chip and the panel read the same summary + chip text.
  assert.match(pos, /chipOf\(summary\)/);
  assert.match(panel, /chipOf\(summary\)/);
});

test("same fixture → identical summary, chip and per-row states for POS and Settings scopes", async () => {
  await seed();
  // POS passes (tenantId, pos.branch.id); Settings passes (session tenant, resolveBranchId(+pin)).
  // For the same operator both resolve to t1/b1 — the panel then derives everything from the scope.
  const posView = {
    summary: await loadSyncSummary("t1", "b1", { includeSynced: true }),
    rows: await loadSyncCenterRows({ tenantId: "t1", branchId: "b1", currentBuild: null, currentShiftId: null }),
  };
  const settingsView = {
    summary: await loadSyncSummary("t1", "b1", { includeSynced: true }),
    rows: await loadSyncCenterRows({ tenantId: "t1", branchId: "b1", currentBuild: null, currentShiftId: null }),
  };
  assert.deepEqual(posView, settingsView);
  assert.deepEqual(posView.summary, EXPECTED_T1_B1);
  assert.deepEqual(chipOf(posView.summary), { text: "3 needs attention", kind: "attention" });

  const states = Object.fromEntries(posView.rows.map((r) => [r.operation_id, displayStateOf(r.status, r.error_code, r.type)]));
  assert.equal(states["p1"], "pending");
  assert.equal(states["w1"], "blocked_dependency");
  assert.equal(states["r1"], "retryable");
  assert.equal(states["s1"], "syncing");
  assert.equal(states["na1"], "needs_attention");
  assert.equal(states["cf1"], "conflict");
  assert.equal(states["ok1"], "synced");
  // The quarantined legacy record stays VISIBLE as a manual-review item.
  const legacy = posView.rows.find((r) => r.type.startsWith("legacy_outbox:"));
  assert.ok(legacy, "legacy quarantined op is listed");
  assert.equal(displayStateOf(legacy!.status, legacy!.error_code, legacy!.type), "manager_review");
  // Other OU / tenant never appear.
  for (const id of ["b2p", "b2na", "t2p", "t2na"]) assert.equal(states[id], undefined, `${id} is out of scope`);

  // Badges (Shell / Dashboard / POS chip) read the same summary without the synced count.
  const badge = await loadSyncSummary("t1", "b1");
  assert.equal(badge.toSync, EXPECTED_T1_B1.toSync);
  assert.equal(badge.parked, EXPECTED_T1_B1.parked);
  assert.equal(badge.synced, 0);
  // …and agrees with the op log's own summary that the POS status-bar badge reads.
  const log = await summarizeOperations({ tenantId: "t1", branchId: "b1" }, { includeSynced: true });
  assert.equal(badge.toSync + badge.parked, log.unsettled);
  assert.equal(posView.summary.synced, log.synced);
});

// ---------------------------------------------------------------------------------------------
// Never "all synced" while work is pending or parked
// ---------------------------------------------------------------------------------------------

test("never 'All changes synced' while anything is pending, waiting, retrying, syncing, parked or un-staged", async () => {
  for (const status of ["pending", "blocked_dependency", "retryable", "syncing", "needs_attention"] as OperationStatus[]) {
    await localdb.operations.clear();
    await localdb.operations.add(op("x", status));
    const s = await loadSyncSummary("t1", "b1", { includeSynced: true });
    assert.notEqual(chipOf(s).kind, "clear", `${status} must not read as all synced`);
  }
  // A legacy quarantined record alone still needs a manager.
  await localdb.operations.clear();
  await enqueue({ kind: "inventory.movement", payload: {}, user_id: "u1", user_name: "C", tenant_id: "t1", branch_id: "b1", device_id: "dev1", terminal_id: "term1", created_at: new Date().toISOString() });
  await migrateLegacyToOperations();
  assert.equal(chipOf(await loadSyncSummary("t1", "b1")).kind, "attention");

  // An offline sale not yet staged into the log (offline, no drain yet) is pending work (D6).
  await localdb.operations.clear();
  await localdb.outbox.clear();
  await addPosOfflineTxn(txn("T1"));
  assert.deepEqual(chipOf(await loadSyncSummary("t1", "b1")), { text: "1 pending", kind: "pending" });
  // Once staged (op exists) it is counted ONCE, through the op.
  await localdb.operations.add(op("mig:txn:T1", "pending", { operation_type: "takeaway_sale" }));
  assert.equal((await loadSyncSummary("t1", "b1")).pending, 1);
  // Synced + reconciled (row synced) → clear.
  await localdb.operations.update("mig:txn:T1", { status: "synced" });
  await localdb.posOfflineTxns.update("T1", { status: "synced" });
  assert.equal(chipOf(await loadSyncSummary("t1", "b1", { includeSynced: true })).text, "All changes synced");

  // Only synced + cancelled history → all clear.
  assert.equal(chipOf(summarize([{ status: "synced", last_error_code: null, operation_type: "payout" }, { status: "cancelled", last_error_code: null, operation_type: "payout" }])).kind, "clear");
});

// ---------------------------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------------------------

test("scope: tenant + branch filtering; null branch = tenant-wide; no tenant = nothing", async () => {
  await seed();
  const b2 = await loadSyncSummary("t1", "b2");
  assert.equal(b2.pending, 2); // b2p + its un-staged sale
  assert.equal(b2.needsAttention, 1);
  assert.equal(b2.managerReview, 0);
  const t2 = await loadSyncSummary("t2", "b1");
  assert.equal(t2.pending, 1);
  assert.equal(t2.needsAttention, 1);
  assert.equal(t2.notYetQueued, 0, "another tenant's offline sale never counts");
  const tenantWide = await loadSyncSummary("t1", null);
  assert.equal(tenantWide.toSync, EXPECTED_T1_B1.toSync + 2);
  assert.equal(tenantWide.parked, EXPECTED_T1_B1.parked + 1);
  assert.equal((await loadSyncSummary(null, "b1")).toSync, 0);
  // History list is scoped too.
  assert.deepEqual((await listHistory("t1", "b1", 100)).map((e) => e.operation_id), ["ok1"]);
});

// ---------------------------------------------------------------------------------------------
// No writes on open; legacy syncNow is harmless
// ---------------------------------------------------------------------------------------------

async function snapshot() {
  return {
    operations: await localdb.operations.toArray(),
    syncHistory: await localdb.syncHistory.toArray(),
    outbox: await localdb.outbox.toArray(),
    posOfflineTxns: await localdb.posOfflineTxns.toArray(),
    audit: await localdb.audit.toArray(),
    entityMap: await localdb.entityMap.toArray(),
  };
}

test("opening a Sync Center (every read the panel/badges do) writes nothing; legacy rows are never deleted", async () => {
  await seed();
  const before = await snapshot();
  await loadSyncSummary("t1", "b1", { includeSynced: true });
  await loadSyncSummary("t1", "b1");
  await loadSyncCenterRows({ tenantId: "t1", branchId: "b1", currentBuild: null, currentShiftId: null });
  await listHistory("t1", "b1", 100);
  // The deprecated legacy entry point is now read-only too (no status flip, no audit row).
  const report = await syncNow("u1");
  assert.equal(report.review.length, 1);
  assert.deepEqual(await snapshot(), before);
  assert.equal(before.outbox.length, 1, "legacy outbox source row preserved");
  assert.ok(before.operations.some((o) => o.operation_id.startsWith("mig:outbox:")), "quarantined op preserved");
});

test("source: the panel/model never drain, migrate, replay or write — the only write is the explicit retry", () => {
  const panel = srcOf("src/components/sync/SyncCenterPanel.tsx");
  const model = srcOf("src/components/sync/syncCenterModel.ts");
  for (const [name, src] of [["panel", panel], ["model", model]] as const) {
    for (const forbidden of ["drainOffline", "drainOperations", "syncPosTxns", "syncNow", "migrateLegacy", "reconcileLegacy", "addOperation", "updateOperation", ".put(", ".add(", ".update(", ".delete(", ".clear(", "bulkDelete", "bulkAdd", "bulkPut", "supabase", ".rpc("]) {
      assert.ok(!src.includes(forbidden), `${name} must not contain ${forbidden}`);
    }
  }
  // requeueOperation appears only inside the click handler.
  assert.equal(panel.match(/requeueOperation\(/g)?.length, 1);
  assert.match(panel, /const retry = useCallback\(\s*async \(operationId: string\) => \{\s*setRequeuing\(operationId\);\s*try \{\s*await requeueOperation\(operationId\)/);
  // Settings no longer has the misleading copy or the legacy drain.
  const settings = srcOf("src/screens/settings/SyncCenter.tsx");
  assert.ok(!/Nothing queued|All changes are synced|Sync now/.test(settings));
});

test("Shell and Dashboard badges read the scoped summary, not the legacy outbox count", () => {
  for (const f of ["src/screens/Shell.tsx", "src/screens/Dashboard.tsx"]) {
    const src = srcOf(f);
    assert.ok(!src.includes("pendingCount"), `${f} no longer uses the outbox pendingCount`);
    assert.match(src, /useSyncScope\(\)/, `${f} uses the shared scope`);
    assert.match(src, /useSyncSummary\(syncTenantId, syncBranchId\)/, `${f} uses the shared summary`);
  }
});
