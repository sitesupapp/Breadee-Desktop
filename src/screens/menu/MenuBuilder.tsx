// THE DESKTOP MENU BUILDER.
//
// WHAT THIS SCREEN IS. A second CLIENT of the menu the Breadee web app already
// owns. It reads and writes `menu_categories`, `menu_items`, `modifier_groups`,
// `modifier_options`, `menu_item_modifier_groups` and `qr_menu_settings` through
// the authenticated user's session, under the m138 RLS policies, with prices
// written by the m213 RPCs. There is no desktop menu table, no export, no
// import, no sync engine and no merge: a change made here IS the change the web
// app reads, because it is the same row.
//
// WHAT IT DELIBERATELY IS NOT. It is not a port of the web component. The data
// model and every business rule come from the web app; the layout, density,
// keyboard behaviour and touch targets come from this application, which is what
// makes it feel like the POS beside it rather than a browser page in a window.
//
// HOW IT REACHES THE POS. It does not push anything. `PosWorkspace` loads the
// menu on mount and the POS lives on its own route OUTSIDE this Shell, so
// leaving Menu Builder for POS unmounts and remounts the workspace and refetches
// through the existing `loadMenu`. No cache is invalidated by hand, no second
// snapshot is written, and nothing here imports the POS's offline database.
//
// STATE OWNERSHIP. All backend work goes through `useMenuBuilder.mutate`, which
// blocks a duplicate submit, awaits the server, re-reads authoritative state and
// reports the failure honestly. This component owns only what is on screen: the
// active tab, the open drawer, the filters and the preview language.

import { useEffect, useMemo, useState } from "react";
import { Navigate } from "react-router-dom";
import { KeyboardProvider } from "@/lib/keyboard/provider";
import { ToastProvider, useToast } from "@/components/toast";
import { Badge, Button, Card, ErrorState, Skeleton, cn } from "@/components/ui";
import { Glyph } from "@/components/Glyph";
import { useSession } from "@/state/session";
import { useMenuBuilder } from "@/state/menuBuilder";
import { canViewMenuBuilder, hasModifiersFeature, hasQrFeature, isReadOnly, menuBuilderDenialReason, menuBuilderGates } from "@/lib/menu/access";
import * as ou from "@/lib/menu/ouRepository";
import { emitMenuChanged } from "@/lib/menu/events";
import {
  ALL_CATEGORIES,
  ANY_STATUS,
  DEFAULT_ITEM_FILTER,
  NO_CATEGORY,
  filterMenuItems,
  itemCountsByCategory,
  menuHealth,
  sortedCategories,
  type ItemFilter,
} from "@/lib/menu/filters";
import { resolveMenuPrice } from "@/lib/pos/menuPrice";
import { readIconAssignments } from "@/lib/icons/assignments";
import { ItemsTab } from "@/components/menu/ItemsTab";
import { ItemDrawer, type ItemDrawerSubmit } from "@/components/menu/ItemDrawer";
import { CategoriesTab } from "@/components/menu/CategoriesTab";
import { ModifiersTab } from "@/components/menu/ModifiersTab";
import { AvailabilityTab } from "@/components/menu/AvailabilityTab";
import { QrMenuTab } from "@/components/menu/QrMenuTab";
import { MenuPreview } from "@/components/menu/MenuPreview";
import type { CurrencyCode } from "@/lib/currency";
import { ITEM_STATUS_LABELS } from "@/lib/menu/types";
import type { BuilderCategory, BuilderGroup, BuilderItem, BuilderOption, CategoryDraft, GroupDraft, ItemDraft, ItemStatus, QrSettings } from "@/lib/menu/types";

const TABS = ["Items", "Categories", "Modifiers", "Availability", "QR Menu"] as const;
type Tab = (typeof TABS)[number];

export function MenuBuilder() {
  return (
    <KeyboardProvider>
      <ToastProvider>
        <MenuBuilderInner />
      </ToastProvider>
    </KeyboardProvider>
  );
}

