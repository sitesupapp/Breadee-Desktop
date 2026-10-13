// R4 (Desktop 1.0.36) — Force End Shift data layer.
//
// Thin, server-authoritative wrappers over the canonical Force-End RPCs plus the branch-scoped
// reads the surfaces need. The desktop performs NO authority logic: every rule — permissions
// (self → pos.end_own_shift, other → pos.close_other_shifts; the requester also needs
// pos.transfers.select_recipient), tenant/branch OU, self-hand-over refusal, paid/part-paid/split
// isolation, the snapshot, recipient eligibility (active + branch + EXACTLY ONE open shift),
// atomic order-move + source-close, and exactly-once/idempotent finalize — is enforced by the
// SECURITY DEFINER RPCs. This only shapes requests, reads state, and surfaces the server's result.
//
// LIFECYCLE (one hand-over row in pos_shift_force_close):
//   request  → status 'pending'   (orders are SNAPSHOTTED, not yet moved)
//   decide   → 'accepted' | 'rejected'   (recipient; still no orders moved)
//   finalize → 'finalized'   (orders move to the recipient shift; source shift closes; report returned)
//   cancel   → 'cancelled'   (requester / pos.close_other_shifts withdraws a pending|accepted hand-over)
//
// DISCOVERY READS: there is no reader RPC. `pos_shift_force_close` carries a branch-scoped SELECT
// RLS policy (tenant_id = current_tenant_id() AND can_access_branch(branch_id)), so the recipient's
// pending hand-overs and the requester's own hand-overs are read directly under RLS — the same
// direct-read pattern findOpenShift uses for pos_shifts. The RECIPIENT CANDIDATE list uses the
// Force-End-specific reader pos_force_end_eligible_recipients (caller needs select_recipient; returns
// active branch members with exactly one open shift). The server re-validates the recipient regardless.

import { callPosRpc, asRecord, requireId, str, strOrNull, num } from "@/lib/pos/rpc";
import { shiftReportFromRow } from "@/lib/pos/shifts";
import { newOpId, nextOpId } from "@/lib/pos/transfers";
import type { EligibleRecipient } from "@/lib/pos/transfers";
import type { DeliveryFeeCashTreatment, ShiftReport } from "@/types/pos";

// Re-export so a surface can mint/rotate the exactly-once request key without importing from two
// modules; the id-rotation contract (same id while the intent fingerprint is unchanged, fresh id
// when it changes) is the shared, unit-tested one from transfers.ts.
export { newOpId, nextOpId };
export type { EligibleRecipient };

export type ForceEndStatus = "pending" | "accepted" | "rejected" | "finalized" | "cancelled";

const FORCE_END_STATUSES: ForceEndStatus[] = ["pending", "accepted", "rejected", "finalized", "cancelled"];

function toForceEndStatus(v: unknown): ForceEndStatus {
  const s = str(v);
  return (FORCE_END_STATUSES as string[]).includes(s) ? (s as ForceEndStatus) : "pending";
}

/** A Force-End hand-over row, read directly under the branch-scoped SELECT RLS. */
export type ForceEndRequestRow = {
  requestId: string;
  branchId: string;
  sourceShiftId: string;
  sourceCashierId: string;
  requestedBy: string;
  recipientUserId: string;
  recipientShiftId: string;
  status: ForceEndStatus;
  /** How many unpaid open orders are snapshotted to move on finalize. */
  orderCount: number;
  note: string | null;
  createdAt: string | null;
  acceptedAt: string | null;
  rejectedAt: string | null;
  rejectReason: string | null;
  finalizedAt: string | null;
  cancelledAt: string | null;
};

export type ForceEndRequestResult = { requestId: string; status: ForceEndStatus; recipientShiftId: string; orders: number };
export type ForceEndDecisionResult = { requestId: string; status: ForceEndStatus };
export type ForceEndCancelResult = { requestId: string; status: ForceEndStatus };
export type ForceEndFinalizeResult = {
  requestId: string;
  status: ForceEndStatus;
  ordersMoved: number;
  recipientShiftId: string;
  idempotent: boolean;
  /** The source shift's close report (same shape pos_end_shift returns), mapped with one source of truth. */
  report: ShiftReport;
};

const COLUMNS =
  "id, branch_id, source_shift_id, source_cashier_id, requested_by, recipient_user_id, recipient_shift_id, status, order_snapshot, note, created_at, accepted_at, rejected_at, reject_reason, finalized_at, cancelled_at";

