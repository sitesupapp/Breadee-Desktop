// Delivery order management (Level 3D): the queue, and the two mutations.
//
// THE TWO CONTRACTS, read from the staging definitions.
//
// `pos_edit_order(p_payload jsonb)` reads `order_id`, and OPTIONALLY `note` and
// the `discount_type`/`discount_value` pair. Both optionals are detected by KEY
// PRESENCE (`p_payload ? 'note'`), not by value - so omitting a key leaves the
// column alone, while sending `note: ""` CLEARS it. It refuses voided/cancelled/
// refunded orders, allows a note edit on a paid order, and refuses a discount
// change on one. It takes no shift lock and writes no payment row. There is no
// idempotency key, but every field is a SET rather than a delta, so replaying
// the same payload converges instead of compounding.
//
// `pos_void_order(p_order uuid, p_reason text, p_refund boolean)` is positional,
// not a payload. It IS idempotent: it derives a key from the order id and stores
// the result in `pos_operation_idempotency`, so a second call replays the first
// result with `idempotent_replay: true` rather than refunding twice. That single
// fact makes this the safest financial mutation in the app - safer than payment,
// which has no key at all.
//
// CANCEL AND REFUND ARE NOT THE SAME ACTION. On an UNPAID order, `p_refund`
// false voids it: no shift lock, no payment row, status -> `voided`, and
// `payment_status` is left as it was. On a PAID order the server REFUSES
// `p_refund` false outright, and `p_refund` true locks the order's shift, writes
// a NEGATIVE `pos_payments` row plus a `pos_refunds` row, and moves both status
// and payment_status to `refunded`. The desktop therefore never offers one
// control with a flag - it offers the action the order's state actually permits.
//
// NEITHER RPC RE-CHECKS THE BRANCH. Both assert the tenant and the permission
// and stop there, exactly as `pos_save_order` does with customer and address. So
// the branch check before every mutation is the client's job, and it is the only
// place it happens.

import { asRecord, bool, callPosRpc, num, numOrNull, str, strOrNull } from "@/lib/pos/rpc";
import { computeDiscount, type DiscountType } from "@/lib/pos/discounts";
import type { Gate } from "@/components/ui";

// --- the queue ---------------------------------------------------------------

/** Statuses a delivery order can no longer be acted on from. */
export const TERMINAL_ORDER_STATUSES = ["voided", "cancelled", "refunded"] as const;

/** The Web reads at most this many; matching it keeps the two views comparable. */
export const DELIVERY_QUEUE_LIMIT = 200;

export type DeliveryQueueOrder = {
  id: string;
  order_number: string | null;
  status: string;
  payment_status: string;
  payment_method: string | null;
  subtotal: number | null;
  discount_amount: number | null;
  /**
   * The canonical persisted delivery fee, already folded into `total_amount`.
   * Optional so pre-fee callers and fixtures need not set it; the queue/detail
   * reader always populates it from the `delivery_fee` column.
   */
  delivery_fee?: number | null;
  /**
   * The INTERNAL delivery operations fields (Delivery Management). Written ONLY by
   * `pos_set_delivery_ops`, never by an order save or payment, and never shown on
   * the customer receipt. `delivery_cost` preserves the NULL(unknown) vs 0(free)
   * distinction; a recorded margin exists only where a cost is known.
   */
  delivery_handler_type?: string | null;
  delivered_by_user_id?: string | null;
  delivery_person_ref?: string | null;
  delivery_cost?: number | null;
  total_amount: number | null;
  currency: string | null;
  customer_id: string | null;
  address_id: string | null;
  notes: string | null;
  shift_id: string | null;
  created_at: string | null;
};

export function isTerminal(status: string): boolean {
  return (TERMINAL_ORDER_STATUSES as readonly string[]).includes(status);
}

