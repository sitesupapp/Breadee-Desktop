// Delivery customer state (Level 3A).
//
// Holds ONLY customer concerns: the search box, the shortlist, the selected
// customer and their addresses and history. It deliberately owns no cart, no
// order and no money - Level 3A cannot take a delivery order at all, and this
// store is where that boundary would first erode if it were going to.
//
// Like `state/tables.ts`, nothing here is a local guess about server state: the
// selected customer is always re-read from the server after a write, so an
// address added on another terminal cannot be missing from the picker while the
// operator chooses which one the order will go to.

import { create } from "zustand";
import {
  createCustomerLatch,
  loadCustomerProfile,
  searchCustomers,
  type CustomerAddress,
  type CustomerLatch,
  type CustomerMatch,
  type CustomerProfile,
} from "@/lib/pos/customers";

/** How long typing settles before a search runs. Matches the web behaviour. */
export const SEARCH_DEBOUNCE_MS = 250;

type CustomerState = {
  query: string;
  /** null = nothing searched yet; [] = searched and genuinely nothing found. */
  results: CustomerMatch[] | null;
  searching: boolean;
  searchError: string | null;

  selected: CustomerProfile | null;
  /** The address a delivery order WOULD use. Never changed implicitly. */
  selectedAddressId: string | null;
  loadingProfile: boolean;
  profileError: string | null;

  saving: boolean;
  saveError: string | null;

  historyOpen: boolean;
  historyLoading: boolean;

  setQuery: (q: string) => void;
  search: (q: string) => Promise<void>;
  clearResults: () => void;
  select: (customerId: string) => Promise<void>;
  /** Re-read the selected customer from the server (after any write). */
  refresh: () => Promise<void>;
  selectAddress: (addressId: string) => void;
  openHistory: () => Promise<void>;
  closeHistory: () => void;
  setSaving: (saving: boolean) => void;
  setSaveError: (message: string | null) => void;
  clearSelection: () => void;
  reset: () => void;
};

/**
 * The create latch lives OUTSIDE the store on purpose.
 *
 * Zustand updates are asynchronous like any React state, so a `saving` flag in
 * the store is still false for a second click landing in the same tick. The
 * latch is a synchronous closure, which is the only thing that can decide in
 * time - and for customers there is no server-side uniqueness on the normalised
 * phone to catch the duplicate afterwards.
 */
export const customerCreateLatch: CustomerLatch = createCustomerLatch();

const EMPTY = {
  query: "",
  results: null,
  searching: false,
  searchError: null,
  selected: null,
  selectedAddressId: null,
  loadingProfile: false,
  profileError: null,
  saving: false,
  saveError: null,
  historyOpen: false,
  historyLoading: false,
} as const;

/** The address a freshly loaded customer should start on: their default, else the first. */
export function preferredAddressId(addresses: CustomerAddress[], keep?: string | null): string | null {
  if (keep && addresses.some((a) => a.id === keep)) return keep;
  return (addresses.find((a) => a.is_default) ?? addresses[0])?.id ?? null;
}

export const useCustomers = create<CustomerState>((set, get) => ({
  ...EMPTY,

  setQuery: (q) => set({ query: q, ...(q.trim() === "" ? { results: null, searchError: null } : {}) }),

  search: async (q) => {
    const term = q.trim();
    if (term === "") {
      set({ results: null, searching: false, searchError: null });
      return;
    }
    set({ searching: true, searchError: null });
    try {
      const results = await searchCustomers(term);
      // The query may have moved on while this read was in flight.
      if (get().query.trim() !== term) return;
      set({ results, searching: false });
    } catch (e) {
      set({ searching: false, searchError: e instanceof Error ? e.message : "Could not search customers." });
    }
  },

  clearResults: () => set({ results: null, searchError: null }),

  select: async (customerId) => {
    set({ loadingProfile: true, profileError: null, results: null });
    try {
      const profile = await loadCustomerProfile(customerId);
      set({
        selected: profile,
        selectedAddressId: preferredAddressId(profile.addresses),
        loadingProfile: false,
      });
    } catch (e) {
      set({ loadingProfile: false, profileError: e instanceof Error ? e.message : "Could not load that customer." });
    }
  },

  refresh: async () => {
    const current = get().selected;
    if (!current) return;
    set({ loadingProfile: true, profileError: null });
    try {
      const profile = await loadCustomerProfile(current.id);
      set({
        selected: profile,
        // Keep the operator's explicit choice when it still exists; otherwise
        // fall back to the server's default. Never silently move to another
        // address - that is the one a delivery order would be sent to.
        selectedAddressId: preferredAddressId(profile.addresses, get().selectedAddressId),
        loadingProfile: false,
      });
    } catch (e) {
      set({ loadingProfile: false, profileError: e instanceof Error ? e.message : "Could not refresh that customer." });
    }
  },

  selectAddress: (addressId) => {
    const selected = get().selected;
    if (!selected || !selected.addresses.some((a) => a.id === addressId)) return;
    set({ selectedAddressId: addressId });
  },

  // Re-read on open so another terminal's order appears rather than a stale count.
  openHistory: async () => {
    set({ historyOpen: true, historyLoading: true });
    await get().refresh();
    set({ historyLoading: false });
  },

  closeHistory: () => set({ historyOpen: false }),

  setSaving: (saving) => set({ saving }),
  setSaveError: (message) => set({ saveError: message }),

  clearSelection: () => set({ selected: null, selectedAddressId: null, profileError: null, saveError: null }),

  reset: () => set({ ...EMPTY }),
}));

/** The currently chosen address object, or null. */
export function selectedAddress(state: Pick<CustomerState, "selected" | "selectedAddressId">): CustomerAddress | null {
  if (!state.selected || !state.selectedAddressId) return null;
  return state.selected.addresses.find((a) => a.id === state.selectedAddressId) ?? null;
}

/** Delivery needs a customer AND an explicitly chosen address - Level 3B will require this. */
export function deliveryContextReady(state: Pick<CustomerState, "selected" | "selectedAddressId">): boolean {
  return selectedAddress(state) !== null;
}
