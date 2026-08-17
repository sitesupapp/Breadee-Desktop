// The Orders workspace: every order for a chosen day and shift, in one table.
//
// A MODAL, NOT A ROUTE. The cashier is mid-service; taking the POS away to look
// something up is how a till gets abandoned with a cart half-built. It opens
// over the workspace, dims it, and closes back to exactly where they were.
//
// THE DEFAULT SCOPE IS THE ACTIVE SHIFT, which is also what the top-bar badge
// counts - so the number beside End shift and the rows behind it are the same
// answer to the same question. Widening to the whole day is a deliberate act by
// the operator, and it can only ever show what RLS already lets them read.
//
// EVERY ACTION IS THE LIFECYCLE'S, NOT THIS SCREEN'S. Which actions a row
// offers comes from `orderActions.ts`, so a terminal order shows no Cancel here
// for the same reason it shows none in the Current Order panel. Nothing is
// enabled to match a layout.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Badge, Button, Input, cn } from "@/components/ui";
import { Modal } from "@/components/overlays";
import { formatMoney, type CurrencyCode } from "@/lib/currency";
import {
  loadOrdersForDay,
  orderLifecycleLabel,
  orderLifecycleTone,
  orderRouteLabel,
  shiftDay,
  toDayKey,
  type ShiftOpenOrder,
} from "@/lib/pos/shiftOrderSummary";
import { canEditOrder, paymentLabel, reversalActionFor, typeLabel } from "@/lib/pos/orderActions";

/** The lifecycle values the desktop can actually be shown, plus "everything". */
const STATUS_FILTERS = [
  { key: "all", label: "All statuses" },
  { key: "sent_to_kitchen", label: "Sent to kitchen" },
  { key: "completed", label: "Completed" },
  { key: "voided", label: "Voided" },
  { key: "cancelled", label: "Cancelled" },
  { key: "refunded", label: "Refunded" },
] as const;

const TYPE_FILTERS = [
  { key: "all", label: "All types" },
  { key: "takeaway", label: "Takeaway" },
  { key: "dine_in", label: "Dine-In" },
  { key: "delivery", label: "Delivery" },
] as const;

