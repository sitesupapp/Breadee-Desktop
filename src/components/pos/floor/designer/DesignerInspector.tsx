// The Designer INSPECTOR (Phase 3B) — properties of the selected floor object,
// in restaurant language. The canvas stays dominant; this panel opens only for a
// selection and never shows developer surfaces (no coordinates, no JSON, no
// database identifiers).
//
// Everything here mutates the DRAFT through the store's single edits→autosave
// path. A table's NAME edit is a STAGED rename of an existing table (or the name
// of a staged new table) — the canonical POS name changes only at a future
// Publish, and the helper copy says so. Seats are read-only for existing tables
// (the current publish contract has no seats update for them) and editable for
// staged new tables, whose creation carries seats.

import { useEffect, useState } from "react";
import { cn } from "@/components/ui";
import { Glyph } from "@/components/Glyph";
import { shapeLabel } from "@/lib/pos/floorStatus";
import type { FloorTableShape } from "@/lib/pos/floor";
import {
  SEATS_MAX,
  SEATS_MIN,
  TABLE_NAME_MAX,
  type DesignerElement,
  type TableMeta,
} from "@/lib/pos/floorDesigner";
import type { OpResult } from "@/state/floorDesigner";

const SHAPES: FloorTableShape[] = ["sq", "round", "r4", "r6", "rect", "rect6", "rect8", "oval", "high", "bar", "lounge"];

/** A friendly heading for a structural element. */
function structureTitle(type: string): string {
  const names: Record<string, string> = {
    wall: "Wall", divider: "Divider", door: "Door", window: "Window", counter: "Counter",
    kitchen: "Kitchen", host: "Host stand", entrance: "Entrance", stairs: "Stairs",
    wc: "WC", text: "Text label", plant: "Plant",
  };
  return names[type] ?? "Object";
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 py-1.5">
      <span className="text-xs font-bold uppercase tracking-wide text-sub">{label}</span>
      <div className="flex items-center gap-1.5">{children}</div>
    </div>
  );
}

function Stepper({
  value,
  onChange,
  step,
  unit,
  decrementLabel,
  incrementLabel,
  disabled,
}: {
  value: number;
  onChange: (next: number) => void;
  step: number;
  unit?: string;
  decrementLabel: string;
  incrementLabel: string;
  disabled?: boolean;
}) {
  // 44px hit targets (the approved touch floor) — visually compact, physically
  // generous. Phase-3B follow-up #3.
  const btn =
    "grid h-11 w-11 place-items-center rounded-lg border border-line bg-white text-ink hover:bg-canvas disabled:opacity-40";
  return (
    <div className="flex items-center gap-1">
      <button type="button" className={btn} aria-label={decrementLabel} disabled={disabled} onClick={() => onChange(value - step)}>
        −
      </button>
      <span className="min-w-[52px] text-center text-sm font-bold tabular-nums text-ink">
        {Math.round(value)}
        {unit ?? ""}
      </span>
      <button type="button" className={btn} aria-label={incrementLabel} disabled={disabled} onClick={() => onChange(value + step)}>
        +
      </button>
    </div>
  );
}

