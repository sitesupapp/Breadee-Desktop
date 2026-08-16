// Cart state for one logical order.
//
// The `clientOpId` lives here, and its lifecycle IS the duplicate-order
// protection working together with m224:
//
//   * minted once when a cart becomes non-empty,
//   * reused for every retry of that same submission,
//   * cleared ONLY when the order is definitively settled (paid) or the cashier
//     explicitly starts a new order.
//
// `savedOrder` is the other half: once `pos_submit_order` has returned an order,
// a failed payment must retry PAYMENT for that order - never create a second one.

import { create } from "zustand";
import type { CartLine, SelectedModifier, SubmitOrderResult } from "@/types/pos";
import { lineTotals } from "@/lib/pos/modifiers";
import { newClientOpId } from "@/lib/pos/orders";

export type RemovedLine = { line: CartLine; index: number };

/**
 * Which context the buffer currently belongs to.
 *
 * Level 2B reuses this ONE cart as the dine-in round buffer - there is
 * deliberately no second cart store. That makes ownership load-bearing: without
 * it, half-built takeaway lines would appear inside a table's round (and vice
 * versa), and the cashier would send someone else's food to a table. Recording
 * the owner makes that state unrepresentable rather than merely unlikely.
 *
 * LEVEL 3B: delivery ownership carries the CUSTOMER, not just the kind.
 *
 * A delivery cart is only meaningful for the person it was built for. If the
 * owner were `{ kind: "delivery" }` alone, then building a basket for customer A,
 * switching to customer B and pressing Send would submit A's food against B's
 * name and B's address - the customer-facing equivalent of sending one table's
 * order to another. The customer id is therefore part of the identity, and
 * `claim` refuses on any mismatch.
 *
 * The ADDRESS is deliberately NOT part of ownership: a caller may legitimately
 * change their mind about where the same basket should go, and forcing them to
 * rebuild it would be hostile. The address is re-validated against the customer
 * at submit time instead (see `lib/pos/deliveryOrder.ts`).
 */
export type CartOwner =
  | { kind: "takeaway" }
  | { kind: "table"; tableId: string }
  | { kind: "delivery"; customerId: string };

/**
 * Do two owners denote the same work?
 *
 * Written as an exhaustive switch on purpose. The previous form ended in
 *
 *   a.kind === "takeaway" || b.kind === "takeaway" || a.tableId === b.tableId
 *
 * which was correct for the two kinds that existed, but silently wrong the
 * moment a third arrived: for two DELIVERY owners neither disjunct matches and
 * the comparison fell through to `a.tableId === b.tableId`, i.e.
 * `undefined === undefined`, i.e. **true for every pair of customers**. That is
 * precisely the wrong-customer submission this level has to make impossible, so
 * the shape that allowed it is gone rather than patched.
 */
export function sameOwner(a: CartOwner | null, b: CartOwner | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "takeaway":
      return true;
    case "table":
      return a.tableId === (b as { kind: "table"; tableId: string }).tableId;
    case "delivery":
      return a.customerId === (b as { kind: "delivery"; customerId: string }).customerId;
  }
}

type CartState = {
  lines: CartLine[];
  selectedKey: string | null;
  clientOpId: string | null;
  /** The order created for this cart, if a submit already succeeded. */
  savedOrder: SubmitOrderResult | null;
  /** Last removed line, for a single-level undo. */
  lastRemoved: RemovedLine | null;
  /** Null while the buffer is empty and unclaimed. */
  owner: CartOwner | null;

  addLine: (input: { menuItemId: string; name: string; basePrice: number; quantity?: number; modifiers?: SelectedModifier[]; note?: string | null }) => string;
  setQuantity: (key: string, quantity: number) => void;
  adjustQuantity: (key: string, delta: number) => void;
  setNote: (key: string, note: string | null) => void;
  removeLine: (key: string) => void;
  undoRemove: () => void;
  select: (key: string | null) => void;
  moveSelection: (delta: number) => void;
  /**
   * Claim the buffer for a context. Succeeds when the buffer is empty or already
   * belongs to that context; returns false when someone else's work is in it, so
   * the caller can refuse rather than silently mixing two orders together.
   */
  claim: (owner: CartOwner) => boolean;
  /** Ensure an operation id exists for the current cart; returns it. */
  ensureOpId: () => string;
  setSavedOrder: (order: SubmitOrderResult | null) => void;
  /** Cart edited after a submit: the saved order no longer matches, start fresh. */
  invalidateSavedOrder: () => void;
  /** Definitive completion (paid) or an explicit new order. */
  reset: () => void;

  /**
   * Lift the whole buffer out, verbatim.
   *
   * Exists for the takeaway order slots (`state/takeawayOrders.ts`), which park
   * one order while the cashier serves another. It copies EVERY field the
   * duplicate-order protection depends on - `clientOpId` and `savedOrder`
   * included - because a parked order that came back without its op id would be
   * submitted a second time as a new order, which is the exact failure m224 and
   * this store exist to prevent.
   */
  snapshot: () => CartSnapshot;
  /**
   * Put a previously lifted buffer back, replacing whatever is here.
   *
   * The caller is responsible for having snapshotted what it is overwriting;
   * this is deliberately a plain assignment rather than a merge, because a merge
   * of two orders is precisely the mixing that `claim` exists to make
   * impossible.
   */
  restore: (snapshot: CartSnapshot) => void;
};

/**
 * A parked order.
 *
 * `lastRemoved` is deliberately NOT part of it: undo is a gesture about what the
 * cashier just did on screen, and offering "undo" for a line removed from a
 * different order ten minutes ago would restore it into whichever order happens
 * to be open now.
 */
