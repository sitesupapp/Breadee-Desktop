// The three-layout cashier system.
//
// THE PROPERTY EVERY TEST HERE ORBITS: the canonical menu is the source, and a
// layout holds only PRESENTATION. The failure this prevents is the obvious
// implementation - copy the categories and items into the layout when it is
// created - which is correct on the day it is built and silently wrong forever
// after: a new item never appears, a rename never propagates, a price never
// updates, and a cashier finds out mid-service.
//
// The second property: HIDING IS NOT DELETING. A cashier tidying their own
// screen must not be able to remove a product from the business.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { stripJsxComments } from "./source-helpers.ts";
import {
  UNCATEGORISED_ID,
  hiddenCount,
  overrideKey,
  pruneOverrides,
  readOverride,
  reorder,
  resolveCategoryButtons,
  resolveCategoryItems,
  resolveDefaultButtons,
  resolveUncategorised,
  restore,
  writeOverride,
} from "@/lib/pos/grid/presentation";
import { LAYOUT_MODES, emptyLayout, isLayoutMode, type PresentationMap } from "@/lib/pos/grid/model";
import type { MenuCategory, MenuItem } from "@/types/pos";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

const CATEGORIES: MenuCategory[] = [
  { id: "c-starters", name: "Starters" },
  { id: "c-drinks", name: "Drinks" },
  { id: "c-burgers", name: "Burgers" },
  { id: "c-sandwiches", name: "Sandwiches" },
];

function item(id: string, name: string, category: string | null): MenuItem {
  return { id, name, price: 10, category_id: category, image_url: null };
}

const ITEMS: MenuItem[] = [
  item("i-soup", "Soup", "c-starters"),
  item("i-cola", "Cola", "c-drinks"),
  item("i-water", "Water", "c-drinks"),
  item("i-cheese", "Cheeseburger", "c-burgers"),
  item("i-double", "Double Burger", "c-burgers"),
  item("i-club", "Club Sandwich", "c-sandwiches"),
  item("i-special", "Chef's Special", null),
];

// --- the three modes ----------------------------------------------------------

test("there are exactly three layouts, and a stored value is validated", () => {
  assert.deepEqual([...LAYOUT_MODES], ["default", "categories", "customized"]);
  for (const mode of LAYOUT_MODES) assert.equal(isLayoutMode(mode), true);
  for (const bad of ["grid", "", null, undefined, 3, "Default"]) assert.equal(isLayoutMode(bad), false);
});

test("a new terminal starts on Default", () => {
  assert.equal(emptyLayout().mode, "default");
});

// --- Categories comes from the canonical menu --------------------------------

test("categories populate automatically from Menu Builder", () => {
  const buttons = resolveCategoryButtons(CATEGORIES, ITEMS, {});
  assert.deepEqual(buttons.map((b) => b.label), ["Starters", "Drinks", "Burgers", "Sandwiches"]);
  for (const button of buttons) assert.equal(button.kind, "category");
});

test("a category opens its own canonical items, and only those", () => {
  const burgers = resolveCategoryItems("c-burgers", ITEMS, {});
  assert.deepEqual(burgers.map((b) => b.label), ["Cheeseburger", "Double Burger"]);
  for (const button of burgers) assert.equal(button.kind, "menu_item");
  assert.deepEqual(resolveCategoryItems("c-drinks", ITEMS, {}).map((b) => b.label), ["Cola", "Water"]);
});

test("a NEW canonical category appears with no migration and no rebuild", () => {
  // The whole reason the layout stores overrides rather than a copy.
  const withNew = [...CATEGORIES, { id: "c-desserts", name: "Desserts" }];
  const withNewItem = [...ITEMS, item("i-cake", "Cake", "c-desserts")];
  const buttons = resolveCategoryButtons(withNew, withNewItem, {});
  assert.ok(buttons.some((b) => b.label === "Desserts"), "a category added in Menu Builder must just appear");
});

test("a RENAMED canonical category renames its button", () => {
  const renamed = CATEGORIES.map((c) => (c.id === "c-drinks" ? { ...c, name: "Cold Drinks" } : c));
  const buttons = resolveCategoryButtons(renamed, ITEMS, {});
  assert.ok(buttons.some((b) => b.label === "Cold Drinks"));
  assert.equal(buttons.some((b) => b.label === "Drinks"), false, "the old name must not survive in a copy");
});

test("an empty category is not offered - a button that opens nothing is a dead end", () => {
  const withEmpty = [...CATEGORIES, { id: "c-empty", name: "Seasonal" }];
  assert.equal(
    resolveCategoryButtons(withEmpty, ITEMS, {}).some((b) => b.label === "Seasonal"),
    false,
  );
});

test("items in no category are still reachable", () => {
  const loose = resolveUncategorised(ITEMS, {});
  assert.deepEqual(loose.map((b) => b.label), ["Chef's Special"]);
  assert.equal(UNCATEGORISED_ID, "__uncategorised__");
});

