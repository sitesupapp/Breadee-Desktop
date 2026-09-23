// Phase 3C — COLLISION / SPACING analysis. Pure, advisory, Designer-owned:
// oriented-box (SAT) overlap so rotated tables are judged as their REAL
// rectangles, a single documented clearance constant for "tight", solid
// structures participate, decorative objects never do, and re-running the pure
// function after a mutation IS the recompute (no hidden state, nothing blocks
// an autosave — the module cannot even reach the network).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  analyzeCollisions,
  NON_SOLID_STRUCTURES,
  RECOMMENDED_CLEARANCE,
  SOLID_STRUCTURES,
} from "@/lib/pos/floorCollision";
import type { DesignerElement } from "@/lib/pos/floorDesigner";
import type { FloorElementType } from "@/lib/pos/floor";

let n = 0;
function el(o: Partial<DesignerElement> & { x: number; y: number; w: number; h: number }): DesignerElement {
  return {
    id: o.id ?? `e${++n}`,
    sectionId: "s1",
    type: (o.type ?? "table") as FloorElementType,
    rotation: o.rotation ?? 0,
    shape: null,
    tableId: o.type && o.type !== "table" ? null : `T-${n}`,
    label: null,
    tempId: null,
    newName: null,
    seats: null,
    renameTo: null,
    ...o,
  } as DesignerElement;
}

test("far-apart tables are CLEAR", () => {
  const r = analyzeCollisions([el({ id: "a", x: 0, y: 0, w: 100, h: 100 }), el({ id: "b", x: 500, y: 0, w: 100, h: 100 })]);
  assert.equal(r.collisions, 0);
  assert.equal(r.tight, 0);
  assert.equal(r.statusById.get("a"), "clear");
});

test("overlapping tables are a COLLISION", () => {
  const r = analyzeCollisions([el({ id: "a", x: 0, y: 0, w: 100, h: 100 }), el({ id: "b", x: 60, y: 60, w: 100, h: 100 })]);
  assert.equal(r.collisions, 1);
  assert.equal(r.statusById.get("a"), "collision");
  assert.equal(r.statusById.get("b"), "collision");
});

test("closer than the recommended clearance is TIGHT; exactly beyond it is CLEAR", () => {
  // Gap of 10 (< RECOMMENDED_CLEARANCE) → tight.
  const tight = analyzeCollisions([el({ id: "a", x: 0, y: 0, w: 100, h: 100 }), el({ id: "b", x: 110, y: 0, w: 100, h: 100 })]);
  assert.equal(tight.tight, 1);
  assert.equal(tight.statusById.get("a"), "tight");
  // Gap just past the clearance → clear.
  const clear = analyzeCollisions([
    el({ id: "a", x: 0, y: 0, w: 100, h: 100 }),
    el({ id: "b", x: 100 + RECOMMENDED_CLEARANCE + 2, y: 0, w: 100, h: 100 }),
  ]);
  assert.equal(clear.tight, 0);
  assert.equal(clear.statusById.get("b"), "clear");
});

test("ROTATED tables are judged as real rectangles, not their bounding boxes", () => {
  // A 200×20 sliver rotated 90° really occupies a tall 20×200 area around
  // x≈90..110. An unrotated-box model (x 0..200) would claim it hits a table at
  // x 130..190 — SAT must not report a collision there.
  const sliver = el({ id: "s", x: 0, y: 90, w: 200, h: 20, rotation: 90 });
  const neighbour = el({ id: "nb", x: 130, y: 92, w: 60, h: 16 });
  const r = analyzeCollisions([sliver, neighbour]);
  assert.equal(
    r.pairs.filter((p) => p.status === "collision").length,
    0,
    "the rotated sliver's real footprint does not touch x=130..190",
  );
  // …and a genuinely overlapping rotated pair IS caught.
  const hit = analyzeCollisions([sliver, el({ id: "c", x: 95, y: 150, w: 30, h: 30 })]);
  assert.equal(hit.statusById.get("c"), "collision");
});

test("a table against a SOLID structure warns; decorative objects never do", () => {
  assert.ok(SOLID_STRUCTURES.has("wall") && NON_SOLID_STRUCTURES.has("plant"));
  const table = el({ id: "t", x: 0, y: 0, w: 100, h: 100 });
  const wall = el({ id: "w", type: "wall", x: 50, y: 50, w: 200, h: 10 });
  const plant = el({ id: "p", type: "plant", x: 50, y: 50, w: 40, h: 40 });
  const text = el({ id: "x", type: "text", x: 10, y: 10, w: 80, h: 20 });
  const r = analyzeCollisions([table, wall, plant, text]);
  assert.equal(r.statusById.get("t"), "collision", "the wall through the table is flagged");
  assert.ok(!r.pairs.some((p) => p.a === "p" || p.b === "p"), "the plant is decoration, not an obstacle");
  assert.ok(!r.pairs.some((p) => p.a === "x" || p.b === "x"), "text labels are never obstacles");
});

test("structure ↔ structure contact is not warned about (walls legitimately meet counters)", () => {
  const r = analyzeCollisions([
    el({ id: "w1", type: "wall", x: 0, y: 0, w: 200, h: 10 }),
    el({ id: "c1", type: "counter", x: 100, y: 0, w: 80, h: 40 }),
  ]);
  assert.equal(r.pairs.length, 0);
});

test("recompute = re-run: moving a table out of collision clears it (pure function, no hidden state)", () => {
  const before = analyzeCollisions([el({ id: "a", x: 0, y: 0, w: 100, h: 100 }), el({ id: "b", x: 50, y: 0, w: 100, h: 100 })]);
  assert.equal(before.statusById.get("b"), "collision");
  const after = analyzeCollisions([el({ id: "a", x: 0, y: 0, w: 100, h: 100 }), el({ id: "b", x: 400, y: 0, w: 100, h: 100 })]);
  assert.equal(after.statusById.get("b"), "clear");
});
