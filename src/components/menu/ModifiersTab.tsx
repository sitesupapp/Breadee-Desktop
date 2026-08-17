// Modifier groups and their options.
//
// THE CONFIGURATION IS CANONICAL BEFORE IT IS SENT. A single-choice group can
// only ever admit exactly one option, so min/max are DERIVED and shown
// read-only; multiple-choice keeps full editing with inline validation. That is
// not a desktop nicety - `modifier_groups_canonical_selection_chk` refuses
// anything else, and `lib/menu/modifierGroupConfig.ts` is the one place either
// client encodes the rule.
//
// OPTION PRICES GO THROUGH THE RPC. An option row is created with the NOT NULL
// placeholder `extra_price = 0` and the real amount is written by
// `set_modifier_option_price`, which normalises it against the tenant's rate.
// Nothing in this file writes `extra_price` directly.

import { useState } from "react";
import { Badge, Button, Card, EmptyState, GatedButton, Input, cn } from "@/components/ui";
import { Switch } from "@/components/Switch";
import { PriceField } from "@/components/menu/PriceField";
import { canonSelectionType, canonicalizeGroup, describeGroup, groupConfigError } from "@/lib/menu/modifierGroupConfig";
import { optionErrors, isSaveable } from "@/lib/menu/validation";
import { optionsForGroup } from "@/lib/menu/filters";
import { resolveMenuPrice } from "@/lib/pos/menuPrice";
import { formatMoney, type CurrencyCode } from "@/lib/currency";
import type { BuilderGroup, BuilderOption, GroupDraft } from "@/lib/menu/types";
import type { Gate } from "@/components/ui";

