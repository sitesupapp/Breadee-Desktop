// Confirmations for the three Level 2C table operations.
//
// The weight of each dialog matches what it actually does:
//
//   Move   - reversible by moving back. A destination picker and a plain confirm.
//   Close  - only completes an already-PAID bill. It states what the server will
//            do, and says up front when the server is going to refuse.
//   Clear  - VOIDS the bill. It is the only one that demands typing, because it
//            is the only one that destroys money. The reason is mandatory here
//            AND in `lib/pos/tableOps.ts`, so no caller can skip it.

import { useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/overlays";
import { Badge, Button, EmptyState, Input, cn, type Gate } from "@/components/ui";
import { formatMoney } from "@/lib/currency";
import {
  CLEAR_REASON_SUGGESTIONS,
  clearConsequence,
  closeOutlook,
  moveDestinations,
  validateClearReason,
} from "@/lib/pos/tableOps";
import type { TableSummary } from "@/types/tables";

// --- Move --------------------------------------------------------------------

export function MoveTableDialog({
  open,
  table,
  tables,
  busy,
  gate,
  error,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  table: TableSummary | null;
  tables: TableSummary[];
  busy: boolean;
  gate: Gate;
  error: string | null;
  onCancel: () => void;
  onConfirm: (destinationId: string) => void;
}) {
  const [destination, setDestination] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (open) {
      setDestination(null);
      setQuery("");
    }
  }, [open]);

  // Only free tables. The server refuses an occupied destination, so offering
  // one would be inviting a refusal the operator cannot act on.
  const options = useMemo(() => {
    const free = moveDestinations(tables, table);
    const q = query.trim().toLowerCase();
    return q === "" ? free : free.filter((t) => t.name.toLowerCase().includes(q));
  }, [tables, table, query]);

  return (
    <Modal
      open={open && !!table}
      title={table ? `Move ${table.name}` : "Move table"}
      subtitle="The open bill moves with the table. Only free tables are listed."
      size="md"
      onClose={onCancel}
      footer={
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
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
              onClick={() => destination && onConfirm(destination)}
              disabled={busy || !destination || !gate.allowed}
              title={gate.reason ?? undefined}
            >
              {busy ? "Moving..." : "Move bill"}
            </Button>
          </div>
        </div>
      }
    >
      <Input
        size="lg"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search free tables"
        className="mb-3"
      />
      {options.length === 0 ? (
        <EmptyState
          title="No free table to move to"
          hint="Every other table has an open bill, or none matches the search. Clear or settle one first."
        />
      ) : (
        <ul className="grid max-h-[40vh] grid-cols-2 gap-2 overflow-y-auto overscroll-contain">
          {options.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => setDestination(t.id)}
                aria-pressed={destination === t.id}
                className={cn(
                  "flex min-h-[52px] w-full items-center justify-between gap-2 rounded-xl border-2 px-3 text-left",
                  destination === t.id ? "border-brand bg-brand-soft/40" : "border-line bg-white hover:bg-slate-50",
                )}
              >
                <span className="truncate text-sm font-bold text-ink">{t.name}</span>
                {t.seats != null && <span className="shrink-0 text-[11px] font-semibold text-sub">{t.seats}p</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

// --- Close -------------------------------------------------------------------

export function CloseTableDialog({
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
  onConfirm: () => void;
}) {
  const outlook = closeOutlook(table);

  return (
    <Modal
      open={open && !!table}
      title={table ? `Close ${table.name}` : "Close table"}
      subtitle="Closing completes settled orders and returns the table to available."
      size="sm"
      onClose={onCancel}
      footer={
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            {error && <p className="truncate text-xs font-semibold text-red-700">{error}</p>}
            {!gate.allowed && gate.reason && (
              <p className="truncate text-xs font-semibold text-amber-800">{gate.reason}</p>
            )}
          </div>
          <div className="flex shrink-0 gap-2">
            <Button variant="ghost" size="lg" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
            <Button size="lg" onClick={onConfirm} disabled={busy || !gate.allowed} title={gate.reason ?? undefined}>
              {busy ? "Closing..." : "Close table"}
            </Button>
          </div>
        </div>
      }
    >
      {/* Said BEFORE the press, not after the refusal. */}
      <div
        className={cn(
          "rounded-xl border px-3 py-2 text-sm",
          outlook.willRefuse ? "border-amber-300 bg-amber-50 text-amber-900" : "border-line bg-slate-50 text-sub",
        )}
      >
        {outlook.explanation}
      </div>
    </Modal>
  );
}

// --- Clear -------------------------------------------------------------------

export function ClearTableDialog({
  open,
  table,
  currency,
  busy,
  gate,
  error,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  table: TableSummary | null;
  currency: Parameters<typeof formatMoney>[1];
  busy: boolean;
  gate: Gate;
  error: string | null;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (open) {
      setReason("");
      setTouched(false);
    }
  }, [open]);

  const validation = validateClearReason(reason);
  const showError = touched && validation.error !== null;
  const canConfirm = !busy && gate.allowed && validation.error === null;

  return (
    <Modal
      open={open && !!table}
      title={table ? `Clear ${table.name}` : "Clear table"}
      subtitle="This voids the open bill. A reason is required."
      size="md"
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
              Keep the bill
            </Button>
            {/* Destructive styling: this is not the same kind of button as Move. */}
            <Button
              size="lg"
              variant="danger"
              onClick={() => validation.reason && onConfirm(validation.reason)}
              disabled={!canConfirm}
              title={gate.reason ?? validation.error ?? undefined}
            >
              {busy ? "Clearing..." : "Void bill and clear"}
            </Button>
          </div>
        </div>
      }
    >
      <div className="mb-3 rounded-xl border border-red-300 bg-red-50 px-3 py-2">
        <p className="text-xs font-bold text-red-800">{clearConsequence(table)}</p>
        {table?.total != null && table.currency && (
          <p className="mt-1 text-sm font-extrabold tabular-nums text-red-900">
            {formatMoney(table.total, table.currency)} will not be collected
          </p>
        )}
        {table?.mixed_currency && (
          <p className="mt-1 text-xs font-semibold text-red-800">
            This table's orders span more than one currency, so no single total can be shown.
          </p>
        )}
      </div>

      <label className="mb-1 block text-sm font-bold text-ink" htmlFor="clear-reason">
        Why is this being cleared?
      </label>
      <Input
        id="clear-reason"
        size="lg"
        value={reason}
        onChange={(e) => {
          setReason(e.target.value);
          setTouched(true);
        }}
        placeholder="Recorded against your account"
        autoComplete="off"
      />
      <div className="mt-2 flex flex-wrap gap-2">
        {CLEAR_REASON_SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => {
              setReason(s);
              setTouched(true);
            }}
            className="min-h-[44px] rounded-full border border-line bg-white px-3 text-xs font-semibold text-sub hover:bg-slate-50"
          >
            {s}
          </button>
        ))}
      </div>
      <p className="mt-3 flex items-center gap-2 text-[11px] text-sub">
        <Badge tone="slate">Audited</Badge>
        The reason, your account and the voided orders are written to the activity log.
      </p>
    </Modal>
  );
}
