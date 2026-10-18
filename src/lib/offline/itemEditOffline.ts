// Phase E — offline ORDER ITEM EDIT capture (edit a line / add lines of an open, unpaid order).
//
// Turns a delivery item edit into a durable Phase-B operation while offline, through the single
// operation log. The UI already builds the exact pos_edit_order_line / pos_add_order_items payload
// (carrying expected_version + client_op_id + reason) and captures {opId, expectedVersion} once per
// logical edit, reusing them on retry — so offline we simply CAPTURE that payload instead of calling
// the RPC. Replay is exactly-once on client_op_id; the CAS (expected_version) in the payload means a
// bill that changed since it was loaded replays as a CONFLICT → needs_attention, never a blind
// re-apply. The target order is canonical (hydrated) or, when it was itself created offline, carried
// as order_local and remapped to the canonical id on reconnect. This module holds NO authority — the
// server edit RPC is the source of truth after sync.

import {
  type OfflineOperation,
  type OperationScope,
  OPERATION_SCHEMA_VERSION,
  addOperation,
  getOperation,
} from "@/lib/offline/operationLog";
import type { EditTargetRef } from "@/lib/offline/handlers";

/** The immutable 5-dimensional scope an offline item edit is captured + replayed under. */
export type ItemEditScope = {
  tenantId: string;
  branchId: string | null; // OU
  cashierUserId: string;
  deviceId: string;
  terminalId: string | null;
};

function opScope(s: ItemEditScope): OperationScope {
  return { tenant_id: s.tenantId, branch_id: s.branchId, device_id: s.deviceId, terminal_id: s.terminalId ?? "", cashier_user_id: s.cashierUserId };
}

export type CaptureItemEditResult = { operationId: string; clientOpId: string; alreadyCaptured: boolean };

/** rc.9 — the projection-derived replay chain for an item edit (see operationalProjection):
 *  targetRef = which line (resolved to a canonical order_item id at replay); versionAfterOp = the prior
 *  version-bumping op of this order (its server-returned version is the exact expected_version);
 *  dependencyIds = the ops that must sync first (that prior op + the op that created the target line). */
export type ItemEditChain = {
  targetRef?: EditTargetRef | null;
  versionAfterOp?: string | null;
  dependencyIds?: string[];
};

async function capture(
  prefix: string,
  opType: "edit_order_line" | "add_order_items",
  input: { scope: ItemEditScope; orderId: string | null; orderLocal: string | null; payload: Record<string, unknown>; clientOpId: string; chain?: ItemEditChain; previewItems?: unknown[] },
): Promise<CaptureItemEditResult> {
  const clientOpId = input.clientOpId;
  const operationId = prefix + clientOpId;
  const existing = await getOperation(operationId);
  if (existing) return { operationId, clientOpId, alreadyCaptured: true };

  const op: OfflineOperation = {
    operation_id: operationId,
    operation_type: opType,
    schema_version: OPERATION_SCHEMA_VERSION,
    scope: opScope(input.scope),
    created_at: new Date().toISOString(),
    client_op_id: clientOpId,
    local_entity_id: null, // mutates an existing order; creates no new local entity
    canonical_entity_id: input.orderLocal ? null : input.orderId,
    dependency_ids: Array.from(new Set(input.chain?.dependencyIds ?? [])),
    // An offline-created target order must sync first; the orchestrator gates on this local id.
    depends_on_local_entities: input.orderLocal ? [input.orderLocal] : [],
    payload: {
      payload: input.payload,
      order_local: input.orderLocal,
      ...(input.chain?.targetRef ? { target_ref: input.chain.targetRef } : {}),
      ...(input.chain?.versionAfterOp ? { version_after_op: input.chain.versionAfterOp } : {}),
      // Display-only captured menu prices for the operational projection (NEVER sent: the handler
      // replays `payload` only, and the server resolves every price).
      ...(input.previewItems && input.previewItems.length > 0 ? { preview_items: input.previewItems } : {}),
    },
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

/** Durably capture an offline line edit (pos_edit_order_line). `payload` is the pre-built p_payload
 *  (op/line/quantity/modifiers + expected_version + reason + client_op_id). Idempotent on the op id
 *  derived from client_op_id — a retry of the SAME edit replays, never double-applies. */
export async function captureEditOrderLineOffline(input: {
  scope: ItemEditScope;
  orderId: string | null;
  orderLocal?: string | null;
  payload: Record<string, unknown>;
  clientOpId: string;
  chain?: ItemEditChain;
}): Promise<CaptureItemEditResult> {
  return capture("editline:", "edit_order_line", { ...input, orderLocal: input.orderLocal ?? null });
}

/** Durably capture an offline add-items (pos_add_order_items). Same contract. */
export async function captureAddOrderItemsOffline(input: {
  scope: ItemEditScope;
  orderId: string | null;
  orderLocal?: string | null;
  payload: Record<string, unknown>;
  clientOpId: string;
  chain?: ItemEditChain;
  /** rc.9 — display-only preview lines (captured menu prices) for the operational projection. */
  previewItems?: unknown[];
}): Promise<CaptureItemEditResult> {
  return capture("additems:", "add_order_items", { ...input, orderLocal: input.orderLocal ?? null });
}
