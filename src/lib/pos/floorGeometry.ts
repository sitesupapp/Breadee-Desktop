// Pure geometry for the Service Floor Map: bounds, Fit, zoom, pan, and the
// progressive information-density thresholds. No React, no DOM — every function
// is a plain transform of numbers so the hard parts (Fit clamping, zoom-about-a-
// point, pan bounds) are unit-tested without a renderer.
//
// COORDINATE MODEL. Elements live in intrinsic LOGICAL units from the published
// document. A single `Transform { scale, tx, ty }` maps a logical point to a
// screen point: screen = logical * scale + t. The whole section plane gets ONE
// transform; individual elements are positioned absolutely in logical units and
// never re-scaled themselves.
//
// THE FIT GUARDRAIL (Gate-2.1, mandatory). Fit-to-section must never shrink an
// operational table below a usable/tappable size. `computeFit` therefore clamps
// the fit scale UP to a floor derived from the smallest table, and when that
// makes the content larger than the viewport the caller simply pans — a readable,
// tappable floor you scroll always beats an unreadable one that "fits".

import type { FloorElement } from "@/lib/pos/floor";

export type Box = { x: number; y: number; w: number; h: number };
export type Viewport = { width: number; height: number };
export type Transform = { scale: number; tx: number; ty: number };

/** A table must never render smaller than this on screen (well above the 44px touch floor). */
export const MIN_TABLE_SCREEN_PX = 56;
/** Absolute scale rails, independent of content. */
export const MIN_SCALE = 0.05;
export const MAX_SCALE = 4;
/** Fraction of the viewport kept as breathing room around a fitted section. */
export const FIT_PADDING = 0.06;
/** One tap of the +/- control. */
export const ZOOM_STEP = 1.25;
/** Fallback logical plane when a section has neither authored size nor elements. */
export const DEFAULT_PLANE: Box = { x: 0, y: 0, w: 1000, h: 700 };

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function clampScale(scale: number): number {
  return clamp(scale, MIN_SCALE, MAX_SCALE);
}

/** Axis-aligned bounds enclosing every element (x..x+w, y..y+h). */
export function boundsOfElements(elements: FloorElement[]): Box | null {
  if (elements.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const e of elements) {
    if (e.x < minX) minX = e.x;
    if (e.y < minY) minY = e.y;
    if (e.x + e.w > maxX) maxX = e.x + e.w;
    if (e.y + e.h > maxY) maxY = e.y + e.h;
  }
  return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
}

/**
 * The logical plane to fit. An authored section size wins (it encodes the
 * designer's intended spacing); otherwise derive it from the elements with a
 * small margin; otherwise a sane default so an empty section still renders a
 * plane rather than dividing by zero.
 */
export function sectionPlane(
  section: { w: number | null; h: number | null } | null,
  elements: FloorElement[],
): Box {
  if (section && section.w != null && section.h != null) {
    return { x: 0, y: 0, w: section.w, h: section.h };
  }
  const b = boundsOfElements(elements);
  if (!b) return DEFAULT_PLANE;
  const marginX = b.w * 0.05;
  const marginY = b.h * 0.05;
  return { x: b.x - marginX, y: b.y - marginY, w: b.w + marginX * 2, h: b.h + marginY * 2 };
}

/** The smallest table footprint dimension, used to set the Fit floor. */
export function smallestTableDimension(elements: FloorElement[]): number | null {
  let min = Infinity;
  for (const e of elements) {
    if (e.type !== "table") continue;
    min = Math.min(min, e.w, e.h);
  }
  return Number.isFinite(min) ? min : null;
}

/** A representative table footprint, used for density thresholds. */
export function referenceTableDimension(elements: FloorElement[]): number {
  const dims: number[] = [];
  for (const e of elements) {
    if (e.type !== "table") continue;
    dims.push(Math.min(e.w, e.h));
  }
  if (dims.length === 0) return 80;
  dims.sort((a, b) => a - b);
  return dims[Math.floor(dims.length / 2)];
}

/**
 * The scale floor that keeps the SMALLEST table at least `MIN_TABLE_SCREEN_PX`.
 * When there are no tables (a structures-only section), there is nothing to
 * protect, so the floor is just the absolute minimum.
 */
