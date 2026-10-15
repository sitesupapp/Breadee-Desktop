// Phase B — controlled migration of the legacy durable stores into the operation log.
//
// Moves pendingShifts (Case-2 shifts) and posOfflineTxns (Takeaway/Delivery-cached
// sales) into `operations`, and quarantines any dormant `outbox` record. Properties
// (Gate 3): crash-resumable, app-restart safe, idempotent, no duplicate business
// operation, no loss of queued work, no deletion of unresolved/needs_attention rows,
// rollback-safe (source rows are NEVER deleted — they are simply no longer drained,
// because syncPosTxns now delegates to the single orchestrator over `operations`).
//
// Idempotency + crash-resumability come from DETERMINISTIC operation ids derived from
// the source row id: re-running (after a crash, or on every drain) skips rows already
// migrated instead of duplicating them.

import { localdb } from "@/lib/offline/db";
import {
  type OfflineOperation,
  type OperationStatus,
  OPERATION_SCHEMA_VERSION,
} from "@/lib/offline/operationLog";
import type { PendingShift, PosOfflineTxn, PendingShiftStatus, PosOfflineTxnStatus } from "@/lib/offline/db";
import { resolveEntity } from "@/lib/offline/entityMap";
import { getDeviceIdentity } from "@/lib/device";

export type MigrationReport = {
  shiftsMigrated: number;
  txnsMigrated: number;
  outboxQuarantined: number;
  skippedAlreadyMigrated: number;
};

const shiftOpId = (localShiftId: string) => `mig:shift:${localShiftId}`;
const txnOpId = (localTxnId: string) => `mig:txn:${localTxnId}`;
const outboxOpId = (id: number) => `mig:outbox:${id}`;

function shiftStatus(s: PendingShiftStatus): OperationStatus {
  if (s === "synced") return "synced";
  if (s === "needs_attention") return "needs_attention";
  return "pending"; // pending_sync
}
function txnStatus(s: PosOfflineTxnStatus): OperationStatus {
  if (s === "synced") return "synced";
  if (s === "needs_attention") return "needs_attention";
  return "pending"; // queued | syncing (syncing is transient → re-drain safely)
}

/**
 * Run the legacy→operation-log migration. Idempotent; safe to call at the start of every
 * drain. Returns a count report. Never deletes source rows. Never replays — it only
 * stages the work for the orchestrator (which is the sole replayer).
 */
