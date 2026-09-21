// One STRUCTURE / object on the Floor Designer canvas (Phase 3D-B) — the
// editable counterpart of the read-only `FloorObject`. It keeps the same soft,
// low-contrast visual language (a wall reads as a wall, a counter as a block, a
// text label as text) so the room looks identical to Service, but unlike
// `FloorObject` it is INTERACTIVE: it carries the `data-designer-element-id`
// marker the canvas gesture reads, and when selected it grows the same selection
// ring, corner resize handles and — for types that rotate — a rotate knob as a
// table does. Tables remain the visually primary objects; structures stay
// contextual architecture.
//
// A structure is a layout object only. Nothing here references a bill, a table
// id, seats or any operational state — a structure has none.

import { cn } from "@/components/ui";
import { Glyph } from "@/components/Glyph";
import { structureLabel, structureSpec } from "@/lib/pos/floorObjects";
import type { DesignerElement, ResizeHandle } from "@/lib/pos/floorDesigner";

const HANDLE_PX = 14;
const ROTATE_OFFSET_PX = 26;

const CORNERS: { handle: ResizeHandle; cx: number; cy: number; cursor: string }[] = [
  { handle: "nw", cx: 0, cy: 0, cursor: "nwse-resize" },
  { handle: "ne", cx: 1, cy: 0, cursor: "nesw-resize" },
  { handle: "sw", cx: 0, cy: 1, cursor: "nesw-resize" },
  { handle: "se", cx: 1, cy: 1, cursor: "nwse-resize" },
];

export function DesignerStructureNode({
  element,
  selected,
  editable,
  scale,
}: {
  element: DesignerElement;
  selected: boolean;
  editable: boolean;
  /** Current view scale, so chrome counter-scales to a constant on-screen size. */
  scale: number;
}) {
  const spec = structureSpec(element.type);
  const render = spec?.render ?? "block";
  const rotatable = spec?.rotatable ?? false;

  const rotate = element.rotation ? `rotate(${element.rotation}deg)` : undefined;
  const counterRotate = element.rotation ? `rotate(${-element.rotation}deg)` : undefined;
  const hs = HANDLE_PX / Math.max(scale, 0.0001);
  const rotOffset = ROTATE_OFFSET_PX / Math.max(scale, 0.0001);
  const fontLogical = Math.min(12 / Math.max(scale, 0.0001), Math.max(element.w, element.h) * 0.5);

  const isText = render === "text";
  const linear = render === "linear";
  const shown = element.label ?? (isText ? "" : structureLabel(element.type));

  return (
    <div
      className="absolute"
      style={{ left: element.x, top: element.y, width: element.w, height: element.h }}
      data-designer-object-type={element.type}
      data-designer-element-id={element.id}
    >
      {/* The object body — same soft look as the Service structure, rotates with
          the element, but interactive (no pointer-events:none). */}
      <div
        className={cn(
          "absolute inset-0 box-border flex items-center justify-center overflow-hidden",
          selected
            ? "border-2 border-floor-select bg-white text-ink"
            : isText
              ? "text-sub/80"
              : linear
                ? "rounded-sm border border-slate-300/80 bg-slate-200/50 text-sub/70"
                : "rounded-md border border-slate-200/80 bg-slate-100/60 text-sub/70",
        )}
        style={{ transform: rotate, transformOrigin: "center center" }}
        aria-label={`${shown || structureLabel(element.type)} object`}
      >
        {(shown || isText) && (
          <span
            className="max-w-full truncate px-1 font-medium leading-tight"
            style={{ transform: counterRotate, fontSize: fontLogical }}
          >
            {shown}
          </span>
        )}
      </div>

      {selected && (
        <div aria-hidden className="pointer-events-none absolute -inset-px rounded-[3px] ring-2 ring-floor-select" />
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
          {rotatable && (
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
          )}
        </>
      )}
    </div>
  );
}
