// 1.0.64 — the payment method a Dine-In bill held on THIS device was settled with, for its reprint.
//
// A synced bill reprints the method Breadee stored (pos_orders.payment_method). A bill still held on this
// device had none (ordersHistoryOffline set it to null), so its reprint read just "Paid". The authoritative
// evidence on the device is the captured settle operation itself: `pay_table` records the method the
// cashier collected with, and every split leg captured for the same bill (`split_settle`) records its own.
//
// PURE and display-only. It returns a method ONLY when every contributing captured operation names one;
// anything missing, refused or not a settle returns null, so the receipt shows the status alone and a
// method is never invented. Several distinct methods are listed in capture order ("card + cash").

import type { OfflineOperation } from "@/lib/offline/operationLog";

const SETTLE_TYPES = new Set(["pay_table"]);
const LEG_TYPE = "split_settle";

function methodOf(op: OfflineOperation | undefined): string | null {
  const m = op && op.payload && typeof op.payload === "object" ? (op.payload as Record<string, unknown>).method : null;
  return typeof m === "string" && m.trim() ? m.trim() : null;
}

/**
 * @param settle the bill's settle operation (the draft's `settled_operation_id`).
 * @param deps   the split legs captured for the same bill (non-leg / undefined entries are ignored).
 */
export function settledMethodFrom(settle: OfflineOperation | undefined, deps: (OfflineOperation | undefined)[]): string | null {
  if (!settle || !SETTLE_TYPES.has(settle.operation_type)) return null;
  const final = methodOf(settle);
  if (!final) return null;
  const legs = deps
    .filter((o): o is OfflineOperation => !!o && o.operation_type === LEG_TYPE)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const methods: string[] = [];
  for (const leg of legs) {
    const m = methodOf(leg);
    if (!m) return null; // a leg with no recorded method: never guess
    methods.push(m);
  }
  methods.push(final);
  return [...new Set(methods)].join(" + ");
}
