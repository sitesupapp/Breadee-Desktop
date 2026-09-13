// Floor geometry: Fit (with the Gate-2.1 min-size clamp), zoom-about-a-point,
// pan bounds and the density thresholds. Pure math, so every rule is pinned here
// rather than eyeballed in a running app.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  boundsOfElements,
  clampPan,
  clampScale,
  computeFit,
  densityLevel,
  MAX_SCALE,
  MIN_SCALE,
  MIN_TABLE_SCREEN_PX,
  minReadableScale,
  sectionPlane,
  smallestTableDimension,
  toLogical,
  toScreen,
  zoomAt,
} from "@/lib/pos/floorGeometry";
import type { FloorElement } from "@/lib/pos/floor";

const tbl = (over: Partial<FloorElement> = {}): FloorElement => ({
  id: "e", sectionId: "s", type: "table", x: 0, y: 0, w: 60, h: 60,
  rotation: 0, shape: "sq", tableId: "t", label: null, ...over,
});

test("boundsOfElements encloses every element", () => {
  const b = boundsOfElements([tbl({ x: 10, y: 20, w: 40, h: 40 }), tbl({ x: 100, y: 50, w: 60, h: 60 })]);
  assert.deepEqual(b, { x: 10, y: 20, w: 150, h: 90 });
  assert.equal(boundsOfElements([]), null);
});

test("sectionPlane prefers an authored size and otherwise derives one", () => {
  assert.deepEqual(sectionPlane({ w: 800, h: 600 }, []), { x: 0, y: 0, w: 800, h: 600 });
  const derived = sectionPlane(null, [tbl({ x: 100, y: 100, w: 60, h: 60 })]);
  assert.ok(derived.w > 60 && derived.h > 60); // includes margin
});

test("minReadableScale keeps the smallest table at least MIN_TABLE_SCREEN_PX", () => {
  const els = [tbl({ w: 60, h: 60 }), tbl({ id: "e2", w: 40, h: 90 })];
  assert.equal(smallestTableDimension(els), 40);
  assert.equal(minReadableScale(els), MIN_TABLE_SCREEN_PX / 40);
  // No tables → nothing to protect → the absolute minimum.
  assert.equal(minReadableScale([tbl({ type: "wall" })]), MIN_SCALE);
});

test("Fit never shrinks a table below the usable floor — 1366×768", () => {
  const els = Array.from({ length: 20 }, (_, i) => tbl({ id: `t${i}`, x: (i % 5) * 400, y: Math.floor(i / 5) * 400, w: 60, h: 60 }));
  const plane = sectionPlane(null, els);
  const { transform, clamped } = computeFit(plane, { width: 1366, height: 768 }, els);
  assert.equal(clamped, true); // a big room clamps up and pans
  assert.ok(60 * transform.scale >= MIN_TABLE_SCREEN_PX - 1e-6);
});

test("Fit centres a small section and does not clamp — 1920×1080", () => {
  const els = [tbl({ x: 0, y: 0, w: 60, h: 60 }), tbl({ id: "t2", x: 200, y: 100, w: 60, h: 60 })];
  const plane = sectionPlane({ w: 400, h: 300 }, els);
  const vp = { width: 1920, height: 1080 };
  const { transform, clamped } = computeFit(plane, vp, els);
  assert.equal(clamped, false);
  // Centre of the plane maps to the centre of the viewport.
  const centre = toScreen({ x: plane.x + plane.w / 2, y: plane.y + plane.h / 2 }, transform);
  assert.ok(Math.abs(centre.x - vp.width / 2) < 0.5);
  assert.ok(Math.abs(centre.y - vp.height / 2) < 0.5);
});

test("clampScale holds the absolute rails", () => {
  assert.equal(clampScale(0.0001), MIN_SCALE);
  assert.equal(clampScale(99), MAX_SCALE);
});

test("zoomAt keeps the point under the cursor fixed", () => {
  const t = { scale: 1, tx: 0, ty: 0 };
  const focus = { x: 100, y: 50 };
  const logicalBefore = toLogical(focus, t);
  const z = zoomAt(t, 2, focus);
  const screenAfter = toScreen(logicalBefore, z);
  assert.ok(Math.abs(screenAfter.x - focus.x) < 1e-6);
  assert.ok(Math.abs(screenAfter.y - focus.y) < 1e-6);
  assert.equal(z.scale, 2);
});

test("clampPan centres content smaller than the viewport", () => {
  const plane = { x: 0, y: 0, w: 100, h: 100 };
  const vp = { width: 1000, height: 800 };
  const t = clampPan({ scale: 1, tx: 9999, ty: -9999 }, plane, vp);
  // Content (100×100) is far smaller than the viewport → centred regardless of input.
  assert.ok(Math.abs(t.tx - (1000 - 100) / 2) < 1e-6);
  assert.ok(Math.abs(t.ty - (800 - 100) / 2) < 1e-6);
});

test("clampPan bounds a large plane within an overscroll margin", () => {
  const plane = { x: 0, y: 0, w: 4000, h: 4000 };
  const vp = { width: 800, height: 600 };
  const scale = 1;
  // Pushed hard to the right/top; the left/top edge cannot drift past the margin.
  const t = clampPan({ scale, tx: 100000, ty: 100000 }, plane, vp);
  assert.ok(t.tx <= vp.width * 0.12 + 1e-6);
  assert.ok(t.ty <= vp.height * 0.12 + 1e-6);
});

test("densityLevel steps from far to close as a table grows on screen", () => {
  const ref = 80;
  assert.equal(densityLevel(0.5, ref), "far"); // 40px
  assert.equal(densityLevel(1.5, ref), "normal"); // 120px
  assert.equal(densityLevel(3, ref), "close"); // 240px
});
