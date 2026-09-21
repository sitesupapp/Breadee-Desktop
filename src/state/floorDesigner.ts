// Floor DESIGNER draft state (Phases 3A + 3B) — the editing counterpart of
// `useFloor`.
//
// STRICT BOUNDARY. This store owns the DRAFT and the editing session only:
//   * the parsed draft, the operator's EDITS on top of it (geometry, staged
//     renames, shapes, placements, removals, staged new-table intents, section
//     add/rename/safe-delete), which element is selected, and the view transform;
//   * READ-ONLY canonical table metadata ({id, name, seats}) so the editor can
//     say what a table is CALLED — never what it is doing;
//   * the editor LEASE (acquire / heartbeat / release / takeover) and the
//     read-only fallbacks when it is lost;
//   * the debounced, CAS-guarded AUTOSAVE and its visible status. EVERY edit
//     kind flows through the same single serialize→autosave path — there is no
//     second save mechanism.
//
// It imports NONE of the operational POS stores. It never reads or writes a
// bill, an order, a shift, a payment, or the canonical table selection
// (`useTables`). A Designer edit changes a draft; canonical tables are created
// or renamed ONLY by a future server-side PUBLISH, which this store never calls.
//
// The published Service Floor keeps reading `floor_service_layout` throughout;
// unpublished edits here never touch it.

import { create } from "zustand";
import {
  applySize,
  classifyFloorDesignerError,
  draftEditsCount,
  effectiveDraft,
  emptyDraftEdits,
  floorAcquireLease,
  floorAutosaveDraft,
  floorHeartbeat,
  floorLoadDraft,
  floorLoadTableMeta,
  floorLoadUnplaced,
  floorReleaseLease,
  floorTakeoverLease,
  geomOf,
  makePlacedElement,
  makeSection,
  makeTempTableElement,
  MAX_ELEMENTS,
  MAX_SECTIONS,
  nextPlacementGeom,
  serializeDraftDoc,
  validateSeats,
  validateSectionName,
  validateTableName,
  type DesignerElement,
  type DraftEdits,
  type ElementGeom,
  type FloorDesignerError,
  type ParsedDraft,
  type TableMeta,
  type UnplacedTable,
} from "@/lib/pos/floorDesigner";
import { resolveActiveSection } from "@/lib/pos/floorSections";
import { sectionPlane } from "@/lib/pos/floorGeometry";
import type { FloorSection, FloorTableShape } from "@/lib/pos/floor";
import type { Transform } from "@/lib/pos/floorGeometry";

/** Heartbeat cadence — comfortably under the server's 150s lease TTL. */
export const FLOOR_HEARTBEAT_MS = 45_000;
/** Autosave debounce — one save settles after the operator pauses. */
export const FLOOR_AUTOSAVE_DEBOUNCE_MS = 900;

type Ctx = { tenantId: string | null; branchId: string | null };

/** Where the session is. `empty` = this branch has no floor document at all. */
export type DesignerPhase = "idle" | "loading" | "ready" | "empty" | "busy" | "error";
export type SaveStatus = "idle" | "saving" | "saved" | "error";

/** The answer to an operation the UI must explain when refused. */
export type OpResult = { ok: boolean; reason: string | null };

const OK: OpResult = { ok: true, reason: null };
const refuse = (reason: string): OpResult => ({ ok: false, reason });

