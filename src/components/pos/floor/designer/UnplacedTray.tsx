// The UNPLACED TABLES tray (Phase 3B) — canonical tables that exist for this
// branch but are not on the draft floor. Tap one to place it into the active
// section; placement is DRAFT-ONLY (same canonical table id, one element), and
// the Service Map keeps showing the published floor until a future Publish.
//
// This is identity metadata only ({name, seats}); nothing operational.

import { useState } from "react";
import { cn } from "@/components/ui";
import { Glyph } from "@/components/Glyph";
import type { UnplacedTable } from "@/lib/pos/floorDesigner";

export function UnplacedTray({
  tables,
  disabled,
  onPlace,
}: {
  tables: UnplacedTable[];
  disabled: boolean;
  onPlace: (tableId: string) => void;
}) {
  const [open, setOpen] = useState(true);
  if (tables.length === 0) return null;

  return (
    <div className="rounded-xl border border-line bg-white">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between px-3 py-2 text-start"
      >
        <span className="flex items-center gap-1.5 text-sm font-extrabold text-ink">
          <Glyph name="layers" size={15} />
          Not on the floor
          <span className="rounded-full bg-canvas px-2 py-0.5 text-xs font-bold text-sub">{tables.length}</span>
        </span>
        <span className="flex items-center gap-1 text-xs font-semibold text-sub">
          {open ? "Hide" : "Show"}
          <Glyph name="chevron-down" size={13} className={open ? "rotate-180" : undefined} />
        </span>
      </button>
      {open && (
        <div className="flex gap-1.5 overflow-x-auto px-3 pb-2.5" role="list" aria-label="Tables not on the floor">
          {tables.map((t) => (
            <button
              key={t.id}
              type="button"
              role="listitem"
              disabled={disabled}
              onClick={() => onPlace(t.id)}
              title={`Place ${t.name || "table"} in the current section`}
              className={cn(
                "flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-white px-3 py-2 text-sm font-bold text-ink",
                "hover:border-brand hover:bg-brand-soft disabled:opacity-40",
              )}
            >
              {t.name || "Table"}
              {t.seats != null && (
                <span className="flex items-center gap-0.5 text-xs font-semibold text-sub">
                  <Glyph name="seats" size={12} />
                  {t.seats}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
