// Menu Builder access - the SAME decision the database makes, evaluated early so
// the UI is honest.
//
// THIS IS NOT THE SECURITY BOUNDARY. `m138_menu_write_authz` replaced the old
// tenant-only write policies with explicit INSERT/UPDATE/DELETE policies that
// each require `assert_feature_access('menu_builder','')` AND a specific
// permission. `set_menu_item_price` / `set_modifier_option_price` re-check
// `menu.edit` inside `_assert_menu_price_writer`. Everything below simply says
// the same thing before the round trip; deleting this file would not grant
// anybody a single extra write.
//
// PERMISSIONS ARE ALREADY FEATURE-MASKED. `current_user_permissions` returns
// `get_user_effective_permissions`, which ANDs every catalogue key with
// `_feature_tree_enabled(features, _permission_feature(key))`. So
// `menu.manage_modifiers` is false whenever `menu_builder.modifiers` is off, and
// `menu.manage_qr` is false whenever `qr_menu` is off. That is why the gates
// below read permissions and do NOT re-test each sub-feature: doing both would
// be two sources for one rule.
//
// THE ONE PLACE THE DESKTOP IS STRICTER THAN THE WEB UI, STATED PLAINLY.
// `qr_menu_settings` and `menu_item_modifier_groups` have tenant-only write
// policies - no permission check at the database. The web workspace therefore
// lets anyone holding `menu.view` change QR publishing. The desktop requires
// `menu.manage_qr`, which is the key the permission catalogue defines for
// exactly that ("Control the public QR menu"). This narrows what a desktop user
// may do; it changes no data shape, no table and no contract, so the two clients
// still operate on identical rows.

import { FEATURES, hasFeature, type FeatureMap } from "@/lib/features";
import { isActiveMember } from "@/lib/permissions";
import type { Gate } from "@/components/ui";
import type { UserStatus } from "@/lib/types";

export type MenuPermissionMap = Record<string, boolean>;

export type MenuAccessContext = {
  status: UserStatus | null | undefined;
  permissions: MenuPermissionMap;
  features: FeatureMap;
};

/** Every permission key this module depends on, in one place so none is typo-gated. */
export const MENU_PERMISSIONS = {
  VIEW: "menu.view",
  CREATE: "menu.create",
  EDIT: "menu.edit",
  DELETE_OR_ARCHIVE: "menu.delete_or_archive",
  MANAGE_CATEGORIES: "menu.manage_categories",
  MANAGE_MODIFIERS: "menu.manage_modifiers",
  MANAGE_QR: "menu.manage_qr",
} as const;

const perm = (ctx: MenuAccessContext, key: string): boolean => Boolean(ctx.permissions?.[key]);

const gate = (allowed: boolean, reason: string): Gate => ({ allowed, reason: allowed ? null : reason });

/** The module itself: active membership + the tenant feature + `menu.view`. */
export function canViewMenuBuilder(ctx: MenuAccessContext): boolean {
  return (
    isActiveMember(ctx.status) &&
    hasFeature(ctx.features, FEATURES.MENU_BUILDER) &&
    perm(ctx, MENU_PERMISSIONS.VIEW)
  );
}

/** Why the module is unavailable, in the order the server would refuse. */
export function menuBuilderDenialReason(ctx: MenuAccessContext): string | null {
  if (!isActiveMember(ctx.status)) return "Your membership is not active for this business.";
  if (!hasFeature(ctx.features, FEATURES.MENU_BUILDER)) return "Menu Builder is not enabled for this plan.";
  if (!perm(ctx, MENU_PERMISSIONS.VIEW)) return "You are not allowed to view the menu.";
  return null;
}

export type MenuBuilderGates = {
  /** menu_items INSERT - RLS `mi_insert` requires `menu.create`. */
  createItem: Gate;
  /** menu_items UPDATE + `set_menu_item_price` - both require `menu.edit`. */
  editItem: Gate;
  /** The archiving UPDATE - RLS `mi_update` also accepts `menu.delete_or_archive`. */
  archiveItem: Gate;
  /** menu_categories INSERT/UPDATE/DELETE - all require `menu.manage_categories`. */
  manageCategories: Gate;
  /** modifier_groups + modifier_options - all require `menu.manage_modifiers`. */
  manageModifiers: Gate;
  /** qr_menu_settings - see the note at the top of this file. */
  manageQr: Gate;
};

export function menuBuilderGates(ctx: MenuAccessContext): MenuBuilderGates {
  return {
    createItem: gate(perm(ctx, MENU_PERMISSIONS.CREATE), "You do not have permission to add menu items."),
    editItem: gate(perm(ctx, MENU_PERMISSIONS.EDIT), "You do not have permission to edit menu items."),
    archiveItem: gate(
      perm(ctx, MENU_PERMISSIONS.DELETE_OR_ARCHIVE),
      "You do not have permission to archive menu items.",
    ),
    manageCategories: gate(
      perm(ctx, MENU_PERMISSIONS.MANAGE_CATEGORIES),
      "You do not have permission to manage categories.",
    ),
    manageModifiers: gate(
      perm(ctx, MENU_PERMISSIONS.MANAGE_MODIFIERS),
      "You do not have permission to manage modifiers and extras.",
    ),
    manageQr: gate(perm(ctx, MENU_PERMISSIONS.MANAGE_QR), "You do not have permission to manage the public QR menu."),
  };
}

/**
 * True when the session may look but not touch. Used for the one banner that
 * states the mode, so the operator is told once instead of discovering it button
 * by button.
 */
export function isReadOnly(gates: MenuBuilderGates): boolean {
  return !(
    gates.createItem.allowed ||
    gates.editItem.allowed ||
    gates.archiveItem.allowed ||
    gates.manageCategories.allowed ||
    gates.manageModifiers.allowed ||
    gates.manageQr.allowed
  );
}

/**
 * Whether the Modifiers & Extras surface is offered at all.
 *
 * The web workspace locks that tab on the `menu_builder.modifiers` sub-feature
 * rather than on a permission, and the desktop matches: a tenant whose plan
 * includes modifiers still SEES its groups read-only without
 * `menu.manage_modifiers`, which is what `mg_select` allows.
 */
export function hasModifiersFeature(ctx: MenuAccessContext): boolean {
  return hasFeature(ctx.features, "menu_builder.modifiers");
}

/** Whether the QR / public-menu surface is offered at all. */
export function hasQrFeature(ctx: MenuAccessContext): boolean {
  return hasFeature(ctx.features, FEATURES.QR_MENU);
}
