// Customer Receivables / On Account: completing a sale that is not fully paid.
//
// THE CONTRACT, stated where the code lives
// `pos_complete_on_account` consumes exactly `order_id`, `customer_id`, `amount`,
// `method`, and - only when a discount is actually applied - `discount_type` /
// `discount_value`. `pos_complete_table_on_account` is the same shape with
// `table_id` instead of `order_id`. Neither has an idempotency key: like
// `pos_pay_order` / `pos_pay_table` they are STATE-GUARDED, so the client submits
// once and recovers a lost response by an authoritative re-read rather than by
// retrying blindly - a blind retry is the one thing that could book a second
// receivable, and the server has no key to stop it.
//
// THE SERVER OWNS THE MONEY. `amount` is what the customer pays NOW, in the
// order/bill PRIMARY currency (0 = the whole bill goes on account, > 0 = a
// partial payment with the remainder on account). Everything the receipt shows -
// `outstanding`, `paid`, `subtotal`, `discount`, `payment_status` - is read back
// from the RPC response. This module computes none of it; it builds the payload
// field by field and parses the answer.
//
// ONLINE ONLY. On-account is never enqueued to the offline outbox: a receivable
// booked against a customer who cannot be re-read is exactly the ambiguity the
// recovery model exists to avoid. The workspaces block it when offline.
//
// `customer_id` IS REQUIRED. A receivable with no customer is a debt owed by
// nobody. The client refuses to submit one; the server refuses too.

import { asRecord, callPosRpc, num, str } from "@/lib/pos/rpc";
import type { CurrencyCode } from "@/lib/currency";
import type { PaymentMethod } from "@/lib/pos/payments";

// --- errors ------------------------------------------------------------------

/** No customer was chosen for a receivable - the one thing on-account cannot do. */
export class OnAccountCustomerRequiredError extends Error {
  constructor() {
    super("Choose a customer before putting a sale on account");
    this.name = "OnAccountCustomerRequiredError";
  }
}

/** A paid-now amount that is not a usable, non-negative number. */
export class InvalidOnAccountAmountError extends Error {
  constructor(detail: string) {
    super(`This amount cannot be taken on account: ${detail}`);
    this.name = "InvalidOnAccountAmountError";
  }
}

export class OnAccountInProgressError extends Error {
  constructor() {
    super("This on-account sale is already being sent");
    this.name = "OnAccountInProgressError";
  }
}

/** The response was lost and the re-read could not settle what happened. */
export class OnAccountAmbiguousError extends Error {
  readonly cause: unknown;
  constructor(cause: unknown) {
    super(
      "Could not confirm whether the sale was put on account. Do NOT try again - refresh the order and check whether it is already completed.",
    );
    this.name = "OnAccountAmbiguousError";
    this.cause = cause;
  }
}

// --- shared input ------------------------------------------------------------

/** The two discount fields, when a discount is applied. Never a spread of a dialog result. */
export type OnAccountDiscount = { discountType?: "percent" | "amount"; discountValue?: number };

/**
 * Reject a paid-now amount the server would refuse. `0` is legal (full
 * on-account); anything NaN or negative is not. The server re-validates - this
 * exists so a refusal is not discovered after the sale has been booked.
 */
export function assertOnAccountAmount(amount: number): void {
  if (!Number.isFinite(amount)) throw new InvalidOnAccountAmountError("it is not a number");
  if (amount < 0) throw new InvalidOnAccountAmountError("it is negative");
}

// --- payloads (field by field, never a spread) -------------------------------

/** Exactly the keys `pos_complete_on_account` consumes. */
export type OnAccountPayload = {
  order_id: string;
  customer_id: string;
  amount: number;
  method: PaymentMethod;
  discount_type?: "percent" | "amount";
  discount_value?: number;
};

