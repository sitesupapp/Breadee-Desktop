// Reading a delivery order the operator did not just create (Level 3D).
//
// Everything here is a READ. The queue and the detail drawer need four facts the
// order row does not carry - who the customer is, where it is going, whether the
// order's own shift is still open, and what was actually paid - and a past order
// needs a receipt that can be reopened without charging anything again.
//
// WHY THE SHIFT STATE IS READ PER ORDER. `pos_void_order` locks the ORDER's
// shift to write a refund, not the cashier's. A cashier standing at an open till
// therefore tells you nothing about whether yesterday's paid order can be
// refunded, and asking the operator's own shift would produce a Refund button
// that always fails at the server. So the ORDER's shift is read, and it is the
// only thing the refund gate believes.
//
// WHY THE RECEIPT IS REBUILT RATHER THAN STORED. Nothing is kept locally: the
// figures come from `pos_orders`, the tender from `pos_payments`, and the lines
// from the same authoritative reader settlement uses. Reopening a receipt is
// therefore a re-read, and it writes nothing at all - no payment, no order, no
// void. That is the whole point of the entry point: the operator can look at
// what was sold without the only route to it being to sell it again.

import { asRecord, num, numOrNull, str, strOrNull } from "@/lib/pos/rpc";
import { kitchenStateLabel } from "@/lib/pos/deliveryOrder";
import { readOrderReceiptLines } from "@/lib/pos/deliverySettlement";
import { buildReceipt, type ReceiptData, type ReceiptLine } from "@/lib/receipt";
import type { OpenDeliveryOrder } from "@/lib/pos/deliveryOrder";
import type { DeliveryQueueOrder } from "@/lib/pos/deliveryOrderManagement";
import type { CurrencyCode } from "@/lib/currency";

// --- addresses ---------------------------------------------------------------

/** The parts of an address that make a line, in the order they are read aloud. */
export type AddressParts = {
  address_label?: string | null;
  area?: string | null;
  street?: string | null;
  building?: string | null;
  floor?: string | null;
};

/**
 * ONE address formatter for the whole app.
 *
 * The customer card, the queue row, the detail panel and the receipt must all
 * render the same address the same way - a driver comparing a screen against a
 * printed slip should not have to work out whether two differently-shaped lines
 * are the same place. `CustomerCard` re-exports this rather than keeping a
 * second copy.
 */
export function addressText(a: AddressParts | null | undefined): string {
  if (!a) return "";
  return [a.address_label, a.area, a.street, a.building && `Bldg ${a.building}`, a.floor && `Fl ${a.floor}`]
    .filter(Boolean)
    .join(", ");
}

// --- state chips -------------------------------------------------------------
//
// Labels and tones for states the SERVER produces. Nothing here invents a state:
// there is no "awaiting collection", no "out for delivery" and no "complete"
// that the desktop made up, because an operator who reads a status they can act
// on - when no such lifecycle exists - has been told something untrue.

/** Order status, in words. Extends the kitchen label with the refunded state. */
export function orderStateLabel(status: string): string {
  if (status === "refunded") return "Refunded";
  return kitchenStateLabel(status);
}

export function orderStateTone(status: string): ChipTone {
  if (status === "completed") return "green";
  if (status === "refunded") return "red";
  if (status === "voided" || status === "cancelled") return "slate";
  if (status === "sent_to_kitchen") return "blue";
  return "slate";
}

export function paymentStateLabel(paymentStatus: string): string {
  if (paymentStatus === "paid") return "Paid";
  if (paymentStatus === "refunded") return "Refunded";
  if (paymentStatus === "unpaid") return "Unpaid";
  return paymentStatus;
}

export function paymentStateTone(paymentStatus: string): ChipTone {
  if (paymentStatus === "paid") return "green";
  if (paymentStatus === "refunded") return "red";
  return "amber";
}

/** Mirrors `BadgeTone`, declared here so this module stays importable by tests. */
export type ChipTone = "slate" | "green" | "amber" | "red" | "blue";

