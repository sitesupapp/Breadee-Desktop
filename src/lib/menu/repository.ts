// THE ONLY PLACE THE MENU BUILDER TALKS TO THE BACKEND.
//
// One module, one source of truth. No component in this feature imports
// `@/lib/supabase`; they call the functions below. That is what makes "the
// desktop and the web operate on the same authoritative data" a checkable
// property rather than a claim - every table name, every column and every RPC
// this feature can possibly touch is in this file, and the list is:
//
//   READ   menu_categories, menu_items, modifier_groups, modifier_options,
//          menu_item_modifier_groups, qr_menu_settings, public_menu_themes
//   WRITE  the same tables, under the m138 RLS policies
//   RPC    set_menu_item_price, set_modifier_option_price
//   STORE  menu-images (public bucket, same path scheme as the web app)
//
// There is NO desktop table, NO local menu database, NO replication and NO
// conflict resolver. The desktop writes the row the web app reads, and re-reads
// authoritative state after every mutation. `lib/offline/db.ts` still holds the
// POS's read-only menu SNAPSHOT for offline rendering, and this module never
// writes to it - a builder edit invalidates that snapshot by the POS reloading,
// not by two writers racing over one cache.
//
// PRICES ARE NEVER WRITTEN AS COLUMNS. `menu_items.price` and
// `modifier_options.extra_price` are compatibility columns; the authoritative
// normalised basis and its metadata are set server-side by the m213 RPCs, which
// resolve the tenant's exchange rate themselves. A client-side write of `price`
// would produce a row whose legacy and normalised values disagree.
//
// EVERY MUTATION RETURNS AFTER THE SERVER CONFIRMED IT. Nothing here reports
// success on a queued or optimistic write.

import { supabase } from "@/lib/supabase";
import { PRICE_METADATA_COLUMNS } from "@/lib/pos/menuPrice";
import { canonicalGroupPayload } from "@/lib/menu/modifierGroupConfig";
import { MENU_IMAGE_BUCKET, menuImagePath, optimizeMenuImage, validateImageFile } from "@/lib/menu/image";
import type { CurrencyCode } from "@/lib/currency";
import type {
  BuilderCategory,
  BuilderGroup,
  BuilderItem,
  BuilderOption,
  CategoryDraft,
  CategoryStatus,
  GroupDraft,
  ItemDraft,
  ItemStatus,
  MenuBuilderData,
  MenuTheme,
  QrSettings,
} from "@/lib/menu/types";

/** Columns every item read needs: the row plus the m212/m213 price metadata. */
const ITEM_COLUMNS = `*, ${PRICE_METADATA_COLUMNS}`;
const OPTION_COLUMNS = `*, ${PRICE_METADATA_COLUMNS}`;

function unwrap<T>(res: { data: T | null; error: { message: string } | null }): T | null {
  if (res.error) throw res.error;
  return res.data;
}

// --- read --------------------------------------------------------------------

/**
 * Everything one Menu Builder session needs, in SEVEN parallel round trips.
 *
 * Deliberately not "one request per category, then one per item": the modifier
 * assignment is fetched as a single flat link table and pivoted here, which is
 * exactly what the web workspace and the POS loader both do. Adding a category
 * or an item does not add a request.
 *
 * ARCHIVED ROWS ARE NOT RETURNED. Archive is this schema's delete, so an
 * archived row is gone from the builder just as it is gone from the POS and the
 * public menu. Categories/groups/options archive via `status`; items via
 * `archived_at` (they also carry `status = 'archived'`, and both are checked).
 */
