// The Service Floor Map gate. Mirrors `floor_service_layout` server-side: the
// `pos.floor_map` entitlement ON TOP OF everything `canViewTables` requires. No
// new permission key — viewing a floor is viewing tables by another presentation.

import { test } from "node:test";
import assert from "node:assert/strict";

import { canViewFloor, type PosAccessContext } from "@/lib/pos/access";
import { FEATURES } from "@/lib/features";

const ALL_FEATURES = {
  [FEATURES.POS]: true,
  [FEATURES.POS_DINE_IN]: true,
  [FEATURES.POS_FLOOR_MAP]: true,
};
const ALL_PERMS = { "pos.access": true, "pos.tables.view": true };

function ctx(overrides: Partial<PosAccessContext> = {}): PosAccessContext {
  return {
    membership: { role: "cashier", status: "active" },
    permissions: { ...ALL_PERMS },
    features: { ...ALL_FEATURES },
    ...overrides,
  };
}

test("the feature key is the server's dotted sub-feature key", () => {
  assert.equal(FEATURES.POS_FLOOR_MAP, "pos.floor_map");
});

test("an entitled cashier who can view tables may view the floor", () => {
  const gate = canViewFloor(ctx());
  assert.equal(gate.allowed, true);
  assert.equal(gate.reason, null);
});

test("with the floor_map feature OFF the floor is denied (List is unaffected)", () => {
  const gate = canViewFloor(ctx({ features: { [FEATURES.POS]: true, [FEATURES.POS_DINE_IN]: true } }));
  assert.equal(gate.allowed, false);
  assert.match(gate.reason ?? "", /Floor map is not enabled/);
});

test("the underlying table-view requirements still apply (no dine_in → denied)", () => {
  const gate = canViewFloor(ctx({ features: { [FEATURES.POS]: true, [FEATURES.POS_FLOOR_MAP]: true } }));
  assert.equal(gate.allowed, false);
  assert.match(gate.reason ?? "", /Dine-in is not enabled/);
});

test("no pos.tables.view permission → denied before the feature is even considered", () => {
  const gate = canViewFloor(ctx({ permissions: { "pos.access": true } }));
  assert.equal(gate.allowed, false);
  assert.match(gate.reason ?? "", /permission to view tables/);
});

test("an owner is refused the floor, exactly as the table map refuses them", () => {
  const gate = canViewFloor(ctx({ membership: { role: "owner", status: "active" } }));
  assert.equal(gate.allowed, false);
});
