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

// ---------------------------------------------------------------------------------------------------------------
// 1.0.42 (P0 2026-11-17) — FORCE SYNC: one orchestrated recovery sweep over THIS terminal's parked work, then the
// SAME single-flight drain. It never marks anything synced itself, never re-sends a deterministic refusal, never
// bypasses a CAS / authorization / idempotency guard and never touches money evidence:
//   1. receipt-verified — Breadee holds the op's receipt (pos_op_submissions): the op WAS applied; it is re-queued
//      and the server's idempotent replay returns the recorded result (that, not this sweep, makes it Synced);
//   2. dependency recovery — a child parked only because a parent failed (dependency_failed) whose parents have
//      ALL synced since is re-queued;
//   3. a CAS-refused table open goes through the existing fail-closed rebase (receipt / free table / no sale since);
//   4. everything else (genuine conflicts, refused payments, price / permission / validation refusals) stays
//      parked for review and is counted, never retried.
// ---------------------------------------------------------------------------------------------------------------

export type ForceSyncDeps = {
  hasReceipt(tenantId: string, clientOpId: string): Promise<boolean>;
  rebaseDeps: RebaseDeps;
  drain: (reason: string) => Promise<number>;
  listParked: () => Promise<OfflineOperation[]>;
  getOp: (id: string) => Promise<OfflineOperation | undefined>;
  requeue: (id: string) => Promise<boolean>;
  health: () => string;
};

export type ForceSyncResult = {
  ran: boolean;
  receiptVerified: string[];
  dependencyRecovered: string[];
  rebased: string[];
  leftForReview: string[];
  text: string;
};

export const FORCE_SYNC_SERVER_OFF =
  "Force sync needs Breadee's server: it checks every parked step against Breadee before re-sending anything. Nothing was changed.";

export async function forceSync(scope: { tenantId: string; branchId: string | null }, actorUserId: string | null, deps: ForceSyncDeps): Promise<ForceSyncResult> {
  const out: ForceSyncResult = { ran: false, receiptVerified: [], dependencyRecovered: [], rebased: [], leftForReview: [], text: "" };
  if (deps.health() !== "online") return { ...out, text: FORCE_SYNC_SERVER_OFF };
  const parked = (await deps.listParked()).filter(
    (o) => o.status === "needs_attention" && o.scope.tenant_id === scope.tenantId && (o.scope.branch_id ?? null) === (scope.branchId ?? null),
  );
  // Parents before children: a re-queued parent can make its children recoverable in the same sweep.
  parked.sort((a, b) => a.created_at.localeCompare(b.created_at));
  for (const op of parked) {
    let receipt = false;
    try {
      receipt = await deps.hasReceipt(op.scope.tenant_id, op.client_op_id);
    } catch {
      out.leftForReview.push(op.operation_id); // cannot verify → nothing changes
      continue;
    }
    if (receipt) {
      if (await deps.requeue(op.operation_id)) out.receiptVerified.push(op.operation_id);
      else out.leftForReview.push(op.operation_id);
      continue;
    }
    const recovery = recoveryOf(op);
    if (recovery === "via_parent") {
      const parents = await Promise.all((op.dependency_ids ?? []).map((id) => deps.getOp(id)));
      const allSynced = parents.length > 0 && parents.every((p) => p?.status === "synced");
      const parentRequeued = (op.dependency_ids ?? []).some((id) => out.receiptVerified.includes(id) || out.rebased.includes(id) || out.dependencyRecovered.includes(id));
      if ((allSynced || parentRequeued) && (await deps.requeue(op.operation_id))) out.dependencyRecovered.push(op.operation_id);
      else out.leftForReview.push(op.operation_id);
      continue;
    }
    if (isRebasableOpen(op)) {
      const r = await rebaseRefusedOpen(op.operation_id, deps.rebaseDeps, actorUserId, { drain: false });
      if (r.kind === "rebased") out.rebased.push(op.operation_id);
      else if (r.kind === "receipt_found" && (await deps.requeue(op.operation_id))) out.receiptVerified.push(op.operation_id);
      else out.leftForReview.push(op.operation_id);
      continue;
    }
    out.leftForReview.push(op.operation_id);
  }
  const touched = out.receiptVerified.length + out.dependencyRecovered.length + out.rebased.length;
  if (touched > 0) await deps.drain("operator-force-sync");
  out.ran = true;
  out.text =
    `Force sync: ${out.receiptVerified.length} confirmed by Breadee's records, ${out.rebased.length} table open${out.rebased.length === 1 ? "" : "s"} re-checked and re-sent, ` +
    `${out.dependencyRecovered.length} waiting step${out.dependencyRecovered.length === 1 ? "" : "s"} released · ${out.leftForReview.length} still need${out.leftForReview.length === 1 ? "s" : ""} review (nothing was forced; no payment was re-collected).`;
  return out;
}

/** Live Force Sync deps (read-only checks + the existing queue primitives). */
export function liveForceSyncDeps(): ForceSyncDeps {
  return {
    hasReceipt: liveRebaseDeps.hasReceipt,
    rebaseDeps: liveRebaseDeps,
    drain: requestDrainAndWait,
    listParked: async () => (await import("@/lib/offline/db")).localdb.operations.where("status").equals("needs_attention").toArray(),
    getOp: getOperation,
    requeue: (id) => requeueOperation(id, { drain: false }),
    health: getBackendHealth,
  };
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
