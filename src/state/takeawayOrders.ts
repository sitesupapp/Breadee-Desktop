// Parallel takeaway orders: `< Order 1  Order 2  Order 3 >`.
//
// WHAT THIS FIXES, AND IT IS NOT COSMETIC. Until now a till could hold exactly
// one takeaway order at a time. A cashier who had sent order 1 to the kitchen
// and then needed to serve the next customer had one way forward - Clear - and
// clearing dropped the reference the app needs to collect the money. The code in
// `PosWorkspace.sendToKitchen` names the real order this happened to and says it
// is still open. Parking an order instead of discarding it is the answer to
// that, and the order navigation in the approved design is how it is reached.
//
// ONE LIVE BUFFER, ALWAYS. There is still exactly one `useCart`. A slot is not a
// second cart; it is a PARKED SNAPSHOT of the one cart, and at any instant
// exactly one slot is un-parked (the active one) and lives in `useCart`.
// Switching parks the live buffer and un-parks the target in the same tick.
// That is the whole mechanism, and it is chosen over N cart stores precisely
// because ownership, claiming, the op id and `savedOrder` are subtle enough once
// - three copies of them would disagree, and what they would disagree about is
// whether two orders are the same order.
//
// THE SELECTED SLOT IS THEREFORE AUTHORITATIVE BY CONSTRUCTION. Pay, Send to
// kitchen, Print and Clear all read `useCart`, and `useCart` IS the selected
// slot. There is no separate "selected order id" for them to fall out of step
// with, which is the class of bug that makes a cashier pay the wrong order.
//
// TAKEAWAY ONLY. Dine-in rounds and delivery baskets borrow the same buffer
// through `claim`, so switching slots while one of them holds it would park
// someone else's work under a takeaway tab. `canSwitch` refuses instead, and the
// tabs are not rendered outside takeaway anyway - two independent reasons,
// because this one is worth being wrong about twice.

import { create } from "zustand";
import { EMPTY_CART_SNAPSHOT, useCart, type CartSnapshot } from "@/state/cart";

/**
 * How many orders a till can hold at once.
 *
 * Three, matching the approved design. It is a constant rather than a setting
 * because the number is a claim about how many customers one cashier can track
 * without confusing them, not a preference - and an unbounded list of tabs is a
 * different feature (a takeaway open-orders workspace) with a different design.
 */
export const TAKEAWAY_SLOT_COUNT = 3;

export type TakeawaySlotSummary = {
  /** 1-based, and what the tab says. */
  position: number;
  /** Has anything in it - lines, or an order the server has accepted. */
  used: boolean;
  /** The server's order number once this slot has been submitted. */
  orderNumber: string | null;
  itemCount: number;
};

type TakeawayOrdersState = {
  /** Parked snapshots, indexed by slot. The ACTIVE index's entry is unused. */
  parked: (CartSnapshot | null)[];
  /** Which slot is live in `useCart`. */
  index: number;

  /** Move to a slot by index. No-op for the current slot or an out-of-range one. */
  select: (index: number) => void;
  /** Previous/next, wrapping, so the arrows always do something. */
  step: (direction: 1 | -1) => void;
  /**
   * Forget every parked order and return to slot 1.
   *
   * Called when the POS workspace closes and when a shift ends: a parked order
   * belongs to the shift it was taken on, and the next cashier must not inherit
   * the previous one's half-built baskets.
   */
  reset: () => void;
};

const emptyParked = () => Array.from({ length: TAKEAWAY_SLOT_COUNT }, () => null);

/**
 * May the buffer be parked right now?
 *
 * Only a takeaway-owned or unowned buffer. Exported so the UI can disable the
 * tabs with a reason rather than silently doing nothing when pressed.
 */
export function canSwitchSlots(owner: CartSnapshot["owner"]): boolean {
  return owner === null || owner.kind === "takeaway";
}

export const useTakeawayOrders = create<TakeawayOrdersState>((set, get) => ({
  parked: emptyParked(),
  index: 0,

  select: (index) => {
    const { index: current, parked } = get();
    if (index === current) return;
    if (index < 0 || index >= TAKEAWAY_SLOT_COUNT) return;

    const cart = useCart.getState();
    const live = cart.snapshot();
    // Refuse rather than park a table's round or a caller's basket under a
    // takeaway tab. The caller surfaces this; the store simply does not move.
    if (!canSwitchSlots(live.owner)) return;

    const next = [...parked];
    next[current] = live;
    const target = next[index] ?? EMPTY_CART_SNAPSHOT;
    // Un-parked, so there is never a second copy of a live order anywhere.
    next[index] = null;

    set({ parked: next, index });
    cart.restore(target);
  },

  step: (direction) => {
    const { index } = get();
    const next = (index + direction + TAKEAWAY_SLOT_COUNT) % TAKEAWAY_SLOT_COUNT;
    get().select(next);
  },

  reset: () => set({ parked: emptyParked(), index: 0 }),
}));

/**
 * What the tab strip renders.
 *
 * The ACTIVE slot is described from the live cart and every other slot from its
 * parked snapshot, which is the same rule the store itself follows - so a tab
 * can never claim an order the buffer does not hold.
 */
export function slotSummaries(input: {
  parked: (CartSnapshot | null)[];
  index: number;
  live: Pick<CartSnapshot, "lines" | "savedOrder">;
}): TakeawaySlotSummary[] {
  return Array.from({ length: TAKEAWAY_SLOT_COUNT }, (_, i) => {
    const source = i === input.index ? input.live : input.parked[i];
    const lines = source?.lines ?? [];
    const savedOrder = source?.savedOrder ?? null;
    return {
      position: i + 1,
      used: lines.length > 0 || savedOrder !== null,
      orderNumber: savedOrder?.order_number ?? null,
      itemCount: lines.reduce((sum, l) => sum + l.quantity, 0),
    };
  });
}

/**
 * Slots holding an order the server accepted but nobody has paid.
 *
 * Read when a shift is being closed, so the cashier is told what is parked
 * before the buffers are dropped rather than after. This is the same money that
 * `pos_shift_unresolved_orders` would block the close on; saying so here means
 * it is discovered at the till instead of at the refusal.
 */
export function unpaidParkedOrders(input: {
  parked: (CartSnapshot | null)[];
  index: number;
  live: Pick<CartSnapshot, "savedOrder">;
}): string[] {
  const out: string[] = [];
  for (let i = 0; i < TAKEAWAY_SLOT_COUNT; i += 1) {
    const source = i === input.index ? input.live : input.parked[i];
    const number = source?.savedOrder?.order_number ?? null;
    if (number) out.push(number);
  }
  return out;
}
