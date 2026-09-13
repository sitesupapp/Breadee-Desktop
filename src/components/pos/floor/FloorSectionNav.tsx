// Section tabs for the floor. Sections that fit are tabs; the rest fall into a
// "More" overflow that is itself searchable when there are many. One section is
// active at a time, and the active section is always reachable as a tab (the
// split logic in `lib/pos/floorSections.ts` guarantees it). User-defined names
// are rendered verbatim and read naturally in Arabic or English.

import { useEffect, useMemo, useRef, useState } from "react";
import { cn, TOUCH_TARGET_PX } from "@/components/ui";
import { Glyph } from "@/components/Glyph";
import { splitSections } from "@/lib/pos/floorSections";
import type { FloorSection } from "@/lib/pos/floor";

/** Approximate width one tab needs; the measured row width divides by it. */
const APPROX_TAB_PX = 132;

export function FloorSectionNav({
  sections,
  activeId,
  onSelect,
}: {
  sections: FloorSection[];
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [maxVisible, setMaxVisible] = useState(6);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [overflowQuery, setOverflowQuery] = useState("");

  useEffect(() => {
    const el = rowRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => setMaxVisible(Math.max(1, Math.floor(el.clientWidth / APPROX_TAB_PX)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { visible, overflow } = useMemo(
    () => splitSections(sections, maxVisible, activeId),
    [sections, maxVisible, activeId],
  );

  const filteredOverflow = useMemo(() => {
    const q = overflowQuery.trim().toLowerCase();
    if (q === "") return overflow;
    return overflow.filter((s) => s.name.toLowerCase().includes(q));
  }, [overflow, overflowQuery]);

  if (sections.length <= 1) {
    // A single section needs no navigation — show its name as a quiet heading.
    return sections.length === 1 ? (
      <div className="truncate px-1 text-sm font-bold text-ink">{sections[0].name}</div>
    ) : null;
  }

  const tab = (s: FloorSection) => {
    const active = s.id === activeId;
    return (
      <button
        key={s.id}
        type="button"
        role="tab"
        aria-selected={active}
        onClick={() => onSelect(s.id)}
        style={{ minHeight: TOUCH_TARGET_PX }}
        className={cn(
          "max-w-[168px] truncate rounded-lg px-3 text-sm font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40",
          active ? "bg-brand-soft text-brand-dark" : "text-sub hover:text-ink",
        )}
        title={s.name}
      >
        {s.name}
      </button>
    );
  };

  return (
    <div ref={rowRef} role="tablist" aria-label="Floor sections" className="flex min-w-0 flex-1 items-center gap-1">
      {visible.map(tab)}
      {overflow.length > 0 && (
        <div className="relative">
          <button
            type="button"
            onClick={() => setOverflowOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={overflowOpen}
            style={{ minHeight: TOUCH_TARGET_PX }}
            className="flex items-center gap-1 rounded-lg px-3 text-sm font-bold text-sub transition hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          >
            More
            <Glyph name="chevron-down" size={14} />
          </button>
          {overflowOpen && (
            <div
              role="menu"
              className="absolute left-0 top-full z-20 mt-1 max-h-80 w-64 overflow-auto rounded-xl border border-line bg-white p-2 shadow-lg"
            >
              {overflow.length > 6 && (
                <div className="mb-2 flex items-center gap-2 rounded-lg border border-line px-2">
                  <Glyph name="search" size={14} />
                  <input
                    value={overflowQuery}
                    onChange={(e) => setOverflowQuery(e.target.value)}
                    placeholder="Find a section"
                    className="w-full bg-transparent py-2 text-sm outline-none"
                    aria-label="Find a section"
                  />
                </div>
              )}
              {filteredOverflow.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onSelect(s.id);
                    setOverflowOpen(false);
                    setOverflowQuery("");
                  }}
                  className={cn(
                    "block w-full truncate rounded-lg px-2 py-2 text-left text-sm font-semibold transition hover:bg-slate-50",
                    s.id === activeId ? "text-brand-dark" : "text-ink",
                  )}
                  title={s.name}
                >
                  {s.name}
                </button>
              ))}
              {filteredOverflow.length === 0 && (
                <div className="px-2 py-2 text-sm text-sub">No sections match.</div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
