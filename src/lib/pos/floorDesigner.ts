// The Dine-In Floor DESIGNER (Phases 3A + 3B), against the Phase-1 staging
// contract. This is the EDIT side of the floor; `lib/pos/floor.ts` is the read
// side. The two never share state.
//
// WHAT THIS OWNS (pure, testable, no React, no DOM):
//   * the DRAFT document contract — load, parse for rendering, and serialize back
//     WITHOUT losing anything this build does not model (an unknown element kind,
//     an extra field on a known element). Editing a floor must never silently
//     drop part of it, so raw element/section records are preserved verbatim and
//     only the fields the operator actually edited are overwritten on save.
//   * the EDITS model (Phase 3B): geometry, staged table RENAME (`rename_to`),
//     shape, placing an existing table, removing an element from the layout,
//     staged NEW-TABLE intents (`temp:` + `new_name` + `seats`), and section
//     add / rename / safe-delete. All of it is draft-only; the server materializes
//     renames and creations only at a future PUBLISH, which this phase never calls.
//   * the geometry of an edit — drag / resize / rotate — as plain transforms of
//     numbers in intrinsic LOGICAL units.
//   * the read-only TABLE METADATA adapter: canonical `{id, name, seats}` from
//     `pos_table_map`, projected immediately so no operational state (bills,
//     orders, payments, elapsed) ever enters the Designer.
//   * the server error → friendly state mapping, and the thin RPC boundary for
//     the Phase-1 draft/lease RPCs.
//
// WHAT THIS DOES NOT OWN: orders, bills, payments, shifts, table operational
// status, the canonical table selection. Those belong to `useTables` and the POS
// stores, and this module imports none of them. A Designer edit changes a draft;
// it can never open, pay, move, close, create or rename a canonical table.

import {
  asRecord,
  bool,
  callPosRpc,
  num,
  numOrNull,
  str,
  strOrNull,
} from "@/lib/pos/rpc";
import {
  parseFloorElement,
  sortSections,
  type FloorElement,
  type FloorSection,
  type FloorTableShape,
} from "@/lib/pos/floor";
import { loadTableMap } from "@/lib/pos/tables";

/** The smallest a table may be resized to, in intrinsic LOGICAL units. */
export const MIN_ELEMENT_LOGICAL = 24;
/** Rotation snaps to this increment — a clean angle without a protractor UI. */
export const ROTATE_SNAP_DEG = 15;

// Server contract limits (recertified 2026-09-21 from `_floor_validate_doc` /
// `_floor_apply_create`): mirrored here so the UI can refuse gently BEFORE an
// autosave round-trip. The server re-enforces every one of them.
export const TABLE_NAME_MAX = 40;
export const SECTION_NAME_MAX = 60;
export const SEATS_MIN = 1;
export const SEATS_MAX = 50;
export const MAX_SECTIONS = 40;
export const MAX_ELEMENTS = 1000;

// --- The draft document ------------------------------------------------------

/** The mutable geometry of one element. */
export type ElementGeom = {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 0–359 integer. */
  rotation: number;
};

/**
 * A DESIGNER element — the reader's `FloorElement` plus the draft-only fields the
 * editor must see. Unlike the Service reader (which drops a table with no
 * canonical id), the Designer KEEPS staged new-table intents: `tempId` carries
 * the `temp:` identity, `newName`/`seats` the staged creation, and `renameTo`
 * the staged rename of an existing table.
 */
export type DesignerElement = FloorElement & {
  tempId: string | null;
  newName: string | null;
  seats: number | null;
  renameTo: string | null;
};

/**
 * A parsed draft: sections and renderable elements PLUS the untouched raw
 * records so a save can round-trip everything this build does not model.
 * `rawDoc`/`rawElements`/`rawSections` are the source of truth for
 * serialization; the parsed views are the source of truth for rendering.
 */
export type ParsedDraft = {
  version: string;
  sections: FloorSection[];
  elements: DesignerElement[];
  /** The document exactly as received, kept for lossless serialization. */
  rawDoc: Record<string, unknown>;
  rawElements: Record<string, unknown>[];
  rawSections: Record<string, unknown>[];
};

/** The lease state as `floor_draft` reports it. */
export type LeaseInfo = {
  ownerIsMe: boolean;
  active: boolean;
  lastSeenAt: string | null;
  expiresAt: string | null;
};

