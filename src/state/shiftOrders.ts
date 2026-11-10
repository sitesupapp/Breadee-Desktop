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
import { stableSelectionIndex, type ShiftOpenOrder } from "@/lib/pos/shiftOrderSummary";
import { loadOrdersHistoryOfflineAware } from "@/lib/offline/ordersHistoryOffline";
import { OFFLINE_DRAINED_EVENT } from "@/lib/offline/reconnectDrain";
import { attachCollected } from "@/lib/pos/orderDue";

/**
 * 1.0.41 (BUG 02 R5) — every payment surface (online or offline: takeaway, delivery, dine-in Pay / Split / On
 * account) announces a recorded settlement with this event, and the shift's orders re-read. Through 1.0.40 the
 * store refreshed only on a ticket print / receipt / adoption, so a paid order kept showing "Open"/"Unpaid"
 * "until another transaction".
 */
export const POS_SETTLED_EVENT = "breadee:pos-settled";
export function notifyPosSettled(): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent(POS_SETTLED_EVENT));
  } catch {
    /* best-effort: the next refresh trigger still runs */
  }
}

type RefreshArgs = { tenantId: string | null; shiftId: string | null; branchId?: string | null; preferId?: string | null };
/** 1.0.41 (R5) — request sequence: only the LATEST refresh may commit (a slow, stale read never overwrites a
 *  fresher one). */
let refreshSeq = 0;
let lastArgs: RefreshArgs | null = null;

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
  refresh: (input: { tenantId: string | null; shiftId: string | null; branchId?: string | null; preferId?: string | null }) => Promise<void>;
  /** rc.14 — the list was read from THIS device (offline). */
  offline: boolean;
  /** rc.14 — offline AND the shift's canonical orders were never saved here (only local orders shown). */
  limited: boolean;
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
  offline: false,
  limited: false,

  refresh: async ({ tenantId, shiftId, branchId, preferId }) => {
    const my = ++refreshSeq;
    lastArgs = { tenantId, shiftId, branchId: branchId ?? null };
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
      // rc.14 (F3) — offline-aware: online = the server read + write-through snapshot; offline = that
      // snapshot merged with this device's local orders (never a raw "Failed to fetch").
      const res = await loadOrdersHistoryOfflineAware({ kind: "shift", tenantId, branchId: branchId ?? null, shiftId });
      // 1.0.41 (BUG 02 S3) — part-paid orders carry what split payments already collected (same source as Pay).
      const orders = res.offline ? res.orders : await attachCollected(res.orders, tenantId).catch(() => res.orders);
      // Discard a response that arrived after the shift moved on.
      if (get().shiftId !== shiftId) return;
      // 1.0.41 (R5) — or after a NEWER refresh started (that one commits; this read may predate a payment).
      if (my !== refreshSeq) return;
      const previous = get();
      const previousId = previous.index >= 0 ? (previous.orders[previous.index]?.id ?? null) : null;
      set({
        orders,
        index: stableSelectionIndex(previousId, previous.index, orders, preferId ?? null),
        loading: false,
        offline: res.offline,
        limited: res.limited,
      });
    } catch (e) {
      if (my !== refreshSeq) return;
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

  reset: () => {
    refreshSeq++; // an in-flight read of the old shift never commits after a reset
    lastArgs = null;
    set({ orders: [], index: -1, loading: false, error: null, shiftId: null, offline: false, limited: false });
  },
}));

/** 1.0.41 (R5) — re-read the CURRENT shift's orders (same tenant / branch / shift as the last refresh). */
export function refreshShiftOrdersAgain(): Promise<void> {
  const a = lastArgs;
  if (!a || !a.tenantId || !a.shiftId || useShiftOrders.getState().shiftId !== a.shiftId) return Promise.resolve();
  return useShiftOrders.getState().refresh({ tenantId: a.tenantId, shiftId: a.shiftId, branchId: a.branchId ?? null });
}

/** 1.0.41 (R5) — after every recorded settlement and every reconnect drain (on ANY screen), the list re-reads. */
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  const again = () => {
    void refreshShiftOrdersAgain();
  };
  window.addEventListener(POS_SETTLED_EVENT, again);
  window.addEventListener(OFFLINE_DRAINED_EVENT, again);
}

/** Test hook. */
export function __resetShiftOrdersSeqForTests(): void {
  refreshSeq = 0;
  lastArgs = null;
}

/** The selected order, or null. Exported so the invariant lives in one place. */
export function selectedShiftOrder(state: Pick<ShiftOrdersState, "orders" | "index">): ShiftOpenOrder | null {
  return state.index >= 0 && state.index < state.orders.length ? state.orders[state.index] : null;
}
