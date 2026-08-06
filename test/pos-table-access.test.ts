// Dine-In access gates.
//
// `pos_table_map` demands `pos.tables.view`; `pos_open_table` demands
// `pos.tables.open` plus pos_assert_operator. These cases pin the desktop gates
// to those contracts, and pin the one place the desktop is deliberately
// STRICTER than the server: it refuses to open a table without an open shift.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  canOpenTable,
  canViewTables,
  POS_PERMISSIONS,
  tableActionNotYetAvailable,
  type PosAccessContext,
} from "@/lib/pos/access";
import { FEATURES } from "@/lib/features";

const ALL_FEATURES = {
  [FEATURES.POS]: true,
  [FEATURES.POS_TAKEAWAY]: true,
  [FEATURES.POS_DINE_IN]: true,
  [FEATURES.POS_SHIFTS]: true,
};

const ALL_PERMS = {
  "pos.access": true,
  "pos.create_orders": true,
  "pos.take_payments": true,
  "pos.open_shift": true,
  "pos.end_own_shift": true,
  "pos.tables.view": true,
  "pos.tables.open": true,
};

function ctx(overrides: Partial<PosAccessContext> = {}): PosAccessContext {
  return {
    membership: { role: "cashier", status: "active" },
    permissions: { ...ALL_PERMS },
    features: { ...ALL_FEATURES },
    ...overrides,
  };
}

test("the permission keys match the ones the server checks", () => {
  assert.equal(POS_PERMISSIONS.TABLES_VIEW, "pos.tables.view");
  assert.equal(POS_PERMISSIONS.TABLES_OPEN, "pos.tables.open");
  assert.equal(POS_PERMISSIONS.TABLES_MOVE, "pos.tables.move");
  assert.equal(POS_PERMISSIONS.TABLES_CLEAR, "pos.tables.clear");
  assert.equal(POS_PERMISSIONS.TABLES_CLOSE, "pos.tables.close");
});

test("an active cashier with pos.tables.view may enter the dine-in workspace", () => {
  const gate = canViewTables(ctx());
  assert.equal(gate.allowed, true);
  assert.equal(gate.reason, null);
});

test("an owner is refused the table map, exactly as pos_assert_operator refuses them", () => {
  const gate = canViewTables(ctx({ membership: { role: "owner", status: "active" } }));
  assert.equal(gate.allowed, false);
  assert.match(gate.reason ?? "", /Owners cannot perform POS operations/);
});

test("the dine_in sub-feature is checked before the permission", () => {
  const noDineIn = ctx({ features: { [FEATURES.POS]: true, [FEATURES.POS_SHIFTS]: true } });
  const gate = canViewTables(noDineIn);
  assert.equal(gate.allowed, false);
  assert.match(gate.reason ?? "", /Dine-in is not enabled for this plan/);
});

test("a missing pos.tables.view closes the dine-in route with its own reason", () => {
  const gate = canViewTables(ctx({ permissions: { ...ALL_PERMS, "pos.tables.view": false } }));
  assert.equal(gate.allowed, false);
  assert.match(gate.reason ?? "", /permission to view tables/);
});

test("table permissions fail closed when the map is empty", () => {
  assert.equal(canViewTables(ctx({ permissions: {} })).allowed, false);
  assert.equal(canOpenTable(ctx({ permissions: {} }), true).allowed, false);
});

test("opening a table needs pos.tables.open on top of view", () => {
  const viewOnly = ctx({ permissions: { ...ALL_PERMS, "pos.tables.open": false } });
  assert.equal(canViewTables(viewOnly).allowed, true);
  const gate = canOpenTable(viewOnly, true);
  assert.equal(gate.allowed, false);
  assert.match(gate.reason ?? "", /permission to open tables/);
});

test("DESKTOP POLICY: an open shift is required to open a table, though the server allows it", () => {
  const gate = canOpenTable(ctx(), false);
  assert.equal(gate.allowed, false);
  assert.match(gate.reason ?? "", /Open a shift before opening a table/);
  assert.equal(canOpenTable(ctx(), true).allowed, true);
});

test("the shift rule is stricter than the server and never looser", () => {
  // Whatever the shift state, a user without the permission is still refused -
  // an open shift can never substitute for pos.tables.open.
  const noOpen = ctx({ permissions: { ...ALL_PERMS, "pos.tables.open": false } });
  assert.equal(canOpenTable(noOpen, true).allowed, false);
  assert.equal(canOpenTable(noOpen, false).allowed, false);
});

test("a view failure short-circuits the open gate with the view reason", () => {
  const owner = ctx({ membership: { role: "owner", status: "active" } });
  assert.deepEqual(canOpenTable(owner, true), canViewTables(owner));
});

test("deferred table actions explain the level rather than implying a missing permission", () => {
  const gate = tableActionNotYetAvailable("Move table", "Level 2C");
  assert.equal(gate.allowed, false);
  assert.equal(gate.reason, "Move table arrives in Level 2C.");
  assert.doesNotMatch(gate.reason ?? "", /permission/i);
});
