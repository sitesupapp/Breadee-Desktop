// The persistent cart.
//
// Contract: the totals and the primary action are pinned to the bottom and are
// visible at every supported size. The list above them scrolls; the panel itself
// never does. When a shift is not open the actions are disabled WITH the reason
// and the fix, because "why can't I press Pay" is the most expensive question a
// cashier can have to ask mid-queue.
//
// ACTION ORDER IS THE DESIGN, NOT A PREFERENCE. Pay, then Send to kitchen, then
// Print, then the destructive one - and each is full width and stacked rather
// than paired, so the button under a thumb is never the one beside the one that
// was meant. The destructive action is last and styled as destructive; it used
// to be a quiet "Clear" in the panel header, which put the only irreversible
// control on the panel in the position a header usually reserves for the least
// consequential one.
//
// EVERY ACTION HERE ACTS ON THE CART, and does so by construction rather than
// by passing an id around: this panel is only ever shown for the UNSAVED draft
// (1.0.4), so there is no order reference that could go stale between the
// navigator above and the buttons below. A saved order is rendered by
// `CurrentOrderPanel`, whose actions take that order explicitly.

import type { ReactNode } from "react";
import { Button, EmptyState, GatedButton, PanelTitle, type Gate } from "@/components/ui";
import { Glyph } from "@/components/Glyph";
import { formatMoney, type CurrencyCode } from "@/lib/currency";
import { CartLineRow } from "@/components/pos/CartLineRow";
import type { CartLine } from "@/types/pos";

export type CartPanelProps = {
  lines: CartLine[];
  selectedKey: string | null;
  currency: CurrencyCode;
  subtotal: number;
  shiftOpen: boolean;
  busy: boolean;
  savedOrderNumber: string | null;
  createGate: Gate;
  /**
   * OPTIONAL on purpose (Level 3B).
   *
   * Delivery reuses this panel - there is deliberately no second cart - but it
   * settles through its own surface. Passing a permanently-denied gate would
   * still render a Pay button, and a disabled Pay is still a Pay: it tells a
   * cashier that settling here is a thing that exists. Omitting the gate removes
   * the control from the DOM instead.
   */
  payGate?: Gate;
  onSelect: (key: string) => void;
  onAdjust: (key: string, delta: number) => void;
  onRemove: (key: string) => void;
  onEditNote: (key: string) => void;
  onSendToKitchen: () => void;
  onPay?: () => void;
  onOpenShift: () => void;
  onNewOrder: () => void;
  /** Label for the primary action. Delivery sends; it never pays. */
  sendLabel?: string;

  // --- added by the POS UI update -------------------------------------------

  /**
   * The Current Order navigator, rendered above the list.
   *
   * A node rather than the data, because only takeaway browses the shift's
   * orders from its side column - a dine-in round belongs to a table and a
   * delivery basket to a caller, and both are already reached by name.
   */
  orderCarousel?: ReactNode;
  /**
   * Manual print of the SELECTED order. Omitted where there is no such thing.
   *
   * Goes to the existing receipt service through the workspace; this panel never
   * builds or renders a document.
   */
  onPrint?: () => void;
  /** Why Print is unavailable - usually "this order has not been sent yet". */
  printReason?: string | null;
  printBusy?: boolean;
  /** Discount already applied to this order, if any. Renders only the row. */
  discount?: number;
  /** Label for the destructive action, which differs by route. */
  clearLabel?: string;
  /** Portions enabled on this terminal - decides the -/+ step and floor. */
  fractionalQuantity?: boolean;
};

