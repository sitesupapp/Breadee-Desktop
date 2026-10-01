// Customer identity for display.
//
// One rule, applied everywhere a customer is shown: prefer the NAME, then the
// PHONE, then a caller-supplied generic fallback. A customer with a real name
// therefore NEVER shows the generic label, and a phone-only customer shows the
// phone instead of an unhelpful "Unnamed"/"Customer" placeholder.
//
// Each call site passes its OWN fallback literal, so every surface keeps its
// existing wording ("Unnamed customer", "Customer", "New customer", "—", …);
// this helper only fixes the precedence (name -> phone -> fallback), never the
// wording. Whitespace-only values are treated as empty.

export function customerDisplayName(
  name: string | null | undefined,
  phone: string | null | undefined,
  fallback: string,
): string {
  const n = name?.trim();
  if (n) return n;
  const p = phone?.trim();
  if (p) return p;
  return fallback;
}
