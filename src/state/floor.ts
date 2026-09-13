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
        lastLoadedAt: Date.now(),
      });
    } catch (e) {
      set({
        loading: false,
        refreshing: false,
        error: e instanceof Error ? e.message : "Couldn't load the floor map.",
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
      lastLoadedAt: null,
      context: { tenantId: null, branchId: null },
    }),
}));

/** True when the floor is old enough that a sensible lifecycle event should re-fetch. */
export function isFloorStale(lastLoadedAt: number | null, now: number): boolean {
  if (lastLoadedAt === null) return false;
  return now - lastLoadedAt > FLOOR_STALE_AFTER_MS;
}
