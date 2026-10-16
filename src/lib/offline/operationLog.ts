// Phase B — the generalized, typed, durable OFFLINE OPERATION LOG.
//
// One queue for every server-dependent mutation captured while offline. It REPLACES
// the role that the Takeaway-specific `posOfflineTxns` + `pendingShifts` stores played
// as replay sources: those remain as legacy/compat producers (migrated in, see
// migration.ts) but are no longer independently drained — the single orchestrator
// (orchestrator.ts) drains THIS log.
//
// Design rules (do not weaken):
//   * A business operation is DURABLE: once captured it must reach `synced` or
//     `needs_attention`. It is NEVER silently dropped and NEVER discarded by a
//     latest-wins/context rule (latest-wins applies only to context refresh, never to
//     a business op).
//   * Capture SCOPE (tenant/OU-branch/device/cashier + a permission snapshot) is
//     written once at creation and is IMMUTABLE. Replay revalidates live authority and
//     fails CLOSED on a scope mismatch — it never re-points an op at whatever branch is
//     selected now.
//   * Forward compatibility: every op carries a `schema_version`. An operation whose
//     (type, schema_version) has no registered handler is QUARANTINED
//     (`needs_attention`, reason `unknown_handler`) and never executed.

import { localdb } from "@/lib/offline/db";

/** The business operation types Phase B knows. Compat handlers only — Phase B adds NO
 *  new offline business capability. Future phases register new types here. */
export type OperationType =
  | "open_shift" // Case-2 offline-opened shift (was pendingShifts)
  | "takeaway_sale" // offline Takeaway/Delivery-cached sale: submit (+ optional cash pay) (was posOfflineTxns)
  // Phase C — offline Dine-In service continuity (certified Track-A contracts only):
  | "dinein_open_table" // occupy a table / establish the local session (→ pos_open_table)
  | "dinein_send_round" // send a round to the table's open order (→ pos_submit_order, expected_order_id-bound)
  // Phase D — bounded offline refund/void of a LOCALLY-HYDRATED canonical order (→ pos_void_order,
  // expected_version CAS + expected_refund_usd guard). Never against an ad-hoc/local-only order.
  | "void_refund"
  // Phase D — offline SETTLE (cash / dynamic tender). Exactly-once via client_op_id (the settle
  // RPCs already carry the server replay wrapper). pay_table settles a dine-in table bill
  // (→ pos_pay_table); pay_order settles a single order (→ pos_pay_order). Both may depend on the
  // session's open/round ops when the order/table was created offline.
  | "pay_table"
  | "pay_order"
  // Phase D — offline ON-ACCOUNT (receivable) against a LOCALLY-KNOWN (cached/canonical) customer.
  // on_account_table → pos_complete_table_on_account; on_account_order → pos_complete_on_account.
  // Exactly-once via client_op_id. An offline-created customer dependency arrives with Phase E.
  | "on_account_table"
  | "on_account_order"
  // Phase D — offline PAYOUT (petty-cash out of the drawer) → pos_payout_create (replay-safe,
  // records payout_id). Reduces the local drawer projection immediately; exactly-once on reconnect.
  | "payout"
  // Phase D — offline END SHIFT → pos_end_shift (replay-safe). Carries a dependency barrier on
  // EVERY prior shift-affecting op so the canonical close replays LAST, after all sales/payments/
  // refunds/payouts of the shift have synced. Local shift = ENDED_PENDING_SYNC until then.
  | "end_shift"
  // Phase D — offline SPLIT settle leg → pos_split_settle (replay-safe). ITEM-SUBSET split; amount
  // is server-derived from the allocated order-item quantities. Legs replay strictly in order
  // (each depends on the previous). Offline requires server order_item_ids (a hydrated/cached bill);
  // over-allocation / not-splittable / version drift → needs_attention. expected_version NULL offline.
  | "split_settle"
  // Phase E — offline CUSTOMER upsert (create / edit / add-or-edit address) → pos_upsert_customer
  // (replay-safe on client_op_id). A CREATE mints a local customer id (local_entity_id) resolved to
  // the canonical id on reconnect so a later offline delivery/on-account can chain to it; an EDIT
  // carries the canonical id and creates no local entity. A same-OU identity conflict replays as a
  // CONFLICT → needs_attention (never a silent duplicate / silent re-link).
  | "customer_upsert"
  // Phase E — offline ORDER ITEM EDIT of an open, unpaid order. edit_order_line → pos_edit_order_line
  // (set_quantity / change_modifiers; CAS expected_version + reason); add_order_items →
  // pos_add_order_items (CAS expected_version). Both replay-safe on client_op_id. A version drift
  // (the bill changed since it was loaded) → CONFLICT → needs_attention, never a blind re-apply. The
  // target order may be canonical (hydrated) or offline-created (order_local → canonical remap).
  | "edit_order_line"
  | "add_order_items"
  // Phase E — offline dine-in TABLE RESTRUCTURE of CANONICAL (hydrated) tables with open bills.
  // move_table → pos_move_table (CAS expected_version); merge_tables → pos_merge_tables_v3 (CAS
  // version-map). Both replay-safe on client_op_id + atomic server-side. Any version drift (a bill
  // changed/settled since the floor was loaded) → CONFLICT → needs_attention, never a silent
  // destructive move/merge. (Order TRANSFER stays online — its cross-cashier approval needs the
  // server to mediate.)
  | "move_table"
  | "merge_tables";

