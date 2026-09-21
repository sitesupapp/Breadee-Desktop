// ALIGN / DISTRIBUTE / SAME-SIZE + group movement for the Floor Designer
// (Phase 3C). Pure functions over intrinsic geometry: each tool takes the
// selected elements' current geometry and returns ONE map of new geometries,
// which the store applies as ONE draft mutation → one debounced autosave.
// Nothing here reorders, renames or otherwise touches canonical identity —
// only x/y (and, for same-size, w/h) change.

import type { ElementGeom } from "@/lib/pos/floorDesigner";

export type ArrangeEntry = { id: string; geom: ElementGeom };

export type AlignMode = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";
export type SizeMode = "width" | "height" | "both";

/** Bounding box of a set of geometries. */
export function bboxOf(entries: ArrangeEntry[]): { x: number; y: number; w: number; h: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const { geom: g } of entries) {
    minX = Math.min(minX, g.x);
    minY = Math.min(minY, g.y);
    maxX = Math.max(maxX, g.x + g.w);
    maxY = Math.max(maxY, g.y + g.h);
  }
  return { x: minX, y: minY, w: Math.max(0, maxX - minX), h: Math.max(0, maxY - minY) };
}

/** Move every entry by one logical delta — relative spacing preserved exactly. */
export function moveGroup(entries: ArrangeEntry[], dx: number, dy: number): Map<string, ElementGeom> {
  const out = new Map<string, ElementGeom>();
  for (const { id, geom } of entries) out.set(id, { ...geom, x: geom.x + dx, y: geom.y + dy });
  return out;
}

/** Align 2+ elements against their common bounding box. Only x or y changes. */
export function alignGeoms(entries: ArrangeEntry[], mode: AlignMode): Map<string, ElementGeom> {
  const out = new Map<string, ElementGeom>();
  if (entries.length < 2) return out;
  const box = bboxOf(entries);
  for (const { id, geom: g } of entries) {
    let x = g.x;
    let y = g.y;
    if (mode === "left") x = box.x;
    else if (mode === "right") x = box.x + box.w - g.w;
    else if (mode === "hcenter") x = box.x + (box.w - g.w) / 2;
    else if (mode === "top") y = box.y;
    else if (mode === "bottom") y = box.y + box.h - g.h;
    else if (mode === "vcenter") y = box.y + (box.h - g.h) / 2;
    out.set(id, { ...g, x, y });
  }
  return out;
}

/**
 * Distribute 3+ elements with EQUAL GAPS along one axis. Deterministic: order
 * is the current position along the axis (ties broken by id), the outer two
 * stay anchored, and the free space between them is divided evenly. When the
 * combined size exceeds the span the elements are laid edge-to-edge from the
 * first anchor (gap 0 floor) rather than being shuffled backwards.
 */
export function distributeGeoms(entries: ArrangeEntry[], axis: "h" | "v"): Map<string, ElementGeom> {
  const out = new Map<string, ElementGeom>();
  if (entries.length < 3) return out;

  const pos = (g: ElementGeom) => (axis === "h" ? g.x : g.y);
  const size = (g: ElementGeom) => (axis === "h" ? g.w : g.h);
  const sorted = [...entries].sort((a, b) => {
    const d = pos(a.geom) + size(a.geom) / 2 - (pos(b.geom) + size(b.geom) / 2);
    return d !== 0 ? d : a.id.localeCompare(b.id);
  });

  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const spanStart = pos(first.geom);
  const spanEnd = pos(last.geom) + size(last.geom);
  const total = sorted.reduce((s, e) => s + size(e.geom), 0);
  const gap = Math.max(0, (spanEnd - spanStart - total) / (sorted.length - 1));

  let cursor = spanStart;
  for (const { id, geom: g } of sorted) {
    const next = axis === "h" ? { ...g, x: cursor } : { ...g, y: cursor };
    out.set(id, next);
    cursor += size(g) + gap;
  }
  return out;
}

/**
 * Match sizes to a REFERENCE element — the primary (last-selected) one, chosen
 * by the caller. Position, rotation, name and section are untouched; only w
 * and/or h change to the reference's.
 */
export function sameSize(
  entries: ArrangeEntry[],
  referenceId: string,
  mode: SizeMode,
): Map<string, ElementGeom> {
  const out = new Map<string, ElementGeom>();
  const ref = entries.find((e) => e.id === referenceId);
  if (!ref || entries.length < 2) return out;
  for (const { id, geom: g } of entries) {
    if (id === referenceId) continue;
    out.set(id, {
      ...g,
      w: mode === "height" ? g.w : ref.geom.w,
      h: mode === "width" ? g.h : ref.geom.h,
    });
  }
  return out;
}
