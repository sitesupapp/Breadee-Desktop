// Phase D (D4) — offline CASH-PAYOUT capture + local proof gate.
//
// The ONE place that turns an operator "Pay out cash" into a durable Phase-B `payout` operation
// while offline. It does NOT drain or replay — the single orchestrator owns that. It only
// CAPTURES (atomically) and decides, fail-closed, whether an offline payout is even allowed.
//
// A payout records that PHYSICAL cash left the till to fund an EXISTING economic source. The cash
// has already left the drawer regardless of connectivity, so capturing it offline is operationally
// correct — but it is permitted ONLY when the chosen source can be proven from LOCALLY-HYDRATED
// data (a PayoutSourceProof cached while online) belonging to THIS tenant+OU on THIS
// device/terminal/cashier (5-D). Otherwise the operator is told to reconnect, never a blind payout
// against an unverifiable record. The server (pos_payout_create, replay-safe on client_op_id) is
// the backstop: it re-validates the source under its row lock, so a source deleted/voided/changed
// since hydration replays as a CONFLICT → needs_attention, never a second economic event. This
// module is NEVER a financial authority — the canonical server payout remains the source of truth.

import {
  localdb,
  readPayoutSourceProof,
  type PayoutSourceProof,
  type PayoutProofScope,
} from "@/lib/offline/db";
import {
  type OfflineOperation,
  type OperationScope,
  OPERATION_SCHEMA_VERSION,
  addOperation,
  getOperation,
  updateOperation,
} from "@/lib/offline/operationLog";

/** The immutable 5-dimensional scope an offline payout is captured and replayed under. */
export type PayoutScope = {
  tenantId: string;
  branchId: string | null; // OU
  cashierUserId: string;
  deviceId: string;
  terminalId: string | null;
};

function opScope(scope: PayoutScope): OperationScope {
  return {
    tenant_id: scope.tenantId,
    branch_id: scope.branchId,
    device_id: scope.deviceId,
    terminal_id: scope.terminalId ?? "",
    cashier_user_id: scope.cashierUserId,
  };
}

function proofScope(scope: PayoutScope): PayoutProofScope {
  return {
    tenantId: scope.tenantId,
    branchId: scope.branchId,
    cashierUserId: scope.cashierUserId,
    deviceId: scope.deviceId,
    terminalId: scope.terminalId,
  };
}

/**
 * Best-effort LOCAL USD value of a cash-out for the drawer projection (pure; no I/O). Returns null
 * when it cannot be known locally (a non-USD currency with no snapshot rate), so the projection
 * carries it as `unknown` rather than inventing a figure — the server prices the authoritative USD
 * on replay either way. USD → the amount itself; LBP → amount / usd_to_lbp rate.
 */
export function payoutAmountUsd(amount: number, currency: string, usdToLbpRate: number | null): number | null {
  if (!(amount > 0)) return null;
  if (currency === "USD") return amount;
  if (currency === "LBP") {
    if (usdToLbpRate != null && usdToLbpRate > 0) return amount / usdToLbpRate;
    return null;
  }
  return null; // a third currency with no local USD basis → unknown
}

export type PayoutProofResult =
  | { ok: true; proof: PayoutSourceProof }
  | { ok: false; reason: string };

/**
 * Can this source be paid out OFFLINE? Fail-closed: requires a scope-exact local proof that the
 * source existed and was valid when hydrated online. Anything unprovable returns ok:false with an
 * operator-facing "reconnect" reason — never a blind offline cash-out against an unverified record.
 */
export async function provePayoutSourceOffline(
  sourceType: string,
  sourceId: string,
  scope: PayoutScope,
): Promise<PayoutProofResult> {
  const proof = await readPayoutSourceProof(sourceType, sourceId, proofScope(scope));
  if (!proof) {
    return { ok: false, reason: "This record isn't available offline. Reconnect to pay it out." };
  }
  return { ok: true, proof };
}

