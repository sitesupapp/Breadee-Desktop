// PERMISSIONS: the desktop must refuse exactly what the database refuses.
//
// The keys are not invented here. `m138_menu_write_authz` requires
// `menu.create` to insert an item, `menu.edit` OR `menu.delete_or_archive` to
// update one, `menu.manage_categories` for every category write and
// `menu.manage_modifiers` for every group/option write; `set_menu_item_price`
// re-checks `menu.edit` inside `_assert_menu_price_writer`. These tests assert
// the client says the same thing.
//
// The other half matters as much: `current_user_permissions` already ANDs every
// key with its feature, so a plan without `menu_builder.modifiers` produces
// `menu.manage_modifiers = false` and needs no second check. A test that a
// permission-less session is READ ONLY - rather than invisible - is what keeps
// the module usable for a manager who may look but not touch.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { stripJsxComments } from "./source-helpers.ts";
import {
  MENU_PERMISSIONS,
  canViewMenuBuilder,
  hasModifiersFeature,
  hasQrFeature,
  isReadOnly,
  menuBuilderDenialReason,
  menuBuilderGates,
} from "@/lib/menu/access";
import { NAV_ITEMS, visibleNav } from "@/lib/nav";
import { visibleModules } from "@/lib/modules";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

const ALL_MENU_PERMS = Object.values(MENU_PERMISSIONS);
const grant = (...keys: string[]) => Object.fromEntries(keys.map((k) => [k, true]));

const owner = {
  status: "active" as const,
  features: { menu_builder: true, "menu_builder.modifiers": true, "menu_builder.categories": true, qr_menu: true },
  permissions: grant(...ALL_MENU_PERMS),
};
const viewer = { ...owner, permissions: grant(MENU_PERMISSIONS.VIEW) };

// --- module visibility --------------------------------------------------------

test("viewing needs an active membership, the feature and menu.view", () => {
  assert.equal(canViewMenuBuilder(owner), true);
  assert.equal(canViewMenuBuilder({ ...owner, status: "frozen" }), false);
  assert.equal(canViewMenuBuilder({ ...owner, features: { menu_builder: false } }), false);
  assert.equal(canViewMenuBuilder({ ...owner, permissions: {} }), false);
});

test("with no context at all the module fails CLOSED", () => {
  assert.equal(canViewMenuBuilder({ status: undefined, features: {}, permissions: {} }), false);
});

test("the refusal is explained in the order the server would refuse", () => {
  assert.match(menuBuilderDenialReason({ ...owner, status: "frozen" })!, /membership is not active/i);
  assert.match(menuBuilderDenialReason({ ...owner, features: {} })!, /not enabled for this plan/i);
  assert.match(menuBuilderDenialReason({ ...owner, permissions: {} })!, /not allowed to view/i);
  assert.equal(menuBuilderDenialReason(owner), null);
});

// --- the write gates ----------------------------------------------------------

test("each write gate names the permission the RLS policy requires", () => {
  const cases: [string, keyof ReturnType<typeof menuBuilderGates>][] = [
    [MENU_PERMISSIONS.CREATE, "createItem"],
    [MENU_PERMISSIONS.EDIT, "editItem"],
    [MENU_PERMISSIONS.DELETE_OR_ARCHIVE, "archiveItem"],
    [MENU_PERMISSIONS.MANAGE_CATEGORIES, "manageCategories"],
    [MENU_PERMISSIONS.MANAGE_MODIFIERS, "manageModifiers"],
    [MENU_PERMISSIONS.MANAGE_QR, "manageQr"],
  ];
  for (const [key, gateName] of cases) {
    const only = menuBuilderGates({ ...owner, permissions: grant(MENU_PERMISSIONS.VIEW, key) });
    assert.equal(only[gateName].allowed, true, `${key} should open ${gateName}`);
    const without = menuBuilderGates({ ...owner, permissions: grant(...ALL_MENU_PERMS.filter((k) => k !== key)) });
    assert.equal(without[gateName].allowed, false, `${gateName} must close without ${key}`);
    assert.ok(without[gateName].reason, `${gateName} must explain its refusal`);
  }
});

test("a menu.view-only session sees the module READ ONLY, not empty", () => {
  assert.equal(canViewMenuBuilder(viewer), true);
  const gates = menuBuilderGates(viewer);
  assert.equal(isReadOnly(gates), true);
  for (const gate of Object.values(gates)) assert.equal(gate.allowed, false);
});

test("one write permission is enough to leave read-only mode", () => {
  const gates = menuBuilderGates({ ...owner, permissions: grant(MENU_PERMISSIONS.VIEW, MENU_PERMISSIONS.EDIT) });
  assert.equal(isReadOnly(gates), false);
});

