// Settings -> Icons Gallery.
//
// PRESENTATION, AND ONLY PRESENTATION. This screen reads the menu and writes an
// icon key into this terminal's storage. It has no RPC, no write to any
// Supabase table, and no reference to a figure, a recipe, a modifier group, a
// tax rule or a print destination - so an icon cannot change what an item costs,
// what it is made of, what it asks the cashier, where it is filed, or where its
// ticket goes. `test/desktop-icons.test.ts` asserts that against this file's
// source.
//
// SEPARATE FROM THEMES, ON PURPOSE. A theme recolours the whole application; an
// icon is a per-item decision an operator makes once. They share only the fact
// that an icon inherits the theme's text colour, which needs no configuration at
// all - see `PosIconGlyph`.
//
// THE PREVIEW IS THE REAL BUTTON. It is `MenuCard`, the same component the POS
// menu grid renders, given the same icon, the same display settings and the
// active theme. A preview drawn by a second component would be a preview of a
// button that does not exist.
//
// APPLY, THEN COMMIT - TWO STEPS, BOTH MEANINGFUL. Choosing an icon stages it
// and updates the preview; nothing is written until Save changes. That is not
// ceremony: an operator scanning ninety glyphs will land on three or four before
// settling, and writing each one would have the POS grid flickering through
// their whole search the next time it opened. A staged change is also something
// the screen can offer to discard, which an immediate write is not.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, EmptyState, ErrorState, Input, Skeleton, cn } from "@/components/ui";
import { Glyph } from "@/components/Glyph";
import { PosIconGlyph } from "@/components/PosIconGlyph";
import { MenuCard } from "@/components/pos/MenuCard";
import { usePosContext } from "@/state/pos";
import { useSession } from "@/state/session";
import { loadMenu } from "@/lib/pos/menu";
import type { MenuData, MenuItem } from "@/types/pos";
import {
  ICON_BY_KEY,
  ICON_CATEGORIES,
  searchIcons,
  sectionsWithCounts,
  type IconCategory,
  type IconSection,
} from "@/lib/icons/catalog";
import {
  iconForItem,
  readIconAssignments,
  writeIconAssignment,
  type IconAssignments,
} from "@/lib/icons/assignments";
import {
  ICON_SIZES,
  ICON_STYLES,
  readIconDisplay,
  writeIconDisplay,
  type IconDisplay,
} from "@/lib/icons/display";

/** How many sections the left column shows before "Show more". */
const SECTIONS_COLLAPSED = 12;

