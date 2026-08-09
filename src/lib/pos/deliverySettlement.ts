// Delivery settlement (Level 3C): paying one delivery order, once.
//
// THE CONTRACT, stated where the code lives
// `pos_pay_order` consumes exactly `order_id`, `method`, `currency_code`, and -
// only when a discount is actually applied - `discount_type` / `discount_value`.
// It has **no idempotency key**. Duplicate safety is state-based: the first call
// sets the order paid, and a second finds it already paid and raises.
//
// That is the same shape as `pos_pay_table` in Level 2D, so the recovery model
// is the same and for the same reason: a lost response leaves the client
// genuinely unable to say whether money changed hands, and the only honest move
// is to ASK the server rather than retry. `performDeliverySettlement` calls
// `submit` at most once.
//
// PAYMENT IS THE WHOLE LIFECYCLE. `pos_pay_order` sets `payment_status = 'paid'`
// AND `status = 'completed'` in one statement, and the schema has no `collected`
// status and no completion RPC. So there is deliberately no second action here:
// paying the order finishes it, releases the shift-close blocker
// (`pos_shift_unresolved_orders` resolves on completed+paid) and makes the order
// eligible for the server's own material-usage path. The desktop writes no
// inventory of any kind.

import { asRecord, bool, callPosRpc, num, numOrNull, requireId, str, strOrNull } from "@/lib/pos/rpc";
import { computeDiscount, type DiscountType } from "@/lib/pos/discounts";
import { OPEN_DELIVERY_STATUSES, type OpenDeliveryOrder } from "@/lib/pos/deliveryOrder";
import type { CurrencyCode } from "@/lib/currency";
import type { ReceiptLine, ReceiptModifier } from "@/lib/receipt";
import type { PaymentMethod } from "@/lib/pos/payments";
import type { Gate } from "@/components/ui";

// --- errors ------------------------------------------------------------------

export class NoUnpaidDeliveryOrderError extends Error {
  constructor() {
    super("There is no unpaid delivery order to settle");
    this.name = "NoUnpaidDeliveryOrderError";
  }
}

export class DeliveryOrderChangedError extends Error {
  constructor(what: string) {
    super(`The delivery order changed before payment: ${what}`);
    this.name = "DeliveryOrderChangedError";
  }
}

export class DeliveryPaymentInProgressError extends Error {
  constructor() {
    super("This payment is already being sent");
    this.name = "DeliveryPaymentInProgressError";
  }
}

/** The one state that must never be resolved by guessing. */
export class DeliveryPaymentAmbiguousError extends Error {
  readonly cause: unknown;
  constructor(cause: unknown) {
    super(
      "Could not confirm whether the payment was taken. Do NOT take payment again - refresh the order and check whether it is already paid.",
    );
    this.name = "DeliveryPaymentAmbiguousError";
    this.cause = cause;
  }
}

export class DeliveryDiscountNotPermittedError extends Error {
  constructor(reason?: string | null) {
    super(reason ?? "You do not have permission to apply discounts");
    this.name = "DeliveryDiscountNotPermittedError";
  }
}

export class InvalidDeliveryDiscountError extends Error {
  constructor(detail: string) {
    super(`This discount cannot be applied: ${detail}`);
    this.name = "InvalidDeliveryDiscountError";
  }
}

// --- the gate ----------------------------------------------------------------

/**
 * THE settlement gate. One result, shared by the Pay button, F4 and the dialog's
 * own confirm, so no surface can hold a different opinion about whether this
 * order may be settled.
 *
 * `pos.apply_discounts` is deliberately NOT here: a cashier who cannot discount
 * may still settle at full price, exactly as in Level 2D. Discount permission is
 * checked only when a discount is actually entered.
 */
export function deliveryPaymentGate(input: {
  deliveryAccess: Gate;
  takePayments: Gate;
  order: OpenDeliveryOrder | null;
  /** The order's own shift, and whether it is still open. */
  hasOpenShift: boolean;
  online: boolean;
  /** LBP with no tenant rate is refused before the request, never guessed. */
  currencyBlockedReason: string | null;
  paying: boolean;
}): Gate {
  if (!input.deliveryAccess.allowed) return input.deliveryAccess;
  if (!input.order) return { allowed: false, reason: "There is no unpaid delivery order to settle." };
  if (input.order.payment_status === "paid") {
    return { allowed: false, reason: "This delivery order is already paid." };
  }
  if (!OPEN_DELIVERY_STATUSES.includes(input.order.status as (typeof OPEN_DELIVERY_STATUSES)[number])) {
    return { allowed: false, reason: "This delivery order can no longer be paid." };
  }
  if (!input.takePayments.allowed) return input.takePayments;
  // `pos_pay_order` locks the ORDER's shift, not the cashier's: an order whose
  // shift has closed cannot be settled at all.
  if (!input.hasOpenShift) return { allowed: false, reason: "This order's shift is closed. It cannot be settled." };
  if (!input.online) return { allowed: false, reason: "Taking payment needs a connection." };
  if (input.currencyBlockedReason) return { allowed: false, reason: input.currencyBlockedReason };
  if (input.paying) return { allowed: false, reason: "This payment is already being sent." };
  return { allowed: true, reason: null };
}

