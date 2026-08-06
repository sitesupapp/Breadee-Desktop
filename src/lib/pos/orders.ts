// Order submission against the staging contract.
//
// WHAT CHANGED FROM THE PREVIOUS IMPLEMENTATION (and why it matters)
//
// 1. The entry point is `pos_submit_order` (m224), NOT `pos_save_order`.
//    m224 exists because three rapid "Send to kitchen" clicks created three
//    independent orders. It resolves a client-minted `client_op_id` to at most
//    one order per tenant and replays the stored result for any repeat.
//
// 2. `shift_id` is MANDATORY here. `pos_pay_order` calls `_pos_lock_open_shift`
//    (m149), whose first statement raises when the order's shift is null - so an
//    order saved without a shift can never be paid, and is invisible to
//    `pos_cash_box_shift` / `pos_shift_expected` / `pos_end_shift`, all of which
//    filter by shift_id. Creating one is a data-integrity bug, not a UX gap, so
//    it is refused client-side before the request is made.
//
// 3. The payload carries the full item shape the server reads: modifiers with
//    group/option ids and price deltas (m241) and kitchen notes. Anything the
//    server does not parse is NOT sent.

import { asRecord, bool, callPosRpc, num, requireId, str } from "@/lib/pos/rpc";
import { lineTotals } from "@/lib/pos/modifiers";
import type { CartLine, OrderType, SubmitOrderResult } from "@/types/pos";

/** Exactly the item shape `pos_save_order` iterates over. */
export type SubmitOrderItem = {
  menu_item_id: string;
  name: string;
  base_price: number;
  quantity: number;
  kitchen_note: string | null;
  modifiers: {
    group_id: string | null;
    option_id: string | null;
    name: string;
    price_delta: number;
    quantity: number;
  }[];
};

export type SubmitOrderPayload = {
  branch_id: string | null;
  order_type: OrderType;
  status: string;
  shift_id: string;
  client_op_id: string;
  notes: string | null;
  /**
   * Dine-in only. m218 keys the single-active-bill lookup on it: a dine-in
   * submit carrying a table_id joins that table's ONE open bill as the next
   * batch, while a dine-in submit WITHOUT it silently opens a second,
   * unreachable bill. Omitted entirely for takeaway so that payload is byte-for
   * byte what it was in Level 1.
   */
  table_id?: string;
  items: SubmitOrderItem[];
};

export class ShiftRequiredError extends Error {
  constructor() {
    super("This order is not attached to an open shift");
    this.name = "ShiftRequiredError";
  }
}

/** A dine-in submission without a table would create an orphan second bill. */
export class TableRequiredError extends Error {
  constructor() {
    super("This dine-in order is not attached to a table");
    this.name = "TableRequiredError";
  }
}

/** Mint an operation id for one logical order. One cart => one id, reused on retry. */
export function newClientOpId(): string {
  return crypto.randomUUID();
}

/**
 * Build the submit payload from the cart. Pure, so the exact bytes that go to the
 * server are testable without a network.
 */
export function buildSubmitPayload(input: {
  branchId: string | null;
  shiftId: string | null;
  orderType: OrderType;
  clientOpId: string;
  lines: CartLine[];
  orderNote?: string | null;
  status?: string;
  /** Dine-in only. Required for `dine_in`, rejected implicitly for takeaway. */
  tableId?: string | null;
}): SubmitOrderPayload {
  if (!input.shiftId) throw new ShiftRequiredError();
  if (input.orderType === "dine_in" && !input.tableId) throw new TableRequiredError();
  return {
    branch_id: input.branchId,
    order_type: input.orderType,
    status: input.status ?? "sent_to_kitchen",
    shift_id: input.shiftId,
    client_op_id: input.clientOpId,
    notes: input.orderNote && input.orderNote.trim() !== "" ? input.orderNote.trim() : null,
    // Present ONLY for dine-in, so the takeaway payload is unchanged.
    ...(input.orderType === "dine_in" && input.tableId ? { table_id: input.tableId } : {}),
    items: input.lines.map((l) => ({
      menu_item_id: l.menu_item_id,
      name: l.name,
      base_price: l.base_price,
      quantity: l.quantity,
      kitchen_note: l.kitchen_note && l.kitchen_note.trim() !== "" ? l.kitchen_note.trim() : null,
      modifiers: l.modifiers.map((m) => ({
        group_id: m.group_id,
        option_id: m.option_id,
        name: m.name,
        price_delta: m.price_delta,
        quantity: m.quantity,
      })),
    })),
  };
}

/**
 * The cart subtotal as the SERVER will compute it: sum over lines of
 * (base_price + sum(modifier delta * modifier qty)) * quantity.
 *
 * Used for display and discount validation only. The authoritative subtotal is
 * the one `pos_submit_order` returns, and that is what the receipt shows.
 */
export function cartSubtotal(lines: CartLine[]): number {
  return lines.reduce((sum, l) => sum + lineTotals(l.base_price, l.modifiers, l.quantity).lineTotal, 0);
}

export async function submitOrder(payload: SubmitOrderPayload): Promise<SubmitOrderResult> {
  const row = asRecord(await callPosRpc("pos_submit_order", { p_payload: payload }));
  return {
    order_id: requireId(row.order_id, "pos_submit_order", "order_id"),
    order_number: str(row.order_number),
    subtotal: num(row.subtotal),
    total: num(row.total),
    batch_no: num(row.batch_no, 1),
    appended: bool(row.appended),
    idempotent: bool(row.idempotent),
  };
}
