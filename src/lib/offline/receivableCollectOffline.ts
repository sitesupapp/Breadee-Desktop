// Phase F (GAP 2) — offline RECEIVABLE collection capture + local proof gate.
//
// Books a cash/tender payment against ONE on-account order while offline, through the single
// operation log, reusing the server-side replay-safe pos_receivable_collect (exactly-once via
// pos_operation_idempotency on client_op_id; FOR UPDATE row lock; re-derives outstanding and refuses
// over-collection). An offline collection is permitted ONLY against a receivable whose outstanding
// balance is proven from LOCALLY-HYDRATED data (a ReceivableProof cached while online) in THIS
// tenant+OU, and never for more than the proven outstanding. The server backstop re-validates under
// the lock, so a stale/over balance replays as a CONFLICT → needs_attention, never an over-collection
// and never a second collection. The local customer-payment event is retained for reconciliation.
// This module holds NO financial authority — the canonical server collection is the source of truth.

import {
  readReceivableProof,
  type ReceivableProof,
} from "@/lib/offline/db";
import {
  type OfflineOperation,
  type OperationScope,
  OPERATION_SCHEMA_VERSION,
  addOperation,
  getOperation,
} from "@/lib/offline/operationLog";

/** The immutable 5-dimensional scope an offline collection is captured + replayed under. */
export type ReceivableScope = {
  tenantId: string;
  branchId: string | null; // OU
  cashierUserId: string;
  deviceId: string;
  terminalId: string | null;
};

function opScope(s: ReceivableScope): OperationScope {
  return { tenant_id: s.tenantId, branch_id: s.branchId, device_id: s.deviceId, terminal_id: s.terminalId ?? "", cashier_user_id: s.cashierUserId };
}

export type ReceivableProofResult = { ok: true; proof: ReceivableProof } | { ok: false; reason: string };

/** Can this receivable be collected OFFLINE? Fail-closed: requires a scope-exact (tenant+OU) proof
 *  with a positive outstanding balance. Anything unprovable → reconnect. */
export async function proveReceivableOffline(orderId: string, scope: ReceivableScope): Promise<ReceivableProofResult> {
  const proof = await readReceivableProof(orderId, { tenantId: scope.tenantId, branchId: scope.branchId });
  if (!proof) return { ok: false, reason: "This receivable isn't available offline. Reconnect to collect it." };
  if (!(proof.outstanding_amount > 0)) return { ok: false, reason: "This receivable is already settled." };
  return { ok: true, proof };
}

/** Pure readiness for the offline collection gate. The amount must not exceed the PROVEN outstanding
 *  balance (the server re-checks under its lock, but refusing locally avoids a sure conflict). */
export function evaluateReceivableCollectOfflineReady(input: {
  online: boolean;
  offlineReady: boolean;
  hasScope: boolean;
  hasOpenShift: boolean;
  proof: ReceivableProofResult | null;
  amount: number;
}): { allowed: boolean; reason: string | null } {
  if (input.online) return { allowed: true, reason: null }; // online path unchanged
  if (!input.offlineReady || !input.hasScope) return { allowed: false, reason: "Collecting a receivable needs the POS to be ready offline." };
  if (!input.hasOpenShift) return { allowed: false, reason: "Open a shift before collecting a receivable." };
  if (!input.proof) return { allowed: false, reason: "This receivable isn't available offline. Reconnect to collect it." };
  if (!input.proof.ok) return { allowed: false, reason: input.proof.reason };
  if (!(input.amount > 0)) return { allowed: false, reason: "Enter a collection amount greater than zero." };
  if (input.amount > input.proof.proof.outstanding_amount + 0.005) {
    return { allowed: false, reason: `That's more than the outstanding ${input.proof.proof.outstanding_amount} ${input.proof.proof.currency}.` };
  }
  return { allowed: true, reason: null };
}

const RECEIVABLE_OP_PREFIX = "receivable:";

/**
 * Durably capture an offline receivable collection BEFORE the UI reports success. Deterministic op
 * id from the caller's client_op_id (one per attempt, reused on retry → exactly-once). The payload
 * carries the pos_receivable_collect fields + drawer fields (method/cash_amount_usd) so a cash
 * collection reflects in the local drawer projection. An offline-created receivable is carried as
 * orderLocal and remapped to canonical on replay.
 */
export async function captureReceivableCollectOffline(input: {
  scope: ReceivableScope;
  orderId: string | null;
  orderLocal?: string | null;
  amount: number;
  method: string;
  currency: string;
  clientOpId: string;
  /** Best-effort local USD for the drawer projection only (server prices the authoritative USD). */
  cashAmountUsd?: number | null;
}): Promise<{ operationId: string; clientOpId: string; alreadyCaptured: boolean }> {
  if (!(input.amount > 0)) throw new Error("A collection amount must be greater than zero.");
  const clientOpId = input.clientOpId;
  const operationId = RECEIVABLE_OP_PREFIX + clientOpId;
  const existing = await getOperation(operationId);
  if (existing) return { operationId, clientOpId, alreadyCaptured: true };

  const op: OfflineOperation = {
    operation_id: operationId,
    operation_type: "receivable_collect",
    schema_version: OPERATION_SCHEMA_VERSION,
    scope: opScope(input.scope),
    created_at: new Date().toISOString(),
    client_op_id: clientOpId,
    local_entity_id: null, // collects against an existing receivable; creates no new local entity
    canonical_entity_id: input.orderLocal ? null : input.orderId,
    dependency_ids: [],
    depends_on_local_entities: input.orderLocal ? [input.orderLocal] : [],
    payload: {
      order_id: input.orderLocal ? null : input.orderId,
      order_local: input.orderLocal ?? null,
      amount: input.amount,
      method: input.method,
      currency: input.currency,
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
