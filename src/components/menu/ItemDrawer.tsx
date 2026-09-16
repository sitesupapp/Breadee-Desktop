// Create / edit one menu item.
//
// A RIGHT-EDGE DRAWER, NOT A FULL-SCREEN MODAL, so the list the operator was
// looking at stays on screen behind it - the same reason the POS cart is a
// drawer below its fixed-cart threshold.
//
// EVERY FIELD HERE IS A REAL COLUMN. There is no "SKU", no "tax class", no
// "kitchen printer" and no UUID on this form, because `menu_items` has none of
// those. The one non-column control is the modifier-group assignment, which
// writes `menu_item_modifier_groups`.
//
// The drawer does not save anything itself. It validates, then hands a plain
// description of the edit to its parent, which owns the single mutation path.

import { useMemo, useState } from "react";
import { Button, Card, GatedButton, Input, Textarea, cn } from "@/components/ui";
import { Switch } from "@/components/Switch";
import { Glyph } from "@/components/Glyph";
import { PriceField } from "@/components/menu/PriceField";
import { itemDraftErrors, isSaveable } from "@/lib/menu/validation";
import { validateImageFile } from "@/lib/menu/image";
import { ITEM_STATUSES, ITEM_STATUS_LABELS, type BuilderCategory, type BuilderGroup, type ItemDraft, type ItemStatus } from "@/lib/menu/types";
import { describeGroup } from "@/lib/menu/modifierGroupConfig";
import type { Gate } from "@/components/ui";
import type { CurrencyCode } from "@/lib/currency";

export type ItemDrawerSubmit = {
  draft: ItemDraft;
  price: { amount: number; currency: CurrencyCode } | null;
  groupIds: string[] | undefined;
  file: File | null;
  clearImage: boolean;
};

