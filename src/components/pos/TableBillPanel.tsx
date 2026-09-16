// The selected table's bill.
//
// The bill shown here is the SERVER's, re-read from `pos_orders`. The cart is
// never displayed as the bill, and every figure on screen comes from the server.
//
// Level 2D added the last action: Pay. Its gate is NOT computed here - the panel
// receives the one `payTableGate` result that the bottom bar and F4 also render
// from, so there is a single answer to "can this bill be settled". The button
// opens the payment dialog; it never settles anything by itself.

import { Badge, Button, EmptyState, GatedButton, PanelTitle, Skeleton, type Gate } from "@/components/ui";
import { Glyph } from "@/components/Glyph";
import { formatMoney } from "@/lib/currency";
import { linesByBatch, billItemCount } from "@/lib/pos/tableBill";
import { lineTotals } from "@/lib/pos/modifiers";
import { sentRoundLabel } from "@/lib/pos/tableRounds";
import type { TableBill, TableSummary } from "@/types/tables";

export type TableBillPanelProps = {
  table: TableSummary | null;
  bill: TableBill | null;
  loading: boolean;
  error: string | null;
  openGate: Gate;
  /** Level 2B: entering Add Items mode for this table. */
  addItemsGate: Gate;
  onAddItems: () => void;
  onOpenTable: () => void;
  onOpenShift: () => void;
  shiftOpen: boolean;
  /** Level 2C table operations. Each opens a confirmation - none acts directly. */
  moveGate: Gate;
  closeGate: Gate;
  clearGate: Gate;
  onMove: () => void;
  onClose: () => void;
  onClear: () => void;
  /** Level 2D. The SHARED `payTableGate` result - never recomputed in this panel. */
  payGate: Gate;
  /** Opens the payment dialog. Settling happens there, behind the same gate. */
  onPay: () => void;
  /**
   * Print the table's CURRENT bill BEFORE payment (guest asked for the bill).
   * Manual preview of the server's bill; it takes no payment, closes no table,
   * and mutates nothing. Enabled only while there is an open bill to print.
   */
  onPrintBill: () => void;
  printBusy?: boolean;
};

