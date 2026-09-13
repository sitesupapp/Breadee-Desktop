// The floor plane for one section.
//
// ONE section is rendered at a time. Elements are positioned in intrinsic LOGICAL
// units inside a single plane; the plane carries one CSS transform
// (translate + scale) for Fit / zoom / pan, so the published geometry is honoured
// exactly and never re-arranged (§24). Structures paint first (behind, inert),
// then tables (front, interactive), then a transient search halo.
//
// Fit is computed here because only the DOM knows the viewport size; the MATH —
// including the Gate-2.1 clamp that stops tables shrinking below a usable size —
// lives in `lib/pos/floorGeometry.ts` and is unit-tested there. Pan is a drag on
// the background; a tap on a table selects (a drag past a small threshold pans
// instead, and the browser then fires no click). Wheel/trackpad zooms about the
// cursor. Pinch is intentionally not implemented in Phase 2 (§20).

import { useEffect, useMemo, useRef } from "react";
import { FloorObject } from "@/components/pos/floor/FloorObject";
import { FloorTableNode } from "@/components/pos/floor/FloorTableNode";
import { buildFloorNode, indexTables } from "@/lib/pos/floorStatus";
import {
  clampPan,
  computeFit,
  densityLevel,
  referenceTableDimension,
  sectionPlane,
  toScreen,
  zoomAt,
  ZOOM_STEP,
  type Transform,
  type Viewport,
} from "@/lib/pos/floorGeometry";
import type { FloorElement, FloorSection } from "@/lib/pos/floor";
import type { TableSummary } from "@/types/tables";

const PAN_THRESHOLD_PX = 5;

export function FloorCanvas({
  section,
  elements,
  tables,
  selectedTableId,
  focusedTableId,
  flashTableId,
  transform,
  onTransform,
  now,
  onSelect,
}: {
  section: FloorSection | null;
  elements: FloorElement[];
  tables: TableSummary[];
  selectedTableId: string | null;
  focusedTableId: string | null;
  flashTableId: string | null;
  /** null → not yet fitted; the canvas computes Fit on its next measure. */
  transform: Transform | null;
  onTransform: (t: Transform) => void;
  now: number;
  onSelect: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<Viewport>({ width: 0, height: 0 });
  const drag = useRef<{ active: boolean; moved: boolean; startX: number; startY: number; base: Transform } | null>(null);

  const plane = useMemo(() => sectionPlane(section, elements), [section, elements]);
  const refDim = useMemo(() => referenceTableDimension(elements), [elements]);
  const tableIndex = useMemo(() => indexTables(tables), [tables]);

  const structures = useMemo(() => elements.filter((e) => e.type !== "table"), [elements]);
  const tableEls = useMemo(() => elements.filter((e) => e.type === "table"), [elements]);

  // Fit when there is no transform yet (first render of a section, or an explicit
  // Fit request cleared it). Measurement drives it, so it re-fits when the pane
  // is first sized.
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
  const density = densityLevel(t.scale, refDim);

  const onPointerDown = (e: React.PointerEvent) => {
    if (transform === null) return;
    drag.current = { active: true, moved: false, startX: e.clientX, startY: e.clientY, base: transform };
    ref.current?.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d?.active) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.hypot(dx, dy) < PAN_THRESHOLD_PX) return;
    d.moved = true;
    onTransform(clampPan({ scale: d.base.scale, tx: d.base.tx + dx, ty: d.base.ty + dy }, plane, viewportRef.current));
  };
  const endDrag = (e: React.PointerEvent) => {
    if (drag.current?.active) ref.current?.releasePointerCapture?.(e.pointerId);
    drag.current = null;
  };

  const onWheel = (e: React.WheelEvent) => {
    if (transform === null) return;
    e.preventDefault();
    const rect = ref.current?.getBoundingClientRect();
    const focus = { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
    const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    onTransform(clampPan(zoomAt(transform, factor, focus), plane, viewportRef.current));
  };

  const flashEl = flashTableId ? tableEls.find((e) => e.tableId === flashTableId) ?? null : null;

  return (
    <div
      ref={ref}
      className="relative h-full w-full touch-none select-none overflow-hidden rounded-xl border border-line bg-canvas"
      style={{
        // Near-invisible spatial dots — orientation only, NOT a designer grid.
        backgroundImage: "radial-gradient(rgb(148 163 184 / 0.14) 1px, transparent 1px)",
        backgroundSize: "26px 26px",
        cursor: drag.current?.active ? "grabbing" : "grab",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onWheel={onWheel}
      data-floor-canvas
    >
      <div
        className="absolute left-0 top-0 origin-top-left"
        style={{ transform: `translate(${t.tx}px, ${t.ty}px) scale(${t.scale})` }}
      >
        {structures.map((el) => (
          <FloorObject key={el.id} element={el} />
        ))}
        {tableEls.map((el) => (
          <FloorTableNode
            key={el.id}
            model={buildFloorNode(el, tableIndex, now)}
            selected={el.tableId === selectedTableId}
            focused={el.tableId === focusedTableId}
            density={density}
            onSelect={onSelect}
          />
        ))}
        {flashEl && (
          <div
            aria-hidden
            className="pointer-events-none absolute animate-pulse rounded-xl ring-4 ring-brand"
            style={{ left: flashEl.x - 4, top: flashEl.y - 4, width: flashEl.w + 8, height: flashEl.h + 8 }}
          />
        )}
      </div>
    </div>
  );
}

/** Convenience for callers that want the current screen position of a table. */
export function tableScreenPoint(element: FloorElement, transform: Transform): { x: number; y: number } {
  return toScreen({ x: element.x + element.w / 2, y: element.y + element.h / 2 }, transform);
}
