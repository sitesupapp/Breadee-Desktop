// Layout rules and shift display helpers.
//
// The layout assertions are the machine-checkable half of the responsive
// requirement: the cart must never wrap below the menu at any supported desktop
// width, and effective widths produced by Windows display scaling must fall back
// to the drawer instead of a broken column.

import { test } from "node:test";
import assert from "node:assert/strict";

import { isTooSmall, railWidth, resolveLayout, MIN_SUPPORTED_WIDTH } from "@/lib/layout";
import { differenceLabel, elapsedSince } from "@/lib/pos/shifts";
import { matchShortcut, FORBIDDEN_COMBOS, SHORTCUTS } from "@/lib/keyboard/shortcuts";
import { stepCategory, ALL_CATEGORIES } from "@/lib/pos/categories";

// The eight required resolutions, at 100% scaling.
const SUPPORTED = [1024, 1280, 1366, 1440, 1600, 1920, 2560];

test("every supported desktop width keeps a fixed, non-wrapping cart", () => {
  for (const width of SUPPORTED) {
    const layout = resolveLayout(width);
    assert.equal(layout.cartAsDrawer, false, `${width} must keep the cart fixed`);
    assert.ok(layout.cartWidth && layout.cartWidth >= 330, `${width} cart too narrow`);
  }
});

test("column counts and cart widths match the agreed tiers", () => {
  assert.deepEqual(pick(2560), { columns: 6, cart: 420, rail: true });
  assert.deepEqual(pick(1920), { columns: 6, cart: 420, rail: true });
  assert.deepEqual(pick(1600), { columns: 5, cart: 400, rail: true });
  assert.deepEqual(pick(1440), { columns: 4, cart: 380, rail: false });
  assert.deepEqual(pick(1280), { columns: 4, cart: 360, rail: false });
  assert.deepEqual(pick(1024), { columns: 3, cart: 340, rail: false });

  function pick(w: number) {
    const l = resolveLayout(w);
    return { columns: l.menuColumns, cart: l.cartWidth, rail: l.railExpanded };
  }
});

test("1366x768 at 125% scaling (~1092 CSS px) still gets a fixed cart", () => {
  const layout = resolveLayout(Math.round(1366 / 1.25));
  assert.equal(layout.cartAsDrawer, false);
  assert.equal(layout.menuColumns, 3);
});

test("1366x768 at 150% scaling (~911 CSS px) falls back to the cart drawer", () => {
  const layout = resolveLayout(Math.round(1366 / 1.5));
  assert.equal(layout.cartAsDrawer, true);
  assert.equal(layout.cartWidth, null);
  assert.ok(layout.menuColumns >= 2, "the menu must stay usable in the drawer tier");
});

test("1280x800 at 150% scaling (~853 CSS px) also falls back to the drawer", () => {
  assert.equal(resolveLayout(Math.round(1280 / 1.5)).cartAsDrawer, true);
});

test("the too-small guard triggers below the supported envelope, not inside it", () => {
  assert.equal(isTooSmall(1024, 768), false);
  assert.equal(isTooSmall(1280, 720), false);
  assert.equal(isTooSmall(MIN_SUPPORTED_WIDTH - 1, 768), true);
  assert.equal(isTooSmall(1024, 400), true);
});

test("the rail is narrow enough to leave real work area at 1024", () => {
  const layout = resolveLayout(1024);
  const remaining = 1024 - railWidth(layout) - (layout.cartWidth ?? 0);
  assert.ok(remaining > 590, `only ${remaining}px left for the menu at 1024`);
});

// --- shift display -----------------------------------------------------------

test("difference is labelled from the server's sign convention", () => {
  // difference = expected - actual: positive means cash is MISSING.
  assert.equal(differenceLabel(5).label, "Shortage");
  assert.equal(differenceLabel(-5).label, "Overage");
  assert.equal(differenceLabel(0).label, "Balanced");
  assert.equal(differenceLabel(0.001).label, "Balanced");
});

test("elapsed time is stable and degrades safely", () => {
  const start = "2026-08-04T09:00:00.000Z";
  const now = Date.parse("2026-08-04T14:30:00.000Z");
  assert.equal(elapsedSince(start, now), "5h 30m");
  assert.equal(elapsedSince(null, now), "--");
  assert.equal(elapsedSince("not a date", now), "--");
});

// --- keyboard ----------------------------------------------------------------

const ev = (over: Partial<Parameters<typeof matchShortcut>[0]>) => ({
  key: "a",
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  target: null,
  ...over,
});

test("core POS shortcuts resolve", () => {
  assert.equal(matchShortcut(ev({ key: "F2" })), "newOrder");
  assert.equal(matchShortcut(ev({ key: "F4" })), "openPayment");
  assert.equal(matchShortcut(ev({ key: "k", ctrlKey: true })), "search");
  assert.equal(matchShortcut(ev({ key: "Enter", ctrlKey: true })), "confirmPayment");
  assert.equal(matchShortcut(ev({ key: "O", ctrlKey: true, shiftKey: true })), "openShift");
  assert.equal(matchShortcut(ev({ key: "E", ctrlKey: true, shiftKey: true })), "endShift");
  assert.equal(matchShortcut(ev({ key: "Escape" })), "closeModal");
  assert.equal(matchShortcut(ev({ key: "1", altKey: true })), "routeTakeaway");
});

test("quantity and search keys are declared unsafe inside inputs; Esc and F-keys are not", () => {
  assert.equal(matchShortcut(ev({ key: "+" })), "qtyUp");
  const unsafeInInput = ["qtyUp", "qtyDown", "removeLine", "lineUp", "lineDown", "search"];
  for (const id of unsafeInInput) {
    const spec = SHORTCUTS.find((s) => s.id === id);
    assert.equal(spec?.worksInInput ?? false, false, `${id} must not fire while typing`);
  }
  for (const id of ["closeModal", "confirmPayment", "openPayment", "newOrder"]) {
    assert.equal(SHORTCUTS.find((s) => s.id === id)?.worksInInput, true, `${id} must work from a field`);
  }
});

test("no shortcut shadows a destructive or reserved Windows/Chromium binding", () => {
  const registered = SHORTCUTS.map((s) => s.display.toLowerCase());
  for (const forbidden of FORBIDDEN_COMBOS) {
    assert.ok(!registered.includes(forbidden.toLowerCase()), `${forbidden} must not be bound`);
  }
  // F5 / Ctrl+R would reload and lose the cart; assert they are absent by key too.
  assert.equal(matchShortcut(ev({ key: "F5" })), null);
  assert.equal(matchShortcut(ev({ key: "r", ctrlKey: true })), null);
  assert.equal(matchShortcut(ev({ key: "w", ctrlKey: true })), null);
});

// --- category navigation -----------------------------------------------------

test("category stepping wraps at both ends", () => {
  const ids = [ALL_CATEGORIES, "a", "b"];
  assert.equal(stepCategory(ids, ALL_CATEGORIES, 1), "a");
  assert.equal(stepCategory(ids, "b", 1), ALL_CATEGORIES);
  assert.equal(stepCategory(ids, ALL_CATEGORIES, -1), "b");
  assert.equal(stepCategory([], "x", 1), "x");
});
