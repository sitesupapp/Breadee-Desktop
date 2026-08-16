// QR encoding, and the local switch that decides whether a receipt carries one.
//
// DELIBERATELY FREE OF `@/env` AND `@/lib/supabase`. Encoding a matrix is pure,
// and keeping it that way means the preview, the printer and the tests all
// share one implementation without any of them needing a configured backend.
// Where the payload COMES from is a different question, answered by
// `paymentQr.ts`.
//
// ONE ENCODER, TWO OUTPUTS. The matrix is computed once and then both drawn on
// screen and handed to the native printer as rows of `0`/`1`. Encoding it twice
// - once for the preview, once in Rust - is how a preview comes to show a code
// that scans and a printer produces one that does not.

import qrcode from "qrcode-generator";

/**
 * A square QR, as rows of `"0"`/`"1"`.
 *
 * A string per row rather than a nested boolean array because this crosses the
 * Tauri IPC boundary: 33 short strings is a fraction of the JSON that 1,089
 * booleans would be, and it stays readable in a log.
 */
export type QrMatrix = { size: number; rows: string[] };

/**
 * Error correction level.
 *
 * M, not H. A thermal head at 203 dpi prints a module of roughly half a
 * millimetre at the sizes used here; level M recovers about 15% of the symbol,
 * which is what survives a receipt folded into a pocket. Level H would be more
 * robust and would also push the symbol wider than a 58 mm roll for a typical
 * public menu URL.
 */
export const QR_ERROR_CORRECTION = "M" as const;

/**
 * Encode a payload.
 *
 * Returns null - never a partial or placeholder code - when the payload cannot
 * be encoded. A QR that does not scan is worse than no QR, because a customer
 * will try it and then ask a cashier about it.
 */
export function encodeQr(text: string): QrMatrix | null {
  if (typeof text !== "string" || text.trim() === "") return null;
  try {
    // Type 0 asks the library for the smallest version the payload fits in.
    const qr = qrcode(0, QR_ERROR_CORRECTION);
    qr.addData(text);
    qr.make();
    const size = qr.getModuleCount();
    if (size <= 0) return null;
    const rows: string[] = [];
    for (let r = 0; r < size; r++) {
      let row = "";
      for (let c = 0; c < size; c++) row += qr.isDark(r, c) ? "1" : "0";
      rows.push(row);
    }
    return { size, rows };
  } catch {
    return null;
  }
}

/** Shape check for a matrix that has crossed a boundary. */
export function isQrMatrix(value: unknown): value is QrMatrix {
  if (!value || typeof value !== "object") return false;
  const m = value as { size?: unknown; rows?: unknown };
  if (typeof m.size !== "number" || m.size <= 0) return false;
  if (!Array.isArray(m.rows) || m.rows.length !== m.size) return false;
  return m.rows.every((r) => typeof r === "string" && r.length === m.size && /^[01]+$/.test(r));
}

// --- the local switch --------------------------------------------------------
//
// WHY THIS IS TERMINAL-LOCAL AND THE BLOCK LIST IS NOT. The block list lives in
// the shared `*_template_config` because the web app owns that schema and
// normalises it on every save - a key the web catalog does not know about is
// DROPPED the next time a manager saves receipt design in the browser. Storing
// "show the payment QR" there would mean the setting silently disappeared the
// first time somebody opened the web screen, which is worse than a switch the
// operator sets once per till. The QR's DATA is still the tenant's one public
// identifier; only this switch is local.

export const PAYMENT_QR_KEY = "breadee.desktop.receiptPaymentQr";

/** Off unless explicitly switched on, so no existing till starts printing one. */
export function readShowPaymentQr(storage?: Pick<Storage, "getItem">): boolean {
  try {
    const store = storage ?? (typeof localStorage === "undefined" ? null : localStorage);
    return store?.getItem(PAYMENT_QR_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeShowPaymentQr(on: boolean, storage?: Pick<Storage, "setItem">): void {
  try {
    const store = storage ?? (typeof localStorage === "undefined" ? null : localStorage);
    store?.setItem(PAYMENT_QR_KEY, on ? "1" : "0");
  } catch {
    /* No storage: the switch applies to this session only. */
  }
}
