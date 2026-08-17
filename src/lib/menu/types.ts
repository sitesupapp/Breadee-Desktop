// Menu Builder domain types.
//
// EVERY FIELD HERE IS A COLUMN THAT ALREADY EXISTS. The desktop Menu Builder is
// a second CLIENT of the web app's menu schema, not a second menu system, so
// this file is deliberately a narrowing of `database.types.ts` rather than a
// design of its own. If a property is not in the generated types (or in the
// additive m212/m213 price metadata the generator predates), it does not belong
// here - inventing one would be the first step towards a desktop-only column.
//
// The four editable entities are TENANT-scoped, not branch-scoped: categories,
// items, modifier groups and options all carry `tenant_id` and are shared by
// every branch. `qr_menu_settings` is the single branch-scoped row and is keyed
// `(tenant_id, branch_id)` - it is written against the tenant's MAIN branch,
// exactly as the web workspace does.

import type { Tables } from "@/lib/database.types";
import type { PriceMetadata } from "@/types/pos";

/** `menu_categories` row. `status` is the `category_status` enum. */
export type BuilderCategory = Tables<"menu_categories">;

/**
 * `menu_items` row plus the price metadata.
 *
 * The generated types were produced before m212/m213 added the four
 * currency-metadata columns, so they are re-declared through `PriceMetadata` -
 * the same accommodation `src/lib/pos/menu.ts` already makes for the POS loader.
 */
export type BuilderItem = Tables<"menu_items"> & PriceMetadata;

/** `modifier_groups` row. `status` reuses the `category_status` enum. */
export type BuilderGroup = Tables<"modifier_groups">;

/** `modifier_options` row plus its price metadata (same m213 accommodation). */
export type BuilderOption = Tables<"modifier_options"> & PriceMetadata;

/** `qr_menu_settings` row - the one branch-scoped entity in this module. */
export type QrSettings = Tables<"qr_menu_settings">;

/** `public_menu_themes` row - a global catalogue, not tenant data. */
export type MenuTheme = Tables<"public_menu_themes">;

/** The shape stored in `public_menu_themes.config_json`. */
export type MenuThemeConfig = {
  key: string;
  sort: number;
  primary: string;
  bg: string;
  card: string;
  text: string;
  muted: string;
  layout: string;
  dark: boolean;
  font: string;
};

/** `menu_items.status` - the `item_status` enum, in the order the web offers it. */
export const ITEM_STATUSES = ["draft", "published", "hidden", "out_of_stock"] as const;
export type ItemStatus = BuilderItem["status"];

/** `menu_categories.status` / `modifier_groups.status` - the `category_status` enum. */
export type CategoryStatus = BuilderCategory["status"];

/** Everything one Menu Builder session reads, in one payload. */
export type MenuBuilderData = {
  categories: BuilderCategory[];
  items: BuilderItem[];
  groups: BuilderGroup[];
  options: BuilderOption[];
  /** menu_item_id -> attached modifier_group_id[] */
  groupsByItem: Record<string, string[]>;
  qr: QrSettings | null;
  themes: MenuTheme[];
};

export const EMPTY_MENU_BUILDER_DATA: MenuBuilderData = {
  categories: [],
  items: [],
  groups: [],
  options: [],
  groupsByItem: {},
  qr: null,
  themes: [],
};

/**
 * The in-flight edit of one item.
 *
 * `_groups` is the modifier-group assignment being edited; it is NOT a column
 * and is written to `menu_item_modifier_groups` separately. `price` is the
 * amount the operator is TYPING - it never reaches `menu_items.price` directly,
 * because that column is written only by `set_menu_item_price`.
 */
export type ItemDraft = Partial<BuilderItem> & { _groups?: string[] };

/** The in-flight edit of one category. */
export type CategoryDraft = Partial<BuilderCategory>;

/** The in-flight edit of one modifier group. */
export type GroupDraft = Partial<BuilderGroup>;

/** Human labels for a status, so the enum value never reaches the operator raw. */
export const ITEM_STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  published: "Published",
  hidden: "Hidden",
  out_of_stock: "Out of stock",
  scheduled: "Scheduled",
  archived: "Archived",
};

export const CATEGORY_STATUS_LABELS: Record<string, string> = {
  active: "Active",
  hidden: "Hidden",
  archived: "Archived",
};