/** One unplaced table — a canonical table not present on the draft floor. */
export type UnplacedTable = {
  id: string;
  name: string;
  seats: number | null;
};

/** Canonical table metadata, projected read-only for the editor. */
export type TableMeta = {
  id: string;
  name: string;
  seats: number | null;
};

/** The whole `floor_draft` response, parsed. */
export type DraftLoad = {
  layoutId: string | null;
  /** null when this branch has never drafted or published a floor. */
  draft: ParsedDraft | null;
  draftHash: string | null;
  /** The CAS key every autosave/publish must echo — the live published revision. */
  publishedRevisionId: string | null;
  /** The base the draft was taken from (may lag the published revision). */
  draftBaseRevisionId: string | null;
  canPublish: boolean;
  unplaced: UnplacedTable[];
  lease: LeaseInfo | null;
};

// --- Phase 4 PUBLISH lifecycle types -----------------------------------------

/** One canonical table the server CREATED at publish, mapped from its temp intent. */
export type PublishedCreate = { tempId: string; tableId: string };
/** One canonical table the server RENAMED at publish. */
export type PublishedRename = { tableId: string; name: string };

/** The `floor_publish` result — what the server actually did, materialized. */
export type PublishResult = {
  ok: boolean;
  revisionId: string | null;
  revisionNo: number | null;
  created: PublishedCreate[];
  renamed: PublishedRename[];
};

/** One immutable published revision, as `floor_history` reports it (metadata only). */
export type HistoryEntry = {
  revisionId: string;
  revisionNo: number;
  publishedAt: string | null;
  publishedBy: string | null;
  /** Server change summary: table count, and how many were created / renamed. */
  tables: number | null;
  createdCount: number | null;
  renamedCount: number | null;
  /** Set when this revision was published from a restore of an earlier one. */
  restoredFromRevisionId: string | null;
  /** True for the revision the Service Floor is currently serving. */
  isCurrent: boolean;
};

/** The `floor_restore_revision` result — a DRAFT was loaded, nothing published. */
export type RestoreResult = { ok: boolean; restoredFrom: string | null; revisionNo: number | null };

const EMPTY_DOC: Record<string, unknown> = { v: "1", sections: [], elements: [] };

/** Parse one draft element for the DESIGNER — keeps staged temp tables. */
export function parseDesignerElement(raw: unknown): DesignerElement | null {
  const r = asRecord(raw);
  const base = parseFloorElement(raw);
  if (base) {
    return {
      ...base,
      tempId: null,
      newName: null,
      seats: numOrNull(r.seats),
      renameTo: strOrNull(r.rename_to),
    };
  }
  // The reader refuses a table with no canonical id; the Designer keeps it WHEN
  // it is a well-formed staged intent (`temp:` identity + geometry). Anything
  // else stays unrenderable (and untouched in the raw records).
  if (str(r.type) !== "table") return null;
  const id = strOrNull(r.id);
  const sectionId = strOrNull(r.section_id);
  const tempId = strOrNull(r.temp_id);
  const x = numOrNull(r.x);
  const y = numOrNull(r.y);
  const w = numOrNull(r.w);
  const h = numOrNull(r.h);
  if (!id || !sectionId || !tempId || x === null || y === null || w === null || h === null) return null;
  if (w <= 0 || h <= 0) return null;
  const shapeRaw = strOrNull(r.shape);
  return {
    id,
    sectionId,
    type: "table",
    x,
    y,
    w,
    h,
    rotation: normalizeRotation(numOrNull(r.rotation) ?? 0),
    shape: (shapeRaw as FloorTableShape | null) ?? null,
    tableId: null,
    label: strOrNull(r.label),
    tempId,
    newName: strOrNull(r.new_name),
    seats: numOrNull(r.seats),
    renameTo: null,
  };
}

/** A draft section parse — mirrors the reader's, kept local so `floor.ts` is untouched. */
function parseDraftSection(raw: unknown): FloorSection | null {
  const r = asRecord(raw);
  const id = strOrNull(r.id);
  if (!id) return null;
  const w = numOrNull(r.w);
  const h = numOrNull(r.h);
  return {
    id,
    name: str(r.name),
    sort: numOrNull(r.sort),
    w: w !== null && w > 0 ? w : null,
    h: h !== null && h > 0 ? h : null,
  };
}

