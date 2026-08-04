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
