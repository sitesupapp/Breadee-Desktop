// Customer Receivables / On Account — the operational Customer Accounts surface.
//
// WHAT THIS FILE IS FOR (Wave 3C)
// A cashier or manager searches customers who owe money, reads their outstanding
// balance, their open receivable orders and each order's payment history, and
// COLLECTS against a balance. Every figure comes from the server and is treated
// as a PROJECTION; after a collection the client RE-READS and the server response
// wins. This module builds payloads field by field and parses the answers - it
// computes no balance, sums no currency and settles no debt of its own.
//
// THREE RPCs, ALL SHARED WITH THE WEB APP
//   READ  pos_receivables_search    - name/phone shortlist, accessible-OU scoped.
//   READ  pos_receivables_customer  - one customer's summary + orders + payments.
//   WRITE pos_receivable_collect    - book a payment against ONE receivable order.
//
// THE COLLECT CONTRACT, stated where the code lives
// `pos_receivable_collect` consumes exactly `order_id`, `amount` (in the ORDER's
// currency), `method`, and `client_op_id`. It attaches the payment to the
// COLLECTOR'S OWN open shift, gates on `pos.receivables.collect` + OU + owner-block,
// and RAISES on no-shift / overpay / already-settled / no-permission / wrong-OU /
// owner. UNLIKE the on-account completion RPCs it IS idempotent, keyed on
// `client_op_id`: the client mints exactly ONE id per collection and reuses it on
// retry, so a repeat replays the first result (`idempotent_replay: true`) rather
// than collecting a second time. A lost response is recovered by an authoritative
// RE-READ, never by minting a new id and trying blindly.
//
// ONLINE ONLY. A collection is never enqueued to the offline outbox and never
// shows local success: a payment booked against a customer who cannot then be
// re-read is exactly the ambiguity the recovery model exists to avoid. The screen
// refuses the Collect action when offline; this module writes no local record and
// imports nothing from the offline database.

import { asRecord, callPosRpc, num, str, strOrNull } from "@/lib/pos/rpc";
import type { CurrencyCode } from "@/lib/currency";
import type { PaymentMethod } from "@/lib/pos/payments";

// --- shortlist ---------------------------------------------------------------

/** One row of the receivables search. Small on purpose - the picker shows no more. */
export type ReceivableSearchRow = {
  customerId: string;
  name: string | null;
  phone: string | null;
  outstandingUsd: number;
  openOrders: number;
  oldestDate: string | null;
};

/** How many customers the search returns. A longer list is a narrower-query problem. */
export const RECEIVABLES_SEARCH_LIMIT = 20;

function toCurrency(value: unknown): CurrencyCode {
  return str(value, "USD") === "LBP" ? "LBP" : "USD";
}

function toSearchRow(raw: unknown): ReceivableSearchRow | null {
  const r = asRecord(raw);
  const customerId = strOrNull(r.customer_id);
  if (!customerId) return null;
  return {
    customerId,
    name: strOrNull(r.name),
    phone: strOrNull(r.phone),
    outstandingUsd: num(r.outstanding_usd),
    openOrders: num(r.open_orders),
    oldestDate: strOrNull(r.oldest_date),
  };
}

/**
 * Search customers with a balance by name or phone.
 *
 * The server scopes the answer to the operator's accessible OUs and does the
 * matching; this passes the typed term through and parses the array. An empty or
 * blank query returns nothing without a round trip.
 */
export async function searchReceivables(
  query: string,
  limit: number = RECEIVABLES_SEARCH_LIMIT,
): Promise<ReceivableSearchRow[]> {
  const term = query.trim();
  if (term === "") return [];
  const data = await callPosRpc("pos_receivables_search", { p_query: term, p_limit: limit });
  const rows = Array.isArray(data) ? data : [];
  return rows.map(toSearchRow).filter((r): r is ReceivableSearchRow => r !== null);
}

// --- one customer's account --------------------------------------------------

/** One payment against a receivable order. Every figure is the server's. */
export type ReceivablePayment = {
  paidAt: string | null;
  amount: number;
  currency: CurrencyCode;
  amountUsd: number;
  method: string | null;
  collector: string | null;
  shiftId: string | null;
};

/** One open receivable order, with its payment history. */
export type ReceivableOrder = {
  orderId: string;
  orderNumber: string | null;
  orderType: string;
  createdAt: string | null;
  branchId: string | null;
  currency: CurrencyCode;
  total: number;
  paid: number;
  balance: number;
  outstandingUsd: number;
  paymentStatus: string;
  lastPaymentAt: string | null;
  payments: ReceivablePayment[];
};

/** One currency's slice of the outstanding balance. NEVER summed across currencies. */
export type ReceivableByCurrency = { currency: CurrencyCode; outstanding: number };

