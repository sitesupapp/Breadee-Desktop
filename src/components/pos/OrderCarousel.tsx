// The Current Order navigator: `←   #260817-0004   →`.
//
// WHAT IT REPLACED, AND WHY THAT MATTERED. Until 1.0.4 this strip showed three
// tabs labelled `Order 1`, `Order 2`, `Order 3`. Those numbers were the till's
// own invention - a slot index - and no order in the business had ever been
// called any of them. A cashier reading `Order 2` on the screen, `#260817-0004`
// on the paper and `#260817-0004` in the Orders list has three names for one
// sale and no way to tell which of them the buttons below are about to act on.
// The centre now shows the ORDER NUMBER the server issued, which is the only
// handle anybody - the kitchen, the customer, the web app, a refund - has on it.
//
// ONE SELECTED ORDER, NEVER THREE. There is a single value in the middle and it
// is the selection. Presenting several at once was the thing that made a slot
// feel like a place an order could be, rather than a view of the orders that
// actually exist.
//
// PRESENTATION ONLY. It renders what it is given and calls `onStep`. It holds no
// order, fetches nothing, and cannot change one: the collection and the
// selection both live in `state/shiftOrders.ts`, which issues nothing but reads.

import { Button } from "@/components/ui";
import { Glyph } from "@/components/Glyph";

export function OrderCarousel(props: {
  /** The selected real order's number. Null while an unsaved draft is shown. */
  orderNumber: string | null;
  /** How many REAL orders this shift holds. */
  count: number;
  /** 1-based position of the selected order within them. 0 while drafting. */
  position: number;
  /** True when the panel below is an unsaved cart rather than a saved order. */
  draft: boolean;
  /** Items in that unsaved cart, so the label says what is being held. */
  draftItemCount?: number;
  onStep: (direction: 1 | -1) => void;
}) {
  // A shift holding one order has nowhere to step to - EXCEPT from a draft,
  // which is not one of the orders and must stay reachable in both directions.
  // Both halves are the same rule: an arrow is live only when pressing it would
  // land somewhere the operator is not already.
  const disabled = props.count === 0 || (props.count === 1 && !props.draft);
  const reason = disabled
    ? props.count === 0
      ? "No orders on this shift yet"
      : "This shift has only one order"
    : null;

  return (
    <div className="shrink-0">
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 px-2"
          disabled={disabled}
          title={reason ?? "Previous order"}
          aria-label="Previous order"
          onClick={() => props.onStep(-1)}
        >
          <Glyph name="chevron-left" size={16} />
        </Button>

        <div className="flex min-w-0 flex-1 items-center justify-center">
          {props.draft ? (
            // Deliberately NOT a number. An unsaved cart has no order number,
            // and showing one - even a placeholder - is how `Order 1` happened.
            <span className="truncate rounded-lg border border-dashed border-line px-3 py-1.5 text-xs font-bold text-sub">
              New order
              {props.draftItemCount ? ` · ${props.draftItemCount} item${props.draftItemCount === 1 ? "" : "s"}` : ""}
            </span>
          ) : (
            <span
              className="truncate px-2 text-base font-extrabold tabular-nums text-ink"
              aria-live="polite"
              data-testid="current-order-number"
            >
              {props.orderNumber ? `#${props.orderNumber}` : "—"}
            </span>
          )}
        </div>

        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 px-2"
          disabled={disabled}
          title={reason ?? "Next order"}
          aria-label="Next order"
          onClick={() => props.onStep(1)}
        >
          <Glyph name="chevron-right" size={16} />
        </Button>
      </div>

      <p className="mt-1 text-center text-[11px] font-semibold text-sub">
        {props.draft
          ? props.count > 0
            ? `Not saved yet · ${props.count} order${props.count === 1 ? "" : "s"} on this shift`
            : "Not saved yet"
          : props.count > 0
            ? `Order ${props.position} of ${props.count} on this shift`
            : "No orders on this shift yet"}
      </p>
    </div>
  );
}
