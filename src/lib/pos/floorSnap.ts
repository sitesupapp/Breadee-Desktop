// SMART SNAPPING + ALIGNMENT GUIDES for the Floor Designer (Phase 3C).
//
// Pure geometry, no React, no DOM, Designer-owned. Everything operates in
// INTRINSIC FLOOR COORDINATES: the snap threshold is specified in SCREEN pixels
// so it FEELS the same at every zoom, and is divided by the view scale before
// being compared with logical distances. Nothing viewport-shaped is ever
// persisted — a snap only nudges the logical geometry the operator was already
// producing, and the guides are transient render artifacts that never enter the
// draft document.
//
// The approved UX is intelligent guides, not a spreadsheet grid: a gesture
// snaps against the EDGES and CENTERS of nearby elements (and the section
// plane's own center), the closest candidate wins, and holding the bypass
// modifier (Alt) moves freely. Snapping is deliberately gentle — outside the
// small threshold the pointer position is used verbatim, so free placement is
// always possible, with or without a keyboard.

import type { ElementGeom } from "@/lib/pos/floorDesigner";
import type { Box, Transform, Viewport } from "@/lib/pos/floorGeometry";

/** How close (ON SCREEN, in px) an edge/center must be before it snaps. */
export const SNAP_THRESHOLD_PX = 8;

/** A rectangle participating in snapping (position + size only). */
export type SnapTarget = { x: number; y: number; w: number; h: number };

/** One transient alignment guide, in logical coordinates. */
export type SnapGuide = {
  axis: "v" | "h";
  /** The logical x (vertical guide) or y (horizontal guide) the line sits at. */
  at: number;
  /** The logical span the line should cover (along the other axis). */
  from: number;
  to: number;
};

export type SnapResult = {
  /** The (possibly) nudged geometry. Identical to the input when nothing snapped. */
  geom: ElementGeom;
  guides: SnapGuide[];
};

type AxisFeature = { value: number; span: [number, number] };

function featuresX(b: SnapTarget): number[] {
  return [b.x, b.x + b.w, b.x + b.w / 2];
}
function featuresY(b: SnapTarget): number[] {
  return [b.y, b.y + b.h, b.y + b.h / 2];
}

function axisSnap(
  movingFeatures: number[],
  candidates: AxisFeature[],
  thresholdLogical: number,
): { delta: number; at: number; span: [number, number] } | null {
  let best: { delta: number; at: number; span: [number, number]; dist: number } | null = null;
  for (const f of movingFeatures) {
    for (const c of candidates) {
      const dist = Math.abs(c.value - f);
      if (dist <= thresholdLogical && (best === null || dist < best.dist)) {
        best = { delta: c.value - f, at: c.value, span: c.span, dist };
      }
    }
  }
  return best;
}

function candidateList(
  targets: SnapTarget[],
  plane: Box | null,
  axis: "x" | "y",
): AxisFeature[] {
  const out: AxisFeature[] = [];
  for (const t of targets) {
    const values = axis === "x" ? featuresX(t) : featuresY(t);
    const span: [number, number] = axis === "x" ? [t.y, t.y + t.h] : [t.x, t.x + t.w];
    for (const value of values) out.push({ value, span });
  }
  if (plane) {
    // The section plane's own centre line — a light "middle of the room" anchor.
    const value = axis === "x" ? plane.x + plane.w / 2 : plane.y + plane.h / 2;
    const span: [number, number] = axis === "x" ? [plane.y, plane.y + plane.h] : [plane.x, plane.x + plane.w];
    out.push({ value, span });
  }
  return out;
}

/**
 * Snap a MOVING box against nearby targets (and the section centre).
 *
 * `scale` converts the on-screen threshold to logical units, so the feel is
 * identical at Fit, 62%, 97% or 200%. `bypass` (the Alt modifier, or any caller
 * decision) disables snapping entirely for the gesture.
 */
export function computeMoveSnap(
  moving: ElementGeom,
  targets: SnapTarget[],
  scale: number,
  opts: { plane?: Box | null; bypass?: boolean } = {},
): SnapResult {
  if (opts.bypass || targets.length === 0 && !opts.plane) return { geom: moving, guides: [] };
  const threshold = SNAP_THRESHOLD_PX / Math.max(scale, 0.0001);

  const sx = axisSnap(featuresX(moving), candidateList(targets, opts.plane ?? null, "x"), threshold);
  const sy = axisSnap(featuresY(moving), candidateList(targets, opts.plane ?? null, "y"), threshold);

  const geom: ElementGeom = {
    ...moving,
    x: moving.x + (sx?.delta ?? 0),
    y: moving.y + (sy?.delta ?? 0),
  };

  const guides: SnapGuide[] = [];
  if (sx) {
    guides.push({
      axis: "v",
      at: sx.at,
      from: Math.min(sx.span[0], geom.y),
      to: Math.max(sx.span[1], geom.y + geom.h),
    });
  }
  if (sy) {
    guides.push({
      axis: "h",
      at: sy.at,
      from: Math.min(sy.span[0], geom.x),
      to: Math.max(sy.span[1], geom.x + geom.w),
    });
  }
  return { geom, guides };
}

