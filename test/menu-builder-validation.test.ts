// VALIDATION AND LIST DERIVATION.
//
// Every rule asserted here has a server-side twin, and the test names say which:
// the point is not that the desktop validates, it is that it validates the SAME
// thing, so a save the desktop allows is a save the database accepts and a save
// the desktop refuses is one the database would have refused anyway.
//
// The deliberate NON-rule is asserted too: duplicate names are legal in this
// schema and the web app does not check, so the desktop must not either.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PRICE_MAX_SAFE,
  categoryNameError,
  exceedsPriceLimit,
  isSaveable,
  itemDraftErrors,
  optionErrors,
  priceError,
} from "@/lib/menu/validation";
import {
  canonSelectionType,
  canonicalGroupPayload,
  canonicalizeGroup,
  describeGroup,
  groupConfigError,
} from "@/lib/menu/modifierGroupConfig";
import {
  ALL_CATEGORIES,
  ANY_STATUS,
  DEFAULT_ITEM_FILTER,
  NO_CATEGORY,
  filterMenuItems,
  itemCountsByCategory,
  menuHealth,
  previewSections,
  previewUncategorized,
  sortedCategories,
} from "@/lib/menu/filters";
import { validateImageFile, MAX_IMAGE_BYTES } from "@/lib/menu/image";
import { menuFailure } from "@/lib/menu/errors";

// --- prices: mirrors `_price_write_prepare` (m213) -----------------------------

test("a negative price is refused, exactly as the RPC refuses it", () => {
  assert.match(priceError(-1, "USD", "USD", null)!, /cannot be negative/i);
});

test("no price is not an error - the column is nullable", () => {
  assert.equal(priceError(null, "USD", "USD", null), null);
  assert.equal(priceError(0, "USD", "USD", null), null);
});

test("an LBP amount without a rate is refused before the round trip", () => {
  assert.match(priceError(10000, "LBP", "USD", null)!, /exchange rate/i);
  assert.match(priceError(10000, "LBP", "USD", 0)!, /exchange rate/i);
  assert.equal(priceError(10000, "LBP", "USD", 89500), null);
});

test("an LBP-primary tenant needs a rate even for a USD amount", () => {
  // `_price_write_prepare` derives the legacy column in the PRIMARY currency, so
  // it raises when the primary is LBP and no rate exists, whatever was typed.
  assert.match(priceError(5, "USD", "LBP", null)!, /exchange rate/i);
  assert.equal(priceError(5, "USD", "LBP", 89500), null);
});

test("the overflow guard matches numeric(18,4)", () => {
  assert.equal(PRICE_MAX_SAFE, 1e14);
  assert.equal(exceedsPriceLimit(1e13), false);
  assert.equal(exceedsPriceLimit(1e14), true);
  assert.match(priceError(1e14, "USD", "USD", null)!, /too large/i);
});

test("a non-numeric amount is refused rather than sent as NaN", () => {
  assert.match(priceError(Number.NaN, "USD", "USD", null)!, /valid amount/i);
});

// --- required fields ----------------------------------------------------------

test("an item needs a name; a whitespace name is not a name", () => {
  assert.ok(itemDraftErrors({ name: "" }, "USD", "USD", null).name);
  assert.ok(itemDraftErrors({ name: "   " }, "USD", "USD", null).name);
  assert.ok(isSaveable(itemDraftErrors({ name: "Espresso", price: 3 }, "USD", "USD", null)));
});

test("a category needs a name", () => {
  assert.ok(categoryNameError(""));
  assert.ok(categoryNameError(null));
  assert.equal(categoryNameError("Drinks"), null);
});

test("an option needs a name and a valid extra", () => {
  assert.ok(optionErrors("", 0, "USD", "USD", null).name);
  assert.ok(optionErrors("Large", -2, "USD", "USD", null).extra);
  assert.ok(isSaveable(optionErrors("Large", 1.5, "USD", "USD", null)));
});