/** Parse a raw draft document into a lossless, renderable `ParsedDraft`. */
export function parseDraftDoc(docRaw: unknown): ParsedDraft {
  const doc = asRecord(docRaw);
  const version = str(doc.v, "1");
  const rawSectionsIn = Array.isArray(doc.sections) ? doc.sections : [];
  const rawElementsIn = Array.isArray(doc.elements) ? doc.elements : [];

  const rawSections = rawSectionsIn.filter(
    (s): s is Record<string, unknown> => !!s && typeof s === "object" && !Array.isArray(s),
  );
  const rawElements = rawElementsIn.filter(
    (e): e is Record<string, unknown> => !!e && typeof e === "object" && !Array.isArray(e),
  );

  const sections = sortSections(
    rawSections.map(parseDraftSection).filter((s): s is FloorSection => s !== null),
  );
  const validSectionIds = new Set(sections.map((s) => s.id));
  const elements = rawElements
    .map(parseDesignerElement)
    .filter((e): e is DesignerElement => e !== null)
    .filter((e) => validSectionIds.has(e.sectionId));

  return {
    version,
    sections,
    elements,
    rawDoc: { ...EMPTY_DOC, ...doc },
    rawElements,
    rawSections,
  };
}

// --- The edits model (Phase 3B) ----------------------------------------------

/**
 * Every change the operator has made on top of the loaded draft, applied at
 * serialization time. ONE edits object, ONE serializer, ONE autosave path — a
 * rename, a placement, a removal and a new-table intent all ride the same
 * debounced, lease-held, CAS-guarded `floor_autosave_draft` that Phase 3A
 * shipped. Removals win over field edits; `added` records are full raw element
 * records (they were created by this build, so there is nothing unknown in
 * them to lose).
 */
export type DraftEdits = {
  geom: Map<string, ElementGeom>;
  /** element id → staged rename (null clears a staged rename). Existing tables only. */
  renames: Map<string, string | null>;
  shapes: Map<string, FloorTableShape>;
  /** element id → structure label/text edit (Phase 3D-B). Applied verbatim. */
  labels: Map<string, string>;
  /** Full raw records created this session: temp intents, placed existing tables, structures. */
  added: Record<string, unknown>[];
  removed: Set<string>;
  sectionAdds: Record<string, unknown>[];
  sectionRenames: Map<string, string>;
  sectionRemoves: Set<string>;
};

export function emptyDraftEdits(): DraftEdits {
  return {
    geom: new Map(),
    renames: new Map(),
    shapes: new Map(),
    labels: new Map(),
    added: [],
    removed: new Set(),
    sectionAdds: [],
    sectionRenames: new Map(),
    sectionRemoves: new Set(),
  };
}

export function draftEditsCount(e: DraftEdits): number {
  return (
    e.geom.size + e.renames.size + e.shapes.size + e.labels.size + e.added.length + e.removed.size +
    e.sectionAdds.length + e.sectionRenames.size + e.sectionRemoves.size
  );
}

function applyElementEdits(raw: Record<string, unknown>, edits: DraftEdits): Record<string, unknown> {
  const id = strOrNull(raw.id);
  if (!id) return raw;
  let out = raw;
  const geom = edits.geom.get(id);
  if (geom) out = { ...out, x: geom.x, y: geom.y, w: geom.w, h: geom.h, rotation: geom.rotation };
  const shape = edits.shapes.get(id);
  if (shape) out = { ...out, shape };
  // Structure label/text edit (Phase 3D-B): an empty string clears the label so
  // it is not serialized as a stray field.
  if (edits.labels.has(id)) {
    const label = edits.labels.get(id) ?? "";
    if (label.length === 0) {
      out = { ...out };
      delete (out as Record<string, unknown>).label;
    } else {
      out = { ...out, label };
    }
  }
  if (edits.renames.has(id)) {
    const to = edits.renames.get(id) ?? null;
    if (to === null) {
      out = { ...out };
      delete (out as Record<string, unknown>).rename_to;
    } else {
      out = { ...out, rename_to: to };
    }
  }
  return out;
}

/**
 * Serialize the loaded draft + the operator's edits back to a document,
 * preserving every element, section and field this build does not model.
 */