/** Exactly the keys `pos_complete_table_on_account` consumes. */
export type TableOnAccountPayload = {
  table_id: string;
  customer_id: string;
  amount: number;
  method: PaymentMethod;
  discount_type?: "percent" | "amount";
  discount_value?: number;
};

export const ON_ACCOUNT_PAYLOAD_KEYS = [
  "order_id",
  "customer_id",
  "amount",
  "method",
  "discount_type",
  "discount_value",
] as const;

export const TABLE_ON_ACCOUNT_PAYLOAD_KEYS = [
  "table_id",
  "customer_id",
  "amount",
  "method",
  "discount_type",
  "discount_value",
] as const;

function applyDiscount<T extends { discount_type?: "percent" | "amount"; discount_value?: number }>(
  payload: T,
  discount: OnAccountDiscount | undefined,
): T {
  if (discount?.discountType !== undefined) payload.discount_type = discount.discountType;
  if (discount?.discountValue !== undefined) payload.discount_value = discount.discountValue;
  return payload;
}

export function buildOnAccountPayload(input: {
  orderId: string;
  customerId: string;
  amount: number;
  method: PaymentMethod;
  discount?: OnAccountDiscount;
}): OnAccountPayload {
  const payload: OnAccountPayload = {
    order_id: input.orderId,
    customer_id: input.customerId,
    amount: input.amount,
    method: input.method,
  };
  return applyDiscount(payload, input.discount);
}

export function buildTableOnAccountPayload(input: {
  tableId: string;
  customerId: string;
  amount: number;
  method: PaymentMethod;
  discount?: OnAccountDiscount;
}): TableOnAccountPayload {
  const payload: TableOnAccountPayload = {
    table_id: input.tableId,
    customer_id: input.customerId,
    amount: input.amount,
    method: input.method,
  };
  return applyDiscount(payload, input.discount);
}

// --- results (every figure is the server's) ----------------------------------

export type OnAccountPaymentStatus = "unpaid" | "partial";

export type OnAccountResult = {
  payment_status: OnAccountPaymentStatus;
  outstanding_usd: number;
  paid_usd: number;
  order_number: string;
  subtotal: number;
  discount: number;
};

export type TableOnAccountResult = {
  bill_total: number;
  paid_usd: number;
  outstanding_primary: number;
  orders: number;
  subtotal: number;
  discount: number;
  currency_code: CurrencyCode;
};

function asPaymentStatus(value: unknown): OnAccountPaymentStatus {
  return str(value) === "partial" ? "partial" : "unpaid";
}

// --- the RPCs ----------------------------------------------------------------

/**
 * Put one order on account. `customerId` is REQUIRED and `amount` must be a
 * usable, non-negative number - both are checked before the request as well as
 * on the server. `amount` is in the order's PRIMARY currency.
 */
export async function completeOnAccount(input: {
  orderId: string;
  customerId: string;
  amount: number;
  method: PaymentMethod;
  discountType?: "percent" | "amount";
  discountValue?: number;
}): Promise<OnAccountResult> {
  if (!input.customerId) throw new OnAccountCustomerRequiredError();
  assertOnAccountAmount(input.amount);
  const payload = buildOnAccountPayload({
    orderId: input.orderId,
    customerId: input.customerId,
    amount: input.amount,
    method: input.method,
    discount: { discountType: input.discountType, discountValue: input.discountValue },
  });
  const row = asRecord(await callPosRpc("pos_complete_on_account", { p_payload: payload }));
  return {
    payment_status: asPaymentStatus(row.payment_status),
    outstanding_usd: num(row.outstanding_usd),
    paid_usd: num(row.paid_usd),
    order_number: str(row.order_number),
    subtotal: num(row.subtotal),
    discount: num(row.discount),
  };
}

/**
 * Put a whole table's bill on account, completing every open order and freeing
 * the table in one call. `customerId` is REQUIRED; `amount` (table currency) is
 * 0 for a full receivable or > 0 for a partial payment.
 */
