// Phase 3D-A — CREATION & LAYOUT AUTOMATION engine. Pure functions behind Quick
// Setup, Bulk Create, Auto-number, Duplicate and deterministic Auto-arrange.
// These pin the two properties the feature depends on: DETERMINISM (same input →
// identical output, physical order independent of UI direction) and DRAFT-ONLY
// creation (a new/duplicated table is a `temp:` intent with no canonical id).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ARRANGE_GAP,
  autoArrange,
  autoNumberPlan,
  bulkLayout,
  DUPLICATE_OFFSET,
  generateNames,
  nameKeySet,
  normalizeName,
  padNumber,
  proposeCopyName,
  readingOrder,
  sectionObstacles,
  validateNameBatch,
  type OrderItem,
} from "@/lib/pos/floorAutomate";
import { orientedExtent } from "@/lib/pos/floorCollision";
import { makeTempTableElement, TABLE_NAME_MAX, type DesignerElement, type ElementGeom } from "@/lib/pos/floorDesigner";

const G = (x: number, y: number, w = 100, h = 100, rotation = 0): ElementGeom => ({ x, y, w, h, rotation });
const I = (id: string, x: number, y: number, w = 100, h = 100, rotation = 0): OrderItem => ({ id, geom: G(x, y, w, h, rotation) });

// --- Naming ------------------------------------------------------------------

test("generateNames builds prefix + counting number, with optional zero-padding", () => {
  assert.deepEqual(generateNames({ prefix: "T", start: 1, count: 3, pad: 0 }), ["T1", "T2", "T3"]);
  assert.deepEqual(generateNames({ prefix: "TR-", start: 1, count: 3, pad: 2 }), ["TR-01", "TR-02", "TR-03"]);
  assert.deepEqual(generateNames({ prefix: "VIP-", start: 5, count: 2, pad: 0 }), ["VIP-5", "VIP-6"]);
  assert.deepEqual(generateNames({ prefix: "T", start: 9, count: 2, pad: 2 }), ["T09", "T10"]);
});

test("padNumber pads to width and never truncates a longer number", () => {
  assert.equal(padNumber(7, 3), "007");
  assert.equal(padNumber(1234, 2), "1234");
  assert.equal(padNumber(5, 0), "5");
});

test("validateNameBatch rejects duplicates, conflicts, empties and over-long names", () => {
  const existing = nameKeySet(["Main 1", "kitchen"]);
  assert.equal(validateNameBatch(["T1", "T2"], existing).ok, true);
  assert.equal(validateNameBatch(["T1", "T1"], new Set()).ok, false, "generated twice");
  assert.equal(validateNameBatch(["Main 1"], existing).ok, false, "conflicts with an existing name (case-insensitive)");
  assert.equal(validateNameBatch(["KITCHEN"], existing).ok, false, "case-insensitive conflict");
  assert.equal(validateNameBatch([""], new Set()).ok, false, "empty");
  assert.equal(validateNameBatch(["x".repeat(TABLE_NAME_MAX + 1)], new Set()).ok, false, "too long");
});

test("proposeCopyName finds a unique “…-copy” and caps at the name limit", () => {
  assert.equal(proposeCopyName("VIP 3", new Set()), "VIP 3-copy");
  assert.equal(proposeCopyName("VIP 3", nameKeySet(["VIP 3-copy"])), "VIP 3-copy2");
  const long = "y".repeat(TABLE_NAME_MAX);
  assert.ok(proposeCopyName(long, new Set()).length <= TABLE_NAME_MAX, "never exceeds the server limit");
});

// --- Physical reading order --------------------------------------------------

test("readingOrder is top-to-bottom then left-to-right by centre — not UI direction", () => {
  // Two rows; deliberately shuffled input. Row 1: a(left) b(right); Row 2: c d.
  const items = [I("d", 300, 300), I("b", 300, 40), I("c", 40, 300), I("a", 40, 40)];
  assert.deepEqual(readingOrder(items).map((o) => o.id), ["a", "b", "c", "d"]);
});

