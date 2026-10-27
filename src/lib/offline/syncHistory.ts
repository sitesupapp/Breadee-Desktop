// Phase B — durable SYNC HISTORY (operator/admin observability).
//
// A persistent event log that survives restart, successful sync, and queue cleanup. It
// is NOT derived from the live pending rows (those are GC'd once synced); history is its
// own durable record. It stores SAFE metadata only — identifiers, status, short error
// summaries — never a wholesale payload dump and never card/credential data.
//
// Scope: history is read back filtered to the active tenant + authorized branch/OU; a
// shared device never surfaces another OU's history.

import { localdb } from "@/lib/offline/db";
import type { OperationType, OperationStatus } from "@/lib/offline/operationLog";

/** A durable, human-meaningful event in an operation's lifecycle. PK = ++id. */
export interface SyncHistoryEvent {
  id?: number;
  at: string; // ISO timestamp of the event
  operation_id: string;
  operation_type: OperationType | string;
  /** Business-worded action label for the UI, e.g. "Open Shift", "Takeaway Order". */
  action_label: string;
  tenant_id: string;
  branch_id: string | null;
  device_id: string;
  cashier_user_id: string;
  /** Operator-facing local reference, e.g. "OFF-0041". */
  local_ref: string | null;
  /** Canonical/server reference once known, e.g. "261015-0041" or a shift id. */
  canonical_ref: string | null;
  status: OperationStatus;
  retry_count: number;
  /** Short, safe summary of an error/conflict — NEVER a raw payload or secret. */
  error_summary: string | null;
  synced_at: string | null;
}

/** Append one history event. Never throws into the caller's critical path. */
export async function appendHistory(ev: SyncHistoryEvent): Promise<void> {
  try {
    await localdb.syncHistory.add(ev);
  } catch {
    /* history is observability; a write failure must never break replay */
  }
}

/** History for the active tenant + authorized branch, newest first. Branch null = tenant-wide
 *  (only when the caller is authorized tenant-wide); otherwise strictly the one branch. */
export async function listHistory(
  tenantId: string | null,
  branchId: string | null,
  limit = 200,
): Promise<SyncHistoryEvent[]> {
  if (!tenantId) return [];
  // rc.12 — newest-first CURSOR that stops after `limit` scoped rows (Dexie filter + limit), instead of
  // materialising the whole (up to thousands of rows) history table every 4 s while the dialog is open.
  return localdb.syncHistory
    .orderBy("id")
    .reverse()
    .filter((e) => e.tenant_id === tenantId && (branchId == null || (e.branch_id ?? null) === branchId))
    .limit(limit)
    .toArray();
}

/** Rolled-up status for the global badge, scoped to the active context. */
export async function historySummary(
  tenantId: string | null,
  branchId: string | null,
): Promise<{ pending: number; syncing: number; needsAttention: number; synced: number }> {
  const out = { pending: 0, syncing: 0, needsAttention: 0, synced: 0 };
  if (!tenantId) return out;
  // Summary is derived from the live operation log (current truth), not the append-only
  // history (which keeps past events). Scope-filtered. (rc.12 measured: ONE bulk read beats per-status
  // index cursors by ~35× on QA-sized logs — cursor steps are individually async.)
  // (Final Foundation: the bulk read is bounded by the local retention window; no production caller.)
  const ops = await localdb.operations.toArray();
  for (const o of ops) {
    if (o.scope.tenant_id !== tenantId) continue;
    if (branchId != null && (o.scope.branch_id ?? null) !== branchId) continue;
    if (o.status === "pending" || o.status === "blocked_dependency" || o.status === "retryable") out.pending++;
    else if (o.status === "syncing") out.syncing++;
    else if (o.status === "needs_attention") out.needsAttention++;
    else if (o.status === "synced") out.synced++;
  }
  return out;
}

/**
 * RETENTION (capability, deliberately separate from destructive GC).
 *
 * Phase-B policy: NEVER remove history for an operation that is still unsettled
 * (pending/syncing/blocked/retryable/needs_attention); preserve recently-synced history.
 * The final retention window is a PRODUCT DECISION (reported, not assumed). This default
 * cap only bounds unbounded growth of SYNCED history and is conservative + configurable.
 */
export const DEFAULT_SYNCED_HISTORY_CAP = 2000;

/** Trim only old SYNCED-event history beyond the cap. Never touches unsettled operations'
 *  history. No-op unless over cap. Returns rows removed. */
export async function trimSyncedHistory(cap = DEFAULT_SYNCED_HISTORY_CAP): Promise<number> {
  const unsettled = new Set(
    (await localdb.operations.where("status").anyOf(["pending", "blocked_dependency", "syncing", "retryable", "needs_attention"]).toArray()).map(
      (o) => o.operation_id,
    ),
  );
  const all = await localdb.syncHistory.orderBy("id").toArray(); // oldest first
  const removable = all.filter((e) => !unsettled.has(e.operation_id) && e.status === "synced");
  const over = removable.length - cap;
  if (over <= 0) return 0;
  const toDelete = removable.slice(0, over).map((e) => e.id!).filter((id) => id != null);
  await localdb.syncHistory.bulkDelete(toDelete);
  return toDelete.length;
}
