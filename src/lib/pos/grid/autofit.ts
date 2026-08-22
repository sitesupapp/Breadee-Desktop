// ONE sizing engine, for all three cashier layouts.
//
// THE PROBLEM IT SOLVES, IN THE TWO DIRECTIONS THAT ACTUALLY HAPPEN.
//
//   Ten buttons on a 24-inch till. A fixed cell size leaves ten small keys
//   marooned in a field of empty screen. The keys should GROW.
//
//   A hundred buttons on a 14-inch laptop. A fixed cell size means the cashier
//   scrolls through several screens to find a drink. The grid should get
//   DENSER, up to the point where a key stops being reliably pressable.
//
// Both are the same question - "what is the best use of this rectangle for this
// many buttons?" - so there is one answer to it here, and Default, Categories
// and Customized all ask it.
//
// THE SEARCH IS EXHAUSTIVE AND TINY. Columns run 1..MAX_COLUMNS; for each, the
// rows needed follow from the button count, and the resulting cell is scored.
// That is at most a few dozen candidates of pure arithmetic - cheaper than the
// single layout pass that would otherwise be needed to measure one guess, and
// it means the result is the best option rather than the first acceptable one.
//
// PAGING IS THE LAST RESORT AND IT IS DETERMINISTIC. Scrolling is refused
// outright: a cashier must not have to scroll to reach an item mid-order. If
// every button cannot fit at the minimum usable size, the grid pages - which
// keeps every key full-size and reachable in one press of Next. Paging never
// engages while everything fits.

import { MIN_CELL_HEIGHT, MIN_CELL_WIDTH, MAX_GAP, MIN_GAP, type GridMetrics } from "@/lib/pos/grid/fit";

/**
 * The largest a key should ever be drawn.
 *
 * A button is a target, not a poster. Past this it stops reading as a control,
 * and on a large screen a handful of enormous keys is harder to scan than a
 * comfortable grid with breathing room around it.
 */
export const MAX_CELL_WIDTH = 260;
/**
 * Lower than the width cap on purpose, and lower than it first was.
 *
 * A key's content is a name and a price - about 50-60px of it. Measured against
 * a 190px cap, a sparse grid produced buttons that were 70% empty: not the
 * "name at the top, price at the bottom" split this design already fixed, but
 * still a lot of nothing around a little something. Capping height sooner keeps
 * a big key looking like a button rather than a panel, and the leftover space
 * becomes margin between keys, which is what makes a grid scannable.
 */
export const MAX_CELL_HEIGHT = 150;

/** The shape a key looks best at - width:height. Matches the 1.0.6 grid. */
export const PREFERRED_ASPECT = 1.32;

export const MAX_AUTOFIT_COLUMNS = 10;
export const MAX_AUTOFIT_ROWS = 8;

export type AutoFitPlan = {
  columns: number;
  rows: number;
  metrics: GridMetrics;
  /** Buttons drawn per page. `columns * rows`. */
  perPage: number;
  /** 1 when everything fits. Greater only when it mathematically cannot. */
  pages: number;
  /** True when the grid had to page rather than fit. */
  paged: boolean;
};

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

function metricsFor(cellWidth: number, cellHeight: number, gap: number): GridMetrics {
  const shortest = Math.max(0, Math.min(cellWidth, cellHeight));
  return {
    cellWidth,
    cellHeight,
    gap,
    // Type is derived from the cell so one configuration stays legible on a
    // 14-inch panel and on a 27-inch monitor. Both ends are clamped: unbounded
    // growth looks like a toy, unbounded shrinking is unreadable.
    // The upper bounds are generous: on a big key the type should grow with it,
    // or the content sits marooned in the middle of a large button.
    labelFontPx: Math.round(clamp(cellHeight * 0.19, 11, 24)),
    priceFontPx: Math.round(clamp(cellHeight * 0.16, 10, 20)),
    iconPx: Math.round(clamp(shortest * 0.26, 14, 32)),
    radiusPx: Math.round(clamp(shortest * 0.12, 6, 14)),
    padPx: Math.round(clamp(shortest * 0.085, 5, 12)),
  };
}

/**
 * The cell height that goes with a width, at the preferred key shape.
 *
 * Deriving one from the other is what keeps every key the same shape whatever
 * the screen, so a cashier's muscle memory survives moving between tills.
 */
function heightFor(cellWidth: number): number {
  return Math.round(clamp(cellWidth / PREFERRED_ASPECT, MIN_CELL_HEIGHT, MAX_CELL_HEIGHT));
}

/** How many columns of this width the rectangle holds. */
function columnsFor(width: number, cellWidth: number, gap: number, buttonCount: number): number {
  const byWidth = Math.floor((width + gap) / (cellWidth + gap));
  // Never more columns than there are buttons - a 7-column grid holding four
  // keys is four keys in a row with three empty cells pretending to be layout.
  return Math.max(0, Math.min(byWidth, buttonCount, MAX_AUTOFIT_COLUMNS));
}

/**
 * Choose the grid for this rectangle and this many buttons.
 *
 * Pure arithmetic on four numbers, so every claim this feature makes about
 * fitting a given screen is a unit test rather than a screenshot.
 */
