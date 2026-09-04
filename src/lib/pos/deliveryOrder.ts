// Delivery ordering (Level 3B): revalidation, submission and recovery.
//
// THE CONTRACT, as read from the staging definitions rather than assumed:
//
//   `pos_submit_order(p_payload)` is a thin idempotency wrapper. With a
//   `client_op_id` it takes an advisory lock on (tenant, op), looks the id up in
//   `pos_order_submissions`, and REPLAYS the stored result with
//   `idempotent: true` if it finds one. Otherwise it calls `pos_save_order` and
//   records the submission. Without a `client_op_id` it calls `pos_save_order`
//   directly - i.e. a new order every time. The id is therefore not optional.
//
//   `pos_save_order` stores `customer_id` and `address_id` EXACTLY as given.
//   It does not check that the customer belongs to the tenant. It does not check
//   that the address belongs to the customer. There is no server-side guard on
//   either. Everything below exists because of that sentence.
//
//   A delivery order is a NEW order every time - the append/batch path is
//   dine-in only (it keys on `table_id`), so there is no "join the existing
//   bill" behaviour to lean on. Duplicate safety rests entirely on the op id.
//
// WHY A SHIFT IS REQUIRED, although `pos_save_order` does not demand one:
// `pos_pay_order` locks THE ORDER'S shift via `_pos_lock_open_shift`, whose
// first statement raises "This order is not attached to an open shift" when that
// shift is null. An order created without one can therefore never be paid, and
// is invisible to the cash box and shift report. The web POS refuses the same
// case ("Open a shift first") for every order type, so this is current product
// behaviour, not a stricter desktop rule.
//
// WHAT IS NOT HERE: payment. `pos_pay_order` owns the authoritative delivery
// discount - it recomputes the subtotal and overwrites `discount_amount` and
// `total_amount` at settlement - so discount belongs to Level 3C with payment,
// and this level sends neither.

import { asRecord, bool, num, str, strOrNull } from "@/lib/pos/rpc";
import {
  AddressRequiredError,
  CustomerRequiredError,
  buildSubmitPayload,
  submitOrder,
  type SubmitOrderPayload,
} from "@/lib/pos/orders";
import type { CartLine, SubmitOrderResult } from "@/types/pos";
import type { Gate } from "@/components/ui";

/** Order states that are still live: not settled, not voided. */
export const OPEN_DELIVERY_STATUSES = ["draft", "sent_to_kitchen"] as const;

/**
 * The server's status, in words an operator can act on.
 *
 * Lives here rather than beside the component because the test runner only
 * loads `.ts` - and because a label that decides whether a cashier believes an
 * order is finished deserves to be tested directly rather than by reading JSX.
 * "completed" is never used for an unpaid order: the server only sets it at
 * settlement.
 */
export function kitchenStateLabel(status: string): string {
  if (status === "sent_to_kitchen") return "Sent to kitchen";
  if (status === "draft") return "Not sent yet";
  if (status === "completed") return "Completed";
  if (status === "voided" || status === "cancelled") return "Cancelled";
  return status;
}

// --- errors ------------------------------------------------------------------

/** The selected customer is gone, or was never this tenant's to begin with. */
export class CustomerGoneError extends Error {
  constructor() {
    super("That customer is no longer available. Search for them again");
    this.name = "CustomerGoneError";
  }
}

/** The chosen address no longer belongs to the chosen customer. */
export class AddressMismatchError extends Error {
  constructor() {
    super("That delivery address does not belong to this customer");
    this.name = "AddressMismatchError";
  }
}

/** The branch moved under an in-flight order. */
export class BranchChangedError extends Error {
  constructor() {
    super("The branch changed while this order was being prepared");
    this.name = "BranchChangedError";
  }
}

/** A second submit arrived while the first was still in the air. */
export class DeliveryInProgressError extends Error {
  constructor() {
    super("This delivery order is already being sent");
    this.name = "DeliveryInProgressError";
  }
}

/** The response was lost and the re-read could not settle what happened. */
export class DeliveryAmbiguousError extends Error {
  readonly cause: unknown;
  constructor(cause: unknown) {
    super(
      "Could not confirm whether the delivery order was sent. Check the customer's orders before sending again.",
    );
    this.name = "DeliveryAmbiguousError";
    this.cause = cause;
  }
}

// --- the gate ----------------------------------------------------------------

/**
 * ONE gate, computed once and rendered from everywhere - the Send button, the
 * bottom bar and the keyboard path - so no two surfaces can disagree about
 * whether this basket may be sent.
 *
 * Deliberately NOT in it: `pos.take_payments`. A cashier who may take delivery
 * orders but not money must still be able to work here; payment is Level 3C's
 * gate, not this one.
 */
/**
 * Parse the manual delivery-fee input. Delivery orders always carry the concept,
 * so unlike the web helper there is no order-type branch here: an empty field is
 * "not entered yet" (Send stays disabled), 0 is valid (free delivery), and a
 * negative or non-numeric value is rejected.
 */
