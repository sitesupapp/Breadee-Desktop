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
  /**
   * Delivery only. `pos_save_order` stores both of these RAW - it does not check
   * that the customer belongs to the tenant, nor that the address belongs to the
   * customer. There is no server-side guard here at all, so the desktop must
   * re-read and validate both before submitting (see `lib/pos/deliveryOrder.ts`).
   * Omitted entirely for takeaway and dine-in so those payloads are unchanged.
   */
  customer_id?: string;
  address_id?: string;
  /**
   * Delivery only. The manual delivery fee entered during the delivery order
   * flow, BEFORE the order is sent — the fee belongs to the order, not only to
   * payment. `pos_save_order` persists it to `pos_orders.delivery_fee` and applies
   * the canonical finance layer, so an unpaid delivery order already carries the
   * fee, its charge line and a fee-inclusive total for the bill/receipt. Never a
   * total: the client sends only the fee. Absent for takeaway and dine-in.
   */
  delivery_fee?: number;
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

/**
 * A delivery submission with no customer.
 *
 * `pos_save_order` would accept it - `customer_id` is nullable and unchecked -
 * and produce a delivery order nobody can be delivered to, invisible to the
 * customer's history. Refused before the request exists.
 */
export class CustomerRequiredError extends Error {
  constructor() {
    super("This delivery order is not attached to a customer");
    this.name = "CustomerRequiredError";
  }
}

/**
 * A delivery submission with no address.
 *
 * Also accepted by the server, and also a dead end: the kitchen prepares food
 * with nowhere to send it. The WEB POS refuses the same case ("Attach a customer
 * with a delivery address first"), so this matches current product behaviour
 * rather than inventing a stricter desktop rule.
 */
export class AddressRequiredError extends Error {
  constructor() {
    super("This delivery order is not attached to a delivery address");
    this.name = "AddressRequiredError";
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
  /** Delivery only. Both required for `delivery`, absent for every other type. */
  customerId?: string | null;
  addressId?: string | null;
  /**
   * Delivery only. The manual delivery fee (>= 0) entered before the order is
   * sent. Sent as the ONLY money field — never a total. Absent (or null) leaves
   * the order with no fee; the server re-validates and ignores it on any other
   * route.
   */
  deliveryFee?: number | null;
}): SubmitOrderPayload {
  if (!input.shiftId) throw new ShiftRequiredError();
  if (input.orderType === "dine_in" && !input.tableId) throw new TableRequiredError();
  if (input.orderType === "delivery") {
    if (!input.customerId) throw new CustomerRequiredError();
    if (!input.addressId) throw new AddressRequiredError();
  }
  return {
    branch_id: input.branchId,
    order_type: input.orderType,
    status: input.status ?? "sent_to_kitchen",
    shift_id: input.shiftId,
    client_op_id: input.clientOpId,
    notes: input.orderNote && input.orderNote.trim() !== "" ? input.orderNote.trim() : null,
    // Present ONLY for dine-in, so the takeaway payload is unchanged.
    ...(input.orderType === "dine_in" && input.tableId ? { table_id: input.tableId } : {}),
    // Present ONLY for delivery, for the same reason. Named individually rather
    // than spread from a customer object: the delivery workspace holds the whole
    // profile - phone, notes, every address, the order history - and none of that
    // belongs in an order payload.
    ...(input.orderType === "delivery" && input.customerId && input.addressId
      ? { customer_id: input.customerId, address_id: input.addressId }
      : {}),
    // Present ONLY for delivery, and only when a fee was entered. The fee belongs
    // to the order; the server persists it and computes the fee-inclusive total.
    ...(input.orderType === "delivery" && input.deliveryFee != null
      ? { delivery_fee: input.deliveryFee }
      : {}),
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
