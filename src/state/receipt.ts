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

type ReceiptState = {
  /** The most recent completed receipt. Survives hide() and cart reset. */
  receipt: ReceiptData | null;
  /** Whether the preview is on screen. Only ever true alongside a receipt. */
  visible: boolean;

  /** Store the authoritative receipt and show it - one atomic transition. */
  present: (receipt: ReceiptData) => void;
  /** Re-show the last receipt (Ctrl+P). No-op when there is nothing to show. */
  reopen: () => void;
  /** Close the preview but KEEP the data. */
  hide: () => void;
  /** Drop everything - used on sign-out, never during a normal sale. */
  clear: () => void;
};

export const useReceipt = create<ReceiptState>((set, get) => ({
  receipt: null,
  visible: false,

  present: (receipt) => set({ receipt, visible: true }),

  reopen: () => {
    if (!get().receipt) return;
    set({ visible: true });
  },

  hide: () => set({ visible: false }),

  clear: () => set({ receipt: null, visible: false }),
}));

/**
 * The render predicate, exported so the invariant is asserted in one place:
 * the preview shows only when it is visible AND has data.
 */
export function shouldShowReceipt(state: Pick<ReceiptState, "receipt" | "visible">): boolean {
  return state.visible && state.receipt !== null;
}
