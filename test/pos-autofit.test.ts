// The auto-fit sizing engine.
//
// ONE ENGINE, THREE LAYOUTS. Default, Categories and Customized all ask
// `planLayout` the same question, so these tests are the specification for all
// three rather than for one of them.
//
// THE TWO FAILURES IT EXISTS TO PREVENT, and they pull in opposite directions:
//
//   ten buttons marooned in a field of empty screen, and
//   a hundred buttons the cashier has to scroll through.
//
// A test suite that only checked "does it fit" would pass a build that solved
// the second by making every key tiny and the first by leaving the screen empty.
// So the assertions below bound the result from BOTH sides - coverage and size -
// and the paging fallback is asserted to engage only when it is forced.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_AUTOFIT_COLUMNS,
  MAX_CELL_HEIGHT,
  MAX_CELL_WIDTH,
  pageSlice,
  planAutoFit,
  planLayout,
  planManual,
} from "@/lib/pos/grid/autofit";
import { MIN_CELL_HEIGHT, MIN_CELL_WIDTH } from "@/lib/pos/grid/fit";

/** The POS work area on a real screen class, with the order column removed. */
const SCREENS = {
  compact: { width: 1280 - 76 - 340, height: 720 - 64 - 36 - 52 },
  laptop: { width: 1366 - 76 - 360, height: 768 - 64 - 36 - 52 },
  desktop: { width: 1600 - 76 - 380, height: 900 - 64 - 36 - 52 },
  large: { width: 1920 - 76 - 420, height: 1080 - 64 - 36 - 52 },
  /** 1366x768 at 150% Windows scaling reports about this. */
  scaled: { width: 911 - 76 - 340, height: 512 - 64 - 36 - 52 },
} as const;

function fit(screen: { width: number; height: number }, buttonCount: number) {
  return planAutoFit({ availableWidth: screen.width, availableHeight: screen.height, buttonCount });
}

// --- it fits, everywhere ------------------------------------------------------

test("every screen class fits a realistic menu on ONE page", () => {
  for (const [name, screen] of Object.entries(SCREENS)) {
    if (name === "scaled") continue; // covered separately below
    for (const count of [6, 12, 24, 40]) {
      const plan = fit(screen, count);
      assert.equal(plan.paged, false, `${name} should not page ${count} buttons`);
      assert.ok(plan.columns * plan.rows >= count, `${name} must hold all ${count}`);
    }
  }
});

test("the grid never exceeds the rectangle it was given", () => {
  for (const [name, screen] of Object.entries(SCREENS)) {
    for (const count of [1, 7, 30, 100]) {
      const plan = fit(screen, count);
      const usedWidth = plan.metrics.cellWidth * plan.columns + plan.metrics.gap * (plan.columns - 1);
      const usedHeight = plan.metrics.cellHeight * plan.rows + plan.metrics.gap * (plan.rows - 1);
      assert.ok(usedWidth <= screen.width + 1, `${name}/${count} overflows horizontally`);
      assert.ok(usedHeight <= screen.height + 1, `${name}/${count} overflows vertically`);
    }
  }
});

test("a key is never smaller than a usable touch target", () => {
  for (const [name, screen] of Object.entries(SCREENS)) {
    for (const count of [1, 12, 50, 100]) {
      const plan = fit(screen, count);
      assert.ok(plan.metrics.cellWidth >= MIN_CELL_WIDTH, `${name}/${count} key too narrow`);
      assert.ok(plan.metrics.cellHeight >= MIN_CELL_HEIGHT, `${name}/${count} key too short`);
    }
  }
});

// --- the two directions that actually happen ---------------------------------

test("TEN buttons on a big screen are not left tiny in empty space", () => {
  const plan = fit(SCREENS.large, 10);
  // The property is that they GREW to the maximum a key is allowed to be -
  // not that they filled every pixel. Coverage cannot reach 1 here by design:
  // `MAX_CELL_*` deliberately stops a key becoming a poster, and the remainder
  // is margin around the grid rather than dead space inside the buttons.
  assert.equal(plan.metrics.cellWidth, MAX_CELL_WIDTH, "ten keys should grow to the cap");
  assert.equal(plan.metrics.cellHeight, MAX_CELL_HEIGHT);
  // And they are dramatically larger than the same ten would be on a small
  // panel, which is the comparison that actually matters to a cashier.
  const cramped = fit(SCREENS.scaled, 10);
  assert.ok(
    plan.metrics.cellWidth > cramped.metrics.cellWidth,
    "a big screen must produce bigger keys than a small one",
  );
  // Deliberately NOT a coverage assertion. Ten capped keys cannot fill a
  // 1424x928 rectangle, and demanding that they do is what would drive the
  // engine back toward poster-sized buttons. The leftover is margin, and margin
  // around a grid of comfortable keys is the correct look - so the property
  // asserted is the key SIZE, not the proportion of screen consumed.
  assert.ok(plan.columns <= 10 && plan.rows <= 8);
  assert.ok(plan.columns * plan.rows >= 10, "and all ten are on one page");
});