export function DesignerInspector({
  element,
  meta,
  sectionName,
  readOnly,
  onRename,
  onDiscardRename,
  onSeats,
  onShape,
  onSize,
  onRotate,
  onDuplicate,
  onRemove,
}: {
  element: DesignerElement;
  /** Canonical identity for an existing table (read-only), or null. */
  meta: TableMeta | null;
  sectionName: string | null;
  readOnly: boolean;
  onRename: (name: string) => OpResult;
  /** Clear a staged rename without needing the canonical name (legacy safety). */
  onDiscardRename: () => void;
  /** Staged NEW tables only — existing-table seats are read-only by contract. */
  onSeats: (seats: number) => void;
  onShape: (shape: FloorTableShape) => void;
  onSize: (w: number, h: number) => void;
  onRotate: (rotation: number) => void;
  /** Phase 3D-A — copy this table into a NEW staged table nearby (draft-only). */
  onDuplicate: () => void;
  onRemove: () => void;
}) {
  const isTable = element.type === "table";
  const isNew = isTable && element.tempId !== null;
  // A LEGACY placement: an existing table whose canonical name is unavailable
  // (hidden from the metadata read). Renaming it is refused — typing the
  // canonical name back would be impossible, so a staged rename could never be
  // undone by name. Identity is shown honestly instead (Phase-3B follow-up #1).
  const isLegacy = isTable && !isNew && meta === null;
  const shownName = isNew ? element.newName ?? "" : element.renameTo ?? meta?.name ?? element.label ?? "";

  const [nameInput, setNameInput] = useState(shownName);
  const [nameError, setNameError] = useState<string | null>(null);
  // Re-sync the field when the selection (or its staged name) changes.
  useEffect(() => {
    setNameInput(shownName);
    setNameError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [element.id, shownName]);

  const commitName = () => {
    if (readOnly) return;
    if (nameInput.trim() === shownName.trim() && nameInput.trim() !== "") return;
    const r = onRename(nameInput);
    setNameError(r.ok ? null : r.reason);
  };

  const renamePending = isTable && !isNew && element.renameTo !== null;

  return (
    <aside
      className="flex h-full w-full flex-col gap-1 overflow-y-auto border-s border-line bg-white p-3"
      aria-label="Selected object"
    >
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-extrabold text-ink">{isTable ? (isNew ? "New table" : "Table") : structureTitle(element.type)}</h3>
        {sectionName && <span className="truncate text-xs font-semibold text-sub">{sectionName}</span>}
      </div>

      {isLegacy && (
        <div className="pt-1">
          <span className="text-xs font-bold uppercase tracking-wide text-sub">Identity</span>
          <p className="mt-1 rounded-lg border border-line bg-canvas px-3 py-2.5 text-sm font-bold text-sub">
            Legacy table
          </p>
          <p className="mt-1 text-xs text-sub">
            This placement points at a table that is hidden from today’s table list, so it can’t be renamed here.
          </p>
          {element.renameTo !== null && (
            <button
              type="button"
              disabled={readOnly}
              onClick={onDiscardRename}
              className="mt-2 flex min-h-[44px] w-full items-center justify-center rounded-lg border border-line bg-white px-3 text-sm font-bold text-ink hover:bg-canvas disabled:opacity-40"
            >
              Discard draft rename (“{element.renameTo}”)
            </button>
          )}
        </div>
      )}

      {isTable && !isLegacy && (
        <div className="pt-1">
          <label className="text-xs font-bold uppercase tracking-wide text-sub" htmlFor="designer-table-name">
            Table name
          </label>
          <input
            id="designer-table-name"
            value={nameInput}
            maxLength={TABLE_NAME_MAX}
            disabled={readOnly}
            onChange={(e) => setNameInput(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            className="mt-1 w-full rounded-lg border border-line bg-white px-3 py-2 text-sm font-bold text-ink outline-none focus:ring-2 focus:ring-brand/40 disabled:opacity-50"
          />
          {nameError ? (
            <p className="mt-1 text-xs font-semibold text-rose-600">{nameError}</p>
          ) : renamePending ? (
            <p className="mt-1 text-xs text-sub">
              Renamed from <span className="font-bold">{meta?.name ?? "its current name"}</span> — applies when the
              floor is published.
            </p>
          ) : isNew ? (
            <p className="mt-1 text-xs text-sub">This table is created when the floor is published.</p>
          ) : (
            <p className="mt-1 text-xs text-sub">Renaming applies when the floor is published.</p>
          )}
        </div>
      )}

      {isTable && (
        <Row label="Seats">
          {isNew ? (
            <Stepper
              value={element.seats ?? SEATS_MIN}
              step={1}
              onChange={(n) => onSeats(Math.min(SEATS_MAX, Math.max(SEATS_MIN, Math.round(n))))}
              decrementLabel="Fewer seats"
              incrementLabel="More seats"
              disabled={readOnly}
            />
          ) : (
            <span className="flex items-center gap-1 text-sm font-bold text-ink">
              <Glyph name="seats" size={14} />
              {meta?.seats ?? "—"}
            </span>
          )}
        </Row>
      )}

      {isTable && (
        <div className="py-1.5">
          <span className="text-xs font-bold uppercase tracking-wide text-sub">Shape</span>
          <div className="mt-1.5 grid grid-cols-4 gap-1">
            {SHAPES.map((s) => (
              <button
                key={s}
                type="button"
                disabled={readOnly}
                onClick={() => onShape(s)}
                aria-pressed={(element.shape ?? "sq") === s}
                className={cn(
                  "min-h-[40px] rounded-lg border px-1 py-1.5 text-[11px] font-bold capitalize disabled:opacity-40",
                  (element.shape ?? "sq") === s
                    ? "border-brand bg-brand-soft text-brand-dark"
                    : "border-line bg-white text-sub hover:text-ink",
                )}
              >
                {shapeLabel(s)}
              </button>
            ))}
          </div>
        </div>
      )}

      <Row label="Width">
        <Stepper
          value={element.w}
          step={10}
          onChange={(n) => onSize(n, element.h)}
          decrementLabel="Narrower"
          incrementLabel="Wider"
          disabled={readOnly}
        />
      </Row>
      <Row label="Depth">
        <Stepper
          value={element.h}
          step={10}
          onChange={(n) => onSize(element.w, n)}
          decrementLabel="Shallower"
          incrementLabel="Deeper"
          disabled={readOnly}
        />
      </Row>
      <Row label="Rotation">
        <Stepper
          value={element.rotation}
          step={15}
          unit="°"
          onChange={(n) => onRotate(n)}
          decrementLabel="Rotate left"
          incrementLabel="Rotate right"
          disabled={readOnly}
        />
      </Row>

      <div className="mt-auto pt-3">
        {isTable && (
          <button
            type="button"
            disabled={readOnly}
            onClick={onDuplicate}
            className="mb-2 flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-lg border border-line bg-white px-3 py-2.5 text-sm font-bold text-ink hover:bg-canvas disabled:opacity-40"
          >
            <Glyph name="layers" size={15} />
            Duplicate table
          </button>
        )}
        <button
          type="button"
          disabled={readOnly}
          onClick={onRemove}
          className="flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-lg border border-rose-200 bg-white px-3 py-2.5 text-sm font-bold text-rose-700 hover:bg-rose-50 disabled:opacity-40"
        >
          <Glyph name="trash" size={15} />
          {isTable ? (isNew ? "Remove new table" : "Remove from floor") : "Remove from floor"}
        </button>
        {isTable && !isNew && (
          <p className="mt-1.5 text-center text-xs text-sub">
            The table itself is kept — it just leaves the map and returns to “Not on the floor”.
          </p>
        )}
      </div>
    </aside>
  );
}