export function parseDeliveryFee(raw: string | null | undefined): { valid: boolean; value: number; provided: boolean } {
  const t = (raw ?? "").trim();
  if (t === "") return { valid: false, value: 0, provided: false };
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return { valid: false, value: 0, provided: true };
  return { valid: true, value: n, provided: true };
}

export function deliveryOrderGate(input: {
  deliveryAccess: Gate;
  createOrders: Gate;
  hasOpenShift: boolean;
  online: boolean;
  customerId: string | null;
  addressId: string | null;
  lineCount: number;
  /** The manual delivery fee must be a valid amount (>= 0) before sending. */
  deliveryFeeValid: boolean;
  sending: boolean;
}): Gate {
  if (!input.deliveryAccess.allowed) return input.deliveryAccess;
  if (!input.createOrders.allowed) return input.createOrders;
  if (!input.customerId) return { allowed: false, reason: "Choose a customer first." };
  if (!input.addressId) return { allowed: false, reason: "Choose the delivery address first." };
  if (input.lineCount === 0) return { allowed: false, reason: "Add at least one item." };
  if (!input.deliveryFeeValid) return { allowed: false, reason: "Enter a delivery fee (0 or more)." };
  // Stated before the connection check because it is the more actionable of the
  // two: an operator with no shift can open one, but cannot conjure a network.
  if (!input.hasOpenShift) return { allowed: false, reason: "Open a shift before sending a delivery order." };
  if (!input.online) return { allowed: false, reason: "Sending a delivery order needs a connection." };
  if (input.sending) return { allowed: false, reason: "This delivery order is already being sent." };
  return { allowed: true, reason: null };
}

// --- authoritative revalidation ----------------------------------------------

export type DeliveryTarget = {
  customerId: string;
  addressId: string;
  branchId: string | null;
};

/**
 * Re-read the customer and address from the server immediately before sending.
 *
 * Local state is not evidence: the customer may have been deleted, moved to
 * another branch, or had that address removed on another terminal since the
 * basket was built - and the server checks NONE of it. This is the only place
 * the customer/address relationship is ever verified.
 *
 * RLS does the tenant scoping: `pos_customers` is tenant + branch scoped, so a
 * customer from another tenant simply does not come back.
 */
export async function revalidateTarget(target: DeliveryTarget, currentBranchId: string | null): Promise<void> {
  if (target.branchId !== currentBranchId) throw new BranchChangedError();
  const { supabase } = await import("@/lib/supabase");

  const [cRes, aRes] = await Promise.all([
    supabase.from("pos_customers").select("id").eq("id", target.customerId).maybeSingle(),
    supabase
      .from("pos_customer_addresses")
      .select("id, customer_id")
      .eq("id", target.addressId)
      .maybeSingle(),
  ]);
  if (cRes.error) throw new Error(cRes.error.message);
  if (aRes.error) throw new Error(aRes.error.message);

  if (!strOrNull(asRecord(cRes.data).id)) throw new CustomerGoneError();
  const address = asRecord(aRes.data);
  if (!strOrNull(address.id)) throw new AddressMismatchError();
  // The check the server never makes.
  if (str(address.customer_id) !== target.customerId) throw new AddressMismatchError();
}

// --- payload -----------------------------------------------------------------

/** Exactly the keys `pos_save_order` reads for a delivery send. Nothing else. */
export const DELIVERY_PAYLOAD_KEYS = [
  "branch_id",
  "order_type",
  "status",
  "shift_id",
  "client_op_id",
  "notes",
  "customer_id",
  "address_id",
  // The manual delivery fee. Unlike a discount (which `pos_pay_order` owns and
  // would overwrite at settlement), `pos_save_order` stores this on the order
  // header and `pos_pay_order` does NOT touch it - the finance engine only reads
  // it - so it belongs on the order at creation, not at payment.
  "delivery_fee",
  "items",
] as const;

/**
 * Fields this level must never send.
 *
 * `discount_amount` heads the list: `pos_save_order` WOULD accept it, but
 * `pos_pay_order` recomputes the subtotal and overwrites the discount at
 * settlement, so a discount recorded here is one the payment screen will
 * silently replace. It belongs to Level 3C, with the payment that owns it.
 */
export const FORBIDDEN_DELIVERY_FIELDS = [
  "discount_amount",
  "discount_type",
  "discount_value",
  "method",
  "payment_method",
  "tendered",
  "change",
  "currency_code",
  "table_id",
  "id",
] as const;

export function buildDeliveryPayload(input: {
  branchId: string | null;
  shiftId: string | null;
  clientOpId: string;
  lines: CartLine[];
  customerId: string | null;
  addressId: string | null;
  orderNote?: string | null;
  /** The manual delivery fee (>= 0). Persisted on the order at creation. */
  deliveryFee?: number | null;
}): SubmitOrderPayload {
  if (!input.customerId) throw new CustomerRequiredError();
  if (!input.addressId) throw new AddressRequiredError();
  return buildSubmitPayload({
    branchId: input.branchId,
    shiftId: input.shiftId,
    orderType: "delivery",
    clientOpId: input.clientOpId,
    lines: input.lines,
    orderNote: input.orderNote ?? null,
    // The server's own default, stated rather than inherited: a delivery order
    // is sent to the kitchen when it is placed, not held as a draft.
    status: "sent_to_kitchen",
    customerId: input.customerId,
    addressId: input.addressId,
    deliveryFee: input.deliveryFee ?? null,
  });
}

