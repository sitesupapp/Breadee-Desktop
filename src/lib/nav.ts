// Central navigation model for the desktop app. Nav items are gated by the SAME
// feature flags + permissions the web app uses, so the desktop never exposes a
// module the tenant/user isn't entitled to. Pure + framework-agnostic: consumed by
// the Shell (sidebar) and the Dashboard ("accessible modules") so both stay in sync.
//
// POS gating goes through `lib/pos/access.ts` (feature + `pos.access` + the owner
// exclusion), NOT through role names. The previous role-list check offered POS to
// tenant owners, whom `pos_assert_operator` rejects server-side.

import { FEATURES, hasFeature, type FeatureMap } from "@/lib/features";
import { canOperatePOS } from "@/lib/pos/access";
import { canViewMenuBuilder } from "@/lib/menu/access";
import type { GlyphName } from "@/components/Glyph";
import type { TenantRole, UserStatus } from "@/lib/types";

export type NavContext = {
  features: FeatureMap;
  permissions: Record<string, boolean>;
  role: TenantRole | null | undefined;
  status: UserStatus | null | undefined;
};

export type NavItem = {
  to: string;
  label: string;
  glyph: GlyphName;
  // Whether to show the item for this session. Returns true when allowed.
  show: (ctx: NavContext) => boolean;
};

// ORDER IS PART OF THE CONTRACT: Dashboard, Menu Builder, POS, Profile,
// Settings. Menu Builder belongs to the APPLICATION's navigation, not to the
// POS rail - it edits the tenant's catalogue, which the POS only consumes.
export const NAV_ITEMS: NavItem[] = [
  {
    to: "/dashboard",
    label: "Dashboard",
    glyph: "dashboard",
    show: () => true, // any authenticated member sees their own dashboard
  },
  {
    to: "/menu-builder",
    label: "Menu Builder",
    glyph: "menu-builder",
    // Same gate the web app's server component applies: active membership, the
    // `menu_builder` feature, and `menu.view`. Fails closed with no context.
    show: (ctx) =>
      canViewMenuBuilder({ status: ctx.status, permissions: ctx.permissions, features: ctx.features }),
  },
  {
    to: "/pos",
    label: "POS",
    glyph: "pos",
    // Deliberately fails CLOSED: with no features/permissions map there is no
    // evidence the user may operate the POS, and the server would refuse anyway.
    show: (ctx) =>
      canOperatePOS({
        membership: { role: ctx.role, status: ctx.status },
        permissions: ctx.permissions,
        features: ctx.features,
      }),
  },
  {
    to: "/profile",
    label: "Profile",
    glyph: "profile",
    show: () => true, // read-only view of the member's own context
  },
  {
    to: "/settings",
    label: "Settings",
    glyph: "settings",
    show: () => true, // local device settings (printers/sync/device/help) are always available
  },
];

export function visibleNav(ctx: NavContext): NavItem[] {
  return NAV_ITEMS.filter((n) => {
    try {
      return n.show(ctx);
    } catch {
      return false;
    }
  });
}

// Human-readable list of enabled feature keys, for the Dashboard "active features" tile.
export function enabledFeatureKeys(features: FeatureMap): string[] {
  return Object.entries(features ?? {})
    .filter(([, on]) => Boolean(on))
    .map(([k]) => k)
    .sort();
}

/** Kept for callers that only need the raw POS feature flag. */
export function hasPosFeature(features: FeatureMap): boolean {
  return hasFeature(features, FEATURES.POS);
}
