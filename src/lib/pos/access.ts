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
  // Delivery customers (Level 3A). There is deliberately no `pos.delivery.*`
  // key: the server has none. Delivery order-taking is gated by the ordinary
  // POS permissions plus the `pos.delivery` sub-feature, and only the CUSTOMER
  // record has keys of its own.
  CUSTOMERS_VIEW: "pos.customers.view",
  CUSTOMERS_MANAGE: "pos.customers.manage",
  // Order management (Level 3D). These three are the keys `pos_edit_order` and
  // `pos_void_order` check for themselves; VIEW_ORDERS guards the queue, which
  // is a read of `pos_orders` that RLS already scopes.
  VIEW_ORDERS: "pos.view_orders",
  EDIT_ORDERS: "pos.edit_orders",
  CANCEL_ORDERS: "pos.cancel_orders",
  // Native receipt printing (Level 3E-B). The registry documents this key as
  // "Print or reprint receipts" under the `pos.printing` sub-feature.
  PRINT_RECEIPTS: "pos.print_receipts",
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

// --- Delivery (Level 3A) -----------------------------------------------------

/**
 * Entering the Delivery workspace: POS access + the `pos.delivery` sub-feature.
 *
 * Exactly the shape `canViewTables` uses for Dine-in, because the server treats
 * the two the same way: `pos.delivery` is a sub-feature in `feature_registry`
 * and the web gates its Delivery route on it. There is no delivery permission
 * key to check here - what an operator may DO once inside is decided by the
 * ordinary POS keys and, for the customer record, by the two customer keys.
 */
export function canViewDelivery(ctx: PosAccessContext): Gate {
  if (!canOperatePOS(ctx)) {
    return { allowed: false, reason: posAccessDenialReason(ctx) ?? "You are not allowed to use POS." };
  }
  if (!hasFeature(ctx.features, FEATURES.POS_DELIVERY)) {
    return { allowed: false, reason: "Delivery is not enabled for this plan." };
  }
  return { allowed: true, reason: null };
}

// --- Delivery order management (Level 3D) ------------------------------------
//
// Three separate keys, mirroring the three separate things the server checks.
// They are deliberately not collapsed into one "manage orders" gate: a cashier
// who may correct a note is not thereby a cashier who may reverse a payment, and
// the server agrees - `pos_edit_order` demands `pos.edit_orders` while
// `pos_void_order` demands `pos.cancel_orders`.

/** Seeing the delivery order queue at all. */
export function canViewOrders(ctx: PosAccessContext): Gate {
  const delivery = canViewDelivery(ctx);
  if (!delivery.allowed) return delivery;
  return gate(perm(ctx, POS_PERMISSIONS.VIEW_ORDERS), "You do not have permission to view orders.");
}

/** Editing an order's note or discount - exactly `pos_edit_order`'s own check. */
export function canEditOrders(ctx: PosAccessContext): Gate {
  return gate(perm(ctx, POS_PERMISSIONS.EDIT_ORDERS), "You do not have permission to edit orders.");
}

/**
 * Cancelling an unpaid order, or refunding a paid one.
 *
 * `pos_void_order` gates BOTH on this single key, so the desktop does too. What
 * separates the two actions is the order's payment state, never a permission -
 * see `voidActionFor`.
 */
export function canCancelOrders(ctx: PosAccessContext): Gate {
  return gate(perm(ctx, POS_PERMISSIONS.CANCEL_ORDERS), "You do not have permission to cancel or refund orders.");
}

/**
 * Printing or reprinting a receipt (Level 3E-B).
 *
 * Both halves are required, in the order the server would refuse in: the
 * `pos.printing` sub-feature, then the `pos.print_receipts` permission.
 *
 * The web POS does not currently check this permission before its browser
 * print, but the registry documents the key precisely ("Print or reprint
 * receipts") and the KDS does check it. This path produces PHYSICAL paper, so
 * the desktop enforces the documented rule rather than copying the looser
 * behaviour - stricter than the server, never looser, the same call the
 * dine-in open-table gate makes.
 */
export function canPrintReceipts(ctx: PosAccessContext): Gate {
  if (!canOperatePOS(ctx)) {
    return { allowed: false, reason: posAccessDenialReason(ctx) ?? "You are not allowed to use POS." };
  }
  if (!hasFeature(ctx.features, FEATURES.POS_PRINTING)) {
    return { allowed: false, reason: "Receipt printing is not enabled for this plan." };
  }
  return gate(perm(ctx, POS_PERMISSIONS.PRINT_RECEIPTS), "You do not have permission to print receipts.");
}

/** Reading the customer book. */
export function canViewCustomers(ctx: PosAccessContext): boolean {
  return perm(ctx, POS_PERMISSIONS.CUSTOMERS_VIEW);
}

/**
 * Creating or editing a customer.
 *
 * `pos_upsert_customer` accepts EITHER `pos.customers.manage` OR
 * `pos.create_orders`, so a cashier who takes delivery orders can capture the
 * caller without a second permission. Mirrored exactly - the desktop is never
 * more permissive than the RPC, and never stricter either, or it would block
 * work the server allows.
 */
export function canManageCustomers(ctx: PosAccessContext): boolean {
  return perm(ctx, POS_PERMISSIONS.CUSTOMERS_MANAGE) || perm(ctx, POS_PERMISSIONS.CREATE_ORDERS);
}