// --- the latch ---------------------------------------------------------------

export type DeliveryLatch = { acquire: () => boolean; release: () => void; held: () => boolean };

/**
 * One sender at a time, decided synchronously.
 *
 * Identical in shape to the payment and customer latches, and for the identical
 * reason: `setState` is asynchronous, so two clicks in the same tick both read a
 * stale "not sending". Here the op id would make the SECOND call harmless - the
 * server replays - but only if both calls carry the same id, and the latch is
 * what guarantees a second attempt cannot start while the first is choosing one.
 */
export function createDeliveryLatch(): DeliveryLatch {
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

/** One live delivery order, as re-read from the server. */
export type OpenDeliveryOrder = {
  id: string;
  order_number: string | null;
  status: string;
  payment_status: string;
  total_amount: number | null;
  currency: string | null;
  customer_id: string | null;
  address_id: string | null;
  notes: string | null;
  created_at: string | null;
};

function toOpenOrder(raw: unknown): OpenDeliveryOrder | null {
  const r = asRecord(raw);
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

const OPEN_ORDER_COLUMNS =
  "id, order_number, status, payment_status, total_amount, primary_currency_snapshot, customer_id, address_id, notes, created_at";

/**
 * The live, unpaid delivery orders for one customer at this branch.
 *
 * This IS the recovery model, and it is a plain RLS-scoped read rather than an
 * RPC because the server has no "active delivery orders" function -
 * `pos_delivery_client_orders` answers a different question (it scopes to
 * completed+paid or cancelled, for the delivery-clients admin screen, behind a
 * different permission). Nothing about the current order is kept only in React:
 * after a reload the operator finds it here.
 */
export async function loadOpenDeliveryOrders(input: {
  tenantId: string | null;
  branchId: string | null;
  customerId: string;
}): Promise<OpenDeliveryOrder[]> {
  const { supabase } = await import("@/lib/supabase");
  let q = supabase
    .from("pos_orders")
    .select(OPEN_ORDER_COLUMNS)
    .eq("order_type", "delivery")
    .eq("customer_id", input.customerId)
    .neq("payment_status", "paid")
    .in("status", [...OPEN_DELIVERY_STATUSES])
    .order("created_at", { ascending: false });
  if (input.branchId) q = q.eq("branch_id", input.branchId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return ((data ?? []) as unknown[]).map(toOpenOrder).filter((o): o is OpenDeliveryOrder => o !== null);
}

export type DeliveryOutcome =
  | { ok: true; result: SubmitOrderResult; recovered: boolean }
  | { ok: false; error: unknown; retryable: boolean };

/**
 * Send one delivery order, once.
 *
 * The recovery shape is Level 2D's, with one crucial difference in its favour:
 * `pos_submit_order` DOES have an idempotency key, so a retry carrying the same
 * `client_op_id` is safe by construction - the server replays the first result
 * instead of creating a second order. That is why the op id is minted by the
 * caller and held across failures rather than regenerated.
 *
 * The re-read still matters, because a lost response leaves the client unable to
 * tell "never arrived" from "arrived and the reply was dropped", and the
 * operator needs to be told which. `recoverSearch` answers it authoritatively.
 */
export async function performDeliveryOrder(input: {
  payload: SubmitOrderPayload;
  submit: (payload: SubmitOrderPayload) => Promise<SubmitOrderResult>;
  /** Authoritative re-read of this customer's live delivery orders. */
  recoverSearch: () => Promise<OpenDeliveryOrder[]>;
  /** Identifies the intended order among whatever the re-read returns. */
  matchesIntent: (order: OpenDeliveryOrder) => boolean;
  latch?: DeliveryLatch;
}): Promise<DeliveryOutcome> {
  if (input.latch && !input.latch.acquire()) {
    return { ok: false, error: new DeliveryInProgressError(), retryable: false };
  }
  try {
    let result: SubmitOrderResult;
    try {
      result = await input.submit(input.payload);
    } catch (error) {
      let found: OpenDeliveryOrder[];
      try {
        found = await input.recoverSearch();
      } catch {
        return { ok: false, error: new DeliveryAmbiguousError(error), retryable: false };
      }
      const match = found.find(input.matchesIntent);
      if (match) {
        // The write landed before the response was lost.
        return {
          ok: true,
          recovered: true,
          result: {
            order_id: match.id,
            order_number: match.order_number ?? "",
            subtotal: 0,
            total: match.total_amount ?? 0,
            batch_no: 1,
            appended: false,
            idempotent: true,
          },
        };
      }
      // Nothing on file, so nothing was written. A retry is safe - and because it
      // reuses the same op id, it stays safe even if this read was itself stale.
      return { ok: false, error, retryable: true };
    }
    return { ok: true, result, recovered: bool(result.idempotent) };
  } finally {
    input.latch?.release();
  }
}
