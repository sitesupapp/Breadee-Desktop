// Add Items mode: the round being prepared, above the bill that already exists.
//
// The separation is the whole point of this panel. The top half is LOCAL and not
// yet real - it is a buffer the cashier is still editing. The bottom half is the
// SERVER's bill. They are labelled, boxed and coloured differently so a cashier
// glancing at the screen can never read an unsent round as money already owed.
//
// Nothing here computes a batch number. "Sent round N" comes from the server's
// own `batch_no`, and the next round is labelled by how many the server says
// have been sent - never by a local counter.

import { Badge, Button, EmptyState, GatedButton, PanelTitle, StatusDot, cn, type Gate } from "@/components/ui";
import { formatMoney, type CurrencyCode } from "@/lib/currency";
import { CartLineRow } from "@/components/pos/CartLineRow";
import { billItemCount, linesByBatch } from "@/lib/pos/tableBill";
import { preparingRoundLabel, sentRoundLabel } from "@/lib/pos/tableRounds";
import type { CartLine } from "@/types/pos";
import type { TableBill, TableSummary } from "@/types/tables";

export type DineInRoundPanelProps = {
  table: TableSummary;
  bill: TableBill | null;
  billLoading: boolean;
  billError: string | null;
  /** True while the bill is being re-read; the figures below may be a moment old. */
  refreshing: boolean;
  /** What changed under the operator since they started this round, if anything. */
  billChange: string | null;
  lines: CartLine[];
  selectedKey: string | null;
  subtotal: number;
  currency: CurrencyCode;
  busy: boolean;
  submitGate: Gate;
  onSelect: (key: string) => void;
  onAdjust: (key: string, delta: number) => void;
  onRemove: (key: string) => void;
  onEditNote: (key: string) => void;
  onSubmitRound: () => void;
  onDiscardRound: () => void;
  onBackToMap: () => void;
};

