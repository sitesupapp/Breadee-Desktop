// Ingredient customization on a POS order line.
//
// Restored from Desktop 1.0.7 (commit caaaa2b) as the INGREDIENT slice only.
// The 1.0.7 file also exercised fractional quantity and the Layout V2 grid;
// neither is part of this restoration, so their tests are not reintroduced.
//
// The ingredient list must come from the MENU, not the COST SHEET. The database
// makes that easy to get wrong: `pos_order_items.customization_json` already
// carries a `removed_ingredients` array that a trigger resolves against
// `cost_materials` and turns into a costed reversal. Writing a menu ingredient
// name into that channel would be a costing instruction. So these tests pin the
// SOURCE (`menu_items.ingredients`) and the CHANNEL (`removed_menu_ingredients`)
// separately.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { stripJsxComments } from "./source-helpers.ts";
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
import { lineTotals } from "@/lib/pos/modifiers";
import { buildKitchenTicket } from "@/lib/pos/kitchenPrinter";
import { toKitchenTicketDoc } from "@/lib/nativePrinting";
import type { CartLine, MenuItem } from "@/types/pos";

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
  ingredients: ["Bun", "Beef", "Mozzarella", "Tomato", "Iceberg", "Mayonnaise"],
};

function line(over: Partial<CartLine> = {}): CartLine {
  return {
    key: "line-1",
    menu_item_id: "i-burger",
    name: "Burger",
    base_price: 12,
    quantity: 1,
    kitchen_note: null,
    modifiers: [],
    ...over,
  };
}

// =============================================================================
// INGREDIENTS
// =============================================================================

test("the list comes from menu_items.ingredients - the Menu Builder array", () => {
  assert.deepEqual(ingredientsOf(BURGER), ["Bun", "Beef", "Mozzarella", "Tomato", "Iceberg", "Mayonnaise"]);
  assert.equal(hasIngredients(BURGER), true);
});

test("an item with no ingredients offers no customization, and does not crash", () => {
  for (const value of [undefined, null, [], "Bun, Beef", 42, {}]) {
    const item = { ...BURGER, ingredients: value } as unknown as MenuItem;
    assert.deepEqual(ingredientsOf(item), [], `${JSON.stringify(value)} must yield no ingredients`);
    assert.equal(hasIngredients(item), false);
  }
});

test("blanks are dropped and duplicates collapse, case-insensitively", () => {
  const messy = { ...BURGER, ingredients: ["Bun", " ", "bun", "Beef", "BEEF", ""] } as MenuItem;
  // Two "Bun" chips a cashier can toggle independently is a bug they cannot
  // make sense of.
  assert.deepEqual(ingredientsOf(messy), ["Bun", "Beef"]);
});

test("COST CONTROL is not the source, and cannot leak into the popup", () => {
  const source = stripJsxComments(read("src/lib/pos/itemOptions.ts"));
  for (const forbidden of ["cost_materials", "material_id", "recipe", "waste_percent", "unit_id", "base_unit"]) {
    assert.equal(source.includes(forbidden), false, `the ingredient source must not reference ${forbidden}`);
  }
  // It reads exactly one field, and it is the customer-facing one.
  assert.match(source, /ingredients/);
  const dialog = stripJsxComments(read("src/components/pos/ModifierDialog.tsx"));
  assert.match(dialog, /ingredientsOf\(props\.item\)/, "the popup asks the one helper");
  for (const forbidden of ["cost_materials", "material_id", "costing_modifier_group_id"]) {
    assert.equal(dialog.includes(forbidden), false, `the popup must not reference ${forbidden}`);
  }
});

test("removals travel in their OWN channel, not Cost Control's", () => {
  // `removed_ingredients` is read by `_pos_persist_line_removals`, which
  // resolves `material_id` against `cost_materials` and writes a costed
  // reversal. Menu-level removals must not land there.
  const custom = buildCustomization(["Tomato", "Mayonnaise"]);
  assert.deepEqual(custom, { removed_menu_ingredients: ["Tomato", "Mayonnaise"] });
  assert.equal("removed_ingredients" in (custom as object), false, "the costing channel must be untouched");
});