test("Default shows every available item in canonical order", () => {
  const buttons = resolveDefaultButtons(ITEMS, {});
  assert.equal(buttons.length, ITEMS.length);
  assert.deepEqual(buttons.map((b) => b.label), ITEMS.map((i) => i.name));
});

// --- editing the presentation -------------------------------------------------

test("hiding a button removes it from the LAYOUT and nothing else", () => {
  const map = writeOverride({}, "item", "i-water", { hidden: true });
  const drinks = resolveCategoryItems("c-drinks", ITEMS, map);
  assert.deepEqual(drinks.map((b) => b.label), ["Cola"], "Water is gone from this till");
  // The canonical arrays are untouched - the source of truth still has it.
  assert.ok(ITEMS.some((i) => i.id === "i-water"), "hiding must never delete the menu item");
  assert.equal(hiddenCount(map), 1);
});

test("hiding every item in a category hides the category too", () => {
  let map: PresentationMap = {};
  map = writeOverride(map, "item", "i-cola", { hidden: true });
  map = writeOverride(map, "item", "i-water", { hidden: true });
  assert.equal(
    resolveCategoryButtons(CATEGORIES, ITEMS, map).some((b) => b.label === "Drinks"),
    false,
    "a category whose items are all hidden opens nothing, so it is not offered",
  );
});

test("a hidden button can be restored", () => {
  let map = writeOverride({}, "item", "i-water", { hidden: true });
  assert.equal(resolveCategoryItems("c-drinks", ITEMS, map).length, 1);
  map = restore(map, "item", "i-water");
  assert.equal(resolveCategoryItems("c-drinks", ITEMS, map).length, 2);
  assert.equal(hiddenCount(map), 0);
});

test("reordering persists, and survives the canonical order changing underneath it", () => {
  const map = reorder({}, "category", ["c-burgers", "c-drinks", "c-starters", "c-sandwiches"]);
  assert.deepEqual(
    resolveCategoryButtons(CATEGORIES, ITEMS, map).map((b) => b.label),
    ["Burgers", "Drinks", "Starters", "Sandwiches"],
  );
  // The whole order is written, not one index - so shuffling the canonical list
  // cannot silently re-mean the stored positions.
  const shuffled = [CATEGORIES[3], CATEGORIES[0], CATEGORIES[2], CATEGORIES[1]];
  assert.deepEqual(
    resolveCategoryButtons(shuffled, ITEMS, map).map((b) => b.label),
    ["Burgers", "Drinks", "Starters", "Sandwiches"],
  );
});

test("a renamed BUTTON does not rename the menu item", () => {
  const map = writeOverride({}, "item", "i-cheese", { label: "CHZ" });
  const buttons = resolveCategoryItems("c-burgers", ITEMS, map);
  assert.equal(buttons[0].label, "CHZ", "the till shows the cashier's label");
  assert.equal(ITEMS.find((i) => i.id === "i-cheese")?.name, "Cheeseburger", "the menu item keeps its name");
  // And the button still sells the canonical item.
  assert.equal(buttons[0].menuItemId, "i-cheese");
});

test("a blank label falls back to the canonical name rather than an unnamed key", () => {
  const map = writeOverride({}, "item", "i-cheese", { label: "   " });
  assert.equal(resolveCategoryItems("c-burgers", ITEMS, map)[0].label, "Cheeseburger");
});

test("an override that says nothing is removed, not stored empty", () => {
  let map = writeOverride({}, "item", "i-cola", { hidden: true });
  assert.equal(Object.keys(map).length, 1);
  map = writeOverride(map, "item", "i-cola", { hidden: undefined });
  assert.deepEqual(map, {}, "resetting a button must not leave a tombstone");
});

test("overrides are keyed by canonical id, and category and item ids cannot collide", () => {
  assert.notEqual(overrideKey("category", "x"), overrideKey("item", "x"));
  const map = writeOverride({}, "category", "x", { hidden: true });
  assert.deepEqual(readOverride(map, "item", "x"), {}, "an item must not inherit a category's override");
});

test("overrides for records that no longer exist are pruned on save", () => {
  let map = writeOverride({}, "item", "i-gone", { hidden: true });
  map = writeOverride(map, "item", "i-cola", { hidden: true });
  const pruned = pruneOverrides(map, CATEGORIES, ITEMS);
  assert.deepEqual(Object.keys(pruned), [overrideKey("item", "i-cola")]);
});

test("resolution NEVER copies a price, and always carries the canonical id", () => {
  const buttons = [...resolveDefaultButtons(ITEMS, {}), ...resolveCategoryButtons(CATEGORIES, ITEMS, {})];
  for (const button of buttons) {
    assert.equal("price" in button, false, "a button must not carry a price");
    if (button.kind === "menu_item") assert.ok(button.menuItemId, "a sellable button names its canonical item");
  }
});

