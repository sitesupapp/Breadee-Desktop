// READY POS Phase C — desktop normalizer for the End Shift dynamic payment
// breakdown. The server (pos_shift_expected / pos_end_shift, via the internal helper
// _pos_shift_payment_breakdown) is authoritative: it returns a catalog-driven
// payment_methods[] with friendly labels, the is_cash classification
// (public._pos_method_is_cash — never method === 'cash') and the three totals.
//
// This module only shapes that server data for display and provides a backward-
// compatible fallback so a shift closed BEFORE Phase C (whose report has the legacy
// gross `payments` map but no payment_methods) still renders. It performs NO money
// arithmetic the server already did and never hardcodes a method.

// One dynamic payment line. `key` is the stable method key; `label` the friendly
// catalog label (falls back to the key); `is_cash` the server classification.
export type PayMethod = { key: string; label: string; is_cash: boolean; amount: number };

// The additive breakdown block merged into the shift response / report. All keys
// optional so pre-Phase-C payloads (no payment_methods) are valid input.
export type PayBreakdown = {
  payment_methods?: PayMethod[] | null;
  cash_total?: number | null;
  non_cash_total?: number | null;
  grand_payment_total?: number | null;
};

export type PaymentSummary = {
  rows: PayMethod[];
  dynamic: boolean;
  cashTotal: number;
  nonCashTotal: number;
  grandTotal: number;
};

// Prefer the server's catalog-driven payment_methods[] (labels, is_cash, totals).
// Fall back to the legacy gross `payments` map for pre-Phase-C shifts: cash is then
// best-effort (key === 'cash') and labels are the raw uppercased keys, as before.
// Totals come from the server when present, else are summed locally. Returns empty
// rows (never throws) for a missing/empty payload.
export function paymentSummary(
  src: (PayBreakdown & { payments?: Record<string, number> | null }) | null | undefined,
): PaymentSummary {
  const methods = src && Array.isArray(src.payment_methods) ? src.payment_methods : null;
  if (methods && methods.length) {
    const rows: PayMethod[] = methods.map((m) => ({
      key: String(m.key),
      label: m.label || String(m.key),
      is_cash: !!m.is_cash,
      amount: Number(m.amount) || 0,
    }));
    const cash = rows.filter((r) => r.is_cash).reduce((a, r) => a + r.amount, 0);
    const non = rows.filter((r) => !r.is_cash).reduce((a, r) => a + r.amount, 0);
    return {
      rows,
      dynamic: true,
      cashTotal: Number(src?.cash_total ?? cash),
      nonCashTotal: Number(src?.non_cash_total ?? non),
      grandTotal: Number(src?.grand_payment_total ?? cash + non),
    };
  }
  const legacy = (src && src.payments) || {};
  const rows: PayMethod[] = Object.entries(legacy).map(([k, v]) => ({
    key: k,
    label: k.toUpperCase(),
    is_cash: k === "cash",
    amount: Number(v) || 0,
  }));
  const cash = rows.filter((r) => r.is_cash).reduce((a, r) => a + r.amount, 0);
  const non = rows.filter((r) => !r.is_cash).reduce((a, r) => a + r.amount, 0);
  return { rows, dynamic: false, cashTotal: cash, nonCashTotal: non, grandTotal: cash + non };
}