export async function migrateLegacyToOperations(): Promise<MigrationReport> {
  const report: MigrationReport = { shiftsMigrated: 0, txnsMigrated: 0, outboxQuarantined: 0, skippedAlreadyMigrated: 0 };
  const dev = getDeviceIdentity();

  // --- pendingShifts -> open_shift operations ---
  const shifts = await localdb.pendingShifts.toArray();
  for (const s of shifts) {
    const id = shiftOpId(s.local_shift_id);
    if (await localdb.operations.get(id)) { report.skippedAlreadyMigrated++; continue; }
    const op: OfflineOperation = {
      operation_id: id,
      operation_type: "open_shift",
      schema_version: OPERATION_SCHEMA_VERSION,
      scope: {
        tenant_id: s.tenant_id,
        branch_id: s.branch_id,
        device_id: s.device_id,
        terminal_id: s.terminal_id,
        cashier_user_id: s.cashier_user_id,
      },
      created_at: s.opened_at,
      client_op_id: s.client_op_id,
      local_entity_id: s.local_shift_id,
      canonical_entity_id: s.server_shift_id ?? null,
      dependency_ids: [],
      depends_on_local_entities: [],
      payload: { branchId: s.branch_id, openingCash: s.opening_cash_amount },
      status: shiftStatus(s.status),
      retry_count: s.attempts ?? 0,
      last_attempt_at: null,
      last_error_code: null,
      last_error_message: s.last_error ?? null,
      result_meta: s.server_shift_id ? { shift_id: s.server_shift_id } : null,
      synced_at: s.status === "synced" ? s.opened_at : null,
    };
    await localdb.operations.add(op);
    // Seed the entity map for an already-synced shift so dependent sales remap.
    if (s.status === "synced" && s.server_shift_id) {
      await resolveEntity({ local_entity_id: s.local_shift_id, entity_type: "shift", canonical_id: s.server_shift_id, resolved_at: new Date().toISOString(), tenant_id: s.tenant_id, branch_id: s.branch_id, device_id: s.device_id, cashier_user_id: s.cashier_user_id, terminal_id: s.terminal_id });
    }
    report.shiftsMigrated++;
  }

  // --- posOfflineTxns -> takeaway_sale operations ---
  const txns = await localdb.posOfflineTxns.toArray();
  for (const t of txns) {
    const id = txnOpId(t.local_txn_id);
    const existingTxnOp = await localdb.operations.get(id);
    if (existingTxnOp) {
      // Second-phase re-capture bridge. The capture layer re-queues a SYNCED sale row to
      // carry a later phase on the SAME logical order — classically a cash payment taken
      // after an unpaid offline send. Mirror that re-queue into the op: re-open it and
      // refresh the mutable fields from the row, while PRESERVING canonical_entity_id and
      // result_meta (merge update) so the handler pays the existing order and NEVER
      // re-submits. Only a synced op paired with a re-queued ("queued") row triggers this;
      // a needs_attention requeue stays operator-driven (requeueForAttention), and an op
      // still mid-flight (pending/syncing/retryable/blocked) is left untouched — so the
      // migration remains idempotent on an unchanged store.
      if (t.status === "queued" && existingTxnOp.status === "synced") {
        await localdb.operations.update(id, {
          status: "pending",
          payload: { order_payload: t.order_payload, payment_intent: t.payment_intent, paid: t.paid === true },
          last_error_code: null,
          last_error_message: null,
        });
      } else {
        report.skippedAlreadyMigrated++;
      }
      continue;
    }
    const dependsShift = t.pending_shift_local_id ?? null;
    const op: OfflineOperation = {
      operation_id: id,
      operation_type: "takeaway_sale",
      schema_version: OPERATION_SCHEMA_VERSION,
      scope: {
        tenant_id: t.tenant_id,
        branch_id: t.branch_id,
        device_id: t.device_id,
        terminal_id: t.terminal_id,
        cashier_user_id: t.cashier_user_id,
      },
      created_at: t.created_at,
      client_op_id: t.client_op_id,
      local_entity_id: t.local_txn_id,
      canonical_entity_id: t.server_order_id ?? null,
      dependency_ids: dependsShift ? [shiftOpId(dependsShift)] : [],
      depends_on_local_entities: dependsShift ? [dependsShift] : [],
      payload: { order_payload: t.order_payload, payment_intent: t.payment_intent, paid: t.paid === true },
      status: txnStatus(t.status),
      retry_count: t.attempts ?? 0,
      last_attempt_at: t.last_attempt_at ?? null,
      last_error_code: null,
      last_error_message: t.last_error ?? null,
      result_meta: t.server_order_number ? { order_number: t.server_order_number } : null,
      synced_at: t.status === "synced" ? (t.last_attempt_at ?? t.created_at) : null,
    };
    await localdb.operations.add(op);
    if (t.status === "synced" && t.server_order_id) {
      await resolveEntity({ local_entity_id: t.local_txn_id, entity_type: "order", canonical_id: t.server_order_id, resolved_at: new Date().toISOString(), tenant_id: t.tenant_id, branch_id: t.branch_id, device_id: t.device_id, cashier_user_id: t.cashier_user_id, terminal_id: t.terminal_id });
    }
    report.txnsMigrated++;
  }

  // --- dormant outbox -> QUARANTINE (visible, never replayed) ---
  // The generic outbox was written by `enqueue` but never had a replayer. Per the GO we
  // do NOT blindly replay it: every record becomes a needs_attention operation so it is
  // visible in Sync History, and is never executed (no handler registered for its type).
  const outbox = await localdb.outbox.toArray();
  for (const o of outbox) {
    if (o.id == null) continue;
    const id = outboxOpId(o.id);
    if (await localdb.operations.get(id)) { report.skippedAlreadyMigrated++; continue; }
    const op: OfflineOperation = {
      operation_id: id,
      operation_type: `legacy_outbox:${o.kind}`,
      schema_version: OPERATION_SCHEMA_VERSION,
      scope: {
        tenant_id: o.tenant_id,
        branch_id: o.branch_id,
        device_id: o.device_id ?? dev.device_id,
        terminal_id: o.terminal_id ?? dev.terminal_id,
        cashier_user_id: o.user_id,
      },
      created_at: o.created_at,
      client_op_id: `outbox-${o.id}`,
      local_entity_id: null,
      canonical_entity_id: null,
      dependency_ids: [],
      depends_on_local_entities: [],
      payload: { kind: o.kind, note: o.note ?? null },
      status: "needs_attention",
      retry_count: 0,
      last_attempt_at: null,
      last_error_code: "unknown_handler",
      last_error_message: "legacy outbox record — quarantined, not replayed",
      result_meta: null,
      synced_at: null,
    };
    await localdb.operations.add(op);
    report.outboxQuarantined++;
  }

  return report;
}