/** Pure readiness for the payout gate — mirrors provePayoutSourceOffline without a DB read, so a
 *  gate can be computed synchronously from an already-resolved proof result + shell state. */
export function evaluatePayoutOfflineReady(input: {
  online: boolean;
  offlineReady: boolean; // the POS is offline-ready (shift/menu/scope hydrated)
  hasOpenShift: boolean;
  proof: PayoutProofResult | null;
}): { allowed: boolean; reason: string | null } {
  if (input.online) return { allowed: true, reason: null }; // online path is unchanged
  if (!input.offlineReady) return { allowed: false, reason: "Cash payouts need the POS to be ready offline." };
  if (!input.hasOpenShift) return { allowed: false, reason: "Open a shift before paying out cash." };
  if (!input.proof) return { allowed: false, reason: "Pick a record that was loaded while online." };
  if (!input.proof.ok) return { allowed: false, reason: input.proof.reason };
  return { allowed: true, reason: null };
}

/** Deterministic operation id so a double-tap / restart-retry of the SAME payout attempt collapses
 *  to ONE durable op. The caller mints one client_op_id per payout attempt (reused on retry),
 *  exactly as the online payout does — so a lost response never pays out twice, yet a DELIBERATE
 *  second payout (a fresh attempt → fresh client_op_id) is correctly a new op. */
const PAYOUT_OP_PREFIX = "payout:";
function payoutOpId(clientOpId: string): string {
  return PAYOUT_OP_PREFIX + clientOpId;
}

export type CapturePayoutResult = {
  operationId: string;
  clientOpId: string;
  alreadyCaptured: boolean;
};

/**
 * Durably CAPTURE an offline cash payout BEFORE the UI reports success. Atomic: the operation is
 * the only durable record, appended under a deterministic id so a repeat is idempotent. The caller
 * MUST have obtained `proof` from provePayoutSourceOffline.
 *
 * The payload carries BOTH the replay fields the server needs (shift_id, amount, source_type,
 * source_id, note, client_op_id — exactly buildPayoutCreatePayload's shape) AND the drawer-
 * projection fields (amount_usd, method 'cash', currency) so the local drawer reduces immediately.
 * When captured under an OFFLINE-OPENED shift, shiftLocalId is carried so replay remaps shift_id to
 * the canonical server shift once that shift syncs (same remap the takeaway/end-shift handlers do).
 */
