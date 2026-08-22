// The icons gallery.
//
// Three properties these tests exist to protect.
//
// ONE, AN ICON IS PRESENTATION. Assigning one must not be able to reach a
// price, a recipe, inventory, tax, modifiers, a category or a print route. The
// strongest form of that check is that the modules involved cannot: they import
// nothing that could.
//
// TWO, ONE ASSET, TEN THEMES. Icons inherit the surrounding text colour, so
// there is no per-theme icon file, no recolouring step and nothing stored per
// theme - and an icon is therefore legible in every theme by construction.
//
// THREE, A STORED KEY IS ALWAYS A REAL ICON. A withdrawn or misspelled key must
// resolve to "no icon", never to an empty square on a menu button in the middle
// of service.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { stripComments, stripJsxComments } from "./source-helpers.ts";
import { ICON_BY_KEY, ICON_CATEGORIES, POS_ICONS, isIconKey, searchIcons } from "@/lib/icons/catalog";
import {
  ICON_ASSIGNMENTS_KEY,
  iconForItem,
  parseIconAssignments,
  readIconAssignments,
  writeIconAssignment,
} from "@/lib/icons/assignments";

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

// --- one, an icon is presentation --------------------------------------------

test("the icon modules cannot reach anything operational", () => {
  for (const file of ["src/lib/icons/catalog.ts", "src/lib/icons/assignments.ts", "src/components/PosIconGlyph.tsx"]) {
    const source = stripJsxComments(read(file));
    for (const forbidden of [
      "supabase",
      "rpc(",
      "price",
      "recipe",
      "inventory",
      "tax",
      "modifier",
      "category_id",
      "print",
      "route",
    ]) {
      assert.ok(!source.toLowerCase().includes(forbidden.toLowerCase()), `${file} must not mention ${forbidden}`);
    }
  }
});

test("the gallery reads the menu and writes only an icon key", () => {
  const source = stripJsxComments(read("src/screens/settings/IconsGallery.tsx"));
  // Reading the menu is the point - it is the list of items to decorate.
  assert.ok(source.includes("loadMenu"), "the gallery lists the real menu");
  // But it must never write one back.
  for (const forbidden of [
    "supabase",
    "menu_items",
    "resolveMenuPrice",
    "updateItem",
    "save",
    "rpc(",
    "modifier_groups",
  ]) {
    assert.ok(!source.includes(forbidden), `IconsGallery must not reference ${forbidden}`);
  }
  assert.ok(source.includes("writeIconAssignment"), "the only write is the local assignment");
});

test("the menu grid renders an icon without changing what a tap does", () => {
  // RETARGETED for layout V2: the per-layout grids were replaced by one
  // renderer plus one button, so the property is now asserted across the pair.
  // What it guards is unchanged - an icon must not be able to alter what adding
  // an item to the cart means.
  const grid = stripJsxComments(read("src/components/pos/grid/PosLayoutGrid.tsx"));
  const tile = stripJsxComments(read("src/components/pos/grid/GridButtonTile.tsx"));
  assert.ok(grid.includes("onPick(button)"), "the pick handler is unchanged");
  assert.equal(tile.split("onClick=").length - 1, 1, "there is still one handler on a button");
  for (const source of [grid, tile]) {
    assert.ok(!source.includes("writeIconAssignment"), "the POS grid never assigns an icon");
  }
  // And the icon is drawn from the button's stored key, nothing more.
  assert.ok(tile.includes("PosIconGlyph"), "the shared button still draws the assigned glyph");
});

test("assign, change and remove are all offered", () => {
  const source = read("src/screens/settings/IconsGallery.tsx");
  assert.ok(source.includes("Assign"));
  assert.ok(source.includes("Change"));
  assert.ok(source.includes("Remove"));
  // And the item preview shows what the button will read.
  assert.ok(source.includes("PosIconGlyph"));
});

// --- two, one asset, ten themes ----------------------------------------------

