// Phase E — offline dine-in TABLE RESTRUCTURE capture (move / merge of CANONICAL tables).
//
// Turns a Move or Merge into a durable Phase-B operation while offline, through the single operation
// log. Both operate on CANONICAL (hydrated) tables whose pos_entity_version is known from the loaded
// floor, so the capture carries that version as the CAS — on reconnect the server's locked re-read
// refuses a drifted bill (VERSION_CONFLICT → needs_attention), never a silent destructive move/merge.
// Replay is exactly-once on client_op_id and atomic server-side. This module holds NO authority — the
// canonical table/bill state is the source of truth after sync.

import {
  type OfflineOperation,
  type OperationScope,
  OPERATION_SCHEMA_VERSION,
  addOperation,
  getOperation,
} from "@/lib/offline/operationLog";
import { deterministicUuid } from "@/lib/offline/dineinOffline";

/** The immutable 5-dimensional scope a table-restructure op is captured + replayed under. */
export type TableOpScope = {
  tenantId: string;
  branchId: string | null; // OU
  cashierUserId: string;
  deviceId: string;
  terminalId: string | null;
};

function opScope(s: TableOpScope): OperationScope {
  return { tenant_id: s.tenantId, branch_id: s.branchId, device_id: s.deviceId, terminal_id: s.terminalId ?? "", cashier_user_id: s.cashierUserId };
}

export type CaptureTableOpResult = { operationId: string; clientOpId: string; alreadyCaptured: boolean };

/** Durably capture an offline table MOVE (pos_move_table). Deterministic client_op_id from the
 *  from/to pair so a double-tap of the same move collapses to one op; idempotent. */
export async function captureMoveTableOffline(input: {
  scope: TableOpScope;
  fromTableId: string;
  toTableId: string;
  expectedVersion: number | null;
}): Promise<CaptureTableOpResult> {
  const clientOpId = deterministicUuid([input.scope.tenantId, input.scope.branchId ?? "", input.scope.deviceId, input.scope.terminalId ?? "", "move_table", input.fromTableId, input.toTableId]);
  const operationId = "movetable:" + clientOpId;
  const existing = await getOperation(operationId);
  if (existing) return { operationId, clientOpId, alreadyCaptured: true };
  const op: OfflineOperation = {
    operation_id: operationId,
    operation_type: "move_table",
    schema_version: OPERATION_SCHEMA_VERSION,
    scope: opScope(input.scope),
    created_at: new Date().toISOString(),
    client_op_id: clientOpId,
    local_entity_id: null,
    canonical_entity_id: input.toTableId,
    dependency_ids: [],
    depends_on_local_entities: [],
    payload: { from_table_id: input.fromTableId, to_table_id: input.toTableId, expected_version: input.expectedVersion },
    status: "pending",
    retry_count: 0,
    last_attempt_at: null,
    last_error_code: null,
    last_error_message: null,
    result_meta: null,
    synced_at: null,
  };
  try {
    await addOperation(op);
  } catch (e) {
    const now = await getOperation(operationId);
    if (now) return { operationId, clientOpId, alreadyCaptured: true };
    throw e;
  }
  return { operationId, clientOpId, alreadyCaptured: false };
}

/** Durably capture an offline table MERGE (pos_merge_tables_v3). The caller passes the stable
 *  content-addressed client_op_id (the target-set signature) so re-submitting the SAME merge set is
 *  idempotent and a different set is a new op. `expected` is the per-table version-map CAS. */
export async function captureMergeTablesOffline(input: {
  scope: TableOpScope;
  primaryTableId: string;
  sourceTableIds: string[];
  expected: Record<string, number>;
  clientOpId: string;
}): Promise<CaptureTableOpResult> {
  const clientOpId = input.clientOpId;
  const operationId = "mergetables:" + clientOpId;
  const existing = await getOperation(operationId);
  if (existing) return { operationId, clientOpId, alreadyCaptured: true };
  const op: OfflineOperation = {
    operation_id: operationId,
    operation_type: "merge_tables",
    schema_version: OPERATION_SCHEMA_VERSION,
    scope: opScope(input.scope),
    created_at: new Date().toISOString(),
    client_op_id: clientOpId,
    local_entity_id: null,
    canonical_entity_id: input.primaryTableId,
    dependency_ids: [],
    depends_on_local_entities: [],
    payload: { primary_table_id: input.primaryTableId, source_table_ids: input.sourceTableIds, expected: input.expected },
    status: "pending",
    retry_count: 0,
    last_attempt_at: null,
    last_error_code: null,
    last_error_message: null,
    result_meta: null,
    synced_at: null,
  };
  try {
    await addOperation(op);
  } catch (e) {
    const now = await getOperation(operationId);
    if (now) return { operationId, clientOpId, alreadyCaptured: true };
    throw e;
  }
  return { operationId, clientOpId, alreadyCaptured: false };
}

/** Pure readiness for the offline table-op gate — ALLOWS a move/merge offline when the POS is
 *  offline-ready + scope present (the base tableOpGate blocks offline entirely). Close/Clear and
 *  order Transfer stay online-only (not covered here). */
export function evaluateTableOpOfflineReady(input: {
  online: boolean;
  offlineReady: boolean;
  hasScope: boolean;
}): boolean {
  if (input.online) return true;
  return input.offlineReady && input.hasScope;
}
