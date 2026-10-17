// Phase F (rc.8) — offline capture for two contract-proven replay-safe Delivery edits:
//   • delivery_ops  → pos_set_delivery_ops  (internal delivered-by / handler / cost; no money, no
//                     external coordination). Replay-safe: pos_op_replay + pos_op_record on client_op_id.
//   • edit_order    → pos_edit_order         (ORDER NOTE only — a discount change is NOT captured here;
//                     it needs a server-authoritative pricing recompute the local projection can't show).
//
// Both mirror the certified item-edit capture (itemEditOffline): a durable op carrying the exact
// pre-built RPC payload + the order's local id (when the order was itself created offline, so the
// orchestrator remaps order_local → canonical before replay). Exactly-once on client_op_id. This
// module holds NO authority — the server RPC is the source of truth after sync.

import {
  type OfflineOperation,
  type OperationScope,
  OPERATION_SCHEMA_VERSION,
  addOperation,
  getOperation,
} from "@/lib/offline/operationLog";

export type DeliveryActionScope = {
  tenantId: string;
  branchId: string | null; // OU
  cashierUserId: string;
  deviceId: string;
  terminalId: string | null;
};

function opScope(s: DeliveryActionScope): OperationScope {
  return { tenant_id: s.tenantId, branch_id: s.branchId, device_id: s.deviceId, terminal_id: s.terminalId ?? "", cashier_user_id: s.cashierUserId };
}

export type CaptureDeliveryActionResult = { operationId: string; clientOpId: string; alreadyCaptured: boolean };

async function capture(
  prefix: string,
  opType: "delivery_ops" | "edit_order",
  input: { scope: DeliveryActionScope; orderId: string | null; orderLocal: string | null; payload: Record<string, unknown>; clientOpId: string },
): Promise<CaptureDeliveryActionResult> {
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
    dependency_ids: [],
    // An offline-created target order must sync first; the orchestrator gates on this local id.
    depends_on_local_entities: input.orderLocal ? [input.orderLocal] : [],
    payload: { payload: input.payload, order_local: input.orderLocal },
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

/** Capture an offline delivery-ops edit. `payload` carries the pos_set_delivery_ops args
 *  (orderId/handlerType/deliveredByUserId/personRef/cost) + client_op_id. Idempotent on the op id. */
export async function captureDeliveryOpsOffline(input: {
  scope: DeliveryActionScope;
  orderId: string | null;
  orderLocal?: string | null;
  payload: Record<string, unknown>;
  clientOpId: string;
}): Promise<CaptureDeliveryActionResult> {
  return capture("delivops:", "delivery_ops", { ...input, orderLocal: input.orderLocal ?? null });
}

/** Capture an offline ORDER NOTE edit. `payload` is the exact pos_edit_order p_payload
 *  (order_id + note + client_op_id). NOTE ONLY — never a discount change. Idempotent on the op id. */
export async function captureEditOrderNoteOffline(input: {
  scope: DeliveryActionScope;
  orderId: string | null;
  orderLocal?: string | null;
  payload: Record<string, unknown>;
  clientOpId: string;
}): Promise<CaptureDeliveryActionResult> {
  return capture("editorder:", "edit_order", { ...input, orderLocal: input.orderLocal ?? null });
}
