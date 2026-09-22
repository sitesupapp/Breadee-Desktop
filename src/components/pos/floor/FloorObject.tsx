// A structural element on the floor — wall, divider, door, counter, kitchen,
// host stand, plant, a text label, and so on. VISUAL CONTEXT ONLY.
//
// Three rules make it context and not clutter: it sits BEHIND every operational
// table (the canvas paints structures first), it never intercepts a table tap
// (`pointer-events: none`), and it stays low-contrast so the tables remain the
// figure and the room stays the ground. This is deliberately not a CAD drawing —
// a soft hint of the room, no more.

import { cn } from "@/components/ui";
import type { FloorElement, FloorElementType } from "@/lib/pos/floor";

/** Kinds drawn as a thin line/edge rather than a filled block. */
const LINEAR: ReadonlySet<FloorElementType> = new Set(["wall", "divider", "door", "window"]);

/** A short glyph-free label for a structure that has no author text. */
function fallbackLabel(type: FloorElementType): string {
  switch (type) {
    case "kitchen": return "Kitchen";
    case "host": return "Host";
    case "entrance": return "Entrance";
    case "stairs": return "Stairs";
    case "wc": return "WC";
    case "counter": return "Counter";
    case "door": return "Door";
    default: return "";
  }
}

export function FloorObject({ element }: { element: FloorElement }) {
  const rotate = element.rotation ? `rotate(${element.rotation}deg)` : undefined;
  const linear = LINEAR.has(element.type);
  const isText = element.type === "text";
  const label = element.label ?? (isText ? "" : fallbackLabel(element.type));

  return (
    <div
      aria-hidden
      data-floor-object-type={element.type}
      className={cn(
        "pointer-events-none absolute flex items-center justify-center overflow-hidden",
        isText
          ? "text-sub/70"
          : linear
            ? "rounded-sm border border-slate-300/70 bg-slate-200/40"
            : "rounded-md border border-slate-200/70 bg-slate-100/50 text-sub/60",
      )}
      style={{
        left: element.x,
        top: element.y,
        width: element.w,
        height: element.h,
        transform: rotate,
        transformOrigin: "center center",
      }}
    >
      {(label || isText) && (
        <span className="truncate px-1 text-[11px] font-medium leading-tight">{label}</span>
      )}
    </div>
  );
}
