// THE OU-AWARE MENU BUILDER BACKEND — the Desktop's counterpart to the web
// WorkspaceClient's per-Operating-Unit menu authoring.
//
// WHAT AND WHY. The Menu Builder authors ONE Operating Unit's operational menu.
// Reads come from `menu_builder_ou(branch)` (that unit's categories/items/
// modifiers with per-OU overrides — a fresh unit is genuinely blank, never the
// tenant catalog / Main / a sibling). Writes go through the authoritative OU
// RPCs, so an item's catalog identity and its OU membership are created
// ATOMICALLY and a Desktop-created item is never a tenant-wide orphan. Every one
// of these is the SAME RPC the web Menu Builder calls — this module is a thin,
// typed Desktop client of that contract, nothing more.
//
// NO IMPLICIT MAIN. Every function requires an explicit `branchId`; there is no
// default branch here. The caller (the screen) refuses to write without a
// selected unit, and these functions would target no unit if asked.
//
// PRICING. Selling prices are written by the secured per-OU price RPCs
// (`set_menu_item_branch_price_override` / `set_modifier_option_branch_price_override`),
// which resolve the tenant rate server-side and store the USD/LBP metadata — the
// client never writes a price column, exactly as on the web.

import { supabase } from "@/lib/supabase";
import { canonicalGroupPayload } from "@/lib/menu/modifierGroupConfig";
import { MENU_IMAGE_BUCKET, menuImagePath, optimizeMenuImage, validateImageFile } from "@/lib/menu/image";
import type { CurrencyCode } from "@/lib/currency";
import type {
  BuilderCategory, BuilderGroup, BuilderItem, BuilderOption,
  GroupDraft, ItemDraft, ItemStatus, MenuBuilderData, MenuTheme, QrSettings,
} from "@/lib/menu/types";

function unwrap<T>(res: { data: T | null; error: { message: string } | null }): T | null {
  if (res.error) throw res.error;
  return res.data;
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn as never, args as never);
  if (error) throw error;
  return data as T;
}

// --- operating units (branches the signed-in user may author) ----------------

export type OUBranch = { id: string; name: string; is_main: boolean };

/**
 * The Operating Units this user can author, straight from `branches` under RLS:
 * an owner sees every branch; a branch-scoped user sees only their own. No Main
 * is pre-selected by the caller — the screen starts with nothing chosen.
 */
export async function listBranches(tenantId: string): Promise<OUBranch[]> {
  const rows = unwrap(
    await supabase.from("branches").select("id, name, is_main").eq("tenant_id", tenantId).order("is_main", { ascending: false }).order("name"),
  ) as OUBranch[] | null;
  return rows ?? [];
}

// --- read --------------------------------------------------------------------

/**
 * Everything one Menu Builder session needs, for ONE Operating Unit. The menu is
 * the `menu_builder_ou` projection for the branch; QR settings are that unit's
 * own row (a fresh unit has none) and themes are tenant-wide. Shape matches the
 * tenant-wide `loadMenuBuilderData` so the screen consumes it unchanged.
 */
export async function loadMenuBuilderOU(tenantId: string, branchId: string): Promise<MenuBuilderData> {
  const [menuRes, qr, themes] = await Promise.all([
    supabase.rpc("menu_builder_ou" as never, { p_branch: branchId } as never),
    supabase.from("qr_menu_settings").select("*").eq("tenant_id", tenantId).eq("branch_id", branchId).order("created_at").limit(1),
    supabase.from("public_menu_themes").select("*"),
  ]);
  if (menuRes.error) throw menuRes.error;
  if (qr.error) throw qr.error;
  if (themes.error) throw themes.error;
  const menu = ((menuRes.data ?? {}) as {
    categories?: BuilderCategory[]; items?: BuilderItem[]; groups?: BuilderGroup[]; options?: BuilderOption[];
    item_groups?: { menu_item_id: string; modifier_group_id: string }[];
  });
  const groupsByItem: Record<string, string[]> = {};
  for (const row of menu.item_groups ?? []) {
    (groupsByItem[row.menu_item_id] ??= []).push(row.modifier_group_id);
  }
  return {
    categories: (menu.categories ?? []) as BuilderCategory[],
    items: (menu.items ?? []) as unknown as BuilderItem[],
    groups: (menu.groups ?? []) as BuilderGroup[],
    options: (menu.options ?? []) as unknown as BuilderOption[],
    groupsByItem,
    qr: ((qr.data ?? [])[0] as QrSettings | undefined) ?? null,
    themes: (themes.data ?? []) as MenuTheme[],
  };
}

