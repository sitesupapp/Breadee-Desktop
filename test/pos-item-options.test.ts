// Ingredient customization and fractional quantity.
//
// TWO INDEPENDENT FEATURES, TWO DIFFERENT KINDS OF RISK.
//
// The ingredient list must come from the MENU, not the COST SHEET. The database
// makes that easy to get wrong: `pos_order_items.customization_json` already
// carries a `removed_ingredients` array that a trigger resolves against
// `cost_materials` and turns into a costed reversal. Writing a menu ingredient
// name into that channel would be a costing instruction. So these tests pin the
// SOURCE (`menu_items.ingredients`) and the CHANNEL
// (`removed_menu_ingredients`) separately.
//
// Fractional quantity must be a REAL number all the way down. The failure worth
// preventing is a UI that accepts 0.5 while the saved order becomes 1 - the
// customer is charged double and the kitchen makes a whole pizza. So the
// arithmetic, the payload, the merge rule and every printed document are all
// asserted, and the price is asserted to come from the canonical item only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { stripJsxComments } from "./source-helpers.ts";
import {
  FRACTION_STEP,
  QUANTITY_FRACTIONS,
  buildCustomization,
  formatQuantity,
  fractionLabel,
  hasIngredients,
  ingredientsOf,
  isWholeQuantity,
  kitchenNoteFor,
  minimumQuantity,
  removalLabel,
  removalSummary,
  sameRemovals,
  snapQuantity,
  stepQuantity,
} from "@/lib/pos/itemOptions";
import { POS_FEATURE_DEFAULTS, parsePosFeatures, readPosFeatures } from "@/lib/pos/posFeatures";
import { buildSubmitPayload, cartSubtotal } from "@/lib/pos/orders";
import { lineTotals } from "@/lib/pos/modifiers";
import { buildKitchenTicket } from "@/lib/pos/kitchenPrinter";
import { buildCollectionTicket, toCollectionReport } from "@/lib/pos/collectionTicket";
import { toKitchenTicketDoc, toReceiptDoc } from "@/lib/nativePrinting";
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
  assert.equal(kitchenNoteFor({ removed: ["Tomato", "Mayonnaise"], note: "well done" }), "NO TOMATO · NO MAYONNAISE · well done");
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
// FRACTIONAL QUANTITY
// =============================================================================

test("the four portions are real numbers, not labels", () => {
  assert.deepEqual([...QUANTITY_FRACTIONS], [0.25, 0.5, 0.75, 1]);
  assert.equal(FRACTION_STEP, 0.25);
  for (const fraction of QUANTITY_FRACTIONS) assert.equal(typeof fraction, "number");
});

test("PRICE IS PRO RATA from the canonical selling price", () => {
  // The worked example from the brief: a $12 item.
  const price = 12;
  assert.equal(lineTotals(price, [], 0.25).lineTotal, 3);
  assert.equal(lineTotals(price, [], 0.5).lineTotal, 6);
  assert.equal(lineTotals(price, [], 0.75).lineTotal, 9);
  assert.equal(lineTotals(price, [], 1).lineTotal, 12);
});

test("a mixed pizza order sums correctly", () => {
  // 0.50 Pepperoni + 0.25 Sujouk + 0.25 Vegetarian, all $12.
  const lines = [
    line({ key: "a", name: "Pepperoni", quantity: 0.5 }),
    line({ key: "b", name: "Sujouk", quantity: 0.25 }),
    line({ key: "c", name: "Vegetarian", quantity: 0.25 }),
  ];
  assert.equal(cartSubtotal(lines), 12, "three portions of one pizza cost one pizza");
});

test("there is no second price source - the item's own price is used", () => {
  const source = stripJsxComments(read("src/lib/pos/itemOptions.ts"));
  for (const forbidden of ["basePrice =", "PRICE_", "priceOverride", "fractionPrice"]) {
    assert.equal(source.includes(forbidden), false, `${forbidden} would be a second price`);
  }
  // The dialog prices a portion by multiplying the canonical base price.
  const dialog = stripJsxComments(read("src/components/pos/ModifierDialog.tsx"));
  assert.match(dialog, /props\.basePrice \* fraction/);
});

test("quantities snap to the quarter grid, so binary drift never reaches an order", () => {
  assert.equal(snapQuantity(0.25 + 0.25 + 0.25), 0.75);
  assert.equal(snapQuantity(0.1 + 0.2), 0.25);
  assert.equal(snapQuantity(0.7500000000000001), 0.75);
  let q = 0;
  for (let i = 0; i < 4; i += 1) q = snapQuantity(q + 0.25);
  assert.equal(q, 1, "four quarters make exactly one");
});