function toQueueOrder(raw: unknown): DeliveryQueueOrder | null {
  const r = asRecord(raw);
  const id = strOrNull(r.id);
  if (!id) return null;
  return {
    id,
    order_number: strOrNull(r.order_number),
    status: str(r.status),
    payment_status: str(r.payment_status),
    payment_method: strOrNull(r.payment_method),
    subtotal: r.subtotal == null ? null : num(r.subtotal),
    discount_amount: r.discount_amount == null ? null : num(r.discount_amount),
    delivery_fee: r.delivery_fee == null ? null : num(r.delivery_fee),
    delivery_handler_type: strOrNull(r.delivery_handler_type),
    delivered_by_user_id: strOrNull(r.delivered_by_user_id),
    delivery_person_ref: strOrNull(r.delivery_person_ref),
    delivery_cost: r.delivery_cost == null ? null : num(r.delivery_cost),
    total_amount: r.total_amount == null ? null : num(r.total_amount),
    currency: strOrNull(r.primary_currency_snapshot),
    customer_id: strOrNull(r.customer_id),
    address_id: strOrNull(r.address_id),
    notes: strOrNull(r.notes),
    shift_id: strOrNull(r.shift_id),
    created_at: strOrNull(r.created_at),
  };
}

/** Local-day bounds as ISO strings. The operator's day, not UTC's. */
export function todayBounds(now: Date): { start: string; end: string } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

const QUEUE_COLUMNS =
  "id, order_number, status, payment_status, payment_method, subtotal, discount_amount, delivery_fee, delivery_handler_type, delivered_by_user_id, delivery_person_ref, delivery_cost, total_amount, primary_currency_snapshot, customer_id, address_id, notes, shift_id, created_at";

/**
 * The operator's delivery queue.
 *
 * Scope mirrors the web panel exactly: an OPEN SHIFT means the shift's orders,
 * and no shift means today's. That is not an arbitrary choice - it is what makes
 * the list match the drawer the cashier is answerable for. RLS supplies the
 * tenant and branch; nothing here widens them.
 */
export async function loadDeliveryQueue(input: {
  tenantId: string | null;
  branchId: string | null;
  shiftId: string | null;
  now: Date;
}): Promise<DeliveryQueueOrder[]> {
  if (!input.tenantId || !input.branchId) return [];
  const { supabase } = await import("@/lib/supabase");
  let q = supabase
    .from("pos_orders")
    .select(QUEUE_COLUMNS)
    .eq("tenant_id", input.tenantId)
    .eq("branch_id", input.branchId)
    .eq("order_type", "delivery")
    .order("created_at", { ascending: false })
    .limit(DELIVERY_QUEUE_LIMIT);
  if (input.shiftId) {
    q = q.eq("shift_id", input.shiftId);
  } else {
    const { start, end } = todayBounds(input.now);
    q = q.gte("created_at", start).lt("created_at", end);
  }
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return ((data ?? []) as unknown[]).map(toQueueOrder).filter((o): o is DeliveryQueueOrder => o !== null);
}

/** How the queue summarises itself. Only states the server actually produces. */
export function queueCounts(orders: DeliveryQueueOrder[]): {
  unpaid: number;
  paid: number;
  cancelled: number;
} {
  let unpaid = 0;
  let paid = 0;
  let cancelled = 0;
  for (const o of orders) {
    if (isTerminal(o.status)) cancelled += 1;
    else if (o.payment_status === "paid") paid += 1;
    else unpaid += 1;
  }
  return { unpaid, paid, cancelled };
}

// --- the detail --------------------------------------------------------------

export type DeliveryOrderLine = {
  id: string;
  name: string;
  quantity: number;
  lineTotal: number;
  kitchenNote: string | null;
  modifiers: { name: string; priceDelta: number; quantity: number }[];
};

/** One order's lines, read authoritatively. Never rebuilt from a cart. */
export async function loadDeliveryOrderLines(orderId: string): Promise<DeliveryOrderLine[]> {
  const { supabase } = await import("@/lib/supabase");
  const items = await supabase
    .from("pos_order_items")
    .select("id, name_snapshot, quantity, line_total, kitchen_note")
    .eq("order_id", orderId)
    .order("created_at");
  if (items.error) throw new Error(items.error.message);
  const ids = ((items.data ?? []) as unknown[])
    .map((raw) => strOrNull(asRecord(raw).id))
    .filter((i): i is string => !!i);
  const byItem = new Map<string, DeliveryOrderLine["modifiers"]>();
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
        { name: str(r.name_snapshot, "Extra"), priceDelta: num(r.price_delta), quantity: num(r.quantity, 1) },
      ]);
    }
  }
  return ((items.data ?? []) as unknown[])
    .map((raw) => {
      const r = asRecord(raw);
      const id = strOrNull(r.id);
      if (!id) return null;
      return {
        id,
        name: str(r.name_snapshot, "Item"),
        quantity: num(r.quantity, 1),
        lineTotal: num(r.line_total),
        kitchenNote: strOrNull(r.kitchen_note),
        modifiers: byItem.get(id) ?? [],
      };
    })
    .filter((l): l is DeliveryOrderLine => l !== null);
}