export function minReadableScale(elements: FloorElement[]): number {
  const smallest = smallestTableDimension(elements);
  if (smallest == null || smallest <= 0) return MIN_SCALE;
  return clampScale(MIN_TABLE_SCREEN_PX / smallest);
}

/**
 * Fit a plane into a viewport, clamped so tables stay usable (Gate-2.1).
 *
 * Returns the transform AND whether the fit was clamped (content overflows and
 * the caller should enable panning). Centering is exact: when the (clamped)
 * content is larger than the viewport it is centered and overflows equally on
 * both axes, which pan then reveals.
 */
export function computeFit(
  plane: Box,
  viewport: Viewport,
  elements: FloorElement[],
): { transform: Transform; clamped: boolean } {
  const vw = Math.max(1, viewport.width);
  const vh = Math.max(1, viewport.height);
  const usableW = vw * (1 - FIT_PADDING * 2);
  const usableH = vh * (1 - FIT_PADDING * 2);
  const rawFit = Math.min(usableW / plane.w, usableH / plane.h);
  const floor = minReadableScale(elements);
  const scale = clampScale(Math.max(rawFit, floor));
  const clamped = scale > rawFit + 1e-9;
  const contentW = plane.w * scale;
  const contentH = plane.h * scale;
  const tx = (vw - contentW) / 2 - plane.x * scale;
  const ty = (vh - contentH) / 2 - plane.y * scale;
  return { transform: { scale, tx, ty }, clamped };
}

/**
 * Keep the plane from drifting off screen. When the content is smaller than the
 * viewport on an axis it is centered on that axis; when larger, panning is
 * allowed up to the plane edges plus a small overscroll margin so a table at the
 * very edge can be brought clear of the chrome.
 */
export function clampPan(transform: Transform, plane: Box, viewport: Viewport): Transform {
  const vw = Math.max(1, viewport.width);
  const vh = Math.max(1, viewport.height);
  const s = transform.scale;
  const contentW = plane.w * s;
  const contentH = plane.h * s;
  const marginX = vw * 0.12;
  const marginY = vh * 0.12;

  const axis = (t: number, content: number, planeStart: number, view: number, margin: number): number => {
    const originAtZero = -planeStart * s; // tx that puts the plane's own origin at screen 0
    if (content <= view) {
      // Center the plane within the viewport.
      return originAtZero + (view - content) / 2;
    }
    const min = view - (planeStart + (content / s)) * s - margin; // right/bottom edge reachable
    const max = originAtZero + margin; // left/top edge reachable
    return clamp(t, min, max);
  };

  return {
    scale: s,
    tx: axis(transform.tx, contentW, plane.x, vw, marginX),
    ty: axis(transform.ty, contentH, plane.y, vh, marginY),
  };
}

/** Zoom by `factor` while holding the logical point under `focus` (screen px) fixed. */
export function zoomAt(transform: Transform, factor: number, focus: { x: number; y: number }): Transform {
  const newScale = clampScale(transform.scale * factor);
  const ratio = newScale / transform.scale;
  return {
    scale: newScale,
    tx: focus.x - (focus.x - transform.tx) * ratio,
    ty: focus.y - (focus.y - transform.ty) * ratio,
  };
}

/** Screen pixel for a logical point. */
export function toScreen(point: { x: number; y: number }, transform: Transform): { x: number; y: number } {
  return { x: point.x * transform.scale + transform.tx, y: point.y * transform.scale + transform.ty };
}

/** Logical point for a screen pixel (inverse of `toScreen`). */
export function toLogical(point: { x: number; y: number }, transform: Transform): { x: number; y: number } {
  return { x: (point.x - transform.tx) / transform.scale, y: (point.y - transform.ty) / transform.scale };
}

export type DensityLevel = "far" | "normal" | "close";

/**
 * Progressive information density from how large a representative table renders.
 * FAR: shape + name + status only (chairs/detail hidden). NORMAL: name + seats or
 * name + elapsed. CLOSE: everything normal, drawn larger.
 */
export function densityLevel(scale: number, referenceDimension: number): DensityLevel {
  const px = referenceDimension * scale;
  if (px < 92) return "far";
  if (px > 168) return "close";
  return "normal";
}

/** Human-readable zoom percentage for the controls. */
export function zoomPercent(scale: number): number {
  return Math.round(scale * 100);
}