// --- the payload -------------------------------------------------------------

/** Exactly the keys `pos_pay_order` consumes for a delivery settlement. */
export type DeliveryPaymentPayload = {
  order_id: string;
  method: PaymentMethod;
  currency_code: CurrencyCode;
  discount_type?: "percent" | "amount";
  discount_value?: number;
};

export const DELIVERY_PAYMENT_PAYLOAD_KEYS = [
  "order_id",
  "method",
  "currency_code",
  "discount_type",
  "discount_value",
] as const;

/**
 * Fields that must never reach the RPC.
 *
 * `tendered` and `change` head the list. The payment dialog computes both and
 * hands them back in the same object as the discount, `pos_payments` has no
 * column for either, and a single spread is all it would take. `client_op_id` is
 * next: `pos_pay_order` has no idempotency key, and sending one would imply a
 * guarantee the server does not give - the very mistake Level 2D's recovery
 * model exists to avoid.
 */
export const FORBIDDEN_DELIVERY_PAYMENT_FIELDS = [
  "tendered",
  "change",
  "client_op_id",
  "shift_id",
  "branch_id",
  "customer_id",
  "address_id",
  "order_number",
  "table_id",
  "notes",
  "items",
] as const;

/**
 * Every field named individually. No spread: the dialog's result object carries
 * `tendered` alongside the discount fields, and spreading it would put a
 * cash-handling aid into a financial RPC.
 */
export function buildDeliveryPaymentPayload(input: {
  orderId: string;
  method: PaymentMethod;
  currency: CurrencyCode;
  discount: { discount_type?: "percent" | "amount"; discount_value?: number };
}): DeliveryPaymentPayload {
  const payload: DeliveryPaymentPayload = {
    order_id: input.orderId,
    method: input.method,
    currency_code: input.currency,
  };
  if (input.discount.discount_type !== undefined) payload.discount_type = input.discount.discount_type;
  if (input.discount.discount_value !== undefined) payload.discount_value = input.discount.discount_value;
  return payload;
}

/**
 * Validate a discount the same way the server will.
 *
 * A permitted, valid but ZERO discount sends nothing: an undiscounted payment
 * and a "0%" payment must produce byte-identical payloads.
 */
export function validateDeliveryDiscount(input: {
  canDiscount: Gate;
  subtotal: number;
  type: DiscountType;
  value: string;
}): { fields: { discount_type?: "percent" | "amount"; discount_value?: number }; amount: number } {
  if (input.type === "none") return { fields: {}, amount: 0 };
  if (!input.canDiscount.allowed) throw new DeliveryDiscountNotPermittedError(input.canDiscount.reason);
  const r = computeDiscount(input.subtotal, input.type, input.value);
  if (!r.valid) throw new InvalidDeliveryDiscountError(r.error ?? "the value is not usable");
  if (r.amount <= 0) return { fields: {}, amount: 0 };
  return { fields: { discount_type: input.type, discount_value: Number(input.value) }, amount: r.amount };
}

// --- the RPC -----------------------------------------------------------------

export type DeliveryPaymentResult = {
  order_id: string;
  paid: boolean;
  method: string;
  subtotal: number;
  discount: number;
  amount: number;
  order_number: string;
  currency_code: CurrencyCode;
  original_amount: number;
  exchange_rate: number | null;
};

export async function payDeliveryOrder(payload: DeliveryPaymentPayload): Promise<DeliveryPaymentResult> {
  const row = asRecord(await callPosRpc("pos_pay_order", { p_payload: payload }));
  const currency = str(row.currency_code, "USD");
  return {
    order_id: requireId(row.order_id, "pos_pay_order", "order_id"),
    paid: bool(row.paid),
    method: str(row.method, payload.method),
    subtotal: num(row.subtotal),
    discount: num(row.discount),
    amount: num(row.amount),
    order_number: str(row.order_number),
    currency_code: currency === "LBP" ? "LBP" : "USD",
    original_amount: num(row.original_amount),
    exchange_rate: numOrNull(row.exchange_rate),
  };
}

