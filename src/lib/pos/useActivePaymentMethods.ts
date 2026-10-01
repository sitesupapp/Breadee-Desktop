// Active payment-method catalog for the NORMAL checkout dialog.
//
// REUSES the Phase B helper (`loadSplitPaymentMethods`) that the Split Bill flow
// already uses — one canonical source, no second implementation. The only reason
// normal Pay showed cash-only was that the shared PaymentDialog never consumed
// this catalog; this hook closes that gap for Takeaway / Dine-In full-bill /
// Delivery without touching Split.
//
// OFFLINE CONTRACT (preserved): when the backend is not reachable we return
// Cash-only and never call the catalog read, so an offline till can never be
// offered a stale custom method. The dynamic catalog appears only when online.

import { useEffect, useState } from "react";
import { loadSplitPaymentMethods, type SplitPaymentMethod } from "@/lib/pos/split";

const CASH_ONLY: SplitPaymentMethod[] = [{ key: "cash", label: "Cash", is_cash: true }];

/**
 * The tenant's ACTIVE payment methods for normal checkout. Cash-only until the
 * catalog loads, when offline, or on any read error — Cash is always valid and
 * the server defaults to it, so checkout is never blocked.
 */
export function useActivePaymentMethods(
  tenantId: string | null | undefined,
  online: boolean,
): SplitPaymentMethod[] {
  const [methods, setMethods] = useState<SplitPaymentMethod[]>(CASH_ONLY);

  useEffect(() => {
    let cancelled = false;
    if (!online || !tenantId) {
      setMethods(CASH_ONLY);
      return;
    }
    loadSplitPaymentMethods(tenantId)
      .then((m) => {
        if (!cancelled) setMethods(m.length ? m : CASH_ONLY);
      })
      .catch(() => {
        if (!cancelled) setMethods(CASH_ONLY);
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId, online]);

  return methods;
}
