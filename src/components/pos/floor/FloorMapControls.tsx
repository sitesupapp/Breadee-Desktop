// The compact floor controls: zoom out, the current zoom level, zoom in, and Fit.
// Nothing here computes geometry — it asks the canvas to zoom or re-fit; the math
// lives in `lib/pos/floorGeometry.ts`.

import { cn, TOUCH_TARGET_PX } from "@/components/ui";
import { Glyph } from "@/components/Glyph";

export function FloorMapControls({
  zoomPercent,
  canZoomIn,
  canZoomOut,
  onZoomIn,
  onZoomOut,
  onFit,
}: {
  zoomPercent: number;
  canZoomIn: boolean;
  canZoomOut: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
}) {
  const btn = "flex items-center justify-center rounded-lg border border-line bg-white text-ink transition disabled:opacity-40 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40";
  const size = { width: TOUCH_TARGET_PX, height: TOUCH_TARGET_PX } as const;
  return (
    <div className="pointer-events-auto flex items-center gap-1 rounded-xl border border-line bg-white/90 p-1 shadow-sm backdrop-blur">
      <button type="button" className={btn} style={size} onClick={onZoomOut} disabled={!canZoomOut} aria-label="Zoom out">
        <span className="text-lg font-bold leading-none">−</span>
      </button>
      <span className="min-w-[3.5rem] text-center text-xs font-bold tabular-nums text-sub" aria-live="polite">
        {zoomPercent}%
      </span>
      <button type="button" className={btn} style={size} onClick={onZoomIn} disabled={!canZoomIn} aria-label="Zoom in">
        <span className="text-lg font-bold leading-none">+</span>
      </button>
      <button
        type="button"
        className={cn(btn, "gap-1 px-3 text-xs font-bold")}
        style={{ height: TOUCH_TARGET_PX }}
        onClick={onFit}
        aria-label="Fit floor to view"
      >
        <Glyph name="fullscreen" size={15} />
        Fit
      </button>
    </div>
  );
}
