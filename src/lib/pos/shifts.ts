// Shift lifecycle against the staging contracts.
//
// Every number that reaches the cashier's eyes comes from the server:
//   * pos_open_shift      (m223) - enforces pos.open_shift + the pos.shifts
//                                  sub-feature; resolves the branch server-side,
//                                  so a client branch_id is never trusted.
//   * pos_shift_expected  (m255) - expected cash = opening float + cash taken.
//   * pos_cash_box_shift  (m255/m256) - live drawer, excludes voided/cancelled/
//                                  refunded orders.
//   * pos_end_shift       (m255) - gross is PRE-discount, net is payable; sets
//                                  status = pending_manager_review.
//
// This module deliberately performs NO financial arithmetic. If a total is
// needed, it is read from the RPC response. That is the whole point: the desktop
// can never disagree with the shift report.

import type { ActiveShift, CashBox, ShiftExpected, ShiftReport, ShiftStatus } from "@/types/pos";
import { asRecord, bool, callPosRpc, num, numOrNull, requireId, str, strOrNull } from "@/lib/pos/rpc";

const SHIFT_STATUSES: ShiftStatus[] = ["open", "ended_by_cashier", "pending_manager_review", "approved", "rejected"];

function toShiftStatus(value: unknown): ShiftStatus {
  const s = str(value);
  return (SHIFT_STATUSES as string[]).includes(s) ? (s as ShiftStatus) : "open";
}

/**
 * The operator's currently open shift, if any. Read straight from `pos_shifts`
 * under RLS - the same query the web POS uses to decide whether to prompt for a
 * shift. Returns null when nothing is open.
 */
export async function findOpenShift(tenantId: string, userId: string): Promise<ActiveShift | null> {
  const { supabase } = await import("@/lib/supabase");
  const { data, error } = await supabase
    .from("pos_shifts")
    .select("id, status, opened_at, opening_cash_amount, branch_id")
    .eq("tenant_id", tenantId)
    .eq("cashier_user_id", userId)
    .eq("status", "open")
    .order("opened_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const row = asRecord(data);
  return {
    id: str(row.id),
    status: toShiftStatus(row.status),
    opened_at: strOrNull(row.opened_at),
    opening_cash_amount: num(row.opening_cash_amount),
    branch_id: strOrNull(row.branch_id),
  };
}

/**
 * Open a shift. `branch_id` is sent because the server uses it as a REQUEST that
 * `pos_resolve_operational_branch` validates - a foreign branch is rejected, not
 * honoured. The opening float is optional and defaults to 0.
 */
export async function openShift(input: { branchId: string | null; openingCash: number }): Promise<{ shiftId: string }> {
  const data = await callPosRpc("pos_open_shift", {
    p_payload: {
      branch_id: input.branchId,
      opening_cash_amount: Number(input.openingCash) || 0,
    },
  });
  const row = asRecord(data);
  return { shiftId: requireId(row.shift_id, "pos_open_shift", "shift_id") };
}

/** Expected-cash preview. Pure server truth - shown, never recomputed. */
export async function getShiftExpected(shiftId: string): Promise<ShiftExpected> {
  const row = asRecord(await callPosRpc("pos_shift_expected", { p_shift: shiftId }));
  return {
    expected: num(row.expected),
    cash_sales: num(row.cash_sales),
    orders: num(row.orders),
    opening_cash: num(row.opening_cash),
    cash_usd: num(row.cash_usd),
    cash_lbp_original: num(row.cash_lbp_original),
    cash_lbp_usd: num(row.cash_lbp_usd),
    exchange_rate: numOrNull(row.exchange_rate),
  };
}

/** Live cash drawer for the open shift. Pure server truth. */
export async function getCashBox(shiftId: string | null): Promise<CashBox> {
  const row = asRecord(await callPosRpc("pos_cash_box_shift", { p_shift: shiftId }));
  return {
    shift_id: strOrNull(row.shift_id),
    shift_open: bool(row.shift_open),
    opened_at: strOrNull(row.opened_at),
    opening_cash: num(row.opening_cash),
    branch_id: strOrNull(row.branch_id),
    branch_name: strOrNull(row.branch_name),
    exchange_rate: numOrNull(row.exchange_rate),
    cash_usd: num(row.cash_usd),
    cash_lbp: num(row.cash_lbp),
    cash_lbp_usd: num(row.cash_lbp_usd),
    total_usd: num(row.total_usd),
    total_lbp: numOrNull(row.total_lbp),
    expected_cash: num(row.expected_cash),
    payment_count: num(row.payment_count),
  };
}

function toByItem(value: unknown): ShiftReport["by_item"] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const r = asRecord(entry);
    return { item: str(r.item, "Item"), qty: num(r.qty), total: num(r.total) };
  });
}

function toPayments(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(asRecord(value))) out[k] = num(v);
  return out;
}

/**
 * End the shift. The server computes and stores the report and moves the shift to
 * `pending_manager_review` - the desktop only supplies the counted cash and note.
 */
export async function endShift(input: {
  shiftId: string;
  actualCashCounted: number;
  notes: string | null;
}): Promise<ShiftReport> {
  const row = asRecord(
    await callPosRpc("pos_end_shift", {
      p_payload: {
        shift_id: input.shiftId,
        actual_cash_counted: Number(input.actualCashCounted) || 0,
        notes: input.notes && input.notes.trim() !== "" ? input.notes.trim() : null,
      },
    }),
  );
  return {
    shift_id: requireId(row.shift_id, "pos_end_shift", "shift_id"),
    orders: num(row.orders),
    gross_sales: num(row.gross_sales),
    discounts: num(row.discounts),
    net_sales: num(row.net_sales),
    cancelled_void: num(row.cancelled_void),
    refunded_count: num(row.refunded_count),
    cash_sales: num(row.cash_sales),
    opening_cash: num(row.opening_cash),
    expected_cash: num(row.expected_cash),
    actual_cash: num(row.actual_cash),
    difference: num(row.difference),
    notes: strOrNull(row.notes),
    opened_at: strOrNull(row.opened_at),
    closed_at: strOrNull(row.closed_at),
    cash_usd: num(row.cash_usd),
    cash_lbp_original: num(row.cash_lbp_original),
    cash_lbp_usd: num(row.cash_lbp_usd),
    exchange_rate: numOrNull(row.exchange_rate),
    by_item: toByItem(row.by_item),
    payments: toPayments(row.payments),
  };
}

/** Human label for a difference, using the same vocabulary as the web report. */
export function differenceLabel(difference: number): { label: string; tone: "green" | "amber" | "red" } {
  const d = Number(difference) || 0;
  if (Math.abs(d) < 0.005) return { label: "Balanced", tone: "green" };
  // difference = expected - actual, so a POSITIVE difference means cash is missing.
  return d > 0 ? { label: "Shortage", tone: "red" } : { label: "Overage", tone: "amber" };
}

/** Elapsed time since a shift opened, as a stable "Hh Mm" string. */
export function elapsedSince(openedAt: string | null, now: number): string {
  if (!openedAt) return "--";
  const start = Date.parse(openedAt);
  if (!Number.isFinite(start)) return "--";
  const mins = Math.max(0, Math.floor((now - start) / 60000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