test("DUPLICATE NAMES ARE LEGAL - there is no unique index and the web app does not check", () => {
  const first = itemDraftErrors({ name: "Espresso", price: 3 }, "USD", "USD", null);
  const second = itemDraftErrors({ name: "Espresso", price: 4 }, "USD", "USD", null);
  assert.ok(isSaveable(first) && isSaveable(second));
  assert.equal(categoryNameError("Drinks"), null);
});

// --- modifier groups: mirrors `modifier_groups_canonical_selection_chk` --------

test("single-select derives max = 1 and min from `required`", () => {
  assert.deepEqual(canonicalGroupPayload({ selection_type: "single", is_required: false, min_select: 7, max_select: 9 }), {
    selection_type: "single",
    min_select: 0,
    max_select: 1,
    is_required: false,
  });
  assert.deepEqual(canonicalGroupPayload({ selection_type: "single", is_required: true, min_select: 0, max_select: 5 }), {
    selection_type: "single",
    min_select: 1,
    max_select: 1,
    is_required: true,
  });
});

test("anything that is not 'single' is stored as 'multi'", () => {
  assert.equal(canonSelectionType("multiple"), "multi");
  assert.equal(canonSelectionType(null), "multi");
  assert.equal(canonicalGroupPayload({ selection_type: "anything" }).selection_type, "multi");
});

test("an impossible multi-select configuration is explained, not silently fixed", () => {
  assert.match(groupConfigError({ selection_type: "multi", min_select: 3, max_select: 2 })!, /cannot be greater/i);
  assert.match(groupConfigError({ selection_type: "multi", min_select: 0, max_select: 0 })!, /at least one/i);
  assert.match(groupConfigError({ selection_type: "multi", min_select: -1, max_select: 3 })!, /negative/i);
  assert.equal(groupConfigError({ selection_type: "multi", min_select: 1, max_select: 3 }), null);
  // A single-select group is always canonicalizable, so it never errors.
  assert.equal(groupConfigError({ selection_type: "single", min_select: 9, max_select: 0 }), null);
});

test("required multi implies a minimum of at least one", () => {
  assert.equal(canonicalizeGroup({ selection_type: "multi", is_required: true, min_select: 0, max_select: 3 }).min_select, 1);
});

test("a group describes itself the way the cashier will experience it", () => {
  assert.match(describeGroup({ selection_type: "single", is_required: true }), /Choose one/);
  assert.match(describeGroup({ selection_type: "multi", min_select: 1, max_select: 3 }), /Choose 1-3/);
});

// --- filters and preview ------------------------------------------------------

const cats = [
  { id: "c1", name: "Drinks", name_ar: null, sort_order: 1, status: "active", archived_at: null },
  { id: "c2", name: "Food", name_ar: null, sort_order: 0, status: "active", archived_at: null },
  { id: "c3", name: "Retired", name_ar: null, sort_order: 2, status: "hidden", archived_at: null },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
] as any[];

const items = [
  { id: "i1", name: "Espresso", name_ar: null, description: "strong", category_id: "c1", status: "published", is_available: true, price: 3, archived_at: null },
  { id: "i2", name: "Latte", name_ar: null, description: null, category_id: "c1", status: "draft", is_available: true, price: 4, archived_at: null },
  { id: "i3", name: "Burger", name_ar: null, description: null, category_id: "c2", status: "published", is_available: false, price: 9, archived_at: null },
  { id: "i4", name: "Mystery", name_ar: null, description: null, category_id: null, status: "published", is_available: true, price: null, archived_at: null },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
] as any[];

test("search covers name, description and category name", () => {
  const byName = filterMenuItems(items, cats, { ...DEFAULT_ITEM_FILTER, query: "latte" });
  assert.deepEqual(byName.map((i) => i.id), ["i2"]);
  const byDescription = filterMenuItems(items, cats, { ...DEFAULT_ITEM_FILTER, query: "strong" });
  assert.deepEqual(byDescription.map((i) => i.id), ["i1"]);
  const byCategory = filterMenuItems(items, cats, { ...DEFAULT_ITEM_FILTER, query: "drinks" });
  assert.deepEqual(byCategory.map((i) => i.id), ["i1", "i2"]);
});

