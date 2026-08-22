// THE cashier grid. One renderer for every layout, and for the preview.
//
// WHY ONE. The brief that produced this file asked for a Settings preview that
// matches the till. The only way to guarantee that is for the preview and the
// till to BE the same component with the same sizing engine - anything else is
// two implementations that agree on the day they are written. So this component
// takes a rectangle and a list of buttons, and both callers hand it those.
//
// IT DOES NOT SCROLL. The sizing engine (`autofit.ts`) chooses a grid that fits
// the rectangle it was measured into. When every button genuinely cannot fit at
// a usable size it PAGES - Previous / Next - because a cashier must never have
// to scroll to reach an item mid-order, and must never be given a key too small
// to hit. Paging never engages while everything fits.
//
// IT ADDS NO ORDERING LOGIC. `onPick` is the workspace's own handler. This
// component decides which button was pressed and nothing else - no cart, no
// modifiers, no claim, no shift, no payment, no printing.

import { useEffect, useMemo, useRef, useState } from "react";
import { Button, cn } from "@/components/ui";
import { useElementSize } from "@/lib/useElementSize";
import { type CurrencyCode } from "@/lib/currency";
import { planLayout, pageSlice, type AutoFitPlan } from "@/lib/pos/grid/autofit";
import { MIN_CELL_HEIGHT, MIN_CELL_WIDTH } from "@/lib/pos/grid/fit";
import { GridButtonTile } from "@/components/pos/grid/GridButtonTile";
import type { GridButton } from "@/lib/pos/grid/model";

/**
 * Height reserved for the pager, only when paging actually engages.
 *
 * Comfortably above the 44px touch minimum its buttons honour - a bar sized to
 * exactly its content leaves the controls touching the grid above them.
 */
export const PAGER_HEIGHT = 52;

export type PosLayoutGridProps = {
  buttons: GridButton[];
  currency: CurrencyCode;
  autoFit: boolean;
  /** Honoured only when `autoFit` is false. */
  columns: number;
  rows: number;
  /** Price per button id. Resolved by the caller from the canonical menu. */
  priceFor: (button: GridButton) => number | null;
  /** Why a button cannot be pressed, if it cannot. */
  unavailableFor?: (button: GridButton) => string | null;
  needsChoiceFor?: (button: GridButton) => boolean;
  hasOptionsFor?: (button: GridButton) => boolean;
  inOrderQuantityFor?: (button: GridButton) => number | null;
  onPick: (button: GridButton) => void;
  onContextMenu?: (button: GridButton, event: React.MouseEvent) => void;
  /** Right-click on empty space, for the designer. */
  onContextMenuEmpty?: (event: React.MouseEvent) => void;
  /**
   * Explicit placement, for the customized grid whose buttons carry row/col.
   * The canonical layouts flow in reading order instead.
   */
  placed?: boolean;
  /** Rendered in place of an empty grid. */
  empty?: React.ReactNode;
};

