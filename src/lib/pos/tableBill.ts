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
import { EMPTY_BILL, type BillLine, type BillOrder, type BillSettlement, type TableBill } from "@/types/tables";
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
    // Phase D — for re-opening the modifier chooser when editing a sent line.
    menu_item_id: strOrNull(r.menu_item_id),
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
    // Phase D — optimistic-concurrency token for sent-line edits (expected_version).
    pos_entity_version: num(r.pos_entity_version),
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
      "id, order_number, status, payment_status, pos_entity_version, shift_id, branch_id, tenant_id, subtotal, discount_amount, total_amount, primary_currency_snapshot, usd_to_lbp_rate_snapshot, created_at, " +
        "pos_order_items(id, menu_item_id, name_snapshot, quantity, base_price, modifiers_total, final_unit_price, line_total, kitchen_note, batch_no, " +
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

  const bill = foldBill(input.tableId, orders);
  if (orders.length === 0) return bill;
  // 1.0.40 (BUG 01 / BUG 06) — fold in what PAID split settlements already hold against these orders. A
  // failed read never fails the bill: collected becomes UNKNOWN and the money paths fall back / refuse.
  return applyPaidSettlements(bill, await readPaidSettlements(orders.map((o) => o.id), input.tenantId));
}

// --- 1.0.40 (BUG 01 / BUG 06 / guest-level split) — paid split settlements --------------------------------
//
// Production `pos_table_map` reports no `collected`, yet its `pos_pay_table_core` charges R = T − P (P = the
// order's PAID `pos_split_settlements`). The desktop therefore derives P itself from the settlements and
// their allocations, which active tenant users may SELECT (settlements additionally branch-scoped). Read
// only — nothing here writes, and the server pin (`expected_amount`) still guards every charge.

export type PaidSettlementRead = { ok: true; rows: unknown[] } | { ok: false };

const round2 = (n: number) => Math.round(n * 100) / 100;

/** One PostgREST read of the PAID settlements (with allocations) of the given orders. Never throws. */
export async function readPaidSettlements(orderIds: string[], tenantId: string): Promise<PaidSettlementRead> {
  if (orderIds.length === 0) return { ok: true, rows: [] };
  try {
    const { supabase } = await import("@/lib/supabase");
    // `database.types.ts` predates the split tables (same structural cast as split.ts / rpc.ts).
    const client = supabase as unknown as {
      from(table: string): {
        select(cols: string): {
          eq(col: string, val: unknown): {
            in(col: string, vals: unknown[]): {
              eq(col: string, val: unknown): PromiseLike<{ data: unknown; error: { message: string } | null }>;
            };
          };
        };
      };
    };
    const { data, error } = await client
      .from("pos_split_settlements")
      .select(
        "id, parent_order_id, split_no, status, amount_order_ccy, payment_method, currency_code, paid_at, payment_id, " +
          "pos_split_allocations(order_item_id, allocated_quantity, allocated_amount_order_ccy)",
      )
      .eq("tenant_id", tenantId)
      .in("parent_order_id", orderIds)
      .eq("status", "paid");
    if (error || !Array.isArray(data)) return { ok: false };
    return { ok: true, rows: data as unknown[] };
  } catch {
    return { ok: false };
  }
}

/**
 * PURE — fold a settlement read into the bill: per line `paid_quantity`, per order `collected`, bill-level
 * `collected` (null when mixed currencies), `collectedKnown` and the settlement list. A FAILED read marks
 * collected unknown (null / collectedKnown=false) and leaves every line and total untouched. Rows of an
 * order that is not on the bill, or not PAID, are ignored. `total` / `subtotal` stay the server's gross T.
 */