test("the category filter has an explicit 'no category' bucket", () => {
  assert.deepEqual(filterMenuItems(items, cats, { ...DEFAULT_ITEM_FILTER, categoryId: NO_CATEGORY }).map((i) => i.id), ["i4"]);
  assert.equal(filterMenuItems(items, cats, { ...DEFAULT_ITEM_FILTER, categoryId: ALL_CATEGORIES }).length, 4);
});

test("status and availability filter independently", () => {
  assert.deepEqual(filterMenuItems(items, cats, { ...DEFAULT_ITEM_FILTER, status: "draft" }).map((i) => i.id), ["i2"]);
  assert.deepEqual(filterMenuItems(items, cats, { ...DEFAULT_ITEM_FILTER, unavailableOnly: true }).map((i) => i.id), ["i3"]);
  assert.equal(DEFAULT_ITEM_FILTER.status, ANY_STATUS);
});

test("categories sort by sort_order, not by insertion", () => {
  assert.deepEqual(sortedCategories(cats).map((c) => c.id), ["c2", "c1", "c3"]);
});

test("item counts include an uncategorised bucket", () => {
  const counts = itemCountsByCategory(items);
  assert.equal(counts.c1, 2);
  assert.equal(counts[NO_CATEGORY], 1);
});

test("THE PREVIEW USES THE POS PREDICATE: published AND available AND not archived", () => {
  const sections = previewSections(cats, items);
  // Food's only item is unavailable, so the section disappears entirely - just
  // as it would on the till and on the public menu.
  assert.deepEqual(sections.map((s) => s.category.id), ["c1"]);
  assert.deepEqual(sections[0].items.map((i) => i.id), ["i1"]);
  assert.deepEqual(previewUncategorized(items).map((i) => i.id), ["i4"]);
});

test("a hidden category never reaches the preview", () => {
  const withHidden = [...items, { id: "i5", name: "Ghost", category_id: "c3", status: "published", is_available: true, price: 1, archived_at: null }];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sections = previewSections(cats, withHidden as any[]);
  assert.ok(!sections.some((s) => s.category.id === "c3"));
});

test("menu health counts what the header reports", () => {
  const health = menuHealth(items);
  assert.equal(health.total, 4);
  assert.equal(health.published, 3);
  assert.equal(health.drafts, 1);
  assert.equal(health.noPrice, 1);
  assert.equal(health.noCategory, 1);
});

// --- images -------------------------------------------------------------------

test("only JPG, PNG and WebP under 5 MB are accepted", () => {
  assert.equal(validateImageFile({ type: "image/png", size: 1000 }), null);
  assert.match(validateImageFile({ type: "image/gif", size: 1000 })!, /JPG, PNG or WebP/);
  assert.match(validateImageFile({ type: "image/png", size: MAX_IMAGE_BYTES + 1 })!, /larger than 5 MB/);
});

// --- error surfacing ----------------------------------------------------------

test("a raw RLS violation never reaches the operator", () => {
  const failure = menuFailure({ code: "42501", message: 'new row violates row-level security policy for table "menu_items"' }, "Saving the item");
  assert.match(failure.message, /refused/i);
  assert.ok(!/row-level security/i.test(failure.detail ?? ""));
  assert.ok(!/menu_items/.test(failure.detail ?? ""));
});

test("a message the server wrote for a human is passed through unchanged", () => {
  const failure = menuFailure({ message: "Price cannot be negative" }, "Saving the item");
  assert.equal(failure.detail, "Price cannot be negative");
});

test("no token, SQL or constraint name is ever surfaced", () => {
  for (const raw of [
    { message: 'duplicate key value violates unique constraint "qr_menu_settings_public_slug_key"' },
    { message: "JWT expired" },
    { message: 'syntax error at or near "select"' },
  ]) {
    const failure = menuFailure(raw, "Saving");
    assert.ok(!/constraint|JWT|syntax error/i.test(failure.detail ?? ""), `leaked: ${failure.detail}`);
  }
});

test("being offline is reported as being offline", () => {
  const failure = menuFailure(new TypeError("Failed to fetch"), "Saving the item");
  assert.match(failure.message, /offline/i);
});
