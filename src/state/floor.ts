// Service Floor Map state — GEOMETRY ONLY.
//
// Holds the published floor layout, which section is active, and the view
// transform (zoom/pan). It owns NONE of the operational truth: the selected
// table lives in `useTables.selectedTableId`, the bill in `useTables.bill`, and
// table status in `useTables.map`. A floor node's click calls the workspace's
// existing `select(id)` → `useTables.select`, so the right-side bill panel, Pay,
// Move/Close/Clear and rounds all keep reading from the one canonical selection.
//
// Read-only feature: `load` calls `floor_service_layout` (a read) and nothing
// else. No draft, no autosave, no publish, no lease — those are the Designer's,
// a later phase.

import { create } from "zustand";
import { EMPTY_FLOOR_LAYOUT, loadFloorLayout, type FloorLayout } from "@/lib/pos/floor";
import { resolveActiveSection } from "@/lib/pos/floorSections";
import type { Transform } from "@/lib/pos/floorGeometry";
import { cacheFloor, readCachedFloor } from "@/lib/offline/db";
import { isBackendReachable } from "@/lib/offline/reachability";

/** How long a loaded floor is considered fresh before a sensible re-fetch. */
export const FLOOR_STALE_AFTER_MS = 60_000;

type Context = { tenantId: string | null; branchId: string | null };

type FloorState = {
  layout: FloorLayout;
  activeSectionId: string | null;
  /** null means "not yet fitted" — the canvas computes Fit on its next measure. */
  transform: Transform | null;

  loading: boolean;
  refreshing: boolean;
  error: string | null;
  /** True when the rendered layout came from the offline cache (backend unreachable). */
  offline: boolean;
  lastLoadedAt: number | null;
  context: Context;

  load: (ctx: Context) => Promise<void>;
  setActiveSection: (sectionId: string) => void;
  setTransform: (transform: Transform) => void;
  /** Ask the canvas to recompute Fit on its next measure (e.g. the Fit button). */
  requestFit: () => void;
  reset: () => void;
};

const sameContext = (a: Context, b: Context) => a.tenantId === b.tenantId && a.branchId === b.branchId;

export const useFloor = create<FloorState>((set, get) => ({
  layout: EMPTY_FLOOR_LAYOUT,
  activeSectionId: null,
  transform: null,
  loading: false,
  refreshing: false,
  error: null,
  offline: false,
  lastLoadedAt: null,
  context: { tenantId: null, branchId: null },

  load: async (ctx) => {
    const state = get();
    const contextChanged = !sameContext(state.context, ctx);
    set({
      loading: contextChanged || state.lastLoadedAt === null,
      refreshing: !contextChanged && state.lastLoadedAt !== null,
      error: null,
      ...(contextChanged
        ? { layout: EMPTY_FLOOR_LAYOUT, activeSectionId: null, transform: null, lastLoadedAt: null }
        : {}),
    });
    try {
      const layout = await loadFloorLayout(ctx.branchId);
      // Keep the current section if it survived a republish; otherwise fall back
      // to the first. A section change (or a first load) resets the transform so
      // the canvas re-fits.
      const nextActive = resolveActiveSection(layout.sections, get().activeSectionId);
      const activeChanged = nextActive !== get().activeSectionId;
      set({
        layout,
        activeSectionId: nextActive,
        transform: activeChanged ? null : get().transform,
        context: ctx,
        loading: false,
        refreshing: false,
        offline: false,
        lastLoadedAt: Date.now(),
      });
      // Write-through cache so the floor stays renderable offline. Fire-and-forget; a
      // cache-write failure must never affect the (successful) online load.
      void cacheFloor(layout, ctx.tenantId, ctx.branchId);
    } catch (e) {
      // OFFLINE FALLBACK: the backend was unreachable. Render the last hydrated floor from
      // the cache instead of an error, so the Floor Map stays active offline. Only this
      // (failure) branch changes; the online success path above is unchanged.
      const cached = await readCachedFloor(ctx.tenantId, ctx.branchId).catch(() => null);
      const cachedLayout = cached?.layout as FloorLayout | undefined;
      if (cachedLayout && cachedLayout.sections) {
        const nextActive = resolveActiveSection(cachedLayout.sections, get().activeSectionId);
        const activeChanged = nextActive !== get().activeSectionId;
        set({
          layout: cachedLayout,
          activeSectionId: nextActive,
          transform: activeChanged ? null : get().transform,
          context: ctx,
          loading: false,
          refreshing: false,
          offline: true,
          error: null,
          lastLoadedAt: Date.now(),
        });
        return;
      }
      // No cache to fall back on. An UNREACHABLE backend is an expected offline
      // state, not a fault to shove a raw "Failed to fetch" at the cashier: show a
      // controlled readiness reason instead. A reachable-but-failed load (RLS, slow
      // replica) keeps its real message so a genuine fault is still diagnosable.
      const reachable = await isBackendReachable().catch(() => false);
      set({
        loading: false,
        refreshing: false,
        offline: !reachable,
        error: reachable
          ? e instanceof Error
            ? e.message
            : "Couldn't load the floor map."
          : "The floor map isn't saved for offline use yet. Reconnect once while online to make it available offline — the table List is available now.",
      });
    }
  },

  setActiveSection: (sectionId) => {
    if (sectionId === get().activeSectionId) return;
    // A new section is a new plane — drop the transform so the canvas fits it.
    set({ activeSectionId: sectionId, transform: null });
  },

  setTransform: (transform) => set({ transform }),

  requestFit: () => set({ transform: null }),

  reset: () =>
    set({
      layout: EMPTY_FLOOR_LAYOUT,
      activeSectionId: null,
      transform: null,
      loading: false,
      refreshing: false,
      error: null,
      offline: false,
      lastLoadedAt: null,
      context: { tenantId: null, branchId: null },
    }),
}));

