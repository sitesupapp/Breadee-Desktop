// The right-side Current Order panel: one shift order, in full, without leaving POS.
//
// REPLACES THE "Open orders" DROPDOWN. The first revision put this behind a
// small pill, which meant the cashier had to open something to see the order
// they had just taken. The order now occupies the panel it belongs in - the
// same right-hand column the live cart uses - and the arrows walk the shift.
//
// IT SHOWS THE WHOLE SHIFT, not just outstanding orders: paid, voided and
// refunded orders are part of what a till did, and reviewing them is the point.
// Lifecycle wording comes from the two stored fields and is never invented.
//
// 1.0.4: IT IS NOW THE TAKEAWAY CURRENT ORDER. The side column used to show a
// strip of three invented slots called `Order 1/2/3`; this panel - which was
// already the one component that knows how to render a real order - takes that
// place whenever a saved order is selected, and the cart panel keeps it while a
// new order is being built. That is why Pay and the destructive action are here
// now: an action offered beside an order must act on THAT order, and the order
// on screen is the only order this component has.
//
// BROWSING IS STILL READS-ONLY. Selecting, stepping and printing issue no
// write of any kind. The two actions that DO write - Pay and the reversal - are
// explicit presses, are handed out by the caller, and are offered only when the
// shared lifecycle rules in `orderActions.ts` say the server would accept them.

import { useEffect, useState } from "react";
import { Badge, Button, GatedButton, type Gate } from "@/components/ui";
import { Glyph } from "@/components/Glyph";
import { OrderCarousel } from "@/components/pos/OrderCarousel";
import { formatMoney, type CurrencyCode } from "@/lib/currency";
import { buildReceipt, type ReceiptData, type ReceiptOrderSource } from "@/lib/receipt";
import { readOrderReceiptLines } from "@/lib/pos/deliverySettlement";
import {
  orderLifecycleLabel,
  orderLifecycleTone,
  orderRouteLabel,
  type ShiftOpenOrder,
} from "@/lib/pos/shiftOrderSummary";
import {
  DESTRUCTIVE_ORDER_CTA,
  canSettleOrder,
  paymentLabel,
  reversalActionFor,
  reversalLabel,
} from "@/lib/pos/orderActions";

