// Dine-In table state.
//
// Holds ONLY table-map concerns: the server map, the selection, and freshness.
// Shift, cart, receipt and session state stay where they are - this store never
// duplicates them, and it never persists a financial assumption: the map is
// re-read from the server rather than mutated locally after an operation.
//
// No background polling in Level 2A. Refresh is explicit and happens after the
// operations that can change the map.

import { create } from "zustand";
import { EMPTY_TABLE_MAP, type TableBill, type TableMap } from "@/types/tables";
import { loadTableMap } from "@/lib/pos/tables";
import { loadTableBill } from "@/lib/pos/tableBill";

/** How long a loaded map is considered fresh before the UI flags it. */
export const STALE_AFTER_MS = 30_000;

type Context = { tenantId: string | null; branchId: string | null };

type TableState = {
  map: TableMap;
  selectedTableId: string | null;
  bill: TableBill | null;

  loading: boolean;
  refreshing: boolean;
  billLoading: boolean;
  error: string | null;
  billError: string | null;
  /** Epoch ms of the last successful map load, or null if never loaded. */
  lastLoadedAt: number | null;
  /** The context the current map belongs to, so a change can invalidate it. */
  context: Context;

  refresh: (ctx: Context) => Promise<void>;
  select: (tableId: string | null, ctx: Context) => Promise<void>;
  clearSelection: () => void;
  loadBill: (ctx: Context) => Promise<void>;
  /** Drop everything - context change or sign-out. */
  reset: () => void;
};

const sameContext = (a: Context, b: Context) => a.tenantId === b.tenantId && a.branchId === b.branchId;

export const useTables = create<TableState>((set, get) => ({
  map: EMPTY_TABLE_MAP,
  selectedTableId: null,
  bill: null,
  loading: false,
  refreshing: false,
  billLoading: false,
  error: null,
  billError: null,
  lastLoadedAt: null,
  context: { tenantId: null, branchId: null },

  refresh: async (ctx) => {
    const state = get();
    const contextChanged = !sameContext(state.context, ctx);
    // A context change invalidates everything immediately - a stale map from
    // another branch must never be shown, not even for one frame.
    set({
      loading: contextChanged || state.lastLoadedAt === null,
      refreshing: !contextChanged && state.lastLoadedAt !== null,
      error: null,
      ...(contextChanged ? { map: EMPTY_TABLE_MAP, selectedTableId: null, bill: null, lastLoadedAt: null } : {}),
    });

    try {
      const map = await loadTableMap(ctx.branchId);
      // A selection that vanished from the refreshed map is dropped safely.
      const selected = get().selectedTableId;
      const stillThere = selected !== null && map.tables.some((t) => t.id === selected);
      set({
        map,
        context: ctx,
        loading: false,
        refreshing: false,
        lastLoadedAt: Date.now(),
        selectedTableId: stillThere ? selected : null,
        bill: stillThere ? get().bill : null,
      });
      if (stillThere) await get().loadBill(ctx);
    } catch (e) {
      set({
        loading: false,
        refreshing: false,
        error: e instanceof Error ? e.message : "Could not load the table map.",
      });
    }
  },

  select: async (tableId, ctx) => {
    set({ selectedTableId: tableId, bill: null, billError: null });
    if (tableId) await get().loadBill(ctx);
  },

  clearSelection: () => set({ selectedTableId: null, bill: null, billError: null }),

  loadBill: async (ctx) => {
    const tableId = get().selectedTableId;
    if (!tableId || !ctx.tenantId) return;
    set({ billLoading: true, billError: null });
    try {
      const bill = await loadTableBill({ tableId, tenantId: ctx.tenantId, branchId: ctx.branchId });
      // The selection may have moved while the read was in flight.
      if (get().selectedTableId !== tableId) return;
      set({ bill, billLoading: false });
    } catch (e) {
      set({ billLoading: false, billError: e instanceof Error ? e.message : "Could not load the table bill." });
    }
  },

  reset: () =>
    set({
      map: EMPTY_TABLE_MAP,
      selectedTableId: null,
      bill: null,
      loading: false,
      refreshing: false,
      billLoading: false,
      error: null,
      billError: null,
      lastLoadedAt: null,
      context: { tenantId: null, branchId: null },
    }),
}));

/** True when the map is old enough that the UI should say so. */
export function isMapStale(lastLoadedAt: number | null, now: number): boolean {
  if (lastLoadedAt === null) return false;
  return now - lastLoadedAt > STALE_AFTER_MS;
}

/** The currently selected row, or null. */
export function selectedTable(state: Pick<TableState, "map" | "selectedTableId">) {
  if (!state.selectedTableId) return null;
  return state.map.tables.find((t) => t.id === state.selectedTableId) ?? null;
}
