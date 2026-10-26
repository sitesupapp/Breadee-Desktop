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
/** 1.0.38 (C5) — a staged sale op that has NOT carried a payment intent yet and can still take one:
 *  not synced (that path re-opens), not syncing (in flight / crashed — replays first), not cancelled. */
function needsPaymentBridge(op: OfflineOperation): boolean {
  if (op.status === "synced" || op.status === "syncing" || op.status === "cancelled") return false;
  return !(op.payload as { payment_intent?: unknown } | null)?.payment_intent;
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
      // 1.0.38 (Bug 3) — OPEN(N+1) captured after an offline CLOSE(N) replays strictly after that close
      // (the existing dependency gate; a refused / cancelled close parks it as dependency_failed), and it
      // must CREATE a shift: require_new makes the server refuse instead of adopting an open one.
      dependency_ids: s.after_end_op_id ? [s.after_end_op_id] : [],
      depends_on_local_entities: [],
      payload: s.after_end_op_id
        ? { branchId: s.branch_id, openingCash: s.opening_cash_amount, require_new: true, after_end_op_id: s.after_end_op_id, generation: s.generation ?? null }
        : { branchId: s.branch_id, openingCash: s.opening_cash_amount },
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
          // rc.14 — MERGE over the op's payload: its remap fields (shift_local / customer_local /
          // address_local) stay with the logical order (rc.13 replaced the payload and dropped them).
          payload: { ...((existingTxnOp.payload as object | null) ?? {}), order_payload: t.order_payload, payment_intent: t.payment_intent, paid: t.paid === true },
          last_error_code: null,
          last_error_message: null,
        });
      } else if (t.payment_intent && needsPaymentBridge(existingTxnOp)) {
        // 1.0.38 (C5) — a cash payment taken AFTER a connection flap. The flap staged the unpaid send
        // (payment_intent null) but did not finish replaying it (pending / retryable / blocked /
        // needs_attention); the later offline Pay wrote the intent to the LEGACY row only. Through 1.0.37
        // the bridge fired only for a synced op, so the op replayed submit-only → synced → the legacy
        // row was reconciled as synced and the payment was never replayed (drawer short, order Open).
        // Merge the intent into the not-yet-synced op EXACTLY ONCE (the op then carries it, so this
        // branch never fires again), keeping its status, canonical id and remap fields. A syncing op
        // (crashed mid-replay) is left alone: it replays as is and the synced re-open bridge above then
        // carries the payment. A cancelled op is never resurrected.
        const prev = (existingTxnOp.payload as { paid?: unknown } | null) ?? {};
        await localdb.operations.update(id, {
          payload: { ...prev, order_payload: t.order_payload, payment_intent: t.payment_intent, paid: prev.paid === true || t.paid === true },
        });
      } else {
        report.skippedAlreadyMigrated++;
      }
      continue;
    }
    const dependsShift = t.pending_shift_local_id ?? null;
    // Phase E (E3): a delivery order against an OFFLINE-CREATED customer/address carries their LOCAL
    // ids. They must resolve (via the customer_upsert op) before this order submits, so they join
    // the dependency barrier and the handler remaps them into order_payload before pos_submit_order.
    const customerLocal = t.customer_local ?? null;
    const addressLocal = t.address_local ?? null;
    // Gate on the shift + the CUSTOMER local (both are op local_entity_ids the orchestrator tracks).
    // The ADDRESS local is resolved by the SAME customer_upsert (into the entity map) as a side
    // effect, so gating on the customer guarantees the address is resolvable; the handler reads it
    // from the map at replay. (An op's dependency gate only recognises local_entity_id resolutions,
    // not a handler-written mapping, so the address must NOT be a gate here.)
    const localDeps = [dependsShift, customerLocal].filter((x): x is string => x != null);
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
      depends_on_local_entities: localDeps,
      payload: { order_payload: t.order_payload, payment_intent: t.payment_intent, paid: t.paid === true, shift_local: dependsShift, customer_local: customerLocal, address_local: addressLocal },
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
        // 1.0.38 (C5) — a payment captured on the legacy row while this op was replaying submit-only:
        // never mark the row synced over it (that ended the bridge forever); leave it queued so the next
        // migrate re-opens the synced op with the payment (the synced → pending bridge).
        const row = await localdb.posOfflineTxns.get(localId);
        if (row && row.status === "queued" && row.payment_intent && !(op.payload as { payment_intent?: unknown } | null)?.payment_intent) continue;
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
