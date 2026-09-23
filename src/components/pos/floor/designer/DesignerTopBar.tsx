// The Floor Designer top bar.
//
// A single "Back to Service" affordance on the left, the caller's editing/publish
// actions beside it (the `actions` slot), and the draft STATUS on the right. There
// is still no Save button — autosave owns draft persistence, and the right-hand pill
// distinguishes the private DRAFT ("Saving…"/"Saved") from PUBLISH, which is a
// deliberate, separate action the caller places in `actions` (Phase 4). "Not
// published" stays visible so the draft/live distinction is never blurred.

import { cn } from "@/components/ui";
import { Glyph } from "@/components/Glyph";
import type { SaveStatus } from "@/state/floorDesigner";

type Tone = "neutral" | "info" | "good" | "warn" | "bad";

function pill(saveStatus: SaveStatus, dirty: boolean, readOnly: boolean): { label: string; tone: Tone } {
  if (readOnly) return { label: "Read-only", tone: "warn" };
  if (saveStatus === "error") return { label: "Couldn’t save", tone: "bad" };
  if (saveStatus === "saving" || dirty) return { label: "Saving…", tone: "info" };
  if (saveStatus === "saved") return { label: "Saved", tone: "good" };
  return { label: "Draft", tone: "neutral" };
}

const TONE_CLASS: Record<Tone, string> = {
  neutral: "border-line bg-white text-sub",
  info: "border-line bg-white text-sub",
  good: "border-emerald-300 bg-emerald-50 text-emerald-700",
  warn: "border-amber-300 bg-amber-50 text-amber-700",
  bad: "border-rose-300 bg-rose-50 text-rose-700",
};

export function DesignerTopBar({
  saveStatus,
  dirty,
  readOnly,
  unplacedCount,
  onBack,
  onRetrySave,
  actions,
}: {
  saveStatus: SaveStatus;
  dirty: boolean;
  readOnly: boolean;
  unplacedCount: number;
  onBack: () => void;
  onRetrySave: () => void;
  /** Phase 3B editing actions (Add table, Sections) — rendered beside the title. */
  actions?: React.ReactNode;
}) {
  const p = pill(saveStatus, dirty, readOnly);
  return (
    <div className="flex items-center justify-between gap-2 border-b border-line bg-white px-3 py-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-white px-3 py-2 text-sm font-bold text-ink hover:bg-canvas"
        >
          <Glyph name="chevron-left" size={16} />
          Back to Service
        </button>
        <span className="hidden items-center gap-1.5 text-sm font-extrabold text-ink sm:inline-flex">
          <Glyph name="edit" size={16} />
          Floor Designer
        </span>
        {actions}
      </div>

      <div className="flex items-center gap-2">
        {unplacedCount > 0 && (
          <span className="hidden items-center gap-1 rounded-lg border border-line bg-white px-2.5 py-1.5 text-xs font-semibold text-sub md:inline-flex">
            <Glyph name="layers" size={13} />
            {unplacedCount} not on the map
          </span>
        )}
        <span className="text-[11px] font-semibold uppercase tracking-wide text-sub/70">Not published</span>
        <span className={cn("inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-bold", TONE_CLASS[p.tone])}>
          {p.tone === "good" && <Glyph name="check" size={13} />}
          {p.label}
        </span>
        {saveStatus === "error" && !readOnly && (
          <button
            type="button"
            onClick={onRetrySave}
            className="inline-flex items-center gap-1 rounded-lg border border-rose-300 bg-white px-2.5 py-1.5 text-xs font-bold text-rose-700 hover:bg-rose-50"
          >
            <Glyph name="sync" size={13} />
            Retry
          </button>
        )}
      </div>
    </div>
  );
}
