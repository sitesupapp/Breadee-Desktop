// Phase D — offline END SHIFT capture (D6).
//
// Captures a durable `end_shift` op whose DEPENDENCY BARRIER is every prior shift-affecting op in
// the same immutable scope, so on reconnect the canonical close (pos_end_shift) replays LAST —
// only after every sale / payment / refund / payout / on-account of the shift has reached `synced`.
// The op is the durable record (deterministic id → restart/double-tap idempotent); the cashier's
// local shift is treated as ENDED_PENDING_SYNC by the UI, never canonically closed until this op
// drains. A server conflict (shift changed/closed elsewhere) surfaces as needs_attention — never a
// silent reopen/reclose.

import { localdb } from "@/lib/offline/db";
import {
  type OfflineOperation,
  OPERATION_SCHEMA_VERSION,
  getOperation,
} from "@/lib/offline/operationLog";
import type { OperationScope } from "@/lib/offline/operationLog";
import { deterministicUuid } from "@/lib/offline/dineinOffline";

export type EndShiftScope = {
  tenantId: string;
  branchId: string | null;
  cashierUserId: string;
  deviceId: string;
  terminalId: string | null;
};

function opScope(s: EndShiftScope): OperationScope {
  return { tenant_id: s.tenantId, branch_id: s.branchId, device_id: s.deviceId, terminal_id: s.terminalId ?? "", cashier_user_id: s.cashierUserId };
}

function inScope(op: OfflineOperation, s: EndShiftScope): boolean {
  return (
    op.scope.tenant_id === s.tenantId &&
    (op.scope.branch_id ?? null) === (s.branchId ?? null) &&
    op.scope.cashier_user_id === s.cashierUserId &&
    op.scope.device_id === s.deviceId &&
    (s.terminalId == null || (op.scope.terminal_id || null) === s.terminalId)
  );
}

const END_SHIFT_OP_PREFIX = "endshift:";

/**
 * Durably capture an offline End Shift. The dependency barrier is a snapshot of EVERY non-terminal,
 * non-end_shift op in this exact scope — the orchestrator will not replay the close until all of
 * them are `synced`. Deterministic op id (scope + shift) makes a double-tap / restart idempotent.
 */
export async function captureEndShiftOffline(input: {
  scope: EndShiftScope;
  /** Canonical shift id (hydrated shift) — null when the shift was opened offline. */
  shiftId: string | null;
  /** Local open-shift entity id (offline-opened shift) to remap to canonical on reconnect. */
  shiftLocal: string | null;
  actualCashCounted: number;
  notes: string | null;
  deliveryFeeCashTreatment?: string;
}): Promise<{ operationId: string; clientOpId: string; alreadyCaptured: boolean; dependencyCount: number }> {
  return localdb.transaction("rw", localdb.operations, async () => {
    const key = input.shiftId ?? input.shiftLocal ?? "";
    const clientOpId = deterministicUuid([input.scope.tenantId, input.scope.branchId ?? "", input.scope.cashierUserId, input.scope.deviceId, input.scope.terminalId ?? "", "end_shift", key]);
    const operationId = END_SHIFT_OP_PREFIX + clientOpId;
    const existing = await getOperation(operationId);
    if (existing) return { operationId, clientOpId, alreadyCaptured: true, dependencyCount: existing.dependency_ids.length };

    // The barrier: every prior op in this scope that is not itself an end_shift and not terminal
    // (synced ops are already satisfied; cancelled ops are excluded). Each must reach `synced`.
    const all = await localdb.operations.toArray();
    const dependencyIds = all
      .filter((o) => o.operation_type !== "end_shift" && o.status !== "cancelled" && inScope(o, input.scope))
      .map((o) => o.operation_id);

    const op: OfflineOperation = {
      operation_id: operationId,
      operation_type: "end_shift",
      schema_version: OPERATION_SCHEMA_VERSION,
      scope: opScope(input.scope),
      created_at: new Date().toISOString(),
      client_op_id: clientOpId,
      local_entity_id: null,
      canonical_entity_id: input.shiftId,
      dependency_ids: dependencyIds,
      depends_on_local_entities: input.shiftLocal ? [input.shiftLocal] : [],
      payload: {
        shift_id: input.shiftId,
        shift_local: input.shiftLocal,
        actual_cash_counted: input.actualCashCounted,
        notes: input.notes,
        ...(input.deliveryFeeCashTreatment ? { delivery_fee_cash_treatment: input.deliveryFeeCashTreatment } : {}),
      },
      status: "pending",
      retry_count: 0,
      last_attempt_at: null,
      last_error_code: null,
      last_error_message: null,
      result_meta: null,
      synced_at: null,
    };
    await localdb.operations.add(op);
    return { operationId, clientOpId, alreadyCaptured: false, dependencyCount: dependencyIds.length };
  });
}

/** The captured end_shift op for this scope (for the UI to show ENDED_PENDING_SYNC), or undefined. */
export async function findEndShiftOp(scope: EndShiftScope): Promise<OfflineOperation | undefined> {
  const rows = await localdb.operations.where("operation_type").equals("end_shift").toArray();
  return rows.find((o) => inScope(o, scope));
}
