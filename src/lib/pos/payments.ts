// Payment against the staging `pos_pay_order` contract (m216 / m68 / m113).
//
// Server rules this mirrors (and never re-implements):
//   * requires an OPEN shift on the order  (_pos_lock_open_shift, m149)
//   * requires `pos.take_payments`
//   * a discount requires `pos.apply_discounts`; percent 0-100; amount <= subtotal
//   * LBP requires a valid tenant rate, else the payment is refused
//   * the CHARGED amount is derived server-side from the order - never from the
//     client. `amount` in the response is the truth, and it is what the receipt
//     prints.
//
// Tendered / change are a cash-handling aid computed locally from the server's
// amount. They are never sent and never posted.

import { callPosRpc, asRecord, bool, num, numOrNull, requireId, str, type RpcClient } from "@/lib/pos/rpc";
import { hasValidRate, roundForCurrency, type CurrencyCode } from "@/lib/currency";
import type { PayOrderResult } from "@/types/pos";
import type { CaptureEvidence } from "@/lib/offline/captureEvidence";

/**
 * A tenant payment-method KEY from the Phase B `pos_payment_methods` catalog.
 * Widened from the former `"cash"` literal so the normal checkout dialog can
 * carry any ACTIVE catalog key — the server already honours it: the pay RPCs
 * read `p_payload->>'method'` (default `cash`) and persist it on the order and
 * the payment row. Every caller already forwards the method; only the dialog's
 * list of choices changed.
 */
export type PaymentMethod = string;

/** Offline / fallback choice set. Cash is always active and always valid. */
export const PAYMENT_METHODS: { value: PaymentMethod; label: string }[] = [{ value: "cash", label: "Cash" }];

export type PayOrderInput = {
  orderId: string;
  method: PaymentMethod;
  currency: CurrencyCode;
  /** Already converted to the order's PRIMARY currency by the caller. */
  discount?: Record<string, unknown>;
  /** 1.0.41 (F-WRITE) — the payment's stable idempotency id. The production `pos_pay_order` wrapper
   *  replays the recorded result for a repeated (tenant, client_op_id) instead of charging again, so a
   *  resend after a lost response is an outcome LOOKUP, never a second payment. Omitted → 1.0.40 payload. */
  clientOpId?: string;
  /** 1.0.41 (F-WRITE) — bound the interactive wait; past it → AmbiguousOutcomeError (never aborted, never re-charged). */
  deadlineMs?: number;
  /** 1.0.41 (S-CAPTURE) — offline replay evidence (when / at which rate). Omitted online. */
  capture?: CaptureEvidence;
};

/** 1.0.41 (F-WRITE) — how long an INTERACTIVE money call may keep the cashier waiting before its outcome
 *  is treated as unknown. Above the server's 8 s statement timeout plus pool acquisition, so a healthy but
 *  slow commit is not cut short. The request itself is NOT aborted (an abort does not stop a server-side
 *  write); its eventual answer still feeds the health store, and the same client_op_id makes a later resend
 *  return the recorded result. */
export const INTERACTIVE_MONEY_DEADLINE_MS = 20_000;

/** 1.0.41 — the outcome of a money call is unknown (no answer within the deadline, a dropped link or a
 *  5xx after the request may have reached the database). Never shown as "nothing happened". */
export class AmbiguousOutcomeError extends Error {
  readonly rpc: string;
  constructor(rpc: string, cause?: unknown) {
    super(`The result of ${rpc} is not confirmed yet.`);
    this.name = "AmbiguousOutcomeError";
    this.rpc = rpc;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/** Race a money call against a deadline WITHOUT aborting it (see INTERACTIVE_MONEY_DEADLINE_MS). */
export async function withDeadline<T>(p: Promise<T>, ms: number, rpc: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_res, rej) => {
    timer = setTimeout(() => rej(new AmbiguousOutcomeError(rpc)), ms);
  });
  // Keep a late rejection of the losing promise from becoming an unhandled rejection.
  p.catch(() => undefined);
  try {
    return await Promise.race([p, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * PURE — could this failure have happened AFTER the server applied the money call? True for our own
 * deadline, a transport failure (the request may have been delivered before the link dropped), and any
 * 5xx / gateway / pool / statement-timeout answer. False for a definitive business refusal (4xx with a
 * server message): that call did not apply.
 */
export function isAmbiguousOutcome(e: unknown): boolean {
  if (e instanceof AmbiguousOutcomeError) return true;
  if (e instanceof TypeError) return true; // "Failed to fetch" / "Load failed"
  const status = (e as { status?: unknown } | null)?.status;
  if (typeof status === "number" && status >= 500) return true;
  const msg = e instanceof Error ? e.message : String(e ?? "");
  return /failed to fetch|load failed|network ?error|timed out|timeout|AbortError|PGRST00[0-3]|statement timeout|connection pool|ERR_INTERNET/i.test(msg);
}

/**
 * Client-side pre-check for the one refusal that is worth catching before the
 * request: LBP with no usable rate. Everything else is left to the server so the
 * desktop can never be more permissive than the database.
 */
export function paymentBlockedReason(currency: CurrencyCode, rate: number | null | undefined): string | null {
  if (currency === "LBP" && !hasValidRate(rate)) {
    return "Set the USD to LBP exchange rate on the dashboard before accepting LBP payments";
  }
  return null;
}

export async function payOrder(input: PayOrderInput, client?: RpcClient): Promise<PayOrderResult> {
  const payload = {
    order_id: input.orderId,
    method: input.method,
    currency_code: input.currency,
    ...(input.discount ?? {}),
    ...(input.clientOpId ? { client_op_id: input.clientOpId } : {}),
    // 1.0.41 (S-CAPTURE) — offline replay only: when/at which rate the cash was taken (server-validated).
    ...(input.capture ? { capture: input.capture } : {}),
  };
  // 1.0.41 (F-WRITE) — an interactive caller bounds the wait (`deadlineMs`): past it the outcome is AMBIGUOUS (the
  // request is not aborted; a re-send with the same clientOpId returns the recorded result, never a second charge).
  const call = callPosRpc("pos_pay_order", { p_payload: payload }, client);
  const row = asRecord(await (input.deadlineMs && input.deadlineMs > 0 ? withDeadline(call, input.deadlineMs, "pos_pay_order") : call));
  const currency = str(row.currency_code, "USD");
  return {
    order_id: requireId(row.order_id, "pos_pay_order", "order_id"),
    paid: bool(row.paid),
    method: str(row.method, input.method),
    subtotal: num(row.subtotal),
    discount: num(row.discount),
    amount: num(row.amount),
    order_number: str(row.order_number),
    currency_code: currency === "LBP" ? "LBP" : "USD",
    original_amount: num(row.original_amount),
    exchange_rate: numOrNull(row.exchange_rate),
  };
}

/**
 * Change due for a cash tender, in the tender currency. Negative "change" means
 * the tender does not cover the bill, which the UI blocks rather than submits.
 */
export function computeChange(
  amountDue: number,
  tendered: number,
  currency: CurrencyCode,
): { change: number; short: boolean } {
  const due = roundForCurrency(amountDue, currency);
  const paid = roundForCurrency(tendered, currency);
  const change = roundForCurrency(paid - due, currency);
  return { change: Math.max(change, 0), short: paid > 0 && paid < due };
}
