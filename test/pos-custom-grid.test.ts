// The customized cashier grid.
//
// FOUR PROPERTIES THESE TESTS EXIST TO PROTECT.
//
// ONE, THE DEFAULT POS IS UNTOUCHED. A terminal that has never opened the
// designer, one whose stored layout cannot be read, and one whose layout came
// from a newer build all resolve to the same thing: Customized OFF. That is what
// makes this feature safe to ship to installations already taking money.
//
// TWO, A SELLABLE BUTTON IS ALWAYS A REAL MENU ITEM. There is no second product
// catalogue, no second price and no way to create one - the model has nowhere to
// put a price, and a button with no canonical item is refused by validation, by
// the editor and by the storage parser.
//
// THREE, IT FITS WITHOUT SCROLLING. The fit arithmetic is checked against real
// screen classes, including the small ones Windows display scaling produces, and
// a configuration that cannot fit is reported rather than shrunk into something
// nobody can press.
//
// FOUR, IT IS READABLE IN LIGHT AND DARK. Every colour a manager can choose is
// walked and its computed ink measured against WCAG AA.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { stripJsxComments } from "./source-helpers.ts";
import {
  DEFAULT_COLUMNS,
  DEFAULT_ROWS,
  GRID_SCHEMA_VERSION,
  MAX_COLUMNS,
  addButton,
  buttonAt,
  canPlace,
  cellsOf,
  countItemButtons,
  emptyLayout,
  findFreeCell,
  freeCells,
  isUsableLayout,
  moveButton,
  newButtonId,
  nextButtonSeed,
  pageOf,
  referencedMenuItemIds,
  removeButton,
  resizeGrid,
  updateButton,
  validateLayout,
  type GridButton,
  type PosGridLayout,
} from "@/lib/pos/grid/model";
import { GRID_KEY_PREFIX, gridStorageKey, parseLayout, readLayout, writeLayout } from "@/lib/pos/grid/storage";
import {
  MIN_CELL_HEIGHT,
  MIN_CELL_WIDTH,
  TARGET_PROFILES,
  failingProfiles,
  fitAcrossProfiles,
  fitGrid,
  fitsEveryProfile,
  largestSafeGrid,
  predictWorkspaceBox,
  spanSize,
} from "@/lib/pos/grid/fit";
import { MIN_BUTTON_CONTRAST, achievedContrast, allCombinations, fillFor, inkFor, resolveColor } from "@/lib/pos/grid/colors";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    read: () => Object.fromEntries(map),
  };
}

function item(over: Partial<GridButton> = {}): GridButton {
  return {
    id: "btn-1",
    kind: "menu_item",
    label: "Pizza",
    menuItemId: "item-pizza",
    iconKey: null,
    color: null,
    row: 1,
    col: 1,
    width: 1,
    height: 1,
    children: [],
    ...over,
  };
}

function category(over: Partial<GridButton> = {}): GridButton {
  return { ...item({ kind: "category", menuItemId: null, label: "Drinks", id: "btn-9" }), ...over };
}

// --- one, the default POS is untouched ---------------------------------------

test("a brand-new layout is switched OFF, which is the default POS", () => {
  const layout = emptyLayout();
  assert.equal(layout.enabled, false);
  assert.equal(layout.buttons.length, 0);
  assert.equal(layout.orderPanel, "right");
  assert.equal(layout.columns, DEFAULT_COLUMNS);
  assert.equal(layout.rows, DEFAULT_ROWS);
});

test("a terminal with no stored layout gets the default POS", () => {
  const store = memoryStorage();
  assert.equal(readLayout({ tenantId: "t1", branchId: "b1" }, store).enabled, false);
});

test("unreadable, malformed and empty storage all resolve to the default POS", () => {
  for (const raw of ["", "   ", "{", "null", "[]", '"a string"', "{}", '{"enabled":true}']) {
    assert.equal(parseLayout(raw).enabled, false, `${JSON.stringify(raw)} must not enable a customized layout`);
  }
});

test("a layout written by a NEWER build falls back rather than half-rendering", () => {
  // A future version may add a button kind, a deeper page or a placement rule
  // this build cannot honour. Drawing the half it understands would put a
  // cashier in front of a grid with items missing from it.
  const future = JSON.stringify({ version: GRID_SCHEMA_VERSION + 1, enabled: true, columns: 4, rows: 4, buttons: [] });
  assert.equal(parseLayout(future).enabled, false);
});