export type ReceivableSummary = {
  totalOutstandingUsd: number;
  openOrders: number;
  oldestDate: string | null;
  lastPaymentAt: string | null;
  /** The per-currency breakdown, shown as-is - a USD total and LBP total never merge. */
  byCurrency: ReceivableByCurrency[];
};

export type ReceivableCustomer = {
  id: string;
  name: string | null;
  phone: string | null;
  branchId: string | null;
};

export type ReceivableAccount = {
  customer: ReceivableCustomer;
  summary: ReceivableSummary;
  orders: ReceivableOrder[];
};

function toPayment(raw: unknown): ReceivablePayment {
  const r = asRecord(raw);
  return {
    paidAt: strOrNull(r.paid_at),
    amount: num(r.amount),
    currency: toCurrency(r.currency),
    amountUsd: num(r.amount_usd),
    method: strOrNull(r.method),
    collector: strOrNull(r.collector),
    shiftId: strOrNull(r.shift_id),
  };
}

function toOrder(raw: unknown): ReceivableOrder | null {
  const r = asRecord(raw);
  const orderId = strOrNull(r.order_id);
  if (!orderId) return null;
  const payments = Array.isArray(r.payments) ? r.payments.map(toPayment) : [];
  return {
    orderId,
    orderNumber: strOrNull(r.order_number),
    orderType: str(r.order_type),
    createdAt: strOrNull(r.created_at),
    branchId: strOrNull(r.branch_id),
    currency: toCurrency(r.currency),
    total: num(r.total),
    paid: num(r.paid),
    balance: num(r.balance),
    outstandingUsd: num(r.outstanding_usd),
    paymentStatus: str(r.payment_status),
    lastPaymentAt: strOrNull(r.last_payment_at),
    payments,
  };
}

function toByCurrency(raw: unknown): ReceivableByCurrency | null {
  const r = asRecord(raw);
  if (r.currency === undefined || r.currency === null) return null;
  return { currency: toCurrency(r.currency), outstanding: num(r.outstanding) };
}

/**
 * Load one customer's whole receivables account: identity, summary, open orders
 * and per-order payment history. Also the authoritative RE-READ used to recover
 * a lost collection response.
 */
export async function getReceivablesCustomer(customerId: string): Promise<ReceivableAccount> {
  const row = asRecord(await callPosRpc("pos_receivables_customer", { p_customer_id: customerId }));
  const customer = asRecord(row.customer);
  const summary = asRecord(row.summary);
  const byCurrencyRaw = Array.isArray(summary.by_currency) ? summary.by_currency : [];
  const ordersRaw = Array.isArray(row.orders) ? row.orders : [];
  return {
    customer: {
      id: str(customer.id, customerId),
      name: strOrNull(customer.name),
      phone: strOrNull(customer.phone),
      branchId: strOrNull(customer.branch_id),
    },
    summary: {
      totalOutstandingUsd: num(summary.total_outstanding_usd),
      openOrders: num(summary.open_orders),
      oldestDate: strOrNull(summary.oldest_date),
      lastPaymentAt: strOrNull(summary.last_payment_at),
      byCurrency: byCurrencyRaw.map(toByCurrency).filter((c): c is ReceivableByCurrency => c !== null),
    },
    orders: ordersRaw.map(toOrder).filter((o): o is ReceivableOrder => o !== null),
  };
}

// --- errors ------------------------------------------------------------------

/** An amount that is not a usable, positive number in the order currency. */
export class InvalidCollectionAmountError extends Error {
  constructor(detail: string) {
    super(`This amount cannot be collected: ${detail}`);
    this.name = "InvalidCollectionAmountError";
  }
}

/** A collection was attempted while an earlier one is still resolving. */
export class CollectionInProgressError extends Error {
  constructor() {
    super("This collection is already being sent");
    this.name = "CollectionInProgressError";
  }
}

/** The response was lost and the re-read could not settle what happened. */
export class CollectionAmbiguousError extends Error {
  readonly cause: unknown;
  constructor(cause: unknown) {
    super(
      "Could not confirm whether the payment was collected. Do NOT try again - refresh the customer's account and check the balance before collecting.",
    );
    this.name = "CollectionAmbiguousError";
    this.cause = cause;
  }
}

/**
 * Reject a collection amount the server would refuse. It must be a real, positive
 * number: a receivable collection of zero is nothing, and the server overpay-guards
 * the ceiling. The server re-validates - this exists so a refusal is not discovered
 * after a payment has been booked.
 */
export function assertCollectionAmount(amount: number): void {
  if (!Number.isFinite(amount)) throw new InvalidCollectionAmountError("it is not a number");
  if (amount <= 0) throw new InvalidCollectionAmountError("it must be greater than zero");
}

// --- the write (field by field, never a spread) ------------------------------

/** Exactly the keys `pos_receivable_collect` consumes. Nothing else may appear. */
export type CollectPayload = {
  order_id: string;
  amount: number;
  method: PaymentMethod;
  client_op_id: string;
};