/** Re-read one order. The authority for every gate and every pre-mutation check. */
export async function readDeliveryOrder(orderId: string): Promise<DeliveryQueueOrder | null> {
  const { supabase } = await import("@/lib/supabase");
  const { data, error } = await supabase.from("pos_orders").select(QUEUE_COLUMNS).eq("id", orderId).maybeSingle();
  if (error) throw new Error(error.message);
  return toQueueOrder(data);
}

// --- errors ------------------------------------------------------------------

export class OrderChangedError extends Error {
  constructor(what: string) {
    super(`The order changed before the action: ${what}`);
    this.name = "OrderChangedError";
  }
}

export class OrderTerminalError extends Error {
  constructor(status: string) {
    super(`This order is already ${status} and can no longer be changed`);
    this.name = "OrderTerminalError";
  }
}

export class MutationInProgressError extends Error {
  constructor(what: string) {
    super(`This ${what} is already being sent`);
    this.name = "MutationInProgressError";
  }
}

export class ReasonRequiredError extends Error {
  constructor() {
    super("A reason is required — it is recorded against your account");
    this.name = "ReasonRequiredError";
  }
}

export class MutationAmbiguousError extends Error {
  readonly cause: unknown;
  constructor(what: string, cause: unknown) {
    super(`Could not confirm whether the ${what} was applied. Refresh the order and check before trying again.`);
    this.name = "MutationAmbiguousError";
    this.cause = cause;
  }
}

// --- shared shape ------------------------------------------------------------

export type MutationLatch = { acquire: () => boolean; release: () => void; held: () => boolean };

