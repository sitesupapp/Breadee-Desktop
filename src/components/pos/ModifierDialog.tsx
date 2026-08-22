// THE item-options dialog: modifiers, ingredients and portion, in one popup.
//
// The selection semantics are the ported, shared ones (m241 mirror): single-select
// replaces, multi-select appends, and validation - not click-trapping - reports
// what is still missing. That means the cashier always sees WHY the line cannot
// be added yet, instead of a dead button.
//
// ONE POPUP, NOT THREE. Ingredient customization and fractional quantity are
// switched independently, and a till with both on must not show a cashier three
// modals for one tap. Each section simply appears when its feature is on and the
// item has something to offer, and the dialog opens at all only when there is at
// least one question to ask - see `PosWorkspace.addItem`.
//
// THE PORTION IS A REAL QUANTITY. The 1/4 . 1/2 . 3/4 . Full row sets the same
// `quantity` the +/- buttons do; there is no second field and no note. See
// `lib/pos/itemOptions.ts` for the contract that makes that safe end to end.

import { useMemo, useState } from "react";
import { Modal } from "@/components/overlays";
import { Button, Textarea, cn } from "@/components/ui";
import { formatMoney, type CurrencyCode } from "@/lib/currency";
import { resolveMenuPrice } from "@/lib/pos/menuPrice";
import { allowedMax, isSingleSelect, lineTotals, modifierViolations, requiredMin, toggleModifier } from "@/lib/pos/modifiers";
import {
  QUANTITY_FRACTIONS,
  fractionLabel,
  formatQuantity,
  ingredientsOf,
  minimumQuantity,
  removalLabel,
  snapQuantity,
  stepQuantity,
  type ItemOptionsResult,
} from "@/lib/pos/itemOptions";
import type { MenuItem, ModifierGroup, ModifierOption, SelectedModifier } from "@/types/pos";

export type ModifierDialogProps = {
  open: boolean;
  item: MenuItem | null;
  basePrice: number;
  groups: ModifierGroup[];
  optionsByGroup: Record<string, ModifierOption[]>;
  currency: CurrencyCode;
  rate: number | null;
  /** Show the Menu Builder ingredient list for this item. */
  ingredientCustomization?: boolean;
  /** Offer 1/4 . 1/2 . 3/4 . Full and let quantity step by quarters. */
  fractionalQuantity?: boolean;
  onCancel: () => void;
  onConfirm: (input: ItemOptionsResult) => void;
};

