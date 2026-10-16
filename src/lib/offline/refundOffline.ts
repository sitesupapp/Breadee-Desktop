// Phase D — offline refund/void CAPTURE + local proof gate.
//
// The ONE place that turns an operator "Refund order" / "Cancel order" into a durable Phase-B
// `void_refund` operation while offline. It does NOT drain or replay — the single orchestrator
// owns that. It only CAPTURES (atomically) and decides, fail-closed, whether an offline refund
// is even allowed.
//
// Policy (binding, user-authorized): an offline refund is permitted ONLY when the original paid
// order and its refundable balance can be proven from LOCALLY-HYDRATED data (a PaidOrderProof
// cached while online) belonging to THIS tenant+OU (rules 1, 2, 8, 9). Otherwise the operator is
// told to reconnect — never a blind offline cash-out. The server guard (p_expected_refund_usd +
// expected_version) is the backstop: any drift replays as a structured conflict → needs_attention
// (rule 7), never a silent second refund. The deterministic client_op_id makes a double-tap and a
// restart-retry exactly-once (rule 3). This module is NEVER a financial authority — the canonical
// server transaction remains the source of truth after sync.

import {
  localdb,
  readPaidOrderProof,
  cachePaidOrderProof,
  deletePaidOrderProof,
  type PaidOrderProof,
} from "@/lib/offline/db";
import {
  type OfflineOperation,
  OPERATION_SCHEMA_VERSION,
  addOperation,
  getOperation,
} from "@/lib/offline/operationLog";
import type { OperationScope } from "@/lib/offline/operationLog";
import { deterministicUuid } from "@/lib/offline/dineinOffline";

/** The immutable 5-dimensional scope an offline refund is captured and replayed under. */
export type RefundScope = {
  tenantId: string;
  branchId: string | null; // OU
  cashierUserId: string;
  deviceId: string;
  terminalId: string | null;
};

function opScope(scope: RefundScope): OperationScope {
  return {
    tenant_id: scope.tenantId,
    branch_id: scope.branchId,
    device_id: scope.deviceId,
    terminal_id: scope.terminalId ?? "",
    cashier_user_id: scope.cashierUserId,
  };
}

/** The operator reversal this order's payment state permits (mirrors the server/UI rule). */
export type RefundAction = "refund" | "cancel";

const TERMINAL = new Set(["voided", "cancelled", "refunded"]);

/**
 * The order's refundable USD, mirroring the server's full-settlement basis (pure; no I/O).
 * Returns 0 when it cannot be known locally (→ the order is NOT offline-refundable; fail-closed):
 * prefer total_amount_usd, else the USD total, else an LBP total converted by the snapshot rate.
 */
export function refundableUsdOf(o: {
  total_amount: number | null;
  total_amount_usd: number | null;
  primary_currency_snapshot: string | null;
  usd_to_lbp_rate_snapshot: number | null;
}): number {
  if (o.total_amount_usd != null && o.total_amount_usd > 0) return Number(o.total_amount_usd);
  const ccy = o.primary_currency_snapshot ?? "USD";
  const total = o.total_amount ?? 0;
  if (ccy === "USD") return total > 0 ? Number(total) : 0;
  if (ccy === "LBP") {
    const rate = o.usd_to_lbp_rate_snapshot;
    if (rate != null && rate > 0 && total > 0) return Number(total) / Number(rate);
    return 0; // no rate → unknown → not offline-refundable
  }
  return 0; // a third currency with no USD snapshot → unknown
}

/**
 * The write-through decision for ONE canonical order (pure; no I/O): whether to EVICT any local
 * proof (the order is terminal, no longer paid, or its balance is unknowable) or CACHE it with the
 * derived refundable USD. Keeps the eviction rule unit-testable away from the Supabase read.
 */
export function hydrationProofDecision(o: {
  status: string | null;
  payment_status: string | null;
  total_amount: number | null;
  total_amount_usd: number | null;
  primary_currency_snapshot: string | null;
  usd_to_lbp_rate_snapshot: number | null;
}): { evict: true } | { evict: false; refundableUsd: number } {
  if (o.status == null || TERMINAL.has(o.status)) return { evict: true };
  if (o.payment_status !== "paid") return { evict: true };
  const usd = refundableUsdOf(o);
  if (!(usd > 0)) return { evict: true };
  return { evict: false, refundableUsd: usd };
}

