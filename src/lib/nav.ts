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
  icon: string;
  // Whether to show the item for this session. Returns true when allowed.
  show: (ctx: NavContext) => boolean;
};

export const NAV_ITEMS: NavItem[] = [
  {
    to: "/dashboard",
    label: "Dashboard",
    icon: "#",
    show: () => true, // any authenticated member sees their own dashboard
  },
  {
    to: "/pos",
    label: "POS",
    icon: "P",
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
    icon: "@",
    show: () => true, // read-only view of the member's own context
  },
  {
    to: "/settings",
    label: "Settings",
    icon: "*",
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