export function DineInRoundPanel(props: DineInRoundPanelProps) {
  const { bill, table } = props;
  const empty = props.lines.length === 0;
  const sentBatches = bill?.batches.length ?? 0;

  return (
    <section className="flex h-full min-h-0 flex-col border-l border-line bg-white" aria-label="Round being prepared">
      {/* Table identity stays pinned: which table this round is for is the one
          fact a cashier must never have to scroll for. */}
      <div className="shrink-0 border-b border-line px-4 py-3">
        <PanelTitle right={table.seats != null ? <Badge tone="slate">{table.seats} seats</Badge> : undefined}>
          {table.name}
        </PanelTitle>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-sub">
          {bill && bill.orders.length > 0 ? (
            <>
              <span className="font-semibold text-brand-dark">{bill.orders[0].order_number}</span>
              <span>
                {sentBatches} round{sentBatches === 1 ? "" : "s"} sent
              </span>
              <span>
                {billItemCount(bill)} item{billItemCount(bill) === 1 ? "" : "s"}
              </span>
              <span className="font-bold text-ink">
                {bill.total != null && bill.currency ? formatMoney(bill.total, bill.currency) : "—"}
              </span>
            </>
          ) : (
            <span>No bill yet - this round will open one.</span>
          )}
          {props.refreshing && (
            <Badge tone="slate">
              <StatusDot tone="slate" />
              Refreshing bill
            </Badge>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
        {props.billChange && (
          <div className="mb-3 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2">
            <p className="text-xs font-bold text-amber-900">This table changed while you were adding items</p>
            <p className="mt-0.5 text-xs text-amber-800">{props.billChange}</p>
          </div>
        )}

        {/* --- the LOCAL buffer -------------------------------------------- */}
        <div className="rounded-xl border-2 border-dashed border-brand/50 bg-brand-soft/20 p-2">
          <div className="mb-2 flex items-center justify-between px-1">
            <span className="text-xs font-extrabold uppercase tracking-wide text-brand-dark">
              {preparingRoundLabel(bill)}
            </span>
            {!empty && (
              <Button variant="ghost" onClick={props.onDiscardRound}>
                Discard
              </Button>
            )}
          </div>

          {empty ? (
            <EmptyState
              title="Nothing in this round yet"
              hint="Pick items from the menu, or press Ctrl+K to search. This round is not sent until you press Submit round."
            />
          ) : (
            <ul className="space-y-2">
              {props.lines.map((line) => (
                <CartLineRow
                  key={line.key}
                  line={line}
                  selected={line.key === props.selectedKey}
                  currency={props.currency}
                  onSelect={() => props.onSelect(line.key)}
                  onAdjust={(delta) => props.onAdjust(line.key, delta)}
                  onRemove={() => props.onRemove(line.key)}
                  onEditNote={() => props.onEditNote(line.key)}
                />
              ))}
            </ul>
          )}
        </div>

        {/* --- the SERVER's bill ------------------------------------------- */}
        {bill && bill.orders.length > 0 && (
          <div className="mt-4">
            <p className="mb-2 px-1 text-xs font-extrabold uppercase tracking-wide text-sub">Current bill</p>

            {bill.mixedCurrency && (
              <div className="mb-2 rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-xs font-semibold text-red-800">
                This table's orders span different currencies. The server will refuse to settle them together.
              </div>
            )}

            <div className="space-y-2">
              {linesByBatch(bill).map(({ batch, lines }) => (
                <div key={batch} className="rounded-xl border border-line">
                  <div className="flex items-center justify-between border-b border-line px-3 py-1.5">
                    <span className="text-xs font-extrabold text-ink">{sentRoundLabel(batch)}</span>
                    <span className="text-[11px] text-sub">
                      {lines.length} line{lines.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  <ul className="divide-y divide-line">
                    {lines.map((l) => (
                      <li key={l.id} className="px-3 py-1.5">
                        <p className="truncate text-xs font-semibold text-ink">
                          {l.quantity} x {l.name}
                        </p>
                        {l.modifiers.map((m) => (
                          <p key={`${l.id}-${m.option_id}`} className="truncate pl-3 text-[11px] text-sub">
                            + {m.name}
                          </p>
                        ))}
                        {l.kitchen_note && (
                          <p className="truncate pl-3 text-[11px] italic text-amber-700">{l.kitchen_note}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        )}

        {props.billError && (
          <div className="mt-3 rounded-xl border border-red-300 bg-red-50 px-3 py-2">
            <p className="text-xs font-bold text-red-800">The bill could not be loaded</p>
            <p className="mt-0.5 text-xs text-red-700">{props.billError}</p>
          </div>
        )}
      </div>

      {/* Pinned action area. Submit round sits alone: the destructive table
          actions arrive in later levels and must never share this row. */}
      <div className="shrink-0 border-t border-line bg-white p-3">
        <div className="mb-3 flex items-baseline justify-between">
          <span className="text-sm font-semibold text-sub">This round</span>
          <span className="text-2xl font-extrabold tabular-nums text-ink">
            {formatMoney(props.subtotal, props.currency)}
          </span>
        </div>

        <div className={cn("grid gap-2", "grid-cols-[auto_1fr]")}>
          <Button variant="ghost" size="lg" onClick={props.onBackToMap}>
            Tables
          </Button>
          <GatedButton
            gate={props.submitGate}
            size="lg"
            disabled={empty || props.busy || !props.submitGate.allowed}
            onClick={props.onSubmitRound}
          >
            {props.busy ? "Sending round..." : "Submit round (Ctrl+Enter)"}
          </GatedButton>
        </div>

        {/* A footer note used to sit here deferring table payment to a later
            level. It was true while settlement did not exist; once Pay shipped
            it became a claim the app itself contradicts one screen away, and a
            POS that misdescribes what it can do is worse than one that says
            nothing. Sending the round is this panel's only job - Pay lives on
            the bill panel, behind the shared gate. */}
      </div>
    </section>
  );
}
