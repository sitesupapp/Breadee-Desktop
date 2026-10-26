// 1.0.38 (Bug 7) — the ONE read model behind every Sync Center entry point.
//
// Before 1.0.38 the device had two Sync Centers that disagreed: Settings → Sync Center read the
// legacy `outbox` (which nothing writes any more) and therefore always said "All changes are
// synced", while the POS Sync Center read the live operations log. Both entry points now render
// the same SyncCenterPanel, and every number, state and label they show comes from here:
//
//   - the authoritative operations log (unsettled ops via the status index — bounded by the
//     unsettled set, never a whole-history scan per tick), scoped to tenant + branch exactly as POS;
//   - offline captures still waiting in the legacy capture stores that the next drain has not yet
//     staged into the log (via summarizeOperations; read-only), so the operator is never told
//     "all synced" while a sale is waiting;
//   - one shared label/definition map.
//
// READ-ONLY. Nothing in this module writes: opening a Sync Center never mutates, migrates, replays
// or drains. The only write a Sync Center performs is the explicit per-operation "Try again"
// (requeueOperation), which the panel calls on a click.

import { localdb } from "@/lib/offline/db";
import { summarizeOperations, type OfflineOperation } from "@/lib/offline/operationLog";

/** Every state an operator can see, across both entry points. */
export type SyncDisplayState =
  | "pending"
  | "blocked_dependency"
  | "syncing"
  | "synced"
  | "retryable"
  | "needs_attention"
  | "conflict"
  | "manager_review"
  | "cancelled";

export type SyncStateDef = {
  label: string;
  /** One plain sentence: what the state means and what happens next. */
  definition: string;
  tone: "green" | "amber" | "red" | "slate" | "brand";
};

/** The ONE label/definition map. Both Sync Centers (POS dialog + Settings) render from it. */
export const SYNC_STATE_DEFS: Record<SyncDisplayState, SyncStateDef> = {
  pending: { label: "Pending", definition: "Saved on this terminal and waiting for the next sync.", tone: "brand" },
  blocked_dependency: {
    label: "Waiting for dependency",
    definition: "Waits for an earlier step (for example its shift or customer) to sync first.",
    tone: "brand",
  },
  syncing: { label: "Syncing", definition: "Being sent to Breadee right now.", tone: "brand" },
  synced: { label: "Synced", definition: "Confirmed by Breadee.", tone: "green" },
  retryable: {
    label: "Will retry",
    definition: "A temporary problem (such as the connection) stopped it; it is retried automatically.",
    tone: "brand",
  },
  needs_attention: {
    label: "Needs attention",
    definition: "Breadee could not accept it. It is kept safely and is not retried until a manager reviews it.",
    tone: "amber",
  },
  conflict: {
    label: "Conflict",
    definition: "It clashes with a change already made in Breadee. A manager must review it.",
    tone: "red",
  },
  manager_review: {
    label: "Manager review",
    definition: "A record kept from an older version of the app for review. It is never sent automatically.",
    tone: "amber",
  },
  cancelled: { label: "Cancelled", definition: "Withdrawn; it will not be sent.", tone: "slate" },
};

/** Display order for the legend. */
export const SYNC_STATE_ORDER: SyncDisplayState[] = [
  "pending",
  "blocked_dependency",
  "syncing",
  "retryable",
  "synced",
  "needs_attention",
  "conflict",
  "manager_review",
  "cancelled",
];

/** Quarantined legacy outbox records (migration.ts → `legacy_outbox:<kind>`, never replayed). */
export function isLegacyQuarantine(operationType: string | null | undefined): boolean {
  return String(operationType ?? "").startsWith("legacy_outbox:");
}

/** 1.0.38 (G1) — the handlers' structured server-CONFLICT codes (the server state changed elsewhere: a bill
 *  closed / changed / moved, a version drift). Through 1.0.38-dev only the literal class "CONFLICT" mapped
 *  here, so a real refusal (e.g. a round on an already-closed bill) never showed as a Conflict anywhere. */
const CONFLICT_ERROR_CODES = new Set([
  "CONFLICT",
  "expected_order_mismatch",
  "version_conflict",
  "settle_conflict",
  "split_conflict",
  "already_settled",
  "already_paid",
  "pay_bill_changed",
  "pay_amount_changed",
  "payment_residue",
  "on_account_bill_changed",
  "on_account_amount_changed",
  "move_source_changed",
  "move_source_empty",
  "move_payment_state_changed",
  "move_dest_occupied",
  "merge_bill_changed",
  "merge_payment_state_changed",
  "merge_primary_empty",
  "merge_source_empty",
  "merge_expected_mismatch",
  "move_table_conflict",
  "merge_tables_conflict",
]);

/**
 * Map a raw operation status (+ its error class and type) to the operator-facing state. A parked
 * op is split three ways so the operator knows what kind of review it needs: a server CONFLICT,
 * a historical legacy record (manager review), or any other refusal (needs attention).
 */
export function displayStateOf(status: string, errorCode?: string | null, operationType?: string | null): SyncDisplayState {
  switch (status) {
    case "pending":
    case "blocked_dependency":
    case "syncing":
    case "synced":
    case "retryable":
    case "cancelled":
      return status;
    case "needs_attention":
      if (isLegacyQuarantine(operationType)) return "manager_review";
      if (errorCode && CONFLICT_ERROR_CODES.has(errorCode)) return "conflict";
      return "needs_attention";
    default:
      // An unknown future status is never shown as synced.
      return "needs_attention";
  }
}

