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
//
// 1.0.6: "COMING SOON" IS NOW A LIE THIS LIST CANNOT TELL.
//
// Inventory and Reports were both marked `planned` and rendered as dead
// "Coming soon" cards. Both have been live in the Breadee web app for a long
// time, so a manager whose plan includes Inventory was being told by their till
// that the inventory they use every day did not exist yet. Every entry that is
// not built on the desktop now declares `web` AND the page it lives on, and the
// dashboard opens it in the browser.
//
// The `planned` availability is deliberately KEPT in the type and used by
// nothing. It is the honest label for a module that genuinely has no home yet,
// and removing it would mean the next such module gets mislabelled `web` and
// linked to a page that does not exist. A tile may only claim `planned` if it is
// absent from BOTH applications.

import { FEATURES, hasFeature, type FeatureMap } from "@/lib/features";
import { canOperatePOS } from "@/lib/pos/access";
import { canViewMenuBuilder } from "@/lib/menu/access";
import type { WebPathKey } from "@/lib/webApp";
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
  /**
   * The WEB page this module is managed on. Required for `web`, absent
   * otherwise - see `everyWebModuleIsReachable` below, which is what stops a
   * "Managed on Breadee Web" tile that goes nowhere.
   */
  web?: WebPathKey;
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
    desc: "Stock levels, movements, daily usage and procurement received.",
    // Was `planned`. Inventory is a full web module - items, stock, movements,
    // adjustments, daily usage, expiry alerts and procurement received - and
    // calling it "Coming soon" on the till told a manager their own data was not
    // built yet.
    availability: "web",
    web: "inventory",
    show: (c) => hasFeature(c.features, FEATURES.INVENTORY) && (isManagerUp(c.role) || perm(c, "inventory.movements.view") || perm(c, "inventory.items.view")),
  },
  {
    key: "reports",
    label: "Reports",
    icon: "📈",
    desc: "POS sales, cost and profit reports.",
    // Was `planned`, for the same reason and with the same consequence as
    // Inventory above. The desktop prints an end-of-shift report; the reporting
    // MODULE is the web app's, and saying so is what sends a manager to it.
    availability: "web",
    web: "reports",
    show: (c) => hasFeature(c.features, FEATURES.REPORTS) && (isManagerUp(c.role) || perm(c, "pos.reports.view")),
  },
  {
    key: "cost_control",
    label: "Cost Control",
    icon: "🧮",
    desc: "Materials, recipes, overhead and cost snapshots.",
    availability: "web",
    web: "cost_control",
    show: (c) => hasFeature(c.features, FEATURES.COST_CONTROL) && isManagerUp(c.role),
  },
  {
    key: "accounting",
    label: "Accounting",
    icon: "💵",
    desc: "Expenses, procurement, suppliers and financial reports.",
    availability: "web",
    web: "accounting",
    show: (c) => hasFeature(c.features, FEATURES.ACCOUNTING) && isManagerUp(c.role),
  },
  {
    key: "menu_builder",
    label: "Menu Builder",
    icon: "📋",
    // The tile now says what the desktop actually does, and the split from
    // E-Menu below is deliberate: the desktop builds the MENU (the shared
    // catalogue the POS and the public menu both read) and does not manage
    // E-Menu settings, analytics or leads, which remain web-only. One tile
    // claiming both would have been the fourth time this list over-promised.
    desc: "Categories, items, modifiers and extras, availability and the public QR menu.",
    availability: "desktop",
    to: "/menu-builder",
    // Exactly the gate the web app's Menu Builder page applies server-side.
    show: (c) => canViewMenuBuilder({ status: c.status, permissions: c.permissions, features: c.features }),
  },
  {
    key: "e_menu",
    label: "E-Menu",
    icon: "📱",
    desc: "E-Menu appearance, settings, analytics and leads.",
    availability: "web",
    web: "e_menu",
    show: (c) => hasFeature(c.features, FEATURES.E_MENU) && isManagerUp(c.role),
  },
  {
    key: "users",
    label: "Users & Admin",
    icon: "👥",
    desc: "Users, roles, branches and business settings.",
    availability: "web",
    web: "users",
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

/**
 * Every `web` module names a page, and nothing else does.
 *
 * Exported so a test can assert it over the real catalog rather than over a
 * fixture. The failure it exists to catch is silent and awful in exactly the way
 * this release is fixing: a tile that says "Managed on Breadee Web", invites a
 * click, and does nothing - which reads to an operator as the desktop being
 * broken rather than the catalog being incomplete.
 */
export function everyWebModuleIsReachable(entries: ModuleEntry[] = MODULES): boolean {
  return entries.every((m) => (m.availability === "web" ? Boolean(m.web) : m.web === undefined));
}

/**
 * Every `desktop` module names a local route, and no other kind does.
 *
 * The other half of the same rule: a desktop tile with no `to` is a dead card,
 * and a web tile carrying a local route would open a desktop screen that does
 * not exist.
 */
export function everyDesktopModuleIsReachable(entries: ModuleEntry[] = MODULES): boolean {
  return entries.every((m) => (m.availability === "desktop" ? Boolean(m.to) : m.to === undefined));
}
