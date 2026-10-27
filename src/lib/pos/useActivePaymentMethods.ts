// Active payment-method catalog for the NORMAL checkout dialog.
//
// REUSES the Phase B helper (`loadSplitPaymentMethods`) that the Split Bill flow
// already uses — one canonical source, no second implementation. The only reason
// normal Pay showed cash-only was that the shared PaymentDialog never consumed
// this catalog; this hook closes that gap for Takeaway / Dine-In full-bill /
// Delivery without touching Split.
//
// OFFLINE CONTRACT (Phase D): online we load the catalog AND mirror it to the local cache; offline
// we read that cache and offer the local-recording (Breadee-records-the-tender) subset — so a till
// can still take the tenant's real tenders offline instead of Cash-only, without ever being offered
// an external-authorization method (network-required) or silently substituting Cash. Falls back to
// Cash-only when there is no cache.

import { useEffect, useState } from "react";
import { loadActivePaymentMethodsStrict, type SplitPaymentMethod } from "@/lib/pos/split";
import { cachePaymentMethods, readCachedPaymentMethods } from "@/lib/offline/db";
import { offlineCapableMethods } from "@/lib/offline/paymentMethodClass";

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
    if (!tenantId) {
      setMethods(CASH_ONLY);
      return;
    }
    // Offline-first recovery: the cached catalog's offline-capable subset when offline, and as the
    // fallback when a live read fails (a failed read never caches Cash-only over the real catalog).
    const fromCache = () =>
      readCachedPaymentMethods(tenantId)
        .then((c) => {
          if (cancelled) return;
          const usable = offlineCapableMethods((c?.methods ?? []) as SplitPaymentMethod[]);
          setMethods(usable.length ? usable : CASH_ONLY);
        })
        .catch(() => {
          if (!cancelled) setMethods(CASH_ONLY);
        });
    if (!online) {
      void fromCache();
      return () => {
        cancelled = true;
      };
    }
    loadActivePaymentMethodsStrict(tenantId)
      .then((m) => {
        if (!cancelled) setMethods(m.length ? m : CASH_ONLY);
        // Mirror the live catalog so the next offline till has the real tenders.
        void cachePaymentMethods(tenantId, m).catch(() => {});
      })
      .catch(() => {
        if (!cancelled) void fromCache();
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId, online]);

  return methods;
}