// `pos_shift_force_close` postdates `database.types.ts` (generated before R4), so `supabase.from`
// does not know the table — the same reason rpc.ts carries ONE documented cast for RPCs. This is the
// read-path equivalent: a minimal chainable, awaitable shim typed to the three builder methods these
// reads use. The rows are still parsed at runtime into `ForceEndRequestRow`; nothing above sees `unknown`.
type RlsResult = { data: unknown; error: { message: string } | null };
interface ForceCloseQuery extends PromiseLike<RlsResult> {
  select(cols: string): ForceCloseQuery;
  eq(col: string, val: string): ForceCloseQuery;
  in(col: string, vals: string[]): ForceCloseQuery;
  order(col: string, opts: { ascending: boolean }): ForceCloseQuery;
}
async function readForceClose(build: (q: ForceCloseQuery) => ForceCloseQuery): Promise<ForceEndRequestRow[]> {
  const { supabase } = await import("@/lib/supabase");
  const client = supabase as unknown as { from(table: string): ForceCloseQuery };
  const { data, error } = await build(client.from("pos_shift_force_close").select(COLUMNS));
  if (error) throw new Error(error.message);
  return Array.isArray(data) ? data.map(toRow) : [];
}

function toRow(raw: unknown): ForceEndRequestRow {
  const r = asRecord(raw);
  return {
    requestId: str(r.id),
    branchId: str(r.branch_id),
    sourceShiftId: str(r.source_shift_id),
    sourceCashierId: str(r.source_cashier_id),
    requestedBy: str(r.requested_by),
    recipientUserId: str(r.recipient_user_id),
    recipientShiftId: str(r.recipient_shift_id),
    status: toForceEndStatus(r.status),
    orderCount: Array.isArray(r.order_snapshot) ? r.order_snapshot.length : 0,
    note: strOrNull(r.note),
    createdAt: strOrNull(r.created_at),
    acceptedAt: strOrNull(r.accepted_at),
    rejectedAt: strOrNull(r.rejected_at),
    rejectReason: strOrNull(r.reject_reason),
    finalizedAt: strOrNull(r.finalized_at),
    cancelledAt: strOrNull(r.cancelled_at),
  };
}

/**
 * Pending Force-End hand-overs addressed to this user — shown on their Open Shift so they can accept
 * (take the orders into their open shift) or reject. Self-scoped by `recipient_user_id`; the
 * branch-scoped SELECT RLS already limits the rows the query can see.
 */
export async function listIncomingForceEnds(userId: string): Promise<ForceEndRequestRow[]> {
  return readForceClose((q) => q.eq("recipient_user_id", userId).eq("status", "pending").order("created_at", { ascending: false }));
}

/**
 * This requester's own Force-End hand-overs that are still actionable — pending (cancellable),
 * accepted (finalizable), or rejected (so the UI can say so and the requester can start again).
 * Scoped by `requested_by`; the branch-scoped SELECT RLS limits visibility.
 */
export async function listMyForceEndRequests(userId: string): Promise<ForceEndRequestRow[]> {
  return readForceClose((q) =>
    q.eq("requested_by", userId).in("status", ["pending", "accepted", "rejected"]).order("created_at", { ascending: false }),
  );
}

/**
 * The recipient candidate list for the hand-over picker.
 *
 * Uses the Force-End-specific reader `pos_force_end_eligible_recipients`, which matches the request
 * RPC's contract exactly: the caller needs `pos.transfers.select_recipient` (NOT transfers.create),
 * and it returns active branch members (excluding the caller) who have EXACTLY ONE open shift on the
 * branch. The server remains authoritative — this list is a convenience, never an authority.
 */
export async function listForceEndRecipientCandidates(branchId: string): Promise<EligibleRecipient[]> {
  const rows = await callPosRpc("pos_force_end_eligible_recipients", { p_branch: branchId });
  if (!Array.isArray(rows)) return [];
  return rows.map((raw) => {
    const r = asRecord(raw);
    return {
      userId: str(r.user_id),
      fullName: strOrNull(r.full_name),
      email: strOrNull(r.email),
      role: strOrNull(r.role),
    };
  });
}

// --- Pure payload builders (extracted so the shape + exactly-once contract is unit-testable) -----

/** REQUEST payload. `client_op_id` is the exactly-once key (reuse the SAME id across retries of one
 *  intent; rotate it when the recipient/shift changes — see nextOpId). `note` is sent only when present. */
export function buildRequestPayload(input: { shiftId: string; recipientUserId: string; note?: string | null; clientOpId?: string }): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    shift_id: input.shiftId,
    recipient_user_id: input.recipientUserId,
    client_op_id: input.clientOpId ?? newOpId(),
  };
  if (input.note && input.note.trim()) payload.note = input.note.trim();
  return payload;
}

