// The Map | List segmented control for the Dine-In workspace.
//
// The ACTIVE segment is the brand — the one place the floor uses brand green for
// a control, matching the approved design (green = brand/nav/CTA/active control).
// Rendered only when the tenant is entitled AND the terminal has a floor to show;
// with the feature off the Dine-in workspace never mounts it and the List stands
// alone, exactly as today.

import { cn, TOUCH_TARGET_PX } from "@/components/ui";
import { Glyph } from "@/components/Glyph";

export type DineInFloorView = "list" | "floor";

export function MapListToggle({
  view,
  onChange,
}: {
  view: DineInFloorView;
  onChange: (view: DineInFloorView) => void;
}) {
  const seg = (value: DineInFloorView, label: string, icon: "grid" | "list") => {
    const active = view === value;
    return (
      <button
        type="button"
        role="tab"
        aria-selected={active}
        onClick={() => onChange(value)}
        style={{ minHeight: TOUCH_TARGET_PX }}
        className={cn(
          "flex items-center gap-1.5 rounded-lg px-3 text-sm font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40",
          active ? "bg-brand text-onbrand shadow-sm" : "text-sub hover:text-ink",
        )}
      >
        <Glyph name={icon} size={16} />
        {label}
      </button>
    );
  };
  return (
    <div role="tablist" aria-label="Table view" className="inline-flex items-center gap-1 rounded-xl border border-line bg-white p-1">
      {seg("floor", "Map", "grid")}
      {seg("list", "List", "list")}
    </div>
  );
}
