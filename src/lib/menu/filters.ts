// Pure list derivation for the Menu Builder: search, filtering and counting.
//
// Kept out of the components so filtering is testable without a DOM and so the
// work is one pass over an already-loaded array rather than a query. A menu of a
// few hundred items filters in well under a frame; nothing here talks to the
// backend, so typing in the search box issues no requests at all.

import type { BuilderCategory, BuilderItem, BuilderOption } from "@/lib/menu/types";

/** The sentinel for "no category filter". Mirrors the POS's `ALL_CATEGORIES`. */
export const ALL_CATEGORIES = "__all__";
/** The sentinel for items that have no category at all. */
export const NO_CATEGORY = "__none__";
/** The sentinel for "any status". */
export const ANY_STATUS = "__any__";

export type ItemFilter = {
  query: string;
  categoryId: string;
  status: string;
  /** When true, only items whose `is_available` is false. */
  unavailableOnly: boolean;
};

export const DEFAULT_ITEM_FILTER: ItemFilter = {
  query: "",
  categoryId: ALL_CATEGORIES,
  status: ANY_STATUS,
  unavailableOnly: false,
};

/**
 * Filter items.
 *
 * Search covers name, Arabic name, description and the item's category name -
 * the same four fields the web workspace searches, so a term that finds an item
 * in the browser finds it here.
 */
export function filterMenuItems(
  items: BuilderItem[],
  categories: BuilderCategory[],
  filter: ItemFilter,
): BuilderItem[] {
  const q = filter.query.trim().toLowerCase();
  const categoryName = new Map(categories.map((c) => [c.id, c.name.toLowerCase()]));
  return items.filter((item) => {
    if (filter.categoryId === NO_CATEGORY) {
      if (item.category_id) return false;
    } else if (filter.categoryId !== ALL_CATEGORIES && item.category_id !== filter.categoryId) {
      return false;
    }
    if (filter.status !== ANY_STATUS && item.status !== filter.status) return false;
    if (filter.unavailableOnly && item.is_available) return false;
    if (q === "") return true;
    return (
      item.name.toLowerCase().includes(q) ||
      (item.name_ar ?? "").toLowerCase().includes(q) ||
      (item.description ?? "").toLowerCase().includes(q) ||
      (item.category_id ? (categoryName.get(item.category_id) ?? "") : "").includes(q)
    );
  });
}

/** How many live items each category holds. Categories with none still appear. */
export function itemCountsByCategory(items: BuilderItem[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = item.category_id ?? NO_CATEGORY;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/** Options belonging to one group, in catalogue order. */
export function optionsForGroup(options: BuilderOption[], groupId: string): BuilderOption[] {
  return options.filter((o) => o.modifier_group_id === groupId);
}

/** How many modifier groups an item has attached. */
export function groupCountForItem(groupsByItem: Record<string, string[]>, itemId: string): number {
  return (groupsByItem[itemId] ?? []).length;
}

/** Categories in display order - `sort_order`, then name as the tie-break. */
export function sortedCategories(categories: BuilderCategory[]): BuilderCategory[] {
  return [...categories].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
}

/**
 * The menu as the public E-Menu would render it: active categories, published
 * AND available items, in order.
 *
 * This is the same predicate the POS loader uses (`status = 'published'`,
 * `is_available = true`, `archived_at is null`) and the same one the public menu
 * applies, which is what makes the preview a preview rather than a mock-up.
 */
export function previewSections(
  categories: BuilderCategory[],
  items: BuilderItem[],
): { category: BuilderCategory; items: BuilderItem[] }[] {
  const live = items.filter((i) => i.status === "published" && i.is_available && !i.archived_at);
  return sortedCategories(categories)
    .filter((c) => c.status === "active")
    .map((category) => ({ category, items: live.filter((i) => i.category_id === category.id) }))
    .filter((section) => section.items.length > 0);
}

/** Published-and-available items with no category - shown last in the preview. */
export function previewUncategorized(items: BuilderItem[]): BuilderItem[] {
  return items.filter((i) => i.status === "published" && i.is_available && !i.archived_at && !i.category_id);
}

export type MenuHealth = { total: number; published: number; drafts: number; noPrice: number; noCategory: number };

/** The counts the header strip reports. One pass, no extra reads. */
export function menuHealth(items: BuilderItem[]): MenuHealth {
  const health: MenuHealth = { total: items.length, published: 0, drafts: 0, noPrice: 0, noCategory: 0 };
  for (const item of items) {
    if (item.status === "published") health.published += 1;
    if (item.status === "draft") health.drafts += 1;
    if (item.price == null && item.price_amount_usd == null) health.noPrice += 1;
    if (!item.category_id) health.noCategory += 1;
  }
  return health;
}
