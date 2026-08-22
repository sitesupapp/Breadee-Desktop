// Menu grid.
//
// Windowed rendering: only the rows near the viewport are mounted, so a 500-item
// menu costs about the same as a 30-item one and stays smooth for a whole shift.
// Cards are large touch targets, show the resolved current price, and flag items
// that will ask for a required choice so the cashier knows a dialog is coming
// before they tap.

import { useMemo, useRef, useState } from "react";
import { type CurrencyCode } from "@/lib/currency";
import { resolveMenuPrice } from "@/lib/pos/menuPrice";
import { useElementSize } from "@/lib/useElementSize";
import type { SearchableItem } from "@/lib/pos/menu";
import { MenuCard, MENU_CARD_HEIGHT } from "@/components/pos/MenuCard";
import { iconForItem, readIconAssignments } from "@/lib/icons/assignments";
import { readIconDisplay } from "@/lib/icons/display";

const CARD_HEIGHT = MENU_CARD_HEIGHT;
const GRID_GAP = 12;
const ROW_HEIGHT = CARD_HEIGHT + GRID_GAP;
const OVERSCAN_ROWS = 3;

export type MenuItemGridProps = {
  items: SearchableItem[];
  columns: number;
  currency: CurrencyCode;
  rate: number | null;
  itemsNeedingChoice: ReadonlySet<string>;
  onPick: (item: SearchableItem, price: number) => void;
};

export function MenuItemGrid({ items, columns, currency, rate, itemsNeedingChoice, onPick }: MenuItemGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { height: viewportHeight } = useElementSize(scrollRef);
  const [scrollTop, setScrollTop] = useState(0);

  /**
   * Icon assignments, read ONCE per mount.
   *
   * From `localStorage`, which is synchronous, so this costs a single small
   * JSON parse when the workspace opens - not one per card, and never per
   * scroll frame. An assignment made in Settings appears the next time the POS
   * is opened, which is the right cadence for a decision nobody makes during
   * service.
   */
  const icons = useMemo(() => readIconAssignments(), []);
  /** The style and size those icons are drawn at. Read once, for the same reason. */
  const iconDisplay = useMemo(() => readIconDisplay(), []);

  const rows = Math.ceil(items.length / columns);
  const totalHeight = Math.max(0, rows * ROW_HEIGHT - GRID_GAP);

  const { firstRow, lastRow } = useMemo(() => {
    const height = viewportHeight || 600;
    const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN_ROWS);
    const visible = Math.ceil(height / ROW_HEIGHT) + OVERSCAN_ROWS * 2;
    return { firstRow: first, lastRow: Math.min(rows, first + visible) };
  }, [scrollTop, viewportHeight, rows]);

  const slice = items.slice(firstRow * columns, lastRow * columns);

  return (
    <div
      ref={scrollRef}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1"
    >
      <div style={{ height: totalHeight, position: "relative" }}>
        <div
          style={{
            position: "absolute",
            top: firstRow * ROW_HEIGHT,
            left: 0,
            right: 0,
            display: "grid",
            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
            gap: GRID_GAP,
          }}
        >
          {slice.map((item) => {
            const resolved = resolveMenuPrice(item, item.price, currency, rate);
            const price = resolved.amount;
            const unpriced = price === null;
            const needsChoice = itemsNeedingChoice.has(item.id);
            const iconKey = iconForItem(icons, item.id);
            return (
              // THE SHARED CARD. The same component the Icons Gallery previews,
              // so an operator approving an icon in Settings is looking at this
              // button and not a drawing of it.
              <MenuCard
                key={item.id}
                name={item.name}
                price={unpriced ? null : price}
                currency={currency}
                iconKey={iconKey}
                display={iconDisplay}
                needsChoice={needsChoice}
                disabled={unpriced}
                title={unpriced ? "This item has no price in the current currency." : undefined}
                onClick={() => onPick(item, price ?? 0)}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
