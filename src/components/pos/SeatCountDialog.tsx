// Open a table, optionally capturing a seat count.
//
// The table NAME is not editable when a table was picked from the map: on a
// configured branch the server refuses an unknown name (22023), so offering a
// free-text box would invite a refusal. The name shown is the one the map
// returned, and the name the server stores is the one that ends up on screen.
//
// A BRANCH WITH NO CONFIGURED TABLES IS THE EXCEPTION (1.0.4). There is no card
// to pick, and `pos_open_table` accepts free text precisely in that case, so the
// dialog asks for a name instead of refusing to open at all. Dine-in staying
// usable before anyone has configured a floor plan is the whole point of it:
// capacity is a setting, and taking an order is not.

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
  namable = false,
  defaultName = "",
  onCancel,
  onConfirm,
}: {
  open: boolean;
  table: TableSummary | null;
  busy: boolean;
  gate: Gate;
  error: string | null;
  /** No configured tables on this branch, so the operator names the table. */
  namable?: boolean;
  defaultName?: string;
  onCancel: () => void;
  onConfirm: (seats: number | null, name?: string) => void;
}) {
  const [seats, setSeats] = useState("");
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (open) {
      // Pre-fill from the map so re-opening a table keeps its existing count.
      setSeats(table?.seats != null ? String(table.seats) : "");
      setName(defaultName);
      setTouched(false);
    }
  }, [open, table, defaultName]);

  const validation = validateSeats(seats);
  const trimmedName = name.trim();
  // Only a NAMED open can be nameless-invalid; picking a card supplies the name.
  const nameError = namable && trimmedName.length === 0 ? "Give the table a name." : null;
  const showError = touched && (validation.error !== null || nameError !== null);
  const canConfirm = !busy && gate.allowed && validation.error === null && nameError === null;

  return (
    <Modal
      open={open && (namable || !!table)}
      title={namable ? "Open a table" : table ? `Open ${table.name}` : "Open table"}
      subtitle={
        namable
          ? "This branch has no configured tables, so name this one whatever the floor calls it."
          : "Seats are optional. The server confirms the table's stored name."
      }
      size="sm"
      onClose={onCancel}
      footer={
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            {showError && (
              <p className="truncate text-xs font-semibold text-amber-800">
                {nameError ?? validation.error}
              </p>
            )}
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
              onClick={() => onConfirm(validation.seats, namable ? trimmedName : undefined)}
              disabled={!canConfirm}
              title={gate.reason ?? validation.error ?? undefined}
            >
              {busy ? "Opening..." : "Open table"}
            </Button>
          </div>
        </div>
      }
    >
      {namable && (
        <div className="mb-3">
          <label className="mb-1 block text-sm font-bold text-ink" htmlFor="table-name">
            Table name
          </label>
          <Input
            id="table-name"
            size="lg"
            value={name}
            maxLength={40}
            onChange={(e) => {
              setName(e.target.value);
              setTouched(true);
            }}
            placeholder="1, Terrace, VIP 2…"
            className="text-lg font-bold"
          />
        </div>
      )}

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
