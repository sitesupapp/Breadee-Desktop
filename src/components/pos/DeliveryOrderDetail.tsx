// One delivery order, in full (Level 3D).
//
// Everything shown here is an AUTHORITATIVE read - the order row and its lines
// come from `pos_orders` / `pos_order_items`, never from a cart that may have
// been cleared hours ago. That matters most for the figures: a total assembled
// locally could disagree with what the customer was actually charged, and this
// panel is where an operator decides whether to reverse a payment.
//
// WHAT LEVEL 3D DELIBERATELY DOES NOT OFFER. No add-item, no quantity change, no
// modifier change, no line removal, and no way to move an order to a different
// customer, address or branch. The narrow edit surface is the scope, not an
// oversight: `pos_edit_order` reads a note and a discount and nothing else, and
// `pos_remove_order_item` is not in the desktop's RPC allow-list at all.
//
// THE ACTION IS NAMED BY THE ORDER'S STATE. An unpaid order offers "Cancel
// order"; a paid one offers "Refund order", styled to look like what it is. The
// two are never one control with a flag - see `voidActionFor`.

import { Badge, Button, GatedButton, Skeleton, type Gate } from "@/components/ui";
import { formatMoney, type CurrencyCode } from "@/lib/currency";
import {
  orderStateLabel,
  orderStateTone,
  paymentStateLabel,
  paymentStateTone,
  UNKNOWN_PARTY,
  type OrderParty,
} from "@/lib/pos/deliveryHistory";
import {
  isCollected,
  isTerminal,
  recordedMargin,
  type DeliveryHandlerType,
  type DeliveryOrderLine,
  type DeliveryQueueOrder,
  type VoidAction,
} from "@/lib/pos/deliveryOrderManagement";
import { DeliveryOpsEditor } from "@/components/pos/DeliveryOpsEditor";

export type DeliveryOrderDetailProps = {
  order: DeliveryQueueOrder;
  party: OrderParty | null;
  lines: DeliveryOrderLine[];
  linesLoading: boolean;
  linesError: string | null;
  currency: CurrencyCode;
  /** "cancel" on an unpaid order, "refund" on a paid one. Derived, never chosen. */
  voidAction: VoidAction;
  editGate: Gate;
  voidGate: Gate;
  payGate: Gate;
  receiptBusy: boolean;
  /** `pos.delivery.manage`. Offers the internal Delivery-details editor; the
      server (pos_set_delivery_ops) re-enforces it. */
  manageDeliveryGate: Gate;
  opsEditing: boolean;
  opsBusy: boolean;
  opsError: string | null;
  onBack: () => void;
  onEdit: () => void;
  onVoid: () => void;
  onPay: () => void;
  onReceipt: () => void;
  onEditOps: () => void;
  onCancelOps: () => void;
  onSaveOps: (values: {
    handlerType: DeliveryHandlerType | null;
    personRef: string | null;
    cost: number | null;
  }) => void;
};

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[11px] font-semibold text-sub">{label}</span>
      <span className="min-w-0 truncate text-[11px] font-semibold text-ink">{value}</span>
    </div>
  );
}

