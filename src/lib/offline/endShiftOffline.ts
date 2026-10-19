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
 * rc.12 — the operation types a canonical shift CLOSE actually depends on: everything that creates,
 * changes or settles money / orders of the shift (pos_end_shift refuses open orders and computes the
 * expected drawer from server payments). Customer records, table moves/merges, delivery logistics and
 * order notes never change what the close counts, so they never hold the close hostage.
 */
export const CLOSE_RELEVANT_TYPES: ReadonlySet<string> = new Set([
  "open_shift",
  "takeaway_sale",
  "dinein_open_table",
  "dinein_send_round",
  "edit_order_line",
  "add_order_items",
  "pay_table",
  "pay_order",
  "split_settle",
  "on_account_table",
  "on_account_order",
  "void_refund",
  "payout",
  "receivable_collect",
]);

export type CloseBarrierState =
  | { ready: true }
  | { ready: false; waiting: string[]; parked: string[]; missing: string[] };

/**
 * rc.12 — the prerequisites that GATE the canonical close: every declared dependency EXCEPT those that
 * provably cannot affect it (a known non-close-relevant op, or a cancelled op that never reaches the
 * server). A MISSING dependency stays in (the generic evaluator still diagnoses it — never assumed done),
 * and the generic scope / cycle checks still run over these.
 */
export function closeEffectiveDependencies(op: OfflineOperation, byId: Map<string, OfflineOperation>): string[] {
  return op.dependency_ids.filter((id) => {
    const d = byId.get(id);
    if (!d) return true;
    return d.status !== "cancelled" && CLOSE_RELEVANT_TYPES.has(String(d.operation_type));
  });
}

/**
 * rc.12 — PURE. The End Shift barrier, evaluated at replay. Through rc.11 the close used the generic
 * rule: ANY prerequisite in needs_attention made the close itself TERMINAL ("A prerequisite could not be
 * completed") — permanently, even after the operator fixed that prerequisite — and the server shift
 * stayed open forever (the "Open Shift succeeded but No open shift" loop). Now:
 *   - synced / cancelled prerequisites            → satisfied (cancelled work never reaches the server)
 *   - non-close-relevant prerequisites (any state) → satisfied (never affect the close)
 *   - pending / syncing / blocked / retryable       → WAIT
 *   - close-relevant needs_attention                → WAIT (parked, named), never terminal: the close
 *     proceeds automatically once the operator resolves it.
 */
export function evaluateCloseBarrier(op: OfflineOperation, byId: Map<string, OfflineOperation>): CloseBarrierState {
  const waiting: string[] = [];
  const parked: string[] = [];
  const missing: string[] = [];
  for (const id of closeEffectiveDependencies(op, byId)) {
    const d = byId.get(id);
    if (!d) missing.push(id); // never assumed satisfied — the generic evaluator diagnoses it
    else if (d.status === "synced") continue;
    else if (d.status === "needs_attention") parked.push(id);
    else waiting.push(id);
  }
  return waiting.length === 0 && parked.length === 0 && missing.length === 0 ? { ready: true } : { ready: false, waiting, parked, missing };
}

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
  /** rc.10 — the shift's open time: the barrier covers THIS shift's work only (every op captured at or
   *  after it). An unresolved op from an EARLIER shift must not hold this shift's close hostage. */
  shiftOpenedAt?: string | null;
}): Promise<{ operationId: string; clientOpId: string; alreadyCaptured: boolean; dependencyCount: number }> {
  return localdb.transaction("rw", localdb.operations, async () => {
    const key = input.shiftId ?? input.shiftLocal ?? "";
    const clientOpId = deterministicUuid([input.scope.tenantId, input.scope.branchId ?? "", input.scope.cashierUserId, input.scope.deviceId, input.scope.terminalId ?? "", "end_shift", key]);
    const operationId = END_SHIFT_OP_PREFIX + clientOpId;
    const existing = await getOperation(operationId);
    if (existing) return { operationId, clientOpId, alreadyCaptured: true, dependencyCount: existing.dependency_ids.length };

    // The barrier: every op of this shift in this scope that is not itself an end_shift and not
    // terminal-success (synced ops are already satisfied; cancelled ops are excluded). Each must reach
    // `synced` before the canonical close replays — orders, rounds, edits, payments, partial/on-account,
    // refunds, payouts, delivery changes, receivable collections (every op type: no type filter).
    const since = input.shiftOpenedAt ? Date.parse(input.shiftOpenedAt) : NaN;
    const all = await localdb.operations.toArray();
    const dependencyIds = all
      .filter(
        (o) =>
          o.operation_type !== "end_shift" &&
          // rc.12 — only work the canonical close depends on (see CLOSE_RELEVANT_TYPES).
          CLOSE_RELEVANT_TYPES.has(String(o.operation_type)) &&
          o.status !== "cancelled" &&
          o.status !== "synced" &&
          inScope(o, input.scope) &&
          // Same shift: captured at/after it opened, or explicitly tied to it.
          (!Number.isFinite(since) ||
            Date.parse(o.created_at) >= since - 1000 ||
            belongsToShift(o, input.shiftId, input.shiftLocal)),
      )
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

/** True when an op explicitly references this shift (canonical id or its offline-opened local id). */
function belongsToShift(o: OfflineOperation, shiftId: string | null, shiftLocal: string | null): boolean {
  const p = (o.payload ?? {}) as Record<string, unknown>;
  const op = (p.order_payload ?? {}) as Record<string, unknown>;
  const ids = [p.shift_id, p.shift_local, op.shift_id].filter((x) => typeof x === "string");
  return (shiftId != null && ids.includes(shiftId)) || (shiftLocal != null && ids.includes(shiftLocal)) || (shiftLocal != null && o.local_entity_id === shiftLocal);
}

/** The captured end_shift op for this scope (for the UI to show ENDED_PENDING_SYNC), or undefined. */
export async function findEndShiftOp(scope: EndShiftScope): Promise<OfflineOperation | undefined> {
  const rows = await localdb.operations.where("operation_type").equals("end_shift").toArray();
  return rows.find((o) => inScope(o, scope));
}

/** rc.10 — the (non-cancelled) end_shift op that closes THIS shift (canonical id or offline local id),
 *  if one was captured. A shift with such an op is ENDED (pending sync) on this device: it must never be
 *  restored as the active shift by an offline restart, a snapshot, or a not-yet-synced server read. */
export async function endShiftOpForShift(shiftIdOrLocal: string | null | undefined): Promise<OfflineOperation | undefined> {
  if (!shiftIdOrLocal) return undefined;
  const rows = await localdb.operations.where("operation_type").equals("end_shift").toArray();
  return rows.find((o) => {
    if (o.status === "cancelled") return false;
    const p = (o.payload ?? {}) as { shift_id?: string | null; shift_local?: string | null };
    return p.shift_id === shiftIdOrLocal || p.shift_local === shiftIdOrLocal;
  });
}

/** rc.10 — any captured, NOT-yet-synced end_shift in this scope (blocks opening a new shift offline:
 *  the server's single-open rule would otherwise adopt the still-open old shift on replay). */
export async function unsyncedEndShiftOp(scope: EndShiftScope): Promise<OfflineOperation | undefined> {
  const rows = await localdb.operations.where("operation_type").equals("end_shift").toArray();
  return rows.find((o) => o.status !== "cancelled" && o.status !== "synced" && inScope(o, scope));
}