test("but they are not blown up into posters either", () => {
  const plan = fit(SCREENS.large, 4);
  assert.ok(plan.metrics.cellWidth <= MAX_CELL_WIDTH, "a key stops growing at the cap");
  assert.ok(plan.metrics.cellHeight <= MAX_CELL_HEIGHT, "a key stops growing at the cap");
});

test("A HUNDRED buttons get denser rather than taller", () => {
  const ten = fit(SCREENS.laptop, 10);
  const hundred = fit(SCREENS.laptop, 100);
  assert.ok(hundred.columns >= ten.columns, "more buttons means at least as many columns");
  assert.ok(
    hundred.metrics.cellWidth <= ten.metrics.cellWidth,
    "a hundred keys must not be as large as ten",
  );
  assert.ok(hundred.metrics.cellWidth >= MIN_CELL_WIDTH, "but still pressable");
});

test("density grows monotonically with the button count", () => {
  let previous = Infinity;
  for (const count of [4, 10, 20, 40, 80]) {
    const plan = fit(SCREENS.desktop, count);
    assert.ok(plan.metrics.cellWidth <= previous + 1, `${count} keys got bigger than fewer keys`);
    previous = plan.metrics.cellWidth;
  }
});

// --- paging is the last resort ------------------------------------------------

test("paging does NOT engage while everything fits", () => {
  for (const count of [1, 5, 12, 24]) {
    assert.equal(fit(SCREENS.desktop, count).paged, false, `${count} buttons must not page`);
    assert.equal(fit(SCREENS.desktop, count).pages, 1);
  }
});

test("once paging is forced, the grid gets AS DENSE AS IT CAN", () => {
  // THE REGRESSION THIS PINS. Ranking paged candidates by coverage looked
  // reasonable and was wrong: the min/max cell bounds squeeze coverage into a
  // narrow band, so the shape term decided - and shape prefers the SPARSEST
  // grid. A hundred buttons came out 4x3 across nine pages, which is the exact
  // opposite of what the requirement asks for. Once a cashier must page, the
  // thing to minimise is the number of pages.
  const screen = { width: 916, height: 611 };
  const dense = planAutoFit({ availableWidth: screen.width, availableHeight: screen.height, buttonCount: 100 });
  assert.ok(dense.perPage >= 60, `only ${dense.perPage} buttons per page`);
  assert.ok(dense.pages <= 3, `${dense.pages} pages for 100 buttons is too many`);
  assert.ok(dense.metrics.cellWidth >= MIN_CELL_WIDTH, "and every key is still pressable");
  // A sparser grid must never be preferred to a denser one that also fits.
  const sparse = planAutoFit({ availableWidth: screen.width, availableHeight: screen.height, buttonCount: 20 });
  assert.ok(dense.perPage > sparse.perPage, "more buttons must produce a denser grid");
});

test("a large menu that CAN fit on one page is not paged", () => {
  // 60 buttons fit a full-size work area at a usable key size, so paging must
  // not engage - the pager is a fallback, not a layout style.
  const plan = planAutoFit({ availableWidth: 916, availableHeight: 611, buttonCount: 60 });
  assert.equal(plan.paged, false, "60 buttons should fit one page here");
  assert.equal(plan.pages, 1);
});

test("paging engages only when the buttons cannot fit at a usable size", () => {
  // Far more buttons than a small panel can hold without shrinking past the
  // touch minimum. The engine must page rather than shrink or scroll.
  const plan = fit(SCREENS.scaled, 200);
  assert.equal(plan.paged, true, "200 buttons on a scaled-down panel must page");
  assert.ok(plan.pages > 1);
  assert.ok(plan.metrics.cellWidth >= MIN_CELL_WIDTH, "keys stay full size when paging");
  assert.ok(plan.metrics.cellHeight >= MIN_CELL_HEIGHT);
});

test("paging covers every button exactly once, in order", () => {
  const buttons = Array.from({ length: 47 }, (_, i) => i);
  const plan = fit(SCREENS.scaled, buttons.length);
  if (!plan.paged) return; // fits on one page here; nothing to slice
  const seen: number[] = [];
  for (let page = 0; page < plan.pages; page += 1) seen.push(...pageSlice(buttons, plan, page));
  assert.deepEqual(seen, buttons, "paging must not drop or repeat a button");
});

test("an unpaged plan returns every button for page 0", () => {
  const buttons = [1, 2, 3];
  const plan = fit(SCREENS.desktop, 3);
  assert.deepEqual(pageSlice(buttons, plan, 0), buttons);
});

test("a rectangle too small for even one key is reported, not drawn", () => {
  const plan = planAutoFit({ availableWidth: 40, availableHeight: 30, buttonCount: 12 });
  assert.ok(plan.metrics.cellWidth < MIN_CELL_WIDTH, "it reports the unusable size rather than faking one");
});

// --- the shape of a key -------------------------------------------------------

