// The selected table's bill - READ ONLY in Level 2A.
//
// The bill shown here is the SERVER's, re-read from `pos_orders`. The cart is
// never displayed as the bill, and nothing in this panel can mutate anything:
// every forward action is rendered disabled with the level that will deliver it.

import { Badge, Button, EmptyState, PanelTitle, Skeleton, StatusDot, cn, type Gate } from "@/components/ui";
import { formatMoney } from "@/lib/currency";
import { linesByBatch, billItemCount } from "@/lib/pos/tableBill";
import { lineTotals } from "@/lib/pos/modifiers";
import { DEFERRED_TABLE_ACTIONS, deferredActionReason } from "@/lib/pos/dineInActions";
import type { TableBill, TableSummary } from "@/types/tables";

export type TableBillPanelProps = {
  table: TableSummary | null;
  bill: TableBill | null;
  loading: boolean;
  error: string | null;
  openGate: Gate;
  onOpenTable: () => void;
  onOpenShift: () => void;
  shiftOpen: boolean;
};

export function TableBillPanel(props: TableBillPanelProps) {
  const { table, bill } = props;

  return (
    <section className="flex h-full min-h-0 flex-col border-l border-line bg-white" aria-label="Table bill">
      <div className="shrink-0 border-b border-line px-4 py-3">
        <PanelTitle right={table?.seats != null ? <Badge tone="slate">{table.seats} seats</Badge> : undefined}>
          {table ? table.name : "No table selected"}
        </PanelTitle>
        {bill && bill.orders.length > 0 && (
          <p className="mt-1 text-xs text-sub">
            {bill.orders.map((o) => `#${o.order_number}`).join(", ")} · {billItemCount(bill)} item
            {billItemCount(bill) === 1 ? "" : "s"} · {bill.batches.length} round
            {bill.batches.length === 1 ? "" : "s"}
          </p>
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
                  <span className="text-xs font-extrabold text-ink">Round {batch}</span>
                  <span className="text-[11px] text-sub">
                    {lines.length} line{lines.length === 1 ? "" : "s"}
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
          <div className="mb-3 flex items-baseline justify-between">
            <span className="text-sm font-semibold text-sub">Bill total</span>
            <span className="text-2xl font-extrabold tabular-nums text-ink">
              {bill.total != null && bill.currency ? formatMoney(bill.total, bill.currency) : "—"}
            </span>
          </div>
        )}

        {table && bill && bill.orders.length === 0 && props.openGate.allowed && (
          <Button size="lg" className="mb-3 w-full" onClick={props.onOpenTable}>
            Open table
          </Button>
        )}
        {table && bill && bill.orders.length === 0 && !props.openGate.allowed && props.openGate.reason && (
          <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">
            {props.openGate.reason}
          </p>
        )}

        {/* Honest placeholders, from the single deferred-action list in
            `lib/pos/dineInActions.ts`. Each renders `disabled` with NO onClick,
            and the RPC each will eventually call is absent from `PosRpcName` -
            so there is no handler, and no reachable server call, behind any of
            them. */}
        <div className="grid grid-cols-2 gap-2">
          {DEFERRED_TABLE_ACTIONS.map((a) => (
            <button
              key={a.key}
              type="button"
              disabled
              aria-disabled
              title={deferredActionReason(a)}
              className={cn(
                "min-h-[44px] cursor-not-allowed rounded-xl border border-line bg-slate-50 px-3",
                "text-sm font-semibold text-slate-400",
              )}
            >
              {a.label}
            </button>
          ))}
        </div>
        <p className="mt-2 flex items-center gap-1 text-[11px] text-sub">
          <StatusDot tone="slate" />
          Ordering and payment for dine-in are not enabled yet.
        </p>
      </div>
    </section>
  );
}