test("archiving an item is a separate permission from editing it", () => {
  const editor = menuBuilderGates({ ...owner, permissions: grant(MENU_PERMISSIONS.EDIT) });
  assert.equal(editor.editItem.allowed, true);
  assert.equal(editor.archiveItem.allowed, false);
});

// --- sub-feature surfaces -----------------------------------------------------

test("the modifiers and QR surfaces follow their sub-features", () => {
  assert.equal(hasModifiersFeature(owner), true);
  assert.equal(hasModifiersFeature({ ...owner, features: { menu_builder: true } }), false);
  assert.equal(hasQrFeature(owner), true);
  assert.equal(hasQrFeature({ ...owner, features: { menu_builder: true } }), false);
});

// --- navigation ---------------------------------------------------------------

test("the sidebar order is Dashboard, Menu Builder, POS, Profile, Settings", () => {
  assert.deepEqual(
    NAV_ITEMS.map((n) => n.label),
    ["Dashboard", "Menu Builder", "POS", "Profile", "Settings"],
  );
  assert.equal(NAV_ITEMS[1].to, "/menu-builder");
});

test("Menu Builder is in the APP sidebar, never inside the POS rail", () => {
  const posShell = stripJsxComments(read("src/layouts/PosShell.tsx"));
  assert.ok(!/menu-builder/.test(posShell), "the POS rail must not link to Menu Builder");
  const workspace = stripJsxComments(read("src/screens/pos/PosWorkspace.tsx"));
  assert.ok(!/menu-builder/.test(workspace));
});

test("the nav item is hidden without the feature or the permission", () => {
  const ctx = { role: "manager" as const, status: "active" as const };
  const shown = visibleNav({ ...ctx, features: owner.features, permissions: owner.permissions }).map((n) => n.to);
  assert.ok(shown.includes("/menu-builder"));
  const hidden = visibleNav({ ...ctx, features: {}, permissions: {} }).map((n) => n.to);
  assert.ok(!hidden.includes("/menu-builder"));
});

test("every nav item draws a real glyph, not an ASCII placeholder", () => {
  for (const item of NAV_ITEMS) {
    assert.equal(typeof item.glyph, "string");
    assert.ok(item.glyph.length > 1, `${item.label} needs a named glyph`);
  }
  assert.match(stripJsxComments(read("src/screens/Shell.tsx")), /<Glyph name=\{n\.glyph\}/);
});

// --- the dashboard tile -------------------------------------------------------

test("the dashboard offers Menu Builder as a DESKTOP module with a route", () => {
  const modules = visibleModules({ ...owner, role: "owner", permissions: owner.permissions });
  const entry = modules.find((m) => m.key === "menu_builder");
  assert.ok(entry, "the Menu Builder tile must be visible to an entitled user");
  assert.equal(entry!.availability, "desktop");
  assert.equal(entry!.to, "/menu-builder");
});

test("the tile does not claim E-Menu management the desktop does not have", () => {
  const modules = visibleModules({
    ...owner,
    role: "owner",
    features: { ...owner.features, e_menu: true },
    permissions: owner.permissions,
  });
  const builder = modules.find((m) => m.key === "menu_builder")!;
  assert.ok(!/e-?menu/i.test(builder.desc));
  const emenu = modules.find((m) => m.key === "e_menu");
  assert.ok(emenu, "E-Menu stays listed, on the web app");
  assert.equal(emenu!.availability, "web");
});

// --- the UI honours the gates -------------------------------------------------

test("write controls are gated in the UI, not merely hidden", () => {
  // GatedButton keeps the control visible and disabled with the reason on hover,
  // which is what stops an operator hunting for a button that was removed.
  for (const file of [
    "src/components/menu/ItemsTab.tsx",
    "src/components/menu/CategoriesTab.tsx",
    "src/components/menu/ModifiersTab.tsx",
    "src/components/menu/AvailabilityTab.tsx",
    "src/components/menu/QrMenuTab.tsx",
    "src/components/menu/ItemDrawer.tsx",
  ]) {
    assert.match(stripJsxComments(read(file)), /GatedButton|gate\.allowed|gate\.reason/, `${file} must honour a gate`);
  }
});

test("a typed URL cannot bypass the module gate", () => {
  const screen = stripJsxComments(read("src/screens/menu/MenuBuilder.tsx"));
  assert.match(screen, /if \(!canViewMenuBuilder\(accessCtx\)\)/);
  assert.match(screen, /<Navigate to="\/dashboard" replace/);
});