export async function capturePayoutOffline(input: {
  scope: PayoutScope;
  shiftId: string | null; // canonical shift id when known
  shiftLocalId?: string | null; // local id of an offline-opened shift to remap on replay
  proof: PayoutSourceProof;
  amount: number;
  currency: string;
  note: string | null;
  /** Best-effort LOCAL USD value of the cash-out, for the drawer projection only (NOT authoritative;
   *  the server prices the real amount). Omitted when the local USD value is unknowable. */
  amountUsd?: number | null;
  /** One id per payout attempt, reused on retry (the server idempotency key). */
  clientOpId: string;
}): Promise<CapturePayoutResult> {
  const { scope, proof } = input;
  if (!(input.amount > 0)) throw new Error("A payout amount must be greater than zero.");
  const clientOpId = input.clientOpId;
  const operationId = payoutOpId(clientOpId);

  const existing = await getOperation(operationId);
  if (existing) return { operationId, clientOpId, alreadyCaptured: true };

  const note = input.note && input.note.trim() !== "" ? input.note.trim() : null;
  const op: OfflineOperation = {
    operation_id: operationId,
    operation_type: "payout",
    schema_version: OPERATION_SCHEMA_VERSION,
    scope: opScope(scope),
    created_at: new Date().toISOString(),
    client_op_id: clientOpId,
    local_entity_id: null, // creates no new local entity the rest of the log depends on
    canonical_entity_id: null, // filled with the server payout_id on replay
    // Replay only AFTER an offline-opened shift exists server-side (else "shift not found").
    dependency_ids: [],
    depends_on_local_entities: input.shiftLocalId ? [input.shiftLocalId] : [],
    payload: {
      shift_id: input.shiftId ?? null,
      shift_local: input.shiftLocalId ?? null,
      amount: input.amount,
      source_type: proof.source_type,
      source_id: proof.source_id,
      source_label: proof.label, // local display only; the server snapshots its own
      note,
      currency: input.currency,
      method: "cash", // a payout is always physical cash out of the till
      ...(input.amountUsd != null && input.amountUsd > 0 ? { amount_usd: input.amountUsd } : {}),
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

function inScope(op: OfflineOperation, scope: PayoutScope): boolean {
  return (
    op.scope.tenant_id === scope.tenantId &&
    (op.scope.branch_id ?? null) === (scope.branchId ?? null) &&
    op.scope.cashier_user_id === scope.cashierUserId &&
    op.scope.device_id === scope.deviceId &&
    (scope.terminalId == null || (op.scope.terminal_id || null) === scope.terminalId)
  );
}

export type LocalPayout = {
  operationId: string;
  clientOpId: string;
  amount: number;
  amountUsd: number | null;
  currency: string;
  sourceType: string;
  sourceId: string;
  sourceLabel: string | null;
  note: string | null;
  status: OfflineOperation["status"];
  createdAt: string;
};

function toLocalPayout(op: OfflineOperation): LocalPayout {
  const p = (op.payload ?? {}) as Record<string, unknown>;
  return {
    operationId: op.operation_id,
    clientOpId: op.client_op_id,
    amount: typeof p.amount === "number" ? p.amount : 0,
    amountUsd: typeof p.amount_usd === "number" ? p.amount_usd : null,
    currency: typeof p.currency === "string" ? p.currency : "USD",
    sourceType: typeof p.source_type === "string" ? p.source_type : "",
    sourceId: typeof p.source_id === "string" ? p.source_id : "",
    sourceLabel: typeof p.source_label === "string" ? p.source_label : null,
    note: typeof p.note === "string" ? p.note : null,
    status: op.status,
    createdAt: op.created_at,
  };
}

/** Locally-captured payouts for the EXACT scope (optionally one shift), newest first. Lets the
 *  Payouts surface show offline cash-outs the operator just recorded (the server list is
 *  unreachable offline). */
export async function listLocalPayouts(scope: PayoutScope, shiftId?: string | null): Promise<LocalPayout[]> {
  const rows = await localdb.operations.where("operation_type").equals("payout").toArray();
  return rows
    .filter((op) => inScope(op, scope))
    .filter((op) => {
      if (shiftId == null) return true;
      const p = (op.payload ?? {}) as Record<string, unknown>;
      return p.shift_id === shiftId;
    })
    .map(toLocalPayout)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Reverse a payout OFFLINE — ONLY when provable, i.e. the payout is still a LOCALLY-CAPTURED op
 * that has NOT yet reached the server. Withdrawing it marks the op `cancelled` (terminal), which
 * the drain never replays and the drawer projection excludes, so the cash returns to the expected
 * drawer with zero server effect. A payout that is already `syncing`/`synced` CANNOT be proven
 * un-sent offline, so it is refused here (it is reversed online via pos_payout_reverse). Idempotent.
 */
export async function withdrawLocalPayout(operationId: string, scope: PayoutScope): Promise<{ ok: boolean; reason?: string }> {
  const op = await getOperation(operationId);
  if (!op || op.operation_type !== "payout") return { ok: false, reason: "That payout is not available offline." };
  if (!inScope(op, scope)) return { ok: false, reason: "That payout belongs to another drawer." };
  if (op.status === "cancelled") return { ok: true }; // already withdrawn (idempotent)
  if (op.status === "synced" || op.status === "syncing") {
    return { ok: false, reason: "This payout has already been sent. Reverse it once you're back online." };
  }
  await updateOperation(operationId, { status: "cancelled" });
  return { ok: true };
}