/** Durable lifecycle of a logged operation. Terminal = synced | cancelled. */
export type OperationStatus =
  | "pending" // captured, awaiting a drain
  | "blocked_dependency" // a prerequisite op is not yet synced
  | "syncing" // a drain pass is actively replaying it
  | "synced" // confirmed on the server (terminal success)
  | "retryable" // transient failure; will be retried with backoff
  | "needs_attention" // definitive refusal / unknown handler / dependency terminal — awaits a human
  | "cancelled"; // explicitly withdrawn (terminal); never auto-set by replay

/** How a failed replay attempt is classified (drives status + backoff). */
export type RetryClass =
  | "TRANSPORT_RETRYABLE" // network/transport; safe to retry (server idempotent)
  | "SERVER_RETRYABLE" // transient server error; bounded retry
  | "DEPENDENCY_BLOCKED" // a prerequisite is unresolved
  | "AUTHORITY_REFUSED" // permission/scope refusal → needs_attention
  | "CONFLICT" // server state conflict → needs_attention
  | "VALIDATION_TERMINAL" // definitive validation refusal → needs_attention
  | "UNKNOWN_HANDLER"; // no handler for (type, schema_version) → needs_attention (quarantine)

/** Immutable scope + authority snapshot captured at creation. Never rewritten. */
export type OperationScope = {
  tenant_id: string;
  branch_id: string | null; // OU/branch
  device_id: string;
  terminal_id: string;
  cashier_user_id: string;
  /** Permission keys the capturing session held, for later reconciliation/audit. Optional. */
  captured_permissions?: string[];
};

/** One durable operation envelope. PK = operation_id (client-minted uuid). */
export interface OfflineOperation {
  operation_id: string;
  operation_type: OperationType | string; // string tolerated so an unknown future type still stores + quarantines
  schema_version: number;
  scope: OperationScope;
  created_at: string; // client ISO at capture
  /** The immutable server-idempotency key for this op's canonical RPC(s). */
  client_op_id: string;
  /** Local id of the entity this op creates (shift/order/…), for dependency wiring. */
  local_entity_id: string | null;
  /** Canonical server id once resolved on reconnect. */
  canonical_entity_id: string | null;
  /** Operations that must be `synced` before this one may replay. */
  dependency_ids: string[];
  /** Local entity ids this op depends on (resolved to canonical before replay). */
  depends_on_local_entities: string[];
  /** The type-specific payload the handler replays. Opaque to the orchestrator. */
  payload: unknown;
  status: OperationStatus;
  retry_count: number;
  last_attempt_at: string | null;
  last_error_code: string | null; // a RetryClass or a short code
  last_error_message: string | null;
  /** Result metadata from a successful replay (safe summary, no sensitive payload). */
  result_meta: Record<string, unknown> | null;
  synced_at: string | null;
}

/** The schema version new captures are written at. Bump when the envelope/payload shape changes. */
export const OPERATION_SCHEMA_VERSION = 1;

/** Statuses that still hold unsynced work (must never be GC'd). */
export const UNSETTLED_STATUSES: OperationStatus[] = [
  "pending",
  "blocked_dependency",
  "syncing",
  "retryable",
  "needs_attention",
];

/** Durably append a new operation BEFORE the UI reports success. Returns its id. */
export async function addOperation(op: OfflineOperation): Promise<string> {
  await localdb.operations.add(op);
  return op.operation_id;
}

/** Patch one operation by id. */
export async function updateOperation(operationId: string, patch: Partial<OfflineOperation>): Promise<void> {
  await localdb.operations.update(operationId, patch);
}

/** One operation by id. */
export async function getOperation(operationId: string): Promise<OfflineOperation | undefined> {
  return localdb.operations.get(operationId);
}

/** Every operation, newest first — for the Sync Center / diagnostics. */
export async function listOperations(): Promise<OfflineOperation[]> {
  return localdb.operations.orderBy("created_at").reverse().toArray();
}

/** Count of operations still holding unsynced work (pending badge source of truth). */
export async function unsettledOperationCount(): Promise<number> {
  const all = await localdb.operations.where("status").anyOf(UNSETTLED_STATUSES).count();
  return all;
}

/**
 * Operations ready for a drain pass, in FIFO capture order, scoped to the EXACT live
 * context. An op for another tenant/branch/cashier/device is never returned here (it is
 * not ours to replay in this session). `needs_attention`/`synced`/`cancelled` are excluded;
 * `blocked_dependency` is included so the orchestrator can re-evaluate its prerequisites.
 */
export async function claimableOperations(scope: {
  tenantId: string | null;
  branchId: string | null;
  cashierUserId: string | null;
  deviceId: string | null;
}): Promise<OfflineOperation[]> {
  const rows = await localdb.operations
    .where("status")
    .anyOf(["pending", "blocked_dependency", "retryable", "syncing"])
    .toArray();
  return rows
    .filter(
      (o) =>
        o.scope.tenant_id === scope.tenantId &&
        (o.scope.branch_id ?? null) === (scope.branchId ?? null) &&
        o.scope.cashier_user_id === scope.cashierUserId &&
        o.scope.device_id === scope.deviceId,
    )
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}