/** One holder at a time, decided synchronously. Same reason as every other latch. */
export function createMutationLatch(): MutationLatch {
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

/**
 * The branch check neither RPC performs.
 *
 * Both assert only the tenant, so an order belonging to another branch would be
 * editable and voidable by anyone with the permission. This is the only place
 * that is prevented.
 */
export function checkOrderContext(
  order: DeliveryQueueOrder | null,
  expected: { orderId: string; branchOrderIds: Set<string> },
): void {
  if (!order) throw new OrderChangedError("it is no longer available");
  if (order.id !== expected.orderId) throw new OrderChangedError("a different order is selected");
  if (!expected.branchOrderIds.has(order.id)) {
    throw new OrderChangedError("it does not belong to this branch");
  }
  if (isTerminal(order.status)) throw new OrderTerminalError(order.status);
}

// --- edit --------------------------------------------------------------------

/** Exactly the keys `pos_edit_order` reads. */
export const EDIT_PAYLOAD_KEYS = ["order_id", "note", "discount_type", "discount_value"] as const;

/**
 * Fields an edit must never carry.
 *
 * The server ignores them, but sending them would say the desktop believes an
 * edit can move an order between customers or rebuild its items - and the next
 * person reading this code would believe it too.
 */
export const FORBIDDEN_EDIT_FIELDS = [
  "customer_id",
  "address_id",
  "items",
  "branch_id",
  "shift_id",
  "table_id",
  "status",
  "payment_status",
  "total_amount",
  "subtotal",
] as const;

export type EditOrderPayload = {
  order_id: string;
  note?: string;
  discount_type?: "percent" | "amount" | null;
  discount_value?: number | null;
};

export type EditOrderResult = { ok: boolean; order_id: string };

/**
 * Editing at all: the permission, a live order, a connection, nothing in flight.
 *
 * `pos.apply_discounts` is deliberately absent - a note edit needs only
 * `pos.edit_orders`, and the discount permission is checked when a discount is
 * actually part of the edit.
 */
export function editOrderGate(input: {
  deliveryAccess: Gate;
  canEditOrders: Gate;
  order: DeliveryQueueOrder | null;
  online: boolean;
  busy: boolean;
}): Gate {
  if (!input.deliveryAccess.allowed) return input.deliveryAccess;
  if (!input.order) return { allowed: false, reason: "Select an order first." };
  if (isTerminal(input.order.status)) {
    return { allowed: false, reason: `This order is ${input.order.status} and can no longer be edited.` };
  }
  if (!input.canEditOrders.allowed) return input.canEditOrders;
  if (!input.online) return { allowed: false, reason: "Editing an order needs a connection." };
  if (input.busy) return { allowed: false, reason: "This edit is already being sent." };
  return { allowed: true, reason: null };
}

/**
 * Build an edit.
 *
 * Keys are included only when the operator actually changed something, because
 * the server detects them by PRESENCE: an unnecessary `note` key would rewrite a
 * note that nobody touched, and an unnecessary discount pair would be refused on
 * a paid order for an edit that was only ever about the note.
 */
export function buildEditPayload(input: {
  orderId: string;
  note?: string | null;
  discount?: { type: DiscountType; value: string } | null;
  isPaid: boolean;
  canDiscount: Gate;
  subtotal: number;
}): EditOrderPayload {
  const payload: EditOrderPayload = { order_id: input.orderId };
  if (input.note !== undefined && input.note !== null) payload.note = input.note.trim();
  if (input.discount) {
    if (input.isPaid) throw new Error("Cannot change the discount on a paid order");
    if (!input.canDiscount.allowed) {
      throw new Error(input.canDiscount.reason ?? "You do not have permission to apply discounts");
    }
    if (input.discount.type === "none") {
      // Clearing: the server treats a null/zero value as "no discount".
      payload.discount_type = null;
      payload.discount_value = null;
    } else {
      const r = computeDiscount(input.subtotal, input.discount.type, input.discount.value);
      if (!r.valid) throw new Error(`This discount cannot be applied: ${r.error ?? "the value is not usable"}`);
      payload.discount_type = input.discount.type;
      payload.discount_value = Number(input.discount.value);
    }
  }
  return payload;
}

export async function editDeliveryOrder(payload: EditOrderPayload): Promise<EditOrderResult> {
  const row = asRecord(await callPosRpc("pos_edit_order", { p_payload: payload }));
  return { ok: bool(row.ok), order_id: str(row.order_id, payload.order_id) };
}

export type MutationOutcome<T> =
  | { ok: true; result: T | null; recovered: boolean }
  | { ok: false; error: unknown; retryable: boolean };

/**
 * Apply an edit, once.
 *
 * Recovery is simpler here than for money, and for a good reason: every field is
 * a SET, so after a lost response the question is just "does the order already
 * say what I asked for?". If it does, the edit landed. If it does not, nothing
 * was written and the same payload can be sent again safely.
 */
export async function performEdit(input: {
  payload: EditOrderPayload;
  submit: (p: EditOrderPayload) => Promise<EditOrderResult>;
  reread: () => Promise<DeliveryQueueOrder | null>;
  /** Did the re-read land on the state this edit asked for? */
  matches: (o: DeliveryQueueOrder) => boolean;
  latch?: MutationLatch;
}): Promise<MutationOutcome<EditOrderResult>> {
  if (input.latch && !input.latch.acquire()) {
    return { ok: false, error: new MutationInProgressError("edit"), retryable: false };
  }
  try {
    let result: EditOrderResult;
    try {
      result = await input.submit(input.payload);
    } catch (error) {
      let fresh: DeliveryQueueOrder | null;
      try {
        fresh = await input.reread();
      } catch {
        return { ok: false, error: new MutationAmbiguousError("edit", error), retryable: false };
      }
      if (!fresh) return { ok: false, error: new MutationAmbiguousError("edit", error), retryable: false };
      if (input.matches(fresh)) return { ok: true, result: null, recovered: true };
      return { ok: false, error, retryable: true };
    }
    return { ok: true, result, recovered: false };
  } finally {
    input.latch?.release();
  }
}

// --- cancel / refund ---------------------------------------------------------

/**
 * What this order's state permits.
 *
 * Returned as a NAME rather than a boolean flag, so no call site can end up
 * deciding "cancel or refund?" for itself. The server refuses `p_refund = false`
 * on a paid order outright, and this is how the UI stays on the right side of
 * that refusal instead of discovering it.
 */
export type VoidAction = "cancel" | "refund";

export function voidActionFor(order: DeliveryQueueOrder): VoidAction {
  return order.payment_status === "paid" ? "refund" : "cancel";
}

/** `p_refund` is derived from the action, never chosen separately. */
export function refundFlagFor(action: VoidAction): boolean {
  return action === "refund";
}

export type VoidOrderResult = {
  order_id: string;
  voided: boolean;
  status: string;
  was_paid: boolean;
  refunded: boolean;
  refund_usd: number;
  refund_amount: number;
  refund_id: string | null;
  idempotent_replay: boolean;
};

/**
 * Cancelling or refunding.
 *
 * A refund additionally requires the ORDER's shift to be open, because
 * `pos_void_order` locks it to write the reversal into the right drawer. An
 * unpaid cancel takes no lock at all, so a closed shift does not block it.
 */
export function voidOrderGate(input: {
  deliveryAccess: Gate;
  canCancelOrders: Gate;
  order: DeliveryQueueOrder | null;
  /** Whether the ORDER's own shift is open - not the operator's current one. */
  orderShiftOpen: boolean;
  online: boolean;
  busy: boolean;
}): Gate {
  if (!input.deliveryAccess.allowed) return input.deliveryAccess;
  if (!input.order) return { allowed: false, reason: "Select an order first." };
  if (isTerminal(input.order.status)) {
    return { allowed: false, reason: `This order is already ${input.order.status}.` };
  }
  if (!input.canCancelOrders.allowed) return input.canCancelOrders;
  if (voidActionFor(input.order) === "refund" && !input.orderShiftOpen) {
    return {
      allowed: false,
      reason: "This order's shift is closed. A refund must be recorded in the shift that took the payment.",
    };
  }
  if (!input.online) return { allowed: false, reason: "This action needs a connection." };
  if (input.busy) return { allowed: false, reason: "This action is already being sent." };
  return { allowed: true, reason: null };
}

/** DESKTOP POLICY: a reason is mandatory, though the server accepts an empty one. */
export function validateVoidReason(reason: string): string {
  const r = reason.trim();
  if (r === "") throw new ReasonRequiredError();
  return r;
}

export async function voidDeliveryOrder(input: {
  orderId: string;
  reason: string;
  action: VoidAction;
}): Promise<VoidOrderResult> {
  const row = asRecord(
    await callPosRpc("pos_void_order", {
      p_order: input.orderId,
      p_reason: input.reason,
      p_refund: refundFlagFor(input.action),
    }),
  );
  return {
    order_id: str(row.order_id, input.orderId),
    voided: bool(row.voided),
    status: str(row.status),
    was_paid: bool(row.was_paid),
    refunded: bool(row.refunded),
    refund_usd: num(row.refund_usd),
    refund_amount: num(row.refund_amount),
    refund_id: strOrNull(row.refund_id),
    idempotent_replay: bool(row.idempotent_replay),
  };
}

/** Did the order reach the terminal state this action was supposed to produce? */
export function voidReached(action: VoidAction, order: DeliveryQueueOrder | null): boolean {
  if (!order) return false;
  if (action === "refund") return order.status === "refunded" && order.payment_status === "refunded";
  return order.status === "voided";
}

/**
 * Cancel or refund, once.
 *
 * `pos_void_order` is idempotent per ORDER - it stores its result and replays it
 * - so unlike payment, a retry here cannot double-refund. The recovery below
 * still refuses to guess: a lost response is resolved by re-reading and
 * checking the terminal state actually arrived, and a state that matches
 * neither outcome blocks rather than being retried.
 */
export async function performVoid(input: {
  orderId: string;
  reason: string;
  action: VoidAction;
  submit: (i: { orderId: string; reason: string; action: VoidAction }) => Promise<VoidOrderResult>;
  reread: () => Promise<DeliveryQueueOrder | null>;
  latch?: MutationLatch;
}): Promise<MutationOutcome<VoidOrderResult>> {
  if (input.latch && !input.latch.acquire()) {
    return { ok: false, error: new MutationInProgressError(input.action), retryable: false };
  }
  try {
    let result: VoidOrderResult;
    try {
      result = await input.submit({ orderId: input.orderId, reason: input.reason, action: input.action });
    } catch (error) {
      let fresh: DeliveryQueueOrder | null;
      try {
        fresh = await input.reread();
      } catch {
        return { ok: false, error: new MutationAmbiguousError(input.action, error), retryable: false };
      }
      // The action landed and the response was lost.
      if (voidReached(input.action, fresh)) return { ok: true, result: null, recovered: true };
      // Untouched and still actionable: the server's own idempotency makes a
      // retry safe, but it stays the operator's decision.
      if (fresh && !isTerminal(fresh.status)) return { ok: false, error, retryable: true };
      return { ok: false, error: new MutationAmbiguousError(input.action, error), retryable: false };
    }
    return { ok: true, result, recovered: result.idempotent_replay };
  } finally {
    input.latch?.release();
  }
}

/** Money the shift should recognise from an order. A voided one contributes nothing. */
export function recognisedTotal(order: DeliveryQueueOrder): number {
  if (isTerminal(order.status)) return 0;
  return numOrNull(order.total_amount) ?? 0;
}

// --- delivery operations (Delivery Management) -------------------------------
//
// The INTERNAL operational fields - who delivered, and what fulfilment COST the
// business, kept apart from the customer's DELIVERY FEE. `pos_set_delivery_ops`
// is the sole authority: it writes only these columns and never the subtotal,
// delivery fee, charge total, payment, taxes or receipt, and it rejects a
// negative cost or a non-delivery order. The desktop therefore NEVER updates
// `pos_orders` directly for these - it calls the RPC, exactly as the web panel
// does. Editing is gated by `pos.delivery.manage`, enforced server-side.

export type DeliveryHandlerType = "driver" | "delivery_company";

export type DeliveryOps = {
  delivery_handler_type: DeliveryHandlerType | null;
  /** Preserved through an edit - this MVP surfaces the free-text ref, not a picker. */
  delivered_by_user_id: string | null;
  delivery_person_ref: string | null;
  /** NULL is UNKNOWN (no margin); 0 is an explicit free fulfilment. Kept distinct. */
  delivery_cost: number | null;
};

/** Exactly the parameters `pos_set_delivery_ops` consumes. */
export const DELIVERY_OPS_PARAM_KEYS = [
  "p_order_id",
  "p_delivery_handler_type",
  "p_delivered_by_user_id",
  "p_delivery_person_ref",
  "p_delivery_cost",
] as const;

/**
 * Fields the ops write must NEVER carry. The server ignores them, but sending any
 * would claim the internal editor can move the customer's money - which it cannot.
 * This is the financial firewall the source-contract test asserts against.
 */
export const FORBIDDEN_DELIVERY_OPS_FIELDS = [
  "p_delivery_fee",
  "delivery_fee",
  "p_subtotal",
  "subtotal",
  "p_total",
  "total_amount",
  "p_charge_total",
  "p_payment_status",
  "payment_status",
  "p_tax",
  "p_amount",
  "tendered",
] as const;

/**
 * Parse the Delivery Cost input. Empty is UNKNOWN (null, no margin recorded); a
 * number must be >= 0. Mirrors the delivery-fee parser's null-vs-zero care so a
 * free fulfilment (0) stays distinct from an un-costed one (null).
 */
export function parseDeliveryCost(raw: string): { valid: boolean; value: number | null; provided: boolean } {
  const t = raw.trim();
  if (t === "") return { valid: true, value: null, provided: false };
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return { valid: false, value: null, provided: true };
  return { valid: true, value: n, provided: true };
}

/**
 * The recorded delivery margin for one order: fee minus cost, and ONLY when a cost
 * is known. An un-costed order has no margin (null) - never a fee-as-profit figure.
 * Display only; the report's own margins come from the server.
 */
export function recordedMargin(order: Pick<DeliveryQueueOrder, "delivery_fee" | "delivery_cost">): number | null {
  if (order.delivery_cost == null) return null;
  return (order.delivery_fee ?? 0) - order.delivery_cost;
}

/** Whether a delivery order may be marked collected, from its payment status alone. */
export function isCollected(order: Pick<DeliveryQueueOrder, "payment_status">): boolean {
  return order.payment_status === "paid";
}

export type SetDeliveryOpsResult = DeliveryOps & {
  order_id: string;
  delivery_fee: number | null;
  delivery_margin: number | null;
  currency: string | null;
};

/**
 * Persist the internal delivery ops through the one server authority. The cost is
 * sent as the ONLY numeric field, and never a fee/total/payment; `null` clears a
 * value (leaving cost unknown), a number sets it.
 */
export async function setDeliveryOps(input: {
  orderId: string;
  handlerType: DeliveryHandlerType | null;
  deliveredByUserId: string | null;
  personRef: string | null;
  cost: number | null;
}): Promise<SetDeliveryOpsResult> {
  const row = asRecord(
    await callPosRpc("pos_set_delivery_ops", {
      p_order_id: input.orderId,
      p_delivery_handler_type: input.handlerType,
      p_delivered_by_user_id: input.deliveredByUserId,
      p_delivery_person_ref: input.personRef,
      p_delivery_cost: input.cost,
    }),
  );
  const handler = strOrNull(row.delivery_handler_type);
  return {
    order_id: str(row.order_id, input.orderId),
    delivery_handler_type: handler === "driver" || handler === "delivery_company" ? handler : null,
    delivered_by_user_id: strOrNull(row.delivered_by_user_id),
    delivery_person_ref: strOrNull(row.delivery_person_ref),
    delivery_cost: row.delivery_cost == null ? null : num(row.delivery_cost),
    delivery_fee: row.delivery_fee == null ? null : num(row.delivery_fee),
    delivery_margin: row.delivery_margin == null ? null : num(row.delivery_margin),
    currency: strOrNull(row.currency),
  };
}

// --- delivery report (BI6) ---------------------------------------------------
//
// A READ-ONLY projection: `pos_delivery_report` computes the rows AND the summary
// server-side (business-day- and OU-scoped, gated on `pos.reports.view`), and the
// desktop renders exactly what it returns - NO client aggregation. Every money
// figure is the server's: the fee is the persisted `delivery_fee`, never
// total-minus-subtotal, and a margin exists only where a cost was entered.

export type DeliveryReportRow = {
  order_id: string;
  order_number: string | null;
  date: string | null;
  time: string | null;
  branch_name: string | null;
  delivery_fee: number | null;
  delivery_handler_type: DeliveryHandlerType | null;
  delivered_by: string | null;
  delivery_cost: number | null;
  delivery_margin: number | null;
  payment_status: string;
  collected: boolean;
  status: string;
  currency: string | null;
};

export type DeliveryReportSummary = {
  total_delivery_orders: number;
  total_delivery_fees: number;
  orders_with_cost: number;
  recorded_delivery_cost: number;
  recorded_delivery_margin: number;
  currency: string | null;
};

export type DeliveryReport = {
  from: string | null;
  to: string | null;
  timezone: string | null;
  currency: string | null;
  rows: DeliveryReportRow[];
  summary: DeliveryReportSummary;
};

function toReportRow(raw: unknown): DeliveryReportRow {
  const r = asRecord(raw);
  const handler = strOrNull(r.delivery_handler_type);
  return {
    order_id: str(r.order_id),
    order_number: strOrNull(r.order_number),
    date: strOrNull(r.date),
    time: strOrNull(r.time),
    branch_name: strOrNull(r.branch_name),
    delivery_fee: r.delivery_fee == null ? null : num(r.delivery_fee),
    delivery_handler_type: handler === "driver" || handler === "delivery_company" ? handler : null,
    delivered_by: strOrNull(r.delivered_by),
    delivery_cost: r.delivery_cost == null ? null : num(r.delivery_cost),
    delivery_margin: r.delivery_margin == null ? null : num(r.delivery_margin),
    payment_status: str(r.payment_status),
    collected: bool(r.collected),
    status: str(r.status),
    currency: strOrNull(r.currency),
  };
}

/**
 * Load the delivery report for a date range. `branch` is the operator's OU when
 * one is in scope; omitted, the server applies the operator's own OU visibility.
 * The dates are plain YYYY-MM-DD - the server resolves the branch business day.
 */
export async function loadDeliveryReport(input: {
  from: string;
  to: string;
  branch?: string | null;
}): Promise<DeliveryReport> {
  const row = asRecord(
    await callPosRpc("pos_delivery_report", {
      p_from: input.from,
      p_to: input.to,
      ...(input.branch ? { p_branch: input.branch } : {}),
    }),
  );
  const s = asRecord(row.summary);
  return {
    from: strOrNull(row.from),
    to: strOrNull(row.to),
    timezone: strOrNull(row.timezone),
    currency: strOrNull(row.currency),
    rows: Array.isArray(row.rows) ? (row.rows as unknown[]).map(toReportRow) : [],
    summary: {
      total_delivery_orders: num(s.total_delivery_orders),
      total_delivery_fees: num(s.total_delivery_fees),
      orders_with_cost: num(s.orders_with_cost),
      recorded_delivery_cost: num(s.recorded_delivery_cost),
      recorded_delivery_margin: num(s.recorded_delivery_margin),
      currency: strOrNull(s.currency),
    },
  };
}
