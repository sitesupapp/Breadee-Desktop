// The active shift's orders, held once.
//
// THREE SURFACES, ONE COLLECTION. The top bar's "Orders N", the Shift Orders
// dropdown and the right-hand Current Order panel are three views of the same
// array and the same selected index. A count that came from a second query is
// a count that can disagree with the list it sits beside - and the number next
// to End shift is exactly the one a cashier uses to decide whether they have
// seen everything this till did.
//
// A STORE RATHER THAN COMPONENT STATE, for the reason the receipt is one: the
// workspace early-returns a skeleton while POS context loads, so state owned
// inside it can be dropped by a transient not-ready render - and this state has
// to survive the moment an order is created, which is precisely when the
// workspace is busy re-rendering.
//
// READS ONLY. Nothing in this store or the module behind it issues anything but
// a SELECT. Selecting, browsing and printing an order cannot change it.

import { create } from "zustand";
import { loadShiftOrders, stableSelectionIndex, type ShiftOpenOrder } from "@/lib/pos/shiftOrderSummary";

type ShiftOrdersState = {
  /** Every order in the active shift, oldest first. */
  orders: ShiftOpenOrder[];
  /** Index into `orders`, or -1 when there is nothing to show. */
  index: number;
  loading: boolean;
  error: string | null;
  /** The shift this data belongs to. Guards against showing a stale shift. */
  shiftId: string | null;

  /**
   * Re-read the shift's orders.
   *
   * `preferId` is the "an order was just created" signal: when the refreshed
   * list contains it, it becomes the selection. Everything else follows
   * `stableSelectionIndex` - keep what was selected, else the newest.
   */
  refresh: (input: { tenantId: string | null; shiftId: string | null; preferId?: string | null }) => Promise<void>;
  /** Select by id. Used by the Shift Orders dropdown. No-op for an unknown id. */
  select: (orderId: string) => void;
  step: (direction: 1 | -1) => void;
  /**
   * Drop everything. Called when the active shift changes - a closed shift's
   * orders must stop being the dataset the moment a new shift opens, or the
   * next cashier reviews the previous cashier's till.
   */
  reset: () => void;
};

export const useShiftOrders = create<ShiftOrdersState>((set, get) => ({
  orders: [],
  index: -1,
  loading: false,
  error: null,
  shiftId: null,

  refresh: async ({ tenantId, shiftId, preferId }) => {
    // A shift change invalidates immediately, before the request - so nothing
    // from the previous shift is on screen while the new list loads.
    if (get().shiftId !== shiftId) {
      set({ orders: [], index: -1, shiftId, error: null });
    }
    if (!tenantId || !shiftId) {
      set({ orders: [], index: -1, loading: false, error: null, shiftId });
      return;
    }
    set({ loading: true, error: null });
    try {
      const orders = await loadShiftOrders({ tenantId, shiftId });
      // Discard a response that arrived after the shift moved on.
      if (get().shiftId !== shiftId) return;
      const previous = get();
      const previousId = previous.index >= 0 ? (previous.orders[previous.index]?.id ?? null) : null;
      set({
        orders,
        index: stableSelectionIndex(previousId, previous.index, orders, preferId ?? null),
        loading: false,
      });
    } catch (e) {
      set({
        loading: false,
        error: e instanceof Error ? e.message : "The shift's orders could not be loaded.",
      });
    }
  },

  select: (orderId) => {
    const found = get().orders.findIndex((o) => o.id === orderId);
    if (found >= 0) set({ index: found });
  },

  step: (direction) => {
    const { orders, index } = get();
    if (orders.length === 0) {
      set({ index: -1 });
      return;
    }
    const from = Math.max(0, index);
    const next = direction === 1 ? (from + 1) % orders.length : (from - 1 + orders.length) % orders.length;
    set({ index: next });
  },

  reset: () => set({ orders: [], index: -1, loading: false, error: null, shiftId: null }),
}));

/** The selected order, or null. Exported so the invariant lives in one place. */
export function selectedShiftOrder(state: Pick<ShiftOrdersState, "orders" | "index">): ShiftOpenOrder | null {
  return state.index >= 0 && state.index < state.orders.length ? state.orders[state.index] : null;
}
