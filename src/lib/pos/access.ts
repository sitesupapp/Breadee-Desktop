// Canonical POS access for the desktop app - ported from the web app's
// `src/lib/posAccess.ts`.
//
// This REPLACES the old role-list gate (`permissions.canUsePOS`), which admitted
// tenant owners that `pos_assert_operator` (m93) rejects server-side, and which
// ignored the effective permission map entirely.
//
// The rule is the documented effective-access order, evaluated in the same
// sequence the database uses:
//
//   active membership -> feature (plan + tenant override) -> effective permission
//   -> action-specific safeguard (Owner is not an operational POS user)
//
// Role names are NOT consulted except for the one intentional exception: tenant
// owners are blocked from operational POS work, mirroring `pos_assert_operator`.
// Every other decision comes from the effective permission map, so a custom
// tenant role behaves exactly like a system role with the same permissions.
//
// Unknown keys fail closed. NONE of this is a security boundary - the RPCs and
// RLS re-enforce every rule. This exists so the UI is honest and a cashier never
// discovers a refusal only after pressing Pay.

import { FEATURES, hasFeature, type FeatureMap } from "@/lib/features";
import { isActiveMember } from "@/lib/permissions";
import type { TenantRole, UserStatus } from "@/lib/types";

export type PermissionMap = Record<string, boolean>;

export type PosMembership = {
  role: TenantRole | null | undefined;
  status: UserStatus | null | undefined;
};

export type PosAccessContext = {
  membership: PosMembership | null | undefined;
  permissions: PermissionMap;
  features: FeatureMap;
};

/** Permission keys this level depends on. Kept as one list so nothing is typo-gated. */
export const POS_PERMISSIONS = {
  ACCESS: "pos.access",
  CREATE_ORDERS: "pos.create_orders",
  TAKE_PAYMENTS: "pos.take_payments",
  APPLY_DISCOUNTS: "pos.apply_discounts",
  OPEN_SHIFT: "pos.open_shift",
  END_OWN_SHIFT: "pos.end_own_shift",
  APPROVE_SHIFTS: "pos.approve_shifts",
  // Dine-In tables. VIEW and OPEN are used in Level 2A; MOVE/CLEAR/CLOSE are
  // declared now so the keys live in one place, but nothing calls them yet -
  // their RPCs are not even in the `PosRpcName` union.
  TABLES_VIEW: "pos.tables.view",
  TABLES_OPEN: "pos.tables.open",
  TABLES_MOVE: "pos.tables.move",
  TABLES_CLEAR: "pos.tables.clear",
  TABLES_CLOSE: "pos.tables.close",
} as const;

/** Owners are deliberately not operational POS users - same rule as pos_assert_operator. */
export function isOperationalRole(role: TenantRole | null | undefined): boolean {
  return role !== "owner";
}

function baseEligible(m: PosMembership | null | undefined): boolean {
  return !!m && isActiveMember(m.status) && isOperationalRole(m.role);
}

const perm = (ctx: PosAccessContext, key: string): boolean => Boolean(ctx.permissions?.[key]);

/** POS workspace / takeaway / dine-in / delivery / orders. */
export function canOperatePOS(ctx: PosAccessContext): boolean {
  return baseEligible(ctx.membership) && hasFeature(ctx.features, FEATURES.POS) && perm(ctx, POS_PERMISSIONS.ACCESS);
}

/**
 * Why POS is unavailable, in the order the server would refuse. Returned so the
 * UI can explain rather than silently hide - and phrased to match the server.
 */
export function posAccessDenialReason(ctx: PosAccessContext): string | null {
  const m = ctx.membership;
  if (!m || !isActiveMember(m.status)) return "Your membership is not active for this tenant.";
  if (!isOperationalRole(m.role)) {
    return "Owners cannot perform POS operations. Use a branch operator account (manager/cashier).";
  }
  if (!hasFeature(ctx.features, FEATURES.POS)) return "POS is not enabled for this plan.";
  if (!perm(ctx, POS_PERMISSIONS.ACCESS)) return "You are not allowed to use POS.";
  return null;
}

/** A POS sub-route (takeaway / dine-in / delivery) also needs its own sub-feature. */
export function canUseOrderType(ctx: PosAccessContext, feature: string): boolean {
  return canOperatePOS(ctx) && hasFeature(ctx.features, feature);
}

// --- Action-level gates ------------------------------------------------------
//
// Each returns a reason string when the action is NOT permitted, so a control can
// stay visible-but-disabled with a tooltip instead of vanishing.

export type Gate = { allowed: boolean; reason: string | null };

const gate = (allowed: boolean, reason: string): Gate => ({ allowed, reason: allowed ? null : reason });

export function canCreateOrders(ctx: PosAccessContext): Gate {
  return gate(perm(ctx, POS_PERMISSIONS.CREATE_ORDERS), "You do not have permission to create orders.");
}

export function canTakePayments(ctx: PosAccessContext): Gate {
  return gate(perm(ctx, POS_PERMISSIONS.TAKE_PAYMENTS), "You do not have permission to take payments.");
}