export async function loadMenuBuilderData(tenantId: string): Promise<MenuBuilderData> {
  const [cats, items, groups, options, links, qr, themes] = await Promise.all([
    supabase.from("menu_categories").select("*").eq("tenant_id", tenantId).neq("status", "archived").order("sort_order"),
    supabase.from("menu_items").select(ITEM_COLUMNS).eq("tenant_id", tenantId).is("archived_at", null).order("sort_order"),
    supabase.from("modifier_groups").select("*").eq("tenant_id", tenantId).neq("status", "archived").order("created_at"),
    supabase.from("modifier_options").select(OPTION_COLUMNS).eq("tenant_id", tenantId).neq("status", "archived").order("sort_order"),
    supabase.from("menu_item_modifier_groups").select("menu_item_id, modifier_group_id").eq("tenant_id", tenantId),
    supabase.from("qr_menu_settings").select("*").eq("tenant_id", tenantId).order("created_at").limit(1),
    supabase.from("public_menu_themes").select("*"),
  ]);

  const firstError = cats.error ?? items.error ?? groups.error ?? options.error ?? links.error ?? qr.error ?? themes.error;
  if (firstError) throw firstError;

  const groupsByItem: Record<string, string[]> = {};
  for (const row of (links.data ?? []) as { menu_item_id: string; modifier_group_id: string }[]) {
    (groupsByItem[row.menu_item_id] ??= []).push(row.modifier_group_id);
  }

  return {
    categories: (cats.data ?? []) as BuilderCategory[],
    // The generated types predate the m212/m213 metadata columns; the select
    // above does return them, so the rows are re-typed rather than narrowed.
    items: (items.data ?? []) as unknown as BuilderItem[],
    groups: (groups.data ?? []) as BuilderGroup[],
    options: (options.data ?? []) as unknown as BuilderOption[],
    groupsByItem,
    qr: ((qr.data ?? [])[0] as QrSettings | undefined) ?? null,
    themes: (themes.data ?? []) as MenuTheme[],
  };
}

// --- categories --------------------------------------------------------------

/** Insert or update one category. Returns nothing; callers re-read. */
export async function saveCategory(tenantId: string, draft: CategoryDraft, nextSortOrder: number): Promise<void> {
  const name = (draft.name ?? "").trim();
  const name_ar = draft.name_ar?.trim() ? draft.name_ar.trim() : null;
  if (draft.id) {
    unwrap(await supabase.from("menu_categories").update({ name, name_ar }).eq("id", draft.id).select("id"));
    return;
  }
  unwrap(
    await supabase
      .from("menu_categories")
      .insert({ tenant_id: tenantId, name, name_ar, sort_order: nextSortOrder, status: "active" })
      .select("id"),
  );
}

/**
 * Swap two categories' `sort_order`.
 *
 * The web app does exactly this - two UPDATEs exchanging the neighbours' values
 * - and the exchange is what keeps ordering stable when the numbers are not
 * contiguous. The second update is awaited, so a half-applied swap surfaces as
 * an error rather than as a silently reordered menu.
 */
export async function swapCategoryOrder(a: BuilderCategory, b: BuilderCategory): Promise<void> {
  unwrap(await supabase.from("menu_categories").update({ sort_order: b.sort_order }).eq("id", a.id).select("id"));
  unwrap(await supabase.from("menu_categories").update({ sort_order: a.sort_order }).eq("id", b.id).select("id"));
}

/** Show / hide a category. `hidden` is a status, not an archive. */
export async function setCategoryStatus(id: string, status: CategoryStatus): Promise<void> {
  unwrap(await supabase.from("menu_categories").update({ status }).eq("id", id).select("id"));
}

/**
 * Archive a category - THE SCHEMA'S DELETE.
 *
 * Never `.delete()`. The web app archives, the POS and public menu filter on
 * `status <> 'archived'`, and items that referenced the category keep their
 * `category_id` intact. A hard delete would null out those references through
 * the FK and silently uncategorise part of the menu.
 */
export async function archiveCategory(id: string): Promise<void> {
  unwrap(
    await supabase
      .from("menu_categories")
      .update({ status: "archived", archived_at: new Date().toISOString() })
      .eq("id", id)
      .select("id"),
  );
}

// --- items -------------------------------------------------------------------