test("icons are drawn in currentColor and carry no colour of their own", () => {
  const glyph = stripJsxComments(read("src/components/PosIconGlyph.tsx"));
  assert.ok(glyph.includes('stroke="currentColor"'), "the glyph inherits the surrounding ink");
  assert.ok(glyph.includes('fill="none"'), "stroke, not fill - a filled glyph blobs at 18px");
  assert.ok(!/#[0-9a-fA-F]{3,8}/.test(glyph), "an icon must not name a colour");
  assert.ok(!glyph.includes("theme"), "there is no per-theme icon asset");
});

test("no icon path carries a colour, an image or a script", () => {
  const source = read("src/lib/icons/catalog.ts");
  assert.ok(!source.includes("<image"), "no photography");
  assert.ok(!source.includes("http"), "no remote asset");
  assert.ok(!source.includes("data:"), "no embedded bitmap");
  for (const icon of POS_ICONS) {
    // Path data only: letters (commands) and numbers. Anything else would be
    // markup smuggled into a `d` attribute.
    assert.match(icon.path, /^[MmLlHhVvCcSsQqTtAaZz0-9 .,-]+$/, `${icon.key} path`);
  }
});

// --- three, a stored key is always a real icon -------------------------------

test("the catalogue covers the categories an operator would look for", () => {
  const keys = POS_ICONS.map((i) => i.key);
  for (const expected of [
    "burger", "pizza", "sandwich", "hotdog", "fries", "chicken", "meat", "fish", "pasta", "rice", "salad",
    "lebanese", "turkish", "oriental",
    "coffee", "tea", "juice", "smoothie", "soft-drink",
    "dessert", "ice-cream", "bakery", "breakfast",
    "sauce", "add-on", "generic-food", "generic-beverage",
  ]) {
    assert.ok(keys.includes(expected), `the catalogue must include ${expected}`);
  }
  assert.equal(new Set(keys).size, keys.length, "icon keys must be unique");
  for (const icon of POS_ICONS) {
    assert.ok(ICON_CATEGORIES.includes(icon.category), `${icon.key} has an unknown category`);
    assert.ok(icon.label.trim() !== "", `${icon.key} needs a label`);
    assert.ok(icon.path.trim() !== "", `${icon.key} needs a path`);
  }
});

test("search matches labels, keys and the words an operator actually types", () => {
  assert.ok(searchIcons("burger", null).some((i) => i.key === "burger"));
  // Keywords exist because nobody searches for "Soft Drink" when they want cola.
  assert.ok(searchIcons("cola", null).some((i) => i.key === "soft-drink"));
  assert.ok(searchIcons("shawarma", null).some((i) => i.key === "lebanese"));
  assert.ok(searchIcons("kebab", null).some((i) => i.key === "turkish"));
  // Substring, not prefix.
  assert.ok(searchIcons("urger", null).some((i) => i.key === "burger"));
  // Category filter narrows without breaking search.
  assert.ok(searchIcons("", "Beverage").every((i) => i.category === "Beverage"));
  assert.equal(searchIcons("zzzz", null).length, 0);
  assert.equal(searchIcons("", null).length, POS_ICONS.length);
});

test("an unknown or withdrawn key resolves to no icon", () => {
  assert.equal(iconForItem({ item1: "burger" }, "item1"), "burger");
  assert.equal(iconForItem({ item1: "no-such-icon" }, "item1"), null);
  assert.equal(iconForItem({}, "item1"), null);
  assert.ok(isIconKey("pizza"));
  assert.ok(!isIconKey("Pizza"));
  assert.ok(!isIconKey(42));
  assert.ok(ICON_BY_KEY.pizza);
});

test("a corrupt assignment map degrades to no icons", () => {
  for (const bad of ["", "not json", "[]", "null", "5"]) {
    assert.deepEqual(parseIconAssignments(bad), {}, JSON.stringify(bad));
  }
  // Values that are not real icon keys are dropped rather than kept, so a menu
  // button can never render an empty square.
  assert.deepEqual(parseIconAssignments('{"a":"burger","b":"nope","c":7}'), { a: "burger" });
  assert.deepEqual(readIconAssignments({ getItem: () => { throw new Error("no storage"); } }), {});
});

test("assigning, changing and removing all write one namespaced key", () => {
  const store = memoryStorage();
  writeIconAssignment("item1", "burger", store);
  assert.deepEqual(JSON.parse(store.read()[ICON_ASSIGNMENTS_KEY]), { item1: "burger" });
  writeIconAssignment("item1", "pizza", store);
  assert.deepEqual(JSON.parse(store.read()[ICON_ASSIGNMENTS_KEY]), { item1: "pizza" });
  writeIconAssignment("item1", null, store);
  assert.deepEqual(JSON.parse(store.read()[ICON_ASSIGNMENTS_KEY]), {});
  // A bogus key is a removal, not a corrupt store.
  writeIconAssignment("item2", "not-an-icon", store);
  assert.deepEqual(JSON.parse(store.read()[ICON_ASSIGNMENTS_KEY]), {});
  assert.ok(ICON_ASSIGNMENTS_KEY.startsWith("breadee.desktop."));
});

test("a terminal with no storage still renders the menu", () => {
  assert.doesNotThrow(() =>
    writeIconAssignment("item1", "burger", {
      getItem: () => null,
      setItem: () => {
        throw new Error("storage disabled");
      },
    }),
  );
});

test("the icon layer imports nothing beyond the catalogue", () => {
  const source = stripComments(read("src/lib/icons/assignments.ts"));
  const imports = source.match(/^import .*$/gm) ?? [];
  assert.equal(imports.length, 1, "one import: the catalogue");
  assert.ok(imports[0].includes("@/lib/icons/catalog"));
});
