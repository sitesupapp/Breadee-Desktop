// Settings -> Printing & Routing -> Item routing.
//
// WHERE THIS SITS AMONG THE OTHER THREE. Quick Setup says what printers exist,
// Routing says where each KIND of document goes, and this screen says where
// individual CATEGORIES and ITEMS are prepared. The three do not overlap: this
// one never touches a `receipt` route and never touches an `order_source` route,
// so nothing configured on the Routing tab can be changed from here.
//
// WHY IT IS HERE AND NOT IN A MENU EDITOR. The desktop's Menu Builder edits the
// canonical menu, which is shared with the web application; adding a
// desktop-only printing section to it would put a desktop concern inside a
// shared editor. Printing lives under Printing & Routing, which is where a
// support technician already goes, and where the printer list this screen offers
// already comes from.
//
// INHERIT IS THE DEFAULT AND IT IS EXPRESSED AS ABSENCE. An item with no rules
// follows its category; a category with no rules follows the branch's kitchen
// ticket route. That is the same idiom the Routing tab uses for "Use default",
// and for the same reason: a row that names the same printer as the thing it
// inherits from looks identical today and silently stops following it the first
// time somebody changes that thing.
//
// NO DATABASE WORDS ON SCREEN. `scope_type`, `print_purpose`, `menu_item_id`,
// priorities and uuids appear nowhere. A category name, an item name, the three
// order types and a printer's Breadee name are what an operator reads.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, EmptyState, Input, Skeleton, cn } from "@/components/ui";
import { usePosContext } from "@/state/pos";
import { MAX_COPIES, MIN_COPIES, listPrinters } from "@/lib/nativePrinting";
import { loadServerPrinters } from "@/lib/pos/printerRegistry";
import { classifyPrinters, type ConfiguredPrinter } from "@/lib/pos/quickSetup";
import { canManageRoutes, routeWriteMessage } from "@/lib/pos/printRouting";
import { loadMenu } from "@/lib/pos/menu";
import { classifyError } from "@/lib/pos/errors";
import {
  ROUTING_SOURCES,
  draftFromRules,
  draftIsDirty,
  planIsEmpty,
  planRoutingSave,
  routingSourceLabel,
  type ItemRoute,
  type RoutingDraft,
  type RoutingSource,
} from "@/lib/pos/itemRouting";
import {
  CATEGORY_SCOPE,
  MENU_ITEM_SCOPE,
  createItemRoute,
  loadItemRoutes,
  removeItemRoute,
  updateItemRouteCopies,
  type RouteTarget,
} from "@/lib/pos/itemRouteRepository";
import type { MenuCategory, MenuItem } from "@/types/pos";

type Selection =
  | { kind: "category"; id: string; name: string }
  | { kind: "item"; id: string; name: string; categoryName: string | null };

