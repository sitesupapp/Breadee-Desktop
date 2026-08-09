// The persistent cart.
//
// Contract: the total and the primary action are pinned to the bottom and are
// visible at every supported size. The list above them scrolls; the panel itself
// never does. When a shift is not open the actions are disabled WITH the reason
// and the fix, because "why can't I press Pay" is the most expensive question a
// cashier can have to ask mid-queue.

import { Button, EmptyState, GatedButton, PanelTitle, type Gate } from "@/components/ui";
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
   * has no payment path at all until Level 3C. Passing a permanently-denied gate
   * would still render a Pay button, and a disabled Pay is still a Pay: it tells
   * a cashier that settling here is a thing that exists. Omitting the gate
   * removes the control from the DOM instead. Takeaway passes it and is
   * byte-for-byte unchanged.
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
};

export function CartPanel(props: CartPanelProps) {
  const empty = props.lines.length === 0;
  const blocked = !props.shiftOpen;

  return (
    <section className="flex h-full min-h-0 flex-col border-l border-line bg-white" aria-label="Current order">
      <div className="shrink-0 border-b border-line px-4 py-3">
        <PanelTitle
          right={
            !empty ? (
              <Button variant="ghost" onClick={props.onNewOrder}>
                Clear
              </Button>
            ) : undefined
          }
        >
          Current order
        </PanelTitle>
        {props.savedOrderNumber && (
          <p className="mt-1 text-xs font-semibold text-brand-dark">
            Order {props.savedOrderNumber} is saved - paying will settle this order.
          </p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
        {empty ? (
          <EmptyState
            title="No items yet"
            hint="Pick items from the menu, or press Ctrl+K to search. Items with required options open a chooser."
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

        <div className="mb-3 flex items-baseline justify-between">
          <span className="text-sm font-semibold text-sub">Subtotal</span>
          <span className="text-2xl font-extrabold tabular-nums text-ink">{formatMoney(props.subtotal, props.currency)}</span>
        </div>

        {/* One column when there is no payment action, so Delivery's Send is not
            a half-width button sitting beside a gap where Pay used to be. */}
        <div className={props.payGate ? "grid grid-cols-2 gap-2" : "grid grid-cols-1"}>
          <GatedButton
            gate={props.createGate}
            variant={props.payGate ? "ghost" : "primary"}
            size="lg"
            disabled={empty || props.busy || blocked}
            onClick={props.onSendToKitchen}
          >
            {props.busy && !props.payGate ? "Sending..." : (props.sendLabel ?? "Send to kitchen")}
          </GatedButton>
          {props.payGate && (
            <GatedButton gate={props.payGate} size="lg" disabled={empty || props.busy || blocked} onClick={props.onPay}>
              {props.busy ? "Working..." : "Pay (F4)"}
            </GatedButton>
          )}
        </div>
      </div>
    </section>
  );
}
