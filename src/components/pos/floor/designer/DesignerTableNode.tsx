// One TABLE on the Floor Designer canvas (Phase 3A) — the editable counterpart of
// `FloorTableNode`. It shows geometry, not operational state: the Designer edits
// where a table sits, never whether it has a bill, so there is no status colour,
// no elapsed time and no money here.
//
// SELECTION CHROME. When a table is selected and the session is editable it grows
// a selection ring, four corner RESIZE handles and one ROTATE knob. The chrome is
// drawn on the element's AXIS-ALIGNED box (not inside the rotation), and every
// handle is counter-scaled by the view zoom so it stays a constant, tappable size
// at any zoom. The handles carry `data-designer-*` markers; the canvas owns the
// pointer gesture and reads those markers to know what a press means.

import { cn } from "@/components/ui";
import { Glyph } from "@/components/Glyph";
import { shapeLabel, shapeRadiusFraction } from "@/lib/pos/floorStatus";
import type { FloorElement } from "@/lib/pos/floor";
import type { ResizeHandle } from "@/lib/pos/floorDesigner";

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
  selected,
  editable,
  scale,
}: {
  element: FloorElement;
  selected: boolean;
  editable: boolean;
  /** Current view scale, so chrome can be counter-scaled to a constant size. */
  scale: number;
}) {
  const radius = Math.min(element.w, element.h) * shapeRadiusFraction(element.shape);
  const rotate = element.rotation ? `rotate(${element.rotation}deg)` : undefined;
  const counterRotate = element.rotation ? `rotate(${-element.rotation}deg)` : undefined;
  const label = element.label ?? "";
  // Handle geometry in LOGICAL units so it renders at ~HANDLE_PX on screen.
  const hs = HANDLE_PX / Math.max(scale, 0.0001);
  const rotOffset = ROTATE_OFFSET_PX / Math.max(scale, 0.0001);

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
          selected ? "border-floor-select bg-white text-ink" : "border-line bg-white text-ink",
        )}
        style={{ borderRadius: radius, transform: rotate, transformOrigin: "center center" }}
        aria-label={`${label || "table"}, ${shapeLabel(element.shape)}`}
      >
        <span
          className="max-w-full truncate px-1 text-center text-[13px] font-extrabold leading-tight"
          style={{ transform: counterRotate }}
        >
          {label}
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