export function DeliveryOrderDetail(props: DeliveryOrderDetailProps) {
  const o = props.order;
  const party = props.party ?? UNKNOWN_PARTY;
  const terminal = isTerminal(o.status);
  const currency = (o.currency as CurrencyCode) ?? props.currency;
  const total = o.total_amount ?? 0;
  const subtotal = o.subtotal ?? total;
  const discount = o.discount_amount ?? 0;
  // The canonical persisted delivery fee, already folded into `total`. Shown as
  // its own line so subtotal - discount + fee reconciles to the total on screen.
  const deliveryFee = o.delivery_fee ?? 0;
  // Internal operations. The COST and MARGIN are the business's own record - shown
  // here, never on the customer receipt. Collection follows payment status.
  const collected = isCollected(o);
  const margin = recordedMargin(o);
  const handlerType: DeliveryHandlerType | null =
    o.delivery_handler_type === "driver" || o.delivery_handler_type === "delivery_company"
      ? o.delivery_handler_type
      : null;
  const handlerLabel = handlerType === "driver" ? "Driver" : handlerType === "delivery_company" ? "Delivery Company" : null;
  const deliveredBy = o.delivery_person_ref
    ? `${o.delivery_person_ref}${handlerLabel ? ` (${handlerLabel})` : ""}`
    : handlerLabel ?? "Not recorded";

  return (
    <section aria-label="Delivery order detail" className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
      <div className="rounded-2xl border border-line bg-white p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-extrabold text-ink">
              {o.order_number ? `Order #${o.order_number}` : "Delivery order"}
            </p>
            <p className="mt-0.5 text-[11px] text-sub">
              {o.created_at ? new Date(o.created_at).toLocaleString() : ""}
            </p>
          </div>
          <Button variant="ghost" onClick={props.onBack}>
            Back
          </Button>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-1">
          <Badge tone={orderStateTone(o.status)}>{orderStateLabel(o.status)}</Badge>
          <Badge tone={paymentStateTone(o.payment_status)}>{paymentStateLabel(o.payment_status)}</Badge>
        </div>

        <div className="mt-3 space-y-0.5 border-t border-line pt-3">
          <p className="text-xs font-bold text-ink">{party.customerName ?? "Customer"}</p>
          <p className="text-[11px] text-sub">{party.customerPhone ?? "-"}</p>
          <p className="text-[11px] text-sub">{party.addressText ?? "No address on file"}</p>
        </div>

        {o.notes && (
          <div className="mt-3">
            <p className="text-[11px] font-bold text-ink">Delivery note</p>
            <p className="mt-1 rounded-lg bg-slate-50 px-3 py-2 text-[11px] text-ink">{o.notes}</p>
          </div>
        )}
      </div>

      {/* The items, as the kitchen received them. Read-only in every sense: this
          level has no control that could change a line. */}
      <div className="rounded-2xl border border-line bg-white p-4">
        <p className="text-xs font-extrabold text-ink">Items</p>
        {props.linesError ? (
          <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-[11px] font-semibold text-red-700">
            {props.linesError}
          </p>
        ) : props.linesLoading ? (
          <div className="mt-2 space-y-2">
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
          </div>
        ) : props.lines.length === 0 ? (
          <p className="mt-2 text-[11px] text-sub">No items recorded on this order.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {props.lines.map((l) => (
              <li key={l.id} className="border-b border-line/70 pb-2 last:border-0 last:pb-0">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 text-xs font-semibold text-ink">
                    {l.quantity} x {l.name}
                  </span>
                  <span className="shrink-0 text-xs font-bold tabular-nums text-ink">
                    {formatMoney(l.lineTotal, currency)}
                  </span>
                </div>
                {l.modifiers.length > 0 && (
                  <ul className="mt-0.5 space-y-0.5">
                    {l.modifiers.map((m, i) => (
                      <li key={`${l.id}-${i}`} className="text-[11px] text-sub">
                        + {m.quantity > 1 ? `${m.quantity} x ` : ""}
                        {m.name}
                        {m.priceDelta !== 0 ? ` (${formatMoney(m.priceDelta, currency)})` : ""}
                      </li>
                    ))}
                  </ul>
                )}
                {l.kitchenNote && <p className="mt-0.5 text-[11px] italic text-sub">Note: {l.kitchenNote}</p>}
              </li>
            ))}
          </ul>
        )}

        <div className="mt-3 space-y-1 border-t border-line pt-2">
          <Row label="Subtotal" value={formatMoney(subtotal, currency)} />
          {discount > 0 && <Row label="Discount" value={`- ${formatMoney(discount, currency)}`} />}
          {deliveryFee > 0 && <Row label="Delivery Fee" value={formatMoney(deliveryFee, currency)} />}
          <div className="flex items-baseline justify-between border-t border-line pt-2">
            <span className="text-sm font-semibold text-sub">Total</span>
            <span className="text-2xl font-extrabold tabular-nums text-ink">{formatMoney(total, currency)}</span>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-line bg-white p-4">
        <p className="text-xs font-extrabold text-ink">Payment</p>
        <div className="mt-2 space-y-1">
          <Row label="Status" value={paymentStateLabel(o.payment_status)} />
          {o.payment_method && <Row label="Method" value={o.payment_method} />}
          <Row label="Currency" value={currency} />
          {o.shift_id && <Row label="Shift" value={o.shift_id.slice(0, 8)} />}
        </div>
      </div>

      {/* Internal delivery operations. The delivery FEE is the customer's charge
          (also on the receipt); the delivery COST and the recorded MARGIN are the
          business's own record and are DELIBERATELY never printed on the customer
          receipt. Editing writes only through pos_set_delivery_ops, gated by
          pos.delivery.manage - never a direct pos_orders update from here. */}
      <div className="rounded-2xl border border-line bg-white p-4">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-extrabold text-ink">Delivery details</p>
          <Badge tone={collected ? "green" : "amber"}>{collected ? "Collected" : "Not collected"}</Badge>
        </div>
        <div className="mt-2 space-y-1">
          <Row label="Delivered by" value={deliveredBy} />
          <Row label="Delivery fee" value={formatMoney(deliveryFee, currency)} />
          <Row
            label="Delivery cost"
            value={o.delivery_cost == null ? "Not recorded" : formatMoney(o.delivery_cost, currency)}
          />
          <Row label="Recorded margin" value={margin == null ? "-" : formatMoney(margin, currency)} />
        </div>
        {!props.opsEditing ? (
          <GatedButton
            gate={props.manageDeliveryGate}
            variant="ghost"
            size="md"
            className="mt-3 w-full"
            onClick={props.onEditOps}
          >
            Edit delivery details
          </GatedButton>
        ) : (
          <DeliveryOpsEditor
            initial={{
              delivery_handler_type: handlerType,
              delivered_by_user_id: o.delivered_by_user_id ?? null,
              delivery_person_ref: o.delivery_person_ref ?? null,
              delivery_cost: o.delivery_cost ?? null,
            }}
            currency={currency}
            gate={props.manageDeliveryGate}
            busy={props.opsBusy}
            error={props.opsError}
            onSave={props.onSaveOps}
            onCancel={props.onCancelOps}
          />
        )}
      </div>

      <div className="space-y-2 pb-2">
        {/* Pay reuses Level 3C's settlement path in full - the same gate, the
            same dialog, the same pre-payment re-read and the same latch. There
            is no second payment implementation behind this button. Kept the
            full-size primary so it stays the obvious control. */}
        {!terminal && o.payment_status !== "paid" && (
          <GatedButton gate={props.payGate} size="lg" className="w-full" onClick={props.onPay}>
            Pay (F4)
          </GatedButton>
        )}

        {/* Edit + Print, paired to save height. "Print" (was mislabelled
            "Receipt preview") prints this order's receipt through the existing
            path - it does not open a separate preview screen. When the order is
            terminal it can only be read, so Edit is gone and Print spans the row. */}
        <div className="grid grid-cols-2 gap-2">
          {!terminal && (
            <GatedButton gate={props.editGate} variant="ghost" size="md" className="w-full" onClick={props.onEdit}>
              Edit order
            </GatedButton>
          )}
          <Button
            variant="ghost"
            size="md"
            className={terminal ? "col-span-2 w-full" : "w-full"}
            disabled={props.receiptBusy}
            onClick={props.onReceipt}
          >
            {props.receiptBusy ? "Preparing..." : "Print"}
          </Button>
        </div>

        {!terminal && (
          <>
            <GatedButton
              gate={props.voidGate}
              variant="danger"
              size="md"
              className="w-full"
              onClick={props.onVoid}
            >
              {props.voidAction === "refund" ? "Refund order" : "Cancel order"}
            </GatedButton>
            {/* Stated in words, not just as a disabled control. The commonest
                refusal here is a CLOSED shift, and an operator who only sees a
                greyed button will reasonably assume opening their own till
                fixes it - it does not, because the server locks the order's. */}
            {!props.voidGate.allowed && props.voidGate.reason && (
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] font-semibold text-amber-900">
                {props.voidGate.reason}
              </p>
            )}
          </>
        )}

        {terminal && (
          <p className="rounded-lg bg-slate-100 px-3 py-2 text-[11px] font-semibold text-sub">
            This order is {orderStateLabel(o.status).toLowerCase()}. It can be read, but not changed.
          </p>
        )}
      </div>
    </section>
  );
}
