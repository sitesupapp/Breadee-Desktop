// Categorized cashier view — a terminal-local, default-OFF navigation layer.
//
// The feature adds NO menu data path: the category cards and the per-category
// items are built from the SAME `usableCategories` / `categoryCounts` /
// `filterItems` the default category strip already uses, so it cannot show a
// category or item the default POS would not — same tenant, same branch, same
// OU isolation, same order. These tests pin: the switch (default OFF, per-field
// round-trip), the data-layer drill-down (Scenario A/B), and the wiring that
// keeps the DEFAULT and CUSTOMIZED presentations untouched when the switch is
// off.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { POS_FEATURE_DEFAULTS, parsePosFeatures, readPosFeatures, writePosFeatures } from "@/lib/pos/posFeatures";
import { filterItems, usableCategories, withSearchIndex } from "@/lib/pos/menu";
import { ALL_CATEGORIES } from "@/lib/pos/categories";
import type { MenuData, MenuItem } from "@/types/pos";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
}

function item(id: string, name: string, category_id: string | null): MenuItem {
  return { id, name, price: 10, category_id, image_url: null };
}

// A small OU menu: two populated categories in a deliberate order, plus one
// category with no available items (which must never surface).
const MENU: Pick<MenuData, "categories" | "items"> = {
  categories: [
    { id: "c-pizza", name: "Pizza" },
    { id: "c-drinks", name: "Drinks" },
    { id: "c-empty", name: "Retired" },
  ],
  items: [
    item("i-margherita", "Margherita", "c-pizza"),
    item("i-pepperoni", "Pepperoni", "c-pizza"),
    item("i-cola", "Cola", "c-drinks"),
  ],
};

// --- the terminal switch -----------------------------------------------------

test("the categorized switch defaults OFF (existing installs keep today's menu)", () => {
  assert.equal(POS_FEATURE_DEFAULTS.categorizedMenu, false);
});

test("a stored categorized choice survives; only an absent/non-boolean key gets the default", () => {
  assert.equal(parsePosFeatures(JSON.stringify({ categorizedMenu: true })).categorizedMenu, true);
  assert.equal(parsePosFeatures(JSON.stringify({})).categorizedMenu, false);
  assert.equal(parsePosFeatures(JSON.stringify({ categorizedMenu: "yes" })).categorizedMenu, false);
  assert.deepEqual(readPosFeatures(memoryStorage()), POS_FEATURE_DEFAULTS);
});

test("categorizedMenu round-trips through storage per field, alongside the other switches", () => {
  const store = memoryStorage();
  writePosFeatures({ ingredientCustomization: false, categorizedMenu: true }, store);
  const back = readPosFeatures(store);
  assert.equal(back.categorizedMenu, true);
  assert.equal(back.ingredientCustomization, false);
});

// --- data-layer drill-down (Scenario A / B) ----------------------------------

test("Scenario A: the category cards are exactly the usable categories, in configured order", () => {
  const cats = usableCategories(MENU);
  assert.deepEqual(cats.map((c) => c.name), ["Pizza", "Drinks"], "empty category dropped, order preserved");
});

test("Scenario B: opening a category shows only that category's items, in order", () => {
  const indexed = withSearchIndex(MENU.items as MenuItem[]);
  const pizza = filterItems(indexed, "c-pizza", "");
  assert.deepEqual(pizza.map((i) => i.name), ["Margherita", "Pepperoni"]);
  const drinks = filterItems(indexed, "c-drinks", "");
  assert.deepEqual(drinks.map((i) => i.name), ["Cola"]);
});

test("the All-items card resolves to the whole menu (no category filter)", () => {
  const indexed = withSearchIndex(MENU.items as MenuItem[]);
  const all = filterItems(indexed, ALL_CATEGORIES === "__all__" ? null : ALL_CATEGORIES, "");
  assert.equal(all.length, 3);
});

// --- wiring & preservation ---------------------------------------------------

test("the workspace builds the cards from the SAME dataset the strip uses, gated OFF the customized grid", () => {
  const src = read("src/screens/pos/PosWorkspace.tsx");
  // Ignored while the customized grid is active — it has its own category keys.
  assert.match(src, /const categorizedActive = features\.categorizedMenu && !customLayoutActive;/);
  // Cards come from categories + categoryCounts, not a separate fetch.
  assert.match(src, /categoryPickerEntries = useMemo/);
  assert.match(src, /\.\.\.categories\.map\(\(c\) => \(\{ id: c\.id, name: c\.name, count: categoryCounts\[c\.id\]/);
  assert.match(src, /<CategoryPicker entries=\{categoryPickerEntries\} onPick=\{pickCategory\}/);
  // Drill state opens on a pick.
  assert.match(src, /setMenuDrilled\(true\)/);
});

test("the DEFAULT presentation is untouched when the switch is off", () => {
  const src = read("src/screens/pos/PosWorkspace.tsx");
  // The category strip still renders for the default layout (now also stood
  // down in categorized mode), and the customized grid branch is intact.
  assert.match(src, /!customLayoutActive && !categorizedActive && \(/);
  assert.match(src, /customLayoutActive && query\.trim\(\) === "" \? \(/);
  // The categorized branch is inserted, gated on the switch AND the drill state.
  assert.match(src, /categorizedActive && !menuDrilled && query\.trim\(\) === "" \? \(/);
});

test("the picker component carries NO menu of its own — navigation only", () => {
  const src = read("src/components/pos/CategoryPicker.tsx");
  for (const forbidden of ["supabase", "loadMenu", "loadPosMenu", "pos_menu"]) {
    assert.equal(src.includes(forbidden), false, `the picker must not reference ${forbidden}`);
  }
});

test("Settings surfaces the terminal-local categorized toggle", () => {
  const src = read("src/screens/settings/PosSettings.tsx");
  assert.match(src, /checked=\{features\.categorizedMenu\}/);
  assert.match(src, /setFeature\("categorizedMenu", next\)/);
});
