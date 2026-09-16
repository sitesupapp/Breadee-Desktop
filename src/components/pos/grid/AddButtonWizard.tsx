// Adding a button, as a short pipeline rather than a settings form.
//
// FIVE STEPS, ONE DECISION EACH: name it, say what it is, link it, colour it,
// save. The person doing this is a manager setting up a till before service, not
// an administrator with an afternoon, and a single dialog with fourteen fields
// is how a setup screen goes unused.
//
// PRINTER ROUTING IS DELIBERATELY ABSENT FROM THIS WIZARD. Where an item is
// prepared belongs to the ITEM, not to a button that happens to point at it -
// see `lib/pos/itemRouting.ts`. Putting a printer picker here would let the same
// product route two ways depending on which button a cashier pressed, which is
// the one outcome the routing design exists to make impossible. It is configured
// once, in Settings → Printing & Routing → Item routing.
//
// THERE IS NO PRICE FIELD, AND THERE CANNOT BE ONE. A menu-item button inherits
// everything commercial from the canonical item: price, tax, recipe, modifiers,
// availability, inventory behaviour and reporting identity. The model has
// nowhere to store a price - see `lib/pos/grid/model.ts`.

import { useMemo, useState } from "react";
import { Button, Input, cn } from "@/components/ui";
import { Modal } from "@/components/overlays";
import { formatMoney, type CurrencyCode } from "@/lib/currency";
import { resolveMenuPrice } from "@/lib/pos/menuPrice";
import type { SearchableItem } from "@/lib/pos/menu";
import { HUES, SHADES, resolveColor } from "@/lib/pos/grid/colors";
import { ICON_BY_KEY, POS_ICONS } from "@/lib/icons/catalog";
import { PosIconGlyph } from "@/components/PosIconGlyph";
import type { ButtonSpan, GridButton, GridButtonKind, GridColorRef } from "@/lib/pos/grid/model";

export type WizardDraft = {
  label: string;
  kind: GridButtonKind;
  menuItemId: string | null;
  iconKey: string | null;
  color: GridColorRef;
  width: ButtonSpan;
  height: ButtonSpan;
};

export const EMPTY_DRAFT: WizardDraft = {
  label: "",
  kind: "menu_item",
  menuItemId: null,
  iconKey: null,
  color: null,
  width: 1,
  height: 1,
};

/** A draft built from an existing button, for editing rather than adding. */
export function draftFromButton(button: GridButton): WizardDraft {
  return {
    label: button.label,
    kind: button.kind,
    menuItemId: button.menuItemId,
    iconKey: button.iconKey,
    color: button.color,
    width: button.width,
    height: button.height,
  };
}

type Step = 1 | 2 | 3 | 4;

const STEP_TITLES: Record<Step, string> = {
  1: "Name",
  2: "Type",
  3: "Link",
  4: "Appearance",
};

