// QUICK SETUP / BULK CREATE (Phase 3D-A) — stand a whole section up in one step:
// choose how many tables, a naming pattern and a shape, and the Designer stages
// that many NEW-table intents in a deterministic grid as ONE draft mutation. It
// is a thin orchestration over the shared automation engine (naming + grid) — no
// second table engine — and it never creates a canonical table: the POS List and
// Service Map stay untouched until a future Publish.
//
// A populated section is never rearranged: the new batch is dropped into fresh
// space BELOW the existing content (the store computes the anchor).

import { useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/overlays";
import { Button } from "@/components/ui";
import { shapeLabel } from "@/lib/pos/floorStatus";
import type { FloorTableShape } from "@/lib/pos/floor";
import { SEATS_MAX, SEATS_MIN, TABLE_NAME_MAX } from "@/lib/pos/floorDesigner";
import { generateNames } from "@/lib/pos/floorAutomate";
import type { BulkCreateSpec, OpResult } from "@/state/floorDesigner";

const SHAPES: FloorTableShape[] = ["sq", "round", "r4", "r6", "rect", "rect6", "rect8", "oval", "high", "bar", "lounge"];
const MAX_BULK = 100; // a practical single-batch ceiling; the server limit is higher.

const stepBtn =
  "grid h-11 w-11 place-items-center rounded-lg border border-line bg-white text-lg font-bold text-ink hover:bg-canvas disabled:opacity-40";

export function QuickSetupDialog({
  open,
  sectionName,
  remainingCapacity,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  sectionName: string | null;
  /** How many more elements this floor can hold (server element limit − current). */
  remainingCapacity: number;
  onCancel: () => void;
  /** Returns the store's verdict so a refusal is shown, not swallowed. */
  onConfirm: (spec: BulkCreateSpec) => OpResult;
}) {
  const [count, setCount] = useState(6);
  const [prefix, setPrefix] = useState("T");
  const [start, setStart] = useState(1);
  const [pad, setPad] = useState(0);
  const [seats, setSeats] = useState(4);
  const [shape, setShape] = useState<FloorTableShape>("sq");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setCount(6);
      setPrefix("T");
      setStart(1);
      setPad(0);
      setSeats(4);
      setShape("sq");
      setError(null);
    }
  }, [open]);

  const cap = Math.max(0, Math.min(MAX_BULK, remainingCapacity));
  const preview = useMemo(
    () => generateNames({ prefix, start, count: Math.min(count, 3), pad }),
    [prefix, start, count, pad],
  );
  const lastName = useMemo(
    () => generateNames({ prefix, start: start + count - 1, count: 1, pad })[0] ?? "",
    [prefix, start, count, pad],
  );
  const overLong = preview.some((n) => n.trim().length === 0 || n.length > TABLE_NAME_MAX);

  const submit = () => {
    if (count < 1) {
      setError("Choose how many tables to create.");
      return;
    }
    if (count > cap) {
      setError(cap === 0 ? "This floor is full." : `You can add at most ${cap} more here.`);
      return;
    }
    const r = onConfirm({ count, prefix, start, pad, seats, shape });
    if (!r.ok) setError(r.reason);
  };

  return (
    <Modal
      open={open}
      title="Quick setup"
      subtitle={sectionName ? `New tables go in ${sectionName}.` : undefined}
      size="sm"
      onClose={onCancel}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="lg" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="lg" onClick={submit} disabled={cap === 0}>
            Create {Math.max(0, count)} table{count === 1 ? "" : "s"}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold uppercase tracking-wide text-sub">How many</span>
          <div className="flex items-center gap-2">
            <button type="button" className={stepBtn} aria-label="Fewer tables" onClick={() => setCount((n) => Math.max(1, n - 1))}>
              −
            </button>
            <span className="min-w-[40px] text-center text-base font-extrabold tabular-nums text-ink">{count}</span>
            <button type="button" className={stepBtn} aria-label="More tables" onClick={() => setCount((n) => Math.min(cap || MAX_BULK, n + 1))}>
              +
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-bold uppercase tracking-wide text-sub" htmlFor="qs-prefix">
              Name prefix
            </label>
            <input
              id="qs-prefix"
              value={prefix}
              maxLength={TABLE_NAME_MAX}
              onChange={(e) => setPrefix(e.target.value)}
              placeholder="T, TR-, VIP-"
              className="mt-1 w-full rounded-lg border border-line bg-white px-3 py-2.5 text-sm font-bold text-ink outline-none focus:ring-2 focus:ring-brand/40"
            />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wide text-sub">Start&nbsp;at</span>
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

        <div className="grid grid-cols-2 gap-3">
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
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wide text-sub">Seats</span>
            <div className="flex items-center gap-2">
              <button type="button" className={stepBtn} aria-label="Fewer seats" onClick={() => setSeats((n) => Math.max(SEATS_MIN, n - 1))}>
                −
              </button>
              <span className="min-w-[36px] text-center text-base font-extrabold tabular-nums text-ink">{seats}</span>
              <button type="button" className={stepBtn} aria-label="More seats" onClick={() => setSeats((n) => Math.min(SEATS_MAX, n + 1))}>
                +
              </button>
            </div>
          </div>
        </div>

        <div>
          <label className="text-xs font-bold uppercase tracking-wide text-sub" htmlFor="qs-shape">
            Shape
          </label>
          <select
            id="qs-shape"
            value={shape}
            onChange={(e) => setShape(e.target.value as FloorTableShape)}
            className="mt-1 w-full rounded-lg border border-line bg-white px-3 py-2.5 text-sm font-bold text-ink outline-none focus:ring-2 focus:ring-brand/40"
          >
            {SHAPES.map((s) => (
              <option key={s} value={s}>
                {shapeLabel(s)}
              </option>
            ))}
          </select>
        </div>

        {/* Lightweight action preview (NOT a floor preview / publish). */}
        <div className="rounded-lg border border-line bg-canvas px-3 py-2.5 text-sm">
          <p className="font-bold text-ink">
            Create {count} table{count === 1 ? "" : "s"}
            {sectionName ? ` in ${sectionName}` : ""}
          </p>
          <p className="mt-0.5 text-sub">
            {overLong ? (
              <span className="font-semibold text-rose-600">That prefix makes an invalid name.</span>
            ) : (
              <>
                {preview.join(", ")}
                {count > preview.length ? ` … ${lastName}` : ""} · {seats} seats · {shapeLabel(shape)}
              </>
            )}
          </p>
          <p className="mt-0.5 text-xs text-sub">Tidied into a grid. Created for the POS only when the floor is published.</p>
        </div>

        {error && <p className="text-sm font-semibold text-rose-600">{error}</p>}
      </div>
    </Modal>
  );
}
