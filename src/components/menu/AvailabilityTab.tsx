// Availability & publishing - the fast lane.
//
// THIS TAB EXISTS BECAUSE THE DRAWER IS THE WRONG TOOL FOR A LUNCH RUSH. Marking
// six items out of stock should not be six drawer open/save/close cycles, so
// each row here carries the two controls that actually change during service:
// the publishing STATUS and the availability SWITCH. Both are single-column
// updates on `menu_items`, both go through the same confirmed mutation path as
// everything else, and both are exactly what the POS reads.
//
// WHAT THE TWO CONTROLS MEAN, because they are easy to confuse:
//   status = 'published'  the item is part of the menu at all
//   is_available = true   the item can be sold right now
// The POS loader requires BOTH (`status = 'published' AND is_available = true`),
// which is why "out of stock" and "hidden" are not the same thing and why the
// switch is not a fourth status.

import { Badge, Button, EmptyState, GatedButton, Input, cn } from "@/components/ui";
import { Glyph } from "@/components/Glyph";
import { Switch } from "@/components/Switch";
import { ITEM_STATUSES, ITEM_STATUS_LABELS, type BuilderItem, type ItemStatus } from "@/lib/menu/types";
import type { ItemFilter } from "@/lib/menu/filters";
import type { Gate } from "@/components/ui";

export function AvailabilityTab({
  items,
  filter,
  hiddenBy,
  editGate,
  publishGate,
  draftCount,
  busyId,
  publishing,
  onFilterChange,
  onClearFilters,
  onStatusChange,
  onAvailabilityChange,
  onPublishAllDrafts,
}: {
  items: BuilderItem[];
  filter: ItemFilter;
  /**
   * Human names of filters set on the Items tab that are ALSO narrowing this
   * list. The two tabs share one filter so a search carries between them, and
   * that is useful - but a category chosen on Items silently hiding half the
   * menu here is how somebody "marks everything back in stock" and misses six
   * items. So it is stated, with one click to drop it.
   */
  hiddenBy: string[];
  editGate: Gate;
  publishGate: Gate;
  draftCount: number;
  busyId: string | null;
  publishing: boolean;
  onFilterChange: (next: ItemFilter) => void;
  onClearFilters: () => void;
  onStatusChange: (item: BuilderItem, status: ItemStatus) => void;
  onAvailabilityChange: (item: BuilderItem, next: boolean) => void;
  onPublishAllDrafts: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <div className="relative min-w-[200px] flex-1">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sub">
            <Glyph name="search" size={16} />
          </span>
          <Input
            value={filter.query}
            placeholder="Find an item to switch off…"
            className="pl-9"
            onChange={(e) => onFilterChange({ ...filter, query: e.target.value })}
          />
        </div>
        <Button
          variant={filter.unavailableOnly ? "primary" : "ghost"}
          onClick={() => onFilterChange({ ...filter, unavailableOnly: !filter.unavailableOnly })}
        >
          Unavailable only
        </Button>
        <GatedButton gate={publishGate} disabled={draftCount === 0 || publishing} onClick={onPublishAllDrafts}>
          {publishing ? "Publishing…" : `Publish ${draftCount} draft${draftCount === 1 ? "" : "s"}`}
        </GatedButton>
      </div>

      {hiddenBy.length > 0 && (
        <p className="flex flex-wrap items-center gap-2 border-b border-line bg-amber-50 px-4 py-2 text-xs text-amber-900">
          <strong>This list is filtered</strong>
          <span>by {hiddenBy.join(" and ")} — some items are not shown.</span>
          <button type="button" onClick={onClearFilters} className="font-bold underline underline-offset-2">
            Show all items
          </button>
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <EmptyState icon="✓" title="Nothing to change" hint="No items match the current search." />
        ) : (
          <ul className="divide-y divide-line">
            {items.map((item) => {
              const busy = busyId === item.id;
              return (
                <li key={item.id} className={cn("flex flex-wrap items-center gap-3 px-4 py-2", busy && "opacity-60")}>
                  <span className="min-w-[160px] flex-1">
                    <span className="block truncate text-sm font-bold text-ink">{item.name}</span>
                  </span>
                  {!item.is_available && <Badge tone="amber">Off right now</Badge>}
                  <select
                    value={item.status}
                    aria-label={`Status for ${item.name}`}
                    disabled={!editGate.allowed || busy}
                    title={editGate.reason ?? undefined}
                    onChange={(e) => onStatusChange(item, e.target.value as ItemStatus)}
                    className="min-h-[44px] rounded-xl border border-line bg-white px-3 text-sm text-ink outline-none focus:border-brand disabled:bg-slate-50"
                  >
                    {ITEM_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {ITEM_STATUS_LABELS[s]}
                      </option>
                    ))}
                    {/* An item already in a status this tab does not offer (a
                        scheduled one, set on the web) keeps it visible instead of
                        being silently re-labelled as the first option. */}
                    {!ITEM_STATUSES.includes(item.status as (typeof ITEM_STATUSES)[number]) && (
                      <option value={item.status}>{ITEM_STATUS_LABELS[item.status] ?? item.status}</option>
                    )}
                  </select>
                  <span className="w-[190px] shrink-0">
                    <Switch
                      checked={item.is_available}
                      disabled={!editGate.allowed || busy}
                      title={editGate.reason ?? undefined}
                      onChange={(v) => onAvailabilityChange(item, v)}
                      label="Available"
                    />
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