/** DECIDE payload — the recipient accepts or rejects. `reason` is sent only for a reject with text. */
export function buildDecidePayload(input: { requestId: string; accept: boolean; reason?: string | null }): Record<string, unknown> {
  const payload: Record<string, unknown> = { request_id: input.requestId, accept: input.accept };
  if (!input.accept && input.reason && input.reason.trim()) payload.reason = input.reason.trim();
  return payload;
}

/** CANCEL payload — requester (or pos.close_other_shifts) withdraws a pending/accepted hand-over. */
export function buildCancelPayload(input: { requestId: string; reason?: string | null }): Record<string, unknown> {
  const payload: Record<string, unknown> = { request_id: input.requestId };
  if (input.reason && input.reason.trim()) payload.reason = input.reason.trim();
  return payload;
}

/** FINALIZE payload. The cash figures mirror exactly what the normal End-Shift collects; the server
 *  defaults an omitted `actual_cash_counted` to 0 and an omitted treatment to the pre-feature behaviour.
 *  `currency` / `delivery_fee_cash_treatment` / `notes` are sent only when present (never null/blank). */
export function buildFinalizePayload(input: {
  requestId: string;
  actualCashCounted: number;
  currency?: string | null;
  deliveryFeeCashTreatment?: DeliveryFeeCashTreatment;
  notes?: string | null;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    request_id: input.requestId,
    actual_cash_counted: Number(input.actualCashCounted) || 0,
  };
  if (input.currency && input.currency.trim()) payload.currency = input.currency.trim();
  if (input.deliveryFeeCashTreatment) payload.delivery_fee_cash_treatment = input.deliveryFeeCashTreatment;
  if (input.notes && input.notes.trim()) payload.notes = input.notes.trim();
  return payload;
}

// --- Wrappers ----------------------------------------------------------------

/** Start a Force-End hand-over. Snapshots the source shift's UNPAID open orders and binds a recipient
 *  who has exactly one open shift on the branch. The shift stays OPEN until finalize. Reuse the SAME
 *  `clientOpId` across retries of one intent for exactly-once semantics. */
export async function requestForceEndShift(input: {
  shiftId: string;
  recipientUserId: string;
  note?: string | null;
  clientOpId?: string;
}): Promise<ForceEndRequestResult> {
  const r = asRecord(await callPosRpc("pos_force_end_shift_request", { p_payload: buildRequestPayload(input) }));
  return {
    requestId: requireId(r.request_id, "pos_force_end_shift_request", "request_id"),
    status: toForceEndStatus(r.status),
    recipientShiftId: str(r.recipient_shift_id),
    orders: num(r.orders),
  };
}

/** The RECIPIENT accepts or rejects a pending hand-over. Moves no orders either way. */
export async function decideForceEndShift(input: { requestId: string; accept: boolean; reason?: string | null }): Promise<ForceEndDecisionResult> {
  const r = asRecord(await callPosRpc("pos_force_end_shift_decide", { p_payload: buildDecidePayload(input) }));
  return {
    requestId: requireId(r.request_id, "pos_force_end_shift_decide", "request_id"),
    status: toForceEndStatus(r.status),
  };
}

/** Requester (or a holder of pos.close_other_shifts) cancels a pending/accepted hand-over. */
export async function cancelForceEndShift(input: { requestId: string; reason?: string | null }): Promise<ForceEndCancelResult> {
  const r = asRecord(await callPosRpc("pos_force_end_shift_cancel", { p_payload: buildCancelPayload(input) }));
  return {
    requestId: requireId(r.request_id, "pos_force_end_shift_cancel", "request_id"),
    status: toForceEndStatus(r.status),
  };
}

/** Finalize an ACCEPTED hand-over: moves the unpaid orders to the recipient shift and closes the
 *  source shift (R7-aware end-shift path), returning its close report. IDEMPOTENT — a repeat of the
 *  same request returns the stored report with `idempotent: true`, never closing or moving twice. */
export async function finalizeForceEndShift(input: {
  requestId: string;
  actualCashCounted: number;
  currency?: string | null;
  deliveryFeeCashTreatment?: DeliveryFeeCashTreatment;
  notes?: string | null;
}): Promise<ForceEndFinalizeResult> {
  const r = asRecord(await callPosRpc("pos_force_end_shift_finalize", { p_payload: buildFinalizePayload(input) }));
  return {
    requestId: requireId(r.request_id, "pos_force_end_shift_finalize", "request_id"),
    status: toForceEndStatus(r.status),
    ordersMoved: num(r.orders_moved),
    recipientShiftId: str(r.recipient_shift_id),
    idempotent: r.idempotent === true,
    report: shiftReportFromRow(r, "pos_force_end_shift_finalize"),
  };
}
