// The items workspace: search, filters, and one dense row per item.
//
// A ROW, NOT A CARD GRID. A menu is a list an operator scans by name and price,
// and at 1366x768 a card grid shows nine items where this shows sixteen. The
// row carries exactly what a manager checks - name, category, price, status,
// availability, how many modifier groups are attached - and nothing else.
//
// The POS icon assigned to an item on THIS terminal is shown too, because that
// is the same item and an operator editing it should see what the till draws.
// It is read-only here: assigning icons stays in Settings > Icons Gallery, and
// nothing in this component can write one.

import { Badge, Button, EmptyState, GatedButton, Input, StatusDot, cn } from "@/components/ui";
import { Glyph } from "@/components/Glyph";
import { PosIconGlyph } from "@/components/PosIconGlyph";
import { formatMoney, type CurrencyCode } from "@/lib/currency";
import { resolveMenuPrice } from "@/lib/pos/menuPrice";
import { ALL_CATEGORIES, ANY_STATUS, NO_CATEGORY, groupCountForItem, type ItemFilter } from "@/lib/menu/filters";
import { ITEM_STATUSES, ITEM_STATUS_LABELS, type BuilderCategory, type BuilderItem } from "@/lib/menu/types";
import type { IconAssignments } from "@/lib/icons/assignments";
import type { Gate } from "@/components/ui";

const STATUS_TONE: Record<string, "green" | "amber" | "slate" | "red"> = {
  published: "green",
  draft: "slate",
  hidden: "amber",
  out_of_stock: "red",
  scheduled: "amber",
  archived: "slate",
};

export function ItemsTab({
  items,
  categories,
  groupsByItem,
  icons,
  filter,
  currency,
  rate,
  createGate,
  editGate,
  onFilterChange,
  onCreate,
  onEdit,
}: {
  items: BuilderItem[];
  categories: BuilderCategory[];
  groupsByItem: Record<string, string[]>;
  icons: IconAssignments;
  filter: ItemFilter;
  currency: CurrencyCode;
  rate: number | null;
  createGate: Gate;
  editGate: Gate;
  onFilterChange: (next: ItemFilter) => void;
  onCreate: () => void;
  onEdit: (item: BuilderItem) => void;
}) {
  const categoryName = new Map(categories.map((c) => [c.id, c.name]));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <div className="relative min-w-[200px] flex-1">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sub">
            <Glyph name="search" size={16} />
          </span>
          <Input
            value={filter.query}
            placeholder="Search items, categories, descriptions…"
            className="pl-9"
            onChange={(e) => onFilterChange({ ...filter, query: e.target.value })}
          />
        </div>
        <select
          value={filter.categoryId}
          onChange={(e) => onFilterChange({ ...filter, categoryId: e.target.value })}
          className="min-h-[44px] rounded-xl border border-line bg-white px-3 text-sm text-ink outline-none focus:border-brand"
        >
          <option value={ALL_CATEGORIES}>All categories</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
          <option value={NO_CATEGORY}>No category</option>
        </select>
        <select
          value={filter.status}
          onChange={(e) => onFilterChange({ ...filter, status: e.target.value })}
          className="min-h-[44px] rounded-xl border border-line bg-white px-3 text-sm text-ink outline-none focus:border-brand"
        >
          <option value={ANY_STATUS}>Any status</option>
          {ITEM_STATUSES.map((s) => (
            <option key={s} value={s}>
              {ITEM_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        <Button
          variant={filter.unavailableOnly ? "primary" : "ghost"}
          onClick={() => onFilterChange({ ...filter, unavailableOnly: !filter.unavailableOnly })}
          title="Show only items switched off right now"
        >
          Unavailable only
        </Button>
        <GatedButton gate={createGate} onClick={onCreate}>
          + Add item
        </GatedButton>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <EmptyState
            icon="🍽"
            title="No items match"
            hint="Change the search or filters, or add the first item on this menu."
          />
        ) : (
          <ul className="divide-y divide-line">
            {items.map((item) => {
              const price = resolveMenuPrice(item, item.price, currency, rate);
              const groups = groupCountForItem(groupsByItem, item.id);
              const iconKey = icons[item.id];
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => onEdit(item)}
                    className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-slate-50"
                  >
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-line bg-slate-50 text-sub">
                      {item.thumbnail_url || item.image_url ? (
                        <img src={item.thumbnail_url ?? item.image_url ?? ""} alt="" className="h-full w-full object-cover" />
                      ) : iconKey ? (
                        <PosIconGlyph iconKey={iconKey} size={22} />
                      ) : (
                        <Glyph name="bag" size={18} />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-bold text-ink">{item.name}</span>
                      <span className="block truncate text-xs text-sub">
                        {item.category_id ? (categoryName.get(item.category_id) ?? "Unknown category") : "No category"}
                        {groups > 0 && ` · ${groups} modifier group${groups === 1 ? "" : "s"}`}
                      </span>
                    </span>
                    <span className={cn("shrink-0 text-sm font-bold", price.amount == null ? "text-sub" : "text-ink")}>
                      {price.amount == null ? "No price" : formatMoney(price.amount, currency)}
                    </span>
                    <span className="flex w-40 shrink-0 items-center justify-end gap-2">
                      {!item.is_available && (
                        <span className="flex items-center gap-1 text-[11px] font-semibold text-amber-800">
                          <StatusDot tone="amber" />
                          Off
                        </span>
                      )}
                      <Badge tone={STATUS_TONE[item.status] ?? "slate"}>{ITEM_STATUS_LABELS[item.status] ?? item.status}</Badge>
                    </span>
                    <span className="shrink-0 text-sub" title={editGate.reason ?? "Edit"}>
                      <Glyph name="chevron-right" size={16} />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