export function CurrentOrderPanel(props: {
  order: ShiftOpenOrder | null;
  count: number;
  position: number;
  hasShift: boolean;
  loading: boolean;
  error: string | null;
  tenantName: string;
  branchName: string;
  staffName: string;
  shiftId: string | null;
  fallbackCurrency: CurrencyCode;
  tableName?: string | null;
  onStep: (direction: 1 | -1) => void;
  onPresentReceipt: (receipt: ReceiptData) => void;
  /**
   * Start the reversal. The panel decides WHETHER one is offered and the
   * action's NAME; the dialog owns the reason and the mutation, so destructive
   * logic exists once.
   */
  onReverse?: (order: ShiftOpenOrder) => void;
  /** Refused reversal, in the gate's own words. Shown instead of a dead button. */
  reverseGateReason?: string | null;

  // --- 1.0.4: this panel is now the takeaway Current Order ------------------

  /**
   * Settle THIS order. Omitted where settlement is not this surface's job -
   * the Orders modal, which has its own row actions.
   *
   * Whether it is OFFERED is `canSettleOrder`, the shared lifecycle rule, so an
   * order that is already paid, voided or refunded shows no Pay at all rather
   * than a button the server would refuse. That is the second accidental
   * settlement, prevented where the operator can see why.
   */
  onPay?: (order: ShiftOpenOrder) => void;
  payGate?: Gate;
  payBusy?: boolean;
  /** Leave the saved order and go back to building a new one. */
  onNewOrder?: () => void;
}) {
  const [preparing, setPreparing] = useState(false);
  const [printError, setPrintError] = useState<string | null>(null);
  const order = props.order;

  if (!props.hasShift) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center">
        <div>
          <p className="text-sm font-bold text-ink">No active shift</p>
          <p className="mt-1 text-xs text-sub">Open a shift to start taking orders.</p>
        </div>
      </div>
    );
  }

  const currency = (order?.currency ?? props.fallbackCurrency) as CurrencyCode;
  // Null for a terminal order - nothing further can be done to it.
  const reversal = order ? reversalActionFor(order) : null;
  // The lifecycle's own answer, not this screen's. A paid order offers no Pay.
  const settleable = order ? canSettleOrder(order) : false;

  /**
   * Build the selected order's receipt from the SERVER's rows and present it.
   * An unpaid order previews as Unpaid: no method, tendered or change is
   * invented, exactly as the historical reprint path behaves.
   */
  const print = async () => {
    if (!order || preparing) return;
    setPreparing(true);
    setPrintError(null);
    try {
      const lines = await readOrderReceiptLines(order.id);
      const source = (["takeaway", "dine_in", "delivery"].includes(order.order_type)
        ? order.order_type
        : "takeaway") as ReceiptOrderSource;
      props.onPresentReceipt(
        buildReceipt({
          businessName: props.tenantName,
          branchName: props.branchName,
          orderType: orderRouteLabel(order.order_type),
          orderSource: source,
          staffName: props.staffName,
          orderNumber: order.order_number ?? order.id.slice(0, 8),
          at: order.created_at ? new Date(order.created_at).toLocaleString() : new Date().toLocaleString(),
          paid: order.payment_status === "paid",
          method: null,
          // The order's OWN currency snapshot - the same source-of-truth rule
          // the delivery receipt fix establishes. Never a display currency.
          currency,
          lines,
          subtotal: order.subtotal ?? order.total_amount ?? 0,
          discount: order.discount_amount,
          total: order.total_amount ?? 0,
          shiftRef: props.shiftId ? props.shiftId.slice(0, 8) : null,
          tableName: order.order_type === "dine_in" ? props.tableName ?? null : null,
          customerName: order.order_type === "delivery" ? order.customer_name : null,
        }),
      );
    } catch (e) {
      setPrintError(e instanceof Error ? e.message : "The order could not be read for printing.");
    } finally {
      setPreparing(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* The ONE navigator, shared with the draft panel, so the operator sees
          the same control whichever of the two is on screen. */}
      <div className="shrink-0 border-b border-line px-3 py-2">
        <OrderCarousel
          orderNumber={order ? (order.order_number ?? order.id.slice(0, 8)) : null}
          count={props.count}
          position={props.position}
          draft={false}
          onStep={props.onStep}
        />
      </div>

      {props.error && (
        <p className="m-3 rounded-lg bg-red-50 px-2 py-1 text-[11px] font-semibold text-red-700">{props.error}</p>
      )}

      {!order && !props.error && (
        <div className="flex flex-1 items-center justify-center p-6 text-center">
          <p className="text-xs text-sub">{props.loading ? "Loading this shift's orders..." : "No orders on this shift yet."}</p>
        </div>
      )}

      {order && (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          <div className="flex flex-wrap items-center gap-1">
            <Badge tone="slate">{orderRouteLabel(order.order_type)}</Badge>
            <Badge tone={orderLifecycleTone(order)}>{orderLifecycleLabel(order)}</Badge>
            {/* The PAYMENT state on its own badge, always - it is the field
                every action below is gated on, so it must never be something
                the operator has to infer from the lifecycle word beside it. */}
            <Badge tone={order.payment_status === "paid" ? "green" : order.payment_status === "refunded" ? "red" : "amber"}>
              {paymentLabel(order)}
            </Badge>
          </div>
          <p className="mt-1 text-[11px] text-sub">
            {order.created_at ? new Date(order.created_at).toLocaleString() : ""}
            {order.order_type === "delivery" && order.customer_name ? ` · ${order.customer_name}` : ""}
            {order.order_type === "dine_in" && props.tableName ? ` · ${props.tableName}` : ""}
          </p>
          {order.notes && <p className="mt-1 text-[11px] italic text-sub">{order.notes}</p>}

          <OrderLines orderId={order.id} currency={currency} />

          <div className="mt-3 space-y-1 border-t border-line pt-2 text-[12px]">
            <div className="flex justify-between text-sub">
              <span>Subtotal</span>
              <span>{formatMoney(order.subtotal ?? order.total_amount ?? 0, currency)}</span>
            </div>
            {order.discount_amount > 0 && (
              <div className="flex justify-between text-sub">
                <span>Discount</span>
                <span>-{formatMoney(order.discount_amount, currency)}</span>
              </div>
            )}
            {/* `formatMoney` already names the currency - "200,000 LBP" for LBP,
                and the "$" sigil for USD - so the code span that used to sit here
                printed it twice: "200,000 LBP LBP". Every other total in the app
                (cart, orders table, shift report) renders bare formatMoney; this
                was the only place that appended a second label. */}
            <div className="flex justify-between text-sm font-extrabold text-ink">
              <span>Total</span>
              <span>{formatMoney(order.total_amount ?? 0, currency)}</span>
            </div>
          </div>

          {printError && (
            <p className="mt-2 rounded-lg bg-red-50 px-2 py-1 text-[11px] font-semibold text-red-700">{printError}</p>
          )}
        </div>
      )}

      {order && (
        <div className="shrink-0 space-y-2 border-t border-line p-3">
          {/* 1 - Pay. Offered only while the lifecycle says this order can still
              be settled, so the control that could take a customer's money a
              second time is not on screen for an order that is already paid. */}
          {props.onPay && settleable && (
            <GatedButton
              gate={props.payGate ?? { allowed: true, reason: null }}
              size="lg"
              className="w-full"
              disabled={props.payBusy}
              onClick={() => props.onPay?.(order)}
            >
              <Glyph name="pay" size={18} />
              {props.payBusy ? "Working..." : "Pay"}
            </GatedButton>
          )}

          {/* 2 - Print. The manual receipt for THIS order and nothing else. */}
          <Button variant="ghost" className="w-full" disabled={preparing} onClick={() => void print()}>
            {preparing ? "Preparing..." : "Print"}
          </Button>

          {/* 3 - Start the next customer. The saved order is left exactly as it
              is; this only stops looking at it. */}
          {props.onNewOrder && (
            <Button variant="outline" className="w-full" onClick={props.onNewOrder}>
              New order
            </Button>
          )}

          {/* 4 - The destructive one, last. It says `Delete / Void` because the
              thing an operator has to distinguish here is "this reaches a real
              order" from the draft panel's "Clear cart"; WHICH reversal it
              performs is named directly beneath it and again in the
              confirmation. It appears only when the order's own state permits
              one, so a voided, cancelled or refunded order offers nothing. */}
          {reversal && props.onReverse && (
            <div>
              <Button variant="danger" className="w-full" onClick={() => props.onReverse?.(order)}>
                <Glyph name="trash" size={18} />
                {DESTRUCTIVE_ORDER_CTA}
              </Button>
              <p className="mt-1 text-center text-[11px] text-sub">{reversalLabel(reversal)}</p>
            </div>
          )}
          {reversal && props.reverseGateReason && (
            <p className="rounded-lg bg-slate-100 px-2 py-1 text-[11px] text-sub">{props.reverseGateReason}</p>
          )}
        </div>
      )}
    </div>
  );
}

