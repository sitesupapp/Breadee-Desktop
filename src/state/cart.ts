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

type CartState = {
  lines: CartLine[];
  selectedKey: string | null;
  clientOpId: string | null;
  /** The order created for this cart, if a submit already succeeded. */
  savedOrder: SubmitOrderResult | null;
  /** Last removed line, for a single-level undo. */
  lastRemoved: RemovedLine | null;

  addLine: (input: { menuItemId: string; name: string; basePrice: number; quantity?: number; modifiers?: SelectedModifier[]; note?: string | null }) => string;
  setQuantity: (key: string, quantity: number) => void;
  adjustQuantity: (key: string, delta: number) => void;
  setNote: (key: string, note: string | null) => void;
  removeLine: (key: string) => void;
  undoRemove: () => void;
  select: (key: string | null) => void;
  moveSelection: (delta: number) => void;
  /** Ensure an operation id exists for the current cart; returns it. */
  ensureOpId: () => string;
  setSavedOrder: (order: SubmitOrderResult | null) => void;
  /** Cart edited after a submit: the saved order no longer matches, start fresh. */
  invalidateSavedOrder: () => void;
  /** Definitive completion (paid) or an explicit new order. */
  reset: () => void;
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

  reset: () => set({ lines: [], selectedKey: null, clientOpId: null, savedOrder: null, lastRemoved: null }),
}));

/** Subtotal as the server computes it. Exported for components and tests. */
export function selectSubtotal(lines: CartLine[]): number {
  return lines.reduce((sum, l) => sum + lineTotals(l.base_price, l.modifiers, l.quantity).lineTotal, 0);
}

export function selectItemCount(lines: CartLine[]): number {
  return lines.reduce((sum, l) => sum + l.quantity, 0);
}
