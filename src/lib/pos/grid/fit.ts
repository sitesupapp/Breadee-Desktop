// Making a customized grid FIT, on whatever screen it is opened on.
//
// THE REQUIREMENT IS "NO SCROLLING", AND THAT IS A HARD ONE. A cashier mid-queue
// must be able to see every operational control without moving anything. So the
// customized cashier workspace never scrolls: the grid is measured against the
// space actually available and its cells, gaps, type and icons are computed to
// fill it. The alternative - a fixed cell size and a scrollbar when it does not
// fit - is the failure this replaces.
//
// MEASURED, NOT ASSUMED. Every number below comes from the real window, exactly
// as `lib/layout.ts` already does for the default POS and for the same reason:
// Windows display scaling changes the CSS viewport, so a 1366x768 panel at 150%
// reports ~911 CSS px. A design tuned to 1920x1080 would be laid out for a screen
// most tills do not have.
//
// AND WHEN IT CANNOT FIT, IT SAYS SO. There is a floor below which a button is
// not a usable touch target, and shrinking past it would produce a technically
// scroll-free screen that nobody can hit. `fitGrid` reports `too_small` instead,
// the designer refuses to save a configuration that cannot fit its target
// screens, and the live workspace falls back to the default grid rather than
// drawing something broken.

/**
 * The smallest a cell may be and still be pressed reliably.
 *
 * The height floor IS the POS touch minimum - the same 44px `TOUCH_TARGET_PX` in
 * `components/ui.tsx` that every other control on the till honours. It is
 * restated here as a literal rather than imported, because this module is pure
 * arithmetic and importing a value from a `.tsx` would drag the component layer
 * into it (and out of reach of the test runner, which loads `.ts` only). The two
 * numbers are pinned to each other by `pos-custom-grid.test.ts`, which reads
 * both files, so they cannot drift apart silently.
 *
 * The width floor is larger because a cell also has to hold a name and a price
 * side by side; below this the price wraps under the name and the button stops
 * being readable at arm's length.
 */
export const MIN_CELL_HEIGHT = 44;
export const MIN_CELL_WIDTH = 88;

/** Gap bounds. Tight enough to be dense, wide enough not to mis-tap. */
export const MIN_GAP = 4;
export const MAX_GAP = 12;

export type GridMetrics = {
  /** Cell size for a 1x1 button, in CSS pixels. */
  cellWidth: number;
  cellHeight: number;
  gap: number;
  /** Type and icon sizes, derived from the cell so a small grid stays legible. */
  labelFontPx: number;
  priceFontPx: number;
  iconPx: number;
  /** Corner radius, so a small cell does not look like a lozenge. */
  radiusPx: number;
  /** Padding inside a cell. */
  padPx: number;
};

export type GridFit =
  | { kind: "fits"; metrics: GridMetrics }
  /** Usable size cannot be reached; `metrics` is what it WOULD have been. */
  | { kind: "too_small"; metrics: GridMetrics; needWidth: number; needHeight: number };

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/**
 * The space a grid of this shape would get, and what it would look like.
 *
 * Pure arithmetic on four numbers, so every claim this feature makes about
 * fitting on a 12-inch panel is a unit test rather than a screenshot.
 */
export function fitGrid(input: {
  availableWidth: number;
  availableHeight: number;
  columns: number;
  rows: number;
}): GridFit {
  const columns = Math.max(1, Math.trunc(input.columns));
  const rows = Math.max(1, Math.trunc(input.rows));
  const width = Number.isFinite(input.availableWidth) ? Math.max(0, input.availableWidth) : 0;
  const height = Number.isFinite(input.availableHeight) ? Math.max(0, input.availableHeight) : 0;

  // The gap scales with the smaller dimension: a dense 10-column grid on a small
  // panel gets tight gaps, a 3-column grid on a large one gets generous ones.
  const gap = Math.round(clamp(Math.min(width, height) / 90, MIN_GAP, MAX_GAP));

  const cellWidth = Math.floor((width - gap * (columns - 1)) / columns);
  const cellHeight = Math.floor((height - gap * (rows - 1)) / rows);

  // Type is derived from the cell rather than fixed, which is what lets one
  // configuration be legible on a 14-inch panel and on a 27-inch monitor. Both
  // ends are clamped: unbounded growth on a large screen looks like a toy, and
  // unbounded shrinking is unreadable.
  const shortest = Math.max(0, Math.min(cellWidth, cellHeight));
  const metrics: GridMetrics = {
    cellWidth,
    cellHeight,
    gap,
    labelFontPx: Math.round(clamp(cellHeight * 0.2, 11, 22)),
    priceFontPx: Math.round(clamp(cellHeight * 0.17, 10, 18)),
    iconPx: Math.round(clamp(shortest * 0.3, 14, 36)),
    radiusPx: Math.round(clamp(shortest * 0.14, 6, 16)),
    padPx: Math.round(clamp(shortest * 0.1, 4, 12)),
  };

  if (cellWidth < MIN_CELL_WIDTH || cellHeight < MIN_CELL_HEIGHT) {
    return {
      kind: "too_small",
      metrics,
      needWidth: MIN_CELL_WIDTH * columns + gap * (columns - 1),
      needHeight: MIN_CELL_HEIGHT * rows + gap * (rows - 1),
    };
  }
  return { kind: "fits", metrics };
}

