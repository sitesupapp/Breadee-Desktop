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
import { isBackendReachable } from "@/lib/offline/reachability";
import { cacheBill, cacheTableMap, readCachedTableMap } from "@/lib/offline/db";
import type { TableSummary } from "@/types/tables";

/** rc.9 — per-session signature of the last bill pre-warmed for a table, so a map refresh re-reads a
 *  bill only when the table's bill actually moved (orders/total/version/order no.). */
const prewarmedSig = new Map<string, string>();
const billSig = (t: TableSummary) => `${t.orders}|${t.total ?? ""}|${t.pos_entity_version}|${t.order_number ?? ""}`;

/**
 * rc.9 — pre-hydrate the CANONICAL open bill of every occupied table (bounded concurrency) during
 * normal online use, so the offline operational projection has real canonical lines (not just the
 * map total) for every table that was open when the connection dropped. Online-only; never throws.
 * Read-only: it only caches what the server returned.
 */
export async function prewarmOpenBills(
  ctx: Context,
  tables: TableSummary[],
  load: typeof loadTableBill = loadTableBill,
): Promise<number> {
  if (!ctx.tenantId) return 0;
  const todo = tables.filter((t) => t.orders > 0 && prewarmedSig.get(`${ctx.branchId}:${t.id}`) !== billSig(t));
  let done = 0;
  const worker = async () => {
    for (let t = todo.shift(); t; t = todo.shift()) {
      const fetchedAt = Date.now();
      try {
        const bill = await load({ tableId: t.id, tenantId: ctx.tenantId as string, branchId: ctx.branchId });
        await cacheBill(t.id, bill, ctx.tenantId, ctx.branchId, fetchedAt);
        prewarmedSig.set(`${ctx.branchId}:${t.id}`, billSig(t));
        done += 1;
      } catch {
        /* best-effort: the next refresh retries this table */
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return done;
}

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
  /** True when the map shown was restored from the local cache (backend unreachable). */
  offline: boolean;
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
  offline: false,
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

    // Offline read continuity: the deciding authority is a backend-reachability
    // probe, not navigator.onLine. When unreachable, serve the last cached map
    // (branch/tenant scoped) instead of throwing "Failed to fetch"; a failed or
    // empty network response never overwrites a valid cached map.
    const applyCached = async (): Promise<boolean> => {
      const cached = await readCachedTableMap(ctx.tenantId, ctx.branchId).catch(() => null);
      if (!cached) return false;
      const map = cached.map as TableMap;
      const selected = get().selectedTableId;
      const stillThere = selected !== null && map.tables.some((t) => t.id === selected);
      set({
        map,
        context: ctx,
        loading: false,
        refreshing: false,
        offline: true,
        error: null,
        lastLoadedAt: cached.cachedAt,
        selectedTableId: stillThere ? selected : null,
        bill: stillThere ? get().bill : null,
      });
      return true;
    };

    if (!(await isBackendReachable())) {
      if (await applyCached()) return;
      // Offline with nothing cached yet: a clean empty state, never a raw error.
      set({ loading: false, refreshing: false, offline: true, error: null });
      return;
    }

    try {
      // 1.0.38 (C8) — freshness = when the read STARTED (as rc.9 does for bills): a map read that began
      // before a settle synced and finished after it must never count as "after the settle".
      const startedAt = Date.now();
      const map = await loadTableMap(ctx.branchId);
      // Cache only a successful load, so a later offline session has a valid map.
      await cacheTableMap(map, ctx.tenantId, ctx.branchId, startedAt).catch(() => {});
      // A selection that vanished from the refreshed map is dropped safely.
      const selected = get().selectedTableId;
      const stillThere = selected !== null && map.tables.some((t) => t.id === selected);
      set({
        map,
        context: ctx,
        loading: false,
        refreshing: false,
        offline: false,
        lastLoadedAt: startedAt,
        selectedTableId: stillThere ? selected : null,
        bill: stillThere ? get().bill : null,
      });
      if (stillThere) await get().loadBill(ctx);
      // rc.9 — keep every occupied table's canonical bill offline-ready (fire-and-forget, bounded).
      void prewarmOpenBills(ctx, map.tables);
    } catch (e) {
      // Reachable but the load failed (RLS, slow replica): fall back to a valid
      // cache if we have one rather than erasing the operator's view.
      if (await applyCached()) return;
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
    // Offline the Dine-In workspace renders the OPERATIONAL projection (cached canonical bill + local
    // rounds/edits/legs — lib/offline/operationalProjection), never this server bill; this store keeps
    // only the server-authoritative bill, so offline it holds none and says why.
    if (!(await isBackendReachable())) {
      set({ billLoading: false, billError: "Reconnect to view the full bill for this table." });
      return;
    }
    set({ billLoading: true, billError: null });
    try {
      const fetchedAt = Date.now();
      const bill = await loadTableBill({ tableId, tenantId: ctx.tenantId, branchId: ctx.branchId });
      // rc.9 — write-through the canonical bill so the offline projection has its real lines.
      void cacheBill(tableId, bill, ctx.tenantId, ctx.branchId, fetchedAt).catch(() => {});
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
      offline: false,
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
