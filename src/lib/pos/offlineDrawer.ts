// Offline-first recovery — Bug 12: the DRAWER control offline.
//
// What the Drawer button does today (PosStatusBar): it opens a popover showing the active shift's
// EXPECTED CASH (`pos_cash_box_shift.expected_cash`, USD). It opens no physical drawer and writes
// nothing — so there is no audit operation to queue, and reconnecting can never create a Drawer effect.
//
// Through 1.0.38 the button rendered only when that server value had been read in THIS run, so it
// vanished whenever the device was offline, on every offline-opened shift, and after any restart
// without a connection. Visibility is now decided from durable local state:
//   * the cashier's own active shift (as the server does: own shift), and
//   * the cached, entitlement-verified grant `pos.take_payments` — the exact permission
//     `pos_cash_box_shift` requires. A user without it stays blocked offline.
// Offline, the popover shows a clearly labelled PROVISIONAL figure: the last server-confirmed drawer
// for this shift (cached per shift on every successful read) — or, for a shift opened offline, its
// opening float — plus the cash movements captured on this device since. Movements whose USD amount is
// not locally known are counted, never guessed. After sync the server figure replaces it.

import type { CashBox } from "@/types/pos";
import type { OfflineOperation } from "@/lib/offline/operationLog";
import { extractDrawerMovements, type DrawerMovement, type DrawerScope } from "@/lib/offline/drawerProjection";

const CACHE_PREFIX = "breadee-desktop-cashbox:";

/** The permission the server's cash-box read requires (own shift). */
export const DRAWER_PERMISSION = "pos.take_payments";

export function canSeeDrawer(permissions: Record<string, boolean>, hasOpenShift: boolean): boolean {
  return hasOpenShift && permissions[DRAWER_PERMISSION] === true;
}

type CachedBox = { shiftId: string; expectedCashUsd: number; fetchedAtMs: number };

/** Remember the last server-confirmed drawer of a shift (write-through on every successful read). */
export function cacheServerCashBox(shiftId: string, box: CashBox, fetchedAtMs = Date.now()): void {
  if (!shiftId || !Number.isFinite(Number(box.expected_cash))) return;
  try {
    localStorage.setItem(CACHE_PREFIX + shiftId, JSON.stringify({ shiftId, expectedCashUsd: Number(box.expected_cash), fetchedAtMs } satisfies CachedBox));
  } catch {
    /* storage unavailable: offline the opening-float base is used */
  }
}

export function readCachedServerCashBox(shiftId: string): CachedBox | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + shiftId);
    const c = raw ? (JSON.parse(raw) as CachedBox) : null;
    return c && c.shiftId === shiftId && Number.isFinite(c.expectedCashUsd) && Number.isFinite(c.fetchedAtMs) ? c : null;
  } catch {
    return null;
  }
}

export type OfflineDrawerView = {
  /** Base + in − out, or null when the base itself is not locally known in USD. */
  projectedUsd: number | null;
  baseUsd: number | null;
  baseSource: "server" | "opening_float" | null;
  /** When the server figure was read (server base only). */
  baseAtMs: number | null;
  cashInUsd: number;
  cashOutUsd: number;
  movementCount: number;
  /** Cash movements captured offline whose USD amount is not locally known (excluded, not guessed). */
  unknownAmountCount: number;
};

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Cash-paid offline TAKEAWAY / DELIVERY sales (`takeaway_sale` with a cash payment intent). The op
 * carries the undiscounted cart total in its own currency; a discounted sale or an unknown rate is an
 * unknown amount (counted, never guessed). drawerProjection deliberately leaves these out of its own
 * extraction, so the two never double-count.
 */