export function serializeDraftDoc(draft: ParsedDraft, edits: DraftEdits): Record<string, unknown> {
  const keep = (raw: Record<string, unknown>) => {
    const id = strOrNull(raw.id);
    return !(id && edits.removed.has(id));
  };
  const elements = [...draft.rawElements.filter(keep), ...edits.added.filter(keep)].map((raw) =>
    applyElementEdits(raw, edits),
  );

  const keepSection = (raw: Record<string, unknown>) => {
    const id = strOrNull(raw.id);
    return !(id && edits.sectionRemoves.has(id));
  };
  const sections = [...draft.rawSections.filter(keepSection), ...edits.sectionAdds.filter(keepSection)].map(
    (raw) => {
      const id = strOrNull(raw.id);
      const name = id ? edits.sectionRenames.get(id) : undefined;
      return name === undefined ? raw : { ...raw, name };
    },
  );

  return { ...draft.rawDoc, sections, elements };
}

/** The parsed render view of the draft WITH the edits applied — one source. */
export function effectiveDraft(draft: ParsedDraft, edits: DraftEdits): ParsedDraft {
  return parseDraftDoc(serializeDraftDoc(draft, edits));
}

/** True when a draft carries at least one renderable element to edit. */
export function draftHasContent(draft: ParsedDraft | null): boolean {
  return !!draft && draft.elements.length > 0;
}

// --- Element / section factories ---------------------------------------------