test("nothing to remove means no customization at all on the payload", () => {
  assert.equal(buildCustomization([]), null);
  assert.equal(buildCustomization(["", "  "]), null);
  const payload = buildSubmitPayload({
    branchId: "b", shiftId: "s", orderType: "takeaway", clientOpId: "op", lines: [line()],
  });
  assert.equal("customization_json" in payload.items[0], false, "an ordinary order is byte-identical to before");
});

test("a removal reaches the order payload structurally", () => {
  const payload = buildSubmitPayload({
    branchId: "b", shiftId: "s", orderType: "takeaway", clientOpId: "op",
    lines: [line({ removed_ingredients: ["Tomato"] })],
  });
  assert.deepEqual(payload.items[0].customization_json, { removed_menu_ingredients: ["Tomato"] });
});

test("a removal reads as `No Tomato`, in one place, everywhere", () => {
  assert.equal(removalLabel("Tomato"), "No Tomato");
  assert.equal(removalSummary(["Tomato", "Mayonnaise"]), "No Tomato, No Mayonnaise");
});

test("removals lead the kitchen note, and survive alongside a typed one", () => {
  // "NO TOMATO" changes what is made; it must not be pushed off the end of a
  // thermal line by a longer free-text note.
  assert.equal(kitchenNoteFor({ removed: ["Tomato"], note: null }), "NO TOMATO");
  assert.equal(
    kitchenNoteFor({ removed: ["Tomato", "Mayonnaise"], note: "well done" }),
    "NO TOMATO · NO MAYONNAISE · well done",
  );
  assert.equal(kitchenNoteFor({ removed: [], note: "well done" }), "well done");
  assert.equal(kitchenNoteFor({ removed: [], note: null }), null);
});

test("multiple removals all survive to the station ticket", () => {
  const ticket = buildKitchenTicket({
    businessName: "B", branchName: "Br", orderNumber: "1", source: "takeaway", at: "now",
    lines: [{ name: "Burger", qty: 1, note: kitchenNoteFor({ removed: ["Tomato", "Mayonnaise"], note: null }) }],
  });
  const printed = JSON.stringify(toKitchenTicketDoc(ticket));
  assert.ok(printed.includes("NO TOMATO"), "the kitchen must be told what was removed");
  assert.ok(printed.includes("NO MAYONNAISE"));
});

test("two lines of the same item with DIFFERENT removals do not merge", () => {
  // Without this a plain burger and a no-tomato burger stack into one line of
  // two, and the kitchen makes two of whichever came first.
  assert.equal(sameRemovals(["Tomato"], ["Tomato"]), true);
  assert.equal(sameRemovals(["Tomato", "Bun"], ["Bun", "Tomato"]), true, "order must not matter");
  assert.equal(sameRemovals(["Tomato"], []), false);
  assert.equal(sameRemovals(undefined, []), true);
  assert.equal(sameRemovals(["Tomato"], ["Mayonnaise"]), false);
  // And the cart applies it - asserted at the source, since the store is where
  // the merge decision lives.
  const cart = stripJsxComments(read("src/state/cart.ts"));
  assert.match(cart, /sameRemovals\(a\.removed_ingredients, removed\)/);
});

test("removing an ingredient changes NO canonical record and no price", () => {
  const withRemoval = line({ removed_ingredients: ["Tomato"] });
  // Same item, same price, same totals - a removal is not a discount.
  assert.equal(withRemoval.menu_item_id, BURGER.id);
  assert.equal(lineTotals(withRemoval.base_price, [], withRemoval.quantity).lineTotal, 12);
  const source = stripJsxComments(read("src/lib/pos/itemOptions.ts"));
  for (const forbidden of ["price_delta", "discount", "set_menu_item_price"]) {
    assert.equal(source.includes(forbidden), false, `a removal must not touch ${forbidden}`);
  }
});

// =============================================================================
// THE SWITCH
// =============================================================================