export function extractTakeawayCashMovements(
  ops: OfflineOperation[],
  scope: DrawerScope,
  usdRate: number | null,
): { movements: DrawerMovement[]; unknownAmountCount: number } {
  const movements: DrawerMovement[] = [];
  let unknown = 0;
  for (const op of ops) {
    if (op.status === "cancelled" || op.operation_type !== "takeaway_sale") continue;
    const s = op.scope;
    if (s.tenant_id !== scope.tenantId || (s.branch_id ?? null) !== (scope.branchId ?? null) || s.cashier_user_id !== scope.cashierUserId || s.device_id !== scope.deviceId) continue;
    if (scope.terminalId != null && (s.terminal_id || null) !== scope.terminalId) continue;
    const p = (op.payload ?? {}) as { payment_intent?: { method?: unknown; currency?: unknown; discount?: unknown } | null; total?: unknown; currency?: unknown };
    const intent = p.payment_intent;
    if (!intent || intent.method !== "cash") continue;
    const total = Number(p.total);
    const cur = String(intent.currency ?? p.currency ?? "");
    const discounted = intent.discount != null && typeof intent.discount === "object" && Object.keys(intent.discount as object).length > 0;
    let usd: number | null = null;
    if (!discounted && Number.isFinite(total) && total > 0) {
      if (cur === "USD") usd = total;
      else if (cur === "LBP" && usdRate && usdRate > 0) usd = round2(total / usdRate);
    }
    if (usd != null && usd > 0) movements.push({ kind: "sale", method: "cash", amountUsd: usd, operationId: op.operation_id });
    else unknown++;
  }
  return { movements, unknownAmountCount: unknown };
}

/** PURE — the provisional offline drawer for one shift. */
export function buildOfflineDrawerView(input: {
  ops: OfflineOperation[];
  scope: DrawerScope;
  server: CachedBox | null;
  /** The shift's opening float in USD, when known locally (offline-opened shift). */
  openingFloatUsd: number | null;
  shiftOpenedAtMs: number | null;
  usdRate: number | null;
}): OfflineDrawerView {
  // Only movements AFTER the base: after the cached server read, else after the shift opened.
  const sinceMs = input.server ? input.server.fetchedAtMs : input.shiftOpenedAtMs ?? 0;
  const after = input.ops.filter((o) => {
    const t = Date.parse(o.created_at);
    return Number.isFinite(t) && t > sinceMs;
  });
  const a = extractDrawerMovements(after, input.scope);
  const b = extractTakeawayCashMovements(after, input.scope, input.usdRate);
  let cashIn = 0;
  let cashOut = 0;
  for (const m of [...a.movements, ...b.movements]) {
    if (m.method !== "cash") continue;
    if (m.kind === "sale") cashIn = round2(cashIn + m.amountUsd);
    else cashOut = round2(cashOut + m.amountUsd);
  }
  const baseUsd = input.server ? input.server.expectedCashUsd : input.openingFloatUsd;
  return {
    projectedUsd: baseUsd == null ? null : round2(baseUsd + cashIn - cashOut),
    baseUsd,
    baseSource: input.server ? "server" : input.openingFloatUsd != null ? "opening_float" : null,
    baseAtMs: input.server ? input.server.fetchedAtMs : null,
    cashInUsd: cashIn,
    cashOutUsd: cashOut,
    movementCount: a.movements.length + b.movements.length,
    unknownAmountCount: a.unknownAmountCount + b.unknownAmountCount,
  };
}

/** Load the offline drawer view for the active shift from the local operation log (no network). */
export async function loadOfflineDrawerView(args: {
  shiftId: string;
  pendingLocal: boolean;
  openingCashAmount: number;
  openingCurrency: string;
  openedAt: string | null;
  scope: DrawerScope;
  usdRate: number | null;
}): Promise<OfflineDrawerView> {
  const { localdb } = await import("@/lib/offline/db");
  // The op log is retention-bounded (synced ops 30 days); scope + time filtering happens in the pure core.
  const ops = (await localdb.operations.toArray()) as OfflineOperation[];
  const server = args.pendingLocal ? null : readCachedServerCashBox(args.shiftId);
  let openingFloatUsd: number | null = null;
  if (!server) {
    if (args.openingCurrency === "USD") openingFloatUsd = args.openingCashAmount;
    else if (args.openingCurrency === "LBP" && args.usdRate && args.usdRate > 0) openingFloatUsd = round2(args.openingCashAmount / args.usdRate);
  }
  const opened = args.openedAt ? Date.parse(args.openedAt) : NaN;
  return buildOfflineDrawerView({ ops, scope: args.scope, server, openingFloatUsd, shiftOpenedAtMs: Number.isFinite(opened) ? opened : null, usdRate: args.usdRate });
}