/** A submitted time, shown short. The server's timestamp, never a local clock. */
function submittedAt(iso: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function TableBillPanel(props: TableBillPanelProps) {
  const { table, bill } = props;

  return (
    <section className="flex h-full min-h-0 flex-col border-l border-line bg-white" aria-label="Table bill">
      <div className="shrink-0 border-b border-line px-4 py-3">
        <PanelTitle right={table?.seats != null ? <Badge tone="slate">{table.seats} seats</Badge> : undefined}>
          {table ? table.name : "No table selected"}
        </PanelTitle>
        {bill && bill.orders.length > 0 && (
          <>
            <p className="mt-1 text-xs text-sub">
              {bill.orders.map((o) => `#${o.order_number}`).join(", ")} · {billItemCount(bill)} item
              {billItemCount(bill) === 1 ? "" : "s"} · {bill.batches.length} round
              {bill.batches.length === 1 ? "" : "s"}
            </p>
            {/* Server-reported lifecycle, read-only. Level 2B submits INTO the
                existing order/kitchen lifecycle; it does not model one locally. */}
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <Badge tone={bill.orders[0].status === "sent_to_kitchen" ? "blue" : "slate"}>
                {bill.orders[0].status.replace(/_/g, " ")}
              </Badge>
              <Badge tone={bill.orders[0].payment_status === "paid" ? "slate" : "amber"}>
                {bill.orders[0].payment_status}
              </Badge>
              {bill.splitShift && <Badge tone="amber">multiple shifts</Badge>}
            </div>
          </>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
        {!table && (
          <EmptyState title="Pick a table" hint="Select a table on the map to see its bill, or open a free one." />
        )}

        {table && props.loading && (
          <div className="space-y-2">
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </div>
        )}

        {table && !props.loading && props.error && (
          <div className="rounded-xl border border-red-300 bg-red-50 px-3 py-2">
            <p className="text-xs font-bold text-red-800">The bill could not be loaded</p>
            <p className="mt-0.5 text-xs text-red-700">{props.error}</p>
          </div>
        )}

        {table && !props.loading && !props.error && bill && bill.orders.length === 0 && (
          <EmptyState
            title="No open bill"
            hint={
              table.occupied
                ? "This table is marked occupied but has no open dine-in order. Refresh the map."
                : "This table is free. Open it to start serving."
            }
            action={
              props.openGate.allowed ? (
                <Button onClick={props.onOpenTable}>Open table</Button>
              ) : props.shiftOpen ? undefined : (
                <Button variant="ghost" onClick={props.onOpenShift}>
                  Open shift
                </Button>
              )
            }
          />
        )}

        {table && !props.loading && bill && bill.orders.length > 0 && (
          <div className="space-y-3">
            {bill.mixedCurrency && (
              <div className="rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-xs font-semibold text-red-800">
                This table's orders were created under different currency settings. The server will refuse to settle
                them together.
              </div>
            )}
            {bill.splitShift && (
              <div className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">
                This table has orders from more than one shift, so they cannot be settled together.
              </div>
            )}

            {/* Grouped by the SERVER's batch number - never a client-side guess. */}
            {linesByBatch(bill).map(({ batch, lines }) => (
              <div key={batch} className="rounded-xl border border-line">
                <div className="flex items-center justify-between border-b border-line px-3 py-1.5">
                  <span className="text-xs font-extrabold text-ink">{sentRoundLabel(batch)}</span>
                  <span className="text-[11px] text-sub">
                    {lines.length} line{lines.length === 1 ? "" : "s"}
                    {submittedAt(bill.orders[0]?.created_at ?? null) && batch === bill.batches[0]
                      ? ` · ${submittedAt(bill.orders[0].created_at)}`
                      : ""}
                  </span>
                </div>
                <ul className="divide-y divide-line">
                  {lines.map((l) => (
                    <li key={l.id} className="px-3 py-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-ink">
                            {l.quantity} x {l.name}
                          </p>
                          {l.modifiers.map((m) => (
                            <p key={`${l.id}-${m.option_id}`} className="truncate pl-3 text-xs text-sub">
                              + {m.name}
                              {m.price_delta !== 0 && bill.currency
                                ? ` (${formatMoney(m.price_delta, bill.currency)})`
                                : ""}
                            </p>
                          ))}
                          {l.kitchen_note && (
                            <p className="truncate pl-3 text-xs italic text-amber-700">{l.kitchen_note}</p>
                          )}
                        </div>
                        {bill.currency && (
                          <p className="shrink-0 text-sm font-bold tabular-nums text-ink">
                            {formatMoney(l.line_total || lineTotals(l.base_price, l.modifiers, l.quantity).lineTotal, bill.currency)}
                          </p>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-line bg-white p-3">
        {bill && bill.orders.length > 0 && (
          <div className="mb-2 flex items-baseline justify-between">
            <span className="text-sm font-semibold text-sub">Bill total</span>
            <span className="text-xl font-extrabold tabular-nums text-ink">
              {bill.total != null && bill.currency ? formatMoney(bill.total, bill.currency) : "—"}
            </span>
          </div>
        )}

        {table && bill && bill.orders.length === 0 && props.openGate.allowed && (
          <Button size="lg" className="mb-2 w-full" onClick={props.onOpenTable}>
            Open table
          </Button>
        )}
        {table && bill && bill.orders.length === 0 && !props.openGate.allowed && props.openGate.reason && (
          <p className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">
            {props.openGate.reason}
          </p>
        )}

        {/* Level 2D. The money action, at the TOP of the action stack and as far
            from Clear as the panel allows - Pay collects the bill, Clear voids
            it, and those two must never be adjacent on a touch screen. Kept the
            full-width, large primary so it stays the obvious control. */}
        {table && bill && bill.orders.length > 0 && (
          <GatedButton gate={props.payGate} size="lg" className="mb-2 w-full" onClick={props.onPay}>
            <Glyph name="pay" size={18} />
            Pay (F4)
          </GatedButton>
        )}

        {/* Secondary actions, paired to save height: Add items (which enters the
            round builder) and Print bill (the guest's copy, BEFORE payment).
            Both are non-destructive, so pairing them carries none of the mis-tap
            risk that keeps Clear on its own row below. */}
        {table && (
          <div className="mb-2 grid grid-cols-2 gap-2">
            <GatedButton
              gate={props.addItemsGate}
              variant="outline"
              size="md"
              className="w-full"
              disabled={!props.addItemsGate.allowed}
              onClick={props.onAddItems}
            >
              <Glyph name="kitchen" size={16} />
              Add items (A)
            </GatedButton>
            <Button
              variant="ghost"
              size="md"
              className="w-full"
              disabled={!bill || bill.orders.length === 0 || props.printBusy}
              onClick={props.onPrintBill}
            >
              <Glyph name="print" size={16} />
              {props.printBusy ? "Preparing..." : "Print bill"}
            </Button>
          </div>
        )}

        {/* Level 2C operations. Move and Close are paired - both are table
            operations, neither voids the bill - while Clear stays on its own row
            below because it VOIDS the bill and must never sit beside another
            control a thumb could reach by mistake. */}
        <div className="grid grid-cols-2 gap-2">
          <GatedButton gate={props.moveGate} variant="ghost" size="md" className="w-full" onClick={props.onMove}>
            <Glyph name="move" size={16} />
            Move table
          </GatedButton>
          <GatedButton gate={props.closeGate} variant="ghost" size="md" className="w-full" onClick={props.onClose}>
            <Glyph name="check" size={16} />
            Close table
          </GatedButton>
        </div>

        <div className="mt-2 border-t border-dashed border-line pt-2">
          <GatedButton
            gate={props.clearGate}
            variant="danger"
            size="md"
            className="w-full"
            onClick={props.onClear}
          >
            <Glyph name="trash" size={16} />
            Clear bill (voids the bill)
          </GatedButton>
        </div>
      </div>
    </section>
  );
}