test("stepping respects the mode's floor", () => {
  // Portions on: a quarter is the smallest a line may be.
  assert.equal(minimumQuantity(true), 0.25);
  assert.equal(stepQuantity(0.5, -1, true), 0.25);
  assert.equal(stepQuantity(0.25, -1, true), 0.25, "it must not fall to zero");
  assert.equal(stepQuantity(0.75, 1, true), 1);
  // Portions off: exactly today's behaviour.
  assert.equal(minimumQuantity(false), 1);
  assert.equal(stepQuantity(1, -1, false), 1, "a whole-unit till still stops at 1");
  assert.equal(stepQuantity(2, -1, false), 1);
  assert.equal(stepQuantity(1, 1, false), 2);
});

test("quantities are WRITTEN readably - never 2.00, never rounded to 1", () => {
  assert.equal(formatQuantity(1), "1");
  assert.equal(formatQuantity(2), "2");
  assert.equal(formatQuantity(0.5), "0.5");
  assert.equal(formatQuantity(0.25), "0.25");
  assert.equal(formatQuantity(0.75), "0.75");
  assert.equal(formatQuantity(1.5), "1.5");
  assert.equal(fractionLabel(0.5), "1/2");
  assert.equal(fractionLabel(0.25), "1/4");
  assert.equal(fractionLabel(0.75), "3/4");
  assert.equal(isWholeQuantity(1), true);
  assert.equal(isWholeQuantity(0.5), false);
});

test("a fraction reaches the ORDER PAYLOAD as a decimal, unrounded", () => {
  const payload = buildSubmitPayload({
    branchId: "b", shiftId: "s", orderType: "takeaway", clientOpId: "op",
    lines: [line({ quantity: 0.5 }), line({ key: "l2", quantity: 0.25 })],
  });
  assert.equal(payload.items[0].quantity, 0.5, "0.5 must not become 1");
  assert.equal(payload.items[1].quantity, 0.25);
  assert.equal(Number.isInteger(payload.items[0].quantity), false);
});

test("the payload snaps rather than rounds", () => {
  const payload = buildSubmitPayload({
    branchId: "b", shiftId: "s", orderType: "takeaway", clientOpId: "op",
    lines: [line({ quantity: 0.7500000000000001 })],
  });
  assert.equal(payload.items[0].quantity, 0.75, "drift is snapped away, not rounded up to 1");
});

test("a fraction prints on the CUSTOMER RECEIPT", () => {
  const doc = toReceiptDoc({
    businessName: "B", branchName: "Br", orderNumber: "1", orderType: "Takeaway", at: "now",
    paid: true, currency: "USD", subtotal: 6, discount: 0, total: 6,
    lines: [{ name: "Pepperoni Pizza", qty: 0.5, lineTotal: 6 }],
  });
  assert.equal(doc.lines[0].qty, 0.5, "the receipt document carries the real quantity");
});

test("a fraction prints on the STATION TICKET", () => {
  const ticket = buildKitchenTicket({
    businessName: "B", branchName: "Br", orderNumber: "1", source: "takeaway", at: "now",
    lines: [{ name: "Pepperoni Pizza", qty: 0.5 }],
  });
  assert.equal(ticket.lines[0].qty, 0.5);
  assert.equal(toKitchenTicketDoc(ticket).lines[0].qty, 0.5, "it survives the native boundary");
});

test("a fraction prints on the COLLECTION TICKET, formatted", () => {
  const report = toCollectionReport(
    buildCollectionTicket({
      businessName: "B", branchName: "Br", orderNumber: "1257", source: "takeaway", at: "now",
      lines: [{ name: "Pepperoni Pizza", qty: 0.5 }, { name: "Cola", qty: 2 }],
    }),
  );
  const pizza = report.lines.find((l) => l.label === "Pepperoni Pizza");
  const cola = report.lines.find((l) => l.label === "Cola");
  assert.equal(pizza?.value, "x0.5", "half a pizza is half a pizza on the docket");
  assert.equal(cola?.value, "x2", "and a whole number stays whole");
});

test("a zero-quantity line is still dropped from every document", () => {
  const ticket = buildKitchenTicket({
    businessName: "B", branchName: "Br", orderNumber: "1", source: "takeaway", at: "now",
    lines: [{ name: "Gone", qty: 0 }, { name: "Kept", qty: 0.25 }],
  });
  assert.deepEqual(ticket.lines.map((l) => l.name), ["Kept"]);
});