/**
 * Snap a RESIZE gesture: only the edges the handle is dragging may snap (to
 * EDGE candidates of nearby targets — centers make poor size anchors), and the
 * anchored corner never moves. Sizes below `min` are left to the caller's
 * clamp; this only nudges within the threshold.
 */
export function computeResizeSnap(
  resized: ElementGeom,
  handle: "nw" | "ne" | "sw" | "se",
  targets: SnapTarget[],
  scale: number,
  opts: { bypass?: boolean; min?: number } = {},
): SnapResult {
  if (opts.bypass || targets.length === 0) return { geom: resized, guides: [] };
  const threshold = SNAP_THRESHOLD_PX / Math.max(scale, 0.0001);
  const min = opts.min ?? 1;

  const movingX = handle === "ne" || handle === "se" ? resized.x + resized.w : resized.x;
  const movingY = handle === "sw" || handle === "se" ? resized.y + resized.h : resized.y;
  const anchorX = handle === "ne" || handle === "se" ? resized.x : resized.x + resized.w;
  const anchorY = handle === "sw" || handle === "se" ? resized.y : resized.y + resized.h;

  const edgeCandidates = (axis: "x" | "y"): AxisFeature[] => {
    const out: AxisFeature[] = [];
    for (const t of targets) {
      const values = axis === "x" ? [t.x, t.x + t.w] : [t.y, t.y + t.h];
      const span: [number, number] = axis === "x" ? [t.y, t.y + t.h] : [t.x, t.x + t.w];
      for (const value of values) out.push({ value, span });
    }
    return out;
  };

  const sx = axisSnap([movingX], edgeCandidates("x"), threshold);
  const sy = axisSnap([movingY], edgeCandidates("y"), threshold);

  let { x, w } = resized;
  let { y, h } = resized;
  if (sx) {
    const snappedEdge = movingX + sx.delta;
    const newW = Math.abs(snappedEdge - anchorX);
    if (newW >= min) {
      w = newW;
      x = Math.min(anchorX, snappedEdge);
    }
  }
  if (sy) {
    const snappedEdge = movingY + sy.delta;
    const newH = Math.abs(snappedEdge - anchorY);
    if (newH >= min) {
      h = newH;
      y = Math.min(anchorY, snappedEdge);
    }
  }

  const geom: ElementGeom = { ...resized, x, y, w, h };
  const guides: SnapGuide[] = [];
  if (sx) guides.push({ axis: "v", at: sx.at, from: Math.min(sx.span[0], geom.y), to: Math.max(sx.span[1], geom.y + geom.h) });
  if (sy) guides.push({ axis: "h", at: sy.at, from: Math.min(sy.span[0], geom.x), to: Math.max(sy.span[1], geom.x + geom.w) });
  return { geom, guides };
}

// --- Inspector viewport compensation (Phase-3B follow-up #2) -----------------

/**
 * Pan the view just enough to reveal `target` (logical box) inside `viewport`,
 * keeping the operator's zoom and as much of their pan as possible. Returns the
 * adjusted transform, or null when the box is already comfortably visible — the
 * caller then leaves the viewport strictly alone (no surprise re-fits).
 */
export function panToReveal(
  transform: Transform,
  target: { x: number; y: number; w: number; h: number },
  viewport: Viewport,
  marginPx = 24,
): Transform | null {
  const s = transform.scale;
  const left = target.x * s + transform.tx;
  const right = (target.x + target.w) * s + transform.tx;
  const top = target.y * s + transform.ty;
  const bottom = (target.y + target.h) * s + transform.ty;

  const boxW = right - left;
  const boxH = bottom - top;
  // A box larger than the viewport is "visible enough" when any of it shows;
  // never fight the operator over it.
  const mx = boxW + 2 * marginPx > viewport.width ? Math.max(0, (viewport.width - boxW) / 2) : marginPx;
  const my = boxH + 2 * marginPx > viewport.height ? Math.max(0, (viewport.height - boxH) / 2) : marginPx;

  let dx = 0;
  let dy = 0;
  if (left < mx) dx = mx - left;
  else if (right > viewport.width - mx) dx = viewport.width - mx - right;
  if (top < my) dy = my - top;
  else if (bottom > viewport.height - my) dy = viewport.height - my - bottom;

  if (dx === 0 && dy === 0) return null;
  return { scale: s, tx: transform.tx + dx, ty: transform.ty + dy };
}
