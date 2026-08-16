// Category strip.
//
// Horizontal, always one row, scrolls itself rather than wrapping - a wrapping
// category row is what pushes the menu grid down and starts the cascade that
// ends with the cart off-screen. Alt+Left / Alt+Right move between categories
// without touching the mouse.

import { useEffect, useRef } from "react";
import { cn } from "@/components/ui";
import { ALL_CATEGORIES } from "@/lib/pos/categories";
import type { MenuCategory } from "@/types/pos";

export function CategoryNavigation({
  categories,
  selected,
  counts,
  onSelect,
}: {
  categories: MenuCategory[];
  selected: string;
  counts: Record<string, number>;
  onSelect: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Keep the active chip in view when the selection moves by keyboard.
  useEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>(`[data-category="${CSS.escape(selected)}"]`);
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selected]);

  const chips = [{ id: ALL_CATEGORIES, name: "All items" }, ...categories];

  return (
    <div
      ref={ref}
      role="tablist"
      aria-label="Menu categories"
      className="flex shrink-0 gap-2 overflow-x-auto pb-1 [scrollbar-width:thin]"
    >
      {chips.map((c) => {
        const active = c.id === selected;
        const count = c.id === ALL_CATEGORIES ? counts[ALL_CATEGORIES] : counts[c.id];
        return (
          <button
            key={c.id}
            type="button"
            role="tab"
            aria-selected={active}
            data-category={c.id}
            onClick={() => onSelect(c.id)}
            className={cn(
              "flex min-h-[44px] shrink-0 items-center gap-2 rounded-xl border px-4 text-sm font-semibold transition",
              active
                ? "border-brand bg-brand text-onbrand shadow-sm"
                : "border-line bg-white text-ink hover:border-brand/40 hover:bg-brand-soft/40",
            )}
          >
            <span className="whitespace-nowrap">{c.name}</span>
            {typeof count === "number" && (
              <span className={cn("rounded-full px-1.5 text-[11px] font-bold", active ? "bg-white/20" : "bg-slate-100 text-sub")}>
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
