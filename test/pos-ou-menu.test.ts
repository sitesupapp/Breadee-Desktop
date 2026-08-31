// OU-scoped POS menu: the `pos_menu` projection mapping and the tenant+OU cache
// key. These are the two pure surfaces of the Franks-class fix — the sell menu
// now comes from the operating unit's authoritative projection, and its snapshot
// is keyed so one terminal can never render another OU's cached menu.

import { test } from "node:test";
import assert from "node:assert/strict";

import { mapPosMenu, posMenuSnapshotKey, type PosMenuJson } from "@/lib/pos/menu";

const SAMPLE: PosMenuJson = {
  categories: [
    { id: "c1", name: "Burgers" },
    { id: "c2", name: "Drinks" },
  ],
  items: [
    { id: "i1", name: "Classic Burger", price: 5, category_id: "c1", image_url: null },
    { id: "i2", name: "Cola", price: 1, category_id: "c2", image_url: null },
  ],
  groups: [{ id: "g1", name: "Size", selection_type: "single", is_required: true, min_select: 1, max_select: 1 }],
  options: [{ id: "o1", modifier_group_id: "g1", name: "Large", extra_price: 1 }],
  item_groups: [
    { menu_item_id: "i1", modifier_group_id: "g1" },
    { menu_item_id: "i1", modifier_group_id: "g2" },
  ],
};

// --- mapPosMenu: pos_menu projection -> MenuData -----------------------------

test("mapPosMenu preserves categories, items, groups and options verbatim (guardrail #7)", () => {
  const menu = mapPosMenu(SAMPLE);
  assert.deepEqual(menu.categories, SAMPLE.categories);
  assert.deepEqual(menu.items, SAMPLE.items);
  assert.deepEqual(menu.groups, SAMPLE.groups);
  assert.deepEqual(menu.options, SAMPLE.options);
});

test("mapPosMenu pivots the flat item_groups link table into groupsByItem", () => {
  const menu = mapPosMenu(SAMPLE);
  assert.deepEqual(menu.groupsByItem, { i1: ["g1", "g2"] });
  assert.equal(menu.groupsByItem.i2, undefined);
});

test("mapPosMenu neither adds nor drops items — the projection is the sole source (guardrail #1/#2)", () => {
  const menu = mapPosMenu(SAMPLE);
  assert.deepEqual(
    menu.items.map((i) => i.id),
    ["i1", "i2"],
  );
});

test("mapPosMenu on a blank/empty projection yields a blank menu — a fresh OU stays blank", () => {
  for (const input of [undefined, null, {}, { items: [] } as PosMenuJson]) {
    const menu = mapPosMenu(input as PosMenuJson);
    assert.deepEqual(menu.items, []);
    assert.deepEqual(menu.categories, []);
    assert.deepEqual(menu.groups, []);
    assert.deepEqual(menu.options, []);
    assert.deepEqual(menu.groupsByItem, {});
  }
});

// --- posMenuSnapshotKey: tenant+OU cache scoping (guardrail #2) ---------------

test("posMenuSnapshotKey produces a distinct key per branch so OU-A never reads OU-B's cache", () => {
  assert.notEqual(posMenuSnapshotKey("branch-A"), posMenuSnapshotKey("branch-B"));
});

test("posMenuSnapshotKey is stable per branch and distinguishes the no-branch case", () => {
  assert.equal(posMenuSnapshotKey("branch-A"), posMenuSnapshotKey("branch-A"));
  assert.equal(posMenuSnapshotKey(null), posMenuSnapshotKey(null));
  assert.notEqual(posMenuSnapshotKey(null), posMenuSnapshotKey("branch-A"));
});

test("posMenuSnapshotKey is namespaced under the legacy snapshot key", () => {
  assert.match(posMenuSnapshotKey("b"), /^pos\.menu\./);
});