// --- the pre-payment re-read -------------------------------------------------

/** What the order looked like when the operator pressed Pay. */
export type SettlementTarget = {
  orderId: string;
  customerId: string | null;
  addressId: string | null;
  total: number;
};

/**
 * The amount on screen is not authority to charge.
 *
 * Re-reads the order immediately before submitting and refuses on ANY change to
 * identity or money. A gate that passed thirty seconds ago says nothing about an
 * order another terminal has since edited, settled or voided.
 */
export function checkSettlementTarget(intended: SettlementTarget, fresh: OpenDeliveryOrder | null): void {
  if (!fresh) throw new DeliveryOrderChangedError("it is no longer available");
  if (fresh.id !== intended.orderId) throw new DeliveryOrderChangedError("a different order is selected");
  if (fresh.payment_status === "paid") throw new DeliveryOrderChangedError("it has already been paid");
  if (!OPEN_DELIVERY_STATUSES.includes(fresh.status as (typeof OPEN_DELIVERY_STATUSES)[number])) {
    throw new DeliveryOrderChangedError(`its status is now ${fresh.status}`);
  }
  if (fresh.customer_id !== intended.customerId) throw new DeliveryOrderChangedError("the customer changed");
  if (fresh.address_id !== intended.addressId) throw new DeliveryOrderChangedError("the delivery address changed");
  if (num(fresh.total_amount) !== num(intended.total)) {
    throw new DeliveryOrderChangedError("the total changed");
  }
}

// --- the latch ---------------------------------------------------------------

export type SettlementLatch = { acquire: () => boolean; release: () => void; held: () => boolean };

/**
 * One payer at a time, decided synchronously.
 *
 * `setState` is asynchronous, so two clicks in the same tick both read a stale
 * "not paying". For money that is not an inconvenience, it is a second charge.
 */
export function createSettlementLatch(): SettlementLatch {
  let held = false;
  return {
    acquire: () => {
      if (held) return false;
      held = true;
      return true;
    },
    release: () => {
      held = false;
    },
    held: () => held,
  };
}

// --- recovery ----------------------------------------------------------------

/** What an authoritative re-read says happened. */
export type SettlementVerdict = "settled" | "unpaid" | "ambiguous";

/**
 * Did the payment land?
 *
 * `settled` requires BOTH halves to agree: the order reports paid/completed AND
 * a payment row exists. Either alone is a half-truth - an order marked paid with
 * no payment row, or a payment row against an unpaid order, is exactly the
 * contradiction that must stop everything rather than be smoothed over.
 */
export function classifySettlement(input: {
  order: OpenDeliveryOrder | null;
  paymentRows: number;
}): SettlementVerdict {
  if (!input.order) return "ambiguous";
  const paid = input.order.payment_status === "paid";
  const completed = input.order.status === "completed";
  if (paid && completed && input.paymentRows >= 1) return "settled";
  if (!paid && input.paymentRows === 0) return "unpaid";
  return "ambiguous";
}

export type SettlementOutcome =
  | { ok: true; result: DeliveryPaymentResult | null; recovered: boolean }
  | { ok: false; error: unknown; retryable: boolean };

/**
 * Settle one delivery order, once.
 *
 * `submit` is called AT MOST ONCE. There is no retry loop, no timer and no queue
 * on this path - a blind retry is the one thing that could take a customer's
 * money twice, and the server has no idempotency key to stop it.
 */
export async function performDeliverySettlement(input: {
  payload: DeliveryPaymentPayload;
  submit: (payload: DeliveryPaymentPayload) => Promise<DeliveryPaymentResult>;
  /** Authoritative re-read, used ONLY after a failure. */
  reread: () => Promise<{ order: OpenDeliveryOrder | null; paymentRows: number }>;
  latch?: SettlementLatch;
}): Promise<SettlementOutcome> {
  if (input.latch && !input.latch.acquire()) {
    return { ok: false, error: new DeliveryPaymentInProgressError(), retryable: false };
  }
  try {
    let result: DeliveryPaymentResult;
    try {
      result = await input.submit(input.payload);
    } catch (error) {
      let state: { order: OpenDeliveryOrder | null; paymentRows: number };
      try {
        state = await input.reread();
      } catch {
        // Cannot even ask. Never guess about money.
        return { ok: false, error: new DeliveryPaymentAmbiguousError(error), retryable: false };
      }
      const verdict = classifySettlement(state);
      // The charge landed and the response was lost. Recovered, not repeated.
      if (verdict === "settled") return { ok: true, result: null, recovered: true };
      // Nothing was charged, so the operator may decide to try again - against
      // freshly read state, not against what was on screen before.
      if (verdict === "unpaid") return { ok: false, error, retryable: true };
      return { ok: false, error: new DeliveryPaymentAmbiguousError(error), retryable: false };
    }
    return { ok: true, result, recovered: false };
  } finally {
    input.latch?.release();
  }
}

