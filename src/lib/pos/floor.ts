// The Dine-In Service Floor Map READER, against the Phase-1 staging contract.
//
//   * floor_service_layout(p_branch) — SECURITY DEFINER, gated server-side on the
//     `pos.floor_map` entitlement + `pos.tables.view`. Returns the PUBLISHED floor
//     revision only (never a draft): { has_published, revision_id, revision_no,
//     published_at, doc } where `doc` is the immutable published document
//     { v:"1", sections:[…], elements:[…] }.
//
// This module is READ-ONLY. It performs no writes and reconstructs no business
// state: a table's operational status (free/active, bill total, elapsed) comes
// from `pos_table_map` (see `lib/pos/tables.ts`), joined by canonical table id.
// A floor placement is only "where this table appears".
//
// Everything here is defensive. A published document is trusted to be well-formed
// (the server validated it at publish), but a single malformed element must never
// take the whole floor down, and an unknown element type or table shape from a
// FUTURE authoring version must degrade gracefully rather than crash — Phase 2
// renders what it understands and safely ignores the rest.

import { asRecord, callPosRpc, num, str, strOrNull } from "@/lib/pos/rpc";

/** Element kinds a published V1 document can carry. */
export type FloorElementType =
  | "table"
  | "wall"
  | "divider"
  | "door"
  | "window"
  | "counter"
  | "kitchen"
  | "host"
  | "entrance"
  | "stairs"
  | "wc"
  | "text"
  | "plant";

/** Table shapes a published V1 document can carry. */
export type FloorTableShape =
  | "sq"
  | "round"
  | "r4"
  | "r6"
  | "rect"
  | "rect6"
  | "rect8"
  | "oval"
  | "high"
  | "bar"
  | "lounge";

const ELEMENT_TYPES: readonly FloorElementType[] = [
  "table", "wall", "divider", "door", "window", "counter", "kitchen",
  "host", "entrance", "stairs", "wc", "text", "plant",
];

const TABLE_SHAPES: readonly FloorTableShape[] = [
  "sq", "round", "r4", "r6", "rect", "rect6", "rect8", "oval", "high", "bar", "lounge",
];

/** Structural (non-table) element kinds — visual context only. */
export const STRUCTURE_TYPES: readonly FloorElementType[] = [
  "wall", "divider", "door", "window", "counter", "kitchen",
  "host", "entrance", "stairs", "wc", "text", "plant",
];

/**
 * One placed element in intrinsic LOGICAL coordinates (never pixels). The plane
 * is transformed for Fit/zoom/pan; the element positions are the published truth
 * and are used verbatim — the service renderer never re-arranges them.
 */
export type FloorElement = {
  id: string;
  sectionId: string;
  type: FloorElementType;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 0–359, default 0. */
  rotation: number;
  /** Tables only. Unknown/absent shape falls back to a safe rectangle at render. */
  shape: FloorTableShape | null;
  /** Tables only. The canonical `pos_tables.id` this placement points at. */
  tableId: string | null;
  /** Optional free label (text objects, named structures). */
  label: string | null;
};

export type FloorSection = {
  id: string;
  name: string;
  sort: number | null;
  /** Optional authored plane size; when absent, bounds are derived from elements. */
  w: number | null;
  h: number | null;
};

export type FloorLayout = {
  hasPublished: boolean;
  revisionId: string | null;
  revisionNo: number | null;
  publishedAt: string | null;
  sections: FloorSection[];
  elements: FloorElement[];
};

export const EMPTY_FLOOR_LAYOUT: FloorLayout = {
  hasPublished: false,
  revisionId: null,
  revisionNo: null,
  publishedAt: null,
  sections: [],
  elements: [],
};

/**
 * A finite number or null. An absent (null/undefined/"") or non-finite value is
 * treated as missing — `Number(null)` is 0, which would otherwise smuggle a
 * malformed coordinate through as a real zero.
 */
function finiteOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toType(value: unknown): FloorElementType | null {
  const s = str(value);
  return (ELEMENT_TYPES as readonly string[]).includes(s) ? (s as FloorElementType) : null;
}

/**
 * An unknown/absent shape does NOT drop the table — it renders as a safe
 * rectangle. A future authoring version may add a shape this build predates, and
 * a table the cashier can still see and tap is always better than a hole.
 */
function toShape(value: unknown): FloorTableShape | null {
  const s = str(value);
  return (TABLE_SHAPES as readonly string[]).includes(s) ? (s as FloorTableShape) : null;
}

function toRotation(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const r = Math.trunc(n) % 360;
  return r < 0 ? r + 360 : r;
}