test("layouts are scoped per tenant AND branch, so a till never inherits another's", () => {
  const a = gridStorageKey({ tenantId: "t1", branchId: "b1" });
  const b = gridStorageKey({ tenantId: "t1", branchId: "b2" });
  const c = gridStorageKey({ tenantId: "t2", branchId: "b1" });
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  for (const key of [a, b, c]) assert.ok(key.startsWith(GRID_KEY_PREFIX));
  // An owner session with no branch is its own scope, not "branch not loaded".
  assert.equal(gridStorageKey({ tenantId: "t1", branchId: null }).endsWith(".all"), true);
});

test("a saved layout survives a round trip through storage", () => {
  const store = memoryStorage();
  const layout: PosGridLayout = {
    ...emptyLayout(),
    enabled: true,
    orderPanel: "left",
    columns: 4,
    rows: 3,
    buttons: [item({ color: { hue: "amber", shade: 500 }, iconKey: "burger" })],
  };
  assert.deepEqual(writeLayout({ tenantId: "t", branchId: "b" }, layout, store), { ok: true });
  const back = readLayout({ tenantId: "t", branchId: "b" }, store);
  assert.equal(back.enabled, true);
  assert.equal(back.orderPanel, "left");
  assert.deepEqual(back.buttons[0].color, { hue: "amber", shade: 500 });
  assert.equal(back.buttons[0].iconKey, "burger");
});

test("switching Customized off leaves the buttons alone, so it can be switched back on", () => {
  const store = memoryStorage();
  const scope = { tenantId: "t", branchId: "b" };
  const on: PosGridLayout = { ...emptyLayout(), enabled: true, buttons: [item()] };
  writeLayout(scope, on, store);
  writeLayout(scope, { ...on, enabled: false }, store);
  const back = readLayout(scope, store);
  assert.equal(back.enabled, false);
  assert.equal(back.buttons.length, 1, "turning it off must not destroy the layout");
});

// --- two, a sellable button is always a real menu item -----------------------

test("a menu item button with no canonical item is REFUSED, everywhere", () => {
  // In validation...
  const layout: PosGridLayout = { ...emptyLayout(), buttons: [item({ menuItemId: null })] };
  const problems = validateLayout(layout);
  assert.equal(problems.some((p) => p.code === "unlinked_item"), true);
  assert.equal(isUsableLayout(layout), false);

  // ...in the editor...
  const add = addButton(emptyLayout(), null, item({ menuItemId: null }));
  assert.equal(add.ok, false);

  // ...and at the storage boundary, so it cannot even be loaded.
  const smuggled = JSON.stringify({
    version: GRID_SCHEMA_VERSION,
    enabled: true,
    columns: 4,
    rows: 4,
    buttons: [{ id: "x", kind: "menu_item", label: "Free Pizza", row: 1, col: 1 }],
  });
  assert.equal(parseLayout(smuggled).buttons.length, 0);
});

test("the model has NOWHERE to store a price, a tax rule or a recipe", () => {
  // The strongest available statement: the type itself. A custom button that
  // could hold a price would be a second price, and the two would drift the
  // first time somebody changed one in Menu Builder.
  const source = stripJsxComments(read("src/lib/pos/grid/model.ts"));
  for (const forbidden of ["price", "tax", "recipe", "cost", "vat", "discount"]) {
    assert.equal(
      new RegExp(`\\b${forbidden}\\s*[?:]`, "i").test(source),
      false,
      `a grid button must not carry ${forbidden}`,
    );
  }
});

test("the live grid resolves its price from the canonical item on every render", () => {
  const tile = stripJsxComments(read("src/components/pos/grid/CustomGrid.tsx"));
  assert.match(tile, /resolveMenuPrice/);
  assert.match(tile, /itemsById\.get/);
  // And it hands the workspace's own handler the CANONICAL item, not a copy.
  assert.match(tile, /onPick\(item, price \?\? 0\)/);
});

test("a category's children must reference canonical items too", () => {
  const layout: PosGridLayout = {
    ...emptyLayout(),
    buttons: [category({ children: [item({ id: "btn-2", menuItemId: null, row: 1, col: 1 })] })],
  };
  assert.equal(validateLayout(layout).some((p) => p.code === "unlinked_item"), true);
});