/** The order's time, short. The server's timestamp, never a local clock. */
export function orderTimeLabel(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// --- who and where -----------------------------------------------------------

/** The identity behind one order row. Read, never inferred from the selection. */
export type OrderParty = {
  customerName: string | null;
  customerPhone: string | null;
  addressText: string | null;
};

export const UNKNOWN_PARTY: OrderParty = { customerName: null, customerPhone: null, addressText: null };

/**
 * Resolve the customer and address for a page of orders, in two queries.
 *
 * Keyed by ORDER id rather than customer id: the queue renders orders, and a
 * lookup that failed would otherwise silently fall back to whoever is selected
 * on the customer half of the workspace - which is exactly how the wrong name
 * ends up on a receipt.
 */
export async function loadOrderParties(orders: DeliveryQueueOrder[]): Promise<Map<string, OrderParty>> {
  const byOrder = new Map<string, OrderParty>();
  if (orders.length === 0) return byOrder;
  const { supabase } = await import("@/lib/supabase");

  const customerIds = [...new Set(orders.map((o) => o.customer_id).filter((i): i is string => !!i))];
  const addressIds = [...new Set(orders.map((o) => o.address_id).filter((i): i is string => !!i))];

  const customers = new Map<string, { name: string | null; phone: string | null }>();
  if (customerIds.length > 0) {
    const { data, error } = await supabase.from("pos_customers").select("id, name, phone").in("id", customerIds);
    if (error) throw new Error(error.message);
    for (const raw of (data ?? []) as unknown[]) {
      const r = asRecord(raw);
      const id = strOrNull(r.id);
      if (id) customers.set(id, { name: strOrNull(r.name), phone: strOrNull(r.phone) });
    }
  }

  const addresses = new Map<string, string>();
  if (addressIds.length > 0) {
    const { data, error } = await supabase
      .from("pos_customer_addresses")
      .select("id, address_label, area, street, building, floor")
      .in("id", addressIds);
    if (error) throw new Error(error.message);
    for (const raw of (data ?? []) as unknown[]) {
      const r = asRecord(raw);
      const id = strOrNull(r.id);
      if (id) {
        addresses.set(
          id,
          addressText({
            address_label: strOrNull(r.address_label),
            area: strOrNull(r.area),
            street: strOrNull(r.street),
            building: strOrNull(r.building),
            floor: strOrNull(r.floor),
          }),
        );
      }
    }
  }

  for (const o of orders) {
    const c = o.customer_id ? customers.get(o.customer_id) : undefined;
    const a = o.address_id ? addresses.get(o.address_id) : undefined;
    byOrder.set(o.id, {
      customerName: c?.name ?? null,
      customerPhone: c?.phone ?? null,
      addressText: a && a !== "" ? a : null,
    });
  }
  return byOrder;
}

// --- reusing Level 3C ---------------------------------------------------------

/**
 * A queue row in the shape Level 3C's settlement path already speaks.
 *
 * Deliberately a CONVERSION rather than a second payment implementation: paying
 * an order found in the queue must go through the same gate, the same dialog,
 * the same pre-payment re-read and the same latch as paying one just sent, or
 * there would be two answers to "may this be charged?" and only one of them
 * would have been audited.
 */
export function toOpenDeliveryOrder(o: DeliveryQueueOrder): OpenDeliveryOrder {
  return {
    id: o.id,
    order_number: o.order_number,
    status: o.status,
    payment_status: o.payment_status,
    total_amount: o.total_amount,
    currency: o.currency,
    customer_id: o.customer_id,
    address_id: o.address_id,
    notes: o.notes,
    created_at: o.created_at,
  };
}

// --- did the edit land? ------------------------------------------------------

/**
 * Whether a re-read shows the state an edit asked for.
 *
 * Only the keys that were actually SENT are checked, which is the whole benefit
 * of presence semantics: an edit that never mentioned the discount says nothing
 * about what the discount should be, and asserting otherwise would report a
 * successful note edit as a failure. A cleared note reads back as `null` rather
 * than `""` (see `strOrNull`), so the comparison normalises both to "".
 */
export function editReached(input: {
  payload: { note?: string; discount_type?: string | null };
  /** What the sent discount should compute to, or null when none was sent. */
  expectedDiscountAmount: number | null;
  order: DeliveryQueueOrder | null;
}): boolean {
  const o = input.order;
  if (!o) return false;
  if (input.payload.note !== undefined && (o.notes ?? "") !== input.payload.note) return false;
  if (input.expectedDiscountAmount !== null && (o.discount_amount ?? 0) !== input.expectedDiscountAmount) return false;
  return true;
}

// --- the order's own shift ---------------------------------------------------

/** The only status `_pos_lock_open_shift` will accept. */
export const OPEN_SHIFT_STATUS = "open";

export function shiftIsOpen(status: string | null | undefined): boolean {
  return status === OPEN_SHIFT_STATUS;
}

/**
 * Which of these shifts are still open.
 *
 * Read for the whole queue at once so the refund gate never has to guess, and
 * never has to fall back to the operator's own shift. An order with no shift id
 * is simply absent from the map, and `shiftIsOpen(undefined)` is false - the
 * safe direction, because a refund that cannot be recorded must not be offered.
 */
export async function loadShiftOpenMap(shiftIds: (string | null)[]): Promise<Map<string, boolean>> {
  const ids = [...new Set(shiftIds.filter((i): i is string => !!i))];
  const map = new Map<string, boolean>();
  if (ids.length === 0) return map;
  const { supabase } = await import("@/lib/supabase");
  const { data, error } = await supabase.from("pos_shifts").select("id, status").in("id", ids);
  if (error) throw new Error(error.message);
  for (const raw of (data ?? []) as unknown[]) {
    const r = asRecord(raw);
    const id = strOrNull(r.id);
    if (id) map.set(id, shiftIsOpen(strOrNull(r.status)));
  }
  return map;
}

/** Whether THIS order's shift is open, as the refund gate asks it. */
export function orderShiftOpen(order: DeliveryQueueOrder | null, shifts: Map<string, boolean>): boolean {
  if (!order?.shift_id) return false;
  return shifts.get(order.shift_id) === true;
}

// --- what was actually paid --------------------------------------------------

export type OrderPayment = {
  method: string | null;
  currency: CurrencyCode;
  amount: number;
  originalAmount: number | null;
  exchangeRate: number | null;
  paidAt: string | null;
};

/**
 * The payment row behind a settled order, if there is one.
 *
 * A REFUNDED order has two rows - the original and the negative reversal - so
 * the earliest is taken: a receipt reprinted for a refunded order should show
 * what the customer was charged, not a negative total that reads like a price.
 */
export async function readOrderPayment(orderId: string): Promise<OrderPayment | null> {
  const { supabase } = await import("@/lib/supabase");
  const { data, error } = await supabase
    .from("pos_payments")
    .select("method, currency_code, amount, original_amount, exchange_rate_usd_to_lbp, paid_at")
    .eq("order_id", orderId)
    .order("paid_at")
    .limit(1);
  if (error) throw new Error(error.message);
  const raw = ((data ?? []) as unknown[])[0];
  if (!raw) return null;
  const r = asRecord(raw);
  const currency = str(r.currency_code, "USD");
  return {
    method: strOrNull(r.method),
    currency: currency === "LBP" ? "LBP" : "USD",
    amount: num(r.amount),
    originalAmount: numOrNull(r.original_amount),
    exchangeRate: numOrNull(r.exchange_rate_usd_to_lbp),
    paidAt: strOrNull(r.paid_at),
  };
}

// --- the historical receipt --------------------------------------------------

/**
 * Rebuild a receipt for an order that was paid at some point in the past.
 *
 * `tendered` and `change` are deliberately absent. They are cash-handling aids
 * captured at the till, they are stored nowhere, and inventing them would put
 * numbers on a document the customer keeps that no record anywhere supports. The
 * order type is stated explicitly for the same reason it is at settlement: the
 * default is "Takeaway", and a delivery receipt that calls itself a takeaway is
 * wrong on the one document that leaves the building.
 */
export function buildHistoricalReceipt(input: {
  tenantName: string | null | undefined;
  branchName: string;
  staffName: string | null;
  order: DeliveryQueueOrder;
  payment: OrderPayment | null;
  lines: ReceiptLine[];
  party: OrderParty;
  /** Used only when neither the order nor the payment recorded one. */
  fallbackCurrency: CurrencyCode;
  at: string;
}): ReceiptData {
  const o = input.order;
  const total = o.total_amount ?? 0;
  const orderCurrency = o.currency === "LBP" || o.currency === "USD" ? (o.currency as CurrencyCode) : null;
  return buildReceipt({
    businessName: input.tenantName,
    branchName: input.branchName,
    orderType: "Delivery",
    staffName: input.staffName,
    orderNumber: o.order_number ?? "",
    at: input.at,
    paid: o.payment_status === "paid",
    method: input.payment?.method ?? o.payment_method ?? null,
    currency: orderCurrency ?? input.payment?.currency ?? input.fallbackCurrency,
    lines: input.lines,
    // Server figures, all three. Nothing on a reprint is recomputed here.
    subtotal: o.subtotal ?? total,
    discount: o.discount_amount ?? 0,
    total,
    tenderCurrency: input.payment?.currency ?? null,
    tenderTotal: input.payment?.originalAmount ?? null,
    tendered: null,
    change: null,
    exchangeRate: input.payment?.exchangeRate ?? null,
    shiftRef: o.shift_id,
    customerName: input.party.customerName,
    customerPhone: input.party.customerPhone,
    deliveryAddress: input.party.addressText,
  });
}

/**
 * Everything a past order's receipt needs, read in one place.
 *
 * Three reads and no writes. Kept together so the call site cannot accidentally
 * assemble a receipt from a mix of fresh and remembered values.
 */
export async function readHistoricalReceipt(input: {
  order: DeliveryQueueOrder;
  party: OrderParty;
  tenantName: string | null | undefined;
  branchName: string;
  staffName: string | null;
  fallbackCurrency: CurrencyCode;
  at: string;
}): Promise<ReceiptData> {
  const [lines, payment] = await Promise.all([
    readOrderReceiptLines(input.order.id),
    readOrderPayment(input.order.id).catch(() => null),
  ]);
  return buildHistoricalReceipt({ ...input, lines, payment });
}