function MenuBuilderInner() {
  const session = useSession();
  const toast = useToast();
  const store = useMenuBuilder();

  const tenantId = session.tenant?.id ?? null;
  const currency: CurrencyCode = session.currency.primary;
  const rate = session.currency.rate;

  // The SELECTED Operating Unit. Null = nothing chosen yet: the workspace is blank
  // and every operational write is refused. There is no implicit Main.
  const branchId = store.branchId;
  const selectedBranch = store.branches.find((b) => b.id === branchId) ?? null;
  function selectOU(id: string | null) {
    store.setBranchId(id);
    if (tenantId) void store.load(tenantId);
  }

  const accessCtx = useMemo(
    () => ({ status: session.membership?.status, permissions: session.permissions, features: session.features }),
    [session.membership?.status, session.permissions, session.features],
  );
  const gates = useMemo(() => menuBuilderGates(accessCtx), [accessCtx]);
  const readOnly = isReadOnly(gates);
  const showModifiers = hasModifiersFeature(accessCtx);
  const showQr = hasQrFeature(accessCtx);

  const [tab, setTab] = useState<Tab>("Items");
  const [filter, setFilter] = useState<ItemFilter>(DEFAULT_ITEM_FILTER);
  const [language, setLanguage] = useState<"en" | "ar">("en");
  const [draft, setDraft] = useState<ItemDraft | null>(null);
  const [priceCurrency, setPriceCurrency] = useState<CurrencyCode>(currency);
  // Icon assignments are TERMINAL-LOCAL and keyed by `menu_items.id`. Read once
  // for display; nothing on this screen writes them - renaming or re-pricing an
  // item cannot disturb its icon, because the key is the id and the id is stable.
  const icons = useMemo(() => readIconAssignments(), []);

  useEffect(() => {
    if (tenantId) {
      void store.loadBranches(tenantId);
      void store.load(tenantId); // blank until an Operating Unit is chosen
    }
    return () => useMenuBuilder.getState().reset();
    // The store is a stable zustand reference; depending on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  // --- gating ---------------------------------------------------------------
  if (!canViewMenuBuilder(accessCtx)) {
    // Same outcome as the web app's server-side redirect, for the same reasons.
    // The Shell already hides the nav item; this covers a typed URL.
    return <Navigate to="/dashboard" replace state={{ denied: menuBuilderDenialReason(accessCtx) }} />;
  }

  const data = store.data;
  const categories = sortedCategories(data.categories);
  const counts = itemCountsByCategory(data.items);
  const health = menuHealth(data.items);
  const visibleItems = filterMenuItems(data.items, data.categories, filter);
  const pendingItemId = pendingSuffix(store.pending, "item:");
  const pendingCategoryId = pendingSuffix(store.pending, "category:");
  const pendingGroupId = pendingSuffix(store.pending, "modifier:");

  /** Run one mutation, announce the outcome, and report whether it succeeded. */
  async function run(key: string, action: string, work: () => Promise<void>, success?: string): Promise<boolean> {
    if (!tenantId) return false;
    if (!branchId) {
      // No implicit Main: an operational write is refused until a unit is chosen.
      toast.push({ tone: "error", message: "Select an Operating Unit to edit this menu." });
      return false;
    }
    const outcome = await store.mutate(key, tenantId, action, work);
    if (outcome.ok) {
      // Nudge an open POS (same terminal) to re-read this OU's menu after a change.
      emitMenuChanged();
      if (success) toast.push({ tone: "success", message: success });
      return true;
    }
    toast.push({ tone: "error", message: outcome.failure.message, detail: outcome.failure.detail });
    return false;
  }

  // --- items ----------------------------------------------------------------
  function startCreate() {
    setPriceCurrency(currency);
    setDraft({ status: "draft", is_available: true, _groups: [] });
  }

  function startEdit(item: BuilderItem) {
    setPriceCurrency(currency);
    // Open showing the RESOLVED amount in the tenant's primary currency, which
    // is what the operator sees everywhere else. Re-saving it unchanged rewrites
    // the same money; it does not re-convert an already-normalised value.
    setDraft({ ...item, price: resolveMenuPrice(item, item.price, currency, rate).amount, _groups: data.groupsByItem[item.id] ?? [] });
  }

  // THE DRAWER CLOSES ON SUCCESS, NEVER BEFORE IT. Closing first would show the
  // final state before the backend confirmed it, and - worse - would destroy the
  // operator's whole edit (including a chosen photo) if the save were refused,
  // leaving them with a toast and nothing to retry. Keeping it open is also what
  // makes the "Saving..." state and the disabled Save button visible at all.
  async function submitItem(submit: ItemDrawerSubmit) {
    if (!tenantId || !branchId) return;
    const id = submit.draft.id;
    const ok = await run(
      `item:${id ?? "new"}`,
      id ? "Saving the item" : "Adding the item",
      () =>
        ou
          .saveItemOU({
            tenantId,
            branchId,
            draft: submit.draft,
            price: submit.price,
            groupIds: submit.groupIds,
            file: submit.file,
            clearImage: submit.clearImage,
            // On edit keep the item's current position; on create append.
            nextSortOrder: (id ? data.items.find((i) => i.id === id)?.sort_order : undefined) ?? data.items.length,
          })
          .then(() => undefined),
      id ? "Item saved" : "Item added",
    );
    if (ok) setDraft(null);
  }

  async function archiveDraftItem() {
    const id = draft?.id;
    if (!id || !branchId) return;
    const ok = await run(`item:${id}`, "Archiving the item", () => ou.archiveItemOU(branchId, id), "Item archived");
    if (ok) setDraft(null);
  }

  // --- categories -----------------------------------------------------------
  async function saveCategory(categoryDraft: CategoryDraft) {
    if (!tenantId || !branchId) return;
    // On edit, carry the current row's sort/status so the OU upsert never resets them.
    const cur = categoryDraft.id ? data.categories.find((c) => c.id === categoryDraft.id) : null;
    await run(
      `category:${categoryDraft.id ?? "new"}`,
      categoryDraft.id ? "Saving the category" : "Adding the category",
      () => ou.saveCategoryOU(branchId, {
        category_id: categoryDraft.id ?? null,
        name: (categoryDraft.name ?? "").trim(),
        name_ar: categoryDraft.name_ar?.trim() ? categoryDraft.name_ar.trim() : null,
        sort_order: cur?.sort_order ?? data.categories.length,
        status: cur?.status ?? "active",
      }),
      "Category saved",
    );
  }

  async function moveCategory(index: number, direction: -1 | 1) {
    const target = categories[index + direction];
    const current = categories[index];
    if (!current || !target || !branchId) return;
    await run(`category:${current.id}`, "Reordering categories", async () => {
      await ou.saveCategoryOU(branchId, { category_id: current.id, name: current.name, name_ar: current.name_ar, sort_order: target.sort_order, status: current.status });
      await ou.saveCategoryOU(branchId, { category_id: target.id, name: target.name, name_ar: target.name_ar, sort_order: current.sort_order, status: target.status });
    });
  }

  async function toggleCategory(category: BuilderCategory) {
    if (!branchId) return;
    const next = category.status === "active" ? "hidden" : "active";
    await run(`category:${category.id}`, "Changing the category", () => ou.saveCategoryOU(branchId, { category_id: category.id, name: category.name, name_ar: category.name_ar, sort_order: category.sort_order, status: next }));
  }

  async function archiveCategory(category: BuilderCategory) {
    if (!branchId) return;
    await run(`category:${category.id}`, "Archiving the category", () => ou.saveCategoryOU(branchId, { category_id: category.id, name: category.name, name_ar: category.name_ar, sort_order: category.sort_order, status: "archived" }), "Category archived");
  }

  // --- modifiers ------------------------------------------------------------
  async function saveGroup(groupDraft: GroupDraft) {
    if (!tenantId || !branchId) return;
    await run(
      `modifier:${groupDraft.id ?? "new"}`,
      groupDraft.id ? "Saving the group" : "Adding the group",
      () => ou.saveGroupOU(branchId, groupDraft),
      "Modifier group saved",
    );
  }

  async function archiveGroup(group: BuilderGroup) {
    if (!branchId) return;
    await run(`modifier:${group.id}`, "Archiving the group", () => ou.archiveGroupOU(branchId, group.id), "Modifier group archived");
  }

  async function addOption(group: BuilderGroup, name: string, extra: number, entered: CurrencyCode) {
    if (!tenantId || !branchId) return;
    await run(`modifier:${group.id}`, "Adding the option", () => ou.addOptionOU(branchId, group.id, name, extra, entered));
  }

  async function archiveOption(option: BuilderOption) {
    if (!branchId) return;
    await run(`modifier:${option.modifier_group_id}`, "Archiving the option", () => ou.archiveOptionOU(branchId, option.id));
  }

  // --- availability ---------------------------------------------------------
  async function changeStatus(item: BuilderItem, status: ItemStatus) {
    if (!branchId) return;
    await run(`item:${item.id}`, "Changing the status", () => ou.setItemStatusOU(branchId, item, status));
  }

  async function changeAvailability(item: BuilderItem, next: boolean) {
    if (!branchId) return;
    await run(`item:${item.id}`, "Changing availability", () => ou.setItemAvailabilityOU(branchId, item, next));
  }

  async function publishDrafts() {
    if (!tenantId || !branchId) return;
    await run("publish:all", "Publishing drafts", () => ou.publishAllDraftsOU(branchId).then(() => undefined), "Drafts published");
  }

  // --- QR (per Operating Unit) ----------------------------------------------
  async function createQr() {
    if (!tenantId || !branchId) return;
    await run("qr:create", "Setting up the public menu", () => ou.ensureQrSettingsOU(tenantId, branchId).then(() => undefined), "Public menu ready");
  }

  async function patchQr(patch: Partial<QrSettings>) {
    const id = data.qr?.id;
    if (!id) return;
    await run("qr:save", "Saving the public menu", () => ou.saveQrSettingsOU(id, patch));
  }

  function copyLink(url: string) {
    navigator.clipboard
      ?.writeText(url)
      .then(() => toast.push({ tone: "success", message: "Public menu link copied" }))
      .catch(() => toast.push({ tone: "warning", message: "Could not copy the link.", detail: url }));
  }

  // --- render ---------------------------------------------------------------
  const tabs = TABS.filter((t) => (t === "Modifiers" ? showModifiers : t === "QR Menu" ? showQr : true));
  const activeTab = tabs.includes(tab) ? tab : "Items";

  return (
    <div className="flex h-full min-h-[560px] min-w-0 flex-col gap-3">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-extrabold text-ink">Menu Builder</h1>
          <p className="text-sm text-sub">Manage the menu used by POS and your Breadee web menu.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-xs font-semibold text-sub" title="Each Operating Unit has its own operational menu">
            <span>Operating Unit</span>
            <select
              className="rounded-lg border border-line bg-white px-2.5 py-1.5 text-xs font-semibold text-ink"
              value={branchId ?? ""}
              onChange={(e) => selectOU(e.target.value || null)}
              disabled={!store.branchesLoaded}
            >
              <option value="">Select an Operating Unit…</option>
              {store.branches.map((b) => (
                <option key={b.id} value={b.id}>{b.name}{b.is_main ? " (Main)" : ""}</option>
              ))}
            </select>
          </label>
          {selectedBranch && <Badge tone="green" title="Edits land in this Operating Unit only">{selectedBranch.name}</Badge>}
          {readOnly && <Badge tone="amber">Read only</Badge>}
          {store.refreshing ? (
            <Badge tone="slate">Refreshing…</Badge>
          ) : store.loadedAt ? (
            <Badge tone={session.online && !session.offlineMode ? "green" : "amber"}>
              {session.offlineMode ? "Offline" : session.online ? "Live" : "No internet"}
            </Badge>
          ) : null}
          <Button variant="ghost" disabled={!tenantId || store.refreshing} onClick={() => tenantId && store.refresh(tenantId)}>
            <Glyph name="sync" size={16} />
            Refresh
          </Button>
        </div>
      </header>

      {store.status === "loading" && (
        <Card className="space-y-2 p-4">
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </Card>
      )}

      {store.status === "error" && (
        <Card className="p-2">
          <ErrorState
            title="The menu could not be loaded"
            message={store.loadError?.message ?? "Loading the menu failed."}
            hint={store.loadError?.detail}
            onRetry={() => tenantId && store.load(tenantId)}
          />
        </Card>
      )}

      {store.status === "ready" && !branchId && (
        <Card className="p-8 text-center">
          <p className="font-bold text-ink">Select an Operating Unit</p>
          <p className="mt-1 text-sm text-sub">
            The Menu Builder edits one Operating Unit&apos;s menu at a time. Choose a unit above to view and edit its
            items, categories and modifiers. A brand-new unit starts empty — nothing is inherited from another unit.
          </p>
        </Card>
      )}

      {store.status === "ready" && branchId && (
        <>
          <div className="flex flex-wrap items-center gap-3 text-xs text-sub">
            <span>
              <strong className="text-ink">{health.total}</strong> items
            </span>
            <span>
              <strong className="text-ink">{health.published}</strong> published
            </span>
            <span>
              <strong className="text-ink">{health.drafts}</strong> drafts
            </span>
            <span>
              <strong className="text-ink">{categories.length}</strong> categories
            </span>
            {health.noPrice > 0 && <span className="text-amber-800">{health.noPrice} without a price</span>}
            {health.noCategory > 0 && <span className="text-amber-800">{health.noCategory} without a category</span>}
          </div>

          <div className="flex min-h-0 flex-1 overflow-hidden rounded-2xl border border-line bg-white shadow-sm">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <nav className="flex shrink-0 gap-1 border-b border-line px-3 pt-3" aria-label="Menu Builder sections">
                {tabs.map((t) => (
                  <button
                    key={t}
                    type="button"
                    aria-current={activeTab === t ? "page" : undefined}
                    onClick={() => setTab(t)}
                    className={cn(
                      "min-h-[40px] rounded-t-xl border border-b-0 px-4 text-sm font-bold transition",
                      activeTab === t ? "border-line bg-white text-brand-dark" : "border-transparent text-sub hover:text-ink",
                    )}
                  >
                    {t}
                  </button>
                ))}
              </nav>

              {activeTab === "Items" && (
                <ItemsTab
                  items={visibleItems}
                  categories={categories}
                  groupsByItem={data.groupsByItem}
                  icons={icons}
                  filter={filter}
                  currency={currency}
                  rate={rate}
                  createGate={gates.createItem}
                  editGate={gates.editItem}
                  onFilterChange={setFilter}
                  onCreate={startCreate}
                  onEdit={startEdit}
                />
              )}

              {activeTab === "Categories" && (
                <CategoriesTab
                  categories={categories}
                  counts={counts}
                  gate={gates.manageCategories}
                  busyId={pendingCategoryId}
                  onSave={saveCategory}
                  onMove={moveCategory}
                  onToggle={toggleCategory}
                  onArchive={archiveCategory}
                />
              )}

              {activeTab === "Modifiers" && (
                <ModifiersTab
                  groups={data.groups}
                  options={data.options}
                  gate={gates.manageModifiers}
                  currency={currency}
                  rate={rate}
                  busyId={pendingGroupId}
                  onSaveGroup={saveGroup}
                  onArchiveGroup={archiveGroup}
                  onAddOption={addOption}
                  onArchiveOption={archiveOption}
                />
              )}

              {activeTab === "Availability" && (
                <AvailabilityTab
                  items={visibleItems}
                  filter={filter}
                  hiddenBy={narrowingFilters(filter, categories)}
                  onClearFilters={() => setFilter({ ...DEFAULT_ITEM_FILTER, query: filter.query })}
                  editGate={gates.editItem}
                  publishGate={gates.editItem}
                  draftCount={health.drafts}
                  busyId={pendingItemId}
                  publishing={store.isPending("publish:all")}
                  onFilterChange={setFilter}
                  onStatusChange={changeStatus}
                  onAvailabilityChange={changeAvailability}
                  onPublishAllDrafts={publishDrafts}
                />
              )}

              {activeTab === "QR Menu" && (
                <QrMenuTab
                  qr={data.qr}
                  themes={data.themes}
                  gate={gates.manageQr}
                  busy={store.isPending("qr:save")}
                  creating={store.isPending("qr:create")}
                  onCreate={createQr}
                  onPatch={patchQr}
                  onCopyLink={copyLink}
                />
              )}
            </div>

            <MenuPreview
              categories={data.categories}
              items={data.items}
              qr={data.qr}
              currency={currency}
              rate={rate}
              language={language}
              onLanguageChange={setLanguage}
            />
          </div>
        </>
      )}

      {draft && (
        <ItemDrawer
          draft={draft}
          categories={categories}
          groups={data.groups}
          showModifiers={showModifiers}
          primaryCurrency={currency}
          priceCurrency={priceCurrency}
          rate={rate}
          saveGate={draft.id ? gates.editItem : gates.createItem}
          archiveGate={gates.archiveItem}
          saving={store.isPending(`item:${draft.id ?? "new"}`)}
          onPriceCurrencyChange={setPriceCurrency}
          onChange={setDraft}
          onClose={() => setDraft(null)}
          onSubmit={submitItem}
          onArchive={draft.id ? archiveDraftItem : null}
        />
      )}
    </div>
  );
}

/** The id inside the first in-flight key with this prefix, or null. */
function pendingSuffix(pending: string[], prefix: string): string | null {
  const key = pending.find((k) => k.startsWith(prefix));
  return key ? key.slice(prefix.length) : null;
}

/**
 * Filters that are narrowing a list WITHOUT their own control on screen.
 *
 * The search box and the availability toggle are visible on every tab that
 * uses them, so they are not reported; the category and status pickers live
 * only on Items, and silently hiding rows on Availability is how a stock
 * update misses half the menu.
 */
function narrowingFilters(filter: ItemFilter, categories: BuilderCategory[]): string[] {
  const active: string[] = [];
  if (filter.categoryId === NO_CATEGORY) {
    active.push("category “No category”");
  } else if (filter.categoryId !== ALL_CATEGORIES) {
    active.push(`category “${categories.find((c) => c.id === filter.categoryId)?.name ?? "unknown"}”`);
  }
  if (filter.status !== ANY_STATUS) active.push(`status “${ITEM_STATUS_LABELS[filter.status] ?? filter.status}”`);
  return active;
}
