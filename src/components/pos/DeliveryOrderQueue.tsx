// The Delivery order queue (Level 3D).
//
// An operational list, not a report. It answers the question a cashier actually
// has - "which delivery orders am I answerable for right now, and which of them
// still owe money?" - and nothing else. There is no date range, no cross-branch
// toggle and no order-type switch: the scope is decided by `loadDeliveryQueue`
// (this shift, or today when no shift is open) and stated at the top so it is
// never a mystery which list is on screen.
//
// EVERY ROW IS A READ. No row carries a mutation control. Editing, cancelling,
// refunding and paying all live one tap further in, on the detail panel, because
// a Cancel button sitting in a scrolling list of similar-looking rows is a
// mis-tap waiting to void the wrong order.

import { Badge, Button, EmptyState, ErrorState, Skeleton, cn } from "@/components/ui";
import { formatMoney, type CurrencyCode } from "@/lib/currency";
import {
  orderStateLabel,
  orderStateTone,
  orderTimeLabel,
  paymentStateLabel,
  paymentStateTone,
  UNKNOWN_PARTY,
  type OrderParty,
} from "@/lib/pos/deliveryHistory";
import { DELIVERY_QUEUE_LIMIT, type DeliveryQueueOrder } from "@/lib/pos/deliveryOrderManagement";

export type DeliveryOrderQueueProps = {
  orders: DeliveryQueueOrder[];
  parties: Map<string, OrderParty>;
  counts: { unpaid: number; paid: number; cancelled: number };
  /** True while a shift is open - decides which scope sentence is shown. */
  shiftScoped: boolean;
  currency: CurrencyCode;
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  onSelect: (order: DeliveryQueueOrder) => void;
  onRefresh: () => void;
};

export function DeliveryOrderQueue(props: DeliveryOrderQueueProps) {
  return (
    <section aria-label="Delivery orders" className="flex min-h-0 flex-1 flex-col rounded-2xl border border-line bg-white">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-line p-4">
        <div className="min-w-0">
          <p className="text-sm font-extrabold text-ink">Delivery orders</p>
          <p className="mt-0.5 text-xs text-sub">
            {props.shiftScoped
              ? "This shift's delivery orders, newest first."
              : "Today's delivery orders for this branch, newest first."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone="amber">{props.counts.unpaid} unpaid</Badge>
          <Badge tone="green">{props.counts.paid} paid</Badge>
          <Badge tone="slate">{props.counts.cancelled} cancelled</Badge>
          <Button variant="ghost" onClick={props.onRefresh} disabled={props.loading}>
            Refresh
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {props.error ? (
          <ErrorState title="The delivery orders could not be loaded" message={props.error} onRetry={props.onRefresh} />
        ) : props.loading && props.orders.length === 0 ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-[68px]" />
            ))}
          </div>
        ) : props.orders.length === 0 ? (
          <EmptyState
            icon="-"
            title="No delivery orders yet"
            hint={
              props.shiftScoped
                ? "Orders taken during this shift will appear here."
                : "Delivery orders taken today at this branch will appear here."
            }
          />
        ) : (
          <ul className="space-y-2">
            {props.orders.map((o) => {
              const party = props.parties.get(o.id) ?? UNKNOWN_PARTY;
              const selected = o.id === props.selectedId;
              return (
                <li key={o.id}>
                  <button
                    type="button"
                    aria-current={selected || undefined}
                    onClick={() => props.onSelect(o)}
                    className={cn(
                      "flex min-h-[68px] w-full items-center gap-3 rounded-xl border p-3 text-left transition",
                      selected ? "border-brand bg-brand-soft" : "border-line bg-white hover:bg-slate-50",
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="text-sm font-extrabold text-ink">
                          #{o.order_number ?? o.id.slice(0, 8)}
                        </span>
                        <span className="text-[11px] font-semibold text-sub">{orderTimeLabel(o.created_at)}</span>
                      </div>
                      <p className="truncate text-xs font-semibold text-ink">{party.customerName ?? "Customer"}</p>
                      <p className="truncate text-[11px] text-sub">{party.addressText ?? "No address on file"}</p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <span className="text-sm font-extrabold tabular-nums text-ink">
                        {formatMoney(o.total_amount ?? 0, (o.currency as CurrencyCode) ?? props.currency)}
                      </span>
                      <div className="flex items-center gap-1">
                        <Badge tone={orderStateTone(o.status)}>{orderStateLabel(o.status)}</Badge>
                        <Badge tone={paymentStateTone(o.payment_status)}>
                          {paymentStateLabel(o.payment_status)}
                        </Badge>
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {/* Said out loud rather than silently truncating: a queue that stops at
            200 and does not say so reads as "that is all of them". */}
        {props.orders.length >= DELIVERY_QUEUE_LIMIT && (
          <p className="mt-2 px-1 text-[11px] font-semibold text-sub">
            Showing the {DELIVERY_QUEUE_LIMIT} most recent orders.
          </p>
        )}
      </div>
    </section>
  );
}
