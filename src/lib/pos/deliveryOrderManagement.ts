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
  "id, order_number, status, payment_status, payment_method, subtotal, discount_amount, total_amount, primary_currency_snapshot, customer_id, address_id, notes, shift_id, created_at";

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
