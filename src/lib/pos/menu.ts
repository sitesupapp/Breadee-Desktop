// POS menu loading - the same contract the web POS uses.
//
// The previous desktop implementation ran a single flat `menu_items` select with
// no category, no modifier group, and no price metadata, which meant:
//   * items published-but-unavailable were still addable,
//   * an LBP-primary tenant saw the legacy column instead of the normalized USD
//     basis (the price could be wrong by the exchange rate),
//   * required modifier groups were invisible, so every order with a mandatory
//     choice would be refused by m241 at submit time.
//
// This mirrors the web loader exactly: five tenant-scoped reads under RLS, then
// prices resolved through the canonical resolver. Recipe/costing tables are NOT
// read - the POS contract does not need them and this level does not add them.

import { PRICE_METADATA_COLUMNS } from "@/lib/pos/menuPrice";
import type { MenuCategory, MenuData, MenuItem, ModifierGroup, ModifierOption } from "@/types/pos";

export const MENU_SNAPSHOT_KEY = "pos.menu";

const EMPTY: MenuData = { categories: [], items: [], groups: [], options: [], groupsByItem: {} };

/**
 * Load the full POS menu for a tenant. Every query is tenant-scoped; RLS is the
 * real boundary. Only ACTIVE/PUBLISHED and AVAILABLE rows are returned, matching
 * the web POS - an unavailable item is never offered rather than offered and
 * refused.
 */
export async function loadMenu(tenantId: string): Promise<MenuData> {
  // Lazy so the pure helpers below stay importable without a built environment.
  const { supabase } = await import("@/lib/supabase");
  const [cats, items, groups, options, links] = await Promise.all([
    supabase
      .from("menu_categories")
      .select("id, name")
      .eq("tenant_id", tenantId)
      .eq("status", "active")
      .order("sort_order"),
    supabase
      .from("menu_items")
      .select(`id, name, price, category_id, image_url, ${PRICE_METADATA_COLUMNS}`)
      .eq("tenant_id", tenantId)
      .eq("status", "published")
      .eq("is_available", true)
      .is("archived_at", null)
      .order("sort_order"),
    supabase
      .from("modifier_groups")
      .select("id, name, selection_type, is_required, min_select, max_select")
      .eq("tenant_id", tenantId)
      .eq("status", "active"),
    supabase
      .from("modifier_options")
      .select(`id, modifier_group_id, name, extra_price, ${PRICE_METADATA_COLUMNS}`)
      .eq("tenant_id", tenantId)
      .eq("status", "active")
      .order("sort_order"),
    supabase.from("menu_item_modifier_groups").select("menu_item_id, modifier_group_id").eq("tenant_id", tenantId),
  ]);

  const firstError = cats.error ?? items.error ?? groups.error ?? options.error ?? links.error;
  if (firstError) throw new Error(firstError.message);

  const groupsByItem: Record<string, string[]> = {};
  for (const row of (links.data ?? []) as { menu_item_id: string; modifier_group_id: string }[]) {
    (groupsByItem[row.menu_item_id] ??= []).push(row.modifier_group_id);
  }

  // `src/lib/database.types.ts` was generated before the m212/m213 price-metadata
  // columns existed, so the typed client cannot describe these two selects. The
  // columns DO exist on staging (they are what `resolveMenuPrice` reads), so the
  // rows are re-typed here through `unknown` rather than dropping the metadata.
  // Regenerating the schema types is the proper fix and is out of scope for this
  // level; `PRICE_METADATA_COLUMNS` keeps the select and the type in one place.
  return {
    categories: (cats.data ?? []) as MenuCategory[],
    items: (items.data ?? []) as unknown as MenuItem[],
    groups: (groups.data ?? []) as ModifierGroup[],
    options: (options.data ?? []) as unknown as ModifierOption[],
    groupsByItem,
  };
}

/**
 * Cache the menu for fast route switching and offline RENDERING. This is a
 * read-only convenience: an offline cashier can look at the menu, but ordering
 * stays blocked (there is no offline capture in this level).
 */
export async function cacheMenu(menu: MenuData, tenantId: string, branchId: string | null): Promise<void> {
  const { localdb } = await import("@/lib/offline/db");
  await localdb.snapshots.put({
    key: MENU_SNAPSHOT_KEY,
    tenant_id: tenantId,
    branch_id: branchId,
    data: menu,
    cached_at: new Date().toISOString(),
  });
}

export async function readCachedMenu(tenantId: string): Promise<{ menu: MenuData; cachedAt: string } | null> {
  const { localdb } = await import("@/lib/offline/db");
  const snap = await localdb.snapshots.get(MENU_SNAPSHOT_KEY);
  // Never serve another tenant's cache, even if the purge has not run yet.
  if (!snap || snap.tenant_id !== tenantId) return null;
  const data = snap.data as Partial<MenuData> | null;
  if (!data || !Array.isArray(data.items)) return null;
  return { menu: { ...EMPTY, ...data } as MenuData, cachedAt: snap.cached_at };
}

/** Case-insensitive substring match over the pre-lowered name. Cheap enough for 500+ items. */
export type SearchableItem = MenuItem & { searchName: string };

export function withSearchIndex(items: MenuItem[]): SearchableItem[] {
  return items.map((i) => ({ ...i, searchName: i.name.toLowerCase() }));
}

export function filterItems(items: SearchableItem[], categoryId: string | null, query: string): SearchableItem[] {
  const q = query.trim().toLowerCase();
  return items.filter((i) => {
    if (categoryId && i.category_id !== categoryId) return false;
    if (q === "") return true;
    return i.searchName.includes(q);
  });
}

/** Categories that actually have at least one available item, plus "All". */
export function usableCategories(menu: Pick<MenuData, "categories" | "items">): MenuCategory[] {
  const used = new Set(menu.items.map((i) => i.category_id).filter(Boolean) as string[]);
  return menu.categories.filter((c) => used.has(c.id));
}
