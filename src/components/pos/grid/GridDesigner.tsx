// The layout canvas: the grid as the cashier will see it, editable.
//
// RIGHT-CLICK IS THE PRIMARY GESTURE, because it is the one that already means
// "what can I do here" on Windows and because it puts the menu on the CELL the
// operator is pointing at - which is the whole question a placement UI has to
// answer. An empty cell offers Add button; a button offers Edit, Open (for a
// category), Move and Remove.
//
// EVERY CONTROL IS ALSO REACHABLE BY LEFT CLICK. Right-click-only would make the
// designer unusable on a touch till, which is precisely the hardware this
// feature is for: a left click on an empty cell adds, and a left click on a
// button selects it and shows the same actions as a toolbar.
//
// IT DRAWS THE REAL TILE. `GridButtonTile` is the component the live grid uses,
// with the same colours, the same fitted metrics and the same resolved prices -
// so the designer is a rehearsal rather than an illustration.

import { useMemo, useRef, useState } from "react";
import { Button, cn } from "@/components/ui";
import { useElementSize } from "@/lib/useElementSize";
import { type CurrencyCode } from "@/lib/currency";
import { resolveMenuPrice } from "@/lib/pos/menuPrice";
import type { SearchableItem } from "@/lib/pos/menu";
import { fitGrid } from "@/lib/pos/grid/fit";
import { GridButtonTile } from "@/components/pos/grid/GridButtonTile";
import { buttonAt, type GridButton, type GridPage } from "@/lib/pos/grid/model";

export type CellAction =
  | { kind: "add"; row: number; col: number }
  | { kind: "edit"; button: GridButton }
  | { kind: "open"; button: GridButton }
  | { kind: "move"; button: GridButton }
  | { kind: "remove"; button: GridButton };

export function GridDesigner({
  page,
  itemsById,
  currency,
  rate,
  /** Set while a Move is in progress: the next empty cell clicked is the target. */
  movingId,
  onAction,
  onDropAt,
}: {
  page: GridPage;
  itemsById: Map<string, SearchableItem>;
  currency: CurrencyCode;
  rate: number | null;
  movingId: string | null;
  onAction: (action: CellAction) => void;
  /** Where a moving button should land. */
  onDropAt: (row: number, col: number) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const { width } = useElementSize(boxRef);
  const [menu, setMenu] = useState<{ x: number; y: number; row: number; col: number } | null>(null);

  /**
   * The canvas is fitted to its OWN width at a fixed preview height per row.
   *
   * Deliberately not the live workspace's box: the designer sits inside a
   * settings page with a header and a sidebar, so fitting to it would show cells
   * smaller than the till's. The separate "will it fit" check is what answers
   * the real question, per target screen, and it is shown beside this canvas.
   */
  const fit = useMemo(
    () =>
      fitGrid({
        availableWidth: Math.max(0, width),
        availableHeight: Math.max(0, page.rows * 74),
        columns: page.columns,
        rows: page.rows,
      }),
    [width, page.columns, page.rows],
  );

  const cells = useMemo(() => {
    const out: { row: number; col: number }[] = [];
    for (let row = 1; row <= page.rows; row += 1) {
      for (let col = 1; col <= page.columns; col += 1) out.push({ row, col });
    }
    return out;
  }, [page.rows, page.columns]);

  const openMenu = (event: React.MouseEvent, row: number, col: number) => {
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY, row, col });
  };

  const act = (action: CellAction) => {
    setMenu(null);
    onAction(action);
  };

  const cellClick = (row: number, col: number) => {
    const existing = buttonAt(page, row, col);
    if (movingId) {
      // A move lands wherever the operator clicks next, INCLUDING onto nothing.
      // A click on another button is refused by the model rather than swapping
      // them: swapping two keys is two changes an operator did not ask for.
      onDropAt(row, col);
      return;
    }
    if (existing) {
      act(existing.kind === "category" ? { kind: "open", button: existing } : { kind: "edit", button: existing });
      return;
    }
    act({ kind: "add", row, col });
  };

  const metrics = fit.metrics;

  return (
    <div className="relative">
      <div ref={boxRef}>
        <div
          className="grid w-full rounded-xl border border-dashed border-line bg-canvas p-2"
          style={{
            gridTemplateColumns: `repeat(${page.columns}, ${Math.max(40, metrics.cellWidth)}px)`,
            gridTemplateRows: `repeat(${page.rows}, ${Math.max(40, metrics.cellHeight)}px)`,
            gap: metrics.gap,
            justifyContent: "start",
          }}
        >
          {/* Empty cells first, so a button drawn over them wins the stacking. */}
          {cells.map(({ row, col }) => {
            if (buttonAt(page, row, col)) return null;
            return (
              <button
                key={`cell-${row}-${col}`}
                type="button"
                style={{ gridColumn: col, gridRow: row, borderRadius: metrics.radiusPx }}
                onClick={() => cellClick(row, col)}
                onContextMenu={(e) => openMenu(e, row, col)}
                title={movingId ? "Move the button here" : "Add a button here (or right-click)"}
                className={cn(
                  "flex items-center justify-center border border-dashed text-lg font-bold transition",
                  movingId
                    ? "border-brand bg-brand-soft/50 text-brand-dark"
                    : "border-line text-slate-300 hover:border-brand hover:text-brand-dark",
                )}
              >
                {movingId ? "↳" : "+"}
              </button>
            );
          })}

          {page.buttons.map((button) => {
            const item = button.menuItemId ? itemsById.get(button.menuItemId) ?? null : null;
            const price = item ? resolveMenuPrice(item, item.price, currency, rate).amount : null;
            return (
              <GridButtonTile
                key={button.id}
                button={button}
                metrics={metrics}
                price={price}
                currency={currency}
                selected={movingId === button.id}
                /* The designer must stay clickable even for a button with a
                   problem - the problem is usually what the operator opened the
                   designer to fix. `unavailableReason` only dims and explains
                   here; the LIVE grid is the surface that refuses the press. */
                unavailableReason={
                  button.kind === "menu_item" && !item ? "This item is not on the menu right now." : null
                }
                onClick={() => cellClick(button.row, button.col)}
                onContextMenu={(e) => openMenu(e, button.row, button.col)}
              />
            );
          })}
        </div>
      </div>

      {menu && (
        <>
          {/* One click anywhere closes it, which is what a context menu does. */}
          <div className="fixed inset-0 z-40" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <CellMenu
            x={menu.x}
            y={menu.y}
            button={buttonAt(page, menu.row, menu.col)}
            onAdd={() => act({ kind: "add", row: menu.row, col: menu.col })}
            onAction={act}
          />
        </>
      )}
    </div>
  );
}

