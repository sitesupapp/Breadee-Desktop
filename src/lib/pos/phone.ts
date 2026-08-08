// Phone normalisation, ported from the server's `_phone_normalize_e164`.
//
// WHY A CLIENT COPY EXISTS AT ALL
// The server derives `pos_customers.phone_e164` itself, so this is NOT the
// security boundary and never decides what gets stored. It exists because of a
// gap the discovery found in the DATA MODEL:
//
//   `uq_pos_customer_phone` is UNIQUE on (tenant_id, phone) - the RAW string the
//   cashier typed - while `phone_e164` carries only a NON-unique index.
//
// So "03 123 456", "+961 3 123456" and "00961 3 123456" are one human being and
// three legal rows. The database will not stop the third one being created. The
// only place that duplicate can be prevented is BEFORE the write, which means
// the desktop has to be able to compare two phone numbers the way the server
// would - hence this file.
//
// It is a port, not an improvement. Every rule below mirrors the SQL exactly,
// including the cases where the SQL returns null. If the two ever disagree the
// SQL is right and this file is wrong.

/** Lebanon. The server's default `p_dial`. */
export const DEFAULT_DIAL = "961";
/** Lebanese subscriber-number lengths, the server's default `p_local_lens`. */
export const LOCAL_LENGTHS = [7, 8] as const;

/** Arabic-Indic and Eastern Arabic-Indic digits, folded to ASCII like the server does. */
const EASTERN_DIGITS = "٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹";

function foldDigits(raw: string): string {
  let out = "";
  for (const ch of raw) {
    const i = EASTERN_DIGITS.indexOf(ch);
    out += i >= 0 ? String(i % 10) : ch;
  }
  return out;
}

/**
 * The E.164 form of a phone number, or null when the input cannot be normalised.
 *
 * Null is a real answer, not a failure: the server stores null in `phone_e164`
 * for anything it cannot parse, and two unparseable numbers are NOT equivalent.
 */
export function normalizePhoneE164(
  raw: string | null | undefined,
  dial: string = DEFAULT_DIAL,
  localLengths: readonly number[] = LOCAL_LENGTHS,
  trunkZero = true,
): string | null {
  if (raw == null) return null;
  const folded = foldDigits(String(raw));
  if (folded.trim() === "") return null;

  // The server rejects anything outside this set outright - letters included.
  if (!/^[0-9()+\-. ]+$/.test(folded)) return null;

  let intl = /^\s*\+/.test(folded);
  let digits = folded.replace(/[^0-9]/g, "");
  if (digits === "") return null;

  // A leading 00 is the written form of "+".
  if (!intl && digits.startsWith("00")) {
    digits = digits.slice(2);
    intl = true;
  }

  const isLocalLength = (n: number) => localLengths.includes(n);

  if (intl) {
    // "+961961XXXXXXX" - the dial code typed twice. Collapse one copy, but only
    // when what remains is a plausible local number.
    if (digits.startsWith(dial + dial) && isLocalLength(digits.length - 2 * dial.length)) {
      digits = digits.slice(dial.length);
    }
    if (digits.startsWith(dial)) {
      let local = digits.slice(dial.length);
      // "+961 03 123456" - a trunk zero that should not survive the country code.
      if (trunkZero && local.startsWith("0") && isLocalLength(local.length - 1)) {
        local = local.slice(1);
      }
      return isLocalLength(local.length) ? `+${dial}${local}` : null;
    }
    // Some other country. The server accepts 8-15 digits and normalises no further.
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }

  let local = digits;
  if (trunkZero && local.startsWith("0")) local = local.slice(1);
  return isLocalLength(local.length) ? `+${dial}${local}` : null;
}

/**
 * Do two typed numbers denote the same subscriber?
 *
 * Only ever true via the normalised form. Two numbers that BOTH fail to
 * normalise are not equivalent - "abc" and "xyz" are not the same customer, and
 * treating unparseable input as a match would block creation on noise.
 */
export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizePhoneE164(a);
  const nb = normalizePhoneE164(b);
  if (na === null || nb === null) return false;
  return na === nb;
}

/**
 * Is this query worth offering "create a customer" for?
 *
 * Mirrors the web rule: at least four digits and nothing but phone punctuation.
 * A name-only query must never create a record - that is how a customer list
 * fills up with rows called "ahmad" that no one can ever look up by phone.
 */
export function looksLikePhone(query: string | null | undefined): boolean {
  const q = String(query ?? "").trim();
  if (q === "") return false;
  const folded = foldDigits(q);
  const digits = folded.replace(/\D/g, "");
  return digits.length >= 4 && /^[+()\-. \d]+$/.test(folded);
}

/** Digits only, for a raw `phone ilike` search that ignores punctuation. */
export function phoneDigits(raw: string | null | undefined): string {
  return foldDigits(String(raw ?? "")).replace(/\D/g, "");
}