export function OrdersModal(props: {
  open: boolean;
  onClose: () => void;
  tenantId: string | null;
  branchId: string | null;
  shiftId: string | null;
  currency: CurrencyCode;
  tableNameFor: (tableId: string | null) => string | null;
  /** Current-shift orders, already loaded by the shared store. */
  shiftOrders: ShiftOpenOrder[];
  selectedOrderId: string | null;
  onSelectOrder: (orderId: string) => void;
  onPrintOrder: (order: ShiftOpenOrder) => void;
  onEditOrder?: (order: ShiftOpenOrder) => void;
  onReverseOrder: (order: ShiftOpenOrder) => void;
  /**
   * The selected order, in full, beside the table.
   *
   * Passed in rather than built here so the ONE panel that knows how to render
   * an order - lines, totals, lifecycle, its manual receipt and its reversal -
   * is the one that renders it, wherever the operator opened it from. Before
   * this, "View" selected the row and CLOSED the modal so the workspace's side
   * panel could show it; the approved design gives that side panel to the live
   * cart and its order strip, so the detail belongs here, where the operator
   * already is.
   */
  detail?: ReactNode;
}) {
  const [day, setDay] = useState(() => toDayKey(new Date()));
  const [scope, setScope] = useState<"shift" | "day">("shift");
  const [type, setType] = useState<string>("all");
  const [status, setStatus] = useState<string>("all");
  const [dayOrders, setDayOrders] = useState<ShiftOpenOrder[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const today = toDayKey(new Date());
  // The active shift is only a meaningful scope for today - browsing back to
  // last week and calling it "current shift" would be a lie about the rows.
  const shiftScopeAvailable = Boolean(props.shiftId) && day === today;

  useEffect(() => {
    if (!props.open) return;
    if (!shiftScopeAvailable && scope === "shift") setScope("day");
  }, [props.open, shiftScopeAvailable, scope]);

  // The whole day is fetched only when asked for; the shift's own orders are
  // already in the shared store and are never re-queried here.
  useEffect(() => {
    if (!props.open || scope !== "day") return;
    let live = true;
    setLoading(true);
    setError(null);
    loadOrdersForDay({ tenantId: props.tenantId, branchId: props.branchId, day })
      .then((rows) => {
        if (live) setDayOrders(rows);
      })
      .catch((e: unknown) => {
        if (live) {
          setDayOrders([]);
          setError(e instanceof Error ? e.message : "The day's orders could not be loaded.");
        }
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [props.open, scope, day, props.tenantId, props.branchId]);

  const source = scope === "shift" ? props.shiftOrders : (dayOrders ?? []);
  const rows = useMemo(
    () =>
      [...source]
        .filter((o) => (type === "all" ? true : o.order_type === type))
        .filter((o) => (status === "all" ? true : o.status === status))
        .reverse(),
    [source, type, status],
  );

  if (!props.open) return null;

  return (
    <Modal open title="Orders" size="lg" onClose={props.onClose}>
      <div className="space-y-3">
        {/* Date + scope. */}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" className="px-2" onClick={() => setDay((d) => shiftDay(d, -1))} title="Previous day">
            ‹
          </Button>
          <Input type="date" value={day} onChange={(e) => setDay(e.target.value)} className="w-[160px]" />
          <Button variant="ghost" className="px-2" onClick={() => setDay((d) => shiftDay(d, 1))} title="Next day">
            ›
          </Button>
          <Button variant={day === today ? "subtle" : "ghost"} onClick={() => setDay(today)}>
            Today
          </Button>

          <select
            value={scope}
            onChange={(e) => setScope(e.target.value as "shift" | "day")}
            className="h-9 rounded-lg border border-line bg-white px-2 text-sm"
            aria-label="Shift scope"
          >
            <option value="shift" disabled={!shiftScopeAvailable}>
              Current shift
            </option>
            <option value="day">All shifts (this day)</option>
          </select>
        </div>

        {/* Type + status. */}
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="h-9 rounded-lg border border-line bg-white px-2 text-sm"
            aria-label="Order type"
          >
            {TYPE_FILTERS.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </select>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="h-9 rounded-lg border border-line bg-white px-2 text-sm"
            aria-label="Order status"
          >
            {STATUS_FILTERS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
          <span className="text-[11px] text-sub">
            {rows.length} order{rows.length === 1 ? "" : "s"}
          </span>
        </div>

        {error && <p className="rounded-lg bg-red-50 px-2 py-1 text-[11px] font-semibold text-red-700">{error}</p>}

        <div className={cn("gap-3", props.detail ? "grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_340px]" : "block")}>
        <div className="max-h-[52vh] min-w-0 overflow-auto rounded-xl border border-line">
          <table className="w-full text-left text-[12px]">
            <thead className="sticky top-0 bg-slate-50 text-[10px] uppercase tracking-wide text-sub">
              <tr>
                <th className="px-2 py-2">Order #</th>
                <th className="px-2 py-2">Time</th>
                <th className="px-2 py-2">Type</th>
                <th className="px-2 py-2">Staff</th>
                <th className="px-2 py-2 text-right">Total</th>
                <th className="px-2 py-2">Payment</th>
                <th className="px-2 py-2">Status</th>
                <th className="px-2 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={8} className="px-2 py-6 text-center text-sub">
                    Loading orders...
                  </td>
                </tr>
              )}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-2 py-6 text-center text-sub">
                    No orders match these filters.
                  </td>
                </tr>
              )}
              {!loading &&
                rows.map((o) => {
                  const reversal = reversalActionFor(o);
                  const editable = canEditOrder(o);
                  return (
                    <tr
                      key={o.id}
                      className={cn("border-t border-line", o.id === props.selectedOrderId && "bg-brand-soft")}
                    >
                      <td className="px-2 py-2 font-bold text-ink">#{o.order_number ?? o.id.slice(0, 8)}</td>
                      <td className="px-2 py-2 text-sub">
                        {o.created_at ? new Date(o.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}
                      </td>
                      <td className="px-2 py-2">{typeLabel(o, props.tableNameFor(o.table_id))}</td>
                      <td className="px-2 py-2 text-sub">{o.staff_name ?? "—"}</td>
                      <td className="px-2 py-2 text-right font-semibold">
                        {formatMoney(o.total_amount ?? 0, (o.currency ?? props.currency) as CurrencyCode)}
                      </td>
                      <td className="px-2 py-2">
                        <Badge tone={o.payment_status === "paid" ? "green" : o.payment_status === "refunded" ? "red" : "amber"}>
                          {paymentLabel(o)}
                        </Badge>
                      </td>
                      <td className="px-2 py-2">
                        <Badge tone={orderLifecycleTone(o)}>{orderLifecycleLabel(o)}</Badge>
                      </td>
                      <td className="px-2 py-2">
                        <div className="flex justify-end gap-1">
                          {/* Selects, and STAYS. The detail pane beside this
                              table is what View now reveals, so an operator
                              comparing two orders no longer has to reopen the
                              workspace between them. */}
                          <Button
                            variant="ghost"
                            className="px-2 py-1 text-[11px]"
                            onClick={() => props.onSelectOrder(o.id)}
                          >
                            View
                          </Button>
                          {editable && props.onEditOrder && (
                            <Button variant="ghost" className="px-2 py-1 text-[11px]" onClick={() => props.onEditOrder?.(o)}>
                              Edit
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
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>

        {props.detail && (
          <div className="max-h-[52vh] min-h-[260px] overflow-hidden rounded-xl border border-line bg-white">
            {props.detail}
          </div>
        )}
        </div>

        <p className="text-[11px] text-sub">
          {scope === "shift"
            ? "This shift's orders. Switch to “All shifts” to review the whole day."
            : "Every order this terminal can read for the selected day."}
        </p>
      </div>
    </Modal>
  );
}
