// The editable floor plane for one section (Phases 3A + 3B).
//
// It reuses the SAME intrinsic-coordinate model and the SAME pure geometry as the
// read-only Service canvas (`lib/pos/floorGeometry.ts`): one section plane with a
// single translate+scale transform, elements positioned in logical units, Fit
// clamped so a table never shrinks below a usable size. Structures paint first as
// inert context (reusing `FloorObject`); tables paint on top and are editable.
//
// ONE pointer gesture is live at a time, decided at press time by what is under
// the pointer: a resize handle, the rotate knob, a table body (select + move), or
// the background (pan / deselect). Screen deltas are turned into LOGICAL edits by
// the pure `applyDrag/applyResize/applyRotate` helpers and persisted through the
// store's `commitGeom`; nothing viewport-shaped is ever written to the draft.
//
// IDENTITY (Phase 3B): each table's shown name comes from the read-only
// `labelFor` projection the shell provides (canonical name, staged draft name,
// or a new-table name) — never from operational state.

import { useEffect, useMemo, useRef } from "react";
import { FloorObject } from "@/components/pos/floor/FloorObject";
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
import type { FloorSection } from "@/lib/pos/floor";

const TAP_THRESHOLD_PX = 4;

type Gesture =
  | { kind: "pan"; startX: number; startY: number; base: Transform; moved: boolean }
  | { kind: "move"; id: string; startX: number; startY: number; base: ElementGeom; scale: number; moved: boolean }
  | { kind: "resize"; id: string; handle: ResizeHandle; startX: number; startY: number; base: ElementGeom; scale: number }
  | { kind: "rotate"; id: string; base: ElementGeom; centerScreen: { x: number; y: number } };

export type DesignerLabel = { label: string; renamed: boolean; isNew: boolean };

export function DesignerCanvas({
  section,
  elements,
  selectedId,
  editable,
  transform,
  labelFor,
  onTransform,
  onSelect,
  onCommit,
}: {
  section: FloorSection | null;
  elements: DesignerElement[];
  selectedId: string | null;
  editable: boolean;
  transform: Transform | null;
  /** Read-only identity projection for a table element. */
  labelFor: (el: DesignerElement) => DesignerLabel;
  onTransform: (t: Transform) => void;
  onSelect: (id: string | null) => void;
  onCommit: (id: string, geom: ElementGeom) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<Viewport>({ width: 0, height: 0 });
  const gesture = useRef<Gesture | null>(null);

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

  const elementById = (id: string) => tableEls.find((e) => e.id === id) ?? null;

  const onPointerDown = (e: React.PointerEvent) => {
    if (transform === null) return;
    const target = e.target as HTMLElement;
    ref.current?.setPointerCapture?.(e.pointerId);

    // A resize handle or the rotate knob — only reachable when editable, because
    // the chrome that carries them is not rendered otherwise.
    const handleEl = editable ? target.closest("[data-designer-handle]") : null;
    const rotateEl = editable ? target.closest("[data-designer-rotate]") : null;
    const tableEl = target.closest("[data-designer-element-id]");
    const tableId = tableEl?.getAttribute("data-designer-element-id") ?? null;

    if (editable && handleEl && selectedId) {
      const base = elementById(selectedId);
      if (base) {
        gesture.current = {
          kind: "resize",
          id: selectedId,
          handle: handleEl.getAttribute("data-designer-handle") as ResizeHandle,
          startX: e.clientX,
          startY: e.clientY,
          base: geomOf(base),
          scale: t.scale,
        };
        return;
      }
    }
    if (editable && rotateEl && selectedId) {
      const base = elementById(selectedId);
      const rect = ref.current?.getBoundingClientRect();
      if (base && rect) {
        const centerLogical = { x: base.x + base.w / 2, y: base.y + base.h / 2 };
        const centerScreenInPlane = toScreen(centerLogical, t);
        gesture.current = {
          kind: "rotate",
          id: selectedId,
          base: geomOf(base),
          centerScreen: { x: rect.left + centerScreenInPlane.x, y: rect.top + centerScreenInPlane.y },
        };
        return;
      }
    }
    if (tableId) {
      onSelect(tableId);
      const base = elementById(tableId);
      if (editable && base) {
        gesture.current = {
          kind: "move",
          id: tableId,
          startX: e.clientX,
          startY: e.clientY,
          base: geomOf(base),
          scale: t.scale,
          moved: false,
        };
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
      onCommit(g.id, applyDrag(g.base, dx, dy, g.scale));
      return;
    }
    if (g.kind === "resize") {
      const dx = e.clientX - g.startX;
      const dy = e.clientY - g.startY;
      onCommit(g.id, applyResize(g.base, g.handle, dx, dy, g.scale));
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
          <FloorObject key={el.id} element={el} />
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
              selected={el.id === selectedId}
              editable={editable}
              scale={scale}
            />
          );
        })}
      </div>
    </div>
  );
}