export function IconsGallery() {
  const pos = usePosContext();
  const session = useSession();
  const tenantId = pos.tenantId;
  const currency = session.currency.primary;

  const [menu, setMenu] = useState<MenuData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [assignments, setAssignments] = useState<IconAssignments>(() => readIconAssignments());
  const [display, setDisplay] = useState<IconDisplay>(() => readIconDisplay());

  const [itemQuery, setItemQuery] = useState("");
  const [iconQuery, setIconQuery] = useState("");
  const [category, setCategory] = useState<IconCategory | null>(null);
  const [section, setSection] = useState<IconSection | null>(null);
  const [allSections, setAllSections] = useState(false);
  /** The item being decorated. */
  const [target, setTarget] = useState<MenuItem | null>(null);
  /**
   * The staged icon for `target`: a key to apply, or null to clear it.
   *
   * `undefined` means nothing is staged, which is a different state from "staged
   * as no icon" - only the second one should turn Save changes into a removal.
   */
  const [staged, setStaged] = useState<string | null | undefined>(undefined);

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
    const byCategory = all;
    return q === "" ? byCategory : byCategory.filter((i) => i.name.toLowerCase().includes(q));
  }, [menu, itemQuery]);

  const icons = useMemo(() => searchIcons(iconQuery, category, section), [iconQuery, category, section]);
  const sections = useMemo(() => sectionsWithCounts(), []);
  const visibleSections = allSections ? sections : sections.slice(0, SECTIONS_COLLAPSED);

  /** The icon the preview should draw: the staged one if there is one, else stored. */
  const currentKey = target ? (staged === undefined ? iconForItem(assignments, target.id) : staged) : null;
  const dirty = staged !== undefined && target !== null && staged !== iconForItem(assignments, target.id);

  const choose = useCallback((item: MenuItem) => {
    setTarget(item);
    setStaged(undefined);
  }, []);

  /** Write the staged decision. The ONLY write this screen makes. */
  const commit = useCallback(() => {
    if (!target || staged === undefined) return;
    setAssignments(writeIconAssignment(target.id, staged));
    setStaged(undefined);
  }, [target, staged]);

  const changeDisplay = useCallback((next: IconDisplay) => {
    setDisplay(writeIconDisplay(next));
  }, []);

  if (!tenantId) {
    return (
      <Card className="p-6">
        <EmptyState title="No business linked" hint="Sign in with an account that belongs to a business." />
      </Card>
    );
  }

  const assignedCount = Object.keys(assignments).length;

  return (
    <div className="space-y-5">
      <Card className="p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold">Icons Gallery</h2>
            <p className="mt-1 text-sm text-sub">
              An optional icon on each menu button. Appearance only — it never changes what an item costs, what it is
              made of, what it asks for, where it is filed, or where its ticket goes.
            </p>
          </div>
          <Badge tone="slate">This terminal</Badge>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Stat label="Icons available" value={String(searchIcons("", null).length)} glyph="layers" />
          <Stat label="Categories" value={String(sections.length)} glyph="grid" />
          <Stat label="Items with an icon" value={String(assignedCount)} glyph="check" />
        </div>

        <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-[11px] text-sub">
          Icons are stored on this computer, like the theme. Another terminal will not show them until it is set up the
          same way.
        </p>
      </Card>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        {/* --- browse the icon set ---------------------------------------- */}
        <Card className="p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-extrabold text-ink">Browse icons</p>
              <p className="mt-0.5 text-xs text-sub">Search and category work together.</p>
            </div>
            <div className="flex items-center gap-1">
              {ICON_CATEGORIES.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCategory(category === c ? null : c)}
                  className={cn(
                    "rounded-lg px-2.5 py-1 text-xs font-bold transition",
                    category === c ? "bg-brand text-onbrand" : "bg-slate-100 text-sub hover:text-ink",
                  )}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-3 flex items-center gap-2">
            <span className="text-sub">
              <Glyph name="search" size={16} />
            </span>
            <Input
              size="sm"
              value={iconQuery}
              onChange={(e) => setIconQuery(e.target.value)}
              placeholder="Search icons — burger, coffee, juice, cake, pizza…"
            />
          </div>

          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-[168px_minmax(0,1fr)]">
            {/* Sections, with counts. */}
            <div className="space-y-1">
              <button
                type="button"
                onClick={() => setSection(null)}
                className={cn(
                  "flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-xs font-bold transition",
                  section === null ? "bg-brand-soft text-brand-dark" : "text-sub hover:bg-slate-50 hover:text-ink",
                )}
              >
                <span>All</span>
                <span className="tabular-nums">{searchIcons("", category).length}</span>
              </button>
              {visibleSections.map((s) => (
                <button
                  key={s.section}
                  type="button"
                  onClick={() => setSection(section === s.section ? null : s.section)}
                  className={cn(
                    "flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-xs font-bold transition",
                    section === s.section ? "bg-brand-soft text-brand-dark" : "text-sub hover:bg-slate-50 hover:text-ink",
                  )}
                >
                  <span className="truncate">{s.section}</span>
                  <span className="shrink-0 tabular-nums">{s.count}</span>
                </button>
              ))}
              {sections.length > SECTIONS_COLLAPSED && (
                <Button size="sm" variant="ghost" className="w-full" onClick={() => setAllSections((v) => !v)}>
                  {allSections ? "Show fewer" : `Show more (${sections.length - SECTIONS_COLLAPSED})`}
                </Button>
              )}
            </div>

            {/* The tiles. */}
            {icons.length === 0 ? (
              <EmptyState title="No icons match" hint="Try a shorter search, or clear the category." />
            ) : (
              <div className="grid max-h-[520px] grid-cols-4 gap-2 overflow-y-auto pr-1 sm:grid-cols-5 lg:grid-cols-6">
                {icons.map((icon) => {
                  const picked = currentKey === icon.key;
                  return (
                    <button
                      key={icon.key}
                      type="button"
                      disabled={!target}
                      title={target ? `${icon.label} · ${icon.section}` : "Pick a menu item first"}
                      onClick={() => setStaged(icon.key)}
                      className={cn(
                        "flex min-h-[76px] flex-col items-center justify-center gap-1 rounded-xl border p-2 transition",
                        picked
                          ? "border-2 border-brand bg-brand-soft text-brand-dark"
                          : "border-line bg-white text-ink",
                        target ? "hover:border-brand hover:bg-brand-soft" : "cursor-default opacity-60",
                      )}
                    >
                      <PosIconGlyph iconKey={icon.key} size={24} />
                      <span className="line-clamp-1 text-[10px] font-semibold">{icon.label}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </Card>

        {/* --- assign to a menu item -------------------------------------- */}
        <Card className="flex min-h-0 flex-col p-5">
          <p className="text-sm font-extrabold text-ink">Assign icon to menu item</p>

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
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
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
            <ul className="mt-3 max-h-[220px] space-y-1 overflow-y-auto pr-1">
              {items.map((item) => {
                const key = iconForItem(assignments, item.id);
                const active = target?.id === item.id;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => choose(item)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left transition",
                        active ? "border-brand bg-brand-soft" : "border-transparent hover:bg-slate-50",
                      )}
                    >
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-slate-50 text-sub">
                        {key ? <PosIconGlyph iconKey={key} size={16} /> : <span className="text-[10px]">—</span>}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink">{item.name}</span>
                      <span className="shrink-0 text-[11px] font-bold text-sub">{key ? "Change" : "Assign"}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {/* --- display settings ----------------------------------------- */}
          <div className="mt-4 space-y-2 border-t border-line pt-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-bold uppercase tracking-wide text-sub">Icon style</span>
              <div className="flex gap-1">
                {ICON_STYLES.map((s) => (
                  <button
                    key={s.value}
                    type="button"
                    onClick={() => changeDisplay({ ...display, style: s.value })}
                    className={cn(
                      "rounded-lg px-2.5 py-1 text-xs font-bold transition",
                      display.style === s.value ? "bg-brand-soft text-brand-dark" : "bg-slate-100 text-sub hover:text-ink",
                    )}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-bold uppercase tracking-wide text-sub">Icon size</span>
              <div className="flex gap-1">
                {ICON_SIZES.map((s) => (
                  <button
                    key={s.value}
                    type="button"
                    onClick={() => changeDisplay({ ...display, size: s.value })}
                    className={cn(
                      "min-w-[34px] rounded-lg px-2 py-1 text-xs font-bold transition",
                      display.size === s.value ? "bg-brand-soft text-brand-dark" : "bg-slate-100 text-sub hover:text-ink",
                    )}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
            <p className="text-[11px] text-sub">
              Style and size apply to every icon on this terminal. Colour is the theme&apos;s, never the icon&apos;s.
            </p>
          </div>

          {/* --- preview + actions ---------------------------------------- */}
          <div className="mt-4 border-t border-line pt-3">
            <p className="text-[11px] font-bold uppercase tracking-wide text-sub">Preview in POS</p>
            {target ? (
              <>
                <div className="mt-2">
                  {/* The POS menu button itself - same component, same theme. */}
                  <MenuCard
                    as="div"
                    name={target.name}
                    price={typeof target.price === "number" ? target.price : Number(target.price ?? 0) || null}
                    currency={currency}
                    iconKey={currentKey}
                    display={display}
                  />
                </div>
                <p className="mt-2 text-[11px] text-sub">
                  {currentKey
                    ? `${ICON_BY_KEY[currentKey]?.label ?? ""}${dirty ? " — not applied yet" : ""}`
                    : "No icon"}
                </p>

                <div className="mt-3 space-y-2">
                  <Button className="w-full" disabled={!dirty} onClick={commit}>
                    <Glyph name="check" size={16} />
                    Save changes
                  </Button>
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      variant="ghost"
                      disabled={!currentKey}
                      onClick={() => setStaged(null)}
                      title="Take the icon off this item"
                    >
                      Remove icon
                    </Button>
                    <Button variant="ghost" disabled={!dirty} onClick={() => setStaged(undefined)}>
                      Discard
                    </Button>
                  </div>
                </div>
              </>
            ) : (
              <p className="mt-2 rounded-lg bg-slate-50 px-3 py-4 text-center text-xs text-sub">
                Pick a menu item above, then choose an icon.
              </p>
            )}
          </div>

          <p className="mt-3 flex items-start gap-1.5 rounded-lg bg-sky-50 px-3 py-2 text-[11px] text-sky-800">
            <Glyph name="info" size={13} className="mt-0.5 shrink-0" />
            <span>
              This only changes the display inside POS. It does not affect what an item is made of, what it costs, or
              what is counted in stock.
            </span>
          </p>
        </Card>
      </div>
    </div>
  );
}

function Stat({ label, value, glyph }: { label: string; value: string; glyph: "layers" | "grid" | "check" }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-line bg-white px-3 py-2.5">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand-dark">
        <Glyph name={glyph} size={18} />
      </span>
      <span className="min-w-0">
        <span className="block text-lg font-extrabold leading-tight text-ink">{value}</span>
        <span className="block truncate text-[11px] font-semibold text-sub">{label}</span>
      </span>
    </div>
  );
}