export const COLLECT_PAYLOAD_KEYS = ["order_id", "amount", "method", "client_op_id"] as const;

export function buildCollectPayload(input: {
  orderId: string;
  amount: number;
  method: PaymentMethod;
  clientOpId: string;
}): CollectPayload {
  return {
    order_id: input.orderId,
    amount: input.amount,
    method: input.method,
    client_op_id: input.clientOpId,
  };
}

/** The server's answer, whose figures win outright. */
export type CollectResult = {
  ok: boolean;
  paymentId: string | null;
  orderNumber: string;
  paymentStatus: string;
  collectedUsd: number;
  outstandingUsd: number;
  idempotentReplay: boolean;
};

/**
 * Book one collection against one receivable order. `amount` is in the ORDER's
 * currency; `clientOpId` is the SAME id across retries of one collection, so the
 * server replays rather than double-charging. Every returned figure is the
 * server's - the caller re-reads and prints what this says.
 */
export async function collectReceivable(input: {
  orderId: string;
  amount: number;
  method: PaymentMethod;
  clientOpId: string;
}): Promise<CollectResult> {
  assertCollectionAmount(input.amount);
  const payload = buildCollectPayload(input);
  const row = asRecord(await callPosRpc("pos_receivable_collect", { p_payload: payload }));
  return {
    ok: row.ok === true,
    paymentId: strOrNull(row.payment_id),
    orderNumber: str(row.order_number),
    paymentStatus: str(row.payment_status),
    collectedUsd: num(row.collected_usd),
    outstandingUsd: num(row.outstanding_usd),
    idempotentReplay: row.idempotent_replay === true,
  };
}

// --- the once-only id + latch (mirrors the on-account paths) ------------------

/**
 * A fresh client operation id for ONE collection.
 *
 * Minted once per collection and reused on every retry of that same collection -
 * the caller holds it and does NOT mint a new one until the attempt resolves,
 * because a new id is a new operation the server would not dedupe against the
 * first. `crypto.randomUUID` where present, with a plain fallback so a test or an
 * older runtime still produces a distinct value.
 */
export function newClientOpId(): string {
  const c = typeof globalThis !== "undefined" ? (globalThis.crypto as Crypto | undefined) : undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `collect-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export type CollectLatch = { acquire: () => boolean; release: () => void; held: () => boolean };

/**
 * One holder at a time, decided synchronously - the same latch shape the payment
 * and on-account paths use. `setState` is asynchronous, so two clicks in the same
 * tick both read a stale "not sending"; this stops the second REQUEST. The
 * idempotency key on `client_op_id` is what stops a second CHARGE if a request
 * still slips through, and the re-read below is what keeps a lost response from
 * becoming an unknown.
 */
export function createCollectLatch(): CollectLatch {
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
 *   committed - the order now shows the collection landed (payment recorded /
 *               balance reduced / settled). The earlier call took; this is a
 *               recovery, not a repeat.
 *   open      - nothing changed; the payment was not booked. A retry with the
 *               SAME `client_op_id` is safe (the server would replay it anyway).
 *   ambiguous - the server cannot be reached or says something unrecognised.
 *               Neither retry nor completion is permitted.
 */
export type CollectVerdict = "committed" | "open" | "ambiguous";

export type CollectOutcome =
  | { ok: true; result: CollectResult | null; recovered: boolean }
  | { ok: false; error: unknown; retryable: boolean };

/**
 * Run one collection, once.
 *
 * `submit` is called AT MOST ONCE - there is no retry loop, no timer and no
 * queue. A retry is a new operator decision made against freshly re-read state,
 * reusing the SAME `client_op_id`. The re-read is injected so the whole decision
 * tree is testable without a network and so the screen supplies the authority it
 * already holds (the customer's account).
 */
export async function performCollect(input: {
  submit: () => Promise<CollectResult>;
  /** Authoritative re-read, used ONLY after a failure. Returns the verdict. */
  reread: () => Promise<CollectVerdict>;
  latch?: CollectLatch;
}): Promise<CollectOutcome> {
  if (input.latch && !input.latch.acquire()) {
    return { ok: false, error: new CollectionInProgressError(), retryable: false };
  }
  try {
    let result: CollectResult;
    try {
      result = await input.submit();
    } catch (error) {
      let verdict: CollectVerdict;
      try {
        verdict = await input.reread();
      } catch {
        // Cannot even ask. Never guess about money.
        return { ok: false, error: new CollectionAmbiguousError(error), retryable: false };
      }
      if (verdict === "committed") return { ok: true, result: null, recovered: true };
      if (verdict === "open") return { ok: false, error, retryable: true };
      return { ok: false, error: new CollectionAmbiguousError(error), retryable: false };
    }
    return { ok: true, result, recovered: false };
  } finally {
    input.latch?.release();
  }
}