type DesignerState = {
  ctx: Ctx;
  phase: DesignerPhase;
  error: FloorDesignerError | null;

  layoutId: string | null;
  sections: FloorSection[];
  activeSectionId: string | null;
  /** The draft WITH the operator's edits applied — the render source. */
  elements: DesignerElement[];
  /** The PRIMARY selection (last selected) — the Inspector's subject. */
  selectedElementId: string | null;
  /**
   * Multi-selection (Phase 3C), in selection ORDER; the last entry is the
   * primary/reference element. Bulk tools operate on the TABLE members.
   */
  selectedIds: string[];
  /** Canonical tables not currently placed on the draft (derived). */
  unplaced: UnplacedTable[];
  /** Read-only canonical identity: table id → {name, seats}. */
  tableMeta: Map<string, TableMeta>;

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
  /** Ctrl/Cmd+click: toggle a TABLE in the multi-selection (structures single-select). */
  toggleSelect: (id: string) => void;

  /** Persist an absolute geometry for one element (the canvas computes it). */
  commitGeom: (id: string, geom: ElementGeom) => void;
  /** Persist geometries for SEVERAL elements as ONE mutation → ONE autosave. */
  commitGeoms: (entries: [string, ElementGeom][]) => void;
  /** Discard a staged rename without needing the canonical name (legacy safety). */
  discardRename: (id: string) => void;
  /** Inspector size steppers — explicit logical dimensions. */
  setElementSize: (id: string, w: number, h: number) => void;
  setElementRotation: (id: string, rotation: number) => void;
  setElementShape: (id: string, shape: FloorTableShape) => void;
  /** Seats for a staged NEW table only — existing-table seats are read-only. */
  setTableSeats: (id: string, seats: number) => void;
  /** Staged rename of an EXISTING table, or editing a NEW table's name. */
  renameTable: (id: string, name: string) => OpResult;
  /** Layout-only removal — never deactivates or deletes a canonical table. */
  removeElement: (id: string) => void;
  /** Place an EXISTING canonical table into the active section (draft-only). */
  placeTable: (tableId: string) => OpResult;
  /** Stage a NEW table intent (draft-only; created canonically at publish). */
  addTable: (name: string, seats: number) => OpResult;
  addSection: (name: string) => OpResult;
  renameSection: (sectionId: string, name: string) => OpResult;
  /** Safe delete: refused (with the reason) unless the section is empty. */
  deleteSection: (sectionId: string) => OpResult;

  heartbeat: () => Promise<void>;
  takeover: () => Promise<void>;
  retrySave: () => void;
  release: () => Promise<void>;
  reset: () => void;
};

// Session-scoped mutable context. Module-level because the store is a singleton
// and these must be reset deterministically on release/reset.
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let currentDraft: ParsedDraft | null = null;
let edits: DraftEdits = emptyDraftEdits();
/**
 * Every canonical table that COULD sit on this floor: the server's unplaced
 * list at entry plus the tables already placed in the draft (with their
 * read-only metadata). The visible tray is derived from this pool minus
 * whatever the effective draft currently places.
 */
let unplacedPool: Map<string, UnplacedTable> = new Map();

function clearSaveTimer() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}

function placedTableIdSet(elements: DesignerElement[]): Set<string> {
  const out = new Set<string>();
  for (const e of elements) if (e.type === "table" && e.tableId) out.add(e.tableId);
  return out;
}

