// Ported verbatim from the web app (src/lib/features.ts) — pure, framework-agnostic.
// Keep in sync with the web app; do not fork the feature keys.
export const FEATURES = {
  MENU_BUILDER: "menu_builder",
  QR_MENU: "qr_menu",
  COST_CONTROL: "cost_control",
  USERS: "users",
  POS: "pos",
  POS_TAKEAWAY: "pos.takeaway",
  POS_DINE_IN: "pos.dine_in",
  POS_DELIVERY: "pos.delivery",
  POS_SHIFTS: "pos.shifts",
  POS_PRINTING: "pos.printing",
  ACCOUNTING: "accounting",
  ACCOUNTING_EXPENSES: "accounting.expenses",
  ACCOUNTING_REPORTS: "accounting.reports",
  INVENTORY: "inventory",
  INVENTORY_STOCK: "inventory.stock",
  INVENTORY_MOVEMENTS: "inventory.movements",
  E_MENU: "e_menu",
  BRANCHES: "branches",
  REPORTS: "reports",
} as const;

export type FeatureMap = Record<string, boolean>;

export function hasFeature(map: FeatureMap | null | undefined, key: string): boolean {
  return Boolean(map && map[key]);
}