/** True when the floor is old enough that a sensible lifecycle event should re-fetch. */
export function isFloorStale(lastLoadedAt: number | null, now: number): boolean {
  if (lastLoadedAt === null) return false;
  return now - lastLoadedAt > FLOOR_STALE_AFTER_MS;
}

/**
 * The outcome of a floor pre-warm, as a PRECISE per-checkpoint code so a diagnostic can pinpoint
 * exactly where offline-readiness fell down (instead of a bare success/fail):
 *   NO_SCOPE     — no tenant/branch yet (caller should wait for resolution; never reached while gated)
 *   LOAD_FAILED  — the published-floor read (floor_service_layout) threw: backend unreachable / RPC error
 *   WRITE_FAILED — the layout loaded but the durable cache write did not commit / could not be read back
 *   EMPTY        — the branch has NO published floor (cached as such → offline shows "no floor published",
 *                  which is correct continuity, not an error); the cache IS present
 *   READY        — a published floor was loaded AND durably cached AND confirmed by read-back
 * READY and EMPTY both mean "the cache is present" (floorCache diagnostic → present).
 */
export type FloorPrewarmResult = "NO_SCOPE" | "LOAD_FAILED" | "WRITE_FAILED" | "EMPTY" | "READY";

/**
 * Pre-warm the durable floor cache for a branch WITHOUT mounting the Map, so the visual Floor Map
 * renders offline the FIRST time Dine-In is opened — the operator never has to visit it online first.
 *
 * Unlike the store's `load` (which write-throughs fire-and-forget), this AWAITS the cache write AND
 * confirms it by reading it back, so a caller can report floorCache=READY only once the durable write
 * has actually committed. Returns a precise checkpoint code; NEVER throws. The loader is injectable
 * for tests.
 */
export async function prewarmFloorCache(
  ctx: Context,
  load: (branchId: string | null) => Promise<FloorLayout> = loadFloorLayout,
): Promise<FloorPrewarmResult> {
  if (!ctx.tenantId || !ctx.branchId) return "NO_SCOPE";
  let layout: FloorLayout;
  try {
    layout = await load(ctx.branchId);
  } catch {
    return "LOAD_FAILED";
  }
  try {
    await cacheFloor(layout, ctx.tenantId, ctx.branchId);
    const confirmed = await readCachedFloor(ctx.tenantId, ctx.branchId);
    if (confirmed == null) return "WRITE_FAILED";
  } catch {
    return "WRITE_FAILED";
  }
  return layout.hasPublished ? "READY" : "EMPTY";
}

/** True when the pre-warm result means the durable cache is present (offline-ready). */
export function floorPrewarmCached(r: FloorPrewarmResult): boolean {
  return r === "READY" || r === "EMPTY";
}
