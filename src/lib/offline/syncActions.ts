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
import { getBackendHealth } from "@/lib/offline/reachability";
import { noRetryText, recoveryOf } from "@/lib/offline/refusalPolicy";

/** 1.0.41 — Retry while the ONE health store says the database is not answering. */
export const RETRY_SERVER_OFF =
  "Breadee's server is not answering right now, so this was not retried. It stays as it is on this terminal; press Retry again when Breadee answers.";

export type SyncNowResult =
  | { ran: true; synced: number; needsAttention: number; failed: number; waiting: number; text: string }
  | { ran: false; text: string };

// 1.0.41 (BUG 03 RC-A) — the drain belongs to the app-level sync worker, so "the POS screen is not open" is no
// longer a reason. NO_POS now only means the worker is not running (signed out / not started).
export const SYNC_NOW_NO_POS =
  "Nothing was synced: syncing is not running on this terminal. Sign in again (or reopen Breadee) and it resumes automatically.";
export const SYNC_NOW_NOT_RUN = "Nothing was synced: a sync was already running or just finished. Try again in a moment.";
/** 1.0.41 — the ONE health store says the database is not answering: say so, consistently with the header. */
export const SYNC_NOW_SERVER_OFF =
  "Nothing was synced: Breadee's server is not answering right now. Your work stays saved on this terminal and syncs automatically when it answers again.";

/**
 * PURE — the operator sentence for a pass's counts. `standingAttention` (native Staging 1.0.48): items that were
 * ALREADY parked for review before this pass are not re-processed by it, so the pass alone reported "0 still need
 * attention" under a header saying "2 needs attention". The sentence now reports the larger of the two, so it never
 * contradicts the screen.
 */
export function syncNowText(
  r: { synced: number; needsAttention: number; failed: number; waiting: number },
  standingAttention = 0,
): string {
  const attention = Math.max(r.needsAttention, Math.max(0, standingAttention));
  const parts = [`${r.synced} synced`, `${attention} still need${attention === 1 ? "s" : ""} attention`, `${r.failed} failed (will retry)`];
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

export async function runSyncNow(
  drain: (reason: string) => Promise<number> = requestDrainAndWait,
  last: () => OperationDrainReport | null = lastDrainReport,
  standingAttention: () => Promise<number> = async () => 0,
): Promise<SyncNowResult> {
  const since = new Date().toISOString();
  const listeners = await drain("operator-sync-now");
  if (listeners === 0) return { ran: false, text: SYNC_NOW_NO_POS };
  const r = last();
  if (!r || !r.executed || r.startedAt < since) {
    return { ran: false, text: getBackendHealth() === "online" ? SYNC_NOW_NOT_RUN : SYNC_NOW_SERVER_OFF };
  }
  const c = countsOf(r);
  const standing = await standingAttention().catch(() => 0);
  return { ran: true, ...c, text: syncNowText(c, standing) };
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
      // 1.0.41 — the same health truth as the header (no "online" header next to "queued until online").
      return getBackendHealth() === "online"
        ? "Queued — it syncs on the next pass."
        : "Queued — Breadee's server is not answering; it syncs automatically when it answers again.";
  }
}

export async function operatorRetry(
  operationId: string,
  opts: { actorUserId: string | null; rebaseDeps?: RebaseDeps; drain?: (reason: string) => Promise<number> } ,
): Promise<RetryResult> {
  const drain = opts.drain ?? requestDrainAndWait;
  const op = await getOperation(operationId);
  if (!op || op.status !== "needs_attention") return { ok: false, text: retryOutcomeText(op) };
  // 1.0.41 (RC-C) — a deterministic refusal of the frozen request is never re-sent, and a child parked behind a
  // refused parent is never re-queued on its own (each such Retry only flipped the chain to Pending).
  const recovery = recoveryOf(op);
  if (recovery !== "retry" && recovery !== "rebase") return { ok: false, text: noRetryText(op) };
  // 1.0.41 — while the server is not answering nothing is re-queued: the op and its chain stay parked as they
  // are (re-queuing would only show them as Pending until the next refusal).
  if (getBackendHealth() !== "online") return { ok: false, text: RETRY_SERVER_OFF };
  if (isRebasableOpen(op)) {
    const r = await rebaseRefusedOpen(operationId, opts.rebaseDeps ?? liveRebaseDeps, opts.actorUserId, { drain: false });
    if (r.kind === "table_busy" || r.kind === "sold_since" || r.kind === "offline" || r.kind === "stale") return { ok: false, text: r.message };
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