function deriveUnplaced(elements: DesignerElement[]): UnplacedTable[] {
  const placed = placedTableIdSet(elements);
  return [...unplacedPool.values()]
    .filter((t) => !placed.has(t.id))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const useFloorDesigner = create<DesignerState>((set, get) => {
  /** Serialize the current draft + edits and autosave it, CAS-guarded. */
  const doAutosave = async () => {
    const s = get();
    if (!currentDraft || s.readOnly || !s.ctx.branchId) return;
    set({ saveStatus: "saving", saveError: null });
    try {
      const doc = serializeDraftDoc(currentDraft, edits);
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

  /**
   * THE single mutation funnel. Applies one change to `edits`, recomputes the
   * effective render state, marks dirty and schedules the one debounced
   * autosave. Every Phase 3B operation goes through here — no second save path.
   */
  const mutate = (change: () => void, after?: (elements: DesignerElement[]) => void): boolean => {
    const s = get();
    if (s.readOnly || !currentDraft) return false;
    change();
    const eff = effectiveDraft(currentDraft, edits);
    const activeSectionId = resolveActiveSection(eff.sections, get().activeSectionId);
    set({
      sections: eff.sections,
      elements: eff.elements,
      unplaced: deriveUnplaced(eff.elements),
      activeSectionId,
      dirty: true,
      saveStatus: "idle",
    });
    after?.(eff.elements);
    scheduleAutosave();
    return true;
  };

  const elementById = (id: string): DesignerElement | undefined => get().elements.find((e) => e.id === id);
  const addedRecordById = (id: string): Record<string, unknown> | undefined =>
    edits.added.find((r) => r.id === id);

  return {
    ctx: { tenantId: null, branchId: null },
    phase: "idle",
    error: null,
    layoutId: null,
    sections: [],
    activeSectionId: null,
    elements: [],
    selectedElementId: null,
    selectedIds: [],
    unplaced: [],
    tableMeta: new Map(),
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
      edits = emptyDraftEdits();
      unplacedPool = new Map();
      set({
        ctx,
        phase: "loading",
        error: null,
        selectedElementId: null,
        selectedIds: [],
        transform: null,
        readOnly: false,
        canTakeover: false,
        saveStatus: "idle",
        saveError: null,
        dirty: false,
        tableMeta: new Map(),
      });

      try {
        const load = await floorLoadDraft(ctx.branchId);
        // No draft document at all → nothing to edit yet (a branch that never
        // published). A draft WITH sections but no tables is editable: the tray
        // is exactly how tables get onto it.
        if (load.draft === null) {
          set({
            phase: "empty",
            layoutId: load.layoutId,
            sections: [],
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
            set({ phase: "busy", error: err, canTakeover: true, sections: load.draft.sections });
            return;
          }
          throw e;
        }

        const draft = load.draft;
        const activeSectionId = resolveActiveSection(draft.sections, null);

        // Read-only canonical identity + the authoritative unplaced list. Both
        // are non-fatal: a failed read falls back to what floor_draft returned
        // (and to shapes without names, which still edit correctly).
        let unplaced = load.unplaced;
        let meta = new Map<string, TableMeta>();
        try {
          [unplaced, meta] = await Promise.all([
            floorLoadUnplaced(ctx.branchId),
            floorLoadTableMeta(ctx.branchId),
          ]);
        } catch {
          try {
            meta = await floorLoadTableMeta(ctx.branchId);
          } catch {
            // names stay unavailable; identity falls back to labels.
          }
        }

        // The placement pool: server-unplaced ∪ already-placed (with metadata).
        unplacedPool = new Map(unplaced.map((t) => [t.id, t]));
        for (const el of draft.elements) {
          if (el.type === "table" && el.tableId && !unplacedPool.has(el.tableId)) {
            const m = meta.get(el.tableId);
            unplacedPool.set(el.tableId, {
              id: el.tableId,
              name: m?.name ?? el.label ?? "",
              seats: m?.seats ?? null,
            });
          }
        }

        set({
          phase: "ready",
          layoutId: load.layoutId,
          sections: draft.sections,
          activeSectionId,
          elements: draft.elements,
          unplaced: deriveUnplaced(draft.elements),
          tableMeta: meta,
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
      set({ activeSectionId: sectionId, transform: null, selectedElementId: null, selectedIds: [] });
    },

    setTransform: (t) => set({ transform: t }),
    requestFit: () => set({ transform: null }),

    // Selection is allowed even read-only (to inspect a table); it is the edit
    // COMMIT that `readOnly` freezes, not the highlight.
    selectElement: (id) => set({ selectedElementId: id, selectedIds: id === null ? [] : [id] }),

    toggleSelect: (id) => {
      const el = elementById(id);
      if (!el) return;
      // Multi-selection is a TABLE tool; toggling a structure single-selects it.
      if (el.type !== "table") {
        set({ selectedElementId: id, selectedIds: [id] });
        return;
      }
      const cur = get().selectedIds.filter((s) => get().elements.some((e) => e.id === s));
      const next = cur.includes(id) ? cur.filter((s) => s !== id) : [...cur, id];
      set({ selectedIds: next, selectedElementId: next.length > 0 ? next[next.length - 1] : null });
    },

    commitGeom: (id, geom) => {
      if (!elementById(id)) return;
      mutate(() => {
        edits.geom.set(id, geom);
      });
      const cur = get().selectedIds;
      set({ selectedElementId: id, selectedIds: cur.includes(id) ? cur : [id] });
    },

    commitGeoms: (entries) => {
      const valid = entries.filter(([id]) => elementById(id));
      if (valid.length === 0) return;
      // ONE mutation for the whole group → one recompute, one debounced autosave.
      mutate(() => {
        for (const [id, geom] of valid) edits.geom.set(id, geom);
      });
    },

    discardRename: (id) => {
      const el = elementById(id);
      if (!el || el.type !== "table" || el.renameTo === null) return;
      mutate(() => {
        const raw = currentDraft?.rawElements.find((r) => r.id === id);
        if (raw && "rename_to" in raw) edits.renames.set(id, null);
        else edits.renames.delete(id);
      });
    },

    setElementSize: (id, w, h) => {
      const el = elementById(id);
      if (!el) return;
      mutate(() => {
        edits.geom.set(id, applySize(geomOf(el), w, h));
      });
    },

    setElementRotation: (id, rotation) => {
      const el = elementById(id);
      if (!el) return;
      const r = ((Math.round(rotation) % 360) + 360) % 360;
      mutate(() => {
        edits.geom.set(id, { ...geomOf(el), rotation: r });
      });
    },

    setElementShape: (id, shape) => {
      const el = elementById(id);
      if (!el || el.type !== "table") return;
      mutate(() => {
        const added = addedRecordById(id);
        if (added) added.shape = shape;
        else edits.shapes.set(id, shape);
      });
    },

    setTableSeats: (id, seats) => {
      const el = elementById(id);
      // Existing canonical tables keep their seats — the publish contract has no
      // seats update for them, so the Designer refuses to pretend otherwise.
      if (!el || el.tempId === null) return;
      if (validateSeats(seats)) return;
      mutate(() => {
        const added = addedRecordById(id);
        if (added) added.seats = seats;
      });
    },

    renameTable: (id, name) => {
      const el = elementById(id);
      if (!el || el.type !== "table") return refuse("Select a table first.");
      const invalid = validateTableName(name);
      if (invalid) return refuse(invalid);
      const trimmed = name.trim();

      const applied = mutate(() => {
        const added = addedRecordById(id);
        if (added && el.tempId) {
          // A staged NEW table: its name IS `new_name` — no rename indirection.
          added.new_name = trimmed;
          return;
        }
        // An existing canonical table: stage `rename_to`; the canonical name
        // changes only at a future PUBLISH. Typing the current canonical name
        // back clears the staged rename instead of storing a no-op.
        const canonical = el.tableId ? get().tableMeta.get(el.tableId)?.name ?? null : null;
        if (canonical !== null && canonical.trim().toLowerCase() === trimmed.toLowerCase()) {
          if (el.renameTo !== null) edits.renames.set(id, null);
          else edits.renames.delete(id);
        } else {
          edits.renames.set(id, trimmed);
        }
      });
      return applied ? OK : refuse("Editing is paused.");
    },

    removeElement: (id) => {
      const el = elementById(id);
      if (!el) return;
      mutate(() => {
        const idx = edits.added.findIndex((r) => r.id === id);
        if (idx >= 0) {
          // Created this session — discard the record and any edits on it.
          edits.added.splice(idx, 1);
        } else {
          edits.removed.add(id);
        }
        edits.geom.delete(id);
        edits.shapes.delete(id);
        edits.renames.delete(id);
      });
      // An existing canonical table returns to the tray via the derived
      // unplaced list; the canonical row itself is NEVER touched.
      set({ selectedElementId: null, selectedIds: [] });
    },

    placeTable: (tableId) => {
      const s = get();
      const sectionId = s.activeSectionId;
      if (!sectionId) return refuse("Choose a section first.");
      if (placedTableIdSet(s.elements).has(tableId)) return refuse("That table is already on the floor.");
      if (s.elements.length >= MAX_ELEMENTS) return refuse("This floor has reached its element limit.");

      const section = s.sections.find((sec) => sec.id === sectionId) ?? null;
      const sectionEls = s.elements.filter((e) => e.sectionId === sectionId);
      const geom = nextPlacementGeom(sectionEls, sectionPlane(section, sectionEls));
      const record = makePlacedElement(tableId, sectionId, geom);
      const applied = mutate(() => {
        edits.added.push(record);
      });
      if (applied) set({ selectedElementId: String(record.id), selectedIds: [String(record.id)] });
      return applied ? OK : refuse("Editing is paused.");
    },

    addTable: (name, seats) => {
      const s = get();
      const sectionId = s.activeSectionId;
      if (!sectionId) return refuse("Choose a section first.");
      const badName = validateTableName(name);
      if (badName) return refuse(badName);
      const badSeats = validateSeats(seats);
      if (badSeats) return refuse(badSeats);
      if (s.elements.length >= MAX_ELEMENTS) return refuse("This floor has reached its element limit.");

      const section = s.sections.find((sec) => sec.id === sectionId) ?? null;
      const sectionEls = s.elements.filter((e) => e.sectionId === sectionId);
      const geom = nextPlacementGeom(sectionEls, sectionPlane(section, sectionEls));
      const record = makeTempTableElement(name.trim(), seats, sectionId, geom);
      const applied = mutate(() => {
        edits.added.push(record);
      });
      if (applied) set({ selectedElementId: String(record.id), selectedIds: [String(record.id)] });
      return applied ? OK : refuse("Editing is paused.");
    },

    addSection: (name) => {
      const s = get();
      const invalid = validateSectionName(name);
      if (invalid) return refuse(invalid);
      if (s.sections.length >= MAX_SECTIONS) return refuse("This floor has reached its section limit.");
      const maxSort = s.sections.reduce((m, sec) => Math.max(m, sec.sort ?? 0), 0);
      const record = makeSection(name.trim(), maxSort + 1);
      const applied = mutate(() => {
        edits.sectionAdds.push(record);
      });
      if (applied) get().setActiveSection(String(record.id));
      return applied ? OK : refuse("Editing is paused.");
    },

    renameSection: (sectionId, name) => {
      const invalid = validateSectionName(name);
      if (invalid) return refuse(invalid);
      const applied = mutate(() => {
        const added = edits.sectionAdds.find((r) => r.id === sectionId);
        if (added) added.name = name.trim();
        else edits.sectionRenames.set(sectionId, name.trim());
      });
      return applied ? OK : refuse("Editing is paused.");
    },

    deleteSection: (sectionId) => {
      const s = get();
      if (s.sections.length <= 1) return refuse("A floor needs at least one section.");
      const inSection = s.elements.filter((e) => e.sectionId === sectionId).length;
      if (inSection > 0) {
        // NEVER silently orphan or delete what is in the section.
        return refuse(
          inSection === 1
            ? "Move or remove the 1 item in this section first."
            : `Move or remove the ${inSection} items in this section first.`,
        );
      }
      const applied = mutate(() => {
        const idx = edits.sectionAdds.findIndex((r) => r.id === sectionId);
        if (idx >= 0) edits.sectionAdds.splice(idx, 1);
        else edits.sectionRemoves.add(sectionId);
        edits.sectionRenames.delete(sectionId);
      });
      return applied ? OK : refuse("Editing is paused.");
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
      // Flush a pending edit before handing back the lease, so the last changes
      // inside the debounce window are never lost on the way out.
      if (s.dirty && !s.readOnly && currentDraft && s.ctx.branchId) {
        try {
          await floorAutosaveDraft(s.ctx.branchId, serializeDraftDoc(currentDraft, edits), s.baseRevisionId);
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
      edits = emptyDraftEdits();
      unplacedPool = new Map();
      set({
        ctx: { tenantId: null, branchId: null },
        phase: "idle",
        error: null,
        layoutId: null,
        sections: [],
        activeSectionId: null,
        elements: [],
        selectedElementId: null,
        selectedIds: [],
        unplaced: [],
        tableMeta: new Map(),
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

/** Test-only: the live edits object, for asserting the single-path model. */
export function __designerEdits(): DraftEdits {
  return edits;
}

/** Test-only: how many edits are pending (all kinds, one model). */
export function __designerEditsCount(): number {
  return draftEditsCount(edits);
}