/** The selected order's lines, re-read per selection rather than cached. */
function OrderLines(props: { orderId: string; currency: CurrencyCode }) {
  const [lines, setLines] = useState<Awaited<ReturnType<typeof readOrderReceiptLines>> | null>(null);
  useEffect(() => {
    let live = true;
    setLines(null);
    readOrderReceiptLines(props.orderId)
      .then((l) => {
        if (live) setLines(l);
      })
      .catch(() => {
        if (live) setLines([]);
      });
    return () => {
      live = false;
    };
  }, [props.orderId]);

  if (lines === null) return <p className="mt-2 text-[11px] text-sub">Loading items...</p>;
  if (lines.length === 0) return <p className="mt-2 text-[11px] text-sub">No items readable for this order.</p>;
  return (
    <ul className="mt-2 space-y-1">
      {lines.map((l, i) => (
        <li key={`${l.name}-${i}`} className="text-[12px]">
          <div className="flex justify-between gap-2">
            <span className="min-w-0">
              {l.qty}x {l.name}
            </span>
            <span className="shrink-0">{formatMoney(l.lineTotal, props.currency)}</span>
          </div>
          {l.modifiers?.map((m) => (
            <p key={m.name} className="pl-3 text-[11px] text-sub">
              + {m.name}
            </p>
          ))}
          {l.note && <p className="pl-3 text-[11px] italic text-sub">{l.note}</p>}
        </li>
      ))}
    </ul>
  );
}