test("a category inside a category is refused - one level, one Back", () => {
  const layout: PosGridLayout = {
    ...emptyLayout(),
    buttons: [category({ children: [category({ id: "btn-2" })] })],
  };
  assert.equal(validateLayout(layout).some((p) => p.code === "nested_category"), true);
  assert.equal(addButton(layout, "btn-9", category({ id: "btn-3" })).ok, false);
});

test("one canonical item may appear many times - that is shortcuts, not duplicates", () => {
  const layout: PosGridLayout = {
    ...emptyLayout(),
    buttons: [
      item({ id: "btn-1", row: 1, col: 1 }),
      item({ id: "btn-2", row: 1, col: 2, label: "Pizza (counter)" }),
      category({ id: "btn-3", row: 2, col: 1, children: [item({ id: "btn-4", row: 1, col: 1 })] }),
    ],
  };
  assert.deepEqual(validateLayout(layout), []);
  assert.deepEqual(referencedMenuItemIds(layout), ["item-pizza"], "one product, three shortcuts");
  assert.equal(countItemButtons(layout), 3);
});

// --- placement ----------------------------------------------------------------

test("a button may not overlap another, and a move that would is refused", () => {
  const base: PosGridLayout = { ...emptyLayout(), buttons: [item({ id: "btn-1", row: 1, col: 1, width: 2 })] };
  const page = pageOf(base, null);
  assert.equal(canPlace(page, { row: 1, col: 2, width: 1, height: 1 }), false);
  assert.equal(canPlace(page, { row: 1, col: 3, width: 1, height: 1 }), true);
  // Moving a button never displaces another - two changes pretending to be one.
  const withSecond = addButton(base, null, item({ id: "btn-2", row: 2, col: 1 }));
  assert.equal(withSecond.ok, true);
  if (withSecond.ok) {
    assert.equal(moveButton(withSecond.layout, null, "btn-2", { row: 1, col: 1 }).ok, false);
    assert.equal(moveButton(withSecond.layout, null, "btn-2", { row: 3, col: 1 }).ok, true);
  }
});

test("a button may not hang off the edge of the grid", () => {
  const layout = { ...emptyLayout(), columns: 3, rows: 2 };
  assert.equal(addButton(layout, null, item({ row: 1, col: 3, width: 2 })).ok, false);
  assert.equal(addButton(layout, null, item({ row: 2, col: 1, height: 2 })).ok, false);
  assert.equal(addButton(layout, null, item({ row: 1, col: 2, width: 2 })).ok, true);
});

test("shrinking the grid is refused while a button would be stranded, and says how many", () => {
  const layout: PosGridLayout = {
    ...emptyLayout(),
    columns: 5,
    rows: 4,
    buttons: [item({ id: "btn-1", row: 4, col: 5 })],
  };
  const shrunk = resizeGrid(layout, 3, 3);
  assert.equal(shrunk.ok, false);
  if (!shrunk.ok) assert.match(shrunk.error, /1 button/);
  assert.equal(resizeGrid(layout, 5, 4).ok, true);
  assert.equal(resizeGrid(layout, MAX_COLUMNS + 1, 4).ok, false);
});

test("the first free cell is found in reading order, and null when the page is full", () => {
  const layout: PosGridLayout = {
    ...emptyLayout(),
    columns: 2,
    rows: 1,
    buttons: [item({ id: "btn-1", row: 1, col: 1 })],
  };
  assert.deepEqual(findFreeCell(pageOf(layout, null), 1, 1), { row: 1, col: 2 });
  assert.equal(findFreeCell(pageOf(layout, null), 2, 1), null);
  const full = addButton(layout, null, item({ id: "btn-2", row: 1, col: 2 }));
  assert.equal(full.ok, true);
  if (full.ok) {
    assert.equal(findFreeCell(pageOf(full.layout, null), 1, 1), null);
    assert.deepEqual(freeCells(pageOf(full.layout, null)), []);
  }
});

test("a wide button occupies every cell it covers, and is found from any of them", () => {
  const wide = item({ row: 2, col: 2, width: 2, height: 2 });
  assert.deepEqual(cellsOf(wide).sort(), ["2:2", "2:3", "3:2", "3:3"]);
  const layout: PosGridLayout = { ...emptyLayout(), buttons: [wide] };
  assert.equal(buttonAt(pageOf(layout, null), 3, 3)?.id, wide.id);
  assert.equal(buttonAt(pageOf(layout, null), 4, 4), null);
});