/** Short operator label for a raw status. */
export function statusLabel(status: string, errorCode?: string | null, operationType?: string | null): string {
  return SYNC_STATE_DEFS[displayStateOf(status, errorCode, operationType)].label;
}

/** "Try again on next sync" is offered for a parked op a retry can actually help — never for a
 *  quarantined legacy record (it has no handler; a retry would only park it again). */
export function canRetry(state: SyncDisplayState): boolean {
  return state === "needs_attention" || state === "conflict";
}

export type SyncSummary = {
  pending: number;
  waiting: number;
  syncing: number;
  retrying: number;
  needsAttention: number;
  conflict: number;
  managerReview: number;
  synced: number;
  /** Offline sales / offline-opened shifts captured but not yet staged into the operations log by a
   *  drain (counted inside `pending`). */
  notYetQueued: number;
  /** Work that will still be sent: pending + waiting + syncing + retrying. */
  toSync: number;
  /** Work parked for a human: needs attention + conflict + manager review. */
  parked: number;
};

export const EMPTY_SUMMARY: SyncSummary = {
  pending: 0,
  waiting: 0,
  syncing: 0,
  retrying: 0,
  needsAttention: 0,
  conflict: 0,
  managerReview: 0,
  synced: 0,
  notYetQueued: 0,
  toSync: 0,
  parked: 0,
};

const inScope = (tenantId: string, branchId: string | null) => (scope: { tenant_id: string; branch_id: string | null }) =>
  scope.tenant_id === tenantId && (branchId == null || (scope.branch_id ?? null) === branchId);

/** Pure roll-up of a set of operations already filtered to the scope. */
export function summarize(ops: Pick<OfflineOperation, "status" | "last_error_code" | "operation_type">[], notYetQueued = { pending: 0, needsAttention: 0 }): SyncSummary {
  const s = { ...EMPTY_SUMMARY };
  for (const o of ops) {
    switch (displayStateOf(o.status, o.last_error_code, String(o.operation_type))) {
      case "pending": s.pending++; break;
      case "blocked_dependency": s.waiting++; break;
      case "syncing": s.syncing++; break;
      case "retryable": s.retrying++; break;
      case "synced": s.synced++; break;
      case "needs_attention": s.needsAttention++; break;
      case "conflict": s.conflict++; break;
      case "manager_review": s.managerReview++; break;
      default: break; // cancelled: terminal, not counted
    }
  }
  s.pending += notYetQueued.pending;
  s.needsAttention += notYetQueued.needsAttention;
  s.notYetQueued = notYetQueued.pending + notYetQueued.needsAttention;
  s.toSync = s.pending + s.waiting + s.syncing + s.retrying;
  s.parked = s.needsAttention + s.conflict + s.managerReview;
  return s;
}

/**
 * The scoped summary every Sync Center surface shows (POS chip, Sync Center panel, Shell and
 * Dashboard badges). Built on the op log's own `summarizeOperations` (status-index reads + legacy
 * capture rows not yet staged), so these numbers agree with the POS status-bar badge; the only extra
 * read splits the parked (needs_attention) set — bounded by that status index — into needs attention /
 * conflict / manager review. `includeSynced` adds the synced count (the panel's summary line); badges
 * skip it. Branch null = tenant-wide, as the Sync Center rows and history (POS semantics).
 */
export async function loadSyncSummary(
  tenantId: string | null,
  branchId: string | null,
  opts: { includeSynced?: boolean } = {},
): Promise<SyncSummary> {
  if (!tenantId) return { ...EMPTY_SUMMARY };
  const base = await summarizeOperations({ tenantId, branchId: branchId ?? undefined }, { includeSynced: opts.includeSynced === true });
  const match = inScope(tenantId, branchId);
  const parked = (await localdb.operations.where("status").equals("needs_attention").toArray()).filter((o) => match(o.scope));
  const split = summarize(parked);
  const s: SyncSummary = {
    pending: base.pending + base.legacy_pending,
    waiting: base.waiting_dependency,
    syncing: base.syncing,
    retrying: base.retryable,
    needsAttention: split.needsAttention,
    conflict: split.conflict,
    managerReview: split.managerReview,
    synced: opts.includeSynced ? base.synced : 0,
    notYetQueued: base.legacy_pending,
    toSync: 0,
    parked: 0,
  };
  s.toSync = s.pending + s.waiting + s.syncing + s.retrying;
  s.parked = s.needsAttention + s.conflict + s.managerReview;
  return s;
}

export type SyncChip = { text: string; kind: "attention" | "pending" | "clear" };

/** Chip/headline text. Parked work dominates, then work still to send; "All changes synced" ONLY
 *  when nothing in scope is pending, waiting, syncing, retrying or parked. */
export function chipOf(s: SyncSummary): SyncChip {
  if (s.parked > 0) return { text: `${s.parked} needs attention`, kind: "attention" };
  if (s.toSync > 0) return { text: `${s.toSync} pending`, kind: "pending" };
  return { text: "All changes synced", kind: "clear" };
}
