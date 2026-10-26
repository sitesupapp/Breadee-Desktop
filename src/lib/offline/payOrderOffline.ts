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
  /** rc.9 — every still-unsynced mutation of this order (item edits / provider / ops) from the
   *  operational projection: the settle replays only AFTER them, never against a pre-edit total. */
  dependencyIds?: string[];
  /** 1.0.38 (D2) — the pay-step pricing the operator confirmed, in the EXACT online pos_pay_order
   *  p_payload field names (buildDeliveryPaymentPayload): discount_type / discount_value /
   *  delivery_fee. Never an amount or total — the server's finance engine computes the charge. */
  pricing?: PayOrderPricing | null;
  /** Display-only order kind for the Sync Center label ("delivery"); ignored by the handler. */
  orderType?: string | null;
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
    dependency_ids: Array.from(new Set(input.dependencyIds ?? [])),
    depends_on_local_entities: input.orderLocal ? [input.orderLocal] : [],
    payload: {
      order_id: input.orderLocal ? null : input.orderId,
      order_local: input.orderLocal ?? null,
      method: input.method,
      currency: input.currency,
      expected_version: input.expectedVersion ?? null,
      order_number: input.orderNumber ?? null,
      ...(input.orderType ? { order_type: input.orderType } : {}),
      // D2 — `discount` is the pay_order handler's pass-through pricing object: replay spreads it
      // verbatim into pos_pay_order's p_payload (posTxnSync payOrderOp), i.e. the same fields the
      // online settle sends. Absent when nothing was entered (byte-identical to the pre-1.0.38 op).
      ...(pricingFields(input.pricing) ? { discount: pricingFields(input.pricing) } : {}),
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

/** 1.0.38 (D2) — the pay-step pricing carried to replay (online pos_pay_order field names). */
export type PayOrderPricing = {
  discount_type?: "percent" | "amount";
  discount_value?: number;
  delivery_fee?: number;
};

/** The named pricing fields only (never a spread of the dialog result); null when none is set. */
function pricingFields(p: PayOrderPricing | null | undefined): PayOrderPricing | null {
  if (!p) return null;
  const out: PayOrderPricing = {};
  if (p.discount_type !== undefined && p.discount_value !== undefined) {
    out.discount_type = p.discount_type;
    out.discount_value = p.discount_value;
  }
  if (p.delivery_fee !== undefined && p.delivery_fee !== null) out.delivery_fee = p.delivery_fee;
  return Object.keys(out).length > 0 ? out : null;
}

/** A deterministic per-attempt client_op_id for an order settlement (stable for the same
 *  order+method+currency so a double-tap collapses; a fresh method/order is a new attempt).
 *  1.0.38 (D2) — the pricing joins the derivation when present, so an op id always names exactly
 *  the discount/fee it replays (no pricing → the pre-1.0.38 id, unchanged). */
export function payOrderClientOpId(scope: PayOrderScope, orderRef: string, method: string, currency: string, pricing?: PayOrderPricing | null): string {
  const base = [scope.tenantId, scope.branchId ?? "", scope.deviceId, scope.terminalId ?? "", "pay_order", orderRef, method, currency];
  const p = pricingFields(pricing);
  if (!p) return deterministicUuid(base);
  return deterministicUuid([...base, p.discount_type ?? "", String(p.discount_value ?? ""), p.delivery_fee == null ? "~" : String(p.delivery_fee)]);
}
