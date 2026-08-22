// THE POS BUTTON. One component, every cashier layout.
//
// Default, Categories and Customized all render this, and so does the layout
// designer's preview - so what a manager approves in Settings is the button, not
// a drawing of it, and the three layouts cannot drift into three looks.
//
// THE INTERNAL LAYOUT IS DELIBERATE, AND IT IS THE THING THAT CHANGED.
//
// The previous version stacked the name at the top and the price at the bottom
// with `justify-between`. On a tall key that puts two or three centimetres of
// nothing between the two pieces of information a cashier actually reads, and
// the eye has to travel the whole button to price one item. The content is now
// ONE CENTRED BLOCK: name, then price immediately beneath it, with the icon
// inline. Whatever space is left over becomes even margin around the block
// instead of a gap through the middle of it.
//
// THE PRICE IS PASSED IN, NEVER STORED. It arrives resolved from the canonical
// menu item on every render, so a price changed in Menu Builder is on this
// button the next time the POS opens - nothing to sync, nothing to go stale.
//
// COLOUR IS EXPLICIT, INK IS COMPUTED - see `lib/pos/grid/colors.ts`. An
// uncoloured button uses theme classes and follows the terminal's theme exactly;
// a coloured one is a deliberate landmark and looks the same on every theme,
// with an ink chosen by measured contrast so it is readable in all of them.

import { PosIconGlyph } from "@/components/PosIconGlyph";
import { cn } from "@/components/ui";
import { formatMoney, type CurrencyCode } from "@/lib/currency";
import { resolveColor, SECONDARY_INK_OPACITY } from "@/lib/pos/grid/colors";
import { spanSize, type GridMetrics } from "@/lib/pos/grid/fit";
import { formatQuantity } from "@/lib/pos/itemOptions";
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
  /** True when tapping opens the ingredient / portion options popup. */
  hasOptions?: boolean;
  selected?: boolean;
  /** How many of this item are already on the order. Null hides the badge. */
  inOrderQuantity?: number | null;
  /** Explicit placement, for the customized grid. Omitted = flow order. */
  placed?: boolean;
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
  hasOptions = false,
  selected = false,
  inOrderQuantity = null,
  placed = true,
  onClick,
  onContextMenu,
}: GridButtonTileProps) {
  const { fill, ink } = resolveColor(button.color);
  const size = spanSize(metrics, button.width, button.height);
  const isCategory = button.kind === "category";
  const disabled = Boolean(unavailableReason);

  // The secondary line: what a category opens, or what an item costs. Exactly
  // one line either way, so every key in a grid has the same silhouette.
  const secondary = isCategory
    ? `${button.children.length > 0 ? `${button.children.length} items` : "Open"}`
    : price === null
      ? "No price"
      : formatMoney(price, currency);

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      onContextMenu={onContextMenu}
      title={unavailableReason ?? button.label}
      aria-label={button.label}
      style={{
        ...(placed
          ? {
              // Placed by the grid parent; the size is stated so a 2-wide button
              // spans two cells PLUS the gap between them, not two cell widths.
              gridColumn: `${button.col} / span ${button.width}`,
              gridRow: `${button.row} / span ${button.height}`,
            }
          : {}),
        width: size.width,
        height: size.height,
        borderRadius: metrics.radiusPx,
        padding: metrics.padPx,
        ...(fill && ink ? { backgroundColor: fill, color: ink, borderColor: ink, borderStyle: "solid" } : {}),
        borderWidth: selected ? 3 : 1,
      }}
      className={cn(
        "relative flex min-w-0 flex-col items-center justify-center overflow-hidden text-center transition",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50",
        // The uncoloured default is FULLY THEMED - the same tokens every other
        // surface in the app uses, so it follows Light, Dark and every brand.
        !fill && "border-line bg-white text-ink hover:border-brand",
        !fill && selected && "border-brand",
        fill && "hover:brightness-95",
        disabled && "cursor-not-allowed opacity-45",
      )}
    >
      {/* Corner marks. Absolutely positioned so they annotate the key without
          taking a row from the content block and re-introducing dead space. */}
      {inOrderQuantity !== null && inOrderQuantity > 0 && (
        <span
          style={{ fontSize: Math.max(9, metrics.priceFontPx - 3) }}
          className={cn(
            "absolute left-1 top-1 rounded-md px-1 font-extrabold tabular-nums",
            fill ? "bg-black/15" : "bg-brand text-onbrand",
          )}
        >
          {formatQuantity(inOrderQuantity)}
        </span>
      )}
      {isCategory && (
        <span
          aria-hidden
          style={{ fontSize: Math.max(10, metrics.priceFontPx) }}
          className="absolute right-1.5 top-1 font-bold"
          // A category needs to read as "this opens something" at a glance, so
          // it carries a chevron as well as a different secondary line.
        >
          ›
        </span>
      )}

      {/* ONE CENTRED BLOCK: icon, name, price. Nothing is pinned to an edge, so
          leftover height becomes margin around the group rather than a gap
          through the middle of it. */}
      <span className="flex min-w-0 max-w-full flex-col items-center justify-center gap-0.5">
        {button.iconKey && (
          <span className="opacity-90">
            <PosIconGlyph iconKey={button.iconKey} size={metrics.iconPx} />
          </span>
        )}
        <span
          style={{ fontSize: metrics.labelFontPx, lineHeight: 1.15 }}
          className="line-clamp-2 w-full break-words font-bold"
        >
          {button.label}
        </span>
        <span
          style={{ fontSize: metrics.priceFontPx, opacity: SECONDARY_INK_OPACITY }}
          className="w-full truncate font-extrabold tabular-nums"
        >
          {secondary}
        </span>
      </span>

      {/* A single quiet marker when tapping will ask a question. Bottom-anchored
          and tiny: it is a hint, not a second label. */}
      {!isCategory && (needsChoice || hasOptions) && (
        <span
          style={{ fontSize: Math.max(8, metrics.priceFontPx - 4), opacity: SECONDARY_INK_OPACITY }}
          className="absolute bottom-1 font-bold uppercase tracking-wide"
        >
          {needsChoice ? "Options" : "Custom"}
        </span>
      )}
    </button>
  );
}
