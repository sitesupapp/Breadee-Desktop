// The LIVE customized cashier grid.
//
// IT DOES NOT SCROLL. That is the requirement this component exists to satisfy,
// and it satisfies it by MEASURING its own box and fitting the grid into it -
// see `lib/pos/grid/fit.ts`. There is no `overflow-y-auto` here, no virtualised
// list and no fixed cell size: the grid is exactly as many rows and columns as
// the layout declares, and every cell is as large as the space allows.
//
// AND WHEN IT CANNOT FIT, IT SAYS SO INSTEAD OF DRAWING SOMETHING BROKEN. Below
// the usable touch size the component renders a short notice with the fix. The
// designer already refuses to save such a layout, so this is the case where a
// terminal was later moved to a smaller screen or its display scaling changed -
// which is exactly the case a designer-time check cannot catch.
//
// IT ADDS NO ORDERING LOGIC WHATSOEVER. `onPick` is the SAME `addItem` the
// default menu grid is given, called with the SAME canonical item and the SAME
// resolved price. This component does not touch the cart, the modifiers, the
// claim, the shift or the payment path; it decides which item was pressed and
// nothing else. That is what makes "one POS engine, two presentations" true
// rather than aspirational.

import { useMemo, useRef, useState } from "react";
import { Button, cn } from "@/components/ui";
import { useElementSize } from "@/lib/useElementSize";
import { type CurrencyCode } from "@/lib/currency";
import { resolveMenuPrice } from "@/lib/pos/menuPrice";
import type { SearchableItem } from "@/lib/pos/menu";
import { fitGrid } from "@/lib/pos/grid/fit";
import { GridButtonTile } from "@/components/pos/grid/GridButtonTile";
import type { GridButton, PosGridLayout } from "@/lib/pos/grid/model";

export type CustomGridProps = {
  layout: PosGridLayout;
  /** The canonical menu, by id. The ONLY source of price and availability. */
  itemsById: Map<string, SearchableItem>;
  currency: CurrencyCode;
  rate: number | null;
  itemsNeedingChoice: ReadonlySet<string>;
  /** The workspace's own `addItem`. Identical to the default grid's. */
  onPick: (item: SearchableItem, price: number) => void;
};