test("readingOrder is deterministic and breaks exact ties by id", () => {
  const a = [I("z", 0, 0), I("a", 0, 0)];
  assert.deepEqual(readingOrder(a).map((o) => o.id), ["a", "z"]);
  // Same geometry, reversed input → same output (stable, geometry-only).
  const b = [I("a", 0, 0), I("z", 0, 0)];
  assert.deepEqual(readingOrder(b).map((o) => o.id), ["a", "z"]);
});

// --- Oriented extent (reused collision math) ---------------------------------

test("orientedExtent uses the collision engine's oriented box for rotated footprints", () => {
  assert.deepEqual(orientedExtent(200, 100, 0), { w: 200, h: 100 });
  const q = orientedExtent(200, 100, 90);
  assert.ok(Math.abs(q.w - 100) < 1e-9 && Math.abs(q.h - 200) < 1e-9, "90° swaps w/h");
  const d = orientedExtent(100, 100, 45);
  assert.ok(Math.abs(d.w - 100 * Math.SQRT2) < 1e-6, "45° square → diagonal-wide enclosing box");
});

// --- Deterministic auto-arrange ----------------------------------------------

test("autoArrange lays a selection into a readable grid from the anchor — same input, same output", () => {
  const items = [I("a", 5, 7), I("b", 500, 9), I("c", 22, 400), I("d", 900, 3)];
  const opts = { anchorX: 0, anchorY: 0, planeW: 400 };
  const r1 = autoArrange(items, { ...opts, order: readingOrder(items).map((o) => o.id) });
  const r2 = autoArrange(items, { ...opts, order: readingOrder(items).map((o) => o.id) });
  assert.deepEqual([...r1.entries()], [...r2.entries()], "deterministic: byte-equal layout");
  // Every id is placed, and only those ids.
  assert.deepEqual(new Set(r1.keys()), new Set(["a", "b", "c", "d"]));
});

test("autoArrange never overlaps two arranged tables (cells sized to the largest footprint)", () => {
  const items = [I("a", 0, 0, 100, 60), I("b", 0, 0, 80, 140), I("c", 0, 0, 120, 120), I("d", 0, 0, 60, 60)];
  const out = autoArrange(items, { anchorX: 0, anchorY: 0, planeW: 500, order: ["a", "b", "c", "d"] });
  const boxes = [...out.entries()].map(([, g]) => ({ minX: g.x, minY: g.y, maxX: g.x + g.w, maxY: g.y + g.h }));
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const overlap = a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
      assert.ok(!overlap, `arranged tables ${i}/${j} must not overlap`);
    }
});

test("autoArrange keeps each table's own size and rotation — only x/y move", () => {
  const items = [I("a", 0, 0, 120, 80, 90), I("b", 0, 0, 100, 100, 0)];
  const out = autoArrange(items, { anchorX: 10, anchorY: 10, planeW: 400, order: ["a", "b"] });
  assert.deepEqual({ w: out.get("a")!.w, h: out.get("a")!.h, rotation: out.get("a")!.rotation }, { w: 120, h: 80, rotation: 90 });
});

test("autoArrange routes around fixed obstacles (skips occupied cells)", () => {
  // One item, an obstacle sitting exactly on the first cell → the item lands elsewhere.
  const items = [I("t", 0, 0, 100, 100)];
  const noObstacle = autoArrange(items, { anchorX: 0, anchorY: 0, planeW: 1000, order: ["t"] }).get("t")!;
  const withObstacle = autoArrange(items, {
    anchorX: 0,
    anchorY: 0,
    planeW: 1000,
    order: ["t"],
    obstacles: [{ x: noObstacle.x, y: noObstacle.y, w: 100, h: 100, rotation: 0 }],
  }).get("t")!;
  assert.ok(withObstacle.x !== noObstacle.x || withObstacle.y !== noObstacle.y, "the item avoided the obstacle cell");
});

