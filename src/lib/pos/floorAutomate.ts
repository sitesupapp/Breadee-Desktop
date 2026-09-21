// CREATION & LAYOUT AUTOMATION for the Floor Designer (Phase 3D-A).
//
// ONE pure engine behind Quick Setup, Bulk Create, Auto-number, Duplicate and
// deterministic Auto-arrange. No React, no network, no store, Designer-owned.
// Everything here is math over names and intrinsic geometry: it decides WHAT to
// name and WHERE to place, and returns plain data the store turns into ONE draft
// mutation (temp intents in `edits.added`, staged names in `edits.renames`,
// geometry in `edits.geom`). It never creates or renames a canonical table — that
// is a future PUBLISH, which this phase never calls.
//
// DETERMINISM IS THE CONTRACT. Given the same input every function returns the
// same output: no randomness, no time, no viewport. Ordering falls back to the
// stable element id on any tie. Auto-numbering reads the PHYSICAL floor order
// (top-to-bottom, then left-to-right by element centre) so the UI's text
// direction — including RTL — never changes which table becomes T01.
//
// The collision/spacing engine is REUSED, not reimplemented: cell sizing uses
// `orientedExtent` (the same oriented-box math as the warnings), and the store
// recomputes `analyzeCollisions` after the one mutation like any other edit.

import { orientedExtent, RECOMMENDED_CLEARANCE, SOLID_STRUCTURES } from "@/lib/pos/floorCollision";
import {
  TABLE_NAME_MAX,
  type DesignerElement,
  type ElementGeom,
} from "@/lib/pos/floorDesigner";

/**
 * Grid gap between arranged tables, in logical units. Set comfortably ABOVE the
 * recommended clearance so a freshly arranged grid reads as "clear", not "tight",
 * in the advisory warnings that recompute right after.
 */
export const ARRANGE_GAP = Math.round(RECOMMENDED_CLEARANCE * 1.5); // 45

/** A duplicate lands this many logical units down-and-right of its original. */
export const DUPLICATE_OFFSET = 24;

// --- Naming -----------------------------------------------------------------

/** Case-insensitive comparison key for a table name. */
export function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

/** A number, optionally zero-padded to a fixed width. */
export function padNumber(n: number, pad: number): string {
  const s = String(Math.trunc(n));
  return pad > 0 ? s.padStart(pad, "0") : s;
}

export type NameSpec = { prefix: string; start: number; count: number; pad: number };

/**
 * A human-friendly naming sequence: `prefix` carries any separator, the number
 * counts up from `start`, optionally zero-padded. `T`→T1,T2…; `TR-`,pad 2→
 * TR-01,TR-02…; `VIP-`→VIP-1,VIP-2…
 */
export function generateNames(spec: NameSpec): string[] {
  const out: string[] = [];
  for (let i = 0; i < Math.max(0, Math.trunc(spec.count)); i++) {
    out.push(`${spec.prefix}${padNumber(spec.start + i, spec.pad)}`);
  }
  return out;
}

/** Build a lookup set of normalized names from any list (nulls dropped). */
export function nameKeySet(names: readonly (string | null | undefined)[]): Set<string> {
  const out = new Set<string>();
  for (const n of names) {
    if (n && n.trim().length > 0) out.add(normalizeName(n));
  }
  return out;
}

export type NameVerdict = { ok: true } | { ok: false; reason: string };

/**
 * The Designer-level uniqueness model. Rejects an empty or over-long name, a
 * name generated twice in the same batch, and a name that already exists on the
 * floor (canonical, staged rename, or another staged new table). This is a
 * courteous UI pre-check so obvious duplicates surface before an autosave — the
 * server's PUBLISH validation stays authoritative.
 */
export function validateNameBatch(names: readonly string[], existing: ReadonlySet<string>): NameVerdict {
  const seen = new Set<string>();
  for (const raw of names) {
    const n = raw.trim();
    if (n.length === 0) return { ok: false, reason: "That prefix and number make an empty name." };
    if (n.length > TABLE_NAME_MAX) return { ok: false, reason: `“${n}” is longer than ${TABLE_NAME_MAX} characters.` };
    const key = normalizeName(n);
    if (seen.has(key)) return { ok: false, reason: `“${n}” would be created twice — adjust the start number or count.` };
    if (existing.has(key)) return { ok: false, reason: `“${n}” already exists — pick a different prefix or start number.` };
    seen.add(key);
  }
  return { ok: true };
}