export function ModifiersTab({
  groups,
  options,
  gate,
  currency,
  rate,
  busyId,
  onSaveGroup,
  onArchiveGroup,
  onAddOption,
  onArchiveOption,
}: {
  groups: BuilderGroup[];
  options: BuilderOption[];
  gate: Gate;
  currency: CurrencyCode;
  rate: number | null;
  busyId: string | null;
  onSaveGroup: (draft: GroupDraft) => void;
  onArchiveGroup: (group: BuilderGroup) => void;
  onAddOption: (group: BuilderGroup, name: string, extra: number, entered: CurrencyCode) => void;
  onArchiveOption: (option: BuilderOption) => void;
}) {
  const [draft, setDraft] = useState<GroupDraft | null>(null);
  const [confirmArchive, setConfirmArchive] = useState<string | null>(null);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <p className="text-xs text-sub">
          Groups are shared by every item you attach them to. The POS enforces the same minimum and maximum at checkout.
        </p>
        <GatedButton
          gate={gate}
          disabled={!!draft}
          onClick={() => setDraft({ name: "", selection_type: "single", is_required: false, min_select: 0, max_select: 1 })}
        >
          + Add group
        </GatedButton>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {draft && !draft.id && (
          <GroupForm draft={draft} saving={busyId === "new"} onChange={setDraft} onCancel={() => setDraft(null)} onSave={() => { onSaveGroup(draft); setDraft(null); }} />
        )}

        {groups.length === 0 && !draft && (
          <EmptyState
            icon="≡"
            title="No modifier groups yet"
            hint="Add a group like Size or Extras, then attach it to the items that offer it."
          />
        )}

        {groups.map((group) => {
          const busy = busyId === group.id;
          if (draft?.id === group.id) {
            return (
              <GroupForm
                key={group.id}
                draft={draft}
                saving={busy}
                onChange={setDraft}
                onCancel={() => setDraft(null)}
                onSave={() => {
                  onSaveGroup(draft);
                  setDraft(null);
                }}
              />
            );
          }
          const groupOptions = optionsForGroup(options, group.id);
          return (
            <Card key={group.id} className={cn("p-4", busy && "opacity-60")}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-ink">{group.name}</p>
                  <p className="text-xs text-sub">{describeGroup(group)}</p>
                </div>
                {confirmArchive === group.id ? (
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-red-700">Archive this group?</span>
                    <Button
                      variant="danger"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        setConfirmArchive(null);
                        onArchiveGroup(group);
                      }}
                    >
                      Archive
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setConfirmArchive(null)}>
                      Keep
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5">
                    <GatedButton gate={gate} variant="ghost" size="sm" disabled={busy} onClick={() => setDraft(group)}>
                      Edit
                    </GatedButton>
                    <GatedButton
                      gate={gate}
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      className="text-red-700"
                      onClick={() => setConfirmArchive(group.id)}
                    >
                      Archive
                    </GatedButton>
                  </div>
                )}
              </div>

              <div className="mt-3 flex flex-wrap gap-1.5">
                {groupOptions.map((option) => {
                  const price = resolveMenuPrice(option, option.extra_price, currency, rate);
                  return (
                    <span
                      key={option.id}
                      className="flex items-center gap-1.5 rounded-full border border-line bg-slate-50 px-3 py-1.5 text-xs font-semibold text-ink"
                    >
                      {option.name}
                      {price.amount != null && price.amount > 0 && (
                        <span className="text-sub">+{formatMoney(price.amount, currency)}</span>
                      )}
                      {gate.allowed && (
                        <button
                          type="button"
                          aria-label={`Archive ${option.name}`}
                          disabled={busy}
                          onClick={() => onArchiveOption(option)}
                          className="text-sub hover:text-red-700 disabled:opacity-40"
                        >
                          ×
                        </button>
                      )}
                    </span>
                  );
                })}
                {groupOptions.length === 0 && <span className="text-xs text-sub">No options yet.</span>}
              </div>

              {gate.allowed && (
                <OptionAdder
                  key={currency}
                  currency={currency}
                  rate={rate}
                  busy={busy}
                  onAdd={(name, extra, entered) => onAddOption(group, name, extra, entered)}
                />
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function GroupForm({
  draft,
  saving,
  onChange,
  onCancel,
  onSave,
}: {
  draft: GroupDraft;
  saving: boolean;
  onChange: (next: GroupDraft) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const single = canonSelectionType(draft.selection_type) === "single";
  const configError = groupConfigError(draft);
  const nameError = (draft.name ?? "").trim() === "" ? "A group name is required." : null;
  return (
    <Card className="border-brand p-4">
      <p className="mb-3 text-xs font-bold uppercase tracking-wide text-sub">{draft.id ? "Edit group" : "New group"}</p>
      <div className="space-y-3">
        <Input
          autoFocus
          value={draft.name ?? ""}
          placeholder="Group name (e.g. Size)"
          aria-label="Group name"
          onChange={(e) => onChange({ ...draft, name: e.target.value })}
        />
        <div className="flex flex-wrap items-center gap-2">
          {(["single", "multi"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={single === (mode === "single")}
              onClick={() => onChange(canonicalizeGroup({ ...draft, selection_type: mode }))}
              className={cn(
                "min-h-[44px] rounded-xl border px-4 text-sm font-semibold",
                single === (mode === "single") ? "border-brand bg-brand-soft text-brand-dark" : "border-line bg-white text-sub",
              )}
            >
              {mode === "single" ? "Choose one" : "Choose several"}
            </button>
          ))}
        </div>
        <Switch
          checked={!!draft.is_required}
          onChange={(v) => onChange(canonicalizeGroup({ ...draft, is_required: v }))}
          label="Required"
          hint="The cashier must answer this group before the item can be added."
        />
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-sub">Minimum</span>
            <Input
              type="number"
              min={0}
              value={String(draft.min_select ?? 0)}
              disabled={single}
              onChange={(e) => onChange({ ...draft, min_select: Number(e.target.value) })}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-sub">Maximum</span>
            <Input
              type="number"
              min={1}
              value={String(draft.max_select ?? 1)}
              disabled={single}
              onChange={(e) => onChange({ ...draft, max_select: Number(e.target.value) })}
            />
          </label>
        </div>
        {single ? (
          <p className="text-[11px] text-sub">
            Choose one always allows exactly one option{draft.is_required ? " and requires it" : " (optional)"} — the
            minimum and maximum are set for you.
          </p>
        ) : configError ? (
          <p className="text-[11px] font-semibold text-red-700">{configError}</p>
        ) : null}
        {nameError && <p className="text-[11px] font-semibold text-red-700">{nameError}</p>}
      </div>
      <div className="mt-4 flex gap-2">
        <Button disabled={!!configError || !!nameError || saving} onClick={onSave}>
          {saving ? "Saving…" : "Save group"}
        </Button>
        <Button variant="ghost" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

function OptionAdder({
  currency,
  rate,
  busy,
  onAdd,
}: {
  currency: CurrencyCode;
  rate: number | null;
  busy: boolean;
  onAdd: (name: string, extra: number, entered: CurrencyCode) => void;
}) {
  const [name, setName] = useState("");
  const [extra, setExtra] = useState("0");
  const [entered, setEntered] = useState<CurrencyCode>(currency);
  const amount = extra.trim() === "" ? 0 : Number(extra);
  const errors = optionErrors(name, amount, entered, currency, rate);
  const canAdd = isSaveable(errors) && !busy;

  return (
    <div className="mt-3 border-t border-line pt-3">
      <div className="flex flex-wrap items-end gap-2">
        <span className="min-w-[160px] flex-1">
          <label className="mb-1 block text-xs font-bold uppercase tracking-wide text-sub">Add option</label>
          <Input value={name} placeholder="e.g. Large" aria-label="Option name" onChange={(e) => setName(e.target.value)} />
        </span>
        <span className="min-w-[200px]">
          <PriceField
            label="Extra"
            amount={extra}
            currency={entered}
            rate={rate}
            error={errors.extra}
            onAmountChange={setExtra}
            onCurrencyChange={setEntered}
          />
        </span>
        <Button
          disabled={!canAdd}
          onClick={() => {
            if (!canAdd) return;
            onAdd(name.trim(), amount, entered);
            setName("");
            setExtra("0");
          }}
        >
          Add
        </Button>
      </div>
      {errors.name && name !== "" && <p className="mt-1 text-[11px] font-semibold text-red-700">{errors.name}</p>}
      <Badge tone="slate" className="mt-2">
        Options are archived, never deleted
      </Badge>
    </div>
  );
}