export type CartSnapshot = {
  lines: CartLine[];
  selectedKey: string | null;
  clientOpId: string | null;
  savedOrder: SubmitOrderResult | null;
  owner: CartOwner | null;
};

export const EMPTY_CART_SNAPSHOT: CartSnapshot = {
  lines: [],
  selectedKey: null,
  clientOpId: null,
  savedOrder: null,
  owner: null,
};

let keySeq = 0;
const nextKey = () => `line-${++keySeq}`;

/** Two lines merge only when the item AND its modifier selection are identical. */
function sameConfiguration(a: CartLine, menuItemId: string, modifiers: SelectedModifier[], note: string | null): boolean {
  if (a.menu_item_id !== menuItemId) return false;
  if ((a.kitchen_note ?? "") !== (note ?? "")) return false;
  if (a.modifiers.length !== modifiers.length) return false;
  const mine = a.modifiers.map((m) => m.option_id).sort();
  const theirs = modifiers.map((m) => m.option_id).sort();
  return mine.every((id, i) => id === theirs[i]);
}

export const useCart = create<CartState>((set, get) => ({
  lines: [],
  selectedKey: null,
  clientOpId: null,
  savedOrder: null,
  lastRemoved: null,
  owner: null,

  claim: (owner) => {
    const state = get();
    if (state.lines.length === 0) {
      set({ owner });
      return true;
    }
    return sameOwner(state.owner, owner);
  },

  addLine: ({ menuItemId, name, basePrice, quantity = 1, modifiers = [], note = null }) => {
    const state = get();
    const existing = state.lines.find((l) => sameConfiguration(l, menuItemId, modifiers, note));
    if (existing) {
      set({
        lines: state.lines.map((l) => (l.key === existing.key ? { ...l, quantity: l.quantity + quantity } : l)),
        selectedKey: existing.key,
        savedOrder: null,
      });
      return existing.key;
    }
    const key = nextKey();
    const line: CartLine = {
      key,
      menu_item_id: menuItemId,
      name,
      base_price: basePrice,
      quantity,
      kitchen_note: note,
      modifiers,
    };
    set({
      lines: [...state.lines, line],
      selectedKey: key,
      savedOrder: null,
      clientOpId: state.clientOpId ?? newClientOpId(),
    });
    return key;
  },

  setQuantity: (key, quantity) =>
    set((s) => {
      if (quantity <= 0) return s; // removal is an explicit, undoable action
      return { lines: s.lines.map((l) => (l.key === key ? { ...l, quantity } : l)), savedOrder: null };
    }),

  adjustQuantity: (key, delta) =>
    set((s) => ({
      lines: s.lines.map((l) => (l.key === key ? { ...l, quantity: Math.max(1, l.quantity + delta) } : l)),
      savedOrder: null,
    })),

  setNote: (key, note) =>
    set((s) => ({
      lines: s.lines.map((l) => (l.key === key ? { ...l, kitchen_note: note } : l)),
      savedOrder: null,
    })),

  removeLine: (key) =>
    set((s) => {
      const index = s.lines.findIndex((l) => l.key === key);
      if (index < 0) return s;
      const line = s.lines[index];
      const lines = s.lines.filter((l) => l.key !== key);
      const selectedKey = s.selectedKey === key ? (lines[Math.min(index, lines.length - 1)]?.key ?? null) : s.selectedKey;
      return { lines, selectedKey, lastRemoved: { line, index }, savedOrder: null };
    }),

  undoRemove: () =>
    set((s) => {
      if (!s.lastRemoved) return s;
      const lines = [...s.lines];
      lines.splice(Math.min(s.lastRemoved.index, lines.length), 0, s.lastRemoved.line);
      return { lines, selectedKey: s.lastRemoved.line.key, lastRemoved: null, savedOrder: null };
    }),

  select: (key) => set({ selectedKey: key }),

  moveSelection: (delta) =>
    set((s) => {
      if (s.lines.length === 0) return s;
      const current = s.lines.findIndex((l) => l.key === s.selectedKey);
      const next = current < 0 ? 0 : Math.min(s.lines.length - 1, Math.max(0, current + delta));
      return { selectedKey: s.lines[next].key };
    }),

  ensureOpId: () => {
    const existing = get().clientOpId;
    if (existing) return existing;
    const id = newClientOpId();
    set({ clientOpId: id });
    return id;
  },

  setSavedOrder: (order) => set({ savedOrder: order }),

  invalidateSavedOrder: () => set({ savedOrder: null }),

  reset: () =>
    set({ lines: [], selectedKey: null, clientOpId: null, savedOrder: null, lastRemoved: null, owner: null }),

  snapshot: () => {
    const s = get();
    return {
      lines: s.lines,
      selectedKey: s.selectedKey,
      clientOpId: s.clientOpId,
      savedOrder: s.savedOrder,
      owner: s.owner,
    };
  },

  restore: (snapshot) =>
    set({
      lines: snapshot.lines,
      selectedKey: snapshot.selectedKey,
      clientOpId: snapshot.clientOpId,
      savedOrder: snapshot.savedOrder,
      owner: snapshot.owner,
      // Cleared rather than carried: see `CartSnapshot`.
      lastRemoved: null,
    }),
}));

/** Subtotal as the server computes it. Exported for components and tests. */
export function selectSubtotal(lines: CartLine[]): number {
  return lines.reduce((sum, l) => sum + lineTotals(l.base_price, l.modifiers, l.quantity).lineTotal, 0);
}

export function selectItemCount(lines: CartLine[]): number {
  return lines.reduce((sum, l) => sum + l.quantity, 0);
}