test("a sparse grid does not produce mostly-empty keys", () => {
  // The content of a key is roughly a name plus a price - about 60px. A cap far
  // above that leaves a button that is mostly nothing, which is the complaint
  // this bound exists to answer.
  assert.ok(MAX_CELL_HEIGHT <= 160, "a key capped much taller than its content looks empty");
  const plan = fit(SCREENS.large, 6);
  assert.ok(plan.metrics.cellHeight <= MAX_CELL_HEIGHT);
  // And the type grows with the key rather than staying small inside it.
  assert.ok(plan.metrics.labelFontPx >= 18, `big keys should carry big type, got ${plan.metrics.labelFontPx}px`);
});

test("keys are not letterboxed, even though coverage alone would allow it", () => {
  // Maximising coverage on its own produces absurd aspect ratios; the shape term
  // in the score is what stops that.
  for (const [name, screen] of Object.entries(SCREENS)) {
    for (const count of [8, 18, 35]) {
      const plan = fit(screen, count);
      const aspect = plan.metrics.cellWidth / plan.metrics.cellHeight;
      assert.ok(aspect > 0.7 && aspect < 3.2, `${name}/${count} produced a ${aspect.toFixed(2)}:1 key`);
    }
  }
});

test("type and icons scale with the key, within readable bounds", () => {
  const small = fit(SCREENS.scaled, 40);
  const large = fit(SCREENS.large, 8);
  assert.ok(large.metrics.labelFontPx >= small.metrics.labelFontPx, "a bigger key gets bigger type");
  for (const plan of [small, large]) {
    assert.ok(plan.metrics.labelFontPx >= 11 && plan.metrics.labelFontPx <= 24);
    assert.ok(plan.metrics.priceFontPx >= 10 && plan.metrics.priceFontPx <= 20);
    assert.ok(plan.metrics.iconPx >= 14 && plan.metrics.iconPx <= 32);
  }
});

test("the column count is bounded, so a wide screen does not become a spreadsheet", () => {
  const plan = fit({ width: 4000, height: 1200 }, 200);
  assert.ok(plan.columns <= MAX_AUTOFIT_COLUMNS);
});

// --- the Current Order side is part of the rectangle -------------------------

test("moving the order column changes the grid, because it changes the space", () => {
  // Same screen, different space available - the engine must see that.
  const withPanel = planAutoFit({ availableWidth: 900, availableHeight: 600, buttonCount: 20 });
  const withoutPanel = planAutoFit({ availableWidth: 1260, availableHeight: 600, buttonCount: 20 });
  assert.ok(
    withoutPanel.metrics.cellWidth > withPanel.metrics.cellWidth,
    "a wider work area produces wider keys",
  );
});

// --- Auto-fit OFF -------------------------------------------------------------

test("with Auto-fit OFF the operator's columns and rows are used EXACTLY", () => {
  const plan = planManual({ availableWidth: 1000, availableHeight: 700, columns: 3, rows: 2, buttonCount: 6 });
  assert.equal(plan.columns, 3, "a manual grid is not re-planned");
  assert.equal(plan.rows, 2);
  assert.equal(plan.perPage, 6);
  assert.equal(plan.paged, false);
});

test("a manual grid holding fewer keys than there are buttons pages rather than hiding them", () => {
  const plan = planManual({ availableWidth: 1000, availableHeight: 700, columns: 2, rows: 2, buttonCount: 9 });
  assert.equal(plan.paged, true);
  assert.equal(plan.pages, 3);
});

test("`planLayout` routes to the right engine and nothing else", () => {
  const auto = planLayout({ availableWidth: 1000, availableHeight: 700, buttonCount: 30, autoFit: true, columns: 2, rows: 2 });
  const manual = planLayout({ availableWidth: 1000, availableHeight: 700, buttonCount: 30, autoFit: false, columns: 2, rows: 2 });
  // Auto-fit ignores the stored 2x2 and chooses for itself...
  assert.ok(auto.columns * auto.rows > 4, "auto-fit must not be limited by the stored grid");
  // ...and manual honours it exactly.
  assert.equal(manual.columns, 2);
  assert.equal(manual.rows, 2);
});

test("degenerate input never throws and never produces NaN", () => {
  for (const input of [
    { availableWidth: 0, availableHeight: 0, buttonCount: 0 },
    { availableWidth: -100, availableHeight: -100, buttonCount: 5 },
    { availableWidth: Number.NaN, availableHeight: 600, buttonCount: 5 },
    { availableWidth: 900, availableHeight: Number.POSITIVE_INFINITY, buttonCount: 5 },
  ]) {
    const plan = planAutoFit(input);
    assert.ok(Number.isFinite(plan.metrics.cellWidth), `NaN width from ${JSON.stringify(input)}`);
    assert.ok(Number.isFinite(plan.metrics.cellHeight));
    assert.ok(plan.columns >= 1 && plan.rows >= 1);
    assert.ok(plan.pages >= 1);
  }
});

test("the plan is deterministic - the same rectangle gives the same grid", () => {
  const once = fit(SCREENS.laptop, 33);
  const twice = fit(SCREENS.laptop, 33);
  assert.deepEqual(once, twice, "two identical screens must lay out identically");
});