export function ModifierDialog(props: ModifierDialogProps) {
  const [selected, setSelected] = useState<SelectedModifier[]>([]);
  const [quantity, setQuantity] = useState(1);
  const [note, setNote] = useState("");
  const [showErrors, setShowErrors] = useState(false);
  /** Menu Builder ingredients the cashier has switched OFF for this line. */
  const [removed, setRemoved] = useState<string[]>([]);

  // Reset whenever a different item opens the dialog.
  const itemId = props.item?.id ?? null;
  const [lastItemId, setLastItemId] = useState<string | null>(null);
  if (itemId !== lastItemId) {
    setLastItemId(itemId);
    setSelected([]);
    setQuantity(1);
    setNote("");
    setRemoved([]);
    setShowErrors(false);
  }

  /**
   * The item's customer-facing ingredients, from `menu_items.ingredients`.
   *
   * NOT a recipe and not Cost Control materials - see `itemOptions.ts`. An item
   * whose ingredients were never filled in simply offers no list, and the
   * section does not render.
   */
  const ingredients = useMemo(
    () => (props.ingredientCustomization && props.item ? ingredientsOf(props.item) : []),
    [props.ingredientCustomization, props.item],
  );

  const fractional = props.fractionalQuantity === true;
  const minQuantity = minimumQuantity(fractional);

  const toggleIngredient = (name: string) =>
    setRemoved((cur) => (cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name]));

  const knownOptionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const g of props.groups) for (const o of props.optionsByGroup[g.id] ?? []) ids.add(o.id);
    return ids;
  }, [props.groups, props.optionsByGroup]);

  const violations = useMemo(
    () => modifierViolations(selected, props.groups, knownOptionIds),
    [selected, props.groups, knownOptionIds],
  );
  const violationByGroup = useMemo(() => {
    const map: Record<string, string> = {};
    for (const v of violations) if (!map[v.group_id]) map[v.group_id] = v.message;
    return map;
  }, [violations]);

  const totals = lineTotals(props.basePrice, selected, quantity);

  function optionDelta(option: ModifierOption): number {
    return resolveMenuPrice(option, option.extra_price, props.currency, props.rate).amount ?? 0;
  }

  function confirm() {
    if (violations.length > 0) {
      setShowErrors(true);
      return;
    }
    props.onConfirm({
      modifiers: selected,
      quantity: snapQuantity(quantity),
      note: note.trim() ? note.trim() : null,
      // Only ingredients this item actually offers can be removed, so a stale
      // selection left by a previous item can never reach an order line.
      removedIngredients: removed.filter((name) => ingredients.includes(name)),
    });
  }

  return (
    <Modal
      open={props.open && !!props.item}
      title={props.item?.name ?? "Choose options"}
      subtitle={`${formatMoney(props.basePrice, props.currency)} base`}
      size="md"
      onClose={props.onCancel}
      footer={
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label="Decrease quantity"
              onClick={() => setQuantity((q) => stepQuantity(q, -1, fractional))}
              className="flex h-12 w-12 items-center justify-center rounded-xl border border-line bg-white text-xl font-bold"
            >
              -
            </button>
            {/* Formatted, never raw: a whole number reads `2` and a portion
                reads `0.5`. `2.00` on a till is noise a cashier has to parse. */}
            <span className="w-12 text-center text-lg font-extrabold tabular-nums">{formatQuantity(quantity)}</span>
            <button
              type="button"
              aria-label="Increase quantity"
              onClick={() => setQuantity((q) => stepQuantity(q, 1, fractional))}
              className="flex h-12 w-12 items-center justify-center rounded-xl border border-line bg-white text-xl font-bold"
            >
              +
            </button>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-lg font-extrabold tabular-nums text-ink">
              {formatMoney(totals.lineTotal, props.currency)}
            </span>
            <Button size="lg" onClick={confirm}>
              Add to order
            </Button>
          </div>
        </div>
      }
    >
      {showErrors && violations.length > 0 && (
        <div className="mb-3 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">
          {violations[0].message}
        </div>
      )}

      <div className="space-y-4">
        {props.groups.length === 0 && ingredients.length === 0 && !fractional && (
          <p className="text-sm text-sub">This item has no options.</p>
        )}

        {/* --- portion ------------------------------------------------------
            First, because on a pizza counter it is the thing being chosen. The
            buttons set a REAL quantity - the same value +/- above changes and
            the same one that reaches `pos_order_items.quantity`. */}
        {fractional && (
          <fieldset className="rounded-xl border border-line p-3">
            <legend className="px-1 text-sm font-bold text-ink">
              Portion <span className="text-xs font-semibold text-sub">Priced pro rata</span>
            </legend>
            <div className="mt-2 grid grid-cols-4 gap-2">
              {QUANTITY_FRACTIONS.map((fraction) => {
                const on = snapQuantity(quantity) === fraction;
                return (
                  <button
                    key={fraction}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setQuantity(fraction)}
                    className={cn(
                      "flex min-h-[52px] flex-col items-center justify-center rounded-xl border text-sm font-bold transition",
                      on ? "border-brand bg-brand-soft text-brand-dark" : "border-line bg-white text-ink hover:border-brand/40",
                    )}
                  >
                    <span className="text-base">{fraction === 1 ? "Full" : fractionLabel(fraction)}</span>
                    <span className="text-[11px] font-semibold opacity-75 tabular-nums">
                      {formatMoney(props.basePrice * fraction, props.currency)}
                    </span>
                  </button>
                );
              })}
            </div>
          </fieldset>
        )}

        {/* --- ingredients --------------------------------------------------
            The Menu Builder list. Switching one off removes it from THIS line;
            it changes no menu item, no recipe and no cost. */}
        {ingredients.length > 0 && (
          <fieldset className="rounded-xl border border-line p-3">
            <legend className="px-1 text-sm font-bold text-ink">
              Ingredients{" "}
              <span className="text-xs font-semibold text-sub">
                {removed.length > 0 ? `${removed.length} removed` : "Tap to remove"}
              </span>
            </legend>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {ingredients.map((name) => {
                const off = removed.includes(name);
                return (
                  <button
                    key={name}
                    type="button"
                    aria-pressed={!off}
                    onClick={() => toggleIngredient(name)}
                    className={cn(
                      "flex min-h-[52px] items-center justify-between gap-2 rounded-xl border px-3 text-left text-sm font-semibold transition",
                      off
                        ? "border-red-300 bg-red-50 text-red-700 line-through"
                        : "border-brand bg-brand-soft text-brand-dark",
                    )}
                  >
                    <span className="truncate">{name}</span>
                    <span aria-hidden className="shrink-0 text-xs font-bold">
                      {off ? "✕" : "✓"}
                    </span>
                  </button>
                );
              })}
            </div>
            {removed.length > 0 && (
              <p className="mt-2 text-xs font-bold text-red-700">
                {removed.map(removalLabel).join(" · ")}
              </p>
            )}
          </fieldset>
        )}

        {props.groups.map((group) => {
          const options = props.optionsByGroup[group.id] ?? [];
          const min = requiredMin(group);
          const max = allowedMax(group);
          const error = showErrors ? violationByGroup[group.id] : undefined;
          return (
            <fieldset key={group.id} className={cn("rounded-xl border p-3", error ? "border-amber-400" : "border-line")}>
              <legend className="px-1 text-sm font-bold text-ink">
                {group.name}{" "}
                <span className="text-xs font-semibold text-sub">
                  {min > 0 ? `Required${max && max > 1 ? ` - choose ${min}-${max}` : ""}` : isSingleSelect(group) ? "Choose one" : "Optional"}
                </span>
              </legend>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {options.map((option) => {
                  const on = selected.some((m) => m.option_id === option.id);
                  const delta = optionDelta(option);
                  return (
                    <button
                      key={option.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setSelected((cur) => toggleModifier(cur, option, group, delta))}
                      className={cn(
                        "flex min-h-[52px] items-center justify-between gap-2 rounded-xl border px-3 text-left text-sm font-semibold transition",
                        on ? "border-brand bg-brand-soft text-brand-dark" : "border-line bg-white text-ink hover:border-brand/40",
                      )}
                    >
                      <span className="truncate">{option.name}</span>
                      {delta !== 0 && <span className="shrink-0 text-xs">+{formatMoney(delta, props.currency)}</span>}
                    </button>
                  );
                })}
                {options.length === 0 && <p className="col-span-2 text-xs text-sub">No options are active in this group.</p>}
              </div>
              {error && <p className="mt-2 text-xs font-semibold text-amber-800">{error}</p>}
            </fieldset>
          );
        })}

        <div>
          <label className="mb-1 block text-sm font-bold text-ink" htmlFor="line-note">
            Kitchen note
          </label>
          <Textarea
            id="line-note"
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. no ice, cut in half"
          />
        </div>
      </div>
    </Modal>
  );
}
