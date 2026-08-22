// Modifier chooser.
//
// The selection semantics are the ported, shared ones (m241 mirror): single-select
// replaces, multi-select appends, and validation - not click-trapping - reports
// what is still missing. That means the cashier always sees WHY the line cannot
// be added yet, instead of a dead button.

import { useMemo, useState } from "react";
import { Modal } from "@/components/overlays";
import { Button, Textarea, cn } from "@/components/ui";
import { formatMoney, type CurrencyCode } from "@/lib/currency";
import { resolveMenuPrice } from "@/lib/pos/menuPrice";
import { allowedMax, isSingleSelect, lineTotals, modifierViolations, requiredMin, toggleModifier } from "@/lib/pos/modifiers";
import type { MenuItem, ModifierGroup, ModifierOption, SelectedModifier } from "@/types/pos";

export type ModifierDialogProps = {
  open: boolean;
  item: MenuItem | null;
  basePrice: number;
  groups: ModifierGroup[];
  optionsByGroup: Record<string, ModifierOption[]>;
  currency: CurrencyCode;
  rate: number | null;
  onCancel: () => void;
  onConfirm: (input: { modifiers: SelectedModifier[]; quantity: number; note: string | null }) => void;
};

export function ModifierDialog(props: ModifierDialogProps) {
  const [selected, setSelected] = useState<SelectedModifier[]>([]);
  const [quantity, setQuantity] = useState(1);
  const [note, setNote] = useState("");
  const [showErrors, setShowErrors] = useState(false);

  // Reset whenever a different item opens the dialog.
  const itemId = props.item?.id ?? null;
  const [lastItemId, setLastItemId] = useState<string | null>(null);
  if (itemId !== lastItemId) {
    setLastItemId(itemId);
    setSelected([]);
    setQuantity(1);
    setNote("");
    setShowErrors(false);
  }

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
    props.onConfirm({ modifiers: selected, quantity, note: note.trim() ? note.trim() : null });
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
              onClick={() => setQuantity((q) => Math.max(1, q - 1))}
              className="flex h-12 w-12 items-center justify-center rounded-xl border border-line bg-white text-xl font-bold"
            >
              -
            </button>
            <span className="w-10 text-center text-lg font-extrabold tabular-nums">{quantity}</span>
            <button
              type="button"
              aria-label="Increase quantity"
              onClick={() => setQuantity((q) => q + 1)}
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
        {props.groups.length === 0 && <p className="text-sm text-sub">This item has no options.</p>}

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
