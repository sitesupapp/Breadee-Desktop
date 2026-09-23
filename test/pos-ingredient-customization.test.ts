// Ingredient customization on a POS order line (prod-native restore).
//
// The ingredient list must come from the MENU, not the COST SHEET. The database
// makes that easy to get wrong: `pos_order_items.customization_json` already
// carries a `removed_ingredients` array that a trigger resolves against
// `cost_materials` and turns into a costed reversal. Writing a menu ingredient
// name into that channel would be a costing instruction. So these tests pin the
// SOURCE (`menu_items.ingredients`) and the CHANNEL (`removed_menu_ingredients`)
// separately, and they prove the prod-native menu enrichment that carries
// `ingredients` alongside the OU-isolated `pos_menu` projection WITHOUT
// regressing OU isolation.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { stripComments, stripJsxComments } from "./source-helpers.ts";

import {
  buildCustomization,
  buildLineCustomization,
  hasIngredients,
  ingredientsOf,
  kitchenNoteFor,
  removalLabel,
  removalSummary,
  sameRemovals,
} from "@/lib/pos/itemOptions";
import { POS_FEATURE_DEFAULTS, parsePosFeatures, readPosFeatures, writePosFeatures } from "@/lib/pos/posFeatures";
import { buildSubmitPayload } from "@/lib/pos/orders";
import { mergeIngredients, pivotRemovables, type RecipeRemovableRow } from "@/lib/pos/menu";
import { lineTotals } from "@/lib/pos/modifiers";
import { useCart } from "@/state/cart";
import {
  reconcileMaterialRemovals,
  sameMaterialRemovals,
  toggleMaterialRemoval,
  type RecipeRemovable,
  type RemovedMaterial,
} from "@/lib/pos/recipeRemovals";
import type { CartLine, MenuData, MenuItem } from "@/types/pos";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
}

const BURGER: MenuItem = {
  id: "i-burger",
  name: "Burger",
  price: 12,
  category_id: "c-burgers",
  image_url: null,
  ingredients: ["Bun", "Beef", "Tomato", "Pickles", "Onion", "Sauce"],
};

function line(over: Partial<CartLine> = {}): CartLine {
  return { key: "line-1", menu_item_id: "i-burger", name: "Burger", base_price: 12, quantity: 1, kitchen_note: null, modifiers: [], ...over };
}

beforeEach(() => {
  useCart.getState().reset();
});

// --- source & channel --------------------------------------------------------

test("the list comes from menu_items.ingredients - the Menu Builder array", () => {
  assert.deepEqual(ingredientsOf(BURGER), ["Bun", "Beef", "Tomato", "Pickles", "Onion", "Sauce"]);
  assert.equal(hasIngredients(BURGER), true);
});

test("an item with no ingredients offers no customization, and does not crash", () => {
  for (const value of [undefined, null, [], "Bun, Beef", 42, {}]) {
    const item = { ...BURGER, ingredients: value } as unknown as MenuItem;
    assert.deepEqual(ingredientsOf(item), []);
    assert.equal(hasIngredients(item), false);
  }
});

test("blanks are dropped and duplicates collapse, case-insensitively", () => {
  const messy = { ...BURGER, ingredients: ["Bun", " ", "bun", "Beef", "BEEF", ""] } as MenuItem;
  assert.deepEqual(ingredientsOf(messy), ["Bun", "Beef"]);
});

test("removals travel in their OWN channel, not Cost Control's", () => {
  const custom = buildCustomization(["Tomato", "Pickles"]);
  assert.deepEqual(custom, { removed_menu_ingredients: ["Tomato", "Pickles"] });
  assert.equal("removed_ingredients" in (custom as object), false);
});

