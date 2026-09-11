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

import { useState, type ReactNode } from "react";
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

  // --- compact Order note (moved in from above the panel) -------------------

  /**
   * The whole-order note value, owned by the caller. OPTIONAL: only takeaway
   * carries an order-level note here (delivery has its own delivery-note box,
   * and a dine-in round uses the round panel). When omitted, no note control is
   * rendered. Persistence is unchanged - this panel only reads and writes the
   * caller's value; it creates no state of its own beyond whether the compact
   * field is expanded.
   */
  orderNote?: string;
  onOrderNoteChange?: (value: string) => void;
};

export function CartPanel(props: CartPanelProps) {
  const empty = props.lines.length === 0;
  const blocked = !props.shiftOpen;
  const discount = props.discount ?? 0;
  const total = Math.max(0, props.subtotal - discount);
  // Compact Order note: expanded automatically when a note already exists, so a
  // saved note is never hidden behind a button. Local to the panel because it is
  // pure presentation; the note VALUE lives with the caller.
  const hasNote = (props.orderNote ?? "").trim().length > 0;
  const [noteOpen, setNoteOpen] = useState(false);
  const noteShown = props.onOrderNoteChange != null && (noteOpen || hasNote);
  // Nothing to print until the server has accepted the order: a receipt for an
  // order that does not exist would carry no number, and the number is the only
  // thing anybody can look the order up by afterwards.
  const printReason = props.printReason ?? (props.savedOrderNumber ? null : "Send or pay this order first - there is nothing to print yet.");

  return (
    <section className="flex h-full min-h-0 flex-col border-l border-line bg-white" aria-label="Current order">
      <div className="shrink-0 space-y-2 border-b border-line px-4 py-2.5">
        <PanelTitle>Current order</PanelTitle>
        {props.orderCarousel}
        {props.savedOrderNumber && (
          <p className="text-xs font-semibold text-brand-dark">
            Order {props.savedOrderNumber} is saved - paying will settle this order.
          </p>
        )}
        {/* Compact Order note. Replaces the tall standalone field that used to
            sit ABOVE this panel and cost ~64px of item-list height. Collapsed to
            a one-line trigger until needed; the same value/handler as before. */}
        {props.onOrderNoteChange != null &&
          (noteShown ? (
            <input
              type="text"
              value={props.orderNote ?? ""}
              onChange={(e) => props.onOrderNoteChange?.(e.target.value)}
              placeholder="Order note - e.g. Call customer when ready"
              className="w-full rounded-lg border border-line bg-white px-3 py-1.5 text-xs text-ink placeholder:text-sub"
            />
          ) : (
            <button
              type="button"
              onClick={() => setNoteOpen(true)}
              className="flex items-center gap-1 text-xs font-semibold text-sub hover:text-ink"
            >
              <Glyph name="info" size={13} />
              Add order note
            </button>
          ))}
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
          <ul className="space-y-1.5">
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

        <div className="mb-2 space-y-0.5">
          <div className="flex items-baseline justify-between text-xs">
            <span className="font-semibold text-sub">Subtotal</span>
            <span className="font-semibold tabular-nums text-ink">{formatMoney(props.subtotal, props.currency)}</span>
          </div>
          <div className="flex items-baseline justify-between text-xs">
            <span className="font-semibold text-sub">Discount</span>
            <span className="font-semibold tabular-nums text-ink">
              {discount > 0 ? `-${formatMoney(discount, props.currency)}` : formatMoney(0, props.currency)}
            </span>
          </div>
          <div className="flex items-baseline justify-between border-t border-line pt-1">
            <span className="text-sm font-extrabold text-ink">Total</span>
            <span className="text-xl font-extrabold tabular-nums text-ink">{formatMoney(total, props.currency)}</span>
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

        {/* Compact TWO-ROW action grid (replaces four stacked 52px buttons). The
            source order stays Pay -> Send -> Print -> Clear so the action
            priority is unchanged; the grid lays them out as Pay | Send on the
            first row and Print | Clear on the second. Pay stays the strong
            primary by FILL and Clear stays the danger control, both at the 44px
            touch size (`md`). When Pay/Print are omitted (delivery add-items),
            the grid collapses to the remaining controls automatically. */}
        <div className="grid grid-cols-2 gap-2">
          {/* 1 - Pay. The primary action, in the theme's strong primary. */}
          {props.payGate && (
            <GatedButton
              gate={props.payGate}
              size="md"
              className="w-full"
              disabled={empty || props.busy || blocked}
              onClick={props.onPay}
            >
              <Glyph name="pay" size={16} />
              {props.busy ? "Working..." : "Pay"}
            </GatedButton>
          )}

          {/* 2 - Send to kitchen. Routed and printed by the EXISTING flow; this
              button calls the workspace's one submit path and nothing else. */}
          <GatedButton
            gate={props.createGate}
            variant={props.payGate ? "outline" : "primary"}
            size="md"
            className="w-full"
            disabled={empty || props.busy || blocked}
            onClick={props.onSendToKitchen}
          >
            <Glyph name="kitchen" size={16} />
            {props.busy && !props.payGate ? "Sending..." : (props.sendLabel ?? "Send to kitchen")}
          </GatedButton>

          {/* 3 - Print. The existing manual receipt path for THIS order. It does
              not pay, and it does not route anything to a kitchen. */}
          {props.onPrint && (
            <Button
              variant="ghost"
              size="md"
              className="w-full"
              disabled={Boolean(printReason) || props.printBusy || props.busy}
              title={printReason ?? undefined}
              onClick={props.onPrint}
            >
              <Glyph name="print" size={16} />
              {props.printBusy ? "Preparing..." : "Print"}
            </Button>
          )}

          {/* 4 - The destructive one, last and unmistakable. */}
          <Button
            variant="danger"
            size="md"
            className="w-full"
            disabled={empty && !props.savedOrderNumber}
            onClick={props.onNewOrder}
          >
            <Glyph name="trash" size={16} />
            {props.clearLabel ?? "Clear cart"}
          </Button>
        </div>
      </div>
    </section>
  );
}
