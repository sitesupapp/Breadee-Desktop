// One TABLE on the Floor Designer canvas — the editable counterpart of
// `FloorTableNode`. It shows geometry and IDENTITY, not operational state: the
// Designer edits where a table sits and what it is called, never whether it has
// a bill, so there is no status colour, no elapsed time and no money here.
//
// IDENTITY (Phase 3B). Every existing table shows its canonical name, resolved
// by the caller from the read-only metadata boundary ("999", "TR-01"…). A staged
// draft rename shows the DRAFT name with a quiet unpublished marker; a staged
// NEW table shows its name with a "New" chip. The Service Floor keeps showing
// the canonical published name for all of them until a future Publish.
//
// SELECTION CHROME. When a table is selected and the session is editable it
// grows a selection ring, four corner RESIZE handles and one ROTATE knob, all on
// the element's AXIS-ALIGNED box and counter-scaled to a constant on-screen
// size. The handles carry `data-designer-*` markers; the canvas owns the pointer
// gesture and reads those markers to know what a press means.

import { cn } from "@/components/ui";
import { Glyph } from "@/components/Glyph";
import { shapeLabel, shapeRadiusFraction } from "@/lib/pos/floorStatus";
import type { DesignerElement, ResizeHandle } from "@/lib/pos/floorDesigner";
import type { CollisionStatus } from "@/lib/pos/floorCollision";

/** Constant on-screen size for a handle, in CSS px, regardless of zoom. */
const HANDLE_PX = 14;
/** How far above the top edge the rotate knob floats, in CSS px. */
const ROTATE_OFFSET_PX = 26;

const CORNERS: { handle: ResizeHandle; cx: number; cy: number; cursor: string }[] = [
  { handle: "nw", cx: 0, cy: 0, cursor: "nwse-resize" },
  { handle: "ne", cx: 1, cy: 0, cursor: "nesw-resize" },
  { handle: "sw", cx: 0, cy: 1, cursor: "nesw-resize" },
  { handle: "se", cx: 1, cy: 1, cursor: "nwse-resize" },
];

export function DesignerTableNode({
  element,
  label,
  renamed,
  isNew,
  warn = "clear",
  selected,
  editable,
  scale,
}: {
  element: DesignerElement;
  /** The name to show: canonical, or the staged draft name when one exists. */
  label: string;
  /** True when the shown name is a staged rename (unpublished). */
  renamed: boolean;
  /** True for a staged new-table intent (created at a future publish). */
  isNew: boolean;
  /** Advisory collision/spacing status (Phase 3C) — quiet chrome, never blocking. */
  warn?: CollisionStatus;
  selected: boolean;
  editable: boolean;
  /** Current view scale, so chrome can be counter-scaled to a constant size. */
  scale: number;
}) {
  const radius = Math.min(element.w, element.h) * shapeRadiusFraction(element.shape);
  const rotate = element.rotation ? `rotate(${element.rotation}deg)` : undefined;
  const counterRotate = element.rotation ? `rotate(${-element.rotation}deg)` : undefined;
  // Handle geometry in LOGICAL units so it renders at ~HANDLE_PX on screen.
  const hs = HANDLE_PX / Math.max(scale, 0.0001);
  const rotOffset = ROTATE_OFFSET_PX / Math.max(scale, 0.0001);
  // The name must stay readable while the plane scales: counter-scale the text
  // toward a constant on-screen size, clamped so a tiny table never overflows.
  const fontLogical = Math.min(13 / Math.max(scale, 0.0001), Math.min(element.w, element.h) * 0.34);

  const unpublishedNote = renamed
    ? "Renamed — applies when the floor is published"
    : isNew
      ? "New — created when the floor is published"
      : null;
  const warnNote =
    warn === "collision" ? "Overlaps a neighbouring table or structure" : warn === "tight" ? "Tight spacing with a neighbour" : null;

  return (
    <div
      className="absolute"
      style={{ left: element.x, top: element.y, width: element.w, height: element.h }}
      data-designer-table-id={element.tableId ?? element.id}
      data-designer-element-id={element.id}
    >
      {/* The table body — rotates with the element, mirrors the service look. */}
      <div
        className={cn(
          "absolute inset-0 box-border flex items-center justify-center overflow-hidden border-2 shadow-sm",
          selected
            ? "border-floor-select bg-white text-ink"
            : warn === "collision"
              ? "border-amber-500 bg-amber-50/60 text-ink"
              : warn === "tight"
                ? "border-amber-300 bg-white text-ink"
                : isNew
                  ? "border-dashed border-line bg-white text-ink"
                  : "border-line bg-white text-ink",
        )}
        style={{ borderRadius: radius, transform: rotate, transformOrigin: "center center" }}
        aria-label={`${label || "table"}, ${shapeLabel(element.shape)}${unpublishedNote ? `, ${unpublishedNote}` : ""}${warnNote ? `, ${warnNote}` : ""}`}
        title={warnNote ?? unpublishedNote ?? undefined}
      >
        <span
          className="flex max-w-full flex-col items-center justify-center text-center leading-tight"
          style={{ transform: counterRotate }}
        >
          <span className="max-w-full truncate px-1 font-extrabold" style={{ fontSize: fontLogical }}>
            {label}
            {renamed && (
              <span aria-hidden className="opacity-50">
                *
              </span>
            )}
          </span>
          {isNew && (
            <span
              className="mt-0.5 rounded-full bg-brand-soft px-1.5 font-bold text-brand-dark"
              style={{ fontSize: fontLogical * 0.6 }}
            >
              New
            </span>
          )}
        </span>
      </div>

      {/* Selection chrome — axis-aligned, constant screen size, edit-only. */}
      {selected && (
        <div
          aria-hidden
          className="pointer-events-none absolute -inset-px rounded-[3px] ring-2 ring-floor-select"
        />
      )}
      {selected && editable && (
        <>
          {CORNERS.map(({ handle, cx, cy, cursor }) => (
            <div
              key={handle}
              data-designer-handle={handle}
              className="absolute rounded-sm border-2 border-floor-select bg-white shadow"
              style={{
                width: hs,
                height: hs,
                left: cx * element.w - hs / 2,
                top: cy * element.h - hs / 2,
                cursor,
                touchAction: "none",
              }}
            />
          ))}
          {/* Rotate knob, floating above the top-centre. */}
          <div
            data-designer-rotate
            className="absolute grid place-items-center rounded-full border-2 border-floor-select bg-white text-floor-select shadow"
            style={{
              width: hs * 1.4,
              height: hs * 1.4,
              left: element.w / 2 - (hs * 1.4) / 2,
              top: -rotOffset - (hs * 1.4) / 2,
              cursor: "grab",
              touchAction: "none",
            }}
          >
            <Glyph name="sync" size={Math.max(8, hs)} />
          </div>
        </>
      )}
    </div>
  );
}
