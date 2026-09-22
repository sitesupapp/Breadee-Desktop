// Category picker — the first screen of the categorized cashier view.
//
// A grid of large, touch-friendly cards, one per menu CATEGORY the till already
// loaded, plus an "All items" card. It is a NAVIGATION layer and nothing else:
// it neither fetches nor filters a menu of its own. `PosWorkspace` builds the
// entries from the SAME `usableCategories` / `categoryCounts` that feed the
// default category strip, so this can never show a category the strip would not
// - same tenant, same branch, same OU isolation, same order.
//
// Choosing a card hands its id back; the workspace sets the existing `category`
// state and switches to the existing item grid. Nothing about the item card,
// price, options, cart or any downstream flow lives here.
//
// The grid is `auto-fill` with a wide minimum, so it stays a comfortable
// touch target from 1280x720 up to 1920x1080 without a breakpoint or a measured
// column count. Direction-agnostic (logical `gap`, `text-start`), so an RTL
// layout reflows rather than breaks.

import { cn } from "@/components/ui";

export type CategoryPickerEntry = {
  id: string;
  name: string;
  count: number;
};

export function CategoryPicker({
  entries,
  onPick,
}: {
  entries: CategoryPickerEntry[];
  onPick: (id: string) => void;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1">
      <div
        role="list"
        aria-label="Menu categories"
        className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(180px,1fr))]"
      >
        {entries.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="listitem"
            onClick={() => onPick(entry.id)}
            className={cn(
              "flex min-h-[104px] flex-col justify-between rounded-2xl border p-4 text-start transition",
              "border-line bg-white text-ink shadow-sm",
              "hover:border-brand/50 hover:bg-brand-soft/40 active:scale-[0.99]",
            )}
          >
            <span className="text-base font-bold leading-tight">{entry.name}</span>
            <span className="mt-2 inline-flex w-fit items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-bold text-sub">
              {entry.count} item{entry.count === 1 ? "" : "s"}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