export function ItemDrawer({
  draft,
  categories,
  groups,
  showModifiers,
  primaryCurrency,
  priceCurrency,
  rate,
  saveGate,
  archiveGate,
  saving,
  onPriceCurrencyChange,
  onChange,
  onClose,
  onSubmit,
  onArchive,
}: {
  draft: ItemDraft;
  categories: BuilderCategory[];
  groups: BuilderGroup[];
  showModifiers: boolean;
  primaryCurrency: CurrencyCode;
  priceCurrency: CurrencyCode;
  rate: number | null;
  /** `menu.create` for a new item, `menu.edit` for an existing one. */
  saveGate: Gate;
  archiveGate: Gate;
  saving: boolean;
  onPriceCurrencyChange: (next: CurrencyCode) => void;
  onChange: (next: ItemDraft) => void;
  onClose: () => void;
  onSubmit: (submit: ItemDrawerSubmit) => void;
  onArchive: (() => void) | null;
}) {
  const [priceText, setPriceText] = useState(draft.price == null ? "" : String(draft.price));
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [clearImage, setClearImage] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);

  const priceAmount = priceText.trim() === "" ? null : Number(priceText);
  const errors = useMemo(
    () => itemDraftErrors({ name: draft.name, price: priceAmount }, priceCurrency, primaryCurrency, rate),
    [draft.name, priceAmount, priceCurrency, primaryCurrency, rate],
  );
  const assigned = draft._groups ?? [];
  const readOnly = !saveGate.allowed;
  const shownImage = clearImage ? null : (preview ?? draft.image_url ?? null);

  function submit() {
    if (!isSaveable(errors) || saving || readOnly) return;
    onSubmit({
      draft,
      price: priceAmount === null ? null : { amount: priceAmount, currency: priceCurrency },
      groupIds: showModifiers ? assigned : undefined,
      file,
      clearImage,
    });
  }

  // A save in flight makes the drawer non-dismissable. Dismissing it mid-request
  // would discard an edit whose outcome is still unknown, which is the one way an
  // operator could believe they had cancelled a change that then landed.
  const dismiss = () => {
    if (!saving) onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={draft.id ? "Edit item" : "Add item"}>
      <div className="absolute inset-0 bg-ink/40" onClick={dismiss} aria-hidden />
      <div className="relative flex h-full w-full max-w-lg flex-col border-l border-line bg-white shadow-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <p className="text-base font-extrabold text-ink">{draft.id ? "Edit item" : "Add item"}</p>
            <p className="mt-0.5 text-xs text-sub">
              {saving
                ? "Saving — waiting for the server to confirm…"
                : readOnly
                  ? (saveGate.reason ?? "Read only")
                  : "Saved to the menu your POS and web menu both use."}
            </p>
          </div>
          <button
            type="button"
            onClick={dismiss}
            disabled={saving}
            aria-label="Close"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-line text-sub hover:bg-slate-50 disabled:opacity-40"
          >
            <Glyph name="close" size={18} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
          <Section title="Basics">
            <Field label="Item name" error={errors.name}>
              <Input
                value={draft.name ?? ""}
                disabled={readOnly}
                placeholder="e.g. Espresso"
                onChange={(e) => onChange({ ...draft, name: e.target.value })}
                aria-invalid={errors.name ? true : undefined}
              />
            </Field>
            <Field label="Arabic name (optional)">
              <Input
                value={draft.name_ar ?? ""}
                disabled={readOnly}
                dir="rtl"
                onChange={(e) => onChange({ ...draft, name_ar: e.target.value })}
              />
            </Field>
            <Field label="Category">
              <select
                value={draft.category_id ?? ""}
                disabled={readOnly}
                onChange={(e) => onChange({ ...draft, category_id: e.target.value || null })}
                className="min-h-[44px] w-full rounded-xl border border-line bg-white px-3 text-sm text-ink outline-none focus:border-brand focus:ring-2 focus:ring-brand/20 disabled:bg-slate-50"
              >
                <option value="">No category</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Description (optional)">
              <Textarea
                rows={3}
                value={draft.description ?? ""}
                disabled={readOnly}
                onChange={(e) => onChange({ ...draft, description: e.target.value })}
              />
            </Field>
          </Section>

          <Section title="Pricing">
            <PriceField
              label="Selling price"
              amount={priceText}
              currency={priceCurrency}
              rate={rate}
              error={errors.price}
              disabled={readOnly}
              onAmountChange={setPriceText}
              onCurrencyChange={onPriceCurrencyChange}
            />
            <p className="text-[11px] text-sub">
              Leave empty for no price. The amount is stored with the currency you typed it in.
            </p>
          </Section>

          <Section title="Availability">
            <Field label="Status">
              <select
                value={draft.status ?? "draft"}
                disabled={readOnly}
                onChange={(e) => onChange({ ...draft, status: e.target.value as ItemStatus })}
                className="min-h-[44px] w-full rounded-xl border border-line bg-white px-3 text-sm text-ink outline-none focus:border-brand focus:ring-2 focus:ring-brand/20 disabled:bg-slate-50"
              >
                {ITEM_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {ITEM_STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </Field>
            <Switch
              checked={draft.is_available ?? true}
              disabled={readOnly}
              onChange={(v) => onChange({ ...draft, is_available: v })}
              label="Available now"
              hint="Turn off to take the item off the POS and the public menu without unpublishing it."
            />
          </Section>

          {showModifiers && (
            <Section title="Modifiers & extras">
              {groups.length === 0 ? (
                <p className="text-xs text-sub">No modifier groups yet. Create one in the Modifiers tab first.</p>
              ) : (
                <div className="space-y-1.5">
                  {groups.map((g) => (
                    <label
                      key={g.id}
                      className={cn(
                        "flex min-h-[44px] cursor-pointer items-center gap-3 rounded-xl border px-3",
                        assigned.includes(g.id) ? "border-brand bg-brand-soft" : "border-line bg-white hover:bg-slate-50",
                        readOnly && "cursor-not-allowed opacity-60",
                      )}
                    >
                      <input
                        type="checkbox"
                        className="h-4 w-4"
                        disabled={readOnly}
                        checked={assigned.includes(g.id)}
                        onChange={(e) =>
                          onChange({
                            ...draft,
                            _groups: e.target.checked ? [...assigned, g.id] : assigned.filter((x) => x !== g.id),
                          })
                        }
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold text-ink">{g.name}</span>
                        <span className="block text-[11px] text-sub">{describeGroup(g)}</span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </Section>
          )}

          <Section title="Details">
            <Field label="Ingredients (comma separated)">
              <Input
                value={(draft.ingredients ?? []).join(", ")}
                disabled={readOnly}
                placeholder="e.g. beef, cheddar, lettuce"
                onChange={(e) =>
                  onChange({
                    ...draft,
                    ingredients: e.target.value.split(",").map((x) => x.trim()).filter(Boolean),
                  })
                }
              />
            </Field>
            <Field label="Allergens (comma separated)">
              <Input
                value={(draft.allergens ?? []).join(", ")}
                disabled={readOnly}
                placeholder="e.g. gluten, dairy, nuts"
                onChange={(e) =>
                  onChange({
                    ...draft,
                    allergens: e.target.value.split(",").map((x) => x.trim()).filter(Boolean),
                  })
                }
              />
            </Field>
            <Field label="Photo" error={imageError}>
              {shownImage && (
                <img src={shownImage} alt={draft.image_alt_text ?? ""} className="mb-2 h-32 w-full rounded-xl border border-line object-cover" />
              )}
              <div className="flex flex-wrap items-center gap-2">
                <label
                  className={cn(
                    "inline-flex min-h-[44px] cursor-pointer items-center rounded-xl border border-line bg-white px-4 text-sm font-semibold text-ink hover:bg-slate-50",
                    readOnly && "pointer-events-none opacity-50",
                  )}
                >
                  {shownImage ? "Replace photo" : "Upload photo"}
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    className="hidden"
                    disabled={readOnly}
                    onChange={(e) => {
                      const chosen = e.target.files?.[0] ?? null;
                      if (!chosen) return;
                      const invalid = validateImageFile(chosen);
                      if (invalid) {
                        setImageError(invalid);
                        return;
                      }
                      setImageError(null);
                      setClearImage(false);
                      setFile(chosen);
                      setPreview(URL.createObjectURL(chosen));
                    }}
                  />
                </label>
                {shownImage && (
                  <Button
                    variant="ghost"
                    disabled={readOnly}
                    onClick={() => {
                      setFile(null);
                      setPreview(null);
                      setImageError(null);
                      setClearImage(true);
                    }}
                  >
                    Remove photo
                  </Button>
                )}
              </div>
              <p className="mt-1 text-[11px] text-sub">
                Resized and compressed on this terminal before upload, so the public menu stays fast.
              </p>
            </Field>
            <Field label="Photo description (optional)">
              <Input
                value={draft.image_alt_text ?? ""}
                disabled={readOnly}
                onChange={(e) => onChange({ ...draft, image_alt_text: e.target.value || null })}
              />
            </Field>
          </Section>
        </div>

        <div className="flex items-center gap-2 border-t border-line bg-slate-50/70 px-5 py-3">
          <GatedButton gate={saveGate} className="flex-1" disabled={!isSaveable(errors) || saving} onClick={submit}>
            {saving ? "Saving…" : "Save item"}
          </GatedButton>
          <Button variant="ghost" disabled={saving} onClick={dismiss}>
            Cancel
          </Button>
          {onArchive && (
            <GatedButton gate={archiveGate} variant="danger" disabled={saving} onClick={onArchive}>
              Archive
            </GatedButton>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="p-4">
      <p className="mb-3 text-xs font-bold uppercase tracking-wide text-sub">{title}</p>
      <div className="space-y-3">{children}</div>
    </Card>
  );
}

function Field({ label, error, children }: { label: string; error?: string | null; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-bold uppercase tracking-wide text-sub">{label}</label>
      {children}
      {error && <p className="mt-1 text-[11px] font-semibold text-red-700">{error}</p>}
    </div>
  );
}