export function CustomGrid({ layout, itemsById, currency, rate, itemsNeedingChoice, onPick }: CustomGridProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const { width, height } = useElementSize(boxRef);

  /**
   * Which category is open, by id. `null` is the main page.
   *
   * ONE LEVEL, so "Back" and "Main" are the same gesture and there is no stack
   * to get out of step with the screen. Both controls are rendered anyway,
   * because a cashier reads "Main" as "start the next order's selection" and a
   * control that appears only sometimes is one they cannot rely on.
   */
  const [openCategoryId, setOpenCategoryId] = useState<string | null>(null);
  const openCategory = openCategoryId ? layout.buttons.find((b) => b.id === openCategoryId) ?? null : null;
  const buttons = openCategory ? openCategory.children : layout.buttons;

  /**
   * "NOT MEASURED YET" IS NOT THE SAME ANSWER AS "TOO SMALL", and conflating
   * them is a real defect rather than a nicety. An unmeasured box is 0x0, which
   * every size test fails - so the first frame would tell a cashier their screen
   * is too small for the layout they use every day, and a browser that never
   * delivers a measurement would say it permanently. `useElementSize` now reads
   * the box synchronously before paint, and this guard is the second half of
   * that fix: until there IS a measurement, this component judges nothing.
   */
  const measured = width > 0 && height > 0;

  const fit = useMemo(
    () => fitGrid({ availableWidth: width, availableHeight: height, columns: layout.columns, rows: layout.rows }),
    [width, height, layout.columns, layout.rows],
  );

  /** The canonical item behind a button, and what it costs right now. */
  const resolve = (button: GridButton) => {
    if (button.kind !== "menu_item" || !button.menuItemId) return { item: null, price: null as number | null };
    const item = itemsById.get(button.menuItemId) ?? null;
    if (!item) return { item: null, price: null as number | null };
    const resolved = resolveMenuPrice(item, item.price, currency, rate);
    return { item, price: resolved.amount };
  };

  const press = (button: GridButton) => {
    if (button.kind === "category") {
      setOpenCategoryId(button.id);
      return;
    }
    const { item, price } = resolve(button);
    // A button whose item is gone is already rendered disabled; this is the
    // belt-and-braces case where the menu reloaded between render and press.
    if (!item) return;
    onPick(item, price ?? 0);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Navigation. Back leaves a category; Main returns to the top so the
          cashier can start the next order the way they always do. Neither
          touches the cart - see the header comment. */}
      <div className="mb-2 flex shrink-0 items-center gap-2">
        <Button
          size="md"
          variant="ghost"
          disabled={openCategoryId === null}
          onClick={() => setOpenCategoryId(null)}
          title="Back one level"
        >
          {/* A text arrow rather than a glyph: the catalogue has no back mark,
              and borrowing a similar one would put a control on the till whose
              icon means something else elsewhere in the app. */}
          <span aria-hidden>←</span>
          Back
        </Button>
        <Button
          size="md"
          variant={openCategoryId === null ? "subtle" : "ghost"}
          onClick={() => setOpenCategoryId(null)}
          title="Back to the main buttons"
        >
          Main
        </Button>
        {openCategory && (
          <span className="truncate rounded-lg bg-brand-soft px-3 py-2 text-xs font-extrabold text-brand-dark">
            {openCategory.label}
          </span>
        )}
      </div>

      <div ref={boxRef} className="min-h-0 flex-1">
        {!measured ? (
          /* One frame at most, and nothing is claimed in it. */
          <div className="h-full" aria-hidden />
        ) : fit.kind === "too_small" ? (
          /* Deliberately a notice, not a scrollbar. */
          <div className="flex h-full items-center justify-center p-4">
            <div className="max-w-sm text-center">
              <p className="text-sm font-extrabold text-ink">This screen is too small for the customized layout</p>
              <p className="mt-1 text-xs text-sub">
                A {layout.columns}×{layout.rows} grid needs about {fit.needWidth}×{fit.needHeight} pixels here. Make the
                window larger, lower the display scaling, or choose a smaller grid in Settings → POS Settings → Cashier
                layout. The default layout still works at this size.
              </p>
            </div>
          </div>
        ) : buttons.length === 0 ? (
          <div className="flex h-full items-center justify-center p-4">
            <div className="max-w-sm text-center">
              <p className="text-sm font-extrabold text-ink">
                {openCategory ? `${openCategory.label} has no items yet` : "No buttons have been set up yet"}
              </p>
              <p className="mt-1 text-xs text-sub">
                Add them in Settings → POS Settings → Cashier layout, or switch back to the default layout.
              </p>
            </div>
          </div>
        ) : (
          <div
            className={cn("grid h-full w-full")}
            style={{
              gridTemplateColumns: `repeat(${layout.columns}, ${fit.metrics.cellWidth}px)`,
              gridTemplateRows: `repeat(${layout.rows}, ${fit.metrics.cellHeight}px)`,
              gap: fit.metrics.gap,
              alignContent: "start",
              justifyContent: "start",
            }}
          >
            {buttons.map((button) => {
              const { item, price } = resolve(button);
              const missing = button.kind === "menu_item" && !item;
              const unpriced = button.kind === "menu_item" && item !== null && price === null;
              return (
                <GridButtonTile
                  key={button.id}
                  button={button}
                  metrics={fit.metrics}
                  price={price}
                  currency={currency}
                  needsChoice={button.menuItemId ? itemsNeedingChoice.has(button.menuItemId) : false}
                  unavailableReason={
                    missing
                      ? "This item is not on the menu right now, so it cannot be ordered."
                      : unpriced
                        ? "This item has no price in the current currency."
                        : null
                  }
                  onClick={() => press(button)}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
