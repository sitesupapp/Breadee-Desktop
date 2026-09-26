// Tenant payment-method catalog helpers — Phase B (dynamic payment methods).
//
// PURE and store-free: the catalog array is passed in (synchronized into the session
// context at login, see state/session.ts), so these are unit-testable without the store
// or a Supabase client. The PaymentDialog reads the session catalog and calls these.
//
// Rules mirrored from the server (never re-implemented):
//   * the STABLE KEY is submitted/stored; the label is display only.
//   * only ACTIVE methods are offered for a new payment.
//   * ordering is deterministic (sort_order, then label).
//   * cash is always present, so an empty/unsynced catalog falls back to cash-only and
//     offline Takeaway+Cash keeps working unchanged.
import type { PaymentMethod } from "@/lib/pos/payments";

export type PaymentMethodDef = {
  key: string;
  label: string;
  is_cash: boolean;
  is_active: boolean;
  sort_order: number;
};

export type PaymentChoice = { value: PaymentMethod; label: string };

// Cash-only fallback — Cash is a protected system method that can never be deactivated,
// so this is always a safe default when the catalog has not synced yet (fresh/offline).
const CASH_ONLY_FALLBACK: PaymentChoice[] = [{ value: "cash", label: "Cash" }];

/** Active methods as {value:key,label}, deterministically ordered. Falls back to cash-only. */
export function activePaymentChoices(methods: PaymentMethodDef[] | null | undefined): PaymentChoice[] {
  const active = (methods ?? []).filter((m) => m.is_active);
  if (active.length === 0) return CASH_ONLY_FALLBACK;
  return [...active]
    .sort((a, b) => a.sort_order - b.sort_order || a.label.localeCompare(b.label))
    .map((m) => ({ value: m.key, label: m.label }));
}

/**
 * Friendly label for a stored method key — resolves ACTIVE or INACTIVE (deactivated /
 * renamed) methods, so historical receipts and reviews stay readable after a rename or
 * deactivate. Falls back to the key itself (a readable slug like "whish"), never a UUID.
 */
export function paymentMethodLabel(
  methods: PaymentMethodDef[] | null | undefined,
  key: string | null | undefined,
): string {
  if (!key) return "";
  const found = (methods ?? []).find((m) => m.key === key);
  return found?.label ?? key;
}
