// 1.0.41 (BUG 02 S3) — ONE collected / due truth for the shift's Orders surfaces.
//
// Breadee leaves an order paid in part by split settlements `payment_status = 'unpaid'` (it is closed only by the
// final settle). Through 1.0.40 the Orders list therefore labelled a part-paid order "unpaid" and the Current
// Order panel offered Pay at its GROSS total, while the server charges only R = T − P: the cashier was told to
// collect P twice. The collected amount is read from the SAME source the table bill uses (pos_split_settlements,
// status paid — tableBill.readPaidSettlements), so the list, the card and the Pay dialog cannot disagree.
//
// Read-only. A failed read leaves `collected` unknown (null) — never zero.

import { readPaidSettlements } from "@/lib/pos/tableBill";
import type { ShiftOpenOrder } from "@/lib/pos/shiftOrderSummary";

export const DINE_IN_PAY_FROM_TABLE_MESSAGE =
  "This is a table order. Pay it from its table in Dine-in, so anything already paid on it is deducted and the table closes.";
export const LOCAL_PAYMENT_PENDING_MESSAGE =
  "This order was recorded on this terminal and Breadee hasn't confirmed it yet. Don't take payment again — it syncs automatically.";

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** PURE — the due of an order given what split settlements collected (null = unknown). */
export function orderDue(o: Pick<ShiftOpenOrder, "payment_status" | "total_amount"> & { collected?: number | null }): {
  state: "paid" | "part_paid" | "unpaid" | "unknown";
  collected: number | null;
  due: number | null;
} {
  if (o.payment_status === "paid") return { state: "paid", collected: o.total_amount ?? null, due: 0 };
  const total = o.total_amount == null ? null : Number(o.total_amount);
  if (o.collected === undefined || o.collected === null) return { state: "unknown", collected: null, due: total };
  const collected = round2(Number(o.collected) || 0);
  if (collected <= 0) return { state: "unpaid", collected: 0, due: total };
  return { state: "part_paid", collected, due: total == null ? null : Math.max(0, round2(total - collected)) };
}

/** Orders whose collected amount matters: not paid, not terminal. */
const needsCollected = (o: ShiftOpenOrder) => o.payment_status !== "paid" && o.status !== "voided" && o.status !== "cancelled" && !o.local_pending;

/**
 * Attach `collected` (Σ paid split settlements, order currency) to every not-yet-paid order. One bounded read.
 * A failed read leaves `collected` undefined on every row (unknown — the labels then stay as the server says).
 */
export async function attachCollected<T extends ShiftOpenOrder>(orders: T[], tenantId: string): Promise<(T & { collected?: number | null })[]> {
  const ids = orders.filter(needsCollected).map((o) => o.id);
  if (ids.length === 0) return orders;
  const read = await readPaidSettlements(ids, tenantId);
  if (!read.ok) return orders;
  const sum = new Map<string, number>();
  for (const raw of read.rows) {
    const r = (raw && typeof raw === "object" ? raw : {}) as { parent_order_id?: unknown; amount_order_ccy?: unknown; status?: unknown };
    if (typeof r.parent_order_id !== "string" || (r.status !== undefined && r.status !== "paid")) continue;
    const amt = Number(r.amount_order_ccy);
    if (!Number.isFinite(amt)) continue;
    sum.set(r.parent_order_id, round2((sum.get(r.parent_order_id) ?? 0) + amt));
  }
  return orders.map((o) => (needsCollected(o) ? { ...o, collected: sum.get(o.id) ?? 0 } : o));
}