export function canApplyDiscounts(ctx: PosAccessContext): Gate {
  return gate(perm(ctx, POS_PERMISSIONS.APPLY_DISCOUNTS), "You do not have permission to apply discounts.");
}

/** Opening a shift additionally requires the `pos.shifts` sub-feature (m223). */
export function canOpenShift(ctx: PosAccessContext): Gate {
  if (!hasFeature(ctx.features, FEATURES.POS_SHIFTS)) {
    return { allowed: false, reason: "Shifts are not enabled for this plan." };
  }
  return gate(perm(ctx, POS_PERMISSIONS.OPEN_SHIFT), "You do not have permission to open a shift.");
}

/**
 * Ending a shift: your own needs `pos.end_own_shift`; someone else's needs
 * `pos.approve_shifts`. Exactly the branch `pos_end_shift` takes (m255).
 */
export function canEndShift(ctx: PosAccessContext, isOwnShift: boolean): Gate {
  if (isOwnShift) {
    return gate(perm(ctx, POS_PERMISSIONS.END_OWN_SHIFT), "You do not have permission to end your shift.");
  }
  return gate(perm(ctx, POS_PERMISSIONS.APPROVE_SHIFTS), "Only a manager can end another cashier's shift.");
}

/**
 * Reviewing (approve/reject) a closed shift. m225 separation of duties: the
 * cashier who closed a shift may never approve it, whoever they are.
 */
export function canReviewShift(ctx: PosAccessContext, isOwnShift: boolean): Gate {
  if (isOwnShift) {
    return { allowed: false, reason: "You cannot approve your own shift - a manager must review it." };
  }
  return gate(perm(ctx, POS_PERMISSIONS.APPROVE_SHIFTS), "You do not have permission to review shifts.");
}

// --- Dine-In tables ----------------------------------------------------------

/**
 * Entering the Dine-In workspace: POS access + the `pos.dine_in` sub-feature +
 * `pos.tables.view`, which is exactly what `pos_table_map` itself demands.
 */
export function canViewTables(ctx: PosAccessContext): Gate {
  if (!canOperatePOS(ctx)) {
    return { allowed: false, reason: posAccessDenialReason(ctx) ?? "You are not allowed to use POS." };
  }
  if (!hasFeature(ctx.features, FEATURES.POS_DINE_IN)) {
    return { allowed: false, reason: "Dine-in is not enabled for this plan." };
  }
  return gate(perm(ctx, POS_PERMISSIONS.TABLES_VIEW), "You do not have permission to view tables.");
}

/**
 * Opening a table.
 *
 * DESKTOP POLICY: an open shift is required even though `pos_open_table` itself
 * does not demand one. Opening a table without a shift produces a table the
 * cashier cannot then order on (the order path requires a shift) - a dead end
 * that is easy to create and awkward to undo while Clear/Close are out of scope.
 * This is deliberately STRICTER than the server and never looser.
 */
export function canOpenTable(ctx: PosAccessContext, hasOpenShift: boolean): Gate {
  const view = canViewTables(ctx);
  if (!view.allowed) return view;
  if (!perm(ctx, POS_PERMISSIONS.TABLES_OPEN)) {
    return { allowed: false, reason: "You do not have permission to open tables." };
  }
  if (!hasOpenShift) {
    return { allowed: false, reason: "Open a shift before opening a table." };
  }
  return { allowed: true, reason: null };
}

/**
 * Declared for the levels that have not landed yet. Deliberately returns a
 * not-yet-available reason so a disabled control can explain itself honestly,
 * rather than implying the user lacks a permission they may well hold.
 */
export function tableActionNotYetAvailable(action: string, level: string): Gate {
  return { allowed: false, reason: `${action} arrives in ${level}.` };
}

// --- Table operations (Level 2C) ---------------------------------------------
//
// Each mirrors the `_pos_require(tenant, 'pos.tables.X')` the RPC itself runs.
// Viewing tables is a prerequisite for all of them: an operator who cannot see
// the map has no business moving or voiding what is on it.

function tableOpGate(ctx: PosAccessContext, key: string, refusal: string): Gate {
  const view = canViewTables(ctx);
  if (!view.allowed) return view;
  return gate(perm(ctx, key), refusal);
}

export function canMoveTable(ctx: PosAccessContext): Gate {
  return tableOpGate(ctx, POS_PERMISSIONS.TABLES_MOVE, "You do not have permission to move tables.");
}

export function canCloseTable(ctx: PosAccessContext): Gate {
  return tableOpGate(ctx, POS_PERMISSIONS.TABLES_CLOSE, "You do not have permission to close tables.");
}

/**
 * Clearing VOIDS an open bill, so this is the most consequential dine-in
 * permission the desktop exposes. It is still just a permission-map lookup -
 * the server re-checks it, and no role name is consulted here either.
 */
export function canClearTable(ctx: PosAccessContext): Gate {
  return tableOpGate(ctx, POS_PERMISSIONS.TABLES_CLEAR, "You do not have permission to clear tables.");
}
