// The two CANONICAL layouts: Default and Categories.
//
// THE DIRECTION OF THE ARROW IS THE WHOLE DESIGN. The canonical menu is the
// source; this module holds only what the cashier CHANGED about how it is
// presented on their till. It never stores a name, a price, a category
// membership or a list of items.
//
// Why that matters more than it looks: the alternative - copying categories and
// items into the layout when it is created - produces a layout that is correct
// on the day it is built and wrong forever after. A new item added in Menu
// Builder would never appear. A renamed category would keep its old name. A
// price change would not reach the button. Every one of those is silent, and
// every one of them is discovered by a cashier mid-service.
//
// So a new canonical category or item appears AUTOMATICALLY, with no override
// and no migration: `resolve*` walks the canonical list and consults the
// override map only for the entries that have one. An override for something
// that no longer exists is simply never read (and is pruned when the operator
// next saves), so the map cannot rot into a second menu.
//
// HIDING IS NOT DELETING. `hidden: true` removes a button from THIS terminal's
// layout. Nothing in this module can reach `menu_categories` or `menu_items`,
// which is what makes "the cashier tidied their screen" and "somebody deleted a
// product" different actions - see the source assertion in the tests.

import type { MenuCategory, MenuItem } from "@/types/pos";
import type { GridButton, PresentationMap, PresentationOverride } from "@/lib/pos/grid/model";

/** The canonical id a presentation override is keyed by. */
export function overrideKey(kind: "category" | "item", id: string): string {
  return `${kind}:${id}`;
}

export function readOverride(map: PresentationMap, kind: "category" | "item", id: string): PresentationOverride {
  return map[overrideKey(kind, id)] ?? {};
}

/** Merge one change into the map, dropping an override that says nothing. */
export function writeOverride(
  map: PresentationMap,
  kind: "category" | "item",
  id: string,
  patch: PresentationOverride,
): PresentationMap {
  const key = overrideKey(kind, id);
  const next: PresentationOverride = { ...(map[key] ?? {}), ...patch };

  // An override that has been reset to "nothing changed" is REMOVED rather than
  // stored as an empty object. Otherwise the map grows one entry per button the
  // operator ever touched, and "has this been customised?" stops being
  // answerable by looking at it.
  for (const field of Object.keys(next) as (keyof PresentationOverride)[]) {
    const value = next[field];
    if (value === undefined || value === null) delete next[field];
  }
  if (next.hidden === false) delete next.hidden;

  const out = { ...map };
  if (Object.keys(next).length === 0) delete out[key];
  else out[key] = next;
  return out;
}

/** Restore a hidden button to the layout. */
export function restore(map: PresentationMap, kind: "category" | "item", id: string): PresentationMap {
  return writeOverride(map, kind, id, { hidden: undefined });
}

// ------------------------------------------------------------- resolution ---

/**
 * A button the canonical layouts render.
 *
 * It carries the CANONICAL id and nothing derived from it - the price is looked
 * up at render time from the menu, exactly as the customized grid does, so there
 * is one price source in the application.
 */
export type ResolvedButton = GridButton & {
  /** True when this button opens a category page. */
  opensCategory: boolean;
};

function toButton(input: {
  kind: "category" | "item";
  id: string;
  canonicalName: string;
  override: PresentationOverride;
}): ResolvedButton {
  const { kind, id, canonicalName, override } = input;
  return {
    id: overrideKey(kind, id),
    kind: kind === "category" ? "category" : "menu_item",
    // The cashier's label wins, and the canonical name is the fallback. A blank
    // override is treated as absent so an accidental empty string cannot produce
    // an unnamed key.
    label: override.label?.trim() ? override.label.trim() : canonicalName,
    menuItemId: kind === "item" ? id : null,
    iconKey: override.iconKey ?? null,
    color: override.color ?? null,
    // Placement is decided by the sizing engine for these layouts; the model's
    // row/col exist for the customized grid and are filled in by the renderer.
    row: 1,
    col: 1,
    width: 1,
    height: 1,
    children: [],
    opensCategory: kind === "category",
  };
}