test("COST CONTROL is not the source, and cannot leak into the popup", () => {
  // Comments are stripped first: itemOptions.ts DOCUMENTS the separation from
  // Cost Control ("NOT cost_materials"), and a raw-text scan cannot tell prose
  // from behaviour. The assertion is about the CODE.
  const source = stripComments(read("src/lib/pos/itemOptions.ts"));
  for (const forbidden of ["cost_materials", "material_id", "waste_percent", "unit_id"]) {
    assert.equal(source.includes(forbidden), false, `the ingredient source must not reference ${forbidden}`);
  }
  const dialog = stripJsxComments(read("src/components/pos/ModifierDialog.tsx"));
  assert.match(dialog, /ingredientsOf\(props\.item\)/);
  for (const forbidden of ["cost_materials", "material_id", "costing_modifier_group_id"]) {
    assert.equal(dialog.includes(forbidden), false, `the popup must not reference ${forbidden}`);
  }
});

// --- payload -----------------------------------------------------------------

test("nothing to remove means no customization at all on the payload", () => {
  assert.equal(buildCustomization([]), null);
  assert.equal(buildCustomization(["", "  "]), null);
  const payload = buildSubmitPayload({ branchId: "b", shiftId: "s", orderType: "takeaway", clientOpId: "op", lines: [line()] });
  assert.equal("customization_json" in payload.items[0], false, "an ordinary order is byte-identical to before");
});

test("a removal reaches the order payload structurally, and only in the menu channel", () => {
  const payload = buildSubmitPayload({ branchId: "b", shiftId: "s", orderType: "takeaway", clientOpId: "op", lines: [line({ removed_ingredients: ["Tomato", "Pickles"] })] });
  assert.deepEqual(payload.items[0].customization_json, { removed_menu_ingredients: ["Tomato", "Pickles"] });
  assert.equal("removed_ingredients" in (payload.items[0].customization_json as object), false);
});

test("DELIVERY FEE is preserved on a delivery order that also customizes an item", () => {
  // Regression guard: the delivery-fee order plumbing already live in prod must
  // survive the ingredient patch, and must coexist with a removal on the line.
  const payload = buildSubmitPayload({
    branchId: "b", shiftId: "s", orderType: "delivery", clientOpId: "op",
    customerId: "c1", addressId: "a1", deliveryFee: 3,
    lines: [line({ removed_ingredients: ["Onion"] })],
  });
  assert.equal(payload.delivery_fee, 3, "the delivery fee still rides on the order");
  assert.equal(payload.customer_id, "c1");
  assert.equal(payload.address_id, "a1");
  assert.deepEqual(payload.items[0].customization_json, { removed_menu_ingredients: ["Onion"] });
});

// --- kitchen-facing text -----------------------------------------------------

test("a removal reads as `No Tomato`, in one place, everywhere", () => {
  assert.equal(removalLabel("Tomato"), "No Tomato");
  assert.equal(removalSummary(["Tomato", "Pickles"]), "No Tomato, No Pickles");
});

test("removals lead the kitchen note, and survive alongside a typed one", () => {
  assert.equal(kitchenNoteFor({ removed: ["Tomato"], note: null }), "NO TOMATO");
  assert.equal(kitchenNoteFor({ removed: ["Tomato", "Pickles"], note: "Well done" }), "NO TOMATO · NO PICKLES · Well done");
  assert.equal(kitchenNoteFor({ removed: [], note: "Well done" }), "Well done");
  assert.equal(kitchenNoteFor({ removed: [], note: null }), null);
});

// --- cart merge & isolation --------------------------------------------------

test("two lines of the same item with DIFFERENT removals do not merge", () => {
  assert.equal(sameRemovals(["Tomato", "Pickles"], ["Pickles", "Tomato"]), true, "order must not matter");
  assert.equal(sameRemovals(["Tomato"], []), false);
  assert.equal(sameRemovals(undefined, []), true);
  const cart = useCart.getState();
  cart.addLine({ menuItemId: "i-burger", name: "Burger", basePrice: 12 });
  cart.addLine({ menuItemId: "i-burger", name: "Burger", basePrice: 12, removedIngredients: ["Tomato"] });
  assert.equal(useCart.getState().lines.length, 2, "plain and no-tomato are distinct lines");
});

