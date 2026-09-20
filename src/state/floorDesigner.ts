// Floor DESIGNER draft state (Phase 3A) — the editing counterpart of `useFloor`.
//
// STRICT BOUNDARY. This store owns the DRAFT and the editing session only:
//   * the parsed draft, the per-element geometry overrides the operator makes,
//     which element is selected, and the view transform;
//   * the editor LEASE (acquire / heartbeat / release / takeover) and the
//     read-only fallbacks when it is lost;
//   * the debounced, CAS-guarded AUTOSAVE and its visible status.
//
// It imports NONE of the operational POS stores. It never reads or writes a bill,
// an order, a shift, a payment, or the canonical table selection (`useTables`). A
// Designer edit changes geometry in a draft and can do nothing else — the one and
// only server call it can make on a table is the geometry autosave, which the
// server itself gates on the lease and the published-revision CAS.
//
// The published Service Floor keeps reading `floor_service_layout` throughout;
// unpublished edits here never touch it (Phase 3A has no publish at all).

import { create } from "zustand";
import {
  classifyFloorDesignerError,
  draftHasContent,
  floorAcquireLease,
  floorAutosaveDraft,
  floorHeartbeat,
  floorLoadDraft,
  floorLoadUnplaced,
  floorReleaseLease,
  floorTakeoverLease,
  serializeDraftDoc,
  type ElementGeom,
  type FloorDesignerError,
  type ParsedDraft,
  type UnplacedTable,
} from "@/lib/pos/floorDesigner";
import { resolveActiveSection } from "@/lib/pos/floorSections";
import type { FloorElement, FloorSection } from "@/lib/pos/floor";
import type { Transform } from "@/lib/pos/floorGeometry";

/** Heartbeat cadence — comfortably under the server's 150s lease TTL. */
export const FLOOR_HEARTBEAT_MS = 45_000;
/** Autosave debounce — one save settles after the operator pauses. */
export const FLOOR_AUTOSAVE_DEBOUNCE_MS = 900;

type Ctx = { tenantId: string | null; branchId: string | null };

/** Where the session is. `empty` = entitled+leaseless, nothing placed to edit. */
export type DesignerPhase = "idle" | "loading" | "ready" | "empty" | "busy" | "error";
export type SaveStatus = "idle" | "saving" | "saved" | "error";

type DesignerState = {
  ctx: Ctx;
  phase: DesignerPhase;
  error: FloorDesignerError | null;

  layoutId: string | null;
  sections: FloorSection[];
  activeSectionId: string | null;
  /** Draft elements with the operator's overrides already applied — render source. */
  elements: FloorElement[];
  selectedElementId: string | null;
  unplaced: UnplacedTable[];

  transform: Transform | null;

  /** CAS key echoed on every autosave — the live published revision at load. */
  baseRevisionId: string | null;
  canPublish: boolean;

  /** Read-only when the lease is lost or the live floor moved; edits are frozen. */
  readOnly: boolean;
  /** True when a prior holder's lease is EXPIRED and can be taken over. */
  canTakeover: boolean;

  saveStatus: SaveStatus;
  saveError: FloorDesignerError | null;
  /** True once at least one edit has been made and not yet confirmed saved. */
  dirty: boolean;

  leaseExpiresAt: string | null;

  enter: (ctx: Ctx) => Promise<void>;
  setActiveSection: (sectionId: string) => void;
  setTransform: (t: Transform) => void;
  requestFit: () => void;
  selectElement: (id: string | null) => void;
  /** Persist an absolute geometry for one element (the canvas computes it). */
  commitGeom: (id: string, geom: ElementGeom) => void;
  heartbeat: () => Promise<void>;
  takeover: () => Promise<void>;
  retrySave: () => void;
  release: () => Promise<void>;
  reset: () => void;
};

// Session-scoped timers. Module-level because the store is a singleton and these
// must be cleared deterministically on release/reset, never left to GC.
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function clearSaveTimer() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}

/** The draft, kept aside from render state so serialize is lossless. */
let currentDraft: ParsedDraft | null = null;
/** elementId → geometry override, the only thing an autosave persists. */
let overrides = new Map<string, ElementGeom>();

function applyOverrideToElements(elements: FloorElement[], id: string, geom: ElementGeom): FloorElement[] {
  return elements.map((e) => (e.id === id ? { ...e, ...geom } : e));
}

