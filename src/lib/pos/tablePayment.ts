// Dine-In settlement (Level 2D): paying a table bill.
//
// THE PROBLEM THIS FILE EXISTS TO SOLVE
// `pos_pay_table` has NO idempotency key. `pos_submit_order` has `client_op_id`
// (m224) and can therefore replay a lost round safely; payment cannot. So the
// question "did my payment go through?" has no answer in the request itself.
//
// The server is nonetheless safe against double-charging, by STATE rather than
// by key: the first successful call marks every open order `paid`/`completed`
// and frees the table, so a second call finds no open unpaid order and raises
// "No open order on this table to pay". Nobody gets charged twice.
//
// That refusal is therefore not a failure - it is EVIDENCE. Combined with an
// authoritative re-read showing the table free and no unpaid bill, it means the
// earlier payment succeeded and the response was simply lost. `recoverPayment`
// below encodes exactly that reasoning, and it is the reason a blind retry is
// never permitted: a retry is only safe once the server has confirmed the bill
// is still unpaid.
//
// What is deliberately NOT sent (Phase 1 confirmed the RPC reads none of it):
// shift_id, branch_id, order_id, order_number, client_op_id, tendered, change,
// batch_no. The shift comes from the ORDERS server-side, via
// `_pos_lock_open_shift`. Tendered and change are cash-handling aids that exist
// only on screen and on the receipt - `pos_payments` has no column for them.
//
// The server also allocates a bill-level discount across the table's orders
// itself (proportionally, remainder on the last). The client sends one
// type/value and never prorates.

import { callPosRpc, asRecord, bool, num, numOrNull, str } from "@/lib/pos/rpc";
import { hasValidRate, type CurrencyCode } from "@/lib/currency";
import { computeDiscount, type DiscountType } from "@/lib/pos/discounts";
import type { TableBill, TableSummary } from "@/types/tables";
import type { Gate } from "@/components/ui";
import type { PaymentMethod } from "@/lib/pos/payments";

/** Exactly the keys `pos_pay_table` consumes. Nothing else may appear. */
export type TablePaymentPayload = {
  table_id: string;
  method: PaymentMethod;
  currency_code: CurrencyCode;
  discount_type?: "percent" | "amount";
  discount_value?: number;
};

/** The authoritative result. `pos_pay_table` returns no order_number. */
export type TablePaymentResult = {
  ok: boolean;
  orders: number;
  subtotal: number;
  discount: number;
  amount: number;
  currency_code: CurrencyCode;
  original_amount: number;
  exchange_rate: number | null;
};

export class PaymentInProgressError extends Error {
  constructor() {
    super("This payment is already being sent");
    this.name = "PaymentInProgressError";
  }
}

export class StaleBillError extends Error {
  readonly detail: string;
  constructor(detail: string) {
    super(`The bill changed before payment: ${detail}`);
    this.name = "StaleBillError";
    this.detail = detail;
  }
}

export class TenderTooLowError extends Error {
  constructor() {
    super("The tendered amount is less than the amount due");
    this.name = "TenderTooLowError";
  }
}

/**
 * The state nobody may act on.
 *
 * Raised when the submit failed AND the recovery re-read could not prove whether
 * the server committed. The wording is matched by `errors.ts` and is deliberately
 * an instruction, not a description: the only safe next move is to look at the
 * authoritative state, never to charge again.
 */
export class PaymentAmbiguousError extends Error {
  readonly cause: unknown;
  constructor(cause: unknown) {
    super(
      "Could not confirm whether the payment went through. Do NOT take payment again until the table's state has been checked.",
    );
    this.name = "PaymentAmbiguousError";
    this.cause = cause;
  }
}

/** A discount was asked for without `pos.apply_discounts`. */
export class DiscountNotPermittedError extends Error {
  constructor(reason: string | null) {
    super(reason ?? "You do not have permission to apply discounts.");
    this.name = "DiscountNotPermittedError";
  }
}