/** Order by the operator's `sort` where present, then by canonical position. */
function ordered<T extends { id: string }>(
  entries: T[],
  kind: "category" | "item",
  map: PresentationMap,
): { entry: T; override: PresentationOverride; index: number }[] {
  return entries
    .map((entry, index) => ({ entry, override: readOverride(map, kind, entry.id), index }))
    .filter((row) => row.override.hidden !== true)
    .sort((a, b) => {
      const sa = typeof a.override.sort === "number" ? a.override.sort : a.index;
      const sb = typeof b.override.sort === "number" ? b.override.sort : b.index;
      if (sa !== sb) return sa - sb;
      // Ties fall back to canonical order, so the result is total and stable -
      // two renders of the same menu must not swap two buttons.
      return a.index - b.index;
    });
}

/**
 * The DEFAULT layout's buttons: every available menu item, canonical order.
 *
 * This is what the till has always shown; the only thing that is new is that a
 * cashier may reorder, recolour, rename or hide one for their own screen.
 */
export function resolveDefaultButtons(items: MenuItem[], map: PresentationMap): ResolvedButton[] {
  return ordered(items, "item", map).map(({ entry, override }) =>
    toButton({ kind: "item", id: entry.id, canonicalName: entry.name, override }),
  );
}

/**
 * The CATEGORIES layout's top level: the tenant's own menu categories.
 *
 * Only categories that actually have a visible item are offered - a category
 * button that opens an empty page is a dead end a cashier has to back out of.
 */
export function resolveCategoryButtons(
  categories: MenuCategory[],
  items: MenuItem[],
  map: PresentationMap,
): ResolvedButton[] {
  const withItems = new Set(
    items.filter((i) => readOverride(map, "item", i.id).hidden !== true).map((i) => i.category_id).filter(Boolean) as string[],
  );
  return ordered(categories.filter((c) => withItems.has(c.id)), "category", map).map(({ entry, override }) =>
    toButton({ kind: "category", id: entry.id, canonicalName: entry.name, override }),
  );
}

/** The items inside one canonical category, in the operator's chosen order. */
export function resolveCategoryItems(
  categoryId: string,
  items: MenuItem[],
  map: PresentationMap,
): ResolvedButton[] {
  return resolveDefaultButtons(items.filter((i) => i.category_id === categoryId), map);
}

/**
 * Items in no category at all.
 *
 * Offered as a final "Other" page rather than dropped: an item with a null
 * `category_id` is still a product the tenant sells, and a Categories layout
 * that silently cannot reach it is a layout that loses sales.
 */
export function resolveUncategorised(items: MenuItem[], map: PresentationMap): ResolvedButton[] {
  return resolveDefaultButtons(items.filter((i) => !i.category_id), map);
}

export const UNCATEGORISED_ID = "__uncategorised__";

/**
 * Prune overrides whose canonical target no longer exists.
 *
 * Called when the operator saves, never on read: an item that is briefly absent
 * because the menu is still loading must not have its colour thrown away.
 */
export function pruneOverrides(map: PresentationMap, categories: MenuCategory[], items: MenuItem[]): PresentationMap {
  const live = new Set<string>([
    ...categories.map((c) => overrideKey("category", c.id)),
    ...items.map((i) => overrideKey("item", i.id)),
  ]);
  const out: PresentationMap = {};
  for (const [key, value] of Object.entries(map)) if (live.has(key)) out[key] = value;
  return out;
}

/** How many canonical buttons this terminal has hidden. Shown in the editor. */
export function hiddenCount(map: PresentationMap): number {
  return Object.values(map).filter((o) => o.hidden === true).length;
}

/**
 * Move a button to a new position within its list, as a new override map.
 *
 * Writes an explicit `sort` for EVERY entry in the list, not just the moved one.
 * Storing one index against an otherwise-canonical order works until the menu
 * changes underneath it, at which point the single stored index means something
 * different; writing the whole order makes the result independent of what the
 * canonical order happens to be later.
 */
export function reorder(
  map: PresentationMap,
  kind: "category" | "item",
  orderedIds: string[],
): PresentationMap {
  let out = map;
  orderedIds.forEach((id, index) => {
    out = writeOverride(out, kind, id, { sort: index });
  });
  return out;
}
