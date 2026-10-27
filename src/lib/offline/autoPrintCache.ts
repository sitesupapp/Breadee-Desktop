// Offline-first recovery — the branch's two AUTO-PRINT switches (customer / kitchen), as last read online,
// so an order captured offline still auto-prints where the branch asked for it. Only the two booleans are
// kept: the receipt TEMPLATE is never stored on the desktop (it is the web app's shared row), so an offline
// receipt uses the default full layout.

export type CachedAutoPrint = { customer: boolean; kitchen: boolean };

const PREFIX = "breadee-desktop-autoprint:";
const key = (tenantId: string, branchId: string | null) => `${PREFIX}${tenantId}:${branchId ?? ""}`;

export function readCachedAutoPrint(tenantId: string, branchId: string | null): CachedAutoPrint | null {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(key(tenantId, branchId)) : null;
    const v = raw ? (JSON.parse(raw) as CachedAutoPrint) : null;
    return v && typeof v.customer === "boolean" && typeof v.kitchen === "boolean" ? { customer: v.customer, kitchen: v.kitchen } : null;
  } catch {
    return null;
  }
}

export function cacheAutoPrint(tenantId: string, branchId: string | null, v: CachedAutoPrint): void {
  try {
    localStorage.setItem(key(tenantId, branchId), JSON.stringify({ customer: v.customer, kitchen: v.kitchen }));
  } catch {
    /* storage unavailable: online printing is unaffected */
  }
}
