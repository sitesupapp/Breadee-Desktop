// Delivery management for the current shift.
//
// SCOPED TO THE ACTIVE SHIFT, like everything else that sits in the top bar. A
// driver board showing yesterday's deliveries is a board nobody can act on, and
// no active shift shows "No active shift" rather than borrowing history.
//
// THERE IS NO "MARK COLLECTED", AND THAT IS DELIBERATE. Level 3C established
// that `pos_pay_order` sets `payment_status = 'paid'` AND `status = 'completed'`
// in one statement, and that the schema has no `collected` state anywhere -
// there is no `pos_collect_*` function to call. Payment IS the completion of a
// delivery. So the action offered on an unpaid delivery is the real one, Pay,
// which routes into the settlement flow the Delivery workspace already owns. A
// button labelled "Mark collected" would be a status the server cannot store.
//
// Every action is state-aware through `orderActions.ts`, so a refunded order
// offers nothing but View and Print, and a paid one is never offered payment
// twice.

import { useMemo } from "react";
import { Badge, Button } from "@/components/ui";
import { Modal } from "@/components/overlays";
import { formatMoney, type CurrencyCode } from "@/lib/currency";
import { orderLifecycleLabel, orderLifecycleTone, type ShiftOpenOrder } from "@/lib/pos/shiftOrderSummary";
import { canEditOrder, canSettleOrder, paymentLabel, reversalActionFor } from "@/lib/pos/orderActions";

export function DeliveryModal(props: {
  open: boolean;
  onClose: () => void;
  shiftId: string | null;
  currency: CurrencyCode;
  /** Current-shift orders from the shared store; filtered to delivery here. */
  shiftOrders: ShiftOpenOrder[];
  onSelectOrder: (orderId: string) => void;
  onPrintOrder: (order: ShiftOpenOrder) => void;
  onEditOrder?: (order: ShiftOpenOrder) => void;
  onSettleOrder?: (order: ShiftOpenOrder) => void;
  onReverseOrder: (order: ShiftOpenOrder) => void;
}) {
  const rows = useMemo(
    () => props.shiftOrders.filter((o) => o.order_type === "delivery").slice().reverse(),
    [props.shiftOrders],
  );

  /**
   * Footer money, from the same rows the cards render.
   *
   * "Collected" is what has actually been paid; a voided or refunded order is
   * neither collected nor owed, so it counts toward neither. Totals are summed
   * from stored order amounts and never recomputed from a current rate.
   */
  const summary = useMemo(() => {
    let total = 0;
    let collected = 0;
    let unpaid = 0;
    for (const o of rows) {
      const amount = o.total_amount ?? 0;
      const reversed = o.status === "voided" || o.status === "cancelled" || o.status === "refunded";
      if (reversed) continue;
      total += amount;
      if (o.payment_status === "paid") collected += amount;
      else unpaid += amount;
    }
    return { count: rows.length, total, collected, unpaid };
  }, [rows]);

  if (!props.open) return null;

  return (
    <Modal open title="Delivery" subtitle="Current shift · delivery orders" size="lg" onClose={props.onClose}>
      {!props.shiftId ? (
        <div className="py-10 text-center">
          <p className="text-sm font-bold text-ink">No active shift</p>
          <p className="mt-1 text-xs text-sub">Open a shift to take delivery orders.</p>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="max-h-[52vh] space-y-2 overflow-y-auto">
            {rows.length === 0 && (
              <p className="py-8 text-center text-[12px] text-sub">No delivery orders on this shift yet.</p>
            )}
            {rows.map((o) => {
              const reversal = reversalActionFor(o);
              return (
                <div key={o.id} className="rounded-xl border border-line p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-extrabold text-ink">#{o.order_number ?? o.id.slice(0, 8)}</span>
                      <Badge tone={o.payment_status === "paid" ? "green" : o.payment_status === "refunded" ? "red" : "amber"}>
                        {paymentLabel(o)}
                      </Badge>
                      <Badge tone={orderLifecycleTone(o)}>{orderLifecycleLabel(o)}</Badge>
                    </div>
                    <span className="text-sm font-extrabold text-ink">
                      {formatMoney(o.total_amount ?? 0, (o.currency ?? props.currency) as CurrencyCode)}
                    </span>
                  </div>

                  <div className="mt-1 flex flex-wrap items-center gap-x-3 text-[11px] text-sub">
                    {o.customer_name && <span className="font-semibold text-ink">{o.customer_name}</span>}
                    {o.customer_phone && <span>{o.customer_phone}</span>}
                    {o.staff_name && <span>· {o.staff_name}</span>}
                    {o.created_at && <span>· {new Date(o.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>}
                  </div>

                  <div className="mt-2 flex flex-wrap justify-end gap-1">
                    <Button
                      variant="ghost"
                      className="px-2 py-1 text-[11px]"
                      onClick={() => {
                        props.onSelectOrder(o.id);
                        props.onClose();
                      }}
                    >
                      View
                    </Button>
                    {canEditOrder(o) && props.onEditOrder && (
                      <Button variant="ghost" className="px-2 py-1 text-[11px]" onClick={() => props.onEditOrder?.(o)}>
                        Edit
                      </Button>
                    )}
                    {/* Payment, not "collected" - see the module note. */}
                    {canSettleOrder(o) && props.onSettleOrder && (
                      <Button className="px-2 py-1 text-[11px]" onClick={() => props.onSettleOrder?.(o)}>
                        Pay
                      </Button>
                    )}
                    {reversal && (
                      <Button
                        variant="ghost"
                        className="px-2 py-1 text-[11px] text-red-700"
                        onClick={() => props.onReverseOrder(o)}
                      >
                        {reversal === "refund" ? "Refund" : "Cancel"}
                      </Button>
                    )}
                    <Button variant="ghost" className="px-2 py-1 text-[11px]" onClick={() => props.onPrintOrder(o)}>
                      Print
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="grid grid-cols-2 gap-2 rounded-xl border border-line bg-slate-50 p-3 sm:grid-cols-4">
            <Figure label="Orders" value={String(summary.count)} />
            <Figure label="Total amount" value={formatMoney(summary.total, props.currency)} />
            <Figure label="Collected" value={formatMoney(summary.collected, props.currency)} />
            <Figure label="Unpaid" value={formatMoney(summary.unpaid, props.currency)} />
          </div>
          <p className="text-[11px] text-sub">
            Reversed orders are excluded from these totals - they are neither collected nor owed.
          </p>
        </div>
      )}
    </Modal>
  );
}

function Figure(props: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] font-bold uppercase tracking-wide text-sub">{props.label}</p>
      <p className="text-sm font-extrabold text-ink">{props.value}</p>
    </div>
  );
}