/**
 * Mirror the TERMINAL state of each migrated operation back onto its legacy source row,
 * so the existing legacy-backed UI (pending badge, Resume banner, shift state) stays
 * consistent now that the orchestrator — not the legacy loop — owns replay. Only moves a
 * legacy row to synced/needs_attention when its operation reached that state; never
 * resurrects or deletes anything. Idempotent.
 */
export async function reconcileLegacyFromOperations(): Promise<void> {
  const ops = await localdb.operations.toArray();
  for (const op of ops) {
    if (op.operation_type === "open_shift" && op.operation_id.startsWith("mig:shift:")) {
      const localId = op.operation_id.slice("mig:shift:".length);
      if (op.status === "synced" && op.canonical_entity_id) {
        await localdb.pendingShifts.update(localId, { status: "synced", server_shift_id: op.canonical_entity_id });
      } else if (op.status === "needs_attention") {
        await localdb.pendingShifts.update(localId, { status: "needs_attention", review_reason: op.last_error_code ?? "needs_attention" });
      }
    } else if (op.operation_type === "takeaway_sale" && op.operation_id.startsWith("mig:txn:")) {
      const localId = op.operation_id.slice("mig:txn:".length);
      if (op.status === "synced") {
        const orderNumber = (op.result_meta?.order_number as string | undefined) ?? undefined;
        // Mirror the remap: the handler rewrote order_payload.shift_id to the canonical
        // server shift and cleared the local dependency, so the legacy row reflects it too.
        const remappedPayload = (op.payload as { order_payload?: unknown } | null)?.order_payload;
        const remappedShift = (remappedPayload as { shift_id?: string } | undefined)?.shift_id;
        const hadDependency = op.depends_on_local_entities.length > 0;
        await localdb.posOfflineTxns.update(localId, {
          status: "synced",
          server_order_id: op.canonical_entity_id ?? undefined,
          server_order_number: orderNumber,
          paid: ((op.payload as { payment_intent?: unknown } | null)?.payment_intent ? true : undefined),
          // Mirror the handler's durable remap onto the legacy row (both the top-level
          // shift_id and the embedded order_payload.shift_id) and clear the dependency.
          ...(hadDependency ? { pending_shift_local_id: null, shift_id: remappedShift, order_payload: remappedPayload } : {}),
          last_error: null,
          review_reason: null,
        });
      } else if (op.status === "needs_attention") {
        await localdb.posOfflineTxns.update(localId, { status: "needs_attention", review_reason: op.last_error_code ?? "needs_attention" });
      }
    }
  }
}