function CellMenu({
  x,
  y,
  button,
  onAdd,
  onAction,
}: {
  x: number;
  y: number;
  button: GridButton | null;
  onAdd: () => void;
  onAction: (action: CellAction) => void;
}) {
  return (
    <div
      // Clamped into the window so a right-click near the right edge does not
      // open a menu the operator cannot reach.
      style={{ left: Math.min(x, window.innerWidth - 190), top: Math.min(y, window.innerHeight - 200) }}
      className="fixed z-50 w-44 overflow-hidden rounded-xl border border-line bg-white py-1 shadow-lg"
      role="menu"
    >
      {!button && (
        <MenuItem label="Add button" onClick={onAdd} />
      )}
      {button && (
        <>
          {button.kind === "category" && <MenuItem label="Open" onClick={() => onAction({ kind: "open", button })} />}
          <MenuItem label="Edit" onClick={() => onAction({ kind: "edit", button })} />
          <MenuItem label="Move" onClick={() => onAction({ kind: "move", button })} />
          <MenuItem label="Remove" danger onClick={() => onAction({ kind: "remove", button })} />
        </>
      )}
    </div>
  );
}

function MenuItem({ label, danger = false, onClick }: { label: string; danger?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        "block w-full px-3 py-2 text-left text-sm font-semibold hover:bg-slate-50",
        danger ? "text-red-700" : "text-ink",
      )}
    >
      {label}
    </button>
  );
}

/** A small legend, so the two gestures are discoverable without a manual. */
export function DesignerHint({ moving, onCancelMove }: { moving: boolean; onCancelMove: () => void }) {
  if (moving) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-lg bg-brand-soft px-3 py-2 text-xs font-bold text-brand-dark">
        Choose where this button should go.
        <Button size="sm" variant="ghost" onClick={onCancelMove}>
          Cancel move
        </Button>
      </div>
    );
  }
  return (
    <p className="text-[11px] text-sub">
      Click an empty square to add a button. Right-click anything for Edit, Move and Remove. Click a category to open
      its page.
    </p>
  );
}