// --- categories --------------------------------------------------------------

/**
 * Upsert ONE category's OU instance. Every write carries the FULL current row
 * (name/name_ar/sort_order/status) because `menu_ou_save_category` upserts the
 * instance wholesale — omitting a field would reset it. This one primitive backs
 * save / reorder / show-hide / archive, exactly as the web builder does. Archive
 * is `status:"archived"` (there is no separate remove RPC); the catalog identity
 * and any order history are preserved.
 */
export type CategoryOUWrite = { category_id: string | null; name: string; name_ar: string | null; sort_order: number; status: string };
export async function saveCategoryOU(branchId: string, p: CategoryOUWrite): Promise<void> {
  await rpc("menu_ou_save_category", { p_payload: { branch_id: branchId, ...p } });
}

// --- items -------------------------------------------------------------------

export type SaveItemOUInput = {
  tenantId: string;
  branchId: string;
  draft: ItemDraft;
  price: { amount: number; currency: CurrencyCode } | null;
  groupIds?: string[];
  file?: File | null;
  clearImage?: boolean;
  nextSortOrder: number;
};

/**
 * Create or edit an item in THIS unit. `menu_ou_save_item` writes the catalog
 * identity (on create) AND this unit's membership atomically, then the modifier
 * assignment and the per-OU price go through their own secured RPCs — the same
 * order the web app uses. Publishing without a valid price is HELD server-side.
 */
