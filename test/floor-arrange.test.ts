// Phase 3C — MULTI-SELECT bulk geometry: group move, align, distribute,
// same-size. Pure functions over intrinsic geometry that return ONE result map
// (→ one draft mutation → one autosave). Nothing here touches identity: ids,
// rotation, names and sections pass through untouched.

import { test } from "node:test";
import assert from "node:assert/strict";

import { alignGeoms, bboxOf, distributeGeoms, moveGroup, sameSize, type ArrangeEntry } from "@/lib/pos/floorArrange";
import { applyDrag, type ElementGeom } from "@/lib/pos/floorDesigner";

const E = (id: string, x: number, y: number, w = 100, h = 100, rotation = 0): ArrangeEntry => ({
  id,
  geom: { x, y, w, h, rotation },
});

test("group move applies ONE logical delta to every member — relative spacing exactly preserved", () => {
  const entries = [E("a", 0, 0), E("b", 150, 40), E("c", 320, 90)];
  const moved = moveGroup(entries, 33, -12);
  assert.equal(moved.get("b")!.x - moved.get("a")!.x, 150);
  assert.equal(moved.get("c")!.y - moved.get("b")!.y, 50);
  assert.equal(moved.get("a")!.x, 33);
  assert.equal(moved.get("a")!.y, -12);
});

test("group drag under zoom: the screen delta converts once and every member shifts identically", () => {
  // The canvas computes the delta with the same pure applyDrag used for singles.
  const bbox = { x: 0, y: 0, w: 420, h: 190, rotation: 0 } as ElementGeom;
  const draggedBbox = applyDrag(bbox, 100, 50, 2); // 100px on screen at 200% = 50 logical
  const dx = draggedBbox.x - bbox.x;
  const dy = draggedBbox.y - bbox.y;
  assert.equal(dx, 50);
  assert.equal(dy, 25);
  const moved = moveGroup([E("a", 10, 10), E("b", 200, 100)], dx, dy);
  assert.equal(moved.get("a")!.x, 60);
  assert.equal(moved.get("b")!.y, 125);
});

test("align left/right/top/bottom hug the selection's bounding box", () => {
  const entries = [E("a", 0, 0, 100, 100), E("b", 200, 50, 60, 40), E("c", 400, 20, 80, 40)];
  const box = bboxOf(entries);
  assert.deepEqual([box.x, box.y, box.x + box.w, box.y + box.h], [0, 0, 480, 100]);

  const left = alignGeoms(entries, "left");
  assert.equal(left.get("b")!.x, 0);
  const right = alignGeoms(entries, "right");
  assert.equal(right.get("b")!.x, 480 - 60);
  const top = alignGeoms(entries, "top");
  assert.equal(top.get("b")!.y, 0);
  const bottom = alignGeoms(entries, "bottom");
  assert.equal(bottom.get("b")!.y, 100 - 40);
});

test("align centers put every member on the shared center line", () => {
  const entries = [E("a", 0, 0, 100, 100), E("b", 200, 50, 60, 60)];
  const h = alignGeoms(entries, "hcenter");
  assert.equal(h.get("a")!.x + 50, h.get("b")!.x + 30, "horizontal centers equal");
  const v = alignGeoms(entries, "vcenter");
  assert.equal(v.get("a")!.y + 50, v.get("b")!.y + 30, "vertical centers equal");
});

test("distribute horizontally: outer anchors stay, inner gaps equalise, deterministically", () => {
  const entries = [E("a", 0, 0, 100, 100), E("c", 500, 0, 100, 100), E("b", 120, 0, 100, 100)];
  const out = distributeGeoms(entries, "h");
  assert.equal(out.get("a")!.x, 0, "first anchor untouched");
  assert.equal(out.get("c")!.x, 500, "last anchor untouched");
  // span 0..600, total width 300 → two gaps of 150 → b sits at 250.
  assert.equal(out.get("b")!.x, 250);
  // Determinism: same input, same output.
  assert.deepEqual([...distributeGeoms(entries, "h").entries()], [...out.entries()]);
});

test("distribute vertically mirrors the same rule on y", () => {
  const out = distributeGeoms([E("a", 0, 0, 50, 50), E("b", 0, 60, 50, 50), E("c", 0, 400, 50, 50)], "v");
  assert.equal(out.get("a")!.y, 0);
  assert.equal(out.get("c")!.y, 400);
  assert.equal(out.get("b")!.y, 200, "span 0..450, sizes 150 → gaps 150 → b at 200");
});

test("distribute needs 3+; align needs 2+ (fewer → empty result, no mutation)", () => {
  assert.equal(distributeGeoms([E("a", 0, 0), E("b", 10, 0)], "h").size, 0);
  assert.equal(alignGeoms([E("a", 0, 0)], "left").size, 0);
});

test("same width / height / size copy from the REFERENCE (the primary member) and touch nothing else", () => {
  const entries = [E("a", 0, 0, 100, 40), E("b", 200, 0, 60, 80, 45)];
  const w = sameSize(entries, "b", "width");
  assert.equal(w.get("a")!.w, 60);
  assert.equal(w.get("a")!.h, 40, "height untouched by Same Width");
  assert.equal(w.has("b"), false, "the reference itself never changes");

  const h = sameSize(entries, "b", "height");
  assert.equal(h.get("a")!.h, 80);
  assert.equal(h.get("a")!.w, 100);

  const both = sameSize(entries, "b", "both");
  assert.deepEqual([both.get("a")!.w, both.get("a")!.h], [60, 80]);
  assert.equal(both.get("a")!.rotation, 0, "rotation is never copied");
  assert.equal(both.get("a")!.x, 0, "position is never copied");
});

test("no tool renames, reorders or re-sections — only x/y/w/h ever change", () => {
  const entries = [E("a", 0, 0, 100, 100, 15), E("b", 200, 50, 60, 60, 30)];
  for (const m of [alignGeoms(entries, "left"), sameSize(entries, "a", "both")]) {
    for (const [, g] of m) {
      assert.ok("x" in g && "y" in g && "w" in g && "h" in g && "rotation" in g);
      assert.equal(Object.keys(g).length, 5, "an ElementGeom carries nothing but geometry");
    }
  }
});