test("the same item with the SAME removals merges and preserves quantity", () => {
  const cart = useCart.getState();
  cart.addLine({ menuItemId: "i-burger", name: "Burger", basePrice: 12, quantity: 2, removedIngredients: ["Tomato"] });
  cart.addLine({ menuItemId: "i-burger", name: "Burger", basePrice: 12, quantity: 1, removedIngredients: ["Tomato"] });
  const lines = useCart.getState().lines;
  assert.equal(lines.length, 1);
  assert.equal(lines[0].quantity, 3);
  assert.deepEqual(lines[0].removed_ingredients, ["Tomato"]);
});

test("removing an ingredient changes NO canonical record and no price", () => {
  const withRemoval = line({ removed_ingredients: ["Tomato"], kitchen_note: "Well done" });
  assert.equal(withRemoval.menu_item_id, BURGER.id);
  assert.equal(lineTotals(withRemoval.base_price, [], withRemoval.quantity).lineTotal, 12);
  // the standalone typed note coexists with the removal
  assert.equal(withRemoval.kitchen_note, "Well done");
  assert.deepEqual(withRemoval.removed_ingredients, ["Tomato"]);
  const source = stripComments(read("src/lib/pos/itemOptions.ts"));
  for (const forbidden of ["price_delta", "discount", "set_menu_item_price"]) {
    assert.equal(source.includes(forbidden), false, `a removal must not touch ${forbidden}`);
  }
});

// --- the terminal switch -----------------------------------------------------

test("the terminal switch defaults OFF", () => {
  assert.deepEqual(POS_FEATURE_DEFAULTS, { ingredientCustomization: false, categorizedMenu: false, preferFloorView: false });
});

test("a stored choice survives; only an ABSENT or non-boolean key gets the default", () => {
  assert.equal(parsePosFeatures(JSON.stringify({ ingredientCustomization: true })).ingredientCustomization, true);
  assert.equal(parsePosFeatures(JSON.stringify({})).ingredientCustomization, false);
  assert.equal(parsePosFeatures(JSON.stringify({ ingredientCustomization: "yes" })).ingredientCustomization, false);
  for (const raw of ["", "{", "null", "[]", '"x"']) assert.deepEqual(parsePosFeatures(raw), POS_FEATURE_DEFAULTS);
  assert.deepEqual(readPosFeatures(memoryStorage()), POS_FEATURE_DEFAULTS);
});

test("writing then reading round-trips through storage", () => {
  const store = memoryStorage();
  writePosFeatures({ ingredientCustomization: true }, store);
  assert.equal(readPosFeatures(store).ingredientCustomization, true);
});

test("the floor-view preference defaults OFF and round-trips per field (Floor Map Phase 2)", () => {
  // Per-terminal Map|List preference; default List, ignored when pos.floor_map is off.
  assert.equal(parsePosFeatures("{}").preferFloorView, false);
  assert.equal(parsePosFeatures(JSON.stringify({ preferFloorView: true })).preferFloorView, true);
  assert.equal(parsePosFeatures(JSON.stringify({ preferFloorView: "yes" })).preferFloorView, false);
});

// --- prod-native menu enrichment (OU isolation preserved) --------------------

test("mergeIngredients enriches only the items the OU projection returned", () => {
  const menu: MenuData = {
    categories: [],
    items: [{ id: "a", name: "A", price: 1, category_id: null, image_url: null }, { id: "b", name: "B", price: 2, category_id: null, image_url: null }],
    groups: [],
    options: [],
    groupsByItem: {},
  };
  const byId = new Map<string, string[] | null>([["a", ["Bun", "Beef"]]]);
  const out = mergeIngredients(menu, byId);
  assert.deepEqual(out.items[0].ingredients, ["Bun", "Beef"]);
  assert.equal(out.items[1].ingredients, undefined, "an item not in the map is untouched");
  assert.equal(out.items.length, menu.items.length, "the item SET is never changed - OU isolation intact");
});

