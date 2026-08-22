// Settings -> POS Settings -> Cashier layout.
//
// THE SWITCH IS THE FEATURE. Everything below exists to be turned OFF safely.
// With Cashier layout set to Default the workspace renders the production POS
// exactly as it did before this release - same grid, same categories, same
// search, same buttons, same routes, same printing - and nothing on this screen
// is consulted. That is not a fallback for when the customized layout breaks; it
// is the default state of every existing installation, and it is what "no
// behavioural regression for users who never enable Customized mode" means.
//
// SAVING IS DELIBERATE AND VALIDATED. A draft lives here until Save; nothing a
// manager is midway through typing reaches a till. Save refuses a layout with a
// problem in it, and it refuses a grid shape that cannot fit the screens tills
// actually have - because the alternative is a cashier discovering it at a
// counter, and the requirement this feature was built around is that the
// ordering workspace never has to be scrolled.
//
// THIS TERMINAL ONLY, AND IT SAYS SO ON SCREEN. See `lib/pos/grid/storage.ts`
// for why, and for the limitation that follows.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, EmptyState, Input, Skeleton, cn } from "@/components/ui";
import { usePosContext } from "@/state/pos";
import { useSession } from "@/state/session";
import { loadMenu, withSearchIndex, type SearchableItem } from "@/lib/pos/menu";
import { classifyError } from "@/lib/pos/errors";
import { GridDesigner, DesignerHint, type CellAction } from "@/components/pos/grid/GridDesigner";
import { PosLayoutGrid, GridEmptyState } from "@/components/pos/grid/PosLayoutGrid";
import { resolveMenuPrice } from "@/lib/pos/menuPrice";
import {
  UNCATEGORISED_ID,
  hiddenCount,
  pruneOverrides,
  reorder,
  resolveCategoryButtons,
  resolveCategoryItems,
  resolveDefaultButtons,
  resolveUncategorised,
  writeOverride,
} from "@/lib/pos/grid/presentation";
import type { CurrencyCode } from "@/lib/currency";
import type { MenuCategory, MenuItem } from "@/types/pos";
import { AddButtonWizard, EMPTY_DRAFT, draftFromButton, type WizardDraft } from "@/components/pos/grid/AddButtonWizard";
import { fitAcrossProfiles, largestSafeGrid } from "@/lib/pos/grid/fit";
import { readLayout, writeLayout } from "@/lib/pos/grid/storage";
import {
  MAX_COLUMNS,
  MAX_ROWS,
  MIN_COLUMNS,
  MIN_ROWS,
  addButton,
  countItemButtons,
  emptyLayout,
  findFreeCell,
  moveButton,
  newButtonId,
  nextButtonSeed,
  pageOf,
  removeButton,
  resizeGrid,
  updateButton,
  validateLayout,
  type GridButton,
  type PosGridLayout,
} from "@/lib/pos/grid/model";

