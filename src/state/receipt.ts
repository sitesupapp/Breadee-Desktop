// Receipt presentation state.
//
// WHY THIS IS A STORE AND NOT COMPONENT STATE
//
// The receipt used to be two independent `useState` values in PosWorkspaceInner
// - `lastReceipt` (the data) and `receiptOpen` (the visibility). On staging, a
// real payment produced the correct data and cleared the cart, but the preview
// never appeared; Ctrl+P recovered it, proving the DATA survived while the OPEN
// signal did not. That split is the defect class:
//
//   * two updates can be interleaved, lost or re-ordered independently, and
//   * they lived inside a component that early-returns a loading skeleton
//     (`if (!pos.ready || session.loading) return <Skeleton/>`), so any transient
//     not-ready state can unmount the modal while leaving the data behind.
//
// The ShiftReportDialog - the one modal in this app that is store-owned - opened
// correctly on the same run. This mirrors that proven arrangement:
//
//   * `present()` sets data AND visibility in ONE atomic update, so "shown with
//     no data" and "data with nothing shown" are both unrepresentable,
//   * the store lives outside the component tree, so no remount, early return or
//     effect-ordering can drop the presentation,
//   * `hide()` deliberately keeps `receipt` so Ctrl+P can reopen the last one.

import { create } from "zustand";
import type { ReceiptData } from "@/lib/receipt";

// Phase F (GAP 1): persist every presented receipt durably so a device-created transaction can be
// reprinted offline AND after a cold restart (Ctrl+P / reopen). Best-effort, lazy-imported so this
// store stays import-safe in the pure-logic test runtime; a persistence failure never affects the
// on-screen receipt.
function persist(receipt: ReceiptData, provisional: boolean): void {
  void (async () => {
    try {
      const ref = (receipt as { orderNumber?: string }).orderNumber;
      if (!ref) return;
      const { persistReceiptSnapshot } = await import("@/lib/offline/db");
      let tenantId: string | null = null;
      try {
        const { useSession } = await import("@/state/session");
        tenantId = useSession.getState().tenant?.id ?? null;
      } catch {
        /* scope is best-effort */
      }
      await persistReceiptSnapshot({ ref, data: receipt, tenantId, provisional });
    } catch {
      /* durability is best-effort; never break presenting a receipt */
    }
  })();
}

type ReceiptState = {
  /** The most recent completed receipt. Survives hide() and cart reset. */
  receipt: ReceiptData | null;
  /** Whether the preview is on screen. Only ever true alongside a receipt. */
  visible: boolean;

  /** Store the authoritative receipt and show it - one atomic transition. */
  present: (receipt: ReceiptData) => void;
  /**
   * Hold the receipt WITHOUT raising the preview (1.0.4).
   *
   * Auto Print ON is now silent: the cashier gets paper and stays on the POS.
   * The data still has to be here, because Ctrl+P must be able to reopen the
   * last receipt and a print that fails must leave something to retry from - so
   * the receipt is always stored, and only its visibility depends on whether
   * paper is coming.
   */
  stage: (receipt: ReceiptData) => void;
  /** Re-show the last receipt (Ctrl+P). No-op when there is nothing to show. */
  reopen: () => void;
  /** Close the preview but KEEP the data. */
  hide: () => void;
  /** Drop everything - used on sign-out, never during a normal sale. */
  clear: () => void;
  /**
   * Phase F (GAP 1): after a cold restart the in-memory receipt is gone, but a durable snapshot of
   * the last presented receipt survives in Dexie. Load it (staged, NOT shown) so Ctrl+P can reprint
   * the last device-created transaction offline. No-op when there is already a receipt in memory or
   * none persisted. Best-effort.
   */
  restoreLatest: (tenantId?: string | null) => Promise<void>;
};

export const useReceipt = create<ReceiptState>((set, get) => ({
  receipt: null,
  visible: false,

  present: (receipt) => {
    set({ receipt, visible: true });
    persist(receipt, false);
  },

  stage: (receipt) => {
    set({ receipt, visible: false });
    persist(receipt, false);
  },

  reopen: () => {
    if (!get().receipt) return;
    set({ visible: true });
  },

  hide: () => set({ visible: false }),

  clear: () => {
    set({ receipt: null, visible: false });
    void (async () => {
      try {
        const { clearReceiptSnapshots } = await import("@/lib/offline/db");
        await clearReceiptSnapshots();
      } catch {
        /* sign-out cleanup is best-effort */
      }
    })();
  },

  restoreLatest: async (tenantId) => {
    if (get().receipt) return; // a live receipt already present — don't overwrite it
    try {
      const { readLatestReceiptSnapshot } = await import("@/lib/offline/db");
      const snap = await readLatestReceiptSnapshot(tenantId ?? null);
      if (snap && snap.data && !get().receipt) set({ receipt: snap.data as ReceiptData, visible: false });
    } catch {
      /* best-effort restore */
    }
  },
}));

/**
 * The render predicate, exported so the invariant is asserted in one place:
 * the preview shows only when it is visible AND has data.
 */
export function shouldShowReceipt(state: Pick<ReceiptState, "receipt" | "visible">): boolean {
  return state.visible && state.receipt !== null;
}
