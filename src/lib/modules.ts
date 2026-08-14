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
import { canOperatePOS } from "@/lib/pos/access";
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
    // Kept current with what the desktop actually ships. This copy has now been
    // wrong THREE times - it deferred Dine-in months after it landed, it said
    // Delivery was customers-only after 3B added ordering and 3C added
    // settlement, and it said printing was unavailable through 3E-A, P2, P3-B
    // and 3E-B. POS v1 closes the last of those, so the sentence goes.
    //
    // The rule this tile keeps breaking is worth stating: it must never promise
    // a capability the desktop lacks, and must never deny one it has. The second
    // half matters as much as the first - an operator who reads "printing is not
    // available" does not go looking for the setting that would have worked.
    desc: "Takeaway, Dine-in and Delivery POS: shifts, tables, customers and addresses, modifiers, discounts, cash payment, receipts and kitchen tickets on a Windows printer.",
    availability: "desktop",
    to: "/pos",
    // Feature + `pos.access` + the owner exclusion, exactly as the server decides.
    show: (c) => canOperatePOS({ membership: { role: c.role, status: c.status }, permissions: c.permissions, features: c.features }),
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