export function applyPaidSettlements(bill: TableBill, read: PaidSettlementRead): TableBill {
  if (!read.ok) return { ...bill, collected: null, collectedKnown: false };
  const orderIds = new Set(bill.orders.map((o) => o.id));
  const settlements: BillSettlement[] = [];
  for (const raw of read.rows) {
    const r = asRecord(raw);
    const id = strOrNull(r.id);
    const orderId = strOrNull(r.parent_order_id);
    if (!id || !orderId || !orderIds.has(orderId)) continue;
    if (r.status !== undefined && str(r.status) !== "paid") continue;
    const order = bill.orders.find((o) => o.id === orderId);
    const splitNo = num(r.split_no);
    settlements.push({
      id,
      order_id: orderId,
      split_no: splitNo,
      display_no: `${order?.order_number ?? ""}-${splitNo}`,
      amount: num(r.amount_order_ccy),
      method: strOrNull(r.payment_method),
      currency: strOrNull(r.currency_code),
      paid_at: strOrNull(r.paid_at),
      payment_id: strOrNull(r.payment_id),
      allocations: (Array.isArray(r.pos_split_allocations) ? r.pos_split_allocations : [])
        .map((a) => asRecord(a))
        .filter((a) => strOrNull(a.order_item_id) !== null)
        .map((a) => ({
          order_item_id: str(a.order_item_id),
          quantity: num(a.allocated_quantity),
          amount: num(a.allocated_amount_order_ccy),
        })),
    });
  }
  settlements.sort((a, b) => (a.order_id === b.order_id ? a.split_no - b.split_no : a.order_id.localeCompare(b.order_id)));

  const paidQty = new Map<string, number>();
  for (const s of settlements) for (const a of s.allocations) paidQty.set(a.order_item_id, (paidQty.get(a.order_item_id) ?? 0) + a.quantity);

  const orders = bill.orders.map((o) => ({
    ...o,
    collected: round2(settlements.filter((s) => s.order_id === o.id).reduce((sum, s) => sum + s.amount, 0)),
    lines: o.lines.map((l) => {
      const q = paidQty.get(l.id) ?? 0;
      return q > 0 ? { ...l, paid_quantity: q } : l;
    }),
  }));
  const collected = bill.mixedCurrency ? null : round2(orders.reduce((sum, o) => sum + (o.collected ?? 0), 0));
  return { ...bill, orders, collected, collectedKnown: true, settlements };
}

/** 1.0.40 (BUG 02) — the first line paid for only PART of its quantity (the merge guard's `partial_line`). */
export function partlyPaidLine(bill: TableBill): BillLine | null {
  for (const o of bill.orders) {
    for (const l of o.lines) {
      const paid = Number(l.paid_quantity ?? 0) || 0;
      if (paid > 0 && paid < l.quantity) return l;
    }
  }
  return null;
}

/** 1.0.40 (BUG 02) — after a `partial_line` merge refusal, name the item and its table (read only, best
 *  effort: null when it cannot be identified — the caller then shows the generic remedy). */
export async function findPartlyPaidLine(input: {
  tenantId: string;
  branchId: string | null;
  tables: { id: string; name: string }[];
  load?: typeof loadTableBill;
}): Promise<{ itemName: string; tableName: string } | null> {
  const load = input.load ?? loadTableBill;
  for (const t of input.tables) {
    try {
      const line = partlyPaidLine(await load({ tableId: t.id, tenantId: input.tenantId, branchId: input.branchId }));
      if (line) return { itemName: line.name, tableName: t.name };
    } catch {
      /* best effort */
    }
  }
  return null;
}

/** The quantity of a line that is still open (not settled by a paid split). */
export function unpaidQuantity(line: BillLine): number {
  return Math.max(0, line.quantity - Math.max(0, Number(line.paid_quantity ?? 0) || 0));
}

/** What the server already holds against this bill through paid splits, when KNOWN from the settlement read
 *  (0 when nothing is paid, not read, unknown, or mixed-currency). Display/print only — money decisions use
 *  `effectiveCollected` (tablePayment.ts), which also honours the map's figure. */
export function billCollected(bill: TableBill | null | undefined): number {
  if (!bill || bill.collectedKnown !== true) return 0;
  return Math.max(0, Number(bill.collected ?? 0) || 0);
}

/** The amount still due on the bill: gross T − paid splits P (null when no single figure exists). */
export function billDue(bill: TableBill): number | null {
  if (bill.total == null) return null;
  return Math.max(0, round2(bill.total - billCollected(bill)));
}

/**
 * PURE — the bill as the cashier must SEE it: every line at its UNPAID quantity (line total prorated), lines
 * fully settled by a split removed, batches recomputed. A bill with nothing paid by quantity is returned
 * AS IS (identical to every release before 1.0.40). Totals stay the server's; use `billDue` for the due.
 */
export function unpaidBillView(bill: TableBill): TableBill {
  const anyPaid = bill.orders.some((o) => o.lines.some((l) => (l.paid_quantity ?? 0) > 0));
  if (!anyPaid) return bill;
  const orders = bill.orders.map((o) => ({
    ...o,
    lines: o.lines
      .filter((l) => unpaidQuantity(l) > 0)
      .map((l) => {
        const open = unpaidQuantity(l);
        if (open === l.quantity) return l;
        const unitTotal = l.quantity > 0 ? l.line_total / l.quantity : l.final_unit_price;
        return { ...l, quantity: open, line_total: round2(unitTotal * open) };
      }),
  }));
  const batches = Array.from(new Set(orders.flatMap((o) => o.lines.map((l) => l.batch_no)))).sort((a, b) => a - b);
  return { ...bill, orders, batches };
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
