// Ingredient removal and fractional quantity: the rules, with no React.
//
// TWO INDEPENDENT FEATURES THAT SHARE ONE DIALOG. They are switched separately
// because a pizzeria wants halves and a burger bar wants "no tomato", and
// neither wants the other's popup. They share a dialog because a cashier who has
// enabled both must not be shown two modals in a row for one tap.
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
//
// ---------------------------------------------------------------------------
// FRACTIONAL QUANTITY IS A REAL NUMBER
// ---------------------------------------------------------------------------
//
// Half a pizza is `quantity = 0.5`, not `quantity = 1` with the word "half" in
// a note. A note cannot be multiplied by a price, summed into a subtotal,
// consumed proportionally from stock, or reported on - and every one of those is
// something the business does with this number.
//
// Verified against the deployed contract rather than assumed:
//   * `pos_order_items.quantity` is `numeric` with no scale limit, default 1
//   * `pos_save_order` casts it `(it->>'quantity')::numeric` - note that the
//     MODIFIER quantity beside it is cast `::int`, so the distinction is
//     deliberate and this one is genuinely decimal
//   * the line total is `v_fup * v_qty`, so price is already proportional
//   * `_pos_item_stamp_cost` multiplies the cost snapshot by `NEW.quantity`
//   * inventory demand is "removal-adjusted and multiplied by" the line quantity
// Nothing needed changing server-side; the desktop simply stops assuming whole
// units.

import type { CartLine, MenuItem, SelectedModifier } from "@/types/pos";

// ------------------------------------------------------------ quantities ----

/** The fast portions a cashier taps. Real numbers, not labels. */
export const QUANTITY_FRACTIONS = [0.25, 0.5, 0.75, 1] as const;
export type QuantityFraction = (typeof QUANTITY_FRACTIONS)[number];

/** The smallest slice the till offers, and the grid every quantity snaps to. */
export const FRACTION_STEP = 0.25;

/**
 * Round a quantity onto the quarter grid.
 *
 * Binary floating point cannot hold 0.1, and repeated `+= 0.25` drifts; snapping
 * keeps 0.75 exactly 0.75 rather than 0.7500000000000001, which matters because
 * this number is serialised into an order payload and compared in tests.
 */
export function snapQuantity(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.round(value / FRACTION_STEP) * FRACTION_STEP;
}

/** Portion labels a cashier reads. `0.5` is "1/2", `1.5` is "1.5". */
export function fractionLabel(value: number): string {
  const snapped = snapQuantity(value);
  if (snapped === 0.25) return "1/4";
  if (snapped === 0.5) return "1/2";
  if (snapped === 0.75) return "3/4";
  if (Number.isInteger(snapped)) return String(snapped);
  return snapped.toFixed(2);
}

/**
 * How a quantity is written on paper and on screen.
 *
 * A whole number prints as `2`, never `2.00`; a fraction prints as `0.5`, never
 * rounded to `1` and never dropped. Both halves of that matter: `1` on a ticket
 * for half a pizza is a whole pizza made, and a missing quantity is a line the
 * kitchen has to guess at.
 */
export function formatQuantity(value: number): string {
  const snapped = snapQuantity(value);
  if (Number.isInteger(snapped)) return String(snapped);
  // Trailing zeros trimmed: 0.50 -> 0.5, which is what a cook reads fastest.
  return String(Number(snapped.toFixed(2)));
}

/** Is this a whole number of items? Used to keep the OFF path byte-identical. */
export function isWholeQuantity(value: number): boolean {
  return Number.isInteger(snapQuantity(value));
}

/**
 * The minimum a line may be reduced to.
 *
 * A quarter when fractions are on, one when they are off - so the existing
 * `-` button on a whole-unit till still stops at 1 exactly as it does today.
 */
export function minimumQuantity(fractionsEnabled: boolean): number {
  return fractionsEnabled ? FRACTION_STEP : 1;
}

/** Step a quantity up or down, respecting the mode's floor. */
export function stepQuantity(current: number, direction: 1 | -1, fractionsEnabled: boolean): number {
  const step = fractionsEnabled ? FRACTION_STEP : 1;
  return Math.max(minimumQuantity(fractionsEnabled), snapQuantity(current + step * direction));
}

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
};

export function buildCustomization(removed: string[]): LineCustomization | null {
  const clean = removed.map((r) => r.trim()).filter((r) => r !== "");
  return clean.length > 0 ? { removed_menu_ingredients: clean } : null;
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
  /** Menu Builder ingredient names the cashier switched off. */
  removedIngredients: string[];
};

/** Does a line carry any menu-ingredient removal? */
export function lineRemovals(line: Pick<CartLine, "removed_ingredients">): string[] {
  return line.removed_ingredients ?? [];
}
