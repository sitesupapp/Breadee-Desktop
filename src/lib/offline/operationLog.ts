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
  | "pay_order";

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
