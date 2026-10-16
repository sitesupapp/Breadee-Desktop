// Phase D — LOCAL DRAWER PROJECTION (operational continuity ONLY).
//
// This is NOT accounting, NOT the Reporting Engine, NOT canonical finance. It is a best-effort
// local view of "how much cash should be in this drawer right now", so a cashier working offline
// can keep operating (and so an offline CASH refund visibly reduces the drawer immediately). After
// sync, the canonical server shift/drawer (pos_cash_box_shift / pos_shift_expected) is authoritative
// and REPLACES this — the projection never writes to or overrides server finance.
//
// The pure core operates on movements already normalized to USD by the caller (the one place that
// knows each op's currency + rate). A movement whose USD amount is NOT locally known is carried as
// `pending` and excluded from the numeric total rather than guessed — the projection prefers to say
// "unreconciled" over inventing a figure.

import type { OfflineOperation } from "@/lib/offline/operationLog";

export type DrawerMovementKind = "sale" | "refund" | "payout";

/** One normalized drawer movement. `amountUsd` is positive; `kind` sets the sign. */
export type DrawerMovement = {
  kind: DrawerMovementKind;
  method: string;
  amountUsd: number;
  /** The operation that produced it (for drill-down / dedup). */
  operationId: string;
};

export type DrawerProjection = {
  openingFloatUsd: number;
  /** opening float + cash sales − cash refunds − cash payouts (CASH tender only). */
  expectedCashUsd: number;
  cashInUsd: number;
  cashOutUsd: number;
  /** Net settled per tender method (sales positive, refunds/payouts negative). */
  byMethod: Record<string, number>;
  movementCount: number;
  /** How many cash-affecting ops were seen but had NO locally-known USD amount (excluded from the
   *  totals). When > 0 the drawer is explicitly not fully reconcilable offline. */
  unknownAmountCount: number;
  /** True when there is unsynced/unknown work behind this projection — the operator sees it is a
   *  provisional local figure, not the canonical drawer. */
  pending: boolean;
};

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Compute the drawer projection from normalized USD movements + the opening float. Pure; the sign
 * rule is fixed here (sale = in, refund/payout = out) so no caller can disagree.
 */
export function computeDrawerProjection(
  openingFloatUsd: number,
  movements: DrawerMovement[],
  opts?: { unknownAmountCount?: number; hasUnsynced?: boolean },
): DrawerProjection {
  let cashIn = 0;
  let cashOut = 0;
  const byMethod: Record<string, number> = {};
  for (const m of movements) {
    const signed = m.kind === "sale" ? m.amountUsd : -m.amountUsd;
    byMethod[m.method] = round2((byMethod[m.method] ?? 0) + signed);
    if (m.method === "cash") {
      if (m.kind === "sale") cashIn = round2(cashIn + m.amountUsd);
      else cashOut = round2(cashOut + m.amountUsd);
    }
  }
  const unknown = opts?.unknownAmountCount ?? 0;
  return {
    openingFloatUsd: round2(openingFloatUsd),
    expectedCashUsd: round2(openingFloatUsd + cashIn - cashOut),
    cashInUsd: cashIn,
    cashOutUsd: cashOut,
    byMethod,
    movementCount: movements.length,
    unknownAmountCount: unknown,
    pending: (opts?.hasUnsynced ?? false) || movements.length > 0 || unknown > 0,
  };
}

/** The immutable scope a drawer belongs to (the live till). */
export type DrawerScope = {
  tenantId: string;
  branchId: string | null;
  cashierUserId: string;
  deviceId: string;
  terminalId: string | null;
};

function inScope(op: OfflineOperation, s: DrawerScope): boolean {
  return (
    op.scope.tenant_id === s.tenantId &&
    (op.scope.branch_id ?? null) === (s.branchId ?? null) &&
    op.scope.cashier_user_id === s.cashierUserId &&
    op.scope.device_id === s.deviceId &&
    (s.terminalId == null || (op.scope.terminal_id || null) === s.terminalId)
  );
}

/**
 * Best-effort extraction of drawer movements from the offline operation log, scope-exact. Only ops
 * that carry a locally-known USD amount contribute a movement; the rest are counted as
 * `unknownAmountCount` (NOT guessed). Terminal-cancelled ops never contribute.
 *
 *   void_refund  → cash refund OUT  (tender 'cash', expected_refund_usd)
 *   pay_table/pay_order → cash sale IN (method 'cash', cash_amount_usd — recorded at capture)
 *   payout       → cash payout OUT  (method 'cash'/null treated as cash, amount_usd)
 *
 * on_account is a RECEIVABLE, never a cash-in, so it is not a drawer movement. takeaway_sale is
 * intentionally excluded here (its cash amount lives in the nested order payload, not a flat field);
 * it is accounted for by the server on sync. This keeps the projection honest rather than parsing
 * nested order math client-side.
 */
export function extractDrawerMovements(
  ops: OfflineOperation[],
  scope: DrawerScope,
): { movements: DrawerMovement[]; unknownAmountCount: number } {
  const movements: DrawerMovement[] = [];
  let unknown = 0;
  for (const op of ops) {
    if (op.status === "cancelled") continue;
    if (!inScope(op, scope)) continue;
    const p = (op.payload ?? {}) as Record<string, unknown>;
    if (op.operation_type === "void_refund") {
      if (p.refund === true && p.tender === "cash") {
        const usd = typeof p.expected_refund_usd === "number" ? p.expected_refund_usd : null;
        if (usd != null && usd > 0) movements.push({ kind: "refund", method: "cash", amountUsd: usd, operationId: op.operation_id });
        else unknown++;
      }
    } else if (op.operation_type === "pay_table" || op.operation_type === "pay_order") {
      if (p.method === "cash") {
        const usd = typeof p.cash_amount_usd === "number" ? p.cash_amount_usd : null;
        if (usd != null && usd > 0) movements.push({ kind: "sale", method: "cash", amountUsd: usd, operationId: op.operation_id });
        else unknown++;
      } else if (typeof p.method === "string" && typeof p.cash_amount_usd === "number" && p.cash_amount_usd > 0) {
        // A non-cash tender still contributes to its per-method total (not to cash).
        movements.push({ kind: "sale", method: p.method, amountUsd: p.cash_amount_usd, operationId: op.operation_id });
      }
    } else if (op.operation_type === "payout") {
      const usd = typeof p.amount_usd === "number" ? p.amount_usd : null;
      const method = typeof p.method === "string" && p.method ? p.method : "cash";
      if (usd != null && usd > 0) movements.push({ kind: "payout", method, amountUsd: usd, operationId: op.operation_id });
      else unknown++;
    } else if (op.operation_type === "receivable_collect") {
      // A cash receivable collection is cash INTO the drawer (sale sign). A non-cash tender goes to
      // its own per-method total, not to cash. Only a locally-known USD amount contributes.
      if (p.method === "cash") {
        const usd = typeof p.cash_amount_usd === "number" ? p.cash_amount_usd : null;
        if (usd != null && usd > 0) movements.push({ kind: "sale", method: "cash", amountUsd: usd, operationId: op.operation_id });
        else unknown++;
      } else if (typeof p.method === "string" && typeof p.cash_amount_usd === "number" && p.cash_amount_usd > 0) {
        movements.push({ kind: "sale", method: p.method, amountUsd: p.cash_amount_usd, operationId: op.operation_id });
      }
    }
  }
  return { movements, unknownAmountCount: unknown };
}