// --- the completion sequence -------------------------------------------------

/**
 * What happens after a settlement is accepted, in this order and once.
 *
 * The order is re-read and CHECKED before anything is presented as settled, and
 * the receipt is presented before the panel switches - the ordering Level 1's
 * staging defect taught, where the data survived but the open signal did not.
 */
export const DELIVERY_COMPLETION_SEQUENCE = [
  "refresh-order",
  "verify-paid-and-completed",
  "refresh-cash-box",
  "refresh-history",
  "present-receipt",
  "clear-payment-state",
] as const;

/** Did the order actually reach the final state the server promises? */
export function deliveryIsSettled(order: OpenDeliveryOrder | null): boolean {
  return order?.payment_status === "paid" && order?.status === "completed";
}

/** Read an order's payment row count. Read-only; the desktop writes no payments. */
export async function countPaymentRows(orderId: string): Promise<number> {
  const { supabase } = await import("@/lib/supabase");
  const { count, error } = await supabase
    .from("pos_payments")
    .select("id", { count: "exact", head: true })
    .eq("order_id", orderId);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

/**
 * The order's lines, for the receipt.
 *
 * Read from the SERVER rather than rebuilt from the cart: by the time a delivery
 * order is paid the cart has been cleared for some time, and a receipt assembled
 * from local memory could disagree with what the kitchen actually made.
 */
export async function readOrderReceiptLines(orderId: string): Promise<ReceiptLine[]> {
  const { supabase } = await import("@/lib/supabase");
  const items = await supabase
    .from("pos_order_items")
    .select("id, name_snapshot, quantity, line_total, kitchen_note")
    .eq("order_id", orderId);
  if (items.error) throw new Error(items.error.message);
  const ids = ((items.data ?? []) as unknown[]).map((raw) => strOrNull(asRecord(raw).id)).filter((i): i is string => !!i);
  const byItem = new Map<string, ReceiptModifier[]>();
  if (ids.length > 0) {
    const mods = await supabase
      .from("pos_order_item_modifiers")
      .select("order_item_id, name_snapshot, price_delta, quantity")
      .in("order_item_id", ids);
    if (mods.error) throw new Error(mods.error.message);
    for (const raw of (mods.data ?? []) as unknown[]) {
      const r = asRecord(raw);
      const id = strOrNull(r.order_item_id);
      if (!id) continue;
      byItem.set(id, [
        ...(byItem.get(id) ?? []),
        { name: str(r.name_snapshot, "Extra"), price_delta: num(r.price_delta), quantity: num(r.quantity, 1) },
      ]);
    }
  }
  return ((items.data ?? []) as unknown[])
    .map((raw) => {
      const r = asRecord(raw);
      const id = strOrNull(r.id);
      if (!id) return null;
      const qty = num(r.quantity, 1);
      const lineTotal = num(r.line_total);
      return {
        name: str(r.name_snapshot, "Item"),
        qty,
        // The server's own line total divided by quantity - never a price
        // recomputed from the menu, which may have moved since the order.
        unitPrice: qty > 0 ? lineTotal / qty : lineTotal,
        lineTotal,
        modifiers: byItem.get(id) ?? [],
        note: strOrNull(r.kitchen_note),
      } as ReceiptLine;
    })
    .filter((l): l is ReceiptLine => l !== null);
}

/** The settled order, re-read authoritatively. Never the local copy. */
export async function readSettledOrder(orderId: string): Promise<OpenDeliveryOrder | null> {
  const { supabase } = await import("@/lib/supabase");
  const { data, error } = await supabase
    .from("pos_orders")
    .select(
      "id, order_number, status, payment_status, total_amount, primary_currency_snapshot, customer_id, address_id, notes, created_at",
    )
    .eq("id", orderId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const r = asRecord(data);
  const id = strOrNull(r.id);
  if (!id) return null;
  return {
    id,
    order_number: strOrNull(r.order_number),
    status: str(r.status),
    payment_status: str(r.payment_status),
    total_amount: r.total_amount == null ? null : num(r.total_amount),
    currency: strOrNull(r.primary_currency_snapshot),
    customer_id: strOrNull(r.customer_id),
    address_id: strOrNull(r.address_id),
    notes: strOrNull(r.notes),
    created_at: strOrNull(r.created_at),
  };
}
