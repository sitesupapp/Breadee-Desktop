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
    if (draft.enabled && failing.length > 0) {
      setError(
        `This grid does not fit ${failing.map((f) => f.profile.label).join(", ")}. Choose fewer columns or rows, or a smaller Current Order column.`,
      );
      return;
    }
    const result = writeLayout(scope, draft);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSaved(draft);
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
              options, payment, printing and reports — is identical in both.
            </p>
          </div>
          <Badge tone="slate">This terminal</Badge>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <ModeCard
            selected={!draft.enabled}
            title="Default"
            body="The standard Breadee POS: category strip, searchable menu grid, Current Order on the right. This is what every terminal uses unless you change it."
            onSelect={() => setDraft({ ...draft, enabled: false })}
          />
          <ModeCard
            selected={draft.enabled}
            title="Customized"
            body="Your own grid of keys, laid out and coloured by you. Menu items and categories only; the ordering, pricing and printing are unchanged."
            onSelect={() => setDraft({ ...draft, enabled: true })}
          />
        </div>

        <p className="mt-3 text-[11px] text-sub">
          Saved on this terminal only. It does not follow you to another till and is not backed up with your business
          data — set it up on each terminal that needs it.
        </p>
      </Card>

      {draft.enabled && (
        <>
          <Card className="p-6">
            <p className="text-sm font-extrabold text-ink">Screen</p>
            <div className="mt-3 flex flex-wrap items-end gap-4">
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
              </div>

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
