// One table on the map.
//
// Every state carries an icon, a text label AND a colour treatment - never
// colour alone. The card only shows what `pos_table_map` actually returned: an
// absent total stays absent rather than being rendered as a confident 0.00.

import { cn } from "@/components/ui";
import { Glyph, type GlyphName } from "@/components/Glyph";
import { formatMoney } from "@/lib/currency";
import { elapsedMinutes, formatElapsed, tableCardState } from "@/lib/pos/tables";
import type { TableCardState, TableSummary } from "@/types/tables";

/** Minimum practical card size - comfortably above the 44px touch floor. */
export const TABLE_CARD_MIN_WIDTH = 150;
export const TABLE_CARD_MIN_HEIGHT = 110;

/**
 * State treatments.
 *
 * NEVER COLOUR ALONE. Each state carries a glyph, a word AND a treatment, so a
 * table's state survives a monochrome screen, a colour-blind operator and a
 * theme whose palette is nothing like Classic Green's.
 *
 * A table with a bill on it is drawn in the BRAND, which is what the approved
 * design shows and is also the honest emphasis: a table with money on it is the
 * one the cashier is looking for.
 */
const STATE_STYLE: Record<TableCardState, { label: string; icon: GlyphName; ring: string; badge: string }> = {
  available: { label: "Free", icon: "seats", ring: "border-line bg-white", badge: "bg-slate-100 text-slate-700" },
  occupied: { label: "Occupied", icon: "user", ring: "border-amber-300 bg-amber-50/60", badge: "bg-amber-100 text-amber-800" },
  active_bill: { label: "Open bill", icon: "pay", ring: "border-brand bg-brand-soft/40", badge: "bg-brand-soft text-brand-dark" },
  mixed_currency: { label: "Mixed currency", icon: "info", ring: "border-red-300 bg-red-50/70", badge: "bg-red-100 text-red-800" },
  reserved: { label: "Reserved", icon: "clock", ring: "border-sky-200 bg-sky-50/40", badge: "bg-sky-100 text-sky-800" },
  unknown: { label: "Unknown", icon: "info", ring: "border-line bg-white", badge: "bg-slate-100 text-slate-600" },
};

export function TableCard({
  table,
  selected,
  focused,
  stale,
  now,
  onSelect,
}: {
  table: TableSummary;
  selected: boolean;
  focused: boolean;
  stale: boolean;
  now: number;
  onSelect: () => void;
}) {
  const state = tableCardState(table);
  const style = STATE_STYLE[state];
  const elapsed = formatElapsed(elapsedMinutes(table.opened_at, now));

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      data-table-id={table.id}
      style={{ minWidth: TABLE_CARD_MIN_WIDTH, minHeight: TABLE_CARD_MIN_HEIGHT }}
      className={cn(
        "flex flex-col justify-between rounded-xl border-2 p-3 text-left transition",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40",
        style.ring,
        selected && "ring-2 ring-brand ring-offset-1 shadow-sm",
        focused && !selected && "ring-2 ring-brand/40",
        stale && "opacity-60",
      )}
    >
      <span className="flex items-start justify-between gap-2">
        {/* The tenant's own label, verbatim - never prefixed or re-derived. */}
        <span className="truncate text-sm font-extrabold text-ink">{table.name}</span>
        {table.seats != null && (
          <span
            className="flex shrink-0 items-center gap-1 text-[11px] font-semibold text-sub"
            title={`${table.seats} seats`}
          >
            <Glyph name="seats" size={13} />
            {table.seats}
          </span>
        )}
      </span>

      <span className="flex flex-col gap-1">
        {table.order_number && (
          <span className="truncate text-[11px] font-semibold text-sub">#{table.order_number}</span>
        )}
        <span className="flex items-center justify-between gap-2">
          <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold", style.badge)}>
            <Glyph name={style.icon} size={12} />
            {style.label}
          </span>
          {/* A total the server declined to sum is shown as a warning, not a number. */}
          {table.total != null && table.currency ? (
            <span className="text-sm font-extrabold tabular-nums text-ink">
              {formatMoney(table.total, table.currency)}
            </span>
          ) : table.mixed_currency ? (
            <span className="text-[11px] font-bold text-red-700">Settle separately</span>
          ) : null}
        </span>
        {(elapsed || table.orders > 1) && (
          <span className="flex items-center justify-between text-[11px] text-sub">
            <span>{elapsed ? `Open ${elapsed}` : ""}</span>
            {table.orders > 1 && <span>{table.orders} orders</span>}
          </span>
        )}
      </span>
    </button>
  );
}
