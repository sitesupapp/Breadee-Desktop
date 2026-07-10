// Business-module catalog for the Desktop dashboard. Translates the tenant's raw
// feature flags into clean, user-friendly module names with an HONEST desktop status.
//
// Key rule: an enabled feature flag does NOT mean a desktop screen exists. Each entry
// declares where it actually lives today:
//   - "desktop": built and usable in this app (clickable)
//   - "planned": intended for desktop later — shown disabled ("Coming soon")
//   - "web":     stays on the Breadee web app for now — shown disabled ("On the web app")
//
// Visibility is gated by BOTH the tenant feature (session.features) AND the user's
// role/permission (session.permissions), so cashiers/staff never see admin-only
// modules or technical feature keys.

import { FEATURES, hasFeature, type FeatureMap } from "@/lib/features";
import { canUsePOS } from "@/lib/permissions";
import type { TenantRole, UserStatus } from "@/lib/types";

export type ModuleAvailability = "desktop" | "planned" | "web";

export type ModuleCtx = {
  features: FeatureMap;
  permissions: Record<string, boolean>;
  role: TenantRole | null | undefined;
  status: UserStatus | null | undefined;
};

export type ModuleEntry = {
  key: string;
  label: string; // clean business name
  icon: string;
  desc: string; // short, non-technical description
  availability: ModuleAvailability;
  to?: string; // route — only set for built ("desktop") modules
  show: (ctx: ModuleCtx) => boolean;
};

const isManagerUp = (role: TenantRole | null | undefined) => ["owner", "admin", "manager"].includes(role ?? "");
const isAdminUp = (role: TenantRole | null | undefined) => ["owner", "admin"].includes(role ?? "");
const perm = (ctx: ModuleCtx, key: string) => Boolean(ctx.permissions?.[key]);

export const MODULES: ModuleEntry[] = [
  {
    key: "pos",
    label: "Point of Sale",
    icon: "🧾",
    desc: "Takeaway orders and cash payment. Dine-in, delivery and printing coming next.",
    availability: "desktop",
    to: "/pos",
    show: (c) => canUsePOS(c.role, c.status) && hasFeature(c.features, FEATURES.POS),
  },
  {
    key: "inventory",
    label: "Inventory",
    icon: "📦",
    desc: "Stock levels, movements and procurement received.",
    availability: "planned",
    show: (c) => hasFeature(c.features, FEATURES.INVENTORY) && (isManagerUp(c.role) || perm(c, "inventory.movements.view") || perm(c, "inventory.items.view")),
  },
  {
    key: "reports",
    label: "Reports",
    icon: "📈",
    desc: "POS sales and cost/profit reports.",
    availability: "planned",
    show: (c) => hasFeature(c.features, FEATURES.REPORTS) && (isManagerUp(c.role) || perm(c, "pos.reports.view")),
  },
  {
    key: "cost_control",
    label: "Cost Control",
    icon: "🧮",
    desc: "Materials, recipes, overhead and cost snapshots.",
    availability: "web",
    show: (c) => hasFeature(c.features, FEATURES.COST_CONTROL) && isManagerUp(c.role),
  },
  {
    key: "accounting",
    label: "Accounting",
    icon: "💵",
    desc: "Expenses, procurement, suppliers and financial reports.",
    availability: "web",
    show: (c) => hasFeature(c.features, FEATURES.ACCOUNTING) && isManagerUp(c.role),
  },
  {
    key: "menu",
    label: "Menu",
    icon: "📋",
    desc: "Menu builder and e-menu setup.",
    availability: "web",
    show: (c) => (hasFeature(c.features, FEATURES.MENU_BUILDER) || hasFeature(c.features, FEATURES.E_MENU)) && isManagerUp(c.role),
  },
  {
    key: "users",
    label: "Users & Admin",
    icon: "👥",
    desc: "Users, roles, branches and business settings.",
    availability: "web",
    show: (c) => hasFeature(c.features, FEATURES.USERS) && isAdminUp(c.role),
  },
];

export function visibleModules(ctx: ModuleCtx): ModuleEntry[] {
  return MODULES.filter((m) => {
    try {
      return m.show(ctx);
    } catch {
      return false;
    }
  });
}
