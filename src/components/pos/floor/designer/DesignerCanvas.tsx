// The editable floor plane for one section (Phases 3A + 3B + 3C).
//
// It reuses the SAME intrinsic-coordinate model and the SAME pure geometry as the
// read-only Service canvas (`lib/pos/floorGeometry.ts`): one section plane with a
// single translate+scale transform, elements positioned in logical units, Fit
// clamped so a table never shrinks below a usable size. Structures paint first as
// inert context (reusing `FloorObject`); tables paint on top and are editable.
//
// ONE pointer gesture is live at a time, decided at press time by what is under
// the pointer: a resize handle, the rotate knob, a table body (select + move —
// moving a member of a multi-selection moves the GROUP), or the background
// (pan / deselect). Screen deltas are turned into LOGICAL edits by the pure
// helpers and persisted through the store; nothing viewport-shaped is ever
// written to the draft.
//
// PHASE 3C. Moves and resizes SNAP against nearby elements and the section
// centre (threshold normalised through the zoom so it feels the same at any
// scale; hold Alt to bypass), transient ALIGNMENT GUIDES appear only while a
// gesture is snapping and vanish with it, Ctrl/Cmd+click toggles tables into a
// multi-selection, and a drag on any selected member moves the whole group as
// ONE draft mutation. Collision/spacing status arrives from the shell as a pure
// per-element projection and is rendered as quiet advisory chrome — never
// blocking an edit, never leaving the Designer.

import { useEffect, useMemo, useRef, useState } from "react";
import { DesignerStructureNode } from "@/components/pos/floor/designer/DesignerStructureNode";
import { DesignerTableNode } from "@/components/pos/floor/designer/DesignerTableNode";
import {
  clampPan,
  computeFit,
  sectionPlane,
  toScreen,
  zoomAt,
  ZOOM_STEP,
  type Transform,
  type Viewport,
} from "@/lib/pos/floorGeometry";
import {
  applyDrag,
  applyResize,
  applyRotate,
  geomOf,
  type DesignerElement,
  type ElementGeom,
  type ResizeHandle,
} from "@/lib/pos/floorDesigner";
import { computeMoveSnap, computeResizeSnap, type SnapGuide, type SnapTarget } from "@/lib/pos/floorSnap";
import { bboxOf, moveGroup } from "@/lib/pos/floorArrange";
import type { CollisionStatus } from "@/lib/pos/floorCollision";
import type { FloorSection } from "@/lib/pos/floor";

const TAP_THRESHOLD_PX = 4;

type Gesture =
  | { kind: "pan"; startX: number; startY: number; base: Transform; moved: boolean }
  | {
      kind: "move";
      ids: string[];
      startX: number;
      startY: number;
      bases: Map<string, ElementGeom>;
      bbox0: { x: number; y: number; w: number; h: number };
      scale: number;
      moved: boolean;
    }
  | { kind: "resize"; id: string; handle: ResizeHandle; startX: number; startY: number; base: ElementGeom; scale: number }
  | { kind: "rotate"; id: string; base: ElementGeom; centerScreen: { x: number; y: number } };

export type DesignerLabel = { label: string; renamed: boolean; isNew: boolean };