test("ids never collide and never reuse a removed one", () => {
  let layout: PosGridLayout = emptyLayout();
  const first = newButtonId(nextButtonSeed(layout));
  const added = addButton(layout, null, item({ id: first, row: 1, col: 1 }));
  assert.equal(added.ok, true);
  if (!added.ok) return;
  layout = added.layout;
  const second = newButtonId(nextButtonSeed(layout));
  assert.notEqual(first, second);
  // Removing the first must not hand its id back out - a stale reference would
  // then point at a different button.
  const afterRemoval = removeButton(layout, null, first);
  assert.notEqual(newButtonId(nextButtonSeed({ ...afterRemoval, buttons: layout.buttons })), first);
});

test("editing a button keeps its identity and its children", () => {
  const layout: PosGridLayout = {
    ...emptyLayout(),
    buttons: [category({ id: "btn-9", children: [item({ id: "btn-2" })] })],
  };
  const renamed = updateButton(layout, null, "btn-9", { label: "Hot Drinks" });
  assert.equal(renamed.ok, true);
  if (renamed.ok) {
    assert.equal(renamed.layout.buttons[0].label, "Hot Drinks");
    assert.equal(renamed.layout.buttons[0].children.length, 1, "renaming a category must not empty it");
  }
});

test("a blank name is refused - an unnamed key is a key nobody can be told to press", () => {
  const layout: PosGridLayout = { ...emptyLayout(), buttons: [item({ label: "   " })] };
  assert.equal(validateLayout(layout).some((p) => p.code === "empty_label"), true);
});

// --- three, it fits without scrolling ----------------------------------------

test("the grid's touch floor IS the POS touch minimum, pinned to it by source", () => {
  // `fit.ts` restates the number rather than importing it from the component
  // layer; this is what stops the two drifting. If `TOUCH_TARGET_PX` ever
  // changes, this fails rather than a cashier discovering an unpressable key.
  const ui = read("src/components/ui.tsx");
  const declared = /TOUCH_TARGET_PX\s*=\s*(\d+)/.exec(ui);
  assert.ok(declared, "components/ui.tsx must declare TOUCH_TARGET_PX");
  assert.equal(MIN_CELL_HEIGHT, Number(declared![1]));
});

test("a fitted cell is never smaller than a usable touch target", () => {
  const fit = fitGrid({ availableWidth: 900, availableHeight: 500, columns: 5, rows: 4 });
  assert.equal(fit.kind, "fits");
  if (fit.kind === "fits") {
    assert.ok(fit.metrics.cellWidth >= MIN_CELL_WIDTH);
    assert.ok(fit.metrics.cellHeight >= MIN_CELL_HEIGHT);
  }
});

test("a grid that cannot fit is REPORTED, never shrunk into something unpressable", () => {
  const fit = fitGrid({ availableWidth: 400, availableHeight: 200, columns: 10, rows: 8 });
  assert.equal(fit.kind, "too_small");
  if (fit.kind === "too_small") {
    assert.ok(fit.needWidth > 400);
    assert.ok(fit.needHeight > 200);
  }
});

test("the whole grid is laid out inside its box - there is nothing to scroll", () => {
  for (const profile of TARGET_PROFILES) {
    const box = predictWorkspaceBox({ windowWidth: profile.width, windowHeight: profile.height });
    const fit = fitGrid({ availableWidth: box.width, availableHeight: box.height, columns: 4, rows: 3 });
    assert.equal(fit.kind, "fits", `${profile.label} must fit a 4x3 grid`);
    if (fit.kind !== "fits") continue;
    const used = {
      width: fit.metrics.cellWidth * 4 + fit.metrics.gap * 3,
      height: fit.metrics.cellHeight * 3 + fit.metrics.gap * 2,
    };
    assert.ok(used.width <= box.width, `${profile.label} overflows horizontally`);
    assert.ok(used.height <= box.height, `${profile.label} overflows vertically`);
  }
});

test("the live grid has no scroll container of its own", () => {
  // The requirement is structural, so the check is too: a scrollbar added here
  // later would silently satisfy "it renders" while breaking "it fits".
  const source = stripJsxComments(read("src/components/pos/grid/CustomGrid.tsx"));
  assert.equal(/overflow-y-auto|overflow-auto|overflow-scroll/.test(source), false);
  assert.match(source, /too_small/, "it must have a path for a screen it cannot fit");
});