// --- the layout modules cannot reach the menu --------------------------------

test("presentation can HIDE but has no way to DELETE", () => {
  const source = stripJsxComments(read("src/lib/pos/grid/presentation.ts"));
  // The check is "can it reach the database", not "does the word delete
  // appear" - `delete obj[key]` on a local override map is ordinary JavaScript
  // and is how an override is reset. What must be absent is any route to the
  // canonical tables.
  for (const forbidden of ["supabase", "menu_items", "menu_categories", "archived_at", "rpc(", "from("]) {
    assert.equal(source.includes(forbidden), false, `presentation must not be able to reach ${forbidden}`);
  }
  // And the only deletions it performs are on a plain object it was handed.
  for (const match of source.match(/delete [^\s;]+/g) ?? []) {
    assert.match(match, /^delete (next|out)[[.]/, `unexpected deletion: ${match}`);
  }
});

test("the layout editor cannot write to Menu Builder either", () => {
  const source = stripJsxComments(read("src/screens/settings/CashierLayout.tsx"));
  for (const forbidden of ["saveMenuItem", "set_menu_item_price", "deleteMenuItem", "upsertCategory", "archiveItem"]) {
    assert.equal(source.includes(forbidden), false, `the layout editor must not ${forbidden}`);
  }
  // It reads the menu, and writes only the layout.
  assert.match(source, /loadMenu/);
  assert.match(source, /writeLayout/);
});

// --- one renderer, one button, one preview -----------------------------------

test("all three layouts render through the SAME grid and button", () => {
  const workspace = stripJsxComments(read("src/screens/pos/PosWorkspace.tsx"));
  const settings = stripJsxComments(read("src/screens/settings/CashierLayout.tsx"));
  // The till and the preview import the same component - which is the only way
  // a preview can be guaranteed to match the thing it previews.
  for (const source of [workspace, settings]) {
    assert.match(source, /from "@\/components\/pos\/grid\/PosLayoutGrid"/);
  }
  const grid = stripJsxComments(read("src/components/pos/grid/PosLayoutGrid.tsx"));
  assert.match(grid, /GridButtonTile/, "the one grid renders the one button");
});

test("the preview uses the SAME resolvers and the SAME sizing engine as the till", () => {
  const settings = stripJsxComments(read("src/screens/settings/CashierLayout.tsx"));
  for (const resolver of ["resolveDefaultButtons", "resolveCategoryButtons", "resolveCategoryItems"]) {
    assert.ok(settings.includes(resolver), `the preview must resolve buttons with ${resolver}`);
  }
  // It passes the real autoFit / columns / rows through, so the geometry the
  // manager approves is the geometry the cashier gets.
  assert.match(settings, /autoFit=\{draft\.autoFit\}/);
  assert.match(settings, /columns=\{draft\.columns\}/);
  assert.match(settings, /rows=\{draft\.rows\}/);
  // And it draws the order column on the chosen side, because that column is
  // exactly the space the grid does not get.
  assert.match(settings, /draft\.orderPanel === "left"/);
});

test("there is no second grid implementation left behind", () => {
  // The per-layout grids were replaced, not supplemented. Two renderers is how
  // the preview and the till drift apart again.
  for (const gone of ["src/components/pos/grid/CustomGrid.tsx", "src/components/pos/MenuItemGrid.tsx"]) {
    let exists = true;
    try {
      read(gone);
    } catch {
      exists = false;
    }
    assert.equal(exists, false, `${gone} should have been replaced by the shared grid`);
  }
});

// --- Current Order side, everywhere ------------------------------------------

test("the order column side is stored once and applies to every layout", () => {
  const workspace = stripJsxComments(read("src/screens/pos/PosWorkspace.tsx"));
  assert.match(workspace, /cartSide=\{gridLayout\.orderPanel\}/);
  // No layout-specific branch remains.
  assert.equal(/customLayoutActive \? gridLayout\.orderPanel/.test(workspace), false);
  const shell = stripJsxComments(read("src/layouts/PosShell.tsx"));
  assert.equal((shell.match(/props\.cart\(layout\)/g) ?? []).length, 3, "left, right and the drawer - one node each");
});

// --- Back / Main --------------------------------------------------------------

test("Back and Main return to the top page and NEVER touch the order", () => {
  const workspace = stripJsxComments(read("src/screens/pos/PosWorkspace.tsx"));
  // Both controls do exactly one thing: clear the open category.
  const backAndMain = workspace.slice(workspace.indexOf("Back one level"), workspace.indexOf("Back one level") + 900);
  assert.match(backAndMain, /setOpenCategoryId\(null\)/);
  for (const destructive of ["cart.reset", "newOrder", "clearOrder", "useCart.getState().reset"]) {
    assert.equal(backAndMain.includes(destructive), false, `Main must not ${destructive}`);
  }
});
