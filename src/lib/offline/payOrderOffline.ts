// Phase F (GAP 3) — offline single-ORDER cash settlement capture (delivery COD + any order pay).
//
// Reuses the Phase-D `pay_order` op + handler (pos_pay_order, server replay-safe on client_op_id +
// expected_version CAS). A delivery COD cash collection is just pos_pay_order on the delivery order,
// so there is NO new RPC and NO second cash movement — the one canonical settlement books the
// payment and sets payment_status. The order may be hydrated-canonical (order_id) or itself created
// offline (order_local → remapped to the canonical id on replay by the handler, via the entity map).
// Captured durably BEFORE the UI reports success; a settle conflict (already paid / no open order)
// replays as needs_attention, never a second charge.

import {
  type OfflineOperation,
  type OperationScope,
  OPERATION_SCHEMA_VERSION,
  addOperation,
  getOperation,
} from "@/lib/offline/operationLog";
import { deterministicUuid } from "@/lib/offline/dineinOffline";

export type PayOrderScope = {
  tenantId: string;
  branchId: string | null; // OU
  cashierUserId: string;
  deviceId: string;
  terminalId: string | null;
};

function opScope(s: PayOrderScope): OperationScope {
  return { tenant_id: s.tenantId, branch_id: s.branchId, device_id: s.deviceId, terminal_id: s.terminalId ?? "", cashier_user_id: s.cashierUserId };
}

const PAY_ORDER_OP_PREFIX = "payorder:";

/** Durably capture an offline single-order cash settlement (pos_pay_order). Deterministic op id
 *  from a caller-supplied client_op_id (one per settlement attempt, reused on retry → exactly-once).
 *  `cashAmountUsd` is a best-effort local USD figure for the drawer projection only (the server
 *  derives the authoritative charge). An offline-created order is carried as orderLocal and remapped
 *  to its canonical id on replay; a hydrated order carries its canonical orderId directly. */
export async function capturePayOrderOffline(input: {
  scope: PayOrderScope;
  orderId: string | null;
  orderLocal?: string | null;
  method: string;
  currency: string;
  clientOpId: string;
  expectedVersion?: number | null;
  cashAmountUsd?: number | null;
  orderNumber?: string | null;
}): Promise<{ operationId: string; clientOpId: string; alreadyCaptured: boolean }> {
  const clientOpId = input.clientOpId;
  const operationId = PAY_ORDER_OP_PREFIX + clientOpId;
  const existing = await getOperation(operationId);
  if (existing) return { operationId, clientOpId, alreadyCaptured: true };

  const op: OfflineOperation = {
    operation_id: operationId,
    operation_type: "pay_order",
    schema_version: OPERATION_SCHEMA_VERSION,
    scope: opScope(input.scope),
    created_at: new Date().toISOString(),
    client_op_id: clientOpId,
    local_entity_id: null, // settles an existing order; creates no new local entity
    canonical_entity_id: input.orderLocal ? null : input.orderId,
    dependency_ids: [],
    depends_on_local_entities: input.orderLocal ? [input.orderLocal] : [],
    payload: {
      order_id: input.orderLocal ? null : input.orderId,
      order_local: input.orderLocal ?? null,
      method: input.method,
      currency: input.currency,
      expected_version: input.expectedVersion ?? null,
      order_number: input.orderNumber ?? null,
      ...(input.cashAmountUsd != null && input.cashAmountUsd > 0 ? { cash_amount_usd: input.cashAmountUsd } : {}),
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

/** A deterministic per-attempt client_op_id for an order settlement (stable for the same
 *  order+method+currency so a double-tap collapses; a fresh method/order is a new attempt). */
export function payOrderClientOpId(scope: PayOrderScope, orderRef: string, method: string, currency: string): string {
  return deterministicUuid([scope.tenantId, scope.branchId ?? "", scope.deviceId, scope.terminalId ?? "", "pay_order", orderRef, method, currency]);
}
