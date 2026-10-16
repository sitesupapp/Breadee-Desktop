// Phase D — offline ORDER on-account capture (Takeaway / Delivery receivable).
//
// Chains an on_account_order op onto an order that is either canonical (hydrated) or captured
// offline. For an offline Takeaway order the order lives in the legacy posOfflineTxns store and
// migrates to a `takeaway_sale` op whose id is `mig:txn:<local_txn_id>` and whose local_entity_id
// is that same `local_txn_id` (resolved to the canonical order id on sync). So the receivable
// depends on that op + remaps order_local → canonical before pos_complete_on_account runs. No
// change to the proven takeaway path: we only add a dependent op. Deterministic id → restart /
// double-tap idempotent. A locally-known customer is required (cached canonical now; customer_local
// forward-compat for a Phase-E offline-created customer).

import { localdb } from "@/lib/offline/db";
import { type OfflineOperation, OPERATION_SCHEMA_VERSION, getOperation } from "@/lib/offline/operationLog";
import type { OperationScope } from "@/lib/offline/operationLog";
import { deterministicUuid } from "@/lib/offline/dineinOffline";

export type OrderScope = {
  tenantId: string;
  branchId: string | null;
  cashierUserId: string;
  deviceId: string;
  terminalId: string | null;
};

function opScope(s: OrderScope): OperationScope {
  return { tenant_id: s.tenantId, branch_id: s.branchId, device_id: s.deviceId, terminal_id: s.terminalId ?? "", cashier_user_id: s.cashierUserId };
}

/** The legacy takeaway migration op id for a local txn (mirrors migration.ts `txnOpId`). */
export function takeawaySaleOpId(localTxnId: string): string {
  return `mig:txn:${localTxnId}`;
}

const ORDER_OA_PREFIX = "onaccountorder:";

/**
 * Durably capture an order-level on-account receivable offline. The order is referenced either by
 * canonical id (hydrated) or by a local id (orderLocal) that remaps on sync; when the order was
 * captured offline, pass its migration op id (migOpId) so the receivable waits for the order to
 * sync first. A customer is required (customerId canonical, or customerLocal for Phase E).
 */
export async function orderOnAccountOffline(input: {
  scope: OrderScope;
  orderId: string | null;
  orderLocal: string | null;
  migOpId: string | null;
  customerId: string | null;
  customerLocal?: string | null;
  amount: number;
  method: string;
  orderNumber?: string | null;
  discount?: { discount_type?: string; discount_value?: number };
}): Promise<{ operationId: string; clientOpId: string; alreadyCaptured: boolean }> {
  if (!input.orderId && !input.orderLocal) throw new Error("An order is required to put on account.");
  if (!input.customerId && !input.customerLocal) throw new Error("A customer is required to put this order on account.");
  return localdb.transaction("rw", localdb.operations, async () => {
    const key = input.orderId ?? input.orderLocal ?? "";
    const cust = input.customerId ?? input.customerLocal ?? "";
    const clientOpId = deterministicUuid([input.scope.tenantId, input.scope.branchId ?? "", input.scope.cashierUserId, input.scope.deviceId, input.scope.terminalId ?? "", "on_account_order", key, cust, input.method, String(input.amount)]);
    const operationId = ORDER_OA_PREFIX + clientOpId;
    const existing = await getOperation(operationId);
    if (existing) return { operationId, clientOpId, alreadyCaptured: true };

    const dependsLocal: string[] = [];
    if (input.orderLocal) dependsLocal.push(input.orderLocal);
    if (input.customerLocal) dependsLocal.push(input.customerLocal);

    const op: OfflineOperation = {
      operation_id: operationId,
      operation_type: "on_account_order",
      schema_version: OPERATION_SCHEMA_VERSION,
      scope: opScope(input.scope),
      created_at: new Date().toISOString(),
      client_op_id: clientOpId,
      local_entity_id: null,
      canonical_entity_id: input.orderId,
      // Wait for the order op (when captured offline) to sync before settling the receivable.
      dependency_ids: input.migOpId ? [input.migOpId] : [],
      depends_on_local_entities: dependsLocal,
      payload: {
        order_id: input.orderId,
        order_local: input.orderLocal,
        customer_id: input.customerId,
        customer_local: input.customerLocal ?? null,
        amount: input.amount,
        method: input.method,
        order_number: input.orderNumber ?? null,
        ...(input.discount ? { discount: input.discount } : {}),
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
    return { operationId, clientOpId, alreadyCaptured: false };
  });
}