/** A discount value the shared validator rejects (percent > 100, amount > subtotal, negative). */
export class InvalidDiscountError extends Error {
  constructor(detail: string) {
    super(`This discount cannot be applied: ${detail}`);
    this.name = "InvalidDiscountError";
  }
}

// --- the in-flight latch (P0) ------------------------------------------------

/**
 * A synchronous one-holder latch, shared by every path that can submit a payment.
 *
 * It is a plain closure rather than React state on purpose: `setState` is
 * asynchronous, so two clicks in the same tick both read `false` and both submit.
 * `acquire()` decides in the calling tick, which is the only place the decision
 * can be made in time. The server remains the authority - this prevents the
 * second REQUEST, not the second charge.
 */
export type PaymentLatch = { acquire: () => boolean; release: () => void; held: () => boolean };

export function createPaymentLatch(): PaymentLatch {
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

// --- gate --------------------------------------------------------------------

/**
 * THE payment gate. There is exactly one, and every Pay surface - the bill
 * panel's button, the bottom bar's PAY slot, F4 and the dialog's own confirm -
 * renders from this single result.
 *
 * That is the whole point: Level 2A's bottom bar carried its own `payDisabled`
 * literal, and a second opinion about whether payment is allowed is a second
 * chance to be wrong. Nothing downstream may recompute "can pay" from parts.
 *
 * Note what is NOT here: `pos.apply_discounts`. A cashier without it may still
 * settle a bill at full price - discount permission is checked only when a
 * discount is actually asked for (see `validateTableDiscount`).
 */
export function payTableGate(input: {
  takePayments: Gate;
  table: TableSummary | null;
  bill: TableBill | null;
  hasOpenShift: boolean;
  online: boolean;
  settling: boolean;
  /** The branch the workspace is scoped to. Every order on the bill must match. */
  branchId?: string | null;
}): Gate {
  if (!input.takePayments.allowed) return input.takePayments;
  if (!input.table) return { allowed: false, reason: "Select a table first." };
  if (!input.online) return { allowed: false, reason: "Taking payment needs a connection." };
  if (!input.hasOpenShift) return { allowed: false, reason: "Open a shift before taking payment." };
  if (!input.bill || input.bill.orders.length === 0) {
    return { allowed: false, reason: "This table has no open bill to settle." };
  }
  // The bill on screen must belong to the table on screen. A selection that
  // moved while a bill was in flight would otherwise settle the wrong table.
  if (input.bill.tableId !== input.table.id) {
    return { allowed: false, reason: "The bill on screen is not this table's. Refresh the table map." };
  }
  if (input.bill.orders.some((o) => o.payment_status === "paid")) {
    return { allowed: false, reason: "This bill is already settled. Refresh the table map." };
  }
  if (input.bill.mixedCurrency) {
    return { allowed: false, reason: "These orders were created under different currency settings; settle or clear each order separately." };
  }
  if (input.bill.splitShift) {
    return { allowed: false, reason: "These table orders span multiple shifts or branches; settle them separately." };
  }
  // Branch is checked LAST of the state rules but before the latch: a bill from
  // another branch is a context defect, not a transient one, and saying so is
  // more useful than "payment in progress".
  if (input.branchId != null && input.bill.orders.some((o) => o.branch_id !== null && o.branch_id !== input.branchId)) {
    return { allowed: false, reason: "This bill belongs to another branch. Switch branch before settling it." };
  }
  if (input.settling) return { allowed: false, reason: "This payment is already being sent." };
  return { allowed: true, reason: null };
}

// --- discounts ---------------------------------------------------------------

/**
 * Validate a requested bill discount and turn it into payload fields.
 *
 * The arithmetic is the SHARED validator (`lib/pos/discounts.ts`), which is the
 * ported copy of the server's own rules - so the figure the cashier is shown is
 * the figure the server will charge. The server still re-validates; this exists
 * so a refusal is not discovered after the customer has handed over cash.
 *
 * The server ALLOCATES the discount across the table's orders itself
 * (proportionally, remainder on the last). One type and one value are sent; the
 * client never prorates, and never sends a per-order breakdown.
 */
export function validateTableDiscount(input: {
  canDiscount: Gate;
  subtotal: number;
  type: DiscountType;
  value: string;
}): { fields: Pick<TablePaymentPayload, "discount_type" | "discount_value">; amount: number } {
  if (input.type === "none") return { fields: {}, amount: 0 };
  if (!input.canDiscount.allowed) throw new DiscountNotPermittedError(input.canDiscount.reason);
  const r = computeDiscount(input.subtotal, input.type, input.value);
  if (!r.valid) throw new InvalidDiscountError(r.error ?? "the value is not usable");
  // A permitted, valid, but ZERO discount sends nothing: an undiscounted payment
  // and a "0%" payment must produce byte-identical payloads.
  if (r.amount <= 0) return { fields: {}, amount: 0 };
  return { fields: { discount_type: input.type, discount_value: Number(input.value) }, amount: r.amount };
}

/** The one refusal worth catching before the request, mirroring Level 1. */
export function paymentCurrencyBlock(currency: CurrencyCode, rate: number | null | undefined): string | null {
  if (currency === "LBP" && !hasValidRate(rate)) {
    return "Set the USD to LBP exchange rate on the dashboard before accepting LBP payments";
  }
  return null;
}

// --- stale-bill protection ---------------------------------------------------

/**
 * Compare the bill the operator is looking at with a freshly-read one. Any
 * difference stops the payment: an amount on screen is not authority to charge.
 */
export function billChangedSincePreview(
  shown: TableBill | null,
  fresh: TableBill | null,
  table: TableSummary | null,
): string | null {
  if (!shown) return "the bill was not loaded";
  if (!fresh || fresh.orders.length === 0) return "the bill is gone - it may already have been settled or cleared";
  if (!table) return "the table selection was lost";
  if (fresh.tableId !== shown.tableId) return "the selected table changed";
  if (fresh.total !== shown.total) {
    return `the total changed from ${shown.total ?? "?"} to ${fresh.total ?? "?"}`;
  }
  if (fresh.currency !== shown.currency) return "the bill currency changed";
  if (fresh.mixedCurrency) return "the bill now spans more than one currency";
  if (fresh.splitShift) return "the bill now spans more than one shift";
  const shownOrders = shown.orders.map((o) => o.id).sort().join(",");
  const freshOrders = fresh.orders.map((o) => o.id).sort().join(",");
  if (shownOrders !== freshOrders) return "the orders on this table changed";
  // A bill whose shift moved is a bill that would be attributed to a different
  // till than the one the cashier is standing at.
  const shownShifts = shown.orders.map((o) => o.shift_id ?? "-").sort().join(",");
  const freshShifts = fresh.orders.map((o) => o.shift_id ?? "-").sort().join(",");
  if (shownShifts !== freshShifts) return "the shift this bill belongs to changed";
  if (fresh.orders.some((o) => o.payment_status === "paid")) return "the bill has already been settled";
  return null;
}

// --- payload -----------------------------------------------------------------

/**
 * Build the payload, key by key.
 *
 * Deliberately NOT a spread of whatever the caller collected. The dialog hands
 * back `tendered` alongside the discount, and a spread is how a cash-drawer aid
 * ends up posted to a financial RPC. Each field is named here, so adding one is
 * an edit to this function - which the exact-payload test guards.
 */
export function buildTablePaymentPayload(input: {
  tableId: string;
  method: PaymentMethod;
  currency: CurrencyCode;
  /** Only ever the two discount fields, from `validateTableDiscount`. */
  discount?: Pick<TablePaymentPayload, "discount_type" | "discount_value">;
}): TablePaymentPayload {
  const payload: TablePaymentPayload = {
    table_id: input.tableId,
    method: input.method,
    currency_code: input.currency,
  };
  if (input.discount?.discount_type !== undefined) payload.discount_type = input.discount.discount_type;
  if (input.discount?.discount_value !== undefined) payload.discount_value = input.discount.discount_value;
  return payload;
}

/** Keys `pos_pay_table` reads. Exported so the contract test cannot drift from the builder. */
export const TABLE_PAYMENT_PAYLOAD_KEYS = [
  "table_id",
  "method",
  "currency_code",
  "discount_type",
  "discount_value",
] as const;

/**
 * Fields that must NEVER reach `pos_pay_table`.
 *
 * `shift_id` / `branch_id` come from the ORDERS server-side; `order_id` and
 * `order_number` would contradict the table-level contract; `client_op_id` does
 * not exist on this RPC and inventing one would imply an idempotency guarantee
 * the server does not give; `tendered` / `change` / `batch_no` have no column.
 */
export const FORBIDDEN_PAYMENT_FIELDS = [
  "shift_id",
  "branch_id",
  "order_id",
  "order_number",
  "client_op_id",
  "tendered",
  "change",
  "batch_no",
] as const;

export async function payTable(payload: TablePaymentPayload): Promise<TablePaymentResult> {
  const row = asRecord(await callPosRpc("pos_pay_table", { p_payload: payload }));
  const ccy = str(row.currency_code, "USD");
  return {
    ok: bool(row.ok),
    orders: num(row.orders),
    subtotal: num(row.subtotal),
    discount: num(row.discount),
    amount: num(row.amount),
    currency_code: ccy === "LBP" ? "LBP" : "USD",
    original_amount: num(row.original_amount),
    exchange_rate: numOrNull(row.exchange_rate),
  };
}

// --- the recovery model (P0) -------------------------------------------------

/** The server's wording when there is nothing left to pay. */
export const NO_OPEN_ORDER = /no open order on this table to pay/i;

export function isNoOpenOrderRefusal(error: unknown): boolean {
  return NO_OPEN_ORDER.test(error instanceof Error ? error.message : String(error ?? ""));
}

/**
 * What an authoritative re-read says about a payment whose response we lost.
 *
 *   settled   - the bill is gone and the table is free. The earlier call worked.
 *   unpaid    - the bill is still open. Nothing was charged; a retry is SAFE.
 *   ambiguous - the server cannot be reached, or says something we do not
 *               recognise. Neither retry nor completion is permitted, because
 *               guessing either way risks a double charge or a lost sale.
 */
export type RecoveryVerdict = "settled" | "unpaid" | "ambiguous";

export function classifyRecovery(input: {
  reReadSucceeded: boolean;
  billAfter: TableBill | null;
  tableAfter: TableSummary | null;
}): RecoveryVerdict {
  if (!input.reReadSucceeded) return "ambiguous";
  const noBill = !input.billAfter || input.billAfter.orders.length === 0;
  const tableFree = !input.tableAfter || input.tableAfter.orders === 0;
  if (noBill && tableFree) return "settled";
  if (!noBill) return "unpaid";
  return "ambiguous";
}

/**
 * The order of operations around a table payment, stated once so it is testable.
 *
 * The re-read sits BEFORE submit deliberately: it is the last moment the amount
 * on screen can be proven to be the amount the server will charge.
 */
export const PAYMENT_SEQUENCE = ["re-read", "submit", "complete", "refresh"] as const;

export type PaymentOutcome =
  | { ok: true; result: TablePaymentResult; recovered: false; steps: string[] }
  | { ok: true; result: null; recovered: true; steps: string[] }
  | { ok: false; error: unknown; retryable: boolean; steps: string[] };

/**
 * Whether an outcome may be offered to the operator as "try again".
 *
 * Exported so no caller has to re-derive it: `retryable` is false for BOTH a
 * stale bill (review first) and an ambiguous response (check the server first),
 * and conflating those with "failed, press Pay again" is the mistake this whole
 * module exists to prevent.
 */
export function isSafeToRetry(outcome: PaymentOutcome): boolean {
  return outcome.ok === false && outcome.retryable;
}

/**
 * Run one table payment with stale-bill protection and lost-response recovery.
 *
 * Effects are injected so the whole decision tree is testable without a network.
 * `submit` is called AT MOST ONCE - there is no retry inside this function, by
 * design. A retry is a new operator decision made against fresh state, never an
 * automatic reaction to a timeout.
 */
export async function performTablePayment(input: {
  shownBill: TableBill | null;
  table: TableSummary | null;
  payload: TablePaymentPayload;
  reReadBill: () => Promise<{ bill: TableBill | null; table: TableSummary | null }>;
  submit: (payload: TablePaymentPayload) => Promise<TablePaymentResult>;
  /** Authoritative read used only when the response was lost. */
  recoverRead: () => Promise<{ bill: TableBill | null; table: TableSummary | null }>;
  /**
   * The locked completion sequence (2D-09), applied by the caller. Awaited, so
   * the receipt and the cash box are settled before the outcome is reported -
   * and so it can never overlap the refresh that follows it.
   */
  complete: (result: TablePaymentResult | null) => void | Promise<void>;
  refresh: () => Promise<void>;
  /**
   * The shared in-flight latch. Acquired synchronously BEFORE the re-read, so a
   * second click that lands during the round trip is refused rather than queued.
   */
  latch?: PaymentLatch;
}): Promise<PaymentOutcome> {
  const steps: string[] = [];

  // 0. Latch. Every submit path funnels through here, so this is the single
  //    place a duplicate can be stopped before it becomes a request.
  if (input.latch && !input.latch.acquire()) {
    return { ok: false, error: new PaymentInProgressError(), retryable: false, steps };
  }

  try {
    // 1. Re-read. Never charge against a total that was only ever on screen.
    let fresh: { bill: TableBill | null; table: TableSummary | null };
    try {
      fresh = await input.reReadBill();
      steps.push("re-read");
    } catch (error) {
      return { ok: false, error, retryable: true, steps };
    }
    const changed = billChangedSincePreview(input.shownBill, fresh.bill, fresh.table);
    if (changed) {
      return { ok: false, error: new StaleBillError(changed), retryable: false, steps };
    }

    // 2. Submit. Exactly once.
    let result: TablePaymentResult;
    try {
      result = await input.submit(input.payload);
      steps.push("submit");
    } catch (error) {
      // The response may have been lost AFTER the server committed. Ask the
      // server what actually happened rather than assuming either way.
      let verdict: RecoveryVerdict = "ambiguous";
      try {
        const after = await input.recoverRead();
        steps.push("recover-read");
        verdict = classifyRecovery({ reReadSucceeded: true, billAfter: after.bill, tableAfter: after.table });
      } catch {
        verdict = "ambiguous";
      }

      // "No open order to pay" plus a settled re-read is proof the earlier call
      // landed. Anything less is not proof, and is not treated as one.
      if (verdict === "settled") {
        await input.complete(null);
        steps.push("complete");
        await input.refresh();
        steps.push("refresh");
        return { ok: true, result: null, recovered: true, steps };
      }
      if (verdict === "unpaid" && !isNoOpenOrderRefusal(error)) {
        return { ok: false, error, retryable: true, steps };
      }
      // Not settled, not provably unpaid. Nothing may be inferred, and the
      // operator is told so in those words rather than being offered a retry.
      return { ok: false, error: new PaymentAmbiguousError(error), retryable: false, steps };
    }

    // 3. Complete once, then let the server tell us the new state.
    await input.complete(result);
    steps.push("complete");
    await input.refresh();
    steps.push("refresh");
    return { ok: true, result, recovered: false, steps };
  } finally {
    input.latch?.release();
  }
}
