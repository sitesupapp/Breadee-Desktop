// STRUCTURE / OBJECT catalog for the Floor Designer (Phase 3D-B). Pure, no
// React, no network, Designer-owned. This is the single source of truth for
// which structure types the operator can add, how each one is grouped and
// labelled in the palette, its deterministic default footprint, and whether it
// rotates/resizes — all within the CURRENT server contract (`_floor_validate_doc`
// recertified 2026-09-21).
//
// CONTRACT SCOPE. The server allows exactly these element types: table + wall,
// divider, door, window, counter, kitchen, host, entrance, stairs, wc, text,
// plant. "bar" is a table SHAPE, not an element type, so a "bar" STRUCTURE is
// not supported and is intentionally absent (deferred). A structure carries only
// id/type/section_id/x/y/w/h and optional rotation (0–359) and label (≤120).
// There is no shape/seats/temp_id on a structure — those are table-only fields.

import { newElementId, type ElementGeom } from "@/lib/pos/floorDesigner";
import type { FloorElementType } from "@/lib/pos/floor";

/** Every non-table element kind. */
export type StructureType = Exclude<FloorElementType, "table">;

/** Palette groupings — plain restaurant language, not developer terms. */
export type StructureGroup = "building" | "service" | "decor";

/** How a structure draws: a thin line/edge, a filled block, or free text. */
export type StructureRender = "linear" | "block" | "text";

export type StructureSpec = {
  type: StructureType;
  /** Friendly, operator-facing name (never the raw type key). */
  label: string;
  group: StructureGroup;
  /** Deterministic default footprint, in logical units (contract: >0, ≤20000). */
  w: number;
  h: number;
  /** Rotation is offered for this type (decorative symmetric objects opt out). */
  rotatable: boolean;
  resizable: boolean;
  render: StructureRender;
};

/** The server's per-element label limit. */
export const STRUCTURE_LABEL_MAX = 120;

/**
 * The catalog. Order is the palette order within each group. Defaults are chosen
 * to read like the room at a glance — walls long and shallow, service items as
 * blocks, text as a small readable label — and every value is a fixed constant
 * so an add is fully deterministic.
 */
export const STRUCTURE_CATALOG: readonly StructureSpec[] = [
  // BUILDING — the fixed shell of the room.
  { type: "wall", label: "Wall", group: "building", w: 300, h: 8, rotatable: true, resizable: true, render: "linear" },
  { type: "divider", label: "Divider", group: "building", w: 200, h: 8, rotatable: true, resizable: true, render: "linear" },
  { type: "door", label: "Door", group: "building", w: 44, h: 10, rotatable: true, resizable: true, render: "linear" },
  { type: "window", label: "Window", group: "building", w: 90, h: 10, rotatable: true, resizable: true, render: "linear" },
  { type: "entrance", label: "Entrance", group: "building", w: 90, h: 40, rotatable: true, resizable: true, render: "block" },
  { type: "stairs", label: "Stairs", group: "building", w: 110, h: 64, rotatable: true, resizable: true, render: "block" },
  // SERVICE — where the staff work.
  { type: "counter", label: "Counter", group: "service", w: 170, h: 40, rotatable: true, resizable: true, render: "block" },
  { type: "kitchen", label: "Kitchen", group: "service", w: 160, h: 120, rotatable: true, resizable: true, render: "block" },
  { type: "host", label: "Host stand", group: "service", w: 90, h: 60, rotatable: true, resizable: true, render: "block" },
  { type: "wc", label: "WC", group: "service", w: 80, h: 80, rotatable: true, resizable: true, render: "block" },
  // DECOR / INFO — labels and greenery.
  { type: "text", label: "Text label", group: "decor", w: 160, h: 28, rotatable: true, resizable: true, render: "text" },
  // A plant is a symmetric decorative marker: rotation would read as no change,
  // so it is intentionally the one type without a rotate control.
  { type: "plant", label: "Plant", group: "decor", w: 44, h: 44, rotatable: false, resizable: true, render: "block" },
] as const;

const BY_TYPE = new Map<StructureType, StructureSpec>(STRUCTURE_CATALOG.map((s) => [s.type, s]));

/** The set of allowed structure types (everything the palette can add). */
export const STRUCTURE_TYPE_SET: ReadonlySet<StructureType> = new Set(BY_TYPE.keys());

export function isStructureType(t: string): t is StructureType {
  return BY_TYPE.has(t as StructureType);
}

export function structureSpec(type: string): StructureSpec | null {
  return BY_TYPE.get(type as StructureType) ?? null;
}

/** Friendly label for a structure type (falls back to the raw key, capitalized). */
export function structureLabel(type: string): string {
  const s = BY_TYPE.get(type as StructureType);
  if (s) return s.label;
  return type ? type.charAt(0).toUpperCase() + type.slice(1) : "Object";
}

export function isRotatable(type: string): boolean {
  return BY_TYPE.get(type as StructureType)?.rotatable ?? false;
}

/** The catalog grouped for the palette, in a stable display order. */
export const STRUCTURE_GROUPS: { group: StructureGroup; label: string; items: StructureSpec[] }[] = [
  { group: "building", label: "Building", items: STRUCTURE_CATALOG.filter((s) => s.group === "building") },
  { group: "service", label: "Service", items: STRUCTURE_CATALOG.filter((s) => s.group === "service") },
  { group: "decor", label: "Decor & info", items: STRUCTURE_CATALOG.filter((s) => s.group === "decor") },
];

/** The default geometry for a freshly added structure of `type`, at an anchor. */
export function defaultStructureGeom(type: StructureType, x: number, y: number): ElementGeom {
  const s = BY_TYPE.get(type);
  const w = s?.w ?? 100;
  const h = s?.h ?? 100;
  return { x, y, w, h, rotation: 0 };
}

/**
 * A raw draft record for a NEW structure. It uses the ordinary draft element id
 * convention (`e-…`) — a structure is a layout object, never a pending canonical
 * table, so it carries no `temp_id`, `table_id`, `new_name`, `seats` or `shape`.
 * A `label` is written only when non-empty (text objects and named structures).
 */
export function makeStructureElement(
  type: StructureType,
  sectionId: string,
  geom: ElementGeom,
  label?: string | null,
): Record<string, unknown> {
  const rec: Record<string, unknown> = {
    id: newElementId(),
    type,
    section_id: sectionId,
    x: geom.x,
    y: geom.y,
    w: geom.w,
    h: geom.h,
    rotation: geom.rotation,
  };
  const trimmed = (label ?? "").trim();
  if (trimmed.length > 0) rec.label = trimmed.slice(0, STRUCTURE_LABEL_MAX);
  return rec;
}