function randomToken(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** A fresh element id — unique within the doc, ≤64 chars. */
export function newElementId(): string {
  return `e-${randomToken()}`;
}

/** A fresh staged-table identity, matching the server's `^temp:[0-9a-zA-Z_-]{1,64}$`. */
export function newTempId(): string {
  return `temp:${randomToken()}`;
}

/** A fresh section id. */
export function newSectionId(): string {
  return `s-${randomToken()}`;
}

/** Place an EXISTING canonical table onto the draft. Same id, one element. */
export function makePlacedElement(
  tableId: string,
  sectionId: string,
  geom: ElementGeom,
  shape: FloorTableShape = "sq",
): Record<string, unknown> {
  return {
    id: newElementId(),
    type: "table",
    section_id: sectionId,
    table_id: tableId,
    shape,
    x: geom.x,
    y: geom.y,
    w: geom.w,
    h: geom.h,
    rotation: geom.rotation,
  };
}

/** A staged NEW-TABLE intent. Draft-only; the server creates the canonical row at PUBLISH. */
export function makeTempTableElement(
  name: string,
  seats: number,
  sectionId: string,
  geom: ElementGeom,
  shape: FloorTableShape = "sq",
): Record<string, unknown> {
  return {
    id: newElementId(),
    type: "table",
    section_id: sectionId,
    temp_id: newTempId(),
    new_name: name,
    seats,
    shape,
    x: geom.x,
    y: geom.y,
    w: geom.w,
    h: geom.h,
    rotation: geom.rotation,
  };
}

export function makeSection(name: string, sort: number): Record<string, unknown> {
  return { id: newSectionId(), name, sort };
}

/** The default name for a brand-new floor's first (and only) section. */
export const FIRST_FLOOR_SECTION_NAME = "Main";

/**
 * The minimal editable draft for a branch that has canonical tables but has
 * never drafted or published a floor. Exactly ONE default section and no
 * elements — the smallest document the server's autosave/publish validator
 * accepts (it requires >=1 section; `EMPTY_DOC` has none). First-floor bootstrap
 * enters the ordinary editing path with this so existing tables can be placed
 * and FIRST-published against `base_revision_id = null`; canonical tables are
 * still created only by the atomic server PUBLISH, never by opening the editor.
 */
export function makeInitialDraft(): ParsedDraft {
  return parseDraftDoc({ v: "1", sections: [makeSection(FIRST_FLOOR_SECTION_NAME, 0)], elements: [] });
}

/** Default footprint for a newly placed table, in logical units. */
export const DEFAULT_TABLE_GEOM = { w: 100, h: 100, rotation: 0 } as const;

/**
 * A sensible spot for the next placed table: near the section's centre, stepped
 * diagonally per existing element so consecutive placements never stack.
 */
export function nextPlacementGeom(
  sectionElements: DesignerElement[],
  plane: { x: number; y: number; w: number; h: number },
): ElementGeom {
  const step = 36;
  const n = sectionElements.length;
  const cx = plane.x + plane.w / 2 - DEFAULT_TABLE_GEOM.w / 2;
  const cy = plane.y + plane.h / 2 - DEFAULT_TABLE_GEOM.h / 2;
  return {
    x: cx + (n % 5) * step,
    y: cy + (Math.floor(n / 5) % 5) * step,
    w: DEFAULT_TABLE_GEOM.w,
    h: DEFAULT_TABLE_GEOM.h,
    rotation: DEFAULT_TABLE_GEOM.rotation,
  };
}

// --- Client-side validation (server limits, refused gently before the wire) --

export function validateTableName(name: string): string | null {
  const n = name.trim();
  if (n.length === 0) return "Give the table a name.";
  if (n.length > TABLE_NAME_MAX) return `Table names can be at most ${TABLE_NAME_MAX} characters.`;
  return null;
}

export function validateSeats(seats: number): string | null {
  if (!Number.isInteger(seats) || seats < SEATS_MIN || seats > SEATS_MAX) {
    return `Seats must be between ${SEATS_MIN} and ${SEATS_MAX}.`;
  }
  return null;
}

export function validateSectionName(name: string): string | null {
  const n = name.trim();
  if (n.length === 0) return "Give the section a name.";
  if (n.length > SECTION_NAME_MAX) return `Section names can be at most ${SECTION_NAME_MAX} characters.`;
  return null;
}

// --- Geometry of an edit (pure) ----------------------------------------------

/** Normalize any angle to a 0–359 integer. */
export function normalizeRotation(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  const r = Math.round(deg) % 360;
  return r < 0 ? r + 360 : r;
}

/** Snap an angle to the nearest `ROTATE_SNAP_DEG`, then normalize. */
export function snapRotation(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  return normalizeRotation(Math.round(deg / ROTATE_SNAP_DEG) * ROTATE_SNAP_DEG);
}

/** The geometry of an element, read into an `ElementGeom`. */
export function geomOf(el: FloorElement): ElementGeom {
  return { x: el.x, y: el.y, w: el.w, h: el.h, rotation: el.rotation };
}

/**
 * Move an element by a SCREEN delta at the current view scale. The delta is
 * converted to logical units; position is otherwise unconstrained (the plane can
 * grow — a table dragged past the current bounds simply extends the section).
 */
export function applyDrag(base: ElementGeom, screenDx: number, screenDy: number, scale: number): ElementGeom {
  const s = scale > 0 ? scale : 1;
  return { ...base, x: base.x + screenDx / s, y: base.y + screenDy / s };
}

export type ResizeHandle = "nw" | "ne" | "sw" | "se";

/**
 * Resize an element from one corner, keeping the OPPOSITE corner fixed, by a
 * screen delta at the current scale. Sizes are SIGNED against the anchor and
 * clamped to `min` — dragging a corner past its anchor pins the size at `min`
 * rather than flipping the rectangle inside out.
 */
export function applyResize(
  base: ElementGeom,
  handle: ResizeHandle,
  screenDx: number,
  screenDy: number,
  scale: number,
  min = MIN_ELEMENT_LOGICAL,
): ElementGeom {
  const s = scale > 0 ? scale : 1;
  const dx = screenDx / s;
  const dy = screenDy / s;
  const left = base.x;
  const right = base.x + base.w;
  const top = base.y;
  const bottom = base.y + base.h;

  const east = handle === "se" || handle === "ne";
  const south = handle === "se" || handle === "sw";

  const w = east ? Math.max(min, right + dx - left) : Math.max(min, right - (left + dx));
  const h = south ? Math.max(min, bottom + dy - top) : Math.max(min, bottom - (top + dy));
  const x = east ? left : right - w;
  const y = south ? top : bottom - h;

  return { ...base, x, y, w, h };
}

/** Rotate to an absolute angle (already computed by the caller from the pointer). */
export function applyRotate(base: ElementGeom, deg: number, snap = true): ElementGeom {
  return { ...base, rotation: snap ? snapRotation(deg) : normalizeRotation(deg) };
}

/** Resize to explicit logical dimensions (the Inspector's steppers). */
export function applySize(base: ElementGeom, w: number, h: number, min = MIN_ELEMENT_LOGICAL): ElementGeom {
  return {
    ...base,
    w: Math.min(20000, Math.max(min, Math.round(w))),
    h: Math.min(20000, Math.max(min, Math.round(h))),
  };
}

// --- Server error mapping ----------------------------------------------------

export type FloorDesignerErrorKind =
  | "busy" // FLOOR_EDITOR_BUSY — another editor holds/held the lease
  | "stale" // FLOOR_STALE_REVISION — the live floor changed under us
  | "permission" // FLOOR_PERMISSION_DENIED / FLOOR_PUBLISH_PERMISSION_DENIED
  | "entitlement" // FLOOR_ENTITLEMENT_DISABLED — feature turned off
  | "invalid" // FLOOR_MALFORMED_DOC / validation
  // Phase 4 publish rejections — ACTIONABLE, and the draft is fully preserved
  // (the whole publish transaction rolled back on the server). The operator fixes
  // the named problem and publishes again; none of these drop to read-only.
  | "noop" // FLOOR_NOOP_PUBLISH — the draft already matches the published floor
  | "openBill" // FLOOR_OPEN_BILL_BLOCK — an open-bill table would leave the map
  | "nameTaken" // FLOOR_NAME_TAKEN — a new/renamed table collides with a canonical name
  | "network" // no response / offline
  | "unknown";

export type FloorDesignerError = {
  kind: FloorDesignerErrorKind;
  message: string;
  /** True when the editing session cannot safely continue and must go read-only. */
  readOnly: boolean;
};

const ERROR_MESSAGES: Record<FloorDesignerErrorKind, string> = {
  busy: "This floor is being edited on another device.",
  stale: "The live floor changed while you were editing. Reopen the designer to continue.",
  permission: "You do not have permission to edit this floor.",
  entitlement: "Floor editing is not enabled for this plan.",
  invalid: "That change couldn’t be saved — the floor layout was rejected.",
  noop: "There’s nothing new to publish — the draft already matches the live floor.",
  openBill: "A table with an open bill would be taken off the map. Keep it on the floor, or close its bill first.",
  nameTaken: "A table name is already in use. Rename it and publish again.",
  network: "Couldn’t reach the server. Your changes are kept locally.",
  unknown: "Something went wrong while editing the floor.",
};

/** Classify a thrown RPC/network error into a Designer state. */
export function classifyFloorDesignerError(e: unknown): FloorDesignerError {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  const kind = kindOf(raw);
  // A lost lease or a moved-out-from-under-us floor both mean: stop writing, keep
  // the operator's work, and drop to read-only. Entitlement/permission removal is
  // the same — the session cannot keep saving.
  const readOnly = kind === "busy" || kind === "stale" || kind === "permission" || kind === "entitlement";
  return { kind, message: ERROR_MESSAGES[kind], readOnly };
}

function kindOf(raw: string): FloorDesignerErrorKind {
  if (raw.includes("FLOOR_EDITOR_BUSY")) return "busy";
  if (raw.includes("FLOOR_STALE_REVISION")) return "stale";
  if (raw.includes("FLOOR_PUBLISH_PERMISSION_DENIED") || raw.includes("FLOOR_PERMISSION_DENIED")) return "permission";
  if (raw.includes("FLOOR_ENTITLEMENT_DISABLED")) return "entitlement";
  // Phase 4 publish rejections — checked before the generic "invalid" so the
  // operator gets the specific, fixable message the server actually raised.
  if (raw.includes("FLOOR_OPEN_BILL_BLOCK")) return "openBill";
  if (raw.includes("FLOOR_NAME_TAKEN")) return "nameTaken";
  if (raw.includes("FLOOR_NOOP")) return "noop";
  if (
    raw.includes("FLOOR_MALFORMED_DOC") ||
    raw.includes("FLOOR_VALIDATION") ||
    raw.includes("FLOOR_INVALID_TABLE_REFERENCE") ||
    raw.includes("FLOOR_CROSS_OU_REFERENCE")
  ) {
    return "invalid";
  }
  if (raw === "" || /network|fetch|timeout|Failed to fetch|offline/i.test(raw)) return "network";
  return "unknown";
}

// --- Read-only canonical table metadata (the identity boundary) --------------

/**
 * Canonical table names/seats for the editor, from the SAME `pos_table_map`
 * read the List uses — projected IMMEDIATELY to `{id, name, seats}` so nothing
 * operational (bills, orders, totals, elapsed, payment state) survives the
 * call. This is deliberately a one-way, read-only adapter: the Designer knows
 * what a table is CALLED, and nothing about what it is DOING.
 */
export async function floorLoadTableMeta(branchId: string | null): Promise<Map<string, TableMeta>> {
  const map = await loadTableMap(branchId);
  const out = new Map<string, TableMeta>();
  for (const t of map.tables) out.set(t.id, { id: t.id, name: t.name, seats: t.seats });
  return out;
}

// --- The RPC boundary (the Phase-1 draft/lease RPCs) -------------------------

/** A short device tag for the lease, so "edited on another device" can be honest. */
export function draftDeviceTag(): string {
  if (typeof navigator !== "undefined" && navigator.platform) return `desktop:${navigator.platform}`;
  return "desktop";
}

function requireBranch(branchId: string | null): string {
  if (!branchId) throw new Error("A branch is required to edit the floor map");
  return branchId;
}

/** floor_draft — load the draft doc, lease and CAS keys for editing. */
export async function floorLoadDraft(branchId: string | null): Promise<DraftLoad> {
  const b = requireBranch(branchId);
  const r = asRecord(await callPosRpc("floor_draft", { p_branch: b }));
  const draftDoc = r.draft_doc;
  const lease = r.lease === null || r.lease === undefined ? null : asRecord(r.lease);
  return {
    layoutId: strOrNull(r.layout_id),
    draft: draftDoc === null || draftDoc === undefined ? null : parseDraftDoc(draftDoc),
    draftHash: strOrNull(r.draft_hash),
    publishedRevisionId: strOrNull(r.published_revision_id),
    draftBaseRevisionId: strOrNull(r.draft_base_revision_id),
    canPublish: bool(r.can_publish),
    unplaced: parseUnplaced(r.unplaced),
    lease: lease
      ? {
          ownerIsMe: bool(lease.owner_is_me),
          active: bool(lease.active),
          lastSeenAt: strOrNull(lease.last_seen_at),
          expiresAt: strOrNull(lease.expires_at),
        }
      : null,
  };
}

/** Parse the `unplaced` payload (from floor_draft or floor_unplaced_tables). */
export function parseUnplaced(raw: unknown): UnplacedTable[] {
  if (!Array.isArray(raw)) return [];
  const out: UnplacedTable[] = [];
  for (const item of raw) {
    const r = asRecord(item);
    const id = strOrNull(r.id ?? r.table_id);
    if (!id) continue;
    out.push({ id, name: str(r.name), seats: numOrNull(r.seats) });
  }
  return out;
}

/** floor_unplaced_tables — the authoritative unplaced list for the draft. */
export async function floorLoadUnplaced(branchId: string | null): Promise<UnplacedTable[]> {
  const b = requireBranch(branchId);
  return parseUnplaced(await callPosRpc("floor_unplaced_tables", { p_branch: b }));
}

export type LeaseResult = { ok: boolean; layoutId: string | null; expiresAt: string | null; tookOver: boolean };

function parseLeaseResult(raw: unknown): LeaseResult {
  const r = asRecord(raw);
  return {
    ok: bool(r.ok),
    layoutId: strOrNull(r.layout_id),
    expiresAt: strOrNull(r.expires_at),
    tookOver: bool(r.took_over),
  };
}

/** floor_acquire_lease — claim the single editor lease for this floor. */
export async function floorAcquireLease(branchId: string | null, device = draftDeviceTag()): Promise<LeaseResult> {
  const b = requireBranch(branchId);
  return parseLeaseResult(await callPosRpc("floor_acquire_lease", { p_branch: b, p_device: device }));
}

/** floor_heartbeat — keep the held lease alive. Throws FLOOR_EDITOR_BUSY if lost. */
export async function floorHeartbeat(branchId: string | null): Promise<{ ok: boolean; expiresAt: string | null }> {
  const b = requireBranch(branchId);
  const r = asRecord(await callPosRpc("floor_heartbeat", { p_branch: b }));
  return { ok: bool(r.ok), expiresAt: strOrNull(r.expires_at) };
}

/** floor_release_lease — hand the lease back on leaving the designer. */
export async function floorReleaseLease(branchId: string | null): Promise<{ ok: boolean }> {
  const b = requireBranch(branchId);
  const r = asRecord(await callPosRpc("floor_release_lease", { p_branch: b }));
  return { ok: bool(r.ok) };
}

/** floor_takeover_lease — claim an EXPIRED lease (still refuses an active one). */
export async function floorTakeoverLease(branchId: string | null, device = draftDeviceTag()): Promise<LeaseResult> {
  const b = requireBranch(branchId);
  return parseLeaseResult(await callPosRpc("floor_takeover_lease", { p_branch: b, p_device: device }));
}

/**
 * floor_autosave_draft — persist the draft. Lease-protected and CAS-guarded on
 * the server (`p_base_revision_id` must equal the live published revision).
 */
export async function floorAutosaveDraft(
  branchId: string | null,
  doc: Record<string, unknown>,
  baseRevisionId: string | null,
): Promise<{ ok: boolean; draftHash: string | null }> {
  const b = requireBranch(branchId);
  const r = asRecord(
    await callPosRpc("floor_autosave_draft", { p_branch: b, p_doc: doc, p_base_revision_id: baseRevisionId }),
  );
  return { ok: bool(r.ok), draftHash: strOrNull(r.draft_hash) };
}

// --- Phase 4 PUBLISH lifecycle RPCs ------------------------------------------

export function parsePublishResult(raw: unknown): PublishResult {
  const r = asRecord(raw);
  const created: PublishedCreate[] = [];
  if (Array.isArray(r.created)) {
    for (const item of r.created) {
      const c = asRecord(item);
      const tempId = strOrNull(c.temp_id);
      const tableId = strOrNull(c.table_id);
      if (tempId && tableId) created.push({ tempId, tableId });
    }
  }
  const renamed: PublishedRename[] = [];
  if (Array.isArray(r.renamed)) {
    for (const item of r.renamed) {
      const c = asRecord(item);
      const tableId = strOrNull(c.table_id);
      const name = strOrNull(c.name);
      if (tableId && name) renamed.push({ tableId, name });
    }
  }
  return {
    ok: bool(r.ok),
    revisionId: strOrNull(r.revision_id),
    revisionNo: numOrNull(r.revision_no),
    created,
    renamed,
  };
}

/**
 * floor_publish — the ONE atomic publish. Echoes the base-revision CAS key the
 * editor started from (`p_base_revision_id`), so a floor that advanced elsewhere
 * is rejected rather than overwritten. On success the SERVER has, in a single
 * transaction: validated the draft, blocked any open-bill table leaving the map,
 * created the staged new tables, applied the staged renames, written an immutable
 * revision, flipped the published pointer and rebased the draft onto it. On any
 * rejection nothing changed — the draft is intact and the operator can fix and
 * retry. This client never materializes a canonical table itself.
 */
export async function floorPublish(
  branchId: string | null,
  baseRevisionId: string | null,
): Promise<PublishResult> {
  const b = requireBranch(branchId);
  return parsePublishResult(
    await callPosRpc("floor_publish", { p_branch: b, p_base_revision_id: baseRevisionId }),
  );
}

/** Parse the `floor_history` payload — a metadata-only revision list, newest first. */
export function parseHistoryEntries(raw: unknown): HistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: HistoryEntry[] = [];
  for (const item of raw) {
    const r = asRecord(item);
    const revisionId = strOrNull(r.revision_id);
    if (!revisionId) continue;
    const summary = asRecord(r.change_summary);
    out.push({
      revisionId,
      revisionNo: num(r.revision_no),
      publishedAt: strOrNull(r.published_at),
      publishedBy: strOrNull(r.published_by),
      tables: numOrNull(summary.tables),
      createdCount: numOrNull(summary.created),
      renamedCount: numOrNull(summary.renamed),
      restoredFromRevisionId: strOrNull(r.restored_from_revision_id),
      isCurrent: bool(r.is_current),
    });
  }
  return out;
}

/** floor_history — the immutable revision list (metadata only, never the doc). */
export async function floorHistory(branchId: string | null): Promise<HistoryEntry[]> {
  const b = requireBranch(branchId);
  return parseHistoryEntries(await callPosRpc("floor_history", { p_branch: b }));
}

/**
 * floor_restore_revision — load a past revision back into the DRAFT. This is NOT
 * a publish: the Service Floor keeps serving the current published revision, and
 * the operator must explicitly Publish afterwards to make the restored layout
 * live. It REPLACES the current draft, so the caller confirms first.
 */
export async function floorRestoreRevision(
  branchId: string | null,
  revisionId: string,
): Promise<RestoreResult> {
  const b = requireBranch(branchId);
  const r = asRecord(await callPosRpc("floor_restore_revision", { p_branch: b, p_revision_id: revisionId }));
  return { ok: bool(r.ok), restoredFrom: strOrNull(r.restored_from), revisionNo: numOrNull(r.revision_no) };
}