/** Propose a unique "…-copy" name for a duplicate, ≤ the name limit. */
export function proposeCopyName(base: string, existing: ReadonlySet<string>): string {
  const trimmed = base.trim() || "Table";
  const fit = (s: string) => (s.length <= TABLE_NAME_MAX ? s : s.slice(0, TABLE_NAME_MAX));
  const first = fit(`${trimmed}-copy`);
  if (!existing.has(normalizeName(first))) return first;
  for (let i = 2; i < 1000; i++) {
    const candidate = fit(`${trimmed}-copy${i}`);
    if (!existing.has(normalizeName(candidate))) return candidate;
  }
  return first;
}

// --- Physical reading order --------------------------------------------------

export type OrderItem = { id: string; geom: ElementGeom };

/**
 * Sort elements into physical reading order: top-to-bottom by row, then
 * left-to-right within a row, by element CENTRE. Rows are banded by half the
 * smallest footprint so a slightly staggered row still reads as one row. Purely
 * geometric — independent of UI text direction, so RTL never reverses it — and
 * deterministic, with the element id as the final tie-break.
 */
export function readingOrder(items: readonly OrderItem[]): OrderItem[] {
  if (items.length <= 1) return [...items];
  const centre = (g: ElementGeom) => ({ x: g.x + g.w / 2, y: g.y + g.h / 2 });
  let minDim = Infinity;
  for (const it of items) minDim = Math.min(minDim, it.geom.w, it.geom.h);
  const band = Math.max(1, (Number.isFinite(minDim) ? minDim : 80) * 0.5);

  const byY = [...items].sort((a, b) => {
    const d = centre(a.geom).y - centre(b.geom).y;
    return d !== 0 ? d : a.id.localeCompare(b.id);
  });

  // Greedily group into rows, then order each row left-to-right.
  const rows: OrderItem[][] = [];
  let rowTop = -Infinity;
  for (const it of byY) {
    const cy = centre(it.geom).y;
    if (rows.length === 0 || cy - rowTop > band) {
      rows.push([it]);
      rowTop = cy;
    } else {
      rows[rows.length - 1].push(it);
    }
  }
  const out: OrderItem[] = [];
  for (const row of rows) {
    row.sort((a, b) => {
      const d = centre(a.geom).x - centre(b.geom).x;
      return d !== 0 ? d : a.id.localeCompare(b.id);
    });
    out.push(...row);
  }
  return out;
}

// --- Deterministic placement -------------------------------------------------

type Aabb = { minX: number; minY: number; maxX: number; maxY: number };

function aabbOf(x: number, y: number, w: number, h: number, rotation: number): Aabb {
  const ext = orientedExtent(w, h, rotation);
  const cx = x + w / 2;
  const cy = y + h / 2;
  return { minX: cx - ext.w / 2, minY: cy - ext.h / 2, maxX: cx + ext.w / 2, maxY: cy + ext.h / 2 };
}

function aabbOverlap(a: Aabb, b: Aabb): boolean {
  return a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
}

/** A fixed obstacle an arrangement should avoid where practical. */
export type Obstacle = { x: number; y: number; w: number; h: number; rotation: number };

export type ArrangeOptions = {
  /** Top-left of the arrangement region, in logical units. */
  anchorX: number;
  anchorY: number;
  /** Working width used to choose the column count. */
  planeW: number;
  gap?: number;
  /** Fixed elements (solid structures, non-arranged tables) to route around. */
  obstacles?: readonly Obstacle[];
  /** Placement order; defaults to the items' own order. Use `readingOrder`. */
  order?: readonly string[];
};

/**
 * Lay tables out in readable rows/columns from an explicit anchor. Deterministic
 * (same input → same output). Cells are sized to the LARGEST table's rotated
 * footprint plus the gap, so no two arranged tables overlap each other; each
 * table is centred in its cell, preserving its own size and rotation. When
 * obstacles are supplied, cells that would sit on a fixed element are skipped
 * (row-major) so the batch routes around walls and existing tables where it can;
 * if space runs out the result still lays out (advisory warnings, never a block).
 * Only x/y change.
 */
