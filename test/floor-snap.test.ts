// Phase 3C — SNAPPING + GUIDES + viewport reveal. Pure geometry: the threshold
// is a SCREEN feel normalised through the zoom, candidates are edges/centers,
// the closest candidate wins, Alt bypasses, and guides exist only as transient
// render data (they are returned per call and never persisted anywhere).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeMoveSnap,
  computeResizeSnap,
  panToReveal,
  SNAP_THRESHOLD_PX,
  type SnapTarget,
} from "@/lib/pos/floorSnap";
import type { ElementGeom } from "@/lib/pos/floorDesigner";

const G = (o: Partial<ElementGeom> = {}): ElementGeom => ({ x: 100, y: 100, w: 80, h: 60, rotation: 0, ...o });
const T = (x: number, y: number, w = 80, h = 60): SnapTarget => ({ x, y, w, h });

test("an edge within the threshold snaps flush; outside it nothing moves", () => {
  // Target's left edge at 200; moving right edge at 100+80+? → put moving so its
  // right edge is 195 (5px from 200 at scale 1 → inside the 8px threshold).
  const snapped = computeMoveSnap(G({ x: 115 }), [T(200, 300)], 1);
  assert.equal(snapped.geom.x + snapped.geom.w, 200, "right edge snapped to the target's left edge");

  const free = computeMoveSnap(G({ x: 90 }), [T(200, 300)], 1);
  assert.equal(free.geom.x, 90, "30px away — no snap, verbatim placement");
  assert.equal(free.guides.length, 0);
});

test("centers snap to centers", () => {
  // Target center x = 240; moving center = 100+40=140 → moving at x=197 puts its
  // center at 237, 3px away → snaps to 240 (x=200).
  const r = computeMoveSnap(G({ x: 197 }), [T(200, 300)], 1);
  assert.equal(r.geom.x + r.geom.w / 2, 240);
});

test("the CLOSEST candidate wins", () => {
  // Two targets: one edge 6px away, one 3px away → the 3px one is chosen.
  const r = computeMoveSnap(G({ x: 100 }), [T(106, 300, 50, 50), T(103, 500, 50, 50)], 1);
  assert.equal(r.geom.x, 103);
});

test("the threshold is normalised through the zoom (same on-screen feel)", () => {
  // 12 LOGICAL units apart. At scale 1 that is 12px on screen → outside the 8px
  // threshold → no snap. At scale 0.5 it is 6px on screen → snaps.
  const at1 = computeMoveSnap(G({ x: 100 }), [T(192, 100)], 1);
  assert.equal(at1.geom.x, 100, "no snap at 100%");
  const atHalf = computeMoveSnap(G({ x: 100 }), [T(192, 100)], 0.5);
  assert.equal(atHalf.geom.x + atHalf.geom.w, 192, "snaps at 50% because it is 6px on screen");
  // Sanity: the constant itself is the screen feel.
  assert.equal(SNAP_THRESHOLD_PX, 8);
});

test("bypass (Alt) disables snapping entirely", () => {
  const r = computeMoveSnap(G({ x: 115 }), [T(200, 300)], 1, { bypass: true });
  assert.equal(r.geom.x, 115);
  assert.equal(r.guides.length, 0);
});

test("a horizontal AND a vertical guide appear for a two-axis snap, spanning both boxes", () => {
  // Moving box 5px off the target's left edge AND 4px off its top edge.
  const r = computeMoveSnap(G({ x: 205, y: 304 }), [T(200, 300)], 1);
  assert.equal(r.geom.x, 200);
  assert.equal(r.geom.y, 300);
  const v = r.guides.find((g) => g.axis === "v");
  const h = r.guides.find((g) => g.axis === "h");
  assert.ok(v && h, "both guides present");
  assert.equal(v!.at, 200);
  assert.equal(h!.at, 300);
  assert.ok(v!.from <= 300 && v!.to >= 360, "the vertical guide spans both elements");
});

test("guides are per-call render data — a bypassed or distant call returns none (they die with the gesture)", () => {
  assert.equal(computeMoveSnap(G(), [T(500, 500)], 1).guides.length, 0);
});

test("the section-plane centre is a light snap anchor", () => {
  const plane = { x: 0, y: 0, w: 1000, h: 700 };
  // Moving center at 497 → 3 from plane centre 500 → snaps.
  const r = computeMoveSnap(G({ x: 457 }), [], 1, { plane });
  assert.equal(r.geom.x + r.geom.w / 2, 500);
});

test("resize snap nudges only the MOVING edge and never the anchor", () => {
  // SE handle: right edge at 183, target edge at 186 → snap width to 86.
  const r = computeResizeSnap(G({ w: 83 }), "se", [T(186, 300, 40, 40)], 1);
  assert.equal(r.geom.x, 100, "anchor untouched");
  assert.equal(r.geom.w, 86, "right edge snapped to 186");
});

// --- panToReveal (Phase-3B follow-up #2) -------------------------------------

test("panToReveal returns null when the element is already comfortably visible", () => {
  const t = { scale: 1, tx: 0, ty: 0 };
  assert.equal(panToReveal(t, { x: 200, y: 200, w: 100, h: 100 }, { width: 800, height: 600 }), null);
});

test("panToReveal pans minimally (zoom preserved) when the element is hidden past an edge", () => {
  const t = { scale: 1, tx: 0, ty: 0 };
  // Element's right edge at 900 in an 800-wide viewport → pan left just enough.
  const r = panToReveal(t, { x: 800, y: 200, w: 100, h: 100 }, { width: 800, height: 600 }, 24);
  assert.ok(r, "a pan is produced");
  assert.equal(r!.scale, 1, "zoom untouched");
  assert.equal(r!.tx, 800 - 24 - 900, "panned exactly to the margin, no further");
  assert.equal(r!.ty, 0, "the visible axis is left alone");
});
