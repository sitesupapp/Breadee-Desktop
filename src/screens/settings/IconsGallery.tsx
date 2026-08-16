// Settings -> Icons Gallery.
//
// PRESENTATION, AND ONLY PRESENTATION. This screen reads the menu and writes an
// icon key into this terminal's storage. It has no RPC, no write to any
// Supabase table, and no reference to a price, a recipe, a modifier group, a
// category, a tax rule or a print route - so an icon cannot change what an item
// costs, what it is made of, what it asks the cashier, where it is filed, or
// where its ticket prints. `test/desktop-icons.test.ts` asserts that against
// this file's source.
//
// SEPARATE FROM THEMES, ON PURPOSE. A theme recolours the whole application; an
// icon is a per-item decision an operator makes once. They share only the fact
// that an icon inherits the theme's text colour, which needs no configuration
// at all - see `PosIconGlyph`.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, EmptyState, ErrorState, Input, Skeleton, cn } from "@/components/ui";
import { PosIconGlyph } from "@/components/PosIconGlyph";
import { usePosContext } from "@/state/pos";
import { loadMenu } from "@/lib/pos/menu";
import type { MenuData, MenuItem } from "@/types/pos";
import { ICON_BY_KEY, ICON_CATEGORIES, searchIcons, type IconCategory } from "@/lib/icons/catalog";
import {
  iconForItem,
  readIconAssignments,
  writeIconAssignment,
  type IconAssignments,
} from "@/lib/icons/assignments";

export function IconsGallery() {
  const pos = usePosContext();
  const tenantId = pos.tenantId;

  const [menu, setMenu] = useState<MenuData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [assignments, setAssignments] = useState<IconAssignments>(() => readIconAssignments());

  const [itemQuery, setItemQuery] = useState("");
  const [iconQuery, setIconQuery] = useState("");
  const [iconCategory, setIconCategory] = useState<IconCategory | null>(null);
  /** The item whose icon is being chosen, if any. */
  const [picking, setPicking] = useState<MenuItem | null>(null);

  const load = useCallback(async () => {
    if (!tenantId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setMenu(await loadMenu(tenantId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "The menu could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  const items = useMemo(() => {
    const q = itemQuery.trim().toLowerCase();
    const all = menu?.items ?? [];
    return q === "" ? all : all.filter((i) => i.name.toLowerCase().includes(q));
  }, [menu, itemQuery]);

  const icons = useMemo(() => searchIcons(iconQuery, iconCategory), [iconQuery, iconCategory]);

  const assign = useCallback((itemId: string, iconKey: string | null) => {
    setAssignments(writeIconAssignment(itemId, iconKey));
    setPicking(null);
  }, []);

  if (!tenantId) {
    return (
      <Card className="p-6">
        <EmptyState title="No business linked" hint="Sign in with an account that belongs to a business." />
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <Card className="p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold">Icons Gallery</h2>
            <p className="mt-1 text-sm text-sub">
              An optional icon on each menu button. Appearance only — it never changes a price, a recipe, modifiers,
              inventory, tax, the item&apos;s category or where its ticket prints.
            </p>
          </div>
          <Badge tone="slate">This terminal</Badge>
        </div>
        <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-[11px] text-sub">
          Icons are stored on this computer, like the theme. Another terminal will not show them until it is set up the
          same way.
        </p>
      </Card>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {/* --- the icon set ---------------------------------------------- */}
        <Card className="p-5">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-extrabold text-ink">
              {picking ? `Choose an icon for “${picking.name}”` : "Icons"}
            </p>
            {picking && (
              <Button size="sm" variant="ghost" onClick={() => setPicking(null)}>
                Cancel
              </Button>
            )}
          </div>

          <div className="mt-3 space-y-2">
            <Input
              size="sm"
              value={iconQuery}
              onChange={(e) => setIconQuery(e.target.value)}
              placeholder="Search icons — burger, cola, kebab…"
            />
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => setIconCategory(null)}
                className={cn(
                  "rounded-lg px-2.5 py-1 text-xs font-bold",
                  iconCategory === null ? "bg-brand text-onbrand" : "bg-slate-100 text-sub hover:text-ink",
                )}
              >
                All
              </button>
              {ICON_CATEGORIES.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setIconCategory(c)}
                  className={cn(
                    "rounded-lg px-2.5 py-1 text-xs font-bold",
                    iconCategory === c ? "bg-brand text-onbrand" : "bg-slate-100 text-sub hover:text-ink",
                  )}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>

          {icons.length === 0 ? (
            <div className="mt-4">
              <EmptyState title="No icons match" hint="Try a shorter search, or clear the category filter." />
            </div>
          ) : (
            <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
              {icons.map((icon) => (
                <button
                  key={icon.key}
                  type="button"
                  disabled={!picking}
                  title={picking ? `Assign ${icon.label}` : "Pick a menu item first"}
                  onClick={() => picking && assign(picking.id, icon.key)}
                  className={cn(
                    "flex min-h-[72px] flex-col items-center justify-center gap-1 rounded-xl border border-line bg-white p-2 text-ink transition",
                    picking
                      ? "hover:border-brand hover:bg-brand-soft hover:text-brand-dark"
                      : "cursor-default opacity-70",
                  )}
                >
                  <PosIconGlyph iconKey={icon.key} size={24} />
                  <span className="line-clamp-1 text-[10px] font-semibold">{icon.label}</span>
                </button>
              ))}
            </div>
          )}
        </Card>

        {/* --- the menu -------------------------------------------------- */}
        <Card className="p-5">
          <p className="text-sm font-extrabold text-ink">Menu items</p>
          <p className="mt-0.5 text-xs text-sub">
            The preview beside each name is exactly how the POS button will read.
          </p>
          <div className="mt-3">
            <Input
              size="sm"
              value={itemQuery}
              onChange={(e) => setItemQuery(e.target.value)}
              placeholder="Search menu items…"
            />
          </div>

          {loading ? (
            <div className="mt-3 space-y-2">
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
            </div>
          ) : error ? (
            <div className="mt-3">
              <ErrorState title="Menu unavailable" message={error} onRetry={() => void load()} />
            </div>
          ) : items.length === 0 ? (
            <div className="mt-3">
              <EmptyState title="No menu items" hint="Published, available items appear here." />
            </div>
          ) : (
            <div className="mt-3 max-h-[520px] space-y-1.5 overflow-y-auto pr-1">
              {items.map((item) => {
                const key = iconForItem(assignments, item.id);
                return (
                  <div
                    key={item.id}
                    className={cn(
                      "flex items-center gap-3 rounded-xl border px-3 py-2",
                      picking?.id === item.id ? "border-2 border-brand bg-brand-soft" : "border-line bg-white",
                    )}
                  >
                    {/* The button preview: [icon] Item name / Price. */}
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-50 text-ink">
                      {key ? <PosIconGlyph iconKey={key} size={20} /> : <span className="text-xs text-sub">—</span>}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-ink">{item.name}</span>
                      <span className="block text-[11px] text-sub">
                        {key ? ICON_BY_KEY[key]?.label : "No icon"}
                      </span>
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => setPicking(item)}>
                      {key ? "Change" : "Assign"}
                    </Button>
                    {key && (
                      <Button size="sm" variant="ghost" onClick={() => assign(item.id, null)}>
                        Remove
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
