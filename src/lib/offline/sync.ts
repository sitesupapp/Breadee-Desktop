import { localdb } from "@/lib/offline/db";

// DEPRECATED (1.0.38, Bug 7) — the legacy-outbox "sync engine".
//
// It never replayed anything: every handler answered "review", it made no server writes, and it
// only flipped `outbox` rows queued/failed → syncing → review (rows `pendingCount` still counted, so
// the badge never cleared). Nothing writes the outbox any more (`enqueue` has no callers), so it
// drove Settings → Sync Center to report "All changes are synced" while real POS work was pending.
//
// The single replay owner is the orchestrator (drainOffline, via syncPosTxns). Legacy outbox rows
// are QUARANTINED by the migration as `legacy_outbox:<kind>` needs_attention operations and shown
// in the Sync Center as manager-review items. This module is kept only for backward compatibility
// and is now READ-ONLY: it reports outbox rows as manager review and writes nothing (no status
// flip, no audit row). Delete it once nothing imports it. Do NOT add a drain here.

export type SyncReport = {
  startedAt: string;
  finishedAt: string;
  triggeredBy: string;
  synced: number[];
  failed: { id: number; error: string }[];
  conflicts: number[];
  skipped: number[];
  review: number[];
};

/** @deprecated Read-only. Use the Sync Center (operations log); replay belongs to the orchestrator. */
export async function syncNow(triggeredBy: string): Promise<SyncReport> {
  const startedAt = new Date().toISOString();
  const items = await localdb.outbox.toArray().catch(() => []);
  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    triggeredBy,
    synced: [],
    failed: [],
    conflicts: [],
    skipped: [],
    review: items.map((i) => i.id).filter((id): id is number => id != null),
  };
}