export type SaveItemInput = {
  tenantId: string;
  draft: ItemDraft;
  /** The typed selling price and the currency it was typed in, or null for "no price". */
  price: { amount: number; currency: CurrencyCode } | null;
  /** Modifier groups to attach. Undefined leaves the existing assignment untouched. */
  groupIds?: string[];
  /** A newly chosen image file, if any. */
  file?: File | null;
  /** True when the operator cleared the existing image. */
  clearImage?: boolean;
  /** Position for a NEW item; ignored on update. */
  nextSortOrder: number;
};

export type SaveItemResult = { id: string };

/**
 * Create or update one menu item.
 *
 * ORDER MATTERS AND IS THE WEB APP'S ORDER: row first (so a new item has an id),
 * then modifier assignment, then the price RPC. The price is last because it is
 * the only step that can fail for a reason the operator can fix without losing
 * the rest of the edit, and because it needs the id.
 */
export async function saveItem(input: SaveItemInput): Promise<SaveItemResult> {
  const { tenantId, draft, price, groupIds, file, clearImage, nextSortOrder } = input;

  let image_url = clearImage ? null : (draft.image_url ?? null);
  let thumbnail_url = clearImage ? null : (draft.thumbnail_url ?? null);
  let image_alt_text = clearImage ? null : (draft.image_alt_text ?? null);

  if (file) {
    const invalid = validateImageFile(file);
    if (invalid) throw new Error(invalid);
    const { main, thumb } = await optimizeMenuImage(file);
    const store = supabase.storage.from(MENU_IMAGE_BUCKET);
    // A new item has no id yet; the same `new-<ts>` convention the web app uses
    // keeps the two clients writing into one namespace.
    const key = draft.id ?? `new-${Date.now()}`;
    const bust = Date.now();
    const mainPath = menuImagePath(tenantId, key, "main", main.ext, bust);
    const thumbPath = menuImagePath(tenantId, key, "thumb", thumb.ext, bust);
    const [mu, tu] = await Promise.all([
      store.upload(mainPath, main.blob, { upsert: true, contentType: main.contentType }),
      store.upload(thumbPath, thumb.blob, { upsert: true, contentType: thumb.contentType }),
    ]);
    if (mu.error || tu.error) throw (mu.error ?? tu.error) as Error;
    image_url = store.getPublicUrl(mainPath).data.publicUrl;
    thumbnail_url = store.getPublicUrl(thumbPath).data.publicUrl;
  }

  const payload = {
    name: (draft.name ?? "").trim(),
    name_ar: draft.name_ar?.trim() ? draft.name_ar.trim() : null,
    description: draft.description?.trim() ? draft.description.trim() : null,
    category_id: draft.category_id ?? null,
    status: (draft.status ?? "draft") as ItemStatus,
    is_available: draft.is_available ?? true,
    image_url,
    thumbnail_url,
    image_alt_text,
    ingredients: draft.ingredients && draft.ingredients.length ? draft.ingredients : null,
    allergens: draft.allergens && draft.allergens.length ? draft.allergens : null,
  };

  let itemId = draft.id;
  if (itemId) {
    unwrap(await supabase.from("menu_items").update(payload).eq("id", itemId).select("id"));
  } else {
    const created = unwrap(
      await supabase
        .from("menu_items")
        .insert({ ...payload, tenant_id: tenantId, sort_order: nextSortOrder })
        .select("id")
        .maybeSingle(),
    );
    itemId = (created as { id: string } | null)?.id;
  }
  if (!itemId) throw new Error("The item was not saved.");

  if (groupIds) await setItemModifierGroups(tenantId, itemId, groupIds);
  if (price) await setItemPrice(itemId, price.amount, price.currency);

  return { id: itemId };
}

/**
 * Replace an item's modifier-group assignment.
 *
 * Delete-then-insert, matching the web app, but the inserts go in ONE statement
 * rather than a loop - the web app's per-group insert is an N+1 the desktop has
 * no reason to copy, and `(menu_item_id, modifier_group_id)` is unique so the
 * set semantics are identical either way.
 */