test("mergeIngredients is fail-soft: an empty map leaves the menu unchanged", () => {
  const menu: MenuData = { categories: [], items: [{ id: "a", name: "A", price: 1, category_id: null, image_url: null }], groups: [], options: [], groupsByItem: {} };
  assert.equal(mergeIngredients(menu, new Map()), menu);
});

// --- UI wiring (one popup, gated on the switch) ------------------------------

test("with the switch OFF the add-item path reduces to the pre-existing condition", () => {
  const workspace = read("src/screens/pos/PosWorkspace.tsx");
  assert.match(workspace, /groups\.length > 0 \|\| offersIngredients/);
  assert.match(workspace, /features\.ingredientCustomization && hasIngredients\(item\)/);
});

test("ONE popup - ingredients share the existing modifier dialog", () => {
  const workspace = read("src/screens/pos/PosWorkspace.tsx");
  assert.equal((workspace.match(/<ModifierDialog/g) ?? []).length, 1);
  assert.equal(workspace.includes("<IngredientDialog"), false);
  const dialog = read("src/components/pos/ModifierDialog.tsx");
  assert.match(dialog, /ingredientCustomization/);
});

const REM_TOMATO: RecipeRemovable = { materialId: "m-tomato", name: "Tomato", quantity: 40, unitId: "u-g", wastePercent: 0 };
const REM_CHEESE: RecipeRemovable = { materialId: "m-cheese", name: "Cheese", quantity: 30, unitId: "u-g", wastePercent: 5 };

test("FT4: material removals serialize into the Cost Control channel, keyed by material id", () => {
  const removed = toggleMaterialRemoval([], REM_TOMATO, null);
  const custom = buildLineCustomization({ removedMaterials: removed });
  assert.deepEqual(custom, {
    removed_ingredients: [{ material_id: "m-tomato", modifier_option_id: null, quantity: 40, unit_id: "u-g", waste_percent: 0 }],
  });
  assert.equal("removed_menu_ingredients" in (custom as object), false, "no descriptive names when only a material removal");
});

test("FT4: both channels coexist and never collide", () => {
  const custom = buildLineCustomization({ removedNames: ["Extra napkin"], removedMaterials: toggleMaterialRemoval([], REM_CHEESE, null) });
  assert.deepEqual(custom?.removed_menu_ingredients, ["Extra napkin"]);
  assert.deepEqual(custom?.removed_ingredients, [{ material_id: "m-cheese", modifier_option_id: null, quantity: 30, unit_id: "u-g", waste_percent: 5 }]);
});

test("FT4: nothing removed is still null (byte-identical to a plain line)", () => {
  assert.equal(buildLineCustomization({}), null);
  assert.equal(buildLineCustomization({ removedNames: [], removedMaterials: [] }), null);
});

test("FT4: a material removal reaches the order payload in the Cost Control channel", () => {
  const payload = buildSubmitPayload({
    branchId: "b", shiftId: "s", orderType: "takeaway", clientOpId: "op",
    lines: [line({ removed_materials: [{ materialId: "m-tomato", name: "Tomato", quantity: 40, unitId: "u-g", wastePercent: 0, modifierOptionId: null }] })],
  });
  assert.deepEqual(payload.items[0].customization_json?.removed_ingredients, [
    { material_id: "m-tomato", modifier_option_id: null, quantity: 40, unit_id: "u-g", waste_percent: 0 },
  ]);
});

