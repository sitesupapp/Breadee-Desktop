// Manage floor SECTIONS (Phase 3B) — add, rename, and safely delete. All of it
// is draft-only; the Service Floor keeps its published sections until a future
// Publish. Deleting is refused with a plain explanation while a section still
// holds tables or structures — nothing is ever orphaned or silently removed.

import { useEffect, useState } from "react";
import { Modal } from "@/components/overlays";
import { Button, cn } from "@/components/ui";
import { Glyph } from "@/components/Glyph";
import { SECTION_NAME_MAX } from "@/lib/pos/floorDesigner";
import type { FloorSection } from "@/lib/pos/floor";
import type { OpResult } from "@/state/floorDesigner";

export function SectionsDialog({
  open,
  sections,
  elementCount,
  onCancel,
  onAdd,
  onRename,
  onDelete,
}: {
  open: boolean;
  sections: FloorSection[];
  /** How many elements each section currently holds (for the delete guard copy). */
  elementCount: (sectionId: string) => number;
  onCancel: () => void;
  onAdd: (name: string) => OpResult;
  onRename: (sectionId: string, name: string) => OpResult;
  onDelete: (sectionId: string) => OpResult;
}) {
  const [names, setNames] = useState<Record<string, string>>({});
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setNames(Object.fromEntries(sections.map((s) => [s.id, s.name])));
      setNewName("");
      setError(null);
    }
    // Re-seed when the section list itself changes (an add/delete landed).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sections.map((s) => s.id).join("|")]);

  const commitRename = (id: string) => {
    const current = sections.find((s) => s.id === id);
    const next = (names[id] ?? "").trim();
    if (!current || next === current.name) return;
    const r = onRename(id, next);
    setError(r.ok ? null : r.reason);
    if (!r.ok) setNames((m) => ({ ...m, [id]: current.name }));
  };

  const add = () => {
    const r = onAdd(newName);
    setError(r.ok ? null : r.reason);
    if (r.ok) setNewName("");
  };

  return (
    <Modal
      open={open}
      title="Floor sections"
      subtitle="Changes apply to the draft and reach staff when the floor is published."
      size="sm"
      onClose={onCancel}
      footer={
        <div className="flex items-center justify-end">
          <Button size="lg" onClick={onCancel}>
            Done
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-2">
        {sections.map((s) => {
          const count = elementCount(s.id);
          const deletable = count === 0 && sections.length > 1;
          return (
            <div key={s.id} className="flex items-center gap-2">
              <input
                value={names[s.id] ?? s.name}
                maxLength={SECTION_NAME_MAX}
                aria-label={`Rename ${s.name}`}
                onChange={(e) => setNames((m) => ({ ...m, [s.id]: e.target.value }))}
                onBlur={() => commitRename(s.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                }}
                className="min-w-0 flex-1 rounded-lg border border-line bg-white px-3 py-2 text-sm font-bold text-ink outline-none focus:ring-2 focus:ring-brand/40"
              />
              <span className="w-16 shrink-0 text-end text-xs font-semibold text-sub">
                {count === 0 ? "empty" : `${count} item${count === 1 ? "" : "s"}`}
              </span>
              <button
                type="button"
                aria-label={`Delete ${s.name}`}
                title={
                  deletable
                    ? "Delete this empty section"
                    : sections.length <= 1
                      ? "A floor needs at least one section"
                      : "Move or remove its items first"
                }
                onClick={() => {
                  const r = onDelete(s.id);
                  setError(r.ok ? null : r.reason);
                }}
                className={cn(
                  // 44px touch target (Phase-3B follow-up #3).
                  "grid h-11 w-11 shrink-0 place-items-center rounded-lg border",
                  deletable
                    ? "border-rose-200 bg-white text-rose-700 hover:bg-rose-50"
                    : "cursor-not-allowed border-line bg-white text-sub opacity-50",
                )}
              >
                <Glyph name="trash" size={14} />
              </button>
            </div>
          );
        })}

        <div className="mt-1 flex items-center gap-2 border-t border-line pt-3">
          <input
            value={newName}
            maxLength={SECTION_NAME_MAX}
            placeholder="New section name (e.g. VIP, Outdoor)"
            aria-label="New section name"
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") add();
            }}
            className="min-w-0 flex-1 rounded-lg border border-line bg-white px-3 py-2 text-sm font-bold text-ink outline-none focus:ring-2 focus:ring-brand/40"
          />
          <Button size="lg" onClick={add}>
            Add
          </Button>
        </div>

        {error && <p className="text-sm font-semibold text-rose-600">{error}</p>}
      </div>
    </Modal>
  );
}