export function CartPanel(props: CartPanelProps) {
  const empty = props.lines.length === 0;
  const blocked = !props.shiftOpen;
  const discount = props.discount ?? 0;
  const total = Math.max(0, props.subtotal - discount);
  // Nothing to print until the server has accepted the order: a receipt for an
  // order that does not exist would carry no number, and the number is the only
  // thing anybody can look the order up by afterwards.
  const printReason = props.printReason ?? (props.savedOrderNumber ? null : "Send or pay this order first - there is nothing to print yet.");

  return (
    <section className="flex h-full min-h-0 flex-col border-l border-line bg-white" aria-label="Current order">
      <div className="shrink-0 space-y-3 border-b border-line px-4 py-3">
        <PanelTitle>Current order</PanelTitle>
        {props.orderCarousel}
        {props.savedOrderNumber && (
          <p className="text-xs font-semibold text-brand-dark">
            Order {props.savedOrderNumber} is saved - paying will settle this order.
          </p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
        {empty ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-slate-50 text-sub">
              <Glyph name="bag" size={26} />
            </span>
            <p className="text-sm font-bold text-ink">Your cart is empty</p>
            <p className="max-w-[220px] text-xs text-sub">Add items from the menu to get started.</p>
          </div>
        ) : (
          <ul className="space-y-2">
            {props.lines.map((line) => (
              <CartLineRow
                key={line.key}
                line={line}
                selected={line.key === props.selectedKey}
                currency={props.currency}
                fractionalQuantity={props.fractionalQuantity}
                onSelect={() => props.onSelect(line.key)}
                onAdjust={(delta) => props.onAdjust(line.key, delta)}
                onRemove={() => props.onRemove(line.key)}
                onEditNote={() => props.onEditNote(line.key)}
              />
            ))}
          </ul>
        )}
      </div>

      {/* Pinned action area - never scrolls out of reach. */}
      <div className="shrink-0 border-t border-line bg-white p-3">
        {blocked && (
          <div className="mb-3 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2">
            <p className="text-xs font-bold text-amber-900">No shift is open</p>
            <p className="mt-0.5 text-xs text-amber-800">
              Orders and payments must belong to an open shift. Open one to start serving.
            </p>
            <Button className="mt-2 w-full" onClick={props.onOpenShift}>
              Open shift
            </Button>
          </div>
        )}

        <div className="mb-3 space-y-1">
          <div className="flex items-baseline justify-between text-sm">
            <span className="font-semibold text-sub">Subtotal</span>
            <span className="font-semibold tabular-nums text-ink">{formatMoney(props.subtotal, props.currency)}</span>
          </div>
          <div className="flex items-baseline justify-between text-sm">
            <span className="font-semibold text-sub">Discount</span>
            <span className="font-semibold tabular-nums text-ink">
              {discount > 0 ? `-${formatMoney(discount, props.currency)}` : formatMoney(0, props.currency)}
            </span>
          </div>
          <div className="flex items-baseline justify-between border-t border-line pt-1.5">
            <span className="text-sm font-extrabold text-ink">Total</span>
            <span className="text-2xl font-extrabold tabular-nums text-ink">{formatMoney(total, props.currency)}</span>
          </div>
        </div>

        {/* Which order these buttons will act on, said out loud. The tab strip
            is at the top of a panel that can be a screen tall, and the moment
            worth protecting is the one where a cashier reaches the bottom of it
            having forgotten which customer they came back for. */}
        {props.orderCarousel && (
          <p className="mb-2 flex items-center justify-center gap-1 text-center text-[11px] text-sub">
            <Glyph name="info" size={12} />
            Actions apply to the order shown above
          </p>
        )}

        <div className="space-y-2">
          {/* 1 - Pay. The primary action, in the theme's strong primary. */}
          {props.payGate && (
            <GatedButton
              gate={props.payGate}
              size="lg"
              className="w-full"
              disabled={empty || props.busy || blocked}
              onClick={props.onPay}
            >
              <Glyph name="pay" size={18} />
              {props.busy ? "Working..." : "Pay"}
            </GatedButton>
          )}

          {/* 2 - Send to kitchen. Routed and printed by the EXISTING flow; this
              button calls the workspace's one submit path and nothing else. */}
          <GatedButton
            gate={props.createGate}
            variant={props.payGate ? "outline" : "primary"}
            size="lg"
            className="w-full"
            disabled={empty || props.busy || blocked}
            onClick={props.onSendToKitchen}
          >
            <Glyph name="kitchen" size={18} />
            {props.busy && !props.payGate ? "Sending..." : (props.sendLabel ?? "Send to kitchen")}
          </GatedButton>

          {/* 3 - Print. The existing manual receipt path for THIS order. It does
              not pay, and it does not route anything to a kitchen. */}
          {props.onPrint && (
            <Button
              variant="ghost"
              size="lg"
              className="w-full"
              disabled={Boolean(printReason) || props.printBusy || props.busy}
              title={printReason ?? undefined}
              onClick={props.onPrint}
            >
              <Glyph name="print" size={18} />
              {props.printBusy ? "Preparing..." : "Print"}
            </Button>
          )}

          {/* 4 - The destructive one, last and unmistakable. */}
          <Button
            variant="danger"
            size="lg"
            className="w-full"
            disabled={empty && !props.savedOrderNumber}
            onClick={props.onNewOrder}
          >
            <Glyph name="trash" size={18} />
            {props.clearLabel ?? "Clear cart"}
          </Button>
        </div>
      </div>
    </section>
  );
}