export function DesignerCanvas({
  section,
  elements,
  selectedIds,
  editable,
  transform,
  labelFor,
  warnFor,
  onTransform,
  onSelect,
  onToggleSelect,
  onCommit,
  onCommitGroup,
}: {
  section: FloorSection | null;
  elements: DesignerElement[];
  selectedIds: string[];
  editable: boolean;
  transform: Transform | null;
  /** Read-only identity projection for a table element. */
  labelFor: (el: DesignerElement) => DesignerLabel;
  /** Advisory collision/spacing status for a table element (pure projection). */
  warnFor: (el: DesignerElement) => CollisionStatus;
  onTransform: (t: Transform) => void;
  onSelect: (id: string | null) => void;
  onToggleSelect: (id: string) => void;
  onCommit: (id: string, geom: ElementGeom) => void;
  /** Group movement — ONE draft mutation for every member. */
  onCommitGroup: (entries: [string, ElementGeom][]) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<Viewport>({ width: 0, height: 0 });
  const gesture = useRef<Gesture | null>(null);
  /** Transient alignment guides — live only while a gesture is snapping. */
  const [guides, setGuides] = useState<SnapGuide[]>([]);

  const plane = useMemo(() => sectionPlane(section, elements), [section, elements]);
  const structures = useMemo(() => elements.filter((e) => e.type !== "table"), [elements]);
  const tableEls = useMemo(() => elements.filter((e) => e.type === "table"), [elements]);
  const scale = transform?.scale ?? 1;

  // Fit when there is no transform yet (first render of a section, or a Fit
  // request cleared it). Same measurement-driven approach as the service canvas.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = () => {
      const vp = { width: el.clientWidth, height: el.clientHeight };
      viewportRef.current = vp;
      if (transform === null && vp.width > 0 && vp.height > 0) {
        onTransform(computeFit(plane, vp, elements).transform);
      }
    };
    apply();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transform, plane, elements]);

  const t: Transform = transform ?? { scale: 1, tx: 0, ty: 0 };

  // Any element can be the primary selection now (Phase 3D-B makes structures
  // editable), so resize/rotate must resolve tables AND structures.
  const elementById = (id: string) => elements.find((e) => e.id === id) ?? null;

  /** Snap targets: every element in the section EXCEPT the ones being moved. */
  const snapTargets = (excluded: Set<string>): SnapTarget[] =>
    elements.filter((e) => !excluded.has(e.id)).map((e) => ({ x: e.x, y: e.y, w: e.w, h: e.h }));

  const onPointerDown = (e: React.PointerEvent) => {
    if (transform === null) return;
    const target = e.target as HTMLElement;
    ref.current?.setPointerCapture?.(e.pointerId);

    const primaryId = selectedIds.length > 0 ? selectedIds[selectedIds.length - 1] : null;
    const handleEl = editable ? target.closest("[data-designer-handle]") : null;
    const rotateEl = editable ? target.closest("[data-designer-rotate]") : null;
    const tableEl = target.closest("[data-designer-element-id]");
    const elementId = tableEl?.getAttribute("data-designer-element-id") ?? null;

    if (editable && handleEl && primaryId) {
      const base = elementById(primaryId);
      if (base) {
        gesture.current = {
          kind: "resize",
          id: primaryId,
          handle: handleEl.getAttribute("data-designer-handle") as ResizeHandle,
          startX: e.clientX,
          startY: e.clientY,
          base: geomOf(base),
          scale: t.scale,
        };
        return;
      }
    }
    if (editable && rotateEl && primaryId) {
      const base = elementById(primaryId);
      const rect = ref.current?.getBoundingClientRect();
      if (base && rect) {
        const centerLogical = { x: base.x + base.w / 2, y: base.y + base.h / 2 };
        const centerScreenInPlane = toScreen(centerLogical, t);
        gesture.current = {
          kind: "rotate",
          id: primaryId,
          base: geomOf(base),
          centerScreen: { x: rect.left + centerScreenInPlane.x, y: rect.top + centerScreenInPlane.y },
        };
        return;
      }
    }
    if (elementId) {
      // Ctrl/Cmd toggles a table in the multi-selection — no drag starts.
      if (e.ctrlKey || e.metaKey) {
        onToggleSelect(elementId);
        return;
      }
      // A press on an already-selected member keeps the group; otherwise the
      // press replaces the selection with this one element.
      const groupIds = selectedIds.includes(elementId) ? selectedIds : [elementId];
      if (!selectedIds.includes(elementId)) onSelect(elementId);
      if (editable) {
        const bases = new Map<string, ElementGeom>();
        for (const id of groupIds) {
          const el = elements.find((x) => x.id === id);
          if (el) bases.set(id, geomOf(el));
        }
        if (bases.size > 0) {
          const entries = [...bases.entries()].map(([id, geom]) => ({ id, geom }));
          gesture.current = {
            kind: "move",
            ids: [...bases.keys()],
            startX: e.clientX,
            startY: e.clientY,
            bases,
            bbox0: bboxOf(entries),
            scale: t.scale,
            moved: false,
          };
        }
      }
      return;
    }
    // Background: pan, and (if it turns out to be a tap) deselect on release.
    gesture.current = { kind: "pan", startX: e.clientX, startY: e.clientY, base: transform, moved: false };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g) return;

    if (g.kind === "pan") {
      const dx = e.clientX - g.startX;
      const dy = e.clientY - g.startY;
      if (!g.moved && Math.hypot(dx, dy) < TAP_THRESHOLD_PX) return;
      g.moved = true;
      onTransform(clampPan({ scale: g.base.scale, tx: g.base.tx + dx, ty: g.base.ty + dy }, plane, viewportRef.current));
      return;
    }
    if (g.kind === "move") {
      const dx = e.clientX - g.startX;
      const dy = e.clientY - g.startY;
      if (!g.moved && Math.hypot(dx, dy) < TAP_THRESHOLD_PX) return;
      g.moved = true;
      // The GROUP's bounding box does the snapping; every member then moves by
      // the same logical delta, so relative spacing is preserved exactly.
      const rawBbox: ElementGeom = {
        ...applyDrag({ ...g.bbox0, rotation: 0 }, dx, dy, g.scale),
        w: g.bbox0.w,
        h: g.bbox0.h,
      };
      const excluded = new Set(g.ids);
      const snap = computeMoveSnap(rawBbox, snapTargets(excluded), g.scale, {
        plane,
        bypass: e.altKey,
      });
      setGuides(snap.guides);
      const deltaX = snap.geom.x - g.bbox0.x;
      const deltaY = snap.geom.y - g.bbox0.y;
      const entries = [...g.bases.entries()].map(([id, geom]) => ({ id, geom }));
      const movedMap = moveGroup(entries, deltaX, deltaY);
      onCommitGroup([...movedMap.entries()]);
      return;
    }
    if (g.kind === "resize") {
      const dx = e.clientX - g.startX;
      const dy = e.clientY - g.startY;
      const resized = applyResize(g.base, g.handle, dx, dy, g.scale);
      const snap = computeResizeSnap(resized, g.handle, snapTargets(new Set([g.id])), g.scale, {
        bypass: e.altKey,
      });
      setGuides(snap.guides);
      onCommit(g.id, snap.geom);
      return;
    }
    // rotate — absolute angle from the element centre to the pointer.
    const deg = Math.atan2(e.clientY - g.centerScreen.y, e.clientX - g.centerScreen.x) * (180 / Math.PI) + 90;
    onCommit(g.id, applyRotate(g.base, deg));
  };

  const endGesture = (e: React.PointerEvent) => {
    const g = gesture.current;
    ref.current?.releasePointerCapture?.(e.pointerId);
    gesture.current = null;
    // Guides live only for the duration of a gesture.
    setGuides([]);
    // A background press that never moved is a deselect.
    if (g && g.kind === "pan" && !g.moved) onSelect(null);
  };

  const onWheel = (e: React.WheelEvent) => {
    if (transform === null) return;
    e.preventDefault();
    const rect = ref.current?.getBoundingClientRect();
    const focus = { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
    const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    onTransform(clampPan(zoomAt(transform, factor, focus), plane, viewportRef.current));
  };

  const guideThickness = 1 / Math.max(scale, 0.0001);

  return (
    <div
      ref={ref}
      className="relative h-full w-full touch-none select-none overflow-hidden rounded-xl border border-line bg-canvas"
      style={{
        // A light editing grid — this IS a designer surface, so the dots are a
        // touch stronger than the service map's near-invisible orientation dots.
        backgroundImage: "radial-gradient(rgb(148 163 184 / 0.22) 1px, transparent 1px)",
        backgroundSize: "24px 24px",
        cursor: gesture.current?.kind === "pan" ? "grabbing" : "default",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endGesture}
      onPointerCancel={endGesture}
      onWheel={onWheel}
      data-designer-canvas
    >
      <div
        className="absolute left-0 top-0 origin-top-left"
        style={{ transform: `translate(${t.tx}px, ${t.ty}px) scale(${t.scale})` }}
      >
        {structures.map((el) => (
          <DesignerStructureNode
            key={el.id}
            element={el}
            selected={selectedIds.includes(el.id)}
            editable={editable}
            scale={scale}
          />
        ))}
        {tableEls.map((el) => {
          const id = labelFor(el);
          return (
            <DesignerTableNode
              key={el.id}
              element={el}
              label={id.label}
              renamed={id.renamed}
              isNew={id.isNew}
              warn={warnFor(el)}
              selected={selectedIds.includes(el.id)}
              editable={editable}
              scale={scale}
            />
          );
        })}
        {/* Transient alignment guides — lightweight, gesture-scoped, never saved. */}
        {guides.map((gd, i) =>
          gd.axis === "v" ? (
            <div
              key={`g${i}`}
              aria-hidden
              className="pointer-events-none absolute bg-floor-select/50"
              style={{ left: gd.at, top: gd.from, width: guideThickness, height: Math.max(0, gd.to - gd.from) }}
            />
          ) : (
            <div
              key={`g${i}`}
              aria-hidden
              className="pointer-events-none absolute bg-floor-select/50"
              style={{ top: gd.at, left: gd.from, height: guideThickness, width: Math.max(0, gd.to - gd.from) }}
            />
          ),
        )}
      </div>
    </div>
  );
}
