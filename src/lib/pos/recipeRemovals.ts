// FT4 — Web/Desktop removal parity: material-linked ingredient removals.
//
// This is the Desktop mirror of the web POS model (src/lib/pos/recipeVariant.ts).
// Removals here are keyed by MATERIAL IDENTITY (material_id), never by name — the
// server trigger `_pos_persist_line_removals` reads `customization_json.removed_ingredients`
// and resolves each entry's `material_id` against `cost_materials`, and
// `pos_line_material_demand` subtracts it from the resolved recipe. A tampered or
// name-guessed payload cannot cut COGS: the server re-validates every removal
// against the resolved recipe (`_assert_order_item_removal`).
//
// The customer/kitchen TEXT channel (`removed_menu_ingredients`, from
// `menu_items.ingredients`) is preserved unchanged and travels alongside — the two
// keys never collide, exactly as itemOptions.ts describes.

// A removable RECIPE ingredient of a menu item, loaded branch/OU-exact from
// `menu_item_recipe_lines` (is_removable = true). Names are display only.
export type RecipeRemovable = {
  materialId: string;
  name: string;
  quantity: number;      // per ONE menu item, in unitId
  unitId: string;
  wastePercent: number;
};

// One removal the cashier switched off, captured against the recipe line by id.
export type RemovedMaterial = {
  materialId: string;
  name: string;
  quantity: number;
  unitId: string;
  wastePercent: number;
  /** The variant this removal was captured against; null = base recipe. */
  modifierOptionId: string | null;
};

/** The material-linked entry shape the server's `_pos_persist_line_removals` reads. */
export type RemovedIngredientPayload = {
  material_id: string;
  modifier_option_id: string | null;
  quantity: number;
  unit_id: string;
  waste_percent: number;
};

export function removableToRemoved(r: RecipeRemovable, modifierOptionId: string | null): RemovedMaterial {
  return {
    materialId: r.materialId,
    name: r.name,
    quantity: r.quantity,
    unitId: r.unitId,
    wastePercent: r.wastePercent,
    modifierOptionId,
  };
}

/** Toggle one removable, keyed by material id (never by name). */
export function toggleMaterialRemoval(
  removed: RemovedMaterial[],
  r: RecipeRemovable,
  modifierOptionId: string | null,
): RemovedMaterial[] {
  if (removed.some((x) => x.materialId === r.materialId)) {
    return removed.filter((x) => x.materialId !== r.materialId);
  }
  return [...removed, removableToRemoved(r, modifierOptionId)];
}

/**
 * Re-validate removals against the current removable set (e.g. the item changed).
 * A removal survives ONLY when the same material is still removable; its
 * quantity/unit/waste are re-captured from the CURRENT line so a stale quantity
 * can never reach an order. Never produces duplicates. Mirrors web reconcileRemovals.
 */
export function reconcileMaterialRemovals(
  removed: RemovedMaterial[],
  removables: RecipeRemovable[],
  modifierOptionId: string | null,
): RemovedMaterial[] {
  const byMaterial = new Map(removables.map((r) => [r.materialId, r]));
  const seen = new Set<string>();
  const out: RemovedMaterial[] = [];
  for (const x of removed) {
    const r = byMaterial.get(x.materialId);
    if (!r || seen.has(x.materialId)) continue;
    seen.add(x.materialId);
    out.push(removableToRemoved(r, modifierOptionId));
  }
  return out;
}

/** The authoritative material-linked payload for the removal channel. */
export function toRemovedIngredientsPayload(removed: RemovedMaterial[]): RemovedIngredientPayload[] {
  return removed.map((x) => ({
    material_id: x.materialId,
    modifier_option_id: x.modifierOptionId,
    quantity: x.quantity,
    unit_id: x.unitId,
    waste_percent: x.wastePercent,
  }));
}

/** Two lines merge only if their material removals match too (by material id). */
export function sameMaterialRemovals(
  a: RemovedMaterial[] | null | undefined,
  b: RemovedMaterial[] | null | undefined,
): boolean {
  const left = [...(a ?? [])].map((x) => x.materialId).sort();
  const right = [...(b ?? [])].map((x) => x.materialId).sort();
  return left.length === right.length && left.every((v, i) => v === right[i]);
}
