// The MULTI-SELECTION panel (Phase 3C) — shown instead of the single-table
// Inspector when 2+ elements are selected. It never pretends to be a single
// table: no Name field (renaming across canonical tables is not a Phase-3C
// operation), just an honest count, the bulk layout tools, and the advisory
// collision summary. Every action produces ONE draft mutation through the
// store's single autosave path.
//
// The REFERENCE for Same-size is the PRIMARY (last-selected) table, named in
// the panel so the operator knows exactly which one wins.

import { Glyph } from "@/components/Glyph";
import type { AlignMode, SizeMode } from "@/lib/pos/floorArrange";

// 44px touch floor on every bulk action (Phase-3B follow-up #3).
const btn =
  "flex min-h-[44px] items-center justify-center rounded-lg border border-line bg-white px-2 text-xs font-bold text-ink hover:bg-canvas disabled:opacity-40";

export function DesignerBulkPanel({
  count,
  referenceName,
  collisions,
  tight,
  readOnly,
  onAlign,
  onDistribute,
  onSameSize,
  onAutoNumber,
  onAutoArrange,
  onClear,
}: {
  /** How many TABLES are in the selection (bulk tools operate on tables). */
  count: number;
  /** The primary/reference table's shown name (for Same-size). */
  referenceName: string;
  collisions: number;
  tight: number;
  readOnly: boolean;
  onAlign: (mode: AlignMode) => void;
  onDistribute: (axis: "h" | "v") => void;
  onSameSize: (mode: SizeMode) => void;
  /** Phase 3D-A — open the auto-number dialog for this selection. */
  onAutoNumber: () => void;
  /** Phase 3D-A — deterministically arrange this selection into a grid. */
  onAutoArrange: () => void;
  onClear: () => void;
}) {
  const canAlign = !readOnly && count >= 2;
  const canDistribute = !readOnly && count >= 3;
  const canSize = !readOnly && count >= 2;

  return (
    <aside className="flex h-full w-full flex-col gap-3 overflow-y-auto border-s border-line bg-white p-3" aria-label="Selection">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-extrabold text-ink">{count} tables selected</h3>
        <button type="button" onClick={onClear} className="min-h-[44px] px-2 text-xs font-bold text-sub hover:text-ink">
          Clear
        </button>
      </div>

      {(collisions > 0 || tight > 0) && (
        <p className="flex items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-xs font-semibold text-amber-800">
          <Glyph name="info" size={14} />
          {collisions > 0 && `${collisions} overlap${collisions === 1 ? "" : "s"}`}
          {collisions > 0 && tight > 0 && " · "}
          {tight > 0 && `${tight} tight spacing`}
          — advisory only
        </p>
      )}

      <div>
        <span className="text-xs font-bold uppercase tracking-wide text-sub">Align</span>
        <div className="mt-1.5 grid grid-cols-3 gap-1.5">
          <button type="button" className={btn} disabled={!canAlign} onClick={() => onAlign("left")}>Left</button>
          <button type="button" className={btn} disabled={!canAlign} onClick={() => onAlign("hcenter")}>Center</button>
          <button type="button" className={btn} disabled={!canAlign} onClick={() => onAlign("right")}>Right</button>
          <button type="button" className={btn} disabled={!canAlign} onClick={() => onAlign("top")}>Top</button>
          <button type="button" className={btn} disabled={!canAlign} onClick={() => onAlign("vcenter")}>Middle</button>
          <button type="button" className={btn} disabled={!canAlign} onClick={() => onAlign("bottom")}>Bottom</button>
        </div>
      </div>

      <div>
        <span className="text-xs font-bold uppercase tracking-wide text-sub">Distribute</span>
        <div className="mt-1.5 grid grid-cols-2 gap-1.5">
          <button type="button" className={btn} disabled={!canDistribute} onClick={() => onDistribute("h")}>
            Horizontally
          </button>
          <button type="button" className={btn} disabled={!canDistribute} onClick={() => onDistribute("v")}>
            Vertically
          </button>
        </div>
        {count < 3 && <p className="mt-1 text-xs text-sub">Select at least 3 tables to distribute.</p>}
      </div>

      <div>
        <span className="text-xs font-bold uppercase tracking-wide text-sub">Same size</span>
        <div className="mt-1.5 grid grid-cols-3 gap-1.5">
          <button type="button" className={btn} disabled={!canSize} onClick={() => onSameSize("width")}>Width</button>
          <button type="button" className={btn} disabled={!canSize} onClick={() => onSameSize("height")}>Height</button>
          <button type="button" className={btn} disabled={!canSize} onClick={() => onSameSize("both")}>Both</button>
        </div>
        <p className="mt-1 text-xs text-sub">
          Matches <span className="font-bold">{referenceName || "the last-selected table"}</span>.
        </p>
      </div>

      {/* Phase 3D-A — automation on the selection. Auto-number renumbers in
          physical reading order; Auto-arrange lays the selection out in a grid.
          Both are ONE draft mutation through the same autosave. */}
      <div>
        <span className="text-xs font-bold uppercase tracking-wide text-sub">Number &amp; arrange</span>
        <div className="mt-1.5 grid grid-cols-2 gap-1.5">
          <button type="button" className={btn} disabled={readOnly || count < 1} onClick={onAutoNumber}>
            Auto-number…
          </button>
          <button type="button" className={btn} disabled={readOnly || count < 2} onClick={onAutoArrange}>
            Auto-arrange
          </button>
        </div>
      </div>

      <p className="mt-auto text-xs text-sub">
        Drag any selected table to move the group. Ctrl/Cmd-click adds or removes a table.
      </p>
    </aside>
  );
}
