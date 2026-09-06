// The order's OWN currency + display precision for a receipt (i18n Slice 6B-2).
//
// The historical order snapshot is authoritative. Currency and decimal_digits come
// from `finance_order_financials` (whose precision is `finance_currencies`, the sole
// catalog) — NOT from today's tenant currency, `finance_base_currency`, the current FX
// rate, or any local digit inference. A third currency whose precision the server does
// not supply is REFUSED, never silently printed at 2 decimals.
//
// Layering: `resolveReceiptCurrency` is pure and exhaustively tested; `fetchReceiptCurrency`
// is the thin async boundary that calls the server and hands the DTO to the resolver.

import { asRecord, callPosRpc } from "@/lib/pos/rpc";
import type { CurrencyCode } from "@/lib/currency";

export type ReceiptCurrency = { currency: string; decimalDigits: number };

/**
 * A third-currency receipt could not be built because the server gave no valid
 * precision. Callers surface this as a refusal (an error toast, no receipt) rather
 * than guessing a precision and printing a wrong amount.
 */
export class ReceiptCurrencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceiptCurrencyError";
  }
}

// ISO-4217 minor units never exceed 4; the catalog in use tops out at 3 (JOD/KWD).
const MAX_SUPPORTED_DIGITS = 4;

function digitsInRange(d: number): boolean {
  return Number.isInteger(d) && d >= 0 && d <= MAX_SUPPORTED_DIGITS;
}

/**
 * Resolve the receipt currency + precision from the server's receipt-financial DTO.
 *
 *  - No server metadata (`meta == null`, i.e. the read was unavailable or returned no
 *    order): fall back to the client's USD/LBP currency. Justified ONLY for USD/LBP —
 *    their precision is intrinsic (and the formatter renders them by code, ignoring the
 *    digit count) and the client currency IS the order currency for a USD/LBP tenant. A
 *    third-currency tenant cannot reach this path in Phase 1 (its client currency is
 *    still USD/LBP-typed), and its activation must supply the server metadata.
 *  - A malformed server currency (not a 3-letter code) is REFUSED — never coerced to USD.
 *  - USD/LBP from the server: use the server digits when valid, else 2 (unused — the
 *    formatter renders USD/LBP by code).
 *  - A third currency from the server: the precision MUST be a valid, in-range server
 *    value; a missing / non-integer / out-of-range `decimal_digits` is REFUSED (fail
 *    closed). It is never defaulted to 2.
 */
export function resolveReceiptCurrency(
  meta: { currency: unknown; decimal_digits: unknown } | null | undefined,
  fallback: CurrencyCode,
): ReceiptCurrency {
  if (meta == null) {
    return { currency: fallback, decimalDigits: 2 };
  }
  const currency = String(meta.currency ?? "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new ReceiptCurrencyError(
      `Refusing receipt: the server returned no valid currency (${JSON.stringify(meta.currency)}).`,
    );
  }
  const digits = Number(meta.decimal_digits);
  const validDigits = digitsInRange(digits);

  if (currency === "USD" || currency === "LBP") {
    // The formatter renders USD/LBP by code and ignores this count, so 2 is a harmless
    // fallback when the server value is absent — it never reaches the output.
    return { currency, decimalDigits: validDigits ? digits : 2 };
  }

  if (!validDigits) {
    throw new ReceiptCurrencyError(
      `Refusing ${currency} receipt: the server supplied no valid decimal_digits ` +
        `(${JSON.stringify(meta.decimal_digits)}); a third currency's precision must not be guessed.`,
    );
  }
  return { currency, decimalDigits: digits };
}

/**
 * Fetch the order's historical currency + precision from `finance_order_financials`.
 *
 * A transport failure (or an order the reader cannot see) falls back to the USD/LBP
 * client currency — the documented compatibility path. A third-currency order whose
 * server precision is missing/invalid throws `ReceiptCurrencyError`, which the caller
 * surfaces as a refusal. `orderId` may be null/empty (e.g. a recovered table payment
 * with no order in the snapshot), which is treated the same as "no metadata".
 */
export async function fetchReceiptCurrency(
  orderId: string | null | undefined,
  fallback: CurrencyCode,
): Promise<ReceiptCurrency> {
  if (!orderId) return resolveReceiptCurrency(null, fallback);
  let data: unknown;
  try {
    data = await callPosRpc("finance_order_financials", { p_order: orderId });
  } catch {
    // Transport/authorization failure: fall back to USD/LBP. (A third-currency tenant
    // is not reachable in Phase 1; its activation would surface this as its own gate.)
    return resolveReceiptCurrency(null, fallback);
  }
  const rec = asRecord(data);
  if (!("currency" in rec)) return resolveReceiptCurrency(null, fallback);
  // resolveReceiptCurrency decides refusal only when a currency IS present and is a
  // third currency without valid precision — that throw is intentional and propagates.
  return resolveReceiptCurrency({ currency: rec.currency, decimal_digits: rec.decimal_digits }, fallback);
}