export function AddButtonWizard({
  open,
  editing,
  initial,
  items,
  currency,
  rate,
  /** Category pages may not hold another category - see the model. */
  allowCategory,
  onCancel,
  onSave,
}: {
  open: boolean;
  editing: boolean;
  initial: WizardDraft;
  items: SearchableItem[];
  currency: CurrencyCode;
  rate: number | null;
  allowCategory: boolean;
  onCancel: () => void;
  onSave: (draft: WizardDraft) => void;
}) {
  const [step, setStep] = useState<Step>(1);
  const [draft, setDraft] = useState<WizardDraft>(initial);
  const [query, setQuery] = useState("");
  const [touched, setTouched] = useState(false);

  // Re-seed whenever the dialog is opened for a different button. Keyed on the
  // dialog being closed rather than on a `useEffect`, so there is no render in
  // which the previous button's draft is on screen.
  const [seed, setSeed] = useState(initial);
  if (open && seed !== initial) {
    setSeed(initial);
    setDraft(initial);
    setStep(1);
    setQuery("");
    setTouched(false);
  }

  const patch = (over: Partial<WizardDraft>) => setDraft((d) => ({ ...d, ...over }));

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pool = q === "" ? items : items.filter((i) => i.name.toLowerCase().includes(q));
    // Bounded, because a 500-item menu in a dialog is a scroll nobody finishes.
    // The search is how a long menu is reached, and it is right above this list.
    return pool.slice(0, 60);
  }, [items, query]);

  const linkedItem = draft.menuItemId ? items.find((i) => i.id === draft.menuItemId) ?? null : null;

  /** Why this step cannot be left. Null when it can. */
  const stepProblem = ((): string | null => {
    if (step === 1) return draft.label.trim() === "" ? "Give the button a name." : null;
    if (step === 3 && draft.kind === "menu_item" && !draft.menuItemId) {
      return "Choose the menu item this button sells.";
    }
    return null;
  })();

  const canSave = draft.label.trim() !== "" && (draft.kind === "category" || Boolean(draft.menuItemId));

  const next = () => {
    setTouched(true);
    if (stepProblem) return;
    setTouched(false);
    setStep((s) => (Math.min(4, s + 1) as Step));
  };

  return (
    <Modal
      open={open}
      title={editing ? "Edit button" : "Add button"}
      subtitle={`Step ${step} of 4 — ${STEP_TITLES[step]}`}
      size="lg"
      onClose={onCancel}
      footer={
        <div className="flex items-center justify-between gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <div className="flex items-center gap-2">
            {step > 1 && (
              <Button variant="ghost" onClick={() => setStep((s) => (Math.max(1, s - 1) as Step))}>
                Back
              </Button>
            )}
            {step < 4 ? (
              <Button onClick={next}>Next</Button>
            ) : (
              <Button disabled={!canSave} onClick={() => onSave(draft)}>
                {editing ? "Save changes" : "Add button"}
              </Button>
            )}
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        {touched && stepProblem && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">{stepProblem}</p>
        )}

        {/* --- 1. Name ------------------------------------------------------ */}
        {step === 1 && (
          <div>
            <label className="mb-1 block text-xs font-bold text-ink" htmlFor="grid-button-name">
              What should the cashier see?
            </label>
            <Input
              id="grid-button-name"
              autoFocus
              value={draft.label}
              maxLength={40}
              placeholder="e.g. Large Pizza, Hot Drinks, Best Sellers"
              onChange={(e) => patch({ label: e.target.value })}
            />
            <p className="mt-2 text-xs text-sub">
              This is the label on the key and nothing more. For a menu item it may differ from the item's own name —
              the price, recipe, options and reporting all still come from the item itself.
            </p>
          </div>
        )}

        {/* --- 2. Type ------------------------------------------------------ */}
        {step === 2 && (
          <div className="grid gap-3 sm:grid-cols-2">
            <TypeCard
              selected={draft.kind === "menu_item"}
              title="Menu item"
              body="Adds one product to the order. It must be linked to a real Breadee menu item."
              onSelect={() => patch({ kind: "menu_item" })}
            />
            <TypeCard
              selected={draft.kind === "category"}
              title="Category"
              disabled={!allowCategory}
              disabledReason="A category cannot contain another category."
              body="Opens a page of more buttons. Name it whatever suits your counter — it does not change your menu."
              onSelect={() => patch({ kind: "category", menuItemId: null })}
            />
          </div>
        )}

        {/* --- 3. Link ------------------------------------------------------ */}
        {step === 3 && draft.kind === "menu_item" && (
          <div>
            <Input
              autoFocus
              value={query}
              placeholder="Search the menu"
              onChange={(e) => setQuery(e.target.value)}
            />
            {linkedItem && (
              <p className="mt-2 rounded-lg bg-brand-soft px-3 py-2 text-xs font-bold text-brand-dark">
                Linked to {linkedItem.name}
              </p>
            )}
            <div className="mt-2 max-h-72 space-y-1 overflow-y-auto overscroll-contain pr-1">
              {matches.length === 0 ? (
                <p className="px-1 py-4 text-center text-xs text-sub">No menu items match.</p>
              ) : (
                matches.map((item) => {
                  const price = resolveMenuPrice(item, item.price, currency, rate).amount;
                  const selected = item.id === draft.menuItemId;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() =>
                        patch({
                          menuItemId: item.id,
                          // A blank name is filled in from the item, which is
                          // what somebody adding twenty buttons expects. A name
                          // they typed is never overwritten.
                          label: draft.label.trim() === "" ? item.name : draft.label,
                        })
                      }
                      className={cn(
                        "flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-2 text-left text-sm",
                        selected ? "border-brand bg-brand-soft" : "border-line bg-white hover:border-brand/50",
                      )}
                    >
                      <span className="min-w-0 truncate font-semibold text-ink">{item.name}</span>
                      {/* Read-only, from the canonical item. There is no price
                          field in this wizard and there is nowhere to save one. */}
                      <span className="shrink-0 text-xs font-extrabold tabular-nums text-sub">
                        {price === null ? "No price" : formatMoney(price, currency)}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        )}

        {step === 3 && draft.kind === "category" && (
          <div className="rounded-xl border border-line bg-slate-50/60 p-4">
            <p className="text-sm font-bold text-ink">Nothing to link</p>
            <p className="mt-1 text-xs text-sub">
              A category is a page of buttons on this till. Save it, then open it on the layout to add menu items to it.
              The same item may sit on the main page and inside as many categories as you like — that is several
              shortcuts to one product, not several products.
            </p>
          </div>
        )}

        {/* --- 4. Appearance ----------------------------------------------- */}
        {step === 4 && (
          <div className="space-y-4">
            <div>
              <p className="mb-1.5 text-xs font-bold text-ink">Colour</p>
              <div className="flex flex-wrap gap-1.5">
                <Swatch
                  fill={null}
                  selected={draft.color === null}
                  title="Follow the terminal's theme"
                  onSelect={() => patch({ color: null })}
                />
                {HUES.map((hue) =>
                  SHADES.map((shade) => {
                    const fill = hue.shades[shade];
                    if (!fill) return null;
                    const selected = draft.color?.hue === hue.key && draft.color?.shade === shade;
                    return (
                      <Swatch
                        key={`${hue.key}-${shade}`}
                        fill={fill}
                        selected={selected}
                        title={`${hue.label} ${shade}`}
                        onSelect={() => patch({ color: { hue: hue.key, shade } })}
                      />
                    );
                  }),
                )}
              </div>
              <p className="mt-1.5 text-[11px] text-sub">
                A chosen colour looks the same in Light and Dark — it is a landmark, like a key cap. Its text colour is
                worked out from the colour itself, so it is always readable. “Theme” follows your terminal's theme.
              </p>
            </div>

            <div>
              <p className="mb-1.5 text-xs font-bold text-ink">Icon (optional)</p>
              <div className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto overscroll-contain">
                <IconChoice selected={draft.iconKey === null} onSelect={() => patch({ iconKey: null })} />
                {POS_ICONS.map((icon) => (
                  <IconChoice
                    key={icon.key}
                    iconKey={icon.key}
                    selected={draft.iconKey === icon.key}
                    onSelect={() => patch({ iconKey: icon.key })}
                  />
                ))}
              </div>
            </div>

            <div className="flex flex-wrap gap-4">
              <SpanPicker label="Width" value={draft.width} onChange={(w) => patch({ width: w })} />
              <SpanPicker label="Height" value={draft.height} onChange={(h) => patch({ height: h })} />
            </div>

            <Preview draft={draft} currency={currency} rate={rate} item={linkedItem} />
          </div>
        )}
      </div>
    </Modal>
  );
}

function TypeCard({
  selected,
  title,
  body,
  disabled = false,
  disabledReason,
  onSelect,
}: {
  selected: boolean;
  title: string;
  body: string;
  disabled?: boolean;
  disabledReason?: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      title={disabled ? disabledReason : undefined}
      className={cn(
        "rounded-xl border p-4 text-left transition",
        selected ? "border-brand bg-brand-soft" : "border-line bg-white hover:border-brand/50",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <p className="font-bold text-ink">{title}</p>
      <p className="mt-1 text-xs text-sub">{disabled ? disabledReason : body}</p>
    </button>
  );
}

function Swatch({
  fill,
  selected,
  title,
  onSelect,
}: {
  fill: string | null;
  selected: boolean;
  title: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onSelect}
      style={fill ? { backgroundColor: fill } : undefined}
      className={cn(
        "h-7 w-7 rounded-lg border-2 transition",
        selected ? "border-ink" : "border-line hover:border-sub",
        !fill && "bg-white",
      )}
    >
      {!fill && <span className="text-[9px] font-bold text-sub">T</span>}
    </button>
  );
}

function IconChoice({
  iconKey,
  selected,
  onSelect,
}: {
  iconKey?: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      title={iconKey ? ICON_BY_KEY[iconKey]?.label ?? iconKey : "No icon"}
      className={cn(
        "flex h-9 w-9 items-center justify-center rounded-lg border transition",
        selected ? "border-brand bg-brand-soft text-brand-dark" : "border-line bg-white text-sub hover:border-brand/50",
      )}
    >
      {iconKey ? <PosIconGlyph iconKey={iconKey} size={18} /> : <span className="text-[10px] font-bold">none</span>}
    </button>
  );
}

function SpanPicker({
  label,
  value,
  onChange,
}: {
  label: string;
  value: ButtonSpan;
  onChange: (value: ButtonSpan) => void;
}) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-bold text-ink">{label}</p>
      <div className="flex gap-1.5">
        {[1, 2].map((span) => (
          <button
            key={span}
            type="button"
            onClick={() => onChange(span as ButtonSpan)}
            className={cn(
              "min-h-[36px] rounded-lg border px-3 text-sm font-semibold",
              value === span ? "border-brand bg-brand-soft text-brand-dark" : "border-line bg-white text-ink",
            )}
          >
            {span} cell{span === 1 ? "" : "s"}
          </button>
        ))}
      </div>
    </div>
  );
}

/** What the key will look like. The real colours, at a readable size. */
function Preview({
  draft,
  currency,
  rate,
  item,
}: {
  draft: WizardDraft;
  currency: CurrencyCode;
  rate: number | null;
  item: SearchableItem | null;
}) {
  const { fill, ink } = resolveColor(draft.color);
  const price = item ? resolveMenuPrice(item, item.price, currency, rate).amount : null;
  return (
    <div>
      <p className="mb-1.5 text-xs font-bold text-ink">Preview</p>
      <div
        style={{
          ...(fill && ink ? { backgroundColor: fill, color: ink, borderColor: ink } : {}),
          width: 96 * draft.width,
          height: 64 * draft.height,
        }}
        className={cn(
          "flex flex-col justify-between rounded-xl border p-2",
          !fill && "border-line bg-white text-ink",
        )}
      >
        <span className="flex items-start gap-1">
          {draft.iconKey && <PosIconGlyph iconKey={draft.iconKey} size={16} />}
          <span className="min-w-0 break-words text-xs font-bold">{draft.label || "Button"}</span>
        </span>
        <span className="text-xs font-extrabold tabular-nums opacity-80">
          {draft.kind === "category" ? "Category" : price === null ? "No price" : formatMoney(price, currency)}
        </span>
      </div>
    </div>
  );
}
