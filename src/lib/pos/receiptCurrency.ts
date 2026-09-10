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
import { isLegacyDualCurrency, type OperationalCurrencyCode } from "@/lib/currency";

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

// A valid precision must actually BE a whole number in range. Crucially it must be a real
// `number` — `Number(null)` is 0 and `Number("")` is 0, so coercing first would let a
// MISSING server precision masquerade as a valid 0 and defeat the third-currency fail-close.
function validDigits(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_SUPPORTED_DIGITS;
}

/**
 * Resolve the receipt currency + precision from the server's receipt-financial DTO.
 *
 * `operational` is the ORDER/tenant operational currency (5E-1A-D). It is consulted ONLY
 * when the server metadata is absent, to decide the fallback:
 *
 *  - No server metadata (`meta == null`, i.e. the read was unavailable or returned no
 *    order) AND `operational` is USD/LBP: fall back to it at 2dp. Justified ONLY for
 *    USD/LBP — their precision is intrinsic (the formatter renders them by code, ignoring
 *    the digit count) and the client currency IS the order currency for a USD/LBP tenant.
 *  - No server metadata AND `operational` is a THIRD currency (AED/JOD/…): there is NO
 *    client-side fallback. The receipt is REFUSED (fail closed) — never rendered as USD,
 *    never at a guessed 2dp. A third-currency receipt's currency + precision must come
 *    from the server (`finance_order_financials`).
 *  - A malformed server currency (not a 3-letter code) is REFUSED — never coerced to USD.
 *  - USD/LBP from the server: use the server digits when valid, else 2 (unused — the
 *    formatter renders USD/LBP by code).
 *  - A third currency from the server: the precision MUST be a valid, in-range server
 *    value; a missing / non-integer / out-of-range `decimal_digits` is REFUSED (fail
 *    closed). It is never defaulted to 2.
 */
export function resolveReceiptCurrency(
  meta: { currency: unknown; decimal_digits: unknown } | null | undefined,
  operational: OperationalCurrencyCode,
): ReceiptCurrency {
  if (meta == null) {
    if (isLegacyDualCurrency(operational)) {
      return { currency: operational, decimalDigits: 2 };
    }
    throw new ReceiptCurrencyError(
      `Refusing ${operational} receipt: the server supplied no historical currency/precision, ` +
        `and a third operational currency has no client-side fallback — it must not be printed as USD.`,
    );
  }
  const currency = String(meta.currency ?? "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new ReceiptCurrencyError(
      `Refusing receipt: the server returned no valid currency (${JSON.stringify(meta.currency)}).`,
    );
  }
  const rawDigits = meta.decimal_digits;

  if (currency === "USD" || currency === "LBP") {
    // The formatter renders USD/LBP by code and ignores this count, so 2 is a harmless
    // fallback when the server value is absent — it never reaches the output.
    return { currency, decimalDigits: validDigits(rawDigits) ? rawDigits : 2 };
  }

  if (!validDigits(rawDigits)) {
    throw new ReceiptCurrencyError(
      `Refusing ${currency} receipt: the server supplied no valid decimal_digits ` +
        `(${JSON.stringify(rawDigits)}); a third currency's precision must not be guessed.`,
    );
  }
  return { currency, decimalDigits: rawDigits };
}

/**
 * Fetch the order's historical currency + precision from `finance_order_financials`.
 *
 * `operational` is the ORDER/tenant operational currency. On any no-metadata path — a
 * transport failure, an order the reader cannot see, or a null/empty `orderId` (e.g. a
 * recovered table payment with no order in the snapshot) — resolution falls back to it ONLY
 * when it is USD/LBP; a THIRD operational currency has no client-side fallback and throws
 * `ReceiptCurrencyError` (fail closed, never USD). A third-currency order whose SERVER
 * precision is missing/invalid likewise throws. The caller surfaces the throw as a refusal.
 */
export async function fetchReceiptCurrency(
  orderId: string | null | undefined,
  operational: OperationalCurrencyCode,
): Promise<ReceiptCurrency> {
  if (!orderId) return resolveReceiptCurrency(null, operational);
  let data: unknown;
  try {
    data = await callPosRpc("finance_order_financials", { p_order: orderId });
  } catch {
    // Transport/authorization failure: USD/LBP fall back to themselves; a third currency
    // fails closed rather than printing the wrong currency.
    return resolveReceiptCurrency(null, operational);
  }
  const rec = asRecord(data);
  if (!("currency" in rec)) return resolveReceiptCurrency(null, operational);
  // resolveReceiptCurrency refuses when a currency IS present and is a third currency
  // without valid precision — that throw is intentional and propagates.
  return resolveReceiptCurrency({ currency: rec.currency, decimal_digits: rec.decimal_digits }, operational);
}