test("the native layer was already decimal - no Rust change was needed", () => {
  // Verified rather than assumed: `qty` is f64 and `format_qty` renders 1.5.
  const kitchen = read("src-tauri/src/printing/kitchen.rs");
  const receipt = read("src-tauri/src/printing/receipt.rs");
  for (const source of [kitchen, receipt]) {
    assert.match(source, /pub qty: f64/, "the printed quantity has always been a float");
    assert.match(source, /fn format_qty/);
  }
  assert.match(receipt, /assert_eq!\(format_qty\(1\.5\), "1\.5"\)/, "and it was already tested");
});

// =============================================================================
// THE SWITCHES
// =============================================================================

test("the three switches are independent, and their defaults are deliberate", () => {
  assert.deepEqual(POS_FEATURE_DEFAULTS, {
    autoFit: true,
    ingredientCustomization: false,
    fractionalQuantity: false,
  });
});

test("a stored choice survives an upgrade; only an ABSENT key gets a default", () => {
  // Per-field, not wholesale: a terminal that enabled ingredients under an older
  // build must keep it while still receiving the new auto-fit default.
  const parsed = parsePosFeatures(JSON.stringify({ ingredientCustomization: true }));
  assert.equal(parsed.ingredientCustomization, true, "an explicit choice is never discarded");
  assert.equal(parsed.autoFit, true, "and a new key still gets its default");
  assert.equal(parsePosFeatures(JSON.stringify({ autoFit: false })).autoFit, false);
});

test("unreadable settings resolve to the documented defaults", () => {
  for (const raw of ["", "{", "null", "[]", '"x"', "{}"]) {
    assert.deepEqual(parsePosFeatures(raw), POS_FEATURE_DEFAULTS);
  }
  assert.deepEqual(readPosFeatures(memoryStorage()), POS_FEATURE_DEFAULTS);
});

test("only a real boolean flips a switch", () => {
  const parsed = parsePosFeatures(JSON.stringify({ fractionalQuantity: "yes", ingredientCustomization: 1 }));
  assert.equal(parsed.fractionalQuantity, false, "a truthy stray must not enable a feature");
  assert.equal(parsed.ingredientCustomization, false);
});

// =============================================================================
// BOTH FEATURES OFF = NO CHANGE
// =============================================================================

test("with both switches OFF the add-item path is what it always was", () => {
  const workspace = stripJsxComments(read("src/screens/pos/PosWorkspace.tsx"));
  // The dialog opens for a required modifier group, OR an ingredient list this
  // terminal may edit, OR a portion to choose. With both features off that
  // reduces to exactly the pre-existing condition.
  assert.match(workspace, /groups\.length > 0 \|\| offersIngredients \|\| features\.fractionalQuantity/);
  assert.match(workspace, /features\.ingredientCustomization && hasIngredients\(item\)/);
});

test("ONE popup, not two - the features share a dialog", () => {
  const workspace = stripJsxComments(read("src/screens/pos/PosWorkspace.tsx"));
  // A second modal for one tap is the thing this avoids.
  assert.equal((workspace.match(/<ModifierDialog/g) ?? []).length, 1);
  assert.equal(workspace.includes("<IngredientDialog"), false);
  assert.equal(workspace.includes("<QuantityDialog"), false);
  const dialog = stripJsxComments(read("src/components/pos/ModifierDialog.tsx"));
  assert.match(dialog, /ingredientCustomization/);
  assert.match(dialog, /fractionalQuantity/);
});

test("the features belong to the ITEM interaction, not to one layout", () => {
  // So they behave identically from Default, Categories and Customized - and
  // across Takeaway, Dine-in and Delivery, which all share this one handler.
  const workspace = stripJsxComments(read("src/screens/pos/PosWorkspace.tsx"));
  assert.equal((workspace.match(/const addItem = useCallback/g) ?? []).length, 1);
  for (const rel of [
    "src/components/pos/grid/PosLayoutGrid.tsx",
    "src/components/pos/grid/GridButtonTile.tsx",
    "src/lib/pos/grid/presentation.ts",
  ]) {
    const source = stripJsxComments(read(rel));
    for (const forbidden of ["ingredientsOf", "removedIngredients", "QUANTITY_FRACTIONS"]) {
      assert.equal(source.includes(forbidden), false, `${rel} must not implement item options itself`);
    }
  }
});