export function ItemRouting() {
  const pos = usePosContext();
  const tenantId = pos.tenantId;
  const branchId = pos.branch.id;

  // The SAME gate the Routing tab applies to kitchen tickets, because these are
  // kitchen ticket rows and the server authorises them with the same policy.
  const gate = canManageRoutes({
    purpose: "kitchen_ticket",
    permissions: pos.access.permissions,
    features: pos.access.features,
  });

  const [printers, setPrinters] = useState<ConfiguredPrinter[]>([]);
  const [categories, setCategories] = useState<MenuCategory[]>([]);
  const [items, setItems] = useState<MenuItem[]>([]);
  const [routes, setRoutes] = useState<ItemRoute[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [drafts, setDrafts] = useState<Record<string, RoutingDraft>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const native = await listPrinters();
    const installed = native.ok ? native.value : [];
    try {
      const [configured, loadedRoutes, menu] = await Promise.all([
        loadServerPrinters({ tenantId, branchId, includeInactive: true }),
        loadItemRoutes({ tenantId, branchId }),
        tenantId ? loadMenu(tenantId) : Promise.resolve({ categories: [], items: [] } as { categories: MenuCategory[]; items: MenuItem[] }),
      ]);
      setPrinters(classifyPrinters(configured, installed));
      setRoutes(loadedRoutes);
      setCategories(menu.categories);
      setItems(menu.items);
      // Drafts are rebuilt from the server on every load, so a failed save can
      // never leave the screen showing a selection the branch does not have.
      setDrafts({});
      setRowErrors({});
    } catch (e) {
      setLoadError(classifyError(e).message);
    }
    setLoading(false);
  }, [tenantId, branchId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const categoryName = useMemo(() => new Map(categories.map((c) => [c.id, c.name])), [categories]);

  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return [] as Selection[];
    const out: Selection[] = [];
    for (const category of categories) {
      if (category.name.toLowerCase().includes(q)) out.push({ kind: "category", id: category.id, name: category.name });
    }
    for (const item of items) {
      if (item.name.toLowerCase().includes(q)) {
        out.push({
          kind: "item",
          id: item.id,
          name: item.name,
          categoryName: item.category_id ? categoryName.get(item.category_id) ?? null : null,
        });
      }
    }
    return out.slice(0, 40);
  }, [query, categories, items, categoryName]);

  /** Rules for the selected target and one order source. */
  const rulesFor = useCallback(
    (source: RoutingSource): ItemRoute[] => {
      if (!selection) return [];
      return routes.filter((r) => {
        if (r.orderSource !== source) return false;
        if (selection.kind === "category") return r.scope === "category" && r.categoryId === selection.id;
        return r.scope === "menu_item" && r.menuItemId === selection.id;
      });
    },
    [routes, selection],
  );

  const cellKey = (source: RoutingSource) => `${selection?.kind ?? "-"}:${selection?.id ?? "-"}:${source}`;

  const draftFor = useCallback(
    (source: RoutingSource): RoutingDraft => drafts[cellKey(source)] ?? draftFromRules(rulesFor(source)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [drafts, rulesFor, selection],
  );

  const toggle = (source: RoutingSource, printerId: string) => {
    const key = cellKey(source);
    const current = draftFor(source);
    const next = current.printerIds.includes(printerId)
      ? current.printerIds.filter((id) => id !== printerId)
      : [...current.printerIds, printerId];
    setDrafts((d) => ({ ...d, [key]: { ...current, printerIds: next.sort() } }));
    setRowErrors((e) => ({ ...e, [key]: "" }));
  };

  const setCopies = (source: RoutingSource, copies: number) => {
    const key = cellKey(source);
    setDrafts((d) => ({ ...d, [key]: { ...draftFor(source), copies } }));
  };

  const save = async (source: RoutingSource) => {
    if (!selection || !tenantId || !branchId) return;
    const key = cellKey(source);
    const plan = planRoutingSave({ draft: draftFor(source), existing: rulesFor(source) });
    if (planIsEmpty(plan)) return;
    setSavingKey(key);
    setRowErrors((e) => ({ ...e, [key]: "" }));
    const target: RouteTarget =
      selection.kind === "category"
        ? { scope: CATEGORY_SCOPE, categoryId: selection.id }
        : { scope: MENU_ITEM_SCOPE, menuItemId: selection.id };
    try {
      // Removals first: a cell that swapped one printer for another must never
      // hold both, not even briefly, or a batch submitted in that window prints
      // in two rooms.
      for (const id of plan.remove) await removeItemRoute({ id });
      for (const change of plan.update) await updateItemRouteCopies(change);
      for (const addition of plan.add) {
        await createItemRoute({
          tenantId,
          branchId,
          target,
          orderSource: source,
          printerId: addition.printerId,
          copies: addition.copies,
        });
      }
      await refresh();
    } catch (e) {
      setRowErrors((err) => ({ ...err, [key]: routeWriteMessage(e) }));
    }
    setSavingKey(null);
  };

  if (loading) return <Skeleton className="h-96" />;

  const configuredTargets = summariseConfigured(routes, categoryName, new Map(items.map((i) => [i.id, i.name])));

  return (
    <div className="space-y-5">
      <Card className="p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold">Item routing</h2>
            <p className="mt-1 text-sm text-sub">
              Send individual categories or menu items to the station that prepares them. One order still stays one
              order — only the preparation tickets are split.
            </p>
          </div>
          <Button variant="ghost" onClick={() => void refresh()}>
            Refresh
          </Button>
        </div>
        {loadError && (
          <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">{loadError}</p>
        )}
        {!gate.allowed && (
          <p className="mt-3 rounded-lg bg-slate-100 px-3 py-2 text-xs font-semibold text-sub">{gate.reason}</p>
        )}
        <p className="mt-3 text-[11px] text-sub">
          Anything without a rule keeps printing exactly where it does today. An item's own rule overrides its
          category's; a category's overrides the branch's kitchen ticket route on the Routing tab.
        </p>
      </Card>

      {configuredTargets.length > 0 && (
        <Card className="p-6">
          <p className="text-sm font-extrabold text-ink">Already routed</p>
          <ul className="mt-2 space-y-1">
            {configuredTargets.map((t) => (
              <li key={t.key} className="flex items-center justify-between gap-3 border-b border-line/60 py-1.5 text-sm last:border-0">
                <span className="min-w-0 truncate">
                  <span className="font-semibold text-ink">{t.name}</span>
                  <span className="ml-2 text-xs text-sub">{t.kind === "category" ? "Category" : "Item"}</span>
                </span>
                <button
                  type="button"
                  className="shrink-0 text-xs font-bold text-brand-dark hover:underline"
                  onClick={() =>
                    setSelection(
                      t.kind === "category"
                        ? { kind: "category", id: t.id, name: t.name }
                        : { kind: "item", id: t.id, name: t.name, categoryName: null },
                    )
                  }
                >
                  {t.rules} rule{t.rules === 1 ? "" : "s"} · edit
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="p-6">
        <p className="text-sm font-extrabold text-ink">Choose what to route</p>
        <div className="mt-2">
          <Input
            value={query}
            placeholder="Search categories and menu items"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        {query.trim() !== "" && (
          <div className="mt-2 max-h-64 space-y-1 overflow-y-auto overscroll-contain pr-1">
            {searchResults.length === 0 ? (
              <p className="px-1 py-4 text-center text-xs text-sub">Nothing matches.</p>
            ) : (
              searchResults.map((result) => (
                <button
                  key={`${result.kind}-${result.id}`}
                  type="button"
                  onClick={() => setSelection(result)}
                  className={cn(
                    "flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-2 text-left text-sm",
                    selection?.kind === result.kind && selection.id === result.id
                      ? "border-brand bg-brand-soft"
                      : "border-line bg-white hover:border-brand/50",
                  )}
                >
                  <span className="min-w-0 truncate font-semibold text-ink">{result.name}</span>
                  <Badge tone={result.kind === "category" ? "blue" : "slate"}>
                    {result.kind === "category" ? "Category" : "Item"}
                  </Badge>
                </button>
              ))
            )}
          </div>
        )}

        {!selection && query.trim() === "" && (
          <div className="mt-3">
            <EmptyState
              title="Nothing selected"
              hint="Search for a category to route everything in it, or a single item to override its category."
            />
          </div>
        )}
      </Card>

      {selection && (
        <Card className="p-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-extrabold text-ink">{selection.name}</p>
              <p className="mt-0.5 text-xs text-sub">
                {selection.kind === "category"
                  ? "Everything in this category, unless an item below it has its own rule."
                  : `This item only${selection.categoryName ? ` — overrides ${selection.categoryName}` : ""}.`}
              </p>
            </div>
            <Button variant="ghost" onClick={() => setSelection(null)}>
              Clear
            </Button>
          </div>

          {printers.length === 0 ? (
            <div className="mt-3">
              <EmptyState
                title="No printers configured"
                hint="Add one under Quick Setup. Every printer you configure appears here automatically."
              />
            </div>
          ) : (
            <div className="mt-3 space-y-2">
              {ROUTING_SOURCES.map((source) => {
                const key = cellKey(source);
                const rules = rulesFor(source);
                const draft = draftFor(source);
                const dirty = draftIsDirty(draft, rules);
                const busy = savingKey === key;
                const error = rowErrors[key];
                return (
                  <div key={source} className="rounded-xl border border-line p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm font-bold text-ink">{routingSourceLabel(source)}</span>
                      <div className="flex items-center gap-2">
                        <label className="flex items-center gap-1.5 text-xs text-sub">
                          Copies
                          <select
                            className="rounded-xl border border-line px-2 py-1.5 text-sm disabled:bg-slate-50"
                            value={draft.copies}
                            disabled={!gate.allowed || draft.printerIds.length === 0 || busy}
                            onChange={(e) => setCopies(source, Number(e.target.value))}
                          >
                            {Array.from({ length: MAX_COPIES - MIN_COPIES + 1 }, (_, i) => i + MIN_COPIES).map((n) => (
                              <option key={n} value={n}>
                                {n}
                              </option>
                            ))}
                          </select>
                        </label>
                        {gate.allowed && dirty && (
                          <Button className="px-3 py-1.5 text-xs" disabled={busy} onClick={() => void save(source)}>
                            {busy ? "Saving..." : "Save"}
                          </Button>
                        )}
                      </div>
                    </div>

                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {/* ACTIVE printers only, plus any this cell already names.
                          The registry is read with `includeInactive` so a
                          disabled printer can still be SEEN and cleared here -
                          but offering one as a new destination would configure a
                          rule that silently never prints: `resolve_print_route`
                          and `resolveRouteTarget` both require an active
                          printer. This matches `printerOptions()` on the Routing
                          tab, which has always filtered the same way; the two
                          screens disagreeing was the defect. */}
                      {printers
                        .filter((entry) => entry.printer.is_active || draft.printerIds.includes(entry.printer.id))
                        .map((entry) => {
                          const checked = draft.printerIds.includes(entry.printer.id);
                          const disabledPrinter = !entry.printer.is_active;
                          return (
                            <button
                              key={entry.printer.id}
                              type="button"
                              disabled={!gate.allowed || busy}
                              onClick={() => toggle(source, entry.printer.id)}
                              title={
                                disabledPrinter
                                  ? `${entry.printer.name} is switched off, so this rule cannot print. Clear it, or re-enable the printer in Quick Setup.`
                                  : entry.printer.system_printer_name
                                    ? `Windows: ${entry.printer.system_printer_name}`
                                    : "No Windows printer chosen yet"
                              }
                              className={cn(
                                "min-h-[36px] rounded-lg border px-3 text-xs font-semibold transition",
                                checked
                                  ? "border-brand bg-brand-soft text-brand-dark"
                                  : "border-line bg-white text-ink hover:border-brand/50",
                                disabledPrinter && "border-amber-400 bg-amber-50 text-amber-900",
                                (!gate.allowed || busy) && "cursor-not-allowed opacity-60",
                              )}
                            >
                              {checked ? "✓ " : ""}
                              {entry.printer.name}
                              {disabledPrinter && " · off"}
                            </button>
                          );
                        })}
                    </div>

                    <p className="mt-1.5 text-[11px] text-sub">
                      {draft.printerIds.length === 0
                        ? selection.kind === "category"
                          ? "No rule — follows the branch's kitchen ticket route."
                          : "No rule — follows this item's category, then the branch route."
                        : `Prints to ${draft.printerIds.length} printer${draft.printerIds.length === 1 ? "" : "s"}.`}
                    </p>

                    {error && (
                      <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">{error}</p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

/** Everything that currently has a rule, so nothing configured is invisible. */
function summariseConfigured(
  routes: ItemRoute[],
  categoryName: Map<string, string>,
  itemName: Map<string, string>,
): { key: string; kind: "category" | "item"; id: string; name: string; rules: number }[] {
  const counts = new Map<string, { kind: "category" | "item"; id: string; name: string; rules: number }>();
  for (const route of routes) {
    if (!route.isActive) continue;
    const isCategory = route.scope === "category";
    const id = (isCategory ? route.categoryId : route.menuItemId) ?? "";
    if (!id) continue;
    const key = `${route.scope}:${id}`;
    const existing = counts.get(key);
    if (existing) {
      existing.rules += 1;
      continue;
    }
    counts.set(key, {
      kind: isCategory ? "category" : "item",
      id,
      // A target the menu no longer contains is still shown, by id, rather than
      // hidden: a rule pointing at a deleted item is exactly the thing somebody
      // needs to find and remove.
      name: (isCategory ? categoryName.get(id) : itemName.get(id)) ?? `(no longer on the menu) ${id.slice(0, 8)}`,
      rules: 1,
    });
  }
  return [...counts.entries()]
    .map(([key, value]) => ({ key, ...value }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
