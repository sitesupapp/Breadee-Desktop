// Open a table, optionally capturing a seat count.
//
// The table NAME is not editable here: on a configured branch the server refuses
// an unknown name (22023), so offering a free-text box would invite a refusal.
// The name shown is the one the map returned, and the name the server stores is
// the one that ends up on screen.

import { useEffect, useState } from "react";
import { Modal } from "@/components/overlays";
import { Button, Input, type Gate } from "@/components/ui";
import { NumericKeypad } from "@/components/pos/NumericKeypad";
import { validateSeats } from "@/lib/pos/tables";
import type { TableSummary } from "@/types/tables";

export function SeatCountDialog({
  open,
  table,
  busy,
  gate,
  error,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  table: TableSummary | null;
  busy: boolean;
  gate: Gate;
  error: string | null;
  onCancel: () => void;
  onConfirm: (seats: number | null) => void;
}) {
  const [seats, setSeats] = useState("");
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (open) {
      // Pre-fill from the map so re-opening a table keeps its existing count.
      setSeats(table?.seats != null ? String(table.seats) : "");
      setTouched(false);
    }
  }, [open, table]);

  const validation = validateSeats(seats);
  const showError = touched && validation.error !== null;
  const canConfirm = !busy && gate.allowed && validation.error === null;

  return (
    <Modal
      open={open && !!table}
      title={table ? `Open ${table.name}` : "Open table"}
      subtitle="Seats are optional. The server confirms the table's stored name."
      size="sm"
      onClose={onCancel}
      footer={
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            {showError && <p className="truncate text-xs font-semibold text-amber-800">{validation.error}</p>}
            {error && <p className="truncate text-xs font-semibold text-red-700">{error}</p>}
            {!gate.allowed && gate.reason && (
              <p className="truncate text-xs font-semibold text-amber-800">{gate.reason}</p>
            )}
          </div>
          <div className="flex shrink-0 gap-2">
            <Button variant="ghost" size="lg" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
            <Button
              size="lg"
              onClick={() => onConfirm(validation.seats)}
              disabled={!canConfirm}
              title={gate.reason ?? validation.error ?? undefined}
            >
              {busy ? "Opening..." : "Open table"}
            </Button>
          </div>
        </div>
      }
    >
      <label className="mb-1 block text-sm font-bold text-ink" htmlFor="seat-count">
        Seats (optional)
      </label>
      <Input
        id="seat-count"
        size="lg"
        inputMode="numeric"
        value={seats}
        onChange={(e) => {
          setSeats(e.target.value);
          setTouched(true);
        }}
        placeholder="Leave blank if not counting"
        className="text-right text-lg font-bold"
      />
      <NumericKeypad
        className="mt-3"
        value={seats}
        allowDecimal={false}
        onChange={(v) => {
          setSeats(v);
          setTouched(true);
        }}
      />
    </Modal>
  );
}
