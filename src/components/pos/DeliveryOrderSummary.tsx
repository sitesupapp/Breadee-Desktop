// The delivery order that has been sent, and has NOT been paid.
//
// This panel exists to make one thing unmistakable: the kitchen is cooking and
// the money has not been collected. Level 3B stops there deliberately, so the
// panel says "Unpaid" in plain words rather than leaving it to be inferred from
// an absent button - and there is no Pay control here to disable, because
// settling a delivery order is not implemented yet at all.
//
// The figures come from the server's response or from an authoritative re-read.
// Nothing here is computed from the cart: the cart is cleared the moment the
// order is accepted, and a total the client worked out itself is not the total
// the customer owes.

import { Badge, Button, PanelTitle } from "@/components/ui";
import { formatMoney, type CurrencyCode } from "@/lib/currency";
import { addressLine } from "@/components/pos/CustomerCard";
import type { CustomerAddress, CustomerProfile } from "@/lib/pos/customers";
import { kitchenStateLabel, type OpenDeliveryOrder } from "@/lib/pos/deliveryOrder";

export type DeliveryOrderSummaryProps = {
  order: OpenDeliveryOrder;
  customer: CustomerProfile | null;
  address: CustomerAddress | null;
  currency: CurrencyCode;
  /** True when this order was found by a re-read rather than a direct response. */
  recovered?: boolean;
  onStartNewOrder: () => void;
};

export function DeliveryOrderSummary(props: DeliveryOrderSummaryProps) {
  const o = props.order;
  const paid = o.payment_status === "paid";

  return (
    <section aria-label="Sent delivery order" className="rounded-2xl border border-line bg-white p-4">
      <PanelTitle
        right={
          <Badge tone={paid ? "green" : "amber"}>{paid ? o.payment_status : "Unpaid"}</Badge>
        }
      >
        {o.order_number ? `Order #${o.order_number}` : "Delivery order"}
      </PanelTitle>

      <p className="mt-1 text-xs font-semibold text-brand-dark">{kitchenStateLabel(o.status)}</p>
      {props.recovered && (
        <p className="mt-1 rounded-lg bg-slate-100 px-3 py-2 text-[11px] font-semibold text-sub">
          This order was already on file - it was sent once, not twice.
        </p>
      )}

      <div className="mt-3 space-y-0.5">
        <p className="text-xs font-bold text-ink">{props.customer?.name ?? "Customer"}</p>
        <p className="text-[11px] text-sub">{props.customer?.phone ?? "-"}</p>
        {props.address && <p className="text-[11px] text-sub">{addressLine(props.address)}</p>}
      </div>

      {o.notes && (
        <p className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-[11px] text-ink">{o.notes}</p>
      )}

      <div className="mt-3 flex items-baseline justify-between border-t border-line pt-2">
        <span className="text-sm font-semibold text-sub">Total</span>
        <span className="text-2xl font-extrabold tabular-nums text-ink">
          {formatMoney(o.total_amount ?? 0, (o.currency as CurrencyCode) ?? props.currency)}
        </span>
      </div>

      {/* Said in words, because the absence of a button is not a message. */}
      <p className="mt-2 text-[11px] font-semibold text-amber-800">
        Not paid. Taking payment for a delivery order is not available on the desktop yet.
      </p>

      <Button variant="ghost" size="lg" className="mt-3 w-full" onClick={props.onStartNewOrder}>
        Start another delivery order
      </Button>
    </section>
  );
}