/**
 * Parse one element defensively. Returns null (drop) when the element is not
 * renderable: an unknown TYPE, a non-finite position/size, a non-positive size,
 * or a table with no canonical id (which could neither be selected nor joined to
 * operational state). Everything droppable is dropped silently — a published doc
 * from a newer authoring build must not break an older reader.
 */
export function parseFloorElement(raw: unknown): FloorElement | null {
  const r = asRecord(raw);
  const id = strOrNull(r.id);
  if (!id) return null;
  const type = toType(r.type);
  if (!type) return null;
  const sectionId = strOrNull(r.section_id);
  if (!sectionId) return null;
  const x = finiteOrNull(r.x);
  const y = finiteOrNull(r.y);
  const w = finiteOrNull(r.w);
  const h = finiteOrNull(r.h);
  if (x === null || y === null || w === null || h === null) return null;
  if (w <= 0 || h <= 0) return null;
  const isTable = type === "table";
  const tableId = isTable ? strOrNull(r.table_id) : null;
  // A published table placement with no canonical id is meaningless (nothing to
  // select, nothing to join to `pos_table_map`) — drop it rather than render a
  // ghost the cashier can tap but never open.
  if (isTable && !tableId) return null;
  return {
    id,
    sectionId,
    type,
    x,
    y,
    w,
    h,
    rotation: toRotation(r.rotation),
    shape: isTable ? toShape(r.shape) : null,
    tableId,
    label: strOrNull(r.label),
  };
}

function parseSection(raw: unknown): FloorSection | null {
  const r = asRecord(raw);
  const id = strOrNull(r.id);
  if (!id) return null;
  return {
    id,
    name: str(r.name),
    sort: finiteOrNull(r.sort),
    w: (() => { const n = finiteOrNull(r.w); return n !== null && n > 0 ? n : null; })(),
    h: (() => { const n = finiteOrNull(r.h); return n !== null && n > 0 ? n : null; })(),
  };
}

/**
 * Parse the `floor_service_layout` response into a `FloorLayout`.
 *
 * `has_published:false` (or a missing doc) yields an empty layout that still
 * carries `hasPublished:false` — the UI shows a friendly "no floor published"
 * state and keeps the List available, never a broken empty canvas.
 */
export function parseFloorLayout(raw: unknown): FloorLayout {
  const root = asRecord(raw);
  const hasPublished = root.has_published === true;
  if (!hasPublished) return EMPTY_FLOOR_LAYOUT;
  const doc = asRecord(root.doc);
  const rawSections = Array.isArray(doc.sections) ? doc.sections : [];
  const rawElements = Array.isArray(doc.elements) ? doc.elements : [];
  const sections = rawSections
    .map(parseSection)
    .filter((s): s is FloorSection => s !== null);
  const validSectionIds = new Set(sections.map((s) => s.id));
  const elements = rawElements
    .map(parseFloorElement)
    .filter((e): e is FloorElement => e !== null)
    // An element that references a section the doc does not define is not
    // renderable in any section plane — drop it rather than orphan it.
    .filter((e) => validSectionIds.has(e.sectionId));
  return {
    hasPublished: true,
    revisionId: strOrNull(root.revision_id),
    revisionNo: (() => { const n = finiteOrNull(root.revision_no); return n; })(),
    publishedAt: strOrNull(root.published_at),
    sections: sortSections(sections),
    elements,
  };
}

/** Sections in their authored order: `sort` ascending, then name, then id. */
export function sortSections(sections: FloorSection[]): FloorSection[] {
  return [...sections].sort((a, b) => {
    const sa = a.sort ?? Number.MAX_SAFE_INTEGER;
    const sb = b.sort ?? Number.MAX_SAFE_INTEGER;
    if (sa !== sb) return sa - sb;
    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) return byName;
    return a.id.localeCompare(b.id);
  });
}

/** Elements of one section. */
export function elementsForSection(layout: FloorLayout, sectionId: string): FloorElement[] {
  return layout.elements.filter((e) => e.sectionId === sectionId);
}

/** The canonical table ids placed anywhere on the published floor. */
export function placedTableIds(layout: FloorLayout): Set<string> {
  const ids = new Set<string>();
  for (const e of layout.elements) if (e.type === "table" && e.tableId) ids.add(e.tableId);
  return ids;
}

/**
 * Load the published floor for a branch. The branch is REQUIRED by the server and
 * is never guessed here. Kept as the sole RPC boundary for this feature; parsing
 * is delegated so it can be unit-tested without the network.
 */
export async function loadFloorLayout(branchId: string | null): Promise<FloorLayout> {
  if (!branchId) throw new Error("A branch is required to load the floor map");
  return parseFloorLayout(await callPosRpc("floor_service_layout", { p_branch: branchId }));
}
