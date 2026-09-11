// One cart line.
//
// Removal is a single tap with an undo toast rather than a confirm dialog: a
// confirm on every remove costs a cashier hundreds of taps a shift, while undo
// costs one only when a mistake actually happens.

import { Button, cn } from "@/components/ui";
import { formatMoney, type CurrencyCode } from "@/lib/currency";
import { lineTotals } from "@/lib/pos/modifiers";
import type { CartLine } from "@/types/pos";

export function CartLineRow({
  line,
  selected,
  currency,
  onSelect,
  onAdjust,
  onRemove,
  onEditNote,
}: {
  line: CartLine;
  selected: boolean;
  currency: CurrencyCode;
  onSelect: () => void;
  onAdjust: (delta: number) => void;
  onRemove: () => void;
  onEditNote: () => void;
}) {
  const { finalUnitPrice, lineTotal } = lineTotals(line.base_price, line.modifiers, line.quantity);

  return (
    <li
      onClick={onSelect}
      className={cn(
        "rounded-xl border px-2.5 py-2 transition",
        selected ? "border-brand bg-brand-soft/40" : "border-line bg-white hover:border-brand/40",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          {/* Name and unit price share one line so the row loses the separate
              "each" line it used to carry, without losing either fact. */}
          <div className="flex items-baseline gap-2">
            <p className="min-w-0 flex-1 truncate text-sm font-bold text-ink">{line.name}</p>
            <span className="shrink-0 text-[11px] text-sub">{formatMoney(finalUnitPrice, currency)} ea</span>
          </div>
          {line.modifiers.length > 0 && (
            <ul className="mt-0.5 space-y-0.5">
              {line.modifiers.map((m) => (
                <li key={`${m.option_id}`} className="flex justify-between gap-2 text-xs text-sub">
                  <span className="truncate">+ {m.name}</span>
                  {m.price_delta !== 0 && <span className="shrink-0">{formatMoney(m.price_delta, currency)}</span>}
                </li>
              ))}
            </ul>
          )}
          {line.kitchen_note && <p className="mt-0.5 truncate text-xs italic text-amber-700">Note: {line.kitchen_note}</p>}
        </div>
        <p className="shrink-0 text-sm font-extrabold text-ink">{formatMoney(lineTotal, currency)}</p>
      </div>

      <div className="mt-1.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label={`Decrease ${line.name}`}
            onClick={(e) => {
              e.stopPropagation();
              onAdjust(-1);
            }}
            disabled={line.quantity <= 1}
            className="flex h-11 w-11 items-center justify-center rounded-lg border border-line bg-white text-lg font-bold text-ink disabled:opacity-40"
          >
            -
          </button>
          <span className="w-10 text-center text-base font-extrabold tabular-nums">{line.quantity}</span>
          <button
            type="button"
            aria-label={`Increase ${line.name}`}
            onClick={(e) => {
              e.stopPropagation();
              onAdjust(1);
            }}
            className="flex h-11 w-11 items-center justify-center rounded-lg border border-line bg-white text-lg font-bold text-ink"
          >
            +
          </button>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            onClick={(e) => {
              e.stopPropagation();
              onEditNote();
            }}
          >
            Note
          </Button>
          {/* Kept visually apart from the quantity controls so a mis-tap costs nothing. */}
          <button
            type="button"
            aria-label={`Remove ${line.name}`}
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            className="ml-2 flex h-11 w-11 items-center justify-center rounded-lg border border-red-200 text-sm font-bold text-red-600 hover:bg-red-50"
          >
            Del
          </button>
        </div>
      </div>
    </li>
  );
}
