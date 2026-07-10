// Central navigation model for the desktop app. Nav items are gated by the SAME
// feature flags + permissions the web app uses, so the desktop never exposes a
// module the tenant/user isn't entitled to. Pure + framework-agnostic: consumed by
// the Shell (sidebar) and the Dashboard ("accessible modules") so both stay in sync.
//
// PHASE 1: only the approved foundation pages appear here (Dashboard, Profile, POS,
// Settings). No entries for unbuilt modules (inventory, reports, etc.).

import { FEATURES, hasFeature, type FeatureMap } from "@/lib/features";
import { canUsePOS } from "@/lib/permissions";
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

// When the effective-features map is empty (e.g. a degraded/offline context where
// feature data didn't load), we fail OPEN for already-working core pages rather than
// hiding them — role/permission checks still apply, and RLS remains the real gate.
const featuresUnknown = (ctx: NavContext) => Object.keys(ctx.features ?? {}).length === 0;

export const NAV_ITEMS: NavItem[] = [
  {
    to: "/dashboard",
    label: "Dashboard",
    icon: "▦",
    show: () => true, // any authenticated member sees their own dashboard
  },
  {
    to: "/pos",
    label: "POS",
    icon: "🧾",
    // Same guard POS.tsx already enforces, plus the tenant POS feature flag.
    show: (ctx) => canUsePOS(ctx.role, ctx.status) && (hasFeature(ctx.features, FEATURES.POS) || featuresUnknown(ctx)),
  },
  {
    to: "/profile",
    label: "Profile",
    icon: "👤",
    show: () => true, // read-only view of the member's own context
  },
  {
    to: "/settings",
    label: "Settings",
    icon: "⚙",
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