/**
 * The pixel size of a button that spans more than one cell.
 *
 * A 2-wide button is two cells PLUS the gap between them, not two cell widths -
 * getting that wrong is a one-gap drift per span that accumulates across a row
 * and pushes the last column off the edge.
 */
export function spanSize(metrics: GridMetrics, width: number, height: number): { width: number; height: number } {
  return {
    width: metrics.cellWidth * width + metrics.gap * (width - 1),
    height: metrics.cellHeight * height + metrics.gap * (height - 1),
  };
}

// -------------------------------------------------- the workspace envelope --

/**
 * Chrome the cashier workspace spends before the grid gets any space.
 *
 * These are MEASURED at runtime by the component (it reads its own box), and
 * these constants are only the estimate the DESIGNER uses to predict a screen it
 * is not currently running on. They are deliberately generous: predicting more
 * chrome than exists means the designer warns slightly early, which costs an
 * operator one column; predicting less would let them save a layout that does
 * not fit the till it was made for.
 */
export const CHROME_ESTIMATE = {
  /** POS status bar. */
  statusBarPx: 64,
  /** Footer bar. */
  footerPx: 36,
  /** The workspace's own padding, top and bottom. */
  workPaddingPx: 24,
  /** The category breadcrumb / Back+Main bar above the grid. */
  gridHeaderPx: 52,
  /** Collapsed navigation rail. */
  railPx: 76,
  /** The Current Order column. */
  orderPanelPx: 360,
} as const;

/** The box a grid gets on a window of this size, as the designer predicts it. */
export function predictWorkspaceBox(input: { windowWidth: number; windowHeight: number }): {
  width: number;
  height: number;
} {
  return {
    width: Math.max(0, input.windowWidth - CHROME_ESTIMATE.railPx - CHROME_ESTIMATE.orderPanelPx - CHROME_ESTIMATE.workPaddingPx),
    height: Math.max(
      0,
      input.windowHeight -
        CHROME_ESTIMATE.statusBarPx -
        CHROME_ESTIMATE.footerPx -
        CHROME_ESTIMATE.workPaddingPx -
        CHROME_ESTIMATE.gridHeaderPx,
    ),
  };
}

/**
 * The screens a layout is checked against before it may be saved.
 *
 * Four real classes of till, not one developer monitor. The smallest is the one
 * that matters: a configuration that fits `compact` fits everything above it,
 * and a configuration that does not is one somebody will discover at a counter.
 */
export const TARGET_PROFILES = [
  { key: "compact", label: "12–14\" laptop (1280×720)", width: 1280, height: 720 },
  { key: "laptop", label: "Common laptop (1366×768)", width: 1366, height: 768 },
  { key: "desktop", label: "17\" desktop (1600×900)", width: 1600, height: 900 },
  { key: "large", label: "Large desktop (1920×1080)", width: 1920, height: 1080 },
] as const;

export type TargetProfile = (typeof TARGET_PROFILES)[number];

export type ProfileFit = { profile: TargetProfile; fit: GridFit };

/** How a grid of this shape would fare on each target screen. */
export function fitAcrossProfiles(input: { columns: number; rows: number }): ProfileFit[] {
  return TARGET_PROFILES.map((profile) => {
    const box = predictWorkspaceBox({ windowWidth: profile.width, windowHeight: profile.height });
    return {
      profile,
      fit: fitGrid({ availableWidth: box.width, availableHeight: box.height, columns: input.columns, rows: input.rows }),
    };
  });
}

/**
 * The largest grid that fits every target profile.
 *
 * Offered as the designer's suggestion, so an operator who wants "as many
 * buttons as possible" gets a number that is actually safe rather than one they
 * have to find by trial.
 */
export function largestSafeGrid(): { columns: number; rows: number } {
  let best = { columns: 2, rows: 2 };
  for (let columns = 2; columns <= 10; columns += 1) {
    for (let rows = 2; rows <= 8; rows += 1) {
      const fits = fitAcrossProfiles({ columns, rows }).every((p) => p.fit.kind === "fits");
      if (fits && columns * rows >= best.columns * best.rows) best = { columns, rows };
    }
  }
  return best;
}

/** Does this shape fit every target screen? What the designer gates saving on. */
export function fitsEveryProfile(input: { columns: number; rows: number }): boolean {
  return fitAcrossProfiles(input).every((p) => p.fit.kind === "fits");
}

/** The profiles a shape does NOT fit, for the warning the designer shows. */
export function failingProfiles(input: { columns: number; rows: number }): TargetProfile[] {
  return fitAcrossProfiles(input)
    .filter((p) => p.fit.kind !== "fits")
    .map((p) => p.profile);
}
