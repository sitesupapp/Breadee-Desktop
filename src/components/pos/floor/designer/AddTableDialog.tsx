// "Add table" (Phase 3B) — stages a NEW table on the draft floor, in plain
// restaurant language: a name and how many seats. The canonical table record is
// created only when the floor is published; until then the table lives on the
// draft with a "New" chip, and nothing appears in the POS List or Service Map.

import { useEffect, useState } from "react";
import { Modal } from "@/components/overlays";
import { Button } from "@/components/ui";
import { SEATS_MAX, SEATS_MIN, TABLE_NAME_MAX, validateSeats, validateTableName } from "@/lib/pos/floorDesigner";
import type { OpResult } from "@/state/floorDesigner";

export function AddTableDialog({
  open,
  sectionName,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  sectionName: string | null;
  onCancel: () => void;
  /** Returns the store's verdict so a refusal is shown, not swallowed. */
  onConfirm: (name: string, seats: number) => OpResult;
}) {
  const [name, setName] = useState("");
  const [seats, setSeats] = useState(4);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName("");
      setSeats(4);
      setError(null);
    }
  }, [open]);

  const submit = () => {
    const bad = validateTableName(name) ?? validateSeats(seats);
    if (bad) {
      setError(bad);
      return;
    }
    const r = onConfirm(name, seats);
    if (!r.ok) setError(r.reason);
  };

  const stepBtn =
    "grid h-10 w-10 place-items-center rounded-lg border border-line bg-white text-lg font-bold text-ink hover:bg-canvas";

  return (
    <Modal
      open={open}
      title="Add a table"
      subtitle={sectionName ? `It will be placed in ${sectionName}.` : undefined}
      size="sm"
      onClose={onCancel}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="lg" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="lg" onClick={submit}>
            Add table
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <div>
          <label className="text-xs font-bold uppercase tracking-wide text-sub" htmlFor="add-table-name">
            Table name
          </label>
          <input
            id="add-table-name"
            value={name}
            maxLength={TABLE_NAME_MAX}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            placeholder="e.g. 12, VIP-2, Garden 5"
            className="mt-1 w-full rounded-lg border border-line bg-white px-3 py-2.5 text-sm font-bold text-ink outline-none focus:ring-2 focus:ring-brand/40"
          />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold uppercase tracking-wide text-sub">Seats</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className={stepBtn}
              aria-label="Fewer seats"
              onClick={() => setSeats((n) => Math.max(SEATS_MIN, n - 1))}
            >
              −
            </button>
            <span className="min-w-[36px] text-center text-base font-extrabold tabular-nums text-ink">{seats}</span>
            <button
              type="button"
              className={stepBtn}
              aria-label="More seats"
              onClick={() => setSeats((n) => Math.min(SEATS_MAX, n + 1))}
            >
              +
            </button>
          </div>
        </div>
        {error && <p className="text-sm font-semibold text-rose-600">{error}</p>}
        <p className="text-xs text-sub">The table is created for the POS when the floor is published.</p>
      </div>
    </Modal>
  );
}
