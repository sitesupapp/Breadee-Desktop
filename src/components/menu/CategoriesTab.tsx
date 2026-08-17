// Category management.
//
// INLINE EDITING, NOT A MODAL. A category has two editable fields - a name and
// an Arabic name - and putting two inputs behind a dialog is the kind of
// ceremony that makes an operator batch their corrections instead of making
// them. The row becomes the form; Save and Cancel replace the row's actions.
//
// ARCHIVE, NEVER DELETE. `menu_categories` has no delete path in this product:
// the web app sets `status = 'archived'` plus `archived_at`, items keep their
// `category_id`, and the POS and public menu filter archived categories out.
// Archiving is confirmed inline for the same reason a POS void is - it is the
// one action here that removes something from a live menu.

import { useState } from "react";
import { Badge, Button, EmptyState, GatedButton, Input, cn } from "@/components/ui";
import { Glyph } from "@/components/Glyph";
import { CATEGORY_STATUS_LABELS, type BuilderCategory, type CategoryDraft } from "@/lib/menu/types";
import { categoryNameError } from "@/lib/menu/validation";
import { NO_CATEGORY } from "@/lib/menu/filters";
import type { Gate } from "@/components/ui";

export function CategoriesTab({
  categories,
  counts,
  gate,
  busyId,
  onSave,
  onMove,
  onToggle,
  onArchive,
}: {
  /** Already in display order. */
  categories: BuilderCategory[];
  counts: Record<string, number>;
  gate: Gate;
  /** The category whose mutation is in flight, if any. */
  busyId: string | null;
  onSave: (draft: CategoryDraft) => void;
  onMove: (index: number, direction: -1 | 1) => void;
  onToggle: (category: BuilderCategory) => void;
  onArchive: (category: BuilderCategory) => void;
}) {
  const [draft, setDraft] = useState<CategoryDraft | null>(null);
  const [confirmArchive, setConfirmArchive] = useState<string | null>(null);
  const nameError = draft ? categoryNameError(draft.name) : null;

  const startAdd = () => setDraft({ name: "", name_ar: "" });
  const uncategorized = counts[NO_CATEGORY] ?? 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <p className="text-xs text-sub">
          Categories are shared by every branch and every channel — POS, public menu and E-Menu.
        </p>
        <GatedButton gate={gate} onClick={startAdd} disabled={!!draft}>
          + Add category
        </GatedButton>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {draft && !draft.id && (
          <CategoryForm
            draft={draft}
            error={nameError}
            saving={busyId === "new"}
            onChange={setDraft}
            onCancel={() => setDraft(null)}
            onSave={() => {
              if (nameError) return;
              onSave(draft);
              setDraft(null);
            }}
          />
        )}

        {categories.length === 0 && !draft ? (
          <EmptyState icon="≣" title="No categories yet" hint="Group your items so the POS and public menu stay readable." />
        ) : (
          <ul className="divide-y divide-line">
            {categories.map((category, index) => {
              const editing = draft?.id === category.id;
              const busy = busyId === category.id;
              if (editing) {
                return (
                  <li key={category.id}>
                    <CategoryForm
                      draft={draft}
                      error={nameError}
                      saving={busy}
                      onChange={setDraft}
                      onCancel={() => setDraft(null)}
                      onSave={() => {
                        if (nameError) return;
                        onSave(draft);
                        setDraft(null);
                      }}
                    />
                  </li>
                );
              }
              return (
                <li key={category.id} className={cn("flex items-center gap-3 px-4 py-2.5", busy && "opacity-60")}>
                  <span className="flex flex-col">
                    <button
                      type="button"
                      aria-label={`Move ${category.name} up`}
                      disabled={index === 0 || !gate.allowed || busy}
                      title={gate.reason ?? undefined}
                      onClick={() => onMove(index, -1)}
                      className="text-sub disabled:opacity-30"
                    >
                      <Glyph name="chevron-down" size={14} className="rotate-180" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${category.name} down`}
                      disabled={index === categories.length - 1 || !gate.allowed || busy}
                      title={gate.reason ?? undefined}
                      onClick={() => onMove(index, 1)}
                      className="text-sub disabled:opacity-30"
                    >
                      <Glyph name="chevron-down" size={14} />
                    </button>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-bold text-ink">
                      {category.name}
                      {category.name_ar && <span className="ml-2 text-xs font-medium text-sub" dir="rtl">{category.name_ar}</span>}
                    </span>
                    <span className="block text-xs text-sub">
                      {counts[category.id] ?? 0} item{(counts[category.id] ?? 0) === 1 ? "" : "s"}
                    </span>
                  </span>
                  <Badge tone={category.status === "active" ? "green" : "amber"}>
                    {CATEGORY_STATUS_LABELS[category.status] ?? category.status}
                  </Badge>
                  {confirmArchive === category.id ? (
                    <span className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-red-700">Archive this category?</span>
                      <Button
                        variant="danger"
                        size="sm"
                        disabled={busy}
                        onClick={() => {
                          setConfirmArchive(null);
                          onArchive(category);
                        }}
                      >
                        Archive
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setConfirmArchive(null)}>
                        Keep
                      </Button>
                    </span>
                  ) : (
                    <span className="flex items-center gap-1.5">
                      <GatedButton gate={gate} variant="ghost" size="sm" disabled={busy} onClick={() => onToggle(category)}>
                        {category.status === "active" ? "Hide" : "Show"}
                      </GatedButton>
                      <GatedButton gate={gate} variant="ghost" size="sm" disabled={busy} onClick={() => setDraft(category)}>
                        Edit
                      </GatedButton>
                      <GatedButton
                        gate={gate}
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        className="text-red-700"
                        onClick={() => setConfirmArchive(category.id)}
                      >
                        Archive
                      </GatedButton>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {uncategorized > 0 && (
          <p className="border-t border-line px-4 py-3 text-xs text-sub">
            {uncategorized} item{uncategorized === 1 ? " has" : "s have"} no category. They stay orderable, but the public
            menu groups items by category.
          </p>
        )}
      </div>
    </div>
  );
}

function CategoryForm({
  draft,
  error,
  saving,
  onChange,
  onCancel,
  onSave,
}: {
  draft: CategoryDraft;
  error: string | null;
  saving: boolean;
  onChange: (next: CategoryDraft) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <div className="border-b border-line bg-slate-50/70 px-4 py-3">
      <div className="flex flex-wrap items-start gap-2">
        <span className="min-w-[180px] flex-1">
          <Input
            autoFocus
            value={draft.name ?? ""}
            placeholder="Category name"
            onChange={(e) => onChange({ ...draft, name: e.target.value })}
            aria-invalid={error ? true : undefined}
            aria-label="Category name"
          />
        </span>
        <span className="min-w-[180px] flex-1">
          <Input
            dir="rtl"
            value={draft.name_ar ?? ""}
            placeholder="Arabic name (optional)"
            onChange={(e) => onChange({ ...draft, name_ar: e.target.value })}
            aria-label="Arabic category name"
          />
        </span>
        <Button disabled={!!error || saving} onClick={onSave}>
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button variant="ghost" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {error && <p className="mt-1 text-[11px] font-semibold text-red-700">{error}</p>}
    </div>
  );
}
