// One key on the customized cashier grid.
//
// ONE COMPONENT, TWO CALLERS - the live grid and the designer - for the same
// reason `MenuCard` is shared with the Icons Gallery: a preview drawn by a
// second component is a preview of a button that does not exist, and the whole
// promise of a layout designer is "this is what your till will look like".
//
// THE PRICE IS PASSED IN, NEVER STORED. It arrives resolved from the canonical
// menu item on every render, so a price changed in Menu Builder is on this
// button the next time the POS opens - with nothing to sync and nothing that can
// go stale. There is no price prop on the layout model at all.
//
// COLOUR IS EXPLICIT, INK IS COMPUTED - see `lib/pos/grid/colors.ts`. An
// uncoloured button uses theme classes and follows the terminal's theme exactly;
// a coloured one is a deliberate landmark and looks the same on every theme,
// with an ink chosen by measured contrast so it is readable in all of them.

import { PosIconGlyph } from "@/components/PosIconGlyph";
import { cn } from "@/components/ui";
import { formatMoney, type CurrencyCode } from "@/lib/currency";
import { resolveColor, SECONDARY_INK_OPACITY } from "@/lib/pos/grid/colors";
import type { GridMetrics } from "@/lib/pos/grid/fit";
import { spanSize } from "@/lib/pos/grid/fit";
import type { GridButton } from "@/lib/pos/grid/model";

export type GridButtonTileProps = {
  button: GridButton;
  metrics: GridMetrics;
  /** Resolved from the canonical item. Null renders "No price", never a zero. */
  price: number | null;
  currency: CurrencyCode;
  /** Why this button cannot be pressed. Renders it dimmed with the reason. */
  unavailableReason?: string | null;
  /** True for a required-choice item, so the cashier knows a dialog is coming. */
  needsChoice?: boolean;
  selected?: boolean;
  onClick?: () => void;
  onContextMenu?: (event: React.MouseEvent) => void;
};

export function GridButtonTile({
  button,
  metrics,
  price,
  currency,
  unavailableReason = null,
  needsChoice = false,
  selected = false,
  onClick,
  onContextMenu,
}: GridButtonTileProps) {
  const { fill, ink } = resolveColor(button.color);
  const size = spanSize(metrics, button.width, button.height);
  const isCategory = button.kind === "category";
  const disabled = Boolean(unavailableReason);

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      onContextMenu={onContextMenu}
      title={unavailableReason ?? button.label}
      aria-label={button.label}
      style={{
        // Placed by the grid parent; the size is stated so a 2-wide button
        // spans two cells PLUS the gap between them rather than two cell widths.
        gridColumn: `${button.col} / span ${button.width}`,
        gridRow: `${button.row} / span ${button.height}`,
        width: size.width,
        height: size.height,
        borderRadius: metrics.radiusPx,
        padding: metrics.padPx,
        ...(fill && ink ? { backgroundColor: fill, color: ink, borderColor: ink, borderStyle: "solid" } : {}),
        borderWidth: selected ? 3 : 1,
      }}
      className={cn(
        "flex min-w-0 flex-col items-start justify-between overflow-hidden text-left transition",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50",
        // The uncoloured default is FULLY THEMED - the same tokens every other
        // surface in the app uses, so it follows Light, Dark and every brand.
        !fill && "border-line bg-white text-ink hover:border-brand",
        !fill && selected && "border-brand",
        fill && "hover:brightness-95",
        disabled && "cursor-not-allowed opacity-45",
      )}
    >
      <span className="flex w-full min-w-0 items-start gap-1.5">
        {button.iconKey && (
          <span className="shrink-0 opacity-90">
            <PosIconGlyph iconKey={button.iconKey} size={metrics.iconPx} />
          </span>
        )}
        <span
          style={{ fontSize: metrics.labelFontPx, lineHeight: 1.15 }}
          className="min-w-0 flex-1 break-words font-bold"
        >
          {button.label}
        </span>
      </span>

      <span className="flex w-full items-baseline justify-between gap-1">
        <span
          style={{ fontSize: metrics.priceFontPx, opacity: SECONDARY_INK_OPACITY }}
          className="truncate font-extrabold tabular-nums"
        >
          {/* A category is navigation and has no price of its own. Showing a
              total, or a zero, would be inventing a figure the business does
              not have. */}
          {isCategory
            ? `${button.children.length} item${button.children.length === 1 ? "" : "s"}`
            : price === null
              ? "No price"
              : formatMoney(price, currency)}
        </span>
        {needsChoice && !isCategory && (
          <span
            style={{ fontSize: Math.max(9, metrics.priceFontPx - 3), opacity: SECONDARY_INK_OPACITY }}
            className="shrink-0 font-bold"
          >
            Options
          </span>
        )}
        {isCategory && (
          <span style={{ fontSize: Math.max(9, metrics.priceFontPx - 2), opacity: SECONDARY_INK_OPACITY }} className="shrink-0">
            ›
          </span>
        )}
      </span>
    </button>
  );
}