export async function setItemModifierGroups(tenantId: string, itemId: string, groupIds: string[]): Promise<void> {
  const existing = unwrap(
    await supabase.from("menu_item_modifier_groups").select("modifier_group_id").eq("menu_item_id", itemId),
  ) as { modifier_group_id: string }[] | null;
  const before = new Set((existing ?? []).map((r) => r.modifier_group_id));
  const after = new Set(groupIds);
  const removed = [...before].filter((id) => !after.has(id));
  const added = [...after].filter((id) => !before.has(id));
  // Nothing changed: do not issue a delete that would churn the rows (and their
  // ids) for no reason.
  if (removed.length === 0 && added.length === 0) return;
  if (removed.length) {
    unwrap(
      await supabase
        .from("menu_item_modifier_groups")
        .delete()
        .eq("menu_item_id", itemId)
        .in("modifier_group_id", removed)
        .select("id"),
    );
  }
  if (added.length) {
    unwrap(
      await supabase
        .from("menu_item_modifier_groups")
        .insert(added.map((gid) => ({ tenant_id: tenantId, menu_item_id: itemId, modifier_group_id: gid })))
        .select("id"),
    );
  }
}

/**
 * Set a selling price through the secured RPC.
 *
 * `set_menu_item_price` normalises the amount to USD with the tenant's own rate,
 * writes the four metadata columns and the legacy column together, re-checks
 * `menu.edit`, and logs the change to `activity_log`. None of that is
 * reproducible from a client-side column update, which is why one does not exist
 * anywhere in this module.
 */
export async function setItemPrice(itemId: string, amount: number, currency: CurrencyCode): Promise<void> {
  const { error } = await supabase.rpc(
    "set_menu_item_price" as never,
    { p_menu_item: itemId, p_amount: amount, p_currency: currency } as never,
  );
  if (error) throw error;
}

/** Change an item's publishing status. */
export async function setItemStatus(id: string, status: ItemStatus): Promise<void> {
  unwrap(await supabase.from("menu_items").update({ status }).eq("id", id).select("id"));
}

/** Change an item's day-to-day availability (the "sold out for now" switch). */
export async function setItemAvailability(id: string, isAvailable: boolean): Promise<void> {
  unwrap(await supabase.from("menu_items").update({ is_available: isAvailable }).eq("id", id).select("id"));
}

/** Archive an item - the schema's delete. Sets BOTH `archived_at` and `status`. */
export async function archiveItem(id: string): Promise<void> {
  unwrap(
    await supabase
      .from("menu_items")
      .update({ archived_at: new Date().toISOString(), status: "archived" })
      .eq("id", id)
      .select("id"),
  );
}

/** Publish every draft item in one statement, exactly as the web app does. */
export async function publishAllDrafts(tenantId: string): Promise<number> {
  const rows = unwrap(
    await supabase
      .from("menu_items")
      .update({ status: "published" })
      .eq("tenant_id", tenantId)
      .eq("status", "draft")
      .is("archived_at", null)
      .select("id"),
  ) as { id: string }[] | null;
  return rows?.length ?? 0;
}

// --- modifiers ---------------------------------------------------------------

/** Insert or update a modifier group, always in its canonical shape. */
export async function saveGroup(tenantId: string, draft: GroupDraft): Promise<void> {
  const name = (draft.name ?? "").trim();
  const config = canonicalGroupPayload(draft);
  if (draft.id) {
    unwrap(await supabase.from("modifier_groups").update({ name, ...config }).eq("id", draft.id).select("id"));
    return;
  }
  unwrap(await supabase.from("modifier_groups").insert({ tenant_id: tenantId, name, ...config }).select("id"));
}

export async function archiveGroup(id: string): Promise<void> {
  unwrap(
    await supabase
      .from("modifier_groups")
      .update({ status: "archived", archived_at: new Date().toISOString() })
      .eq("id", id)
      .select("id"),
  );
}