export async function completeTableOnAccount(input: {
  tableId: string;
  customerId: string;
  amount: number;
  method: PaymentMethod;
  discountType?: "percent" | "amount";
  discountValue?: number;
}): Promise<TableOnAccountResult> {
  if (!input.customerId) throw new OnAccountCustomerRequiredError();
  assertOnAccountAmount(input.amount);
  const payload = buildTableOnAccountPayload({
    tableId: input.tableId,
    customerId: input.customerId,
    amount: input.amount,
    method: input.method,
    discount: { discountType: input.discountType, discountValue: input.discountValue },
  });
  const row = asRecord(await callPosRpc("pos_complete_table_on_account", { p_payload: payload }));
  const ccy = str(row.currency_code, "USD");
  return {
    bill_total: num(row.bill_total),
    paid_usd: num(row.paid_usd),
    outstanding_primary: num(row.outstanding_primary),
    orders: num(row.orders),
    subtotal: num(row.subtotal),
    discount: num(row.discount),
    currency_code: ccy === "LBP" ? "LBP" : "USD",
  };
}

// --- the latch (mirrors the payment paths) -----------------------------------

export type OnAccountLatch = { acquire: () => boolean; release: () => void; held: () => boolean };

/**
 * One holder at a time, decided synchronously.
 *
 * `setState` is asynchronous, so two clicks in the same tick both read a stale
 * "not sending" and both submit. This prevents the second REQUEST; the server
 * state guard is what prevents the second receivable if a request still slips
 * through, and the recovery model below is what keeps a lost response from
 * becoming one.
 */
export function createOnAccountLatch(): OnAccountLatch {
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

/**
 * What an authoritative re-read says happened after a lost response.
 *
 *   committed - the order/table now shows the completed-on-account state. The
 *               earlier call landed; this is a recovery, not a repeat.
 *   open      - nothing changed; the sale was not booked, so a retry is SAFE.
 *   ambiguous - the server cannot be reached or says something unrecognised.
 *               Neither retry nor completion is permitted.
 */
export type OnAccountVerdict = "committed" | "open" | "ambiguous";

export type OnAccountOutcome<T> =
  | { ok: true; result: T | null; recovered: boolean }
  | { ok: false; error: unknown; retryable: boolean };

/**
 * Run one on-account completion, once.
 *
 * The recovery shape is `performDeliverySettlement`'s, for the same reason: the
 * write may have landed before the response was lost. `submit` is called AT MOST
 * ONCE - there is no retry loop, no timer and no queue. A retry is a new operator
 * decision made against freshly read state, never an automatic reaction to a
 * timeout. The concrete re-read is injected so the whole decision tree is
 * testable without a network, and so each workspace supplies the read that
 * matches its own authority (the order for takeaway/delivery, the table for
 * dine-in).
 */
export async function performOnAccount<T>(input: {
  submit: () => Promise<T>;
  /** Authoritative re-read, used ONLY after a failure. Returns the verdict. */
  reread: () => Promise<OnAccountVerdict>;
  latch?: OnAccountLatch;
}): Promise<OnAccountOutcome<T>> {
  if (input.latch && !input.latch.acquire()) {
    return { ok: false, error: new OnAccountInProgressError(), retryable: false };
  }
  try {
    let result: T;
    try {
      result = await input.submit();
    } catch (error) {
      let verdict: OnAccountVerdict;
      try {
        verdict = await input.reread();
      } catch {
        // Cannot even ask. Never guess about a receivable.
        return { ok: false, error: new OnAccountAmbiguousError(error), retryable: false };
      }
      if (verdict === "committed") return { ok: true, result: null, recovered: true };
      if (verdict === "open") return { ok: false, error, retryable: true };
      return { ok: false, error: new OnAccountAmbiguousError(error), retryable: false };
    }
    return { ok: true, result, recovered: false };
  } finally {
    input.latch?.release();
  }
}
