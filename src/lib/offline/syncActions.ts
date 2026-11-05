// 1.0.40 (BUG 03, F3/F5) — the Sync Center's two operator actions, with their REAL outcome.
//
//   - runSyncNow: asks the live POS for the SAME single-flight drain every automatic trigger uses (reconnect
//     stays the default) and reports the counts of the pass that actually ran (orchestrator lastDrainReport):
//     synced / still needing attention / failed (will retry) / waiting. A pass that did not run (offline, no
//     POS open, another pass in flight) is reported as such — never as "0 synced".
//   - operatorRetry: one parked op. A table open refused on its table-version CAS is re-checked against Breadee
//     and re-armed with the current version (openRebase); any other parked op is re-queued as before. Then the
//     drain runs and the op's resulting state is reported.
// Neither deletes, acknowledges or marks anything synced.

import { getOperation, requeueOperation, requestDrainAndWait, type OfflineOperation } from "@/lib/offline/operationLog";
import { lastDrainReport, type OperationDrainReport } from "@/lib/offline/orchestrator";
import { isRebasableOpen, liveRebaseDeps, rebaseRefusedOpen, type RebaseDeps } from "@/lib/offline/openRebase";

export type SyncNowResult =
  | { ran: true; synced: number; needsAttention: number; failed: number; waiting: number; text: string }
  | { ran: false; text: string };

export const SYNC_NOW_NO_POS =
  "Nothing was synced: this terminal is offline, or the POS screen is not open. Offline work syncs automatically once the POS is open and online.";
export const SYNC_NOW_NOT_RUN = "Nothing was synced: this terminal may be offline, or a sync was already running. Try again in a moment.";

/** PURE — the operator sentence for a pass's counts. */
export function syncNowText(r: { synced: number; needsAttention: number; failed: number; waiting: number }): string {
  const parts = [`${r.synced} synced`, `${r.needsAttention} still need${r.needsAttention === 1 ? "s" : ""} attention`, `${r.failed} failed (will retry)`];
  if (r.waiting > 0) parts.push(`${r.waiting} waiting`);
  return `Sync finished: ${parts.join(" · ")}.`;
}

/** PURE — counts of one executed drain report. */
export function countsOf(report: OperationDrainReport): { synced: number; needsAttention: number; failed: number; waiting: number } {
  return {
    synced: report.drained.length,
    needsAttention: report.needsAttention.length,
    failed: report.retryable.length + report.skippedBackoff.length,
    waiting: report.blocked.length,
  };
}

export async function runSyncNow(drain: (reason: string) => Promise<number> = requestDrainAndWait, last: () => OperationDrainReport | null = lastDrainReport): Promise<SyncNowResult> {
  const since = new Date().toISOString();
  const listeners = await drain("operator-sync-now");
  if (listeners === 0) return { ran: false, text: SYNC_NOW_NO_POS };
  const r = last();
  if (!r || !r.executed || r.startedAt < since) return { ran: false, text: SYNC_NOW_NOT_RUN };
  const c = countsOf(r);
  return { ran: true, ...c, text: syncNowText(c) };
}

export type RetryResult = { ok: boolean; text: string };

/** PURE — the operator sentence for an op's state after a retry. */
export function retryOutcomeText(o: OfflineOperation | undefined): string {
  if (!o) return "This operation is no longer on this device.";
  switch (o.status) {
    case "synced":
      return "Synced.";
    case "needs_attention":
      return `Still needs attention: ${(o.last_error_message ?? o.last_error_code ?? "refused").slice(0, 160)}`;
    case "retryable":
      return "Not synced yet — a temporary problem; it will retry automatically.";
    case "blocked_dependency":
      return "Queued — waiting for an earlier step to sync first.";
    default:
      return "Queued — it will sync when this terminal is online.";
  }
}

export async function operatorRetry(
  operationId: string,
  opts: { actorUserId: string | null; rebaseDeps?: RebaseDeps; drain?: (reason: string) => Promise<number> } ,
): Promise<RetryResult> {
  const drain = opts.drain ?? requestDrainAndWait;
  const op = await getOperation(operationId);
  if (isRebasableOpen(op)) {
    const r = await rebaseRefusedOpen(operationId, opts.rebaseDeps ?? liveRebaseDeps, opts.actorUserId, { drain: false });
    if (r.kind === "table_busy" || r.kind === "offline" || r.kind === "stale") return { ok: false, text: r.message };
    if (r.kind === "receipt_found") {
      // Breadee already holds it: a plain re-queue replays the recorded receipt (idempotent), never a new version.
      await requeueOperation(operationId, { drain: false });
    }
  } else if (!(await requeueOperation(operationId, { drain: false }))) {
    return { ok: false, text: retryOutcomeText(await getOperation(operationId)) };
  }
  await drain("operator-retry");
  const after = await getOperation(operationId);
  return { ok: after?.status === "synced", text: retryOutcomeText(after) };
}
