// THE menu button.
//
// ONE COMPONENT, TWO CALLERS: the POS grid renders it for real, and the Icons
// Gallery renders the same component as its preview. That is the whole reason it
// exists as a file rather than as markup inside the grid - a preview drawn by a
// second component is a preview of a button that does not exist, and the icon
// feature's entire promise is "this is how it will look".
//
// LAYOUT: glyph on the left, name and price stacked beside it. The name is the
// widest thing on the card and the price is the boldest; between them they are
// what a cashier reads at arm's length, and the icon is what makes the button
// findable before either is read.
//
// NO COLOUR LITERALS. Every colour here is a theme token class.

import { cn } from "@/components/ui";
import { PosIconMark } from "@/components/PosIconGlyph";
import { formatMoney, type CurrencyCode } from "@/lib/currency";
import { DEFAULT_ICON_DISPLAY, type IconDisplay } from "@/lib/icons/display";

export const MENU_CARD_HEIGHT = 96;

export function MenuCard({
  name,
  price,
  currency,
  iconKey,
  display = DEFAULT_ICON_DISPLAY,
  needsChoice = false,
  disabled = false,
  title,
  onClick,
  className,
  /** Rendered flat, without the button semantics, for the settings preview. */
  as = "button",
}: {
  name: string;
  /** Null renders "No price" rather than a zero, which would be a lie. */
  price: number | null;
  currency: CurrencyCode;
  iconKey?: string | null;
  display?: IconDisplay;
  needsChoice?: boolean;
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
  className?: string;
  as?: "button" | "div";
}) {
  const body = (
    <>
      {iconKey ? (
        <PosIconMark iconKey={iconKey} display={display} className="mt-0.5" />
      ) : (
        // A reserved, empty box rather than nothing: without it an unassigned
        // item's name starts in a different place from its neighbours', and a
        // grid where the text jumps column to column is harder to scan than one
        // with a few blanks in it.
        <span aria-hidden className="mt-0.5 w-[34px] shrink-0" />
      )}
      <span className="flex min-w-0 flex-1 flex-col justify-center gap-1">
        <span className="line-clamp-2 text-sm font-semibold leading-snug text-ink">{name}</span>
        <span className="flex items-center justify-between gap-2">
          <span className="text-sm font-extrabold tabular-nums text-brand-dark">
            {price === null ? "No price" : formatMoney(price, currency)}
          </span>
          {needsChoice && (
            <span className="shrink-0 rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-bold text-sky-800">Options</span>
          )}
        </span>
      </span>
    </>
  );

  const shell = cn(
    "flex w-full items-start gap-2.5 rounded-xl border border-line bg-white p-3 text-left transition",
    as === "button" && "hover:border-brand hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40",
    as === "button" && "disabled:cursor-not-allowed disabled:opacity-50",
    className,
  );

  if (as === "div") {
    return (
      <div className={shell} style={{ minHeight: MENU_CARD_HEIGHT }}>
        {body}
      </div>
    );
  }

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={title}
      style={{ height: MENU_CARD_HEIGHT }}
      className={shell}
    >
      {body}
    </button>
  );
}