/** One canonical order row as the online write-through sees it. */
export type ProofSourceRow = {
  id: string;
  order_number: string | null;
  shift_id: string | null;
  pos_entity_version: number | null;
  payment_status: string | null;
  status: string | null;
  total_amount: number | null;
  total_amount_usd: number | null;
  primary_currency_snapshot: string | null;
  usd_to_lbp_rate_snapshot: number | null;
};

/**
 * Apply ONE canonical order row to the local proof cache (network-free; the online write-through
 * just reads the rows and calls this). CACHE when the order is paid, non-terminal and its USD
 * balance is knowable; otherwise EVICT any existing proof — INCLUDING when the status is null or
 * unknowable, so stale authorization evidence can never outlive the order being refundable.
 */
export async function applyProofRow(scope: RefundScope, raw: ProofSourceRow): Promise<"cached" | "evicted"> {
  if (!raw.id) return "evicted";
  const decision = hydrationProofDecision(raw);
  if (decision.evict) {
    await deletePaidOrderProof(raw.id);
    return "evicted";
  }
  await cacheRefundProof({
    scope,
    order: {
      order_id: raw.id,
      order_number: raw.order_number,
      shift_id: raw.shift_id,
      pos_entity_version: raw.pos_entity_version,
      payment_status: raw.payment_status ?? "paid",
      status: raw.status as string, // non-terminal, non-null by the decision above
      refundable_usd: decision.refundableUsd,
      currency: raw.primary_currency_snapshot ?? "USD",
    },
  });
  return "cached";
}

/**
 * Write through the refund-proof of a PAID canonical order while ONLINE. Call from the places
 * that already hold authoritative server data for an order (pay confirmation, an online order
 * read that carries the USD total + version). Only a non-terminal order is cached; a terminal
 * one drops any stale proof so it can never be offline-refunded.
 */
export async function cacheRefundProof(input: {
  scope: RefundScope;
  order: {
    order_id: string;
    order_number: string | null;
    shift_id: string | null;
    pos_entity_version: number | null;
    payment_status: string;
    status: string;
    refundable_usd: number;
    currency: string;
  };
}): Promise<void> {
  const o = input.order;
  if (TERMINAL.has(o.status)) {
    await localdb.paidOrderProofs.delete(o.order_id).catch(() => undefined);
    return;
  }
  const proof: PaidOrderProof = {
    order_id: o.order_id,
    order_number: o.order_number,
    tenant_id: input.scope.tenantId,
    branch_id: input.scope.branchId,
    shift_id: o.shift_id,
    pos_entity_version: o.pos_entity_version,
    payment_status: o.payment_status,
    status: o.status,
    refundable_usd: o.refundable_usd,
    currency: o.currency,
    cashier_user_id: input.scope.cashierUserId,
    device_id: input.scope.deviceId,
    terminal_id: input.scope.terminalId ?? null,
    cached_at: new Date().toISOString(),
  };
  await cachePaidOrderProof(proof);
}

export type RefundProofResult =
  | { ok: true; proof: PaidOrderProof; action: RefundAction }
  | { ok: false; reason: string };

/**
 * Can this order be reversed OFFLINE, and as what? Fail-closed: requires a scope-exact local
 * proof of a non-terminal order. A refund additionally requires payment_status 'paid' AND a
 * positive locally-known refundable balance; a cancel requires the order to be unpaid. Anything
 * unprovable returns ok:false with an operator-facing "reconnect" reason (rule 8).
 */
export async function proveOfflineReversible(orderId: string, scope: RefundScope): Promise<RefundProofResult> {
  const proof = await readPaidOrderProof(orderId, {
    tenantId: scope.tenantId,
    branchId: scope.branchId,
    cashierUserId: scope.cashierUserId,
    deviceId: scope.deviceId,
    terminalId: scope.terminalId,
  });
  if (!proof) {
    return { ok: false, reason: "This order is not available offline. Reconnect to refund it." };
  }
  if (TERMINAL.has(proof.status)) {
    return { ok: false, reason: `This order is already ${proof.status}.` };
  }
  const paid = proof.payment_status === "paid";
  if (paid) {
    if (!(proof.refundable_usd > 0)) {
      return { ok: false, reason: "The refundable amount isn't known offline. Reconnect to refund it." };
    }
    return { ok: true, proof, action: "refund" };
  }
  // Unpaid → a cancel, which moves no money and needs no balance proof.
  return { ok: true, proof, action: "cancel" };
}

