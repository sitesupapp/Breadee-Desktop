// Ingredient removal on a POS order line: the rules, with no React.
//
// Restored from Desktop 1.0.7 (commit caaaa2b). This is the INGREDIENT slice
// only - the fractional-quantity helpers that shared the 1.0.7 file are
// deliberately NOT reintroduced, because fractional quantity is out of scope
// for this restoration and quantity here stays whole-unit exactly as HEAD had
// it.
//
// ---------------------------------------------------------------------------
// INGREDIENTS: THE SOURCE IS THE MENU, NOT THE COST SHEET
// ---------------------------------------------------------------------------
//
// The list comes from `menu_items.ingredients` - the customer-facing array the
// Menu Builder writes, the same one the public E-Menu shows. It is deliberately
// NOT `cost_materials`, not a recipe, and not inventory composition.
//
// That distinction is not pedantry, and the database makes it easy to get
// wrong: `pos_order_items.customization_json` already carries a
// `removed_ingredients` array, and a trigger (`_pos_persist_line_removals`)
// reads it, resolves each entry's `material_id` against `cost_materials`, and
// writes a costed reversal row. That channel belongs to Cost Control. Writing a
// menu ingredient NAME into it would either do nothing or, worse, be understood
// as a costing instruction.
//
// So menu-level removals travel under their own key, `removed_menu_ingredients`,
// which the costing trigger does not read. Cost Control keeps its channel, the
// menu keeps its own, and neither can be mistaken for the other.

import type { CartLine, MenuItem, SelectedModifier } from "@/types/pos";
import {
  toRemovedIngredientsPayload,
  type RemovedIngredientPayload,
  type RemovedMaterial,
} from "@/lib/pos/recipeRemovals";

// ----------------------------------------------------------- ingredients ----

/**
 * The customer-facing ingredient list for an item.
 *
 * Reads `menu_items.ingredients` (a `text[]`) defensively: the column is
 * nullable, older rows have never been written, and a hand-edited row could hold
 * anything. Blanks are dropped and entries are de-duplicated case-insensitively,
 * because two "Tomato" chips a cashier can toggle independently is a bug they
 * cannot make sense of.
 */
export function ingredientsOf(item: Pick<MenuItem, "id"> & { ingredients?: unknown }): string[] {
  const raw = (item as { ingredients?: unknown }).ingredients;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const name = entry.trim();
    if (name === "") continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/** Would the popup have anything to show for this item? */
export function hasIngredients(item: Pick<MenuItem, "id"> & { ingredients?: unknown }): boolean {
  return ingredientsOf(item).length > 0;
}

/**
 * What a removed ingredient reads as, everywhere it is shown.
 *
 * ONE function, so the cart line, the receipt, the station ticket and the
 * collection ticket cannot word it differently - a cook comparing a ticket to a
 * docket must see the same words.
 */
export function removalLabel(ingredient: string): string {
  return `No ${ingredient}`;
}

export function removalSummary(removed: string[]): string {
  return removed.map(removalLabel).join(", ");
}

// ------------------------------------------------------- the line payload ----

/**
 * `customization_json` for one order line.
 *
 * `removed_menu_ingredients` is this feature's own key. The Cost Control trigger
 * reads `removed_ingredients` and will never see this one, which is exactly the
 * separation described at the top of this file.
 */
export type LineCustomization = {
  removed_menu_ingredients?: string[];
  /**
   * FT4 — the Cost Control channel. Material-linked removals the server trigger
   * `_pos_persist_line_removals` reads to write `pos_order_item_removals`, so
   * `pos_line_material_demand` subtracts them. Present ONLY when the removal was
   * captured against a recipe material (never derived from a menu name).
   */
  removed_ingredients?: RemovedIngredientPayload[];
};

/**
 * Text-only customization (menu channel). Unchanged: a line with only descriptive
 * removals produces byte-for-byte the payload it did before FT4.
 */
export function buildCustomization(removed: string[]): LineCustomization | null {
  return buildLineCustomization({ removedNames: removed, removedMaterials: [] });
}

/**
 * FT4 — the full line customization, carrying BOTH channels:
 *   - `removed_menu_ingredients`: descriptive names (kitchen/receipt text), and
 *   - `removed_ingredients`: material-linked removals (Cost Control / inventory).
 * The two keys never collide. Emits a key only when its channel is non-empty, so
 * a line with no removals is still `null` (byte-identical to a plain line).
 */
export function buildLineCustomization(input: {
  removedNames?: string[];
  removedMaterials?: RemovedMaterial[];
}): LineCustomization | null {
  const names = (input.removedNames ?? []).map((r) => r.trim()).filter((r) => r !== "");
  const materials = input.removedMaterials ?? [];
  const out: LineCustomization = {};
  if (names.length > 0) out.removed_menu_ingredients = names;
  if (materials.length > 0) out.removed_ingredients = toRemovedIngredientsPayload(materials);
  return names.length > 0 || materials.length > 0 ? out : null;
}

/**
 * Two cart lines merge only if their removals match too.
 *
 * Without this, a plain burger and a no-tomato burger would stack into one line
 * of two and the kitchen would make two of whichever the first one was.
 */
export function sameRemovals(a: string[] | null | undefined, b: string[] | null | undefined): boolean {
  const left = [...(a ?? [])].sort();
  const right = [...(b ?? [])].sort();
  return left.length === right.length && left.every((value, i) => value === right[i]);
}

/**
 * The kitchen-facing note for a line, combining removals with a typed note.
 *
 * Removals come FIRST: "NO TOMATO" is an instruction that changes what is made,
 * and it must not be pushed off the end of a line by a longer free-text note.
 * Upper-cased because a cook reads a ticket at a glance from a metre away.
 */
export function kitchenNoteFor(input: { removed: string[]; note: string | null }): string | null {
  const removals = input.removed.map((r) => removalLabel(r).toUpperCase());
  const typed = input.note?.trim();
  const parts = [...removals, ...(typed ? [typed] : [])];
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Everything one confirmed item-options dialog produces. */
export type ItemOptionsResult = {
  modifiers: SelectedModifier[];
  quantity: number;
  /** The cashier's free text, kept separate from the removals. */
  note: string | null;
  /** Menu Builder ingredient names the cashier switched off (descriptive / text). */
  removedIngredients: string[];
  /**
   * FT4 — material-linked removals captured against the item's recipe removables
   * (empty when the item has no recipe removables; then only text names apply).
   */
  removedMaterials: RemovedMaterial[];
};

/** Does a line carry any menu-ingredient removal? */
export function lineRemovals(line: Pick<CartLine, "removed_ingredients">): string[] {
  return line.removed_ingredients ?? [];
}
