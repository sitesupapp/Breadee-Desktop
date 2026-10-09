// Desktop 1.0.35 (R2) — Add Items to an open, unpaid DELIVERY order.
//
// This REUSES the canonical POS menu + modifier components — MenuItemGrid for item selection, the shared
// search (withSearchIndex/filterItems), and ModifierDialog for option selection — so there is no parallel
// menu or pricing engine. It builds only a list of item IDENTITIES + quantities + chosen option ids and
// hands them to the caller; the SERVER resolves every price via pos_add_order_items. No client price is ever
// treated as authoritative, and nothing here mutates the order — the caller runs the idempotent addOrderItems
// path and re-reads the authoritative order on success.

import { useMemo, useState } from "react";
import { Modal } from "@/components/overlays";
import { Button } from "@/components/ui";
import { Input } from "@/components/ui";
import { MenuItemGrid } from "@/components/pos/MenuItemGrid";
import { ModifierDialog } from "@/components/pos/ModifierDialog";
import { withSearchIndex, filterItems, type SearchableItem } from "@/lib/pos/menu";
import { groupsForItem } from "@/lib/pos/modifiers";
import type { RoundMenu } from "@/lib/pos/tableRounds";
import type { ModifierOption } from "@/types/pos";
import type { ItemOptionsResult } from "@/lib/pos/itemOptions";
import type { AddItemInput } from "@/lib/pos/orders";
import { addDraftSimple, addDraftFromOptions, type AddDraftItem } from "@/lib/pos/deliveryItemEdit";
import { type CurrencyCode } from "@/lib/currency";

export type DeliveryAddItemsPickerProps = {
  open: boolean;
  menu: RoundMenu;
  currency: CurrencyCode;
  rate: number | null;
  /** Locked while the add is committing, so the picker cannot double-submit. */
  busy: boolean;
  onClose: () => void;
  /** The canonical add: item identities + quantities + option ids ONLY (no prices). */
  onConfirm: (items: AddItemInput[]) => void;
};

export function DeliveryAddItemsPicker(props: DeliveryAddItemsPickerProps) {
  const { menu } = props;
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<AddDraftItem[]>([]);
  const [optionItem, setOptionItem] = useState<SearchableItem | null>(null);

  const searchable = useMemo(() => withSearchIndex(menu.items), [menu.items]);
  const visible = useMemo(() => filterItems(searchable, null, query), [searchable, query]);

  // An item "needs a choice" when it has any modifier group attached — MenuItemGrid flags it and onPick
  // opens the shared chooser so required groups are satisfied (the server + the kitchen trigger re-enforce).
  const itemsNeedingChoice = useMemo(() => {
    const s = new Set<string>();
    for (const it of menu.items) {
      if (groupsForItem(it.id, menu.groupsByItem, menu.groups).length > 0) s.add(it.id);
    }
    return s;
  }, [menu.items, menu.groupsByItem, menu.groups]);

  const optionGroups = useMemo(
    () => (optionItem ? groupsForItem(optionItem.id, menu.groupsByItem, menu.groups) : []),
    [optionItem, menu.groupsByItem, menu.groups],
  );
  const optionsByGroup = useMemo(() => {
    const map: Record<string, ModifierOption[]> = {};
    for (const o of menu.options) (map[o.modifier_group_id] ??= []).push(o);
    return map;
  }, [menu.options]);

  const onPick = (item: SearchableItem) => {
    if (itemsNeedingChoice.has(item.id)) setOptionItem(item);
    else setDraft((prev) => addDraftSimple(prev, { id: item.id, name: item.name }, `${item.id}:${prev.length}:${Date.now()}`));
  };

  const onOptionsConfirm = (result: ItemOptionsResult) => {
    const item = optionItem;
    if (!item) return;
    setOptionItem(null);
    setDraft((prev) => addDraftFromOptions(prev, { id: item.id, name: item.name }, result, `${item.id}:${prev.length}:${Date.now()}`));
  };

  const removeDraft = (key: string) => setDraft((prev) => prev.filter((d) => d.key !== key));
  const totalLines = draft.reduce((n, d) => n + d.input.quantity, 0);

  const confirm = () => {
    if (props.busy || draft.length === 0) return;
    props.onConfirm(draft.map((d) => d.input));
    setDraft([]);
    setQuery("");
  };

  const close = () => {
    if (props.busy) return;
    setDraft([]);
    setQuery("");
    setOptionItem(null);
    props.onClose();
  };

  return (
    <Modal open={props.open} onClose={close} title="Add items to this delivery order">
      <div className="flex min-h-0 flex-col gap-3">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search the menu"
          aria-label="Search the menu"
        />
        <div className="max-h-[42vh] min-h-0 overflow-y-auto">
          {visible.length === 0 ? (
            <p className="px-2 py-6 text-center text-[11px] text-sub">No items match.</p>
          ) : (
            <MenuItemGrid
              items={visible}
              columns={3}
              currency={props.currency}
              rate={props.rate}
              itemsNeedingChoice={itemsNeedingChoice}
              onPick={(item) => onPick(item)}
            />
          )}
        </div>

        {draft.length > 0 && (
          <div className="rounded-xl border border-line bg-slate-50 p-2">
            <p className="mb-1 text-[11px] font-bold text-ink">To add ({totalLines})</p>
            <ul className="space-y-1">
              {draft.map((d) => (
                <li key={d.key} className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="min-w-0 truncate text-ink">
                    {d.input.quantity} x {d.displayName}
                    {d.input.modifiers?.length ? ` (+${d.input.modifiers.length})` : ""}
                  </span>
                  <Button variant="ghost" size="sm" disabled={props.busy} onClick={() => removeDraft(d.key)}>
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex items-center justify-between gap-2">
          <Button variant="ghost" size="md" disabled={props.busy} onClick={close}>
            Cancel
          </Button>
          <Button size="md" disabled={props.busy || draft.length === 0} onClick={confirm}>
            {props.busy ? "Adding..." : `Add ${totalLines || ""} to order`}
          </Button>
        </div>
      </div>

      {/* The SAME shared chooser used for creating and editing lines; the chosen options carry identities
          only, and the server prices them. */}
      <ModifierDialog
        open={optionItem !== null}
        item={optionItem}
        basePrice={Number(optionItem?.price ?? 0)}
        groups={optionGroups}
        optionsByGroup={optionsByGroup}
        currency={props.currency}
        rate={props.rate}
        ingredientCustomization={false}
        seedKey={optionItem ? `deliv-add:${optionItem.id}` : null}
        initialModifiers={[]}
        initialQuantity={1}
        confirmLabel="Add to order"
        onCancel={() => setOptionItem(null)}
        onConfirm={onOptionsConfirm}
      />
    </Modal>
  );
}