test("autoArrange is independent of any viewport — it takes only logical anchor/plane", () => {
  // The same items at two different anchors shift by exactly the anchor delta.
  const items = [I("a", 0, 0), I("b", 0, 0)];
  const at0 = autoArrange(items, { anchorX: 0, anchorY: 0, planeW: 400, order: ["a", "b"] });
  const at100 = autoArrange(items, { anchorX: 100, anchorY: 60, planeW: 400, order: ["a", "b"] });
  assert.equal(at100.get("a")!.x - at0.get("a")!.x, 100);
  assert.equal(at100.get("a")!.y - at0.get("a")!.y, 60);
});

test("bulkLayout returns count geometries in a deterministic grid, gap ≥ recommended clearance", () => {
  const geoms = bulkLayout(6, { w: 100, h: 100 }, { anchorX: 0, anchorY: 0, planeW: 400 });
  assert.equal(geoms.length, 6);
  // Cells stride by size + ARRANGE_GAP; ARRANGE_GAP sits above the tight envelope.
  assert.ok(ARRANGE_GAP > 30, "arranged grids read as clear, not tight");
  const g2 = bulkLayout(6, { w: 100, h: 100 }, { anchorX: 0, anchorY: 0, planeW: 400 });
  assert.deepEqual(geoms, g2, "deterministic");
});

// --- Auto-number planning ----------------------------------------------------

test("autoNumberPlan pairs each id (already in reading order) with the generated name", () => {
  const plan = autoNumberPlan(["a", "b", "c"], (id) => ({ a: "5", b: "6", c: "7" }[id] ?? ""), { prefix: "T", start: 1, pad: 2 });
  assert.deepEqual(plan, [
    { id: "a", from: "5", to: "T01" },
    { id: "b", from: "6", to: "T02" },
    { id: "c", from: "7", to: "T03" },
  ]);
});

// --- Obstacles ---------------------------------------------------------------

test("sectionObstacles = solid structures + non-arranged tables; openings/decoration excluded", () => {
  const els = [
    { id: "t1", type: "table", x: 0, y: 0, w: 10, h: 10, rotation: 0 },
    { id: "t2", type: "table", x: 20, y: 0, w: 10, h: 10, rotation: 0 },
    { id: "wall", type: "wall", x: 0, y: 40, w: 100, h: 4, rotation: 0 },
    { id: "plant", type: "plant", x: 0, y: 60, w: 8, h: 8, rotation: 0 },
    { id: "door", type: "door", x: 0, y: 80, w: 20, h: 4, rotation: 0 },
  ] as unknown as DesignerElement[];
  const obs = sectionObstacles(els, new Set(["t1"])); // t1 is being arranged
  const ids = new Set(obs.map((o) => `${o.x},${o.y}`));
  assert.ok(ids.has("20,0"), "the other table is an obstacle");
  assert.ok(ids.has("0,40"), "a solid wall is an obstacle");
  assert.ok(!ids.has("0,60"), "a plant is not an obstacle");
  assert.ok(!ids.has("0,80"), "a door/opening is not an obstacle");
  assert.equal(obs.length, 2);
});

// --- Draft-only creation (no canonical id) -----------------------------------

test("a bulk/duplicate table is a temp INTENT: temp_id + new_name, and NO canonical table_id", () => {
  const rec = makeTempTableElement("T7", 4, "s1", G(DUPLICATE_OFFSET, DUPLICATE_OFFSET), "round");
  assert.match(String(rec.temp_id), /^temp:[0-9a-zA-Z_-]{1,64}$/, "server temp-identity shape");
  assert.equal(rec.new_name, "T7");
  assert.equal(rec.table_id, undefined, "never a canonical id — nothing is created before Publish");
  assert.equal(rec.shape, "round");
});

test("normalizeName is a trimmed, case-insensitive key", () => {
  assert.equal(normalizeName("  VIP 3 "), "vip 3");
});
