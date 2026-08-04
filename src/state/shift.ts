// Shift state.
//
// The invariant this store exists to protect: `shiftId` is either a real open
// shift on the server, or null. It is never inferred, never cached across a
// sign-out, and never carried forward once the shift ends - because an order
// submitted against a stale shift id is exactly the orphan-order class of bug
// this level was built to remove.

import { create } from "zustand";
import type { ActiveShift, CashBox, ShiftReport } from "@/types/pos";
import { endShift, findOpenShift, getCashBox, openShift } from "@/lib/pos/shifts";

type ShiftState = {
  loading: boolean;
  shift: ActiveShift | null;
  cashBox: CashBox | null;
  /** The report returned by the most recent end-shift, kept for the summary view. */
  lastReport: ShiftReport | null;
  error: string | null;

  refresh: (tenantId: string, userId: string) => Promise<void>;
  refreshCashBox: () => Promise<void>;
  open: (input: { tenantId: string; userId: string; branchId: string | null; openingCash: number }) => Promise<void>;
  close: (input: { actualCashCounted: number; notes: string | null }) => Promise<ShiftReport>;
  clearReport: () => void;
  clear: () => void;
};

export const useShift = create<ShiftState>((set, get) => ({
  loading: true,
  shift: null,
  cashBox: null,
  lastReport: null,
  error: null,

  refresh: async (tenantId, userId) => {
    set({ loading: true, error: null });
    try {
      const shift = await findOpenShift(tenantId, userId);
      set({ shift, loading: false });
      if (shift) await get().refreshCashBox();
      else set({ cashBox: null });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : "Could not read the current shift." });
    }
  },

  refreshCashBox: async () => {
    const shift = get().shift;
    if (!shift) {
      set({ cashBox: null });
      return;
    }
    try {
      set({ cashBox: await getCashBox(shift.id) });
    } catch (e) {
      // The drawer is informational; a failure here must not block ordering.
      set({ error: e instanceof Error ? e.message : "Could not read the cash box." });
    }
  },

  open: async ({ tenantId, userId, branchId, openingCash }) => {
    await openShift({ branchId, openingCash });
    // Re-read rather than trust the returned id: this also picks up the case
    // where the server CONTINUED an existing open shift instead of creating one.
    await get().refresh(tenantId, userId);
  },

  close: async ({ actualCashCounted, notes }) => {
    const shift = get().shift;
    if (!shift) throw new Error("There is no open shift to end.");
    const report = await endShift({ shiftId: shift.id, actualCashCounted, notes });
    // The shift is now pending_manager_review - it is no longer usable for orders.
    set({ shift: null, cashBox: null, lastReport: report });
    return report;
  },

  clearReport: () => set({ lastReport: null }),

  clear: () => set({ loading: false, shift: null, cashBox: null, lastReport: null, error: null }),
}));

/** The one predicate the order/payment paths consult. */
export function requireOpenShiftId(shift: ActiveShift | null): string | null {
  return shift && shift.status === "open" ? shift.id : null;
}