export function planAutoFit(input: {
  availableWidth: number;
  availableHeight: number;
  buttonCount: number;
}): AutoFitPlan {
  const width = Number.isFinite(input.availableWidth) ? Math.max(0, input.availableWidth) : 0;
  const height = Number.isFinite(input.availableHeight) ? Math.max(0, input.availableHeight) : 0;
  const count = Math.max(1, Math.trunc(input.buttonCount) || 1);
  const gap = Math.round(clamp(Math.min(width, height) / 90, MIN_GAP, MAX_GAP));

  // THE SEARCH IS OVER KEY SIZE, NOT OVER GRIDS.
  //
  // "As large as possible while everything still fits" is the requirement, so
  // that is literally what is searched: walk the key width down from the
  // maximum and take the first size at which every button fits. The first hit
  // is by construction the largest workable key, so no scoring, weighting or
  // tie-breaking is needed - and those were where the earlier version went
  // wrong. Ranking grids by how much of the screen they covered counted EMPTY
  // cells as covered, which chose a 7-column grid for four buttons.
  for (let cellWidth = MAX_CELL_WIDTH; cellWidth >= MIN_CELL_WIDTH; cellWidth -= 1) {
    const columns = columnsFor(width, cellWidth, gap, count);
    if (columns < 1) continue;
    const rows = Math.ceil(count / columns);
    if (rows > MAX_AUTOFIT_ROWS) continue;
    const cellHeight = heightFor(cellWidth);
    if (rows * (cellHeight + gap) - gap > height) continue;
    return {
      columns,
      rows,
      metrics: metricsFor(cellWidth, cellHeight, gap),
      perPage: columns * rows,
      pages: 1,
      paged: false,
    };
  }

  // IT CANNOT FIT. Page it, at the DENSEST grid the rectangle supports, so the
  // cashier presses Next as rarely as possible and every key stays above the
  // usable minimum. The height is used AS MEASURED: the pager is a sibling of
  // the grid box and has already taken its space out of that measurement.
  const columns = Math.max(1, columnsFor(width, MIN_CELL_WIDTH, gap, Math.min(count, MAX_AUTOFIT_COLUMNS)));
  const cellHeight = heightFor(MIN_CELL_WIDTH);
  const rows = Math.max(1, Math.min(MAX_AUTOFIT_ROWS, Math.floor((height + gap) / (cellHeight + gap))));
  const fits = columns * (MIN_CELL_WIDTH + gap) - gap <= width && rows * (cellHeight + gap) - gap <= height;

  if (fits) {
    const perPage = columns * rows;
    return {
      columns,
      rows,
      metrics: metricsFor(MIN_CELL_WIDTH, cellHeight, gap),
      perPage,
      pages: Math.max(1, Math.ceil(count / perPage)),
      paged: count > perPage,
    };
  }

  // The rectangle cannot hold even one usable key. Reported honestly rather
  // than drawn: the caller shows the "screen too small" notice.
  return {
    columns: 1,
    rows: 1,
    metrics: metricsFor(Math.max(0, Math.min(width, MIN_CELL_WIDTH - 1)), Math.max(0, height), gap),
    perPage: 1,
    pages: count,
    paged: true,
  };
}

/** Did the rectangle refuse even one usable key? */
export function isUnusable(plan: AutoFitPlan, buttonCount: number): boolean {
  return plan.columns === 1 && plan.rows === 1 && buttonCount > 1 && plan.metrics.cellWidth < MIN_CELL_WIDTH;
}

/** The slice of buttons on a page, 0-based. */
export function pageSlice<T>(buttons: T[], plan: AutoFitPlan, page: number): T[] {
  if (!plan.paged) return buttons;
  const start = Math.max(0, page) * plan.perPage;
  return buttons.slice(start, start + plan.perPage);
}

// ---------------------------------------------------------- manual sizing ---

/**
 * The grid when Auto-fit is OFF.
 *
 * The operator's stored columns/rows are honoured exactly, and the cell is
 * sized to whatever that leaves. This is the mode for a till that has been set
 * up deliberately and must not be re-arranged by an algorithm - so nothing here
 * second-guesses the numbers it was given.
 */
export function planManual(input: {
  availableWidth: number;
  availableHeight: number;
  columns: number;
  rows: number;
  buttonCount: number;
}): AutoFitPlan {
  const width = Number.isFinite(input.availableWidth) ? Math.max(0, input.availableWidth) : 0;
  const height = Number.isFinite(input.availableHeight) ? Math.max(0, input.availableHeight) : 0;
  const columns = clamp(Math.trunc(input.columns) || 1, 1, MAX_AUTOFIT_COLUMNS);
  const rows = clamp(Math.trunc(input.rows) || 1, 1, MAX_AUTOFIT_ROWS);
  const gap = Math.round(clamp(Math.min(width, height) / 90, MIN_GAP, MAX_GAP));
  const cellWidth = Math.max(0, Math.floor((width - gap * (columns - 1)) / columns));
  const cellHeight = Math.max(0, Math.floor((height - gap * (rows - 1)) / rows));
  const perPage = columns * rows;
  const count = Math.max(1, Math.trunc(input.buttonCount) || 1);
  return {
    columns,
    rows,
    metrics: metricsFor(cellWidth, cellHeight, gap),
    perPage,
    pages: Math.max(1, Math.ceil(count / perPage)),
    // A manual grid pages too when it holds fewer keys than there are buttons -
    // the alternative is hiding products the tenant sells.
    paged: count > perPage,
  };
}

/** The one entry point the renderers call. */
export function planLayout(input: {
  availableWidth: number;
  availableHeight: number;
  buttonCount: number;
  autoFit: boolean;
  columns: number;
  rows: number;
}): AutoFitPlan {
  return input.autoFit
    ? planAutoFit({
        availableWidth: input.availableWidth,
        availableHeight: input.availableHeight,
        buttonCount: input.buttonCount,
      })
    : planManual({
        availableWidth: input.availableWidth,
        availableHeight: input.availableHeight,
        columns: input.columns,
        rows: input.rows,
        buttonCount: input.buttonCount,
      });
}
