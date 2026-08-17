// The takeaway order strip: `< Order 1  Order 2  Order 3 >`.
//
// PRESENTATION ONLY. Every decision this renders - which slot is live, whether
// one holds anything, whether switching is allowed at all - comes from
// `state/takeawayOrders.ts`. The strip has no opinion of its own, because an
// opinion about which order is selected is the thing that must not exist twice.
//
// A USED SLOT SAYS SO. An operator returning to the till after serving someone
// else needs to know which tabs have a customer behind them before pressing one,
// so a slot that holds lines or an accepted order is marked - and a slot holding
// an order the server has accepted shows its NUMBER, which is the only handle
// anyone has on that money.

import { Button, cn } from "@/components/ui";
import { Glyph } from "@/components/Glyph";
import type { TakeawaySlotSummary } from "@/state/takeawayOrders";

export function OrderTabs(props: {
  slots: TakeawaySlotSummary[];
  /** 0-based index of the live slot. */
  index: number;
  /** Why switching is refused right now, if it is. Shown on hover. */
  disabledReason?: string | null;
  onSelect: (index: number) => void;
  onStep: (direction: 1 | -1) => void;
}) {
  const disabled = Boolean(props.disabledReason);
  const active = props.slots[props.index];

  return (
    <div className="shrink-0">
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 px-2"
          disabled={disabled}
          title={props.disabledReason ?? "Previous order"}
          aria-label="Previous order"
          onClick={() => props.onStep(-1)}
        >
          <Glyph name="chevron-left" size={16} />
        </Button>

        {/* The tabs themselves. `overflow-x-auto` rather than wrapping: the
            strip must stay one row tall at every supported width, because the
            panel below it is what actually needs the vertical space. */}
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {props.slots.map((slot, i) => {
            const isActive = i === props.index;
            return (
              <button
                key={slot.position}
                type="button"
                disabled={disabled && !isActive}
                aria-current={isActive ? "true" : undefined}
                title={
                  disabled && !isActive
                    ? (props.disabledReason ?? undefined)
                    : slot.orderNumber
                      ? `Order ${slot.orderNumber} - sent, not yet paid`
                      : slot.used
                        ? `${slot.itemCount} item${slot.itemCount === 1 ? "" : "s"} waiting`
                        : "Empty order"
                }
                onClick={() => props.onSelect(i)}
                className={cn(
                  "relative min-h-[36px] flex-1 whitespace-nowrap rounded-lg border px-3 text-xs font-bold transition",
                  isActive
                    ? "border-brand bg-brand-soft text-brand-dark"
                    : "border-line bg-white text-sub hover:text-ink disabled:cursor-not-allowed disabled:opacity-50",
                )}
              >
                Order {slot.position}
                {/* A dot, not a count: the tab is 60px wide and the number of
                    items in an order nobody is looking at is not a decision. */}
                {slot.used && !isActive && (
                  <span
                    aria-hidden
                    className="absolute right-1.5 top-1.5 inline-block h-1.5 w-1.5 rounded-full bg-brand"
                  />
                )}
              </button>
            );
          })}
        </div>

        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 px-2"
          disabled={disabled}
          title={props.disabledReason ?? "Next order"}
          aria-label="Next order"
          onClick={() => props.onStep(1)}
        >
          <Glyph name="chevron-right" size={16} />
        </Button>
      </div>

      <p className="mt-1.5 text-center text-[11px] font-semibold text-sub">
        Viewing Order {props.index + 1} of {props.slots.length}
        {active?.orderNumber ? ` · #${active.orderNumber}` : ""}
      </p>

      {props.disabledReason && (
        <p className="mt-1 rounded-lg bg-slate-100 px-2 py-1 text-center text-[11px] text-sub">{props.disabledReason}</p>
      )}
    </div>
  );
}