export function PosLayoutGrid(props: PosLayoutGridProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const { width, height } = useElementSize(boxRef);
  const [page, setPage] = useState(0);

  // "Not measured yet" is not the same answer as "too small": an unmeasured box
  // is 0x0 and fails every size test, so judging it would flash a "too small"
  // notice on every open. `useElementSize` reads the box before paint; this is
  // the second half of that guard.
  const measured = width > 0 && height > 0;

  const plan: AutoFitPlan = useMemo(
    () =>
      planLayout({
        availableWidth: width,
        availableHeight: height,
        buttonCount: props.buttons.length,
        autoFit: props.autoFit,
        columns: props.columns,
        rows: props.rows,
      }),
    [width, height, props.buttons.length, props.autoFit, props.columns, props.rows],
  );

  // A page that no longer exists - the operator opened a smaller category, or
  // the window grew and the grid now holds everything - snaps back rather than
  // rendering an empty screen the cashier has to page out of.
  useEffect(() => {
    if (page > plan.pages - 1) setPage(0);
  }, [page, plan.pages]);

  const visible = useMemo(() => pageSlice(props.buttons, plan, page), [props.buttons, plan, page]);
  const unusable = measured && plan.metrics.cellWidth < MIN_CELL_WIDTH && props.buttons.length > 0;

  // The wrapper and the measured box are rendered IDENTICALLY in every state,
  // including before the first measurement. An early return with a differently
  // nested box would measure one rectangle and lay out inside another.
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={boxRef} className="min-h-0 flex-1" onContextMenu={props.onContextMenuEmpty}>
        {!measured ? (
          <div className="h-full" aria-hidden />
        ) : props.buttons.length === 0 ? (
          <div className="flex h-full items-center justify-center p-4">{props.empty}</div>
        ) : unusable ? (
          /* Deliberately a notice, not a scrollbar and not unusable keys. */
          <div className="flex h-full items-center justify-center p-4">
            <div className="max-w-sm text-center">
              <p className="text-sm font-extrabold text-ink">This screen is too small for the POS grid</p>
              <p className="mt-1 text-xs text-sub">
                A usable button needs about {MIN_CELL_WIDTH}×{MIN_CELL_HEIGHT} pixels. Make the window larger or lower
                the display scaling.
              </p>
            </div>
          </div>
        ) : (
          <div
            className="grid h-full w-full"
            style={{
              gridTemplateColumns: `repeat(${plan.columns}, ${plan.metrics.cellWidth}px)`,
              gridTemplateRows: `repeat(${plan.rows}, ${plan.metrics.cellHeight}px)`,
              gap: plan.metrics.gap,
              alignContent: "start",
              justifyContent: "start",
            }}
          >
            {visible.map((button) => (
              <GridButtonTile
                key={button.id}
                button={button}
                metrics={plan.metrics}
                price={props.priceFor(button)}
                currency={props.currency}
                placed={props.placed ?? false}
                unavailableReason={props.unavailableFor?.(button) ?? null}
                needsChoice={props.needsChoiceFor?.(button) ?? false}
                hasOptions={props.hasOptionsFor?.(button) ?? false}
                inOrderQuantity={props.inOrderQuantityFor?.(button) ?? null}
                onClick={() => props.onPick(button)}
                onContextMenu={props.onContextMenu ? (e) => props.onContextMenu!(button, e) : undefined}
              />
            ))}
          </div>
        )}
      </div>

      {/* The fallback, and only when it is mathematically necessary. */}
      {plan.paged && plan.pages > 1 && !unusable && (
        <div style={{ height: PAGER_HEIGHT }} className="flex shrink-0 items-center justify-center gap-2">
          {/* `md`, not `sm`: Previous/Next are operational controls a cashier
              taps mid-order, so they honour the 44px touch minimum like every
              other POS control. */}
          <Button size="md" variant="ghost" disabled={page <= 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
            ‹ Previous
          </Button>
          <span className="min-w-[86px] text-center text-xs font-bold tabular-nums text-sub">
            Page {page + 1} of {plan.pages}
          </span>
          <Button
            size="md"
            variant="ghost"
            disabled={page >= plan.pages - 1}
            onClick={() => setPage((p) => Math.min(plan.pages - 1, p + 1))}
          >
            Next ›
          </Button>
        </div>
      )}
    </div>
  );
}

/** The measured plan, for a caller that needs it (the preview's caption). */
export function useLayoutPlan(input: {
  width: number;
  height: number;
  buttonCount: number;
  autoFit: boolean;
  columns: number;
  rows: number;
}): AutoFitPlan {
  return useMemo(
    () =>
      planLayout({
        availableWidth: input.width,
        availableHeight: input.height,
        buttonCount: input.buttonCount,
        autoFit: input.autoFit,
        columns: input.columns,
        rows: input.rows,
      }),
    [input.width, input.height, input.buttonCount, input.autoFit, input.columns, input.rows],
  );
}

/** Shared empty-state copy, so every layout says the same thing. */
export function GridEmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <div className={cn("max-w-sm text-center")}>
      <p className="text-sm font-extrabold text-ink">{title}</p>
      <p className="mt-1 text-xs text-sub">{hint}</p>
    </div>
  );
}
