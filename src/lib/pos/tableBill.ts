// The table's open bill - READ ONLY.
//
// The SERVER owns the bill. m218 guarantees one active dine-in order per table,
// and rounds are appended to it as `batch_no` values. This module only reads
// that state back; it never reconstructs, caches or derives a bill locally, and
// the cart is never treated as the bill.
//
// Level 2A performs no mutation here at all - no round submission, no payment.

import { asRecord, num, numOrNull, str, strOrNull } from "@/lib/pos/rpc";
import { isCurrencyCode, type CurrencyCode } from "@/lib/currency";
import { EMPTY_BILL, type BillLine, type BillOrder, type TableBill } from "@/types/tables";
import type { SelectedModifier } from "@/types/pos";

/** Statuses that constitute an OPEN bill - mirrors m218 / pos_table_map. */
const OPEN_STATUSES = ["draft", "sent_to_kitchen"];

function toModifiers(raw: unknown): SelectedModifier[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((m) => {
    const r = asRecord(m);
    return {
      group_id: strOrNull(r.modifier_group_id),
      option_id: strOrNull(r.modifier_option_id),
      name: str(r.name_snapshot, "Extra"),
      price_delta: num(r.price_delta),
      quantity: num(r.quantity, 1),
    };
  });
}

function toLine(raw: unknown): BillLine | null {
  const r = asRecord(raw);
  const id = strOrNull(r.id);
  if (!id) return null;
  return {
    id,
    name: str(r.name_snapshot, "Item"),
    quantity: num(r.quantity),
    base_price: num(r.base_price),
    modifiers_total: num(r.modifiers_total),
    final_unit_price: num(r.final_unit_price),
    line_total: num(r.line_total),
    kitchen_note: strOrNull(r.kitchen_note),
    // Server-assigned. Defaults to 1 only because pre-m218 rows predate batching.
    batch_no: num(r.batch_no, 1),
    modifiers: toModifiers(r.pos_order_item_modifiers),
  };
}

function toOrder(raw: unknown): BillOrder | null {
  const r = asRecord(raw);
  const id = strOrNull(r.id);
  if (!id) return null;
  const ccy = r.primary_currency_snapshot;
  const lines = (Array.isArray(r.pos_order_items) ? r.pos_order_items : [])
    .map(toLine)
    .filter((l): l is BillLine => l !== null)
    .sort((a, b) => a.batch_no - b.batch_no);
  return {
    id,
    order_number: str(r.order_number),
    status: str(r.status),
    payment_status: str(r.payment_status),
    shift_id: strOrNull(r.shift_id),
    branch_id: strOrNull(r.branch_id),
    tenant_id: str(r.tenant_id),
    subtotal: num(r.subtotal),
    discount_amount: num(r.discount_amount),
    total_amount: num(r.total_amount),
    currency: isCurrencyCode(ccy) ? (ccy as CurrencyCode) : "USD",
    exchange_rate: numOrNull(r.usd_to_lbp_rate_snapshot),
    created_at: strOrNull(r.created_at),
    lines,
  };
}

/**
 * Fold the loaded orders into a bill view.
 *
 * `subtotal`/`total` stay NULL when the orders span currencies, mirroring the
 * server's own refusal to add raw USD to raw LBP (m214). `splitShift` mirrors
 * the guard in `pos_pay_table` that refuses a bill straddling shifts.
 */
export function foldBill(tableId: string, orders: BillOrder[]): TableBill {
  if (orders.length === 0) return EMPTY_BILL(tableId);

  const currencies = new Set(orders.map((o) => o.currency));
  const shifts = new Set(orders.map((o) => o.shift_id));
  const mixedCurrency = currencies.size > 1;
  const splitShift = shifts.size > 1;

  const batches = Array.from(new Set(orders.flatMap((o) => o.lines.map((l) => l.batch_no)))).sort((a, b) => a - b);

  return {
    tableId,
    orders,
    subtotal: mixedCurrency ? null : orders.reduce((s, o) => s + o.subtotal, 0),
    total: mixedCurrency ? null : orders.reduce((s, o) => s + o.total_amount, 0),
    currency: mixedCurrency ? null : (orders[0]?.currency ?? null),
    mixedCurrency,
    splitShift,
    batches,
  };
}

/**
 * Read the open bill for a table.
 *
 * Tenant and branch are passed in and asserted, so a stale selection can never
 * render another context's bill. RLS remains the real boundary; this is the
 * client-side consistency check on top of it.
 */
export async function loadTableBill(input: {
  tableId: string;
  tenantId: string;
  branchId: string | null;
}): Promise<TableBill> {
  const { supabase } = await import("@/lib/supabase");
  const { data, error } = await supabase
    .from("pos_orders")
    .select(
      "id, order_number, status, payment_status, shift_id, branch_id, tenant_id, subtotal, discount_amount, total_amount, primary_currency_snapshot, usd_to_lbp_rate_snapshot, created_at, " +
        "pos_order_items(id, name_snapshot, quantity, base_price, modifiers_total, final_unit_price, line_total, kitchen_note, batch_no, " +
        "pos_order_item_modifiers(modifier_group_id, modifier_option_id, name_snapshot, price_delta, quantity))",
    )
    .eq("tenant_id", input.tenantId)
    .eq("table_id", input.tableId)
    .eq("order_type", "dine_in")
    .in("status", OPEN_STATUSES)
    .neq("payment_status", "paid")
    .order("created_at");

  if (error) throw new Error(error.message);

  const orders = ((data ?? []) as unknown[])
    .map(toOrder)
    .filter((o): o is BillOrder => o !== null)
    // Defence in depth: never show an order from another tenant/branch.
    .filter((o) => o.tenant_id === input.tenantId)
    .filter((o) => input.branchId === null || o.branch_id === input.branchId);

  return foldBill(input.tableId, orders);
}

/** Lines grouped by the server's batch number, ascending. */
export function linesByBatch(bill: TableBill): { batch: number; lines: BillLine[] }[] {
  const map = new Map<number, BillLine[]>();
  for (const order of bill.orders) {
    for (const line of order.lines) {
      const list = map.get(line.batch_no) ?? [];
      list.push(line);
      map.set(line.batch_no, list);
    }
  }
  return Array.from(map.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([batch, lines]) => ({ batch, lines }));
}

export function billItemCount(bill: TableBill): number {
  return bill.orders.reduce((sum, o) => sum + o.lines.reduce((s, l) => s + l.quantity, 0), 0);
}
