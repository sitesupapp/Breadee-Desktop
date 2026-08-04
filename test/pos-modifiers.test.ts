// Modifier selection and validation - the client mirror of m241.
//
// A required group that is not answered must BLOCK the line locally, otherwise
// the cashier discovers the refusal only after pressing Send, mid-queue.

import { test } from "node:test";
import assert from "node:assert/strict";

import { allowedMax, groupsForItem, isSingleSelect, modifierViolations, requiredMin, requiresChoice, toggleModifier } from "@/lib/pos/modifiers";
import type { ModifierGroup, ModifierOption, SelectedModifier } from "@/types/pos";

const single: ModifierGroup = { id: "size", name: "Size", selection_type: "single", is_required: true, min_select: 0, max_select: 1 };
const multi: ModifierGroup = { id: "extras", name: "Extras", selection_type: "multi", is_required: false, min_select: 0, max_select: 2 };

const opt = (id: string, group: string, name: string): ModifierOption => ({
  id,
  modifier_group_id: group,
  name,
  extra_price: 0,
});

const small = opt("small", "size", "Small");
const large = opt("large", "size", "Large");
const cheese = opt("cheese", "extras", "Cheese");
const bacon = opt("bacon", "extras", "Bacon");
const olives = opt("olives", "extras", "Olives");

const known = new Set(["small", "large", "cheese", "bacon", "olives"]);

test("a required group blocks the line until it is answered", () => {
  const violations = modifierViolations([], [single], known);
  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /Choose a Size/);
});

test("answering a required group clears the violation", () => {
  const selected = toggleModifier([], small, single, 0);
  assert.deepEqual(modifierViolations(selected, [single], known), []);
});

test("a single-select group replaces rather than accumulates", () => {
  let selected: SelectedModifier[] = toggleModifier([], small, single, 0);
  selected = toggleModifier(selected, large, single, 1.5);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].option_id, "large");
  assert.equal(selected[0].price_delta, 1.5);
});

test("a multi-select group accumulates, and re-tapping deselects", () => {
  let selected = toggleModifier([], cheese, multi, 0.5);
  selected = toggleModifier(selected, bacon, multi, 1);
  assert.equal(selected.length, 2);
  selected = toggleModifier(selected, cheese, multi, 0.5);
  assert.deepEqual(selected.map((m) => m.option_id), ["bacon"]);
});

test("exceeding max_select is reported rather than silently swallowed", () => {
  let selected = toggleModifier([], cheese, multi, 0.5);
  selected = toggleModifier(selected, bacon, multi, 1);
  selected = toggleModifier(selected, olives, multi, 0.25);
  const violations = modifierViolations(selected, [multi], known);
  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /at most 2 Extras/);
});

test("an option outside the item's active set is rejected", () => {
  const stale: SelectedModifier[] = [{ group_id: "extras", option_id: "retired", name: "Retired", price_delta: 0, quantity: 1 }];
  const violations = modifierViolations(stale, [], known);
  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /not available for this item/);
});

test("min_select above one is honoured even when is_required is false", () => {
  const pickTwo: ModifierGroup = { ...multi, is_required: false, min_select: 2 };
  assert.equal(requiredMin(pickTwo), 2);
  const violations = modifierViolations(toggleModifier([], cheese, pickTwo, 0), [pickTwo], known);
  assert.match(violations[0].message, /at least 2 Extras/);
});

test("selection bounds are derived, not assumed", () => {
  assert.equal(isSingleSelect(single), true);
  assert.equal(allowedMax(single), 1);
  assert.equal(allowedMax(multi), 2);
  assert.equal(allowedMax({ ...multi, max_select: 0 }), null);
  assert.equal(requiredMin(single), 1, "is_required implies a minimum of one");
});

test("groups are attached per item, and required choices are detectable up front", () => {
  const groupsByItem = { burger: ["size", "extras"], water: [] };
  const groups = [single, multi];
  assert.deepEqual(groupsForItem("burger", groupsByItem, groups).map((g) => g.id), ["size", "extras"]);
  assert.equal(requiresChoice("burger", groupsByItem, groups), true);
  assert.equal(requiresChoice("water", groupsByItem, groups), false);
});
