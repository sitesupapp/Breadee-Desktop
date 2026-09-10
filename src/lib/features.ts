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
  // Kitchen operations. Kitchen TICKET routing is gated on this, while receipt
  // routing is gated on `pos` - the two purposes are authorised separately by
  // the server, and a POS-only tenant legitimately has receipt routing without
  // ever seeing a kitchen ticket route.
  KITCHEN_OPS: "kitchen_ops",
  ACCOUNTING: "accounting",
  ACCOUNTING_EXPENSES: "accounting.expenses",
  ACCOUNTING_REPORTS: "accounting.reports",
  INVENTORY: "inventory",
  INVENTORY_STOCK: "inventory.stock",
  INVENTORY_MOVEMENTS: "inventory.movements",
  E_MENU: "e_menu",
  BRANCHES: "branches",
  REPORTS: "reports",
  // Customer Receivables / On Account. The server emits this key via
  // `get_tenant_effective_features`; the desktop stays dark unless the tenant is
  // entitled, exactly like every other POS sub-feature.
  POS_RECEIVABLES: "pos.receivables",
} as const;

export type FeatureMap = Record<string, boolean>;

export function hasFeature(map: FeatureMap | null | undefined, key: string): boolean {
  return Boolean(map && map[key]);
}
