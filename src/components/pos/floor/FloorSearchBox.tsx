// Floor search: find a table by name (or open order number) across sections.
// A hit navigates — activate its section, bring it into view, flash the brand
// halo — which is DISTINCT from selecting it. Enter picks the first result.

import { useState } from "react";
import { cn } from "@/components/ui";
import { Glyph } from "@/components/Glyph";
import type { FloorSearchMatch } from "@/lib/pos/floorSearch";

export function FloorSearchBox({
  query,
  onQueryChange,
  matches,
  onPick,
  sectionNameById,
}: {
  query: string;
  onQueryChange: (q: string) => void;
  matches: FloorSearchMatch[];
  onPick: (match: FloorSearchMatch) => void;
  sectionNameById: (id: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const showResults = open && query.trim() !== "";

  return (
    <div className="relative w-56">
      <div className="flex items-center gap-2 rounded-lg border border-line bg-white px-2 focus-within:ring-2 focus-within:ring-brand/40">
        <Glyph name="search" size={15} />
        <input
          value={query}
          onChange={(e) => {
            onQueryChange(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && matches.length > 0) {
              onPick(matches[0]);
              setOpen(false);
            } else if (e.key === "Escape") {
              onQueryChange("");
              setOpen(false);
            }
          }}
          placeholder="Find a table"
          aria-label="Find a table on the floor"
          className="w-full bg-transparent py-2 text-sm outline-none"
        />
      </div>
      {showResults && (
        <div className="absolute left-0 top-full z-20 mt-1 max-h-72 w-72 overflow-auto rounded-xl border border-line bg-white p-1 shadow-lg">
          {matches.length === 0 ? (
            <div className="px-3 py-3 text-sm text-sub">No table matches “{query.trim()}”.</div>
          ) : (
            matches.map((m) => (
              <button
                key={m.tableId}
                type="button"
                onMouseDown={(e) => {
                  // mousedown (before blur) so the pick lands before the list closes.
                  e.preventDefault();
                  onPick(m);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left transition hover:bg-slate-50",
                )}
              >
                <span className="truncate text-sm font-bold text-ink">{m.name}</span>
                <span className="flex shrink-0 items-center gap-2 text-[11px] text-sub">
                  {m.orderNumber && <span className="tabular-nums">#{m.orderNumber}</span>}
                  <span className="truncate">{sectionNameById(m.sectionId)}</span>
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
