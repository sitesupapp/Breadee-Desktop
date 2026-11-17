// 1.0.63 (native Staging 1.0.62, D-A) — the lines the Current Order panel's manual "Print" prints.
//
// Through 1.0.62 that button always read `pos_order_items` from Breadee, so offline a bill held on this
// device (an offline Takeaway sale, an offline Dine-In session) failed with "TypeError: Failed to fetch",
// while the Orders history reprint (PosWorkspace) already fell back to the device's own lines.
//
// Rule (the same as the panel's on-screen lines and the Orders history reprint):
//   - a device-held bill (`localPending`), or any bill while Breadee is KNOWN unreachable, prints this
//     device's durable lines first (its Dine-In draft, or the provisional receipt persisted at capture),
//     with no server call;
//   - otherwise Breadee's rows; a failed or empty server read falls back to this device's lines;
//   - only when neither exists does the original error surface (nothing is invented).
// Totals, method and currency come from the order row exactly as before; this only chooses the lines.

import type { ReceiptLine } from "@/lib/receipt";

export type ReprintLineDeps = {
  local?: (orderId: string) => Promise<ReceiptLine[] | null>;
  server?: (orderId: string) => Promise<ReceiptLine[]>;
  reachable?: () => boolean | null;
};

export async function reprintLines(orderId: string, localPending: boolean, deps: ReprintLineDeps = {}): Promise<ReceiptLine[]> {
  const local = async (): Promise<ReceiptLine[] | null> => {
    try {
      const fn = deps.local ?? (await import("@/lib/offline/ordersHistoryOffline")).readLocalOrderLines;
      return (await fn(orderId)) ?? null;
    } catch {
      return null;
    }
  };
  let reachable: boolean | null = null;
  try {
    reachable = (deps.reachable ?? (await import("@/lib/offline/reachability")).lastKnownReachable)();
  } catch {
    reachable = null;
  }
  if (localPending || reachable === false) {
    const own = await local();
    if (own && own.length > 0) return own;
  }
  const server = deps.server ?? (await import("@/lib/pos/deliverySettlement")).readOrderReceiptLines;
  try {
    const rows = await server(orderId);
    if (rows.length > 0) return rows;
    const own = await local();
    return own && own.length > 0 ? own : rows;
  } catch (e) {
    const own = await local();
    if (own && own.length > 0) return own;
    throw e;
  }
}