test("the terminal switch defaults OFF", () => {
  assert.deepEqual(POS_FEATURE_DEFAULTS, { ingredientCustomization: false });
});

test("a stored choice survives; only an ABSENT key gets the default", () => {
  // Per-field, not wholesale: a terminal that enabled ingredients under an
  // older build keeps it.
  assert.equal(parsePosFeatures(JSON.stringify({ ingredientCustomization: true })).ingredientCustomization, true);
  assert.equal(parsePosFeatures(JSON.stringify({})).ingredientCustomization, false, "absent means default");
});

test("unreadable settings resolve to the documented defaults", () => {
  for (const raw of ["", "{", "null", "[]", '"x"', "{}"]) {
    assert.deepEqual(parsePosFeatures(raw), POS_FEATURE_DEFAULTS);
  }
  assert.deepEqual(readPosFeatures(memoryStorage()), POS_FEATURE_DEFAULTS);
});

test("only a real boolean flips the switch", () => {
  assert.equal(parsePosFeatures(JSON.stringify({ ingredientCustomization: 1 })).ingredientCustomization, false);
  assert.equal(parsePosFeatures(JSON.stringify({ ingredientCustomization: "yes" })).ingredientCustomization, false);
});

test("writing then reading round-trips through storage", () => {
  const store = memoryStorage();
  writePosFeatures({ ingredientCustomization: true }, store);
  assert.equal(readPosFeatures(store).ingredientCustomization, true);
});

// =============================================================================
// SWITCH OFF = NO CHANGE, AND ISOLATION FROM THE GRID
// =============================================================================

test("with the switch OFF the add-item path is what it always was", () => {
  const workspace = stripJsxComments(read("src/screens/pos/PosWorkspace.tsx"));
  // The dialog opens for a required modifier group OR, when this terminal
  // enables it, an ingredient list. With the switch off that reduces to exactly
  // the pre-existing `groups.length > 0` condition.
  assert.match(workspace, /groups\.length > 0 \|\| offersIngredients/);
  assert.match(workspace, /features\.ingredientCustomization && hasIngredients\(item\)/);
});

test("ONE popup - ingredients share the existing modifier dialog", () => {
  const workspace = stripJsxComments(read("src/screens/pos/PosWorkspace.tsx"));
  assert.equal((workspace.match(/<ModifierDialog/g) ?? []).length, 1);
  assert.equal(workspace.includes("<IngredientDialog"), false);
  const dialog = stripJsxComments(read("src/components/pos/ModifierDialog.tsx"));
  assert.match(dialog, /ingredientCustomization/);
});

test("the feature belongs to the ITEM interaction, not to the grid", () => {
  // The grid components just call `addItem`; they must know nothing about
  // ingredients, so the behaviour is identical whichever grid is on screen.
  const workspace = stripJsxComments(read("src/screens/pos/PosWorkspace.tsx"));
  assert.equal((workspace.match(/const addItem = useCallback/g) ?? []).length, 1);
  for (const rel of ["src/components/pos/MenuItemGrid.tsx", "src/components/pos/grid/CustomGrid.tsx"]) {
    const source = stripJsxComments(read(rel));
    for (const forbidden of ["ingredientsOf", "removedIngredients", "removed_menu_ingredients"]) {
      assert.equal(source.includes(forbidden), false, `${rel} must not reference ${forbidden}`);
    }
  }
});

test("the existing kitchen note is untouched - both notes coexist on a line", () => {
  // The item note (`kitchen_note` + LineNoteDialog) predates this feature and
  // must remain. A line can carry both a removal and a typed note.
  const withBoth = line({ removed_ingredients: ["Tomato"], kitchen_note: "well done" });
  assert.equal(withBoth.kitchen_note, "well done");
  assert.deepEqual(withBoth.removed_ingredients, ["Tomato"]);
  const workspace = stripJsxComments(read("src/screens/pos/PosWorkspace.tsx"));
  assert.match(workspace, /<LineNoteDialog/, "the standalone note editor is still mounted");
});