test("FT4: toggle is keyed by material id; reconcile drops a material no longer removable", () => {
  let removed = toggleMaterialRemoval([], REM_TOMATO, null);
  removed = toggleMaterialRemoval(removed, REM_CHEESE, null);
  assert.equal(removed.length, 2);
  removed = toggleMaterialRemoval(removed, REM_TOMATO, null);
  assert.deepEqual(removed.map((r) => r.materialId), ["m-cheese"]);
  assert.deepEqual(reconcileMaterialRemovals(removed, [REM_TOMATO], null), []);
});

test("FT4: reconcile re-captures quantity/unit from the CURRENT recipe (no stale qty)", () => {
  const stale: RemovedMaterial = { materialId: "m-tomato", name: "Tomato", quantity: 999, unitId: "u-old", wastePercent: 99, modifierOptionId: null };
  const [fresh] = reconcileMaterialRemovals([stale], [REM_TOMATO], null);
  assert.equal(fresh.quantity, 40);
  assert.equal(fresh.unitId, "u-g");
  assert.equal(fresh.wastePercent, 0);
});

test("FT4: pivotRemovables keys by item, drops rows with no branch material instance", () => {
  const rows: RecipeRemovableRow[] = [
    { menu_item_id: "i-burger", material_id: "m-tomato", unit_id: "u-g", quantity: 40, waste_percent: 0, cost_materials: { name: "Tomato" } },
    { menu_item_id: "i-burger", material_id: null, unit_id: "u-g", quantity: 10, waste_percent: 0, cost_materials: { name: "Unmapped" } },
    { menu_item_id: "i-pizza", material_id: "m-cheese", unit_id: "u-g", quantity: 30, waste_percent: 5, cost_materials: { name: "Cheese" } },
  ];
  const by = pivotRemovables(rows);
  assert.deepEqual(by["i-burger"], [{ materialId: "m-tomato", name: "Tomato", quantity: 40, unitId: "u-g", wastePercent: 0 }]);
  assert.equal(by["i-pizza"].length, 1);
});

test("FT4: cart merges same material removal, splits on different, preserves qty", () => {
  const cart = useCart.getState();
  const tom: RemovedMaterial[] = [{ materialId: "m-tomato", name: "Tomato", quantity: 40, unitId: "u-g", wastePercent: 0, modifierOptionId: null }];
  cart.addLine({ menuItemId: "i-burger", name: "Burger", basePrice: 12, quantity: 2, removedMaterials: tom });
  cart.addLine({ menuItemId: "i-burger", name: "Burger", basePrice: 12, quantity: 1, removedMaterials: tom });
  assert.equal(useCart.getState().lines.length, 1, "same material removal merges");
  assert.equal(useCart.getState().lines[0].quantity, 3);
  cart.addLine({ menuItemId: "i-burger", name: "Burger", basePrice: 12, removedMaterials: [{ materialId: "m-cheese", name: "Cheese", quantity: 30, unitId: "u-g", wastePercent: 5, modifierOptionId: null }] });
  assert.equal(useCart.getState().lines.length, 2, "different material removal is a distinct line");
});

test("FT4: sameMaterialRemovals is order-insensitive and id-keyed", () => {
  const a: RemovedMaterial[] = [{ materialId: "m1", name: "A", quantity: 1, unitId: "u", wastePercent: 0, modifierOptionId: null }, { materialId: "m2", name: "B", quantity: 1, unitId: "u", wastePercent: 0, modifierOptionId: null }];
  const b: RemovedMaterial[] = [a[1], a[0]];
  assert.equal(sameMaterialRemovals(a, b), true);
  assert.equal(sameMaterialRemovals(a, [a[0]]), false);
  assert.equal(sameMaterialRemovals(undefined, []), true);
});

test("FT4: an item with no recipe removables keeps the text-only channel (fallback preserved)", () => {
  const custom = buildCustomization(["Tomato", "Pickles"]);
  assert.deepEqual(custom, { removed_menu_ingredients: ["Tomato", "Pickles"] });
  assert.equal("removed_ingredients" in (custom as object), false);
});
