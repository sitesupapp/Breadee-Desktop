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
  hasIngredients,
  ingredientsOf,
  kitchenNoteFor,
  removalLabel,
  removalSummary,
  sameRemovals,
} from "@/lib/pos/itemOptions";
import { POS_FEATURE_DEFAULTS, parsePosFeatures, readPosFeatures, writePosFeatures } from "@/lib/pos/posFeatures";
import { buildSubmitPayload } from "@/lib/pos/orders";
import { mergeIngredients } from "@/lib/pos/menu";
import { lineTotals } from "@/lib/pos/modifiers";
import { useCart } from "@/state/cart";
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