export function CashierLayout() {
  const pos = usePosContext();
  const session = useSession();
  const tenantId = pos.tenantId;
  const branchId = pos.branch.id;
  const currency = session.currency.primary;
  const rate = session.currency.rate;

  const scope = useMemo(() => ({ tenantId, branchId }), [tenantId, branchId]);

  const [saved, setSaved] = useState<PosGridLayout>(() => emptyLayout());
  const [draft, setDraft] = useState<PosGridLayout>(() => emptyLayout());
  const [items, setItems] = useState<SearchableItem[]>([]);
  const [categories, setCategories] = useState<MenuCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Which category page is open in the designer. `null` is the main page. */
  const [openCategoryId, setOpenCategoryId] = useState<string | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  /** The wizard's target: a new button at a cell, or an existing one. */
  const [wizard, setWizard] = useState<
    | { kind: "add"; row: number; col: number; initial: WizardDraft }
    | { kind: "edit"; button: GridButton; initial: WizardDraft }
    | null
  >(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const stored = readLayout(scope);
    setSaved(stored);
    setDraft(stored);
    if (!tenantId) {
      setLoading(false);
      return;
    }
    try {
      const menu = await loadMenu(tenantId);
      setItems(withSearchIndex(menu.items));
      // The Categories layout is built from these, so the editor needs them
      // too - and needs them from the SAME loader the till uses, or the preview
      // would be previewing a different menu.
      setCategories(menu.categories);
    } catch (e) {
      // The layout is still editable without the menu - an operator can move and
      // recolour buttons - but linking a new one needs the canonical list, so
      // the reason is shown rather than an empty picker.
      setLoadError(classifyError(e).message);
    }
    setLoading(false);
  }, [scope, tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  const itemsById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const problems = useMemo(() => validateLayout(draft), [draft]);
  const profileFits = useMemo(
    () => fitAcrossProfiles({ columns: draft.columns, rows: draft.rows }),
    [draft.columns, draft.rows],
  );
  const failing = profileFits.filter((p) => p.fit.kind !== "fits");
  const dirty = JSON.stringify(saved) !== JSON.stringify(draft);
  const page = pageOf(draft, openCategoryId);
  const openCategory = openCategoryId ? draft.buttons.find((b) => b.id === openCategoryId) ?? null : null;

  const apply = (result: { ok: true; layout: PosGridLayout } | { ok: false; error: string }) => {
    if (result.ok) {
      setDraft(result.layout);
      setError(null);
    } else {
      setError(result.error);
    }
  };

  const onAction = (action: CellAction) => {
    setNotice(null);
    switch (action.kind) {
      case "add":
        setWizard({ kind: "add", row: action.row, col: action.col, initial: { ...EMPTY_DRAFT } });
        return;
      case "edit":
        setWizard({ kind: "edit", button: action.button, initial: draftFromButton(action.button) });
        return;
      case "open":
        setOpenCategoryId(action.button.id);
        setMovingId(null);
        return;
      case "move":
        setMovingId(action.button.id);
        return;
      case "remove":
        setDraft(removeButton(draft, openCategoryId, action.button.id));
        setError(null);
        return;
    }
  };

  const dropAt = (row: number, col: number) => {
    if (!movingId) return;
    const result = moveButton(draft, openCategoryId, movingId, { row, col });
    apply(result);
    if (result.ok) setMovingId(null);
  };

  const saveWizard = (wizardDraft: WizardDraft) => {
    if (!wizard) return;
    if (wizard.kind === "edit") {
      apply(
        updateButton(draft, openCategoryId, wizard.button.id, {
          label: wizardDraft.label.trim(),
          menuItemId: wizardDraft.kind === "menu_item" ? wizardDraft.menuItemId : null,
          iconKey: wizardDraft.iconKey,
          color: wizardDraft.color,
          width: wizardDraft.width,
          height: wizardDraft.height,
        }),
      );
      setWizard(null);
      return;
    }
    const button: GridButton = {
      id: newButtonId(nextButtonSeed(draft)),
      kind: wizardDraft.kind,
      label: wizardDraft.label.trim(),
      menuItemId: wizardDraft.kind === "menu_item" ? wizardDraft.menuItemId : null,
      iconKey: wizardDraft.iconKey,
      color: wizardDraft.color,
      row: wizard.row,
      col: wizard.col,
      width: wizardDraft.width,
      height: wizardDraft.height,
      children: [],
    };
    let result = addButton(draft, openCategoryId, button);
    if (!result.ok) {
      // The chosen cell cannot hold a 2x2; put it in the first place that can
      // rather than refusing outright, and say where it went.
      const free = findFreeCell(page, wizardDraft.width, wizardDraft.height);
      if (free) {
        result = addButton(draft, openCategoryId, { ...button, ...free });
        if (result.ok) setNotice(`“${button.label}” did not fit there, so it was placed at row ${free.row}, column ${free.col}.`);
      }
    }
    apply(result);
    setWizard(null);
  };

  const save = () => {
    setError(null);
    setNotice(null);
    if (problems.length > 0) {
      setError("Fix the problems listed below before saving.");
      return;
    }
    // Only a MANUAL customized grid can be configured into a shape that does not
    // fit: with Auto-fit on, the sizing engine chooses the grid, and it cannot
    // choose an impossible one. Blocking the save in that case would refuse a
    // configuration the till will render correctly.
    if (draft.mode === "customized" && !draft.autoFit && failing.length > 0) {
      setError(
        `This grid does not fit ${failing.map((f) => f.profile.label).join(", ")}. Choose fewer columns or rows, turn Auto-fit on, or move the Current Order column.`,
      );
      return;
    }
    // Overrides whose canonical target is gone are dropped on the way out, so
    // the map cannot rot into a second menu. Done on SAVE, never on read: an
    // item briefly absent because the menu is still loading must not have its
    // colour thrown away.
    const cleaned = { ...draft, presentation: pruneOverrides(draft.presentation, categories, items) };
    const result = writeLayout(scope, cleaned);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSaved(cleaned);
    setDraft(cleaned);
    setNotice("Saved on this terminal.");
  };

  if (loading) return <Skeleton className="h-96" />;
  if (!tenantId) {
    return (
      <Card className="p-6">
        <EmptyState title="No business linked" hint="Sign in with an account that belongs to a business." />
      </Card>
    );
  }

  const suggestion = largestSafeGrid();

  return (
    <div className="space-y-5">
      <Card className="p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold">Cashier layout</h2>
            <p className="mt-1 text-sm text-sub">
              Choose how the ordering screen presents your menu. Everything else about the POS — the order, prices,
              options, payment, printing and reports — is identical in all three.
            </p>
          </div>
          <Badge tone="slate">This terminal</Badge>
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-3">
          <ModeCard
            selected={draft.mode === "default"}
            title="Default"
            body="Every available item, with the category strip above it. What a terminal uses unless you change it."
            onSelect={() => setDraft({ ...draft, mode: "default" })}
          />
          <ModeCard
            selected={draft.mode === "categories"}
            title="Categories"
            body="Your menu's own categories as keys; tapping one opens its items. Built from Menu Builder, so a new category appears here by itself."
            onSelect={() => setDraft({ ...draft, mode: "categories" })}
          />
          <ModeCard
            selected={draft.mode === "customized"}
            title="Customized"
            body="Your own grid of keys, laid out and coloured by you. Menu items and categories only."
            onSelect={() => setDraft({ ...draft, mode: "customized" })}
          />
        </div>

        <div className="mt-4 flex flex-wrap items-end gap-4 border-t border-line pt-4">
          <div>
            <p className="mb-1.5 text-xs font-bold text-ink">Current Order</p>
            <div className="flex gap-1.5">
              {(["left", "right"] as const).map((side) => (
                <button
                  key={side}
                  type="button"
                  onClick={() => setDraft({ ...draft, orderPanel: side })}
                  className={cn(
                    "min-h-[40px] rounded-lg border px-4 text-sm font-semibold capitalize",
                    draft.orderPanel === side
                      ? "border-brand bg-brand-soft text-brand-dark"
                      : "border-line bg-white text-ink",
                  )}
                >
                  {side}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[11px] text-sub">Applies to every layout.</p>
          </div>
        </div>

        <p className="mt-3 text-[11px] text-sub">
          Saved on this terminal only. It does not follow you to another till and is not backed up with your business
          data — set it up on each terminal that needs it.
        </p>
      </Card>

      {/* THE PREVIEW. The real grid, the real button, the real sizing engine -
          see `LayoutPreview`. A separate mock would agree on the day it was
          written and drift thereafter. */}
      <LayoutPreview
        draft={draft}
        categories={categories}
        items={items}
        currency={currency}
        rate={rate}
        onChange={setDraft}
      />

      {draft.mode === "customized" && (
        <>
          <Card className="p-6">
            <p className="text-sm font-extrabold text-ink">Grid</p>
            <p className="mt-0.5 text-xs text-sub">
              Used when Auto-fit is off. With Auto-fit on, the POS chooses the grid to fill the screen.
            </p>
            <div className="mt-3 flex flex-wrap items-end gap-4">
              <NumberField
                label="Columns"
                value={draft.columns}
                min={MIN_COLUMNS}
                max={MAX_COLUMNS}
                onChange={(columns) => apply(resizeGrid(draft, columns, draft.rows))}
              />
              <NumberField
                label="Rows"
                value={draft.rows}
                min={MIN_ROWS}
                max={MAX_ROWS}
                onChange={(rows) => apply(resizeGrid(draft, draft.columns, rows))}
              />

              <Button
                variant="ghost"
                onClick={() => apply(resizeGrid(draft, suggestion.columns, suggestion.rows))}
                title={`The largest grid that fits every supported screen: ${suggestion.columns}x${suggestion.rows}`}
              >
                Use {suggestion.columns}×{suggestion.rows}
              </Button>
            </div>

            {/* THE NO-SCROLL CHECK, per real screen class. A configuration that
                fails any of these is refused on Save, because the alternative is
                a cashier meeting it mid-service. */}
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {profileFits.map(({ profile, fit }) => (
                <div
                  key={profile.key}
                  className={cn(
                    "flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs",
                    fit.kind === "fits" ? "border-line bg-white" : "border-amber-300 bg-amber-50",
                  )}
                >
                  <span className="font-semibold text-ink">{profile.label}</span>
                  {fit.kind === "fits" ? (
                    <span className="text-sub">
                      Fits · {fit.metrics.cellWidth}×{fit.metrics.cellHeight} px keys
                    </span>
                  ) : (
                    <span className="font-bold text-amber-900">Too small</span>
                  )}
                </div>
              ))}
            </div>
          </Card>

          <Card className="p-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-extrabold text-ink">
                  {openCategory ? `Category: ${openCategory.label}` : "Main buttons"}
                </p>
                <p className="mt-0.5 text-xs text-sub">
                  {countItemButtons(draft)} menu item button{countItemButtons(draft) === 1 ? "" : "s"} in this layout.
                </p>
              </div>
              {openCategory && (
                <Button variant="ghost" onClick={() => { setOpenCategoryId(null); setMovingId(null); }}>
                  ← Back to main
                </Button>
              )}
            </div>

            <div className="mt-3">
              <DesignerHint moving={Boolean(movingId)} onCancelMove={() => setMovingId(null)} />
            </div>

            {loadError && (
              <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">
                The menu could not be loaded, so prices and item names are unavailable here. {loadError}
              </p>
            )}

            <div className="mt-3">
              <GridDesigner
                page={page}
                itemsById={itemsById}
                currency={currency}
                rate={rate}
                movingId={movingId}
                onAction={onAction}
                onDropAt={dropAt}
              />
            </div>

            {problems.length > 0 && (
              <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3">
                <p className="text-xs font-extrabold text-red-700">
                  {problems.length} problem{problems.length === 1 ? "" : "s"} to fix
                </p>
                <ul className="mt-1 space-y-0.5">
                  {problems.map((p, i) => (
                    <li key={`${p.code}-${p.buttonId ?? i}`} className="text-xs text-red-700">
                      {p.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Card>
        </>
      )}

      <Card className="p-5">
        {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">{error}</p>}
        {notice && !error && (
          <p className="mb-3 rounded-lg bg-slate-50 px-3 py-2 text-xs font-semibold text-sub">{notice}</p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={!dirty} onClick={save}>
            Save layout
          </Button>
          <Button
            variant="ghost"
            disabled={!dirty}
            onClick={() => {
              setDraft(saved);
              setError(null);
              setNotice(null);
              setMovingId(null);
              setOpenCategoryId(null);
            }}
          >
            Discard changes
          </Button>
          {dirty && <span className="text-xs font-semibold text-amber-900">Unsaved changes</span>}
        </div>
      </Card>

      <AddButtonWizard
        open={wizard !== null}
        editing={wizard?.kind === "edit"}
        initial={wizard?.initial ?? EMPTY_DRAFT}
        items={items}
        currency={currency}
        rate={rate}
        allowCategory={openCategoryId === null}
        onCancel={() => setWizard(null)}
        onSave={saveWizard}
      />
    </div>
  );
}

/**
 * The layout preview.
 *
 * IT IS THE REAL THING. `PosLayoutGrid` is the component the till renders, given
 * the same buttons, the same `autoFit` flag and the same sizing engine, inside a
 * frame shaped like a cashier screen. The Current Order column is drawn to scale
 * on the chosen side, because the space it takes is exactly what the grid does
 * not get - a preview that ignored it would promise a roomier till than exists.
 *
 * Right-click a button for Edit / Move / Hide. Those write PRESENTATION
 * OVERRIDES against the canonical id; nothing here can reach Menu Builder, which
 * is what makes "the cashier tidied their screen" and "somebody deleted a
 * product" different actions.
 */
function LayoutPreview({
  draft,
  categories,
  items,
  currency,
  rate,
  onChange,
}: {
  draft: PosGridLayout;
  categories: MenuCategory[];
  items: MenuItem[];
  currency: CurrencyCode;
  rate: number | null;
  onChange: (next: PosGridLayout) => void;
}) {
  const [openCategoryId, setOpenCategoryId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; button: GridButton } | null>(null);

  const itemsById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  /** EXACTLY the resolution the workspace performs. */
  const buttons = useMemo((): GridButton[] => {
    if (draft.mode === "customized") {
      return openCategoryId
        ? (draft.buttons.find((b) => b.id === openCategoryId)?.children ?? [])
        : draft.buttons;
    }
    if (draft.mode === "categories") {
      if (openCategoryId === UNCATEGORISED_ID) return resolveUncategorised(items, draft.presentation);
      if (openCategoryId) return resolveCategoryItems(openCategoryId, items, draft.presentation);
      const cats = resolveCategoryButtons(categories, items, draft.presentation);
      const loose = resolveUncategorised(items, draft.presentation);
      return loose.length > 0
        ? [...cats, { ...cats[0], id: UNCATEGORISED_ID, kind: "category" as const, label: "Other", menuItemId: null, color: null, iconKey: null, children: loose }]
        : cats;
    }
    return resolveDefaultButtons(items, draft.presentation);
  }, [draft, openCategoryId, items, categories]);

  /** Which canonical record a preview button stands for. */
  const targetOf = (button: GridButton): { kind: "category" | "item"; id: string } | null => {
    const [kind, id] = button.id.split(":");
    if ((kind === "category" || kind === "item") && id) return { kind, id };
    return null;
  };

  const act = (button: GridButton, change: "hide" | "up" | "down") => {
    setMenu(null);
    const target = targetOf(button);
    if (!target) return;
    if (change === "hide") {
      onChange({ ...draft, presentation: writeOverride(draft.presentation, target.kind, target.id, { hidden: true }) });
      return;
    }
    // Reordering writes an explicit order for the WHOLE list, not one index -
    // a single stored index means something different once the canonical list
    // changes underneath it.
    const ids = buttons.map((b) => targetOf(b)?.id).filter(Boolean) as string[];
    const at = ids.indexOf(target.id);
    const to = change === "up" ? at - 1 : at + 1;
    if (at < 0 || to < 0 || to >= ids.length) return;
    const next = [...ids];
    [next[at], next[to]] = [next[to], next[at]];
    onChange({ ...draft, presentation: reorder(draft.presentation, target.kind, next) });
  };

  const hidden = hiddenCount(draft.presentation);

  return (
    <Card className="p-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-extrabold text-ink">Preview</p>
          <p className="mt-0.5 text-xs text-sub">
            The real cashier grid. Right-click a button to reorder or remove it from this till — your menu is not
            changed.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {openCategoryId && (
            <Button size="sm" variant="ghost" onClick={() => setOpenCategoryId(null)}>
              ← Main
            </Button>
          )}
          {hidden > 0 && (
            <Button size="sm" variant="ghost" onClick={() => onChange({ ...draft, presentation: {} })}>
              Restore {hidden} hidden
            </Button>
          )}
        </div>
      </div>

      {/* A cashier-shaped frame. Fixed aspect so the proportions a manager
          approves are the proportions a till renders. */}
      <div className="mt-3 overflow-hidden rounded-xl border border-line bg-canvas" style={{ height: 420 }}>
        <div className="flex h-full">
          {draft.orderPanel === "left" && <PreviewOrderColumn />}
          <div className="min-w-0 flex-1 p-2">
            <PosLayoutGrid
              buttons={buttons}
              currency={currency}
              autoFit={draft.autoFit}
              columns={draft.columns}
              rows={draft.rows}
              placed={draft.mode === "customized"}
              priceFor={(b) => {
                if (!b.menuItemId) return null;
                const item = itemsById.get(b.menuItemId);
                return item ? resolveMenuPrice(item, item.price, currency, rate).amount : null;
              }}
              onPick={(b) => {
                if (b.kind === "category") setOpenCategoryId(b.id);
              }}
              onContextMenu={(button, e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, button });
              }}
              empty={<GridEmptyState title="Nothing to show" hint="Add items in Menu Builder to see them here." />}
            />
          </div>
          {draft.orderPanel !== "left" && <PreviewOrderColumn />}
        </div>
      </div>

      {menu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div
            style={{ left: Math.min(menu.x, window.innerWidth - 190), top: Math.min(menu.y, window.innerHeight - 180) }}
            className="fixed z-50 w-44 overflow-hidden rounded-xl border border-line bg-white py-1 shadow-lg"
            role="menu"
          >
            <PreviewMenuItem label="Move earlier" onClick={() => act(menu.button, "up")} />
            <PreviewMenuItem label="Move later" onClick={() => act(menu.button, "down")} />
            <PreviewMenuItem label="Remove from this till" danger onClick={() => act(menu.button, "hide")} />
          </div>
        </>
      )}
    </Card>
  );
}

/** The Current Order column, to scale. It is the space the grid does not get. */
function PreviewOrderColumn() {
  return (
    <aside style={{ width: 132 }} className="shrink-0 border-l border-line bg-white p-2">
      <p className="text-[10px] font-extrabold uppercase tracking-wide text-sub">Current order</p>
      <div className="mt-2 space-y-1">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-4 rounded bg-slate-100" />
        ))}
      </div>
    </aside>
  );
}

function PreviewMenuItem({ label, danger = false, onClick }: { label: string; danger?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        "block w-full px-3 py-2 text-left text-sm font-semibold hover:bg-slate-50",
        danger ? "text-red-700" : "text-ink",
      )}
    >
      {label}
    </button>
  );
}

function ModeCard({
  selected,
  title,
  body,
  onSelect,
}: {
  selected: boolean;
  title: string;
  body: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "rounded-xl border p-4 text-left transition",
        selected ? "border-brand bg-brand-soft" : "border-line bg-white hover:border-brand/50",
      )}
    >
      <p className="flex items-center gap-2 font-bold text-ink">
        {title}
        {selected && <Badge tone="green">In use</Badge>}
      </p>
      <p className="mt-1 text-xs text-sub">{body}</p>
    </button>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-bold text-ink">{label}</p>
      <Input
        className="w-24"
        inputMode="numeric"
        value={String(value)}
        onChange={(e) => {
          const next = Number(e.target.value);
          if (Number.isFinite(next) && next >= min && next <= max) onChange(Math.trunc(next));
        }}
      />
    </div>
  );
}