export function autoArrange(items: readonly OrderItem[], opts: ArrangeOptions): Map<string, ElementGeom> {
  const out = new Map<string, ElementGeom>();
  if (items.length === 0) return out;
  const gap = opts.gap ?? ARRANGE_GAP;

  let maxW = 0;
  let maxH = 0;
  for (const it of items) {
    const e = orientedExtent(it.geom.w, it.geom.h, it.geom.rotation);
    if (e.w > maxW) maxW = e.w;
    if (e.h > maxH) maxH = e.h;
  }
  const strideX = maxW + gap;
  const strideY = maxH + gap;
  const cols = Math.max(1, Math.floor((opts.planeW + gap) / strideX));

  const obstacles = (opts.obstacles ?? []).map((o) => aabbOf(o.x, o.y, o.w, o.h, o.rotation));
  const byId = new Map(items.map((it) => [it.id, it] as const));
  const order = opts.order ?? items.map((it) => it.id);

  const cellCentre = (index: number) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    return { cx: opts.anchorX + maxW / 2 + col * strideX, cy: opts.anchorY + maxH / 2 + row * strideY };
  };
  const cellClear = (index: number): boolean => {
    if (obstacles.length === 0) return true;
    const { cx, cy } = cellCentre(index);
    const rect: Aabb = { minX: cx - strideX / 2, minY: cy - strideY / 2, maxX: cx + strideX / 2, maxY: cy + strideY / 2 };
    return !obstacles.some((o) => aabbOverlap(o, rect));
  };

  let cell = 0;
  for (const id of order) {
    const it = byId.get(id);
    if (!it) continue;
    if (obstacles.length > 0) {
      // Route around fixed elements; a generous guard keeps this bounded.
      let guard = 0;
      while (!cellClear(cell) && guard < 100000) {
        cell++;
        guard++;
      }
    }
    const { cx, cy } = cellCentre(cell);
    out.set(id, { ...it.geom, x: cx - it.geom.w / 2, y: cy - it.geom.h / 2 });
    cell++;
  }
  return out;
}

/**
 * Positions for a NEW batch of `count` identical cells (Quick Setup / Bulk
 * Create). Thin wrapper over `autoArrange` so creation and re-arrangement share
 * exactly one placement algorithm.
 */
export function bulkLayout(
  count: number,
  cell: { w: number; h: number },
  opts: ArrangeOptions,
): ElementGeom[] {
  const items: OrderItem[] = Array.from({ length: Math.max(0, Math.trunc(count)) }, (_, i) => ({
    id: `slot-${i}`,
    geom: { x: 0, y: 0, w: cell.w, h: cell.h, rotation: 0 },
  }));
  const placed = autoArrange(items, { ...opts, order: items.map((it) => it.id) });
  return items.map((it) => placed.get(it.id)!);
}

// --- Auto-number planning ----------------------------------------------------

export type AutoNumberRow = { id: string; from: string; to: string };

/**
 * The rename plan for auto-numbering: pair each id (already in physical reading
 * order) with the next generated name. The UI shows this as a preview before it
 * is applied; the store turns each row into `new_name` (temp) or `rename_to`
 * (existing) — never an immediate canonical rename.
 */
export function autoNumberPlan(
  orderedIds: readonly string[],
  fromName: (id: string) => string,
  spec: Omit<NameSpec, "count">,
): AutoNumberRow[] {
  const names = generateNames({ ...spec, count: orderedIds.length });
  return orderedIds.map((id, i) => ({ id, from: fromName(id), to: names[i] }));
}

// --- Obstacle extraction (reuse the collision engine's SOLID set) ------------

/**
 * The fixed obstacles an arrangement in one section should route around: every
 * SOLID structure, plus tables that are NOT part of the set being arranged.
 * Openings and decoration (doors, plants, text…) are not obstacles — the same
 * rule the collision warnings use.
 */
export function sectionObstacles(
  sectionElements: readonly DesignerElement[],
  arrangingIds: ReadonlySet<string>,
): Obstacle[] {
  const out: Obstacle[] = [];
  for (const el of sectionElements) {
    if (arrangingIds.has(el.id)) continue;
    const isSolid = el.type === "table" || SOLID_STRUCTURES.has(el.type);
    if (!isSolid) continue;
    out.push({ x: el.x, y: el.y, w: el.w, h: el.h, rotation: el.rotation });
  }
  return out;
}