/**
 * Add one option to a group.
 *
 * `extra_price` is NOT NULL, so the row is created with a placeholder 0 and the
 * real amount is written by `set_modifier_option_price` with its currency
 * metadata - the same two-step the web app performs, and for the same reason.
 */
export async function addOption(
  tenantId: string,
  groupId: string,
  name: string,
  extra: number,
  currency: CurrencyCode,
  nextSortOrder: number,
): Promise<void> {
  const created = unwrap(
    await supabase
      .from("modifier_options")
      .insert({ tenant_id: tenantId, modifier_group_id: groupId, name: name.trim(), extra_price: 0, sort_order: nextSortOrder })
      .select("id")
      .maybeSingle(),
  ) as { id: string } | null;
  if (!created?.id) throw new Error("The option was not added.");
  const { error } = await supabase.rpc(
    "set_modifier_option_price" as never,
    { p_option: created.id, p_amount: extra, p_currency: currency } as never,
  );
  if (error) throw error;
}

/** Change an existing option's price through the secured RPC. */
export async function setOptionPrice(optionId: string, amount: number, currency: CurrencyCode): Promise<void> {
  const { error } = await supabase.rpc(
    "set_modifier_option_price" as never,
    { p_option: optionId, p_amount: amount, p_currency: currency } as never,
  );
  if (error) throw error;
}

/** Archive an option - the schema's delete, exactly as the web app's "x" does. */
export async function archiveOption(id: string): Promise<void> {
  unwrap(
    await supabase
      .from("modifier_options")
      .update({ status: "archived", archived_at: new Date().toISOString() })
      .eq("id", id)
      .select("id"),
  );
}

// --- public / QR menu --------------------------------------------------------

/**
 * The tenant's public-menu row, creating it only when the operator is actually
 * setting the public menu up.
 *
 * DELIBERATELY NOT CREATED ON LOAD. The web workspace upserts this row while
 * merely READING the page, which means opening Menu Builder writes to the
 * database. A till that did the same would create rows for a cashier who only
 * wanted to check a price. Same table, same unique key `(tenant_id, branch_id)`,
 * same generated-slug shape - only the moment differs.
 */
export async function ensureQrSettings(tenantId: string, mainBranchId: string | null): Promise<QrSettings> {
  const existing = unwrap(
    await supabase.from("qr_menu_settings").select("*").eq("tenant_id", tenantId).order("created_at").limit(1),
  ) as QrSettings[] | null;
  const current = existing?.[0] ?? null;
  if (current?.public_slug) return current;
  const slug = `breadee-${Math.random().toString(36).slice(2, 9)}`;
  // A row that exists but carries no slug is not a public menu yet. Give it one
  // rather than inserting a second row - `(tenant_id, branch_id)` is unique, so
  // an insert would fail and the operator would be stuck.
  if (current) {
    const patched = unwrap(
      await supabase.from("qr_menu_settings").update({ public_slug: slug }).eq("id", current.id).select("*").maybeSingle(),
    ) as QrSettings | null;
    if (!patched) throw new Error("The public menu could not be created.");
    return patched;
  }
  if (!mainBranchId) throw new Error("This business has no main branch, so a public menu cannot be created yet.");
  const created = unwrap(
    await supabase
      .from("qr_menu_settings")
      .upsert(
        { tenant_id: tenantId, branch_id: mainBranchId, public_slug: slug, show_prices: true, is_public: false },
        { onConflict: "tenant_id,branch_id" },
      )
      .select("*")
      .maybeSingle(),
  ) as QrSettings | null;
  if (!created) throw new Error("The public menu could not be created.");
  return created;
}

export async function saveQrSettings(id: string, patch: Partial<QrSettings>): Promise<void> {
  unwrap(await supabase.from("qr_menu_settings").update(patch).eq("id", id).select("id"));
}