export const useFloorDesigner = create<DesignerState>((set, get) => {
  /** Serialize the current draft + overrides and autosave it, CAS-guarded. */
  const doAutosave = async () => {
    const s = get();
    if (!currentDraft || s.readOnly || !s.ctx.branchId) return;
    set({ saveStatus: "saving", saveError: null });
    try {
      const doc = serializeDraftDoc(currentDraft, overrides);
      await floorAutosaveDraft(s.ctx.branchId, doc, s.baseRevisionId);
      // Only clear dirty if no newer edit arrived while the request was in flight.
      set((cur) => (cur.saveStatus === "saving" ? { saveStatus: "saved", dirty: false } : {}));
    } catch (e) {
      const err = classifyFloorDesignerError(e);
      set({
        saveStatus: "error",
        saveError: err,
        readOnly: get().readOnly || err.readOnly,
      });
    }
  };

  const scheduleAutosave = () => {
    clearSaveTimer();
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void doAutosave();
    }, FLOOR_AUTOSAVE_DEBOUNCE_MS);
  };

  return {
    ctx: { tenantId: null, branchId: null },
    phase: "idle",
    error: null,
    layoutId: null,
    sections: [],
    activeSectionId: null,
    elements: [],
    selectedElementId: null,
    unplaced: [],
    transform: null,
    baseRevisionId: null,
    canPublish: false,
    readOnly: false,
    canTakeover: false,
    saveStatus: "idle",
    saveError: null,
    dirty: false,
    leaseExpiresAt: null,

    enter: async (ctx) => {
      clearSaveTimer();
      currentDraft = null;
      overrides = new Map();
      set({
        ctx,
        phase: "loading",
        error: null,
        selectedElementId: null,
        transform: null,
        readOnly: false,
        canTakeover: false,
        saveStatus: "idle",
        saveError: null,
        dirty: false,
      });

      try {
        const load = await floorLoadDraft(ctx.branchId);
        // Nothing placed → nothing to edit in Phase 3A (no create yet). Show the
        // empty state without taking a lease that would block another device.
        if (!draftHasContent(load.draft)) {
          set({
            phase: "empty",
            layoutId: load.layoutId,
            sections: load.draft?.sections ?? [],
            activeSectionId: null,
            elements: [],
            unplaced: load.unplaced,
            baseRevisionId: load.publishedRevisionId,
            canPublish: load.canPublish,
          });
          return;
        }

        currentDraft = load.draft;
        // Take the single editor lease. BUSY means another device holds it.
        try {
          const lease = await floorAcquireLease(ctx.branchId);
          set({ leaseExpiresAt: lease.expiresAt });
        } catch (e) {
          const err = classifyFloorDesignerError(e);
          if (err.kind === "busy") {
            set({ phase: "busy", error: err, canTakeover: true, sections: load.draft!.sections });
            return;
          }
          throw e;
        }

        const draft = load.draft!;
        const activeSectionId = resolveActiveSection(draft.sections, null);
        // The unplaced list, re-read authoritatively for the shell indicator.
        let unplaced = load.unplaced;
        try {
          unplaced = await floorLoadUnplaced(ctx.branchId);
        } catch {
          // Non-fatal: fall back to the count the draft load already returned.
        }
        set({
          phase: "ready",
          layoutId: load.layoutId,
          sections: draft.sections,
          activeSectionId,
          elements: draft.elements,
          unplaced,
          baseRevisionId: load.publishedRevisionId,
          canPublish: load.canPublish,
          readOnly: false,
        });
      } catch (e) {
        set({ phase: "error", error: classifyFloorDesignerError(e) });
      }
    },

    setActiveSection: (sectionId) => {
      if (sectionId === get().activeSectionId) return;
      // A new section is a new plane — drop the transform to re-fit, clear select.
      set({ activeSectionId: sectionId, transform: null, selectedElementId: null });
    },

    setTransform: (t) => set({ transform: t }),
    requestFit: () => set({ transform: null }),

    // Selection is allowed even read-only (to inspect a table); it is the geometry
    // COMMIT that `readOnly` freezes, not the highlight.
    selectElement: (id) => set({ selectedElementId: id }),

    commitGeom: (id, geom) => {
      const s = get();
      // Frozen sessions never write; a stray gesture cannot resurrect editing.
      if (s.readOnly) return;
      if (!s.elements.some((e) => e.id === id)) return;
      overrides.set(id, geom);
      set({
        elements: applyOverrideToElements(s.elements, id, geom),
        selectedElementId: id,
        dirty: true,
        saveStatus: "idle",
      });
      scheduleAutosave();
    },

    heartbeat: async () => {
      const s = get();
      if (s.phase !== "ready" || s.readOnly || !s.ctx.branchId) return;
      try {
        const r = await floorHeartbeat(s.ctx.branchId);
        set({ leaseExpiresAt: r.expiresAt });
      } catch (e) {
        const err = classifyFloorDesignerError(e);
        // Lease lost: freeze editing but keep the operator's work on screen.
        set({ readOnly: true, error: err, canTakeover: err.kind === "busy" });
      }
    },

    takeover: async () => {
      const s = get();
      if (!s.ctx.branchId) return;
      set({ phase: "loading", error: null });
      try {
        await floorTakeoverLease(s.ctx.branchId);
        await get().enter(s.ctx);
      } catch (e) {
        const err = classifyFloorDesignerError(e);
        set({ phase: "busy", error: err, canTakeover: err.kind === "busy" });
      }
    },

    retrySave: () => {
      if (get().readOnly) return;
      set({ saveError: null });
      void doAutosave();
    },

    release: async () => {
      clearSaveTimer();
      const s = get();
      // Flush a pending edit before handing back the lease, so the last keystrokes
      // inside the debounce window are never lost on the way out.
      if (s.dirty && !s.readOnly && currentDraft && s.ctx.branchId) {
        try {
          await floorAutosaveDraft(s.ctx.branchId, serializeDraftDoc(currentDraft, overrides), s.baseRevisionId);
        } catch {
          // ignore — a failed final save leaves the earlier autosaved draft intact.
        }
      }
      // Best-effort: a failed release just lets the lease lapse after its TTL.
      if (s.ctx.branchId && (s.phase === "ready" || s.readOnly)) {
        try {
          await floorReleaseLease(s.ctx.branchId);
        } catch {
          // ignore — the lease expires on its own.
        }
      }
      get().reset();
    },

    reset: () => {
      clearSaveTimer();
      currentDraft = null;
      overrides = new Map();
      set({
        ctx: { tenantId: null, branchId: null },
        phase: "idle",
        error: null,
        layoutId: null,
        sections: [],
        activeSectionId: null,
        elements: [],
        selectedElementId: null,
        unplaced: [],
        transform: null,
        baseRevisionId: null,
        canPublish: false,
        readOnly: false,
        canTakeover: false,
        saveStatus: "idle",
        saveError: null,
        dirty: false,
        leaseExpiresAt: null,
      });
    },
  };
});

/** Test-only: the live overrides map, for asserting geometry commits. */
export function __designerOverrides(): ReadonlyMap<string, ElementGeom> {
  return overrides;
}