test("a span covers its cells PLUS the gaps between them", () => {
  const metrics = { cellWidth: 100, cellHeight: 60, gap: 8, labelFontPx: 12, priceFontPx: 11, iconPx: 18, radiusPx: 8, padPx: 6 };
  assert.deepEqual(spanSize(metrics, 1, 1), { width: 100, height: 60 });
  // 208, not 200: a one-gap drift per span accumulates across a row and pushes
  // the last column off the edge.
  assert.deepEqual(spanSize(metrics, 2, 2), { width: 208, height: 128 });
});

test("small screens produced by Windows display scaling are covered, not assumed away", () => {
  // 1366x768 at 150% reports ~911x512 CSS px. A layout that only fits a
  // developer's 1920 monitor is the failure this check exists for.
  const box = predictWorkspaceBox({ windowWidth: Math.round(1366 / 1.5), windowHeight: Math.round(768 / 1.5) });
  const generous = fitGrid({ availableWidth: box.width, availableHeight: box.height, columns: 8, rows: 6 });
  assert.equal(generous.kind, "too_small", "an 8x6 grid cannot fit a scaled-down panel and must say so");
});

test("the designer's suggestion actually fits every target screen", () => {
  const suggestion = largestSafeGrid();
  assert.equal(fitsEveryProfile(suggestion), true);
  assert.deepEqual(failingProfiles(suggestion), []);
  // And an oversized shape names the screens it fails, so the warning is useful.
  const failures = failingProfiles({ columns: 10, rows: 8 });
  assert.ok(failures.length > 0);
  assert.equal(fitAcrossProfiles({ columns: 10, rows: 8 }).length, TARGET_PROFILES.length);
});

// --- four, readable in light and dark ----------------------------------------

test("EVERY colour a manager can choose meets WCAG AA with its computed ink", () => {
  const combinations = allCombinations();
  assert.ok(combinations.length >= 60, "a handful of colours is not a palette");
  for (const { hue, shade, fill } of combinations) {
    const contrast = achievedContrast(fill);
    assert.ok(
      contrast >= MIN_BUTTON_CONTRAST,
      `${hue}-${shade} (${fill}) reaches only ${contrast.toFixed(2)}:1 with ${inkFor(fill)}`,
    );
  }
});

test("an uncoloured button is fully themed, so Light and Dark both follow the theme", () => {
  assert.deepEqual(resolveColor(null), { fill: null, ink: null });
  const tile = stripJsxComments(read("src/components/pos/grid/GridButtonTile.tsx"));
  assert.match(tile, /!fill && "border-line bg-white text-ink/);
});

test("an unrecognised colour token falls back to the theme rather than a guess", () => {
  assert.equal(fillFor({ hue: "chartreuse", shade: 500 }), null);
  assert.equal(fillFor({ hue: "amber", shade: 999 }), null);
  assert.deepEqual(resolveColor({ hue: "nope", shade: 1 }), { fill: null, ink: null });
});

// --- the engine is not duplicated ---------------------------------------------

test("the customized grid adds NO ordering, payment or printing logic", () => {
  const source = stripJsxComments(read("src/components/pos/grid/CustomGrid.tsx"));
  for (const forbidden of [
    "useCart",
    "submitOrder",
    "payOrder",
    "pos_submit_order",
    "pos_pay_order",
    "printReceipt",
    "printKitchenTicket",
    "resolvePrintRoute",
    "buildSubmitPayload",
  ]) {
    assert.equal(source.includes(forbidden), false, `the grid must not reach ${forbidden}`);
  }
});

test("both presentations call ONE handler with the same canonical item", () => {
  const workspace = stripJsxComments(read("src/screens/pos/PosWorkspace.tsx"));
  // The default grid and the custom grid are given the same `addItem`.
  assert.match(workspace, /<CustomGrid[\s\S]*?onPick=\{addItem\}/);
  assert.match(workspace, /<MenuItemGrid[\s\S]*?onPick=\{addItem\}/);
});

test("the default layout is pinned to the right, whatever a stored layout says", () => {
  const workspace = stripJsxComments(read("src/screens/pos/PosWorkspace.tsx"));
  assert.match(workspace, /cartSide=\{customLayoutActive \? gridLayout\.orderPanel : "right"\}/);
});

test("the shell renders ONE cart node whichever side it is on", () => {
  const shell = stripJsxComments(read("src/layouts/PosShell.tsx"));
  // Two placements, one `props.cart(layout)` call shape - there is no second
  // Current Order component and nothing downstream can tell which side it is on.
  assert.equal((shell.match(/props\.cart\(layout\)/g) ?? []).length, 3, "left, right and the drawer - and no more");
});
