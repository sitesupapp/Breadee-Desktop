// COLLISION / SPACING analysis for the Floor Designer (Phase 3C).
//
// Pure geometry, no React, no network, Designer-owned. This is ADVISORY
// feedback for the operator while they lay a room out: it never blocks an
// autosave, never blocks an edit, and never touches canonical POS state.
// Publish-time blockers are a Phase-4 concern.
//
// ROTATED TABLES ARE REAL RECTANGLES HERE. Tables rotate in 15° steps, and
// treating a rotated table as its unrotated box would produce materially wrong
// warnings, so overlap is decided by the separating-axis theorem on ORIENTED
// boxes (~40 lines of pure math, no geometry dependency). Spacing uses the same
// test with both boxes inflated by half the recommended clearance — a
// documented V1 envelope that approximates "less than an aisle apart".
//
// WHAT IS SOLID. Tables are solid. Structures are solid when a guest could not
// walk through them: wall, divider, counter, kitchen, host, stairs, wc.
// Doors, windows and entrances are OPENINGS/markers, and text and plants are
// decorative — none of those produce warnings (a plant pot next to a chair is
// not a layout fault). The set is one exported constant, not scattered rules.
//
// THE CLEARANCE. `RECOMMENDED_CLEARANCE` is 30 logical units — on the standard
// QA floor (~90–150-unit tables) that reads as a modest service aisle. It is a
// single documented Designer constant for restaurant-layout UX guidance and
// explicitly NOT a legal building/fire-code clearance.

import type { DesignerElement } from "@/lib/pos/floorDesigner";
import type { FloorElementType } from "@/lib/pos/floor";

/** Recommended clearance between solid elements, in logical floor units. */
export const RECOMMENDED_CLEARANCE = 30;

/** Structure kinds a guest cannot pass through — they participate in warnings. */
export const SOLID_STRUCTURES: ReadonlySet<FloorElementType> = new Set([
  "wall",
  "divider",
  "counter",
  "kitchen",
  "host",
  "stairs",
  "wc",
]);

/** Kinds that never produce warnings (openings, markers, decoration). */
export const NON_SOLID_STRUCTURES: ReadonlySet<FloorElementType> = new Set([
  "door",
  "window",
  "entrance",
  "text",
  "plant",
]);

export type CollisionStatus = "clear" | "tight" | "collision";

export type CollisionPair = {
  a: string;
  b: string;
  status: Exclude<CollisionStatus, "clear">;
};

export type CollisionReport = {
  /** element id → worst status it participates in. */
  statusById: Map<string, CollisionStatus>;
  pairs: CollisionPair[];
  collisions: number;
  tight: number;
};

type Obb = { corners: { x: number; y: number }[]; axes: { x: number; y: number }[] };

/** The four corners + two edge axes of a (possibly rotated) rectangle. */
function obbOf(x: number, y: number, w: number, h: number, rotationDeg: number, inflate = 0): Obb {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const hw = w / 2 + inflate;
  const hh = h / 2 + inflate;
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const ax = { x: cos, y: sin }; // local +x axis
  const ay = { x: -sin, y: cos }; // local +y axis
  const corners = [
    { x: cx + ax.x * hw + ay.x * hh, y: cy + ax.y * hw + ay.y * hh },
    { x: cx - ax.x * hw + ay.x * hh, y: cy - ax.y * hw + ay.y * hh },
    { x: cx - ax.x * hw - ay.x * hh, y: cy - ax.y * hw - ay.y * hh },
    { x: cx + ax.x * hw - ay.x * hh, y: cy + ax.y * hw - ay.y * hh },
  ];
  return { corners, axes: [ax, ay] };
}

function project(corners: { x: number; y: number }[], axis: { x: number; y: number }): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const c of corners) {
    const p = c.x * axis.x + c.y * axis.y;
    if (p < min) min = p;
    if (p > max) max = p;
  }
  return [min, max];
}

/** Separating-axis overlap test for two oriented boxes. */
function obbsOverlap(a: Obb, b: Obb): boolean {
  for (const axis of [...a.axes, ...b.axes]) {
    const [amin, amax] = project(a.corners, axis);
    const [bmin, bmax] = project(b.corners, axis);
    if (amax < bmin || bmax < amin) return false;
  }
  return true;
}

type SolidItem = { id: string; obb: Obb; obbInflated: Obb; isTable: boolean };

function solidItems(elements: DesignerElement[]): SolidItem[] {
  const out: SolidItem[] = [];
  const half = RECOMMENDED_CLEARANCE / 2;
  for (const el of elements) {
    const isTable = el.type === "table";
    if (!isTable && !SOLID_STRUCTURES.has(el.type)) continue;
    out.push({
      id: el.id,
      isTable,
      obb: obbOf(el.x, el.y, el.w, el.h, el.rotation),
      obbInflated: obbOf(el.x, el.y, el.w, el.h, el.rotation, half),
    });
  }
  return out;
}

/**
 * Analyse one section's elements. Pairs considered: table↔table and
 * table↔solid-structure (two structures may legitimately touch — a wall meets a
 * counter — so structure↔structure is not warned about). Pure and synchronous;
 * memoize on the elements array at the call site.
 */
export function analyzeCollisions(elements: DesignerElement[]): CollisionReport {
  const items = solidItems(elements);
  const statusById = new Map<string, CollisionStatus>();
  const pairs: CollisionPair[] = [];

  const worsen = (id: string, status: CollisionStatus) => {
    const cur = statusById.get(id) ?? "clear";
    if (status === "collision" || (status === "tight" && cur === "clear")) statusById.set(id, status);
  };
  for (const el of elements) if (el.type === "table") statusById.set(el.id, "clear");

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];
      if (!a.isTable && !b.isTable) continue;
      if (obbsOverlap(a.obb, b.obb)) {
        pairs.push({ a: a.id, b: b.id, status: "collision" });
        worsen(a.id, "collision");
        worsen(b.id, "collision");
      } else if (obbsOverlap(a.obbInflated, b.obbInflated)) {
        pairs.push({ a: a.id, b: b.id, status: "tight" });
        worsen(a.id, "tight");
        worsen(b.id, "tight");
      }
    }
  }

  let collisions = 0;
  let tight = 0;
  for (const p of pairs) {
    if (p.status === "collision") collisions++;
    else tight++;
  }
  return { statusById, pairs, collisions, tight };
}