/** Pure readiness for the refund gate — mirrors proveOfflineReversible without a DB read, so a
 *  gate can be computed synchronously from an already-resolved proof result. */
export function evaluateRefundOfflineReady(input: {
  online: boolean;
  offlineReady: boolean; // the POS is offline-ready (menu/shift/etc. hydrated)
  proof: RefundProofResult | null;
}): { allowed: boolean; reason: string | null } {
  if (input.online) return { allowed: true, reason: null }; // online path is unchanged
  if (!input.offlineReady) return { allowed: false, reason: "This action needs a connection." };
  if (!input.proof) return { allowed: false, reason: "This order is not available offline. Reconnect to refund it." };
  if (!input.proof.ok) return { allowed: false, reason: input.proof.reason };
  return { allowed: true, reason: null };
}

/** Deterministic operation id so a double-tap / restart-retry of the SAME reversal collapses to
 *  ONE durable op (the second add is a ConstraintError we treat as already-captured). */
function refundOpId(clientOpId: string): string {
  return `refund:${clientOpId}`;
}

function refundClientOpId(scope: RefundScope, orderId: string, expectedVersion: number | null): string {
  return deterministicUuid([
    scope.tenantId,
    scope.branchId ?? "",
    scope.cashierUserId,
    scope.deviceId,
    scope.terminalId ?? "",
    "void_refund",
    orderId,
    String(expectedVersion ?? ""),
  ]);
}

/** An existing (any-status) void_refund op for this order in this scope, or undefined. Lets the
 *  UI avoid offering a second reversal for an order already captured this session. */
export async function findRefundOp(orderId: string, scope: RefundScope): Promise<OfflineOperation | undefined> {
  const rows = await localdb.operations.where("operation_type").equals("void_refund").toArray();
  return rows.find(
    (o) =>
      (o.payload as { order_id?: string } | null)?.order_id === orderId &&
      o.scope.tenant_id === scope.tenantId &&
      (o.scope.branch_id ?? null) === (scope.branchId ?? null) &&
      o.scope.cashier_user_id === scope.cashierUserId &&
      o.scope.device_id === scope.deviceId &&
      (scope.terminalId == null || (o.scope.terminal_id || null) === scope.terminalId),
  );
}

export type CaptureRefundResult = {
  operationId: string;
  clientOpId: string;
  alreadyCaptured: boolean;
};

/**
 * Durably CAPTURE an offline reversal BEFORE the UI reports success. Atomic: the operation is the
 * only durable record (there is no separate projection), appended under a deterministic id so a
 * repeat is idempotent. The caller MUST have obtained `proof`/`action` from
 * proveOfflineReversible and validated the reason per desktop policy.
 */
export async function captureOfflineRefund(input: {
  scope: RefundScope;
  proof: PaidOrderProof;
  action: RefundAction;
  reason: string;
  tender: "cash" | "other";
}): Promise<CaptureRefundResult> {
  const { scope, proof, action } = input;
  const refund = action === "refund";
  const clientOpId = refundClientOpId(scope, proof.order_id, proof.pos_entity_version);
  const operationId = refundOpId(clientOpId);

  // Idempotent capture: a prior op with this deterministic id means the reversal is already
  // durably recorded (double-tap / re-entry) — return it rather than enqueue a second.
  const existing = await getOperation(operationId);
  if (existing) return { operationId, clientOpId, alreadyCaptured: true };

  const op: OfflineOperation = {
    operation_id: operationId,
    operation_type: "void_refund",
    schema_version: OPERATION_SCHEMA_VERSION,
    scope: opScope(scope),
    created_at: new Date().toISOString(),
    client_op_id: clientOpId,
    local_entity_id: null, // mutates an existing canonical order; creates no new local entity
    canonical_entity_id: proof.order_id,
    dependency_ids: [],
    depends_on_local_entities: [],
    payload: {
      order_id: proof.order_id,
      order_number: proof.order_number,
      reason: input.reason,
      refund,
      expected_version: proof.pos_entity_version,
      expected_refund_usd: refund ? proof.refundable_usd : null,
      tender: input.tender,
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
    // A concurrent double-tap lost the race to the same deterministic id → already captured.
    const now = await getOperation(operationId);
    if (now) return { operationId, clientOpId, alreadyCaptured: true };
    throw e;
  }
  return { operationId, clientOpId, alreadyCaptured: false };
}
