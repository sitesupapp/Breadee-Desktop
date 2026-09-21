// AUTO-NUMBER (Phase 3D-A) — renumber the selected tables into a clean sequence.
// The order is PHYSICAL reading order (top-to-bottom, then left-to-right), so the
// result is what an operator sees walking the room — and independent of UI text
// direction. Every change is draft-only: a staged `rename_to` for an existing
// table, `new_name` for a staged one. Nothing renames a canonical table until a
// future Publish. A preview shows exactly what each table becomes before it is
// applied.

import { useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/overlays";
import { Button } from "@/components/ui";
import { TABLE_NAME_MAX } from "@/lib/pos/floorDesigner";
import { generateNames } from "@/lib/pos/floorAutomate";
import type { AutoNumberSpec, OpResult } from "@/state/floorDesigner";

const stepBtn =
  "grid h-11 w-11 place-items-center rounded-lg border border-line bg-white text-lg font-bold text-ink hover:bg-canvas disabled:opacity-40";

export function AutoNumberDialog({
  open,
  fromNames,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  /** The selected tables' current names, ALREADY in physical reading order. */
  fromNames: string[];
  onCancel: () => void;
  onConfirm: (spec: AutoNumberSpec) => OpResult;
}) {
  const [prefix, setPrefix] = useState("T");
  const [start, setStart] = useState(1);
  const [pad, setPad] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setPrefix("T");
      setStart(1);
      setPad(0);
      setError(null);
    }
  }, [open]);

  const toNames = useMemo(
    () => generateNames({ prefix, start, count: fromNames.length, pad }),
    [prefix, start, pad, fromNames.length],
  );
  const overLong = toNames.some((n) => n.trim().length === 0 || n.length > TABLE_NAME_MAX);

  const submit = () => {
    const r = onConfirm({ prefix, start, pad });
    if (!r.ok) setError(r.reason);
  };

  return (
    <Modal
      open={open}
      title="Auto-number tables"
      subtitle={`${fromNames.length} selected · numbered in reading order`}
      size="sm"
      onClose={onCancel}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="lg" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="lg" onClick={submit} disabled={overLong}>
            Apply numbering
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-bold uppercase tracking-wide text-sub" htmlFor="an-prefix">
              Prefix
            </label>
            <input
              id="an-prefix"
              value={prefix}
              maxLength={TABLE_NAME_MAX}
              onChange={(e) => setPrefix(e.target.value)}
              placeholder="T, TR-, VIP-"
              className="mt-1 w-full rounded-lg border border-line bg-white px-3 py-2.5 text-sm font-bold text-ink outline-none focus:ring-2 focus:ring-brand/40"
            />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wide text-sub">Start</span>
            <div className="flex items-center gap-2">
              <button type="button" className={stepBtn} aria-label="Lower start number" onClick={() => setStart((n) => Math.max(0, n - 1))}>
                −
              </button>
              <span className="min-w-[36px] text-center text-base font-extrabold tabular-nums text-ink">{start}</span>
              <button type="button" className={stepBtn} aria-label="Higher start number" onClick={() => setStart((n) => n + 1)}>
                +
              </button>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between">
          <span className="text-xs font-bold uppercase tracking-wide text-sub">Zero-pad</span>
          <div className="flex items-center gap-2">
            <button type="button" className={stepBtn} aria-label="Less padding" onClick={() => setPad((n) => Math.max(0, n - 1))}>
              −
            </button>
            <span className="min-w-[36px] text-center text-base font-extrabold tabular-nums text-ink">{pad || "—"}</span>
            <button type="button" className={stepBtn} aria-label="More padding" onClick={() => setPad((n) => Math.min(4, n + 1))}>
              +
            </button>
          </div>
        </div>

        <div className="max-h-48 overflow-y-auto rounded-lg border border-line bg-canvas">
          {fromNames.map((from, i) => (
            <div key={i} className="flex items-center justify-between gap-2 border-b border-line px-3 py-1.5 text-sm last:border-b-0">
              <span className="truncate text-sub">{from || "(unnamed)"}</span>
              <span aria-hidden className="px-1 text-sub">→</span>
              <span className={`truncate text-end font-bold ${overLong ? "text-rose-600" : "text-ink"}`}>{toNames[i]}</span>
            </div>
          ))}
        </div>

        {error && <p className="text-sm font-semibold text-rose-600">{error}</p>}
        <p className="text-xs text-sub">Renaming applies to the POS when the floor is published.</p>
      </div>
    </Modal>
  );
}
