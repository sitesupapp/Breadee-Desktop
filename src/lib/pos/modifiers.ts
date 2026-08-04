// POS modifier-selection rules - ported from the web app's
// `src/lib/pos/modifierSelection.ts` (IL2-001).
//
// One implementation of the selection semantics: how toggling an option changes
// the selected set, and which configuration rules a line must satisfy before it
// may be added to the cart. The server enforces the same rules independently at
// order submission (m241); this module only makes the UI honest so a cashier
// never hits the server error.
//
// Selection is tracked by modifier-group ID + modifier-option ID - never by
// names or positions.

import type { ModifierGroup, ModifierOption, SelectedModifier } from "@/types/pos";

export const isSingleSelect = (g: ModifierGroup) => g.selection_type === "single";

/** Lower bound of selections a group demands (required flag OR min_select). */
export const requiredMin = (g: ModifierGroup) => Math.max(Number(g.min_select) || 0, g.is_required ? 1 : 0);

/** Upper bound (single => 1; multi => max_select when it is a positive number). */
export const allowedMax = (g: ModifierGroup): number | null => {
  if (isSingleSelect(g)) return 1;
  const m = Number(g.max_select) || 0;
  return m >= 1 ? m : null;
};

/**
 * Toggle `option` in the selected set.
 * - Already selected -> deselect (a required group is then caught by validation,
 *   not by trapping the click).
 * - Single-select group -> REPLACE any existing selection of the same group.
 * - Multi-select group -> append (min/max enforced by validation, so the user
 *   sees the message rather than having clicks silently swallowed).
 * Never produces two selections of the same option.
 */
export function toggleModifier(
  selected: SelectedModifier[],
  option: Pick<ModifierOption, "id" | "modifier_group_id" | "name">,
  group: ModifierGroup | undefined,
  priceDelta: number,
): SelectedModifier[] {
  const isOn = selected.some((m) => m.option_id === option.id);
  if (isOn) return selected.filter((m) => m.option_id !== option.id);
  const base = group && isSingleSelect(group) ? selected.filter((m) => m.group_id !== group.id) : selected;
  return [
    ...base,
    { group_id: option.modifier_group_id, option_id: option.id, name: option.name, price_delta: priceDelta, quantity: 1 },
  ];
}

export type GroupViolation = { group_id: string; group_name: string; message: string };

/**
 * Validate a line's selections against every group ATTACHED to the item.
 * Returns one violation per broken group; an empty array means the line is
 * addable. `knownOptionIds` is the set of ACTIVE options offered for the item -
 * anything outside it (inactive, foreign group, stale) is rejected.
 */
export function modifierViolations(
  selected: SelectedModifier[],
  attachedGroups: ModifierGroup[],
  knownOptionIds: ReadonlySet<string>,
): GroupViolation[] {
  const violations: GroupViolation[] = [];
  const seen = new Set<string>();

  for (const m of selected) {
    if (!m.option_id) continue; // legacy free-text extras carry no option id
    if (seen.has(m.option_id)) {
      violations.push({ group_id: m.group_id ?? "", group_name: m.name, message: `"${m.name}" is selected more than once.` });
      continue;
    }
    seen.add(m.option_id);
    if (!knownOptionIds.has(m.option_id)) {
      violations.push({ group_id: m.group_id ?? "", group_name: m.name, message: `"${m.name}" is not available for this item.` });
    }
  }

  for (const g of attachedGroups) {
    const count = new Set(selected.filter((m) => m.group_id === g.id && m.option_id).map((m) => m.option_id)).size;
    const min = requiredMin(g);
    const max = allowedMax(g);
    if (max != null && count > max) {
      violations.push({
        group_id: g.id,
        group_name: g.name,
        message: isSingleSelect(g) ? `Choose only one ${g.name}.` : `Choose at most ${max} ${g.name}.`,
      });
    } else if (count < min) {
      violations.push({
        group_id: g.id,
        group_name: g.name,
        message: min === 1 ? `Choose a ${g.name}.` : `Choose at least ${min} ${g.name}.`,
      });
    }
  }
  return violations;
}

/**
 * Per-unit modifier total, mirroring pos_save_order exactly:
 *   sum(price_delta * quantity)
 * The server recomputes this from the submitted modifiers, so a mismatch here
 * would show the cashier a total the receipt then contradicts.
 */
export function modifiersTotal(modifiers: SelectedModifier[]): number {
  return modifiers.reduce((sum, m) => sum + (Number(m.price_delta) || 0) * (Number(m.quantity) || 1), 0);
}

/** Final unit price and line total, mirroring pos_save_order's arithmetic. */
export function lineTotals(basePrice: number, modifiers: SelectedModifier[], quantity: number) {
  const modsTotal = modifiersTotal(modifiers);
  const finalUnitPrice = (Number(basePrice) || 0) + modsTotal;
  return { modsTotal, finalUnitPrice, lineTotal: finalUnitPrice * (Number(quantity) || 0) };
}

/** Groups attached to an item, in catalogue order. */
export function groupsForItem(
  itemId: string,
  groupsByItem: Record<string, string[]>,
  groups: ModifierGroup[],
): ModifierGroup[] {
  const ids = new Set(groupsByItem[itemId] ?? []);
  return groups.filter((g) => ids.has(g.id));
}

/** True when an item has at least one group that must be answered before adding. */
export function requiresChoice(
  itemId: string,
  groupsByItem: Record<string, string[]>,
  groups: ModifierGroup[],
): boolean {
  return groupsForItem(itemId, groupsByItem, groups).some((g) => requiredMin(g) > 0);
}
