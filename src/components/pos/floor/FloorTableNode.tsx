// One table on the Service Floor Map — the approved Option-D visual language.
//
// FREE: neutral white surface, soft neutral border, name strongest, seats
//   secondary. ACTIVE (open bill): pale blush surface, soft coral border, dark
//   ink, a currency-neutral receipt marker and elapsed time — never the brand
//   green, never destructive red, and never the bill TOTAL (the panel is the
//   detail surface). SELECTED: an independent navy ring that composes on top of
//   any status without repainting it; keyboard FOCUS is a lighter navy ring, so
//   focus and selection stay visually distinct.
//
// NEVER COLOUR ALONE: every state also carries a word and/or glyph, so it
// survives a monochrome screen and a colour-blind operator.
//
// Positioned in LOGICAL units inside the scaled plane; the shape is a border
// radius derived from the node's own size, so a circle stays a circle at any
// zoom. An unknown/future shape degrades to a safe rounded rectangle.

import { cn } from "@/components/ui";
import { Glyph } from "@/components/Glyph";
import { shapeLabel, shapeRadiusFraction, type FloorNodeModel } from "@/lib/pos/floorStatus";
import type { DensityLevel } from "@/lib/pos/floorGeometry";

/** Fraction of the shorter side reserved as the minimum tap surface. */
export function nodeTapSizePx(model: FloorNodeModel, scale: number): number {
  return Math.min(model.element.w, model.element.h) * scale;
}

export function FloorTableNode({
  model,
  selected,
  focused,
  density,
  onSelect,
}: {
  model: FloorNodeModel;
  selected: boolean;
  focused: boolean;
  density: DensityLevel;
  onSelect: (id: string) => void;
}) {
  const { element, state } = model;
  const radius = Math.min(element.w, element.h) * shapeRadiusFraction(element.shape);

  // Status treatment. Free and reserved lean on themed neutrals; the open bill is
  // the one operational highlight, in the fixed Option-D blush/coral.
  const surface =
    model.missing
      ? "border-line bg-slate-100 text-sub"
      : state === "active_bill" || state === "occupied" || state === "mixed_currency"
        ? "border-floor-active-border bg-floor-active text-floor-active-ink"
        : state === "reserved"
          ? "border-amber-300 bg-amber-50 text-ink"
          : "border-line bg-white text-ink";

  const showSecondary = density !== "far";
  const nameSize = density === "close" ? "text-base" : density === "far" ? "text-[13px]" : "text-sm";

  // Labels stay upright even when the table is rotated: the shape rotates, the
  // content counter-rotates.
  const rotate = element.rotation ? `rotate(${element.rotation}deg)` : undefined;
  const counterRotate = element.rotation ? `rotate(${-element.rotation}deg)` : undefined;

  const ariaLabel = [
    model.name,
    model.missing ? "unavailable" : state === "active_bill" || state === "occupied" ? "open bill" : "free",
    model.seats != null ? `${model.seats} seats` : null,
    model.elapsedLabel ? `open ${model.elapsedLabel}` : null,
    shapeLabel(element.shape),
  ]
    .filter(Boolean)
    .join(", ");

  const common = "absolute box-border border-2 shadow-sm transition-[box-shadow,transform] overflow-hidden";
  const positioned = {
    left: element.x,
    top: element.y,
    width: element.w,
    height: element.h,
    borderRadius: radius,
    transform: rotate,
    transformOrigin: "center center",
  } as const;

  const ring = selected
    ? "ring-2 ring-floor-select ring-offset-2 ring-offset-canvas"
    : focused
      ? "ring-2 ring-floor-select/45"
      : "";

  const body = (
    <span
      className="flex h-full w-full flex-col items-center justify-center gap-0.5 px-1 text-center leading-tight"
      style={{ transform: counterRotate }}
    >
      <span className={cn("max-w-full truncate font-extrabold", nameSize)}>{model.name}</span>
      {showSecondary && !model.missing && (
        <span className="flex items-center justify-center gap-1 text-[11px] font-semibold opacity-80">
          {state === "active_bill" || state === "occupied" ? (
            <>
              {/* Currency-neutral receipt marker — never a "$" and never the total. */}
              <Glyph name="pay" size={12} />
              {model.elapsedLabel ? <span className="tabular-nums">{model.elapsedLabel}</span> : <span>Open</span>}
            </>
          ) : model.seats != null ? (
            <>
              <Glyph name="seats" size={12} />
              <span className="tabular-nums">{model.seats}</span>
            </>
          ) : null}
        </span>
      )}
      {showSecondary && model.missing && (
        <span className="text-[10px] font-semibold uppercase tracking-wide">Unavailable</span>
      )}
    </span>
  );

  // A placement whose table left the map is shown but not interactive: there is
  // nothing to open, and tapping it must not select a table that no longer exists.
  if (model.missing) {
    return (
      <div className={cn(common, surface, "opacity-70")} style={positioned} data-floor-table-id={model.tableId} aria-hidden>
        {body}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onSelect(model.tableId)}
      aria-pressed={selected}
      aria-label={ariaLabel}
      data-floor-table-id={model.tableId}
      className={cn(common, surface, ring, "cursor-pointer focus-visible:outline-none")}
      style={positioned}
    >
      {body}
    </button>
  );
}