export async function saveItemOU(input: SaveItemOUInput): Promise<{ id: string }> {
  const { tenantId, branchId, draft, price, groupIds, file, clearImage, nextSortOrder } = input;
  let image_url = clearImage ? null : (draft.image_url ?? null);
  let thumbnail_url = clearImage ? null : (draft.thumbnail_url ?? null);
  if (file) {
    const invalid = validateImageFile(file);
    if (invalid) throw new Error(invalid);
    const { main, thumb } = await optimizeMenuImage(file);
    const store = supabase.storage.from(MENU_IMAGE_BUCKET);
    const key = draft.id ?? `new-${Date.now()}`;
    const bust = Date.now();
    // Image path is TENANT-scoped (same namespace the web app uses), independent of OU.
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

  const saved = await rpc<{ menu_item_id?: string } | null>("menu_ou_save_item", { p_payload: {
    branch_id: branchId, menu_item_id: draft.id ?? null,
    name: (draft.name ?? "").trim(), name_ar: draft.name_ar?.trim() ? draft.name_ar.trim() : null,
    description: draft.description?.trim() ? draft.description.trim() : null,
    category_id: draft.category_id ?? null, status: (draft.status ?? "draft") as ItemStatus,
    is_available: draft.is_available ?? true, image_url, thumbnail_url,
    // Always send sort_order — the OU upsert rewrites it, so omitting it would reset to 0.
    sort_order: nextSortOrder,
  } });
  const itemId = saved?.menu_item_id ?? draft.id;
  if (!itemId) throw new Error("The item was not saved.");
  if (groupIds) await rpc("menu_ou_set_item_modifiers", { p_payload: { branch_id: branchId, menu_item_id: itemId, group_ids: groupIds } });
  if (price) await setItemPriceOU(branchId, itemId, price.amount, price.currency);
  return { id: itemId };
}

export async function setItemPriceOU(branchId: string, itemId: string, amount: number, currency: CurrencyCode): Promise<void> {
  await rpc("set_menu_item_branch_price_override", { p_menu_item: itemId, p_branch: branchId, p_amount: amount, p_currency: currency });
}

export async function setItemStatusOU(branchId: string, item: BuilderItem, status: ItemStatus): Promise<void> {
  await rpc("menu_ou_save_item", { p_payload: {
    branch_id: branchId, menu_item_id: item.id, name: item.name, name_ar: item.name_ar,
    description: item.description, category_id: item.category_id, is_available: item.is_available,
    image_url: item.image_url, sort_order: item.sort_order, status,
  } });
}

export async function setItemAvailabilityOU(branchId: string, item: BuilderItem, isAvailable: boolean): Promise<void> {
  await rpc("menu_ou_save_item", { p_payload: {
    branch_id: branchId, menu_item_id: item.id, name: item.name, name_ar: item.name_ar,
    description: item.description, category_id: item.category_id, is_available: isAvailable,
    image_url: item.image_url, sort_order: item.sort_order, status: item.status,
  } });
}

/** Remove an item from THIS unit's menu only (identity + order history preserved). */
export async function archiveItemOU(branchId: string, itemId: string): Promise<void> {
  await rpc("menu_ou_remove_item", { p_menu_item: itemId, p_branch: branchId });
}

/** Publish this unit's drafts (per-OU membership rows), independently of other units. */
export async function publishAllDraftsOU(branchId: string): Promise<void> {
  // `status` on menu_item_branch_availability postdates the generated types (repo↔DB
  // drift), so `.filter` (string column) is used to avoid the stale column union.
  const { error } = await supabase
    .from("menu_item_branch_availability")
    .update({ status: "published" } as never)
    .eq("branch_id", branchId)
    .filter("status", "eq", "draft")
    .select("menu_item_id");
  if (error) throw error;
}

// --- modifiers ---------------------------------------------------------------

export async function saveGroupOU(branchId: string, draft: GroupDraft): Promise<void> {
  const name = (draft.name ?? "").trim();
  const config = canonicalGroupPayload(draft);
  await rpc("menu_ou_save_modifier_group", { p_payload: { branch_id: branchId, modifier_group_id: draft.id ?? null, name, ...config } });
}

export async function archiveGroupOU(branchId: string, groupId: string): Promise<void> {
  await rpc("menu_ou_remove_modifier_group", { p_group: groupId, p_branch: branchId });
}

export async function addOptionOU(branchId: string, groupId: string, name: string, extra: number, currency: CurrencyCode): Promise<void> {
  const created = await rpc<{ modifier_option_id?: string } | null>("menu_ou_save_modifier_option", {
    p_payload: { branch_id: branchId, modifier_group_id: groupId, name: name.trim() },
  });
  const optId = created?.modifier_option_id;
  if (!optId) throw new Error("The option was not added.");
  await rpc("set_modifier_option_branch_price_override", { p_option: optId, p_branch: branchId, p_amount: extra, p_currency: currency });
}

export async function archiveOptionOU(branchId: string, optionId: string): Promise<void> {
  await rpc("menu_ou_remove_modifier_option", { p_option: optionId, p_branch: branchId });
}

// --- public / QR menu (per Operating Unit) -----------------------------------

export async function ensureQrSettingsOU(tenantId: string, branchId: string): Promise<QrSettings> {
  const existing = unwrap(
    await supabase.from("qr_menu_settings").select("*").eq("tenant_id", tenantId).eq("branch_id", branchId).order("created_at").limit(1),
  ) as QrSettings[] | null;
  const current = existing?.[0] ?? null;
  if (current?.public_slug) return current;
  const slug = `breadee-${Math.random().toString(36).slice(2, 9)}`;
  if (current) {
    const patched = unwrap(
      await supabase.from("qr_menu_settings").update({ public_slug: slug }).eq("id", current.id).select("*").maybeSingle(),
    ) as QrSettings | null;
    if (!patched) throw new Error("The public menu could not be created.");
    return patched;
  }
  const created = unwrap(
    await supabase.from("qr_menu_settings")
      .upsert({ tenant_id: tenantId, branch_id: branchId, public_slug: slug, show_prices: true, is_public: false }, { onConflict: "tenant_id,branch_id" })
      .select("*").maybeSingle(),
  ) as QrSettings | null;
  if (!created) throw new Error("The public menu could not be created.");
  return created;
}

export async function saveQrSettingsOU(id: string, patch: Partial<QrSettings>): Promise<void> {
  unwrap(await supabase.from("qr_menu_settings").update(patch).eq("id", id).select("id"));
}
