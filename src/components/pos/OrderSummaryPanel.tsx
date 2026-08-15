// The Order Summary panel: the active shift's open orders, one at a time.
//
// A COMPACT OVERLAY, NOT A FOURTH WORKSPACE. Collapsed it is one pill -
// "Open orders N" - and expanded it is one card over the top-right corner of
// the work area, so the ordering surface underneath stays usable in every mode.
// It reads; it never mutates. The one side effect it can start - Print - goes
// through the SAME store-owned receipt preview every other route uses, where
// the operator still has to confirm the named printer before paper exists.
//
// WHY PRINT PRESENTS THE PREVIEW instead of printing directly: the preview
// modal already owns the whole manual-print contract - route resolution, the
// confirmation that names order/printer/queue/width/copies, the no-retry rule,
// and honest unpaid rendering. A second print path here would be a second copy
// of those decisions, and the first place they could drift.

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button } from "@/components/ui";
import { formatMoney } from "@/lib/currency";
import type { CurrencyCode } from "@/lib/currency";
import { buildReceipt, type ReceiptData, type ReceiptOrderSource } from "@/lib/receipt";
import { readOrderReceiptLines } from "@/lib/pos/deliverySettlement";
import {
  loadShiftOpenOrders,
  nextOrderIndex,
  orderRouteLabel,
  previousOrderIndex,
  stableSelectionIndex,
  type ShiftOpenOrder,
} from "@/lib/pos/shiftOrderSummary";

export function OrderSummaryPanel(props: {
  tenantId: string | null;
  shiftId: string | null;
  tenantName: string;
  branchName: string;
  staffName: string;
  fallbackCurrency: CurrencyCode;
  /**
   * Present a receipt for MANUAL printing. Wired to the store-owned preview
   * layer directly - deliberately NOT the auto-print wrapper, so browsing the
   * summary can never produce paper by itself.
   */
  onPresentReceipt: (receipt: ReceiptData) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [orders, setOrders] = useState<ShiftOpenOrder[]>([]);
  const [index, setIndex] = useState(-1);
  const [loading, setLoading] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The id survives refreshes; the index is only its fallback.
  const selectedIdRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await loadShiftOpenOrders({ tenantId: props.tenantId, shiftId: props.shiftId });
      setOrders(list);
      setIndex((prev) => stableSelectionIndex(selectedIdRef.current, prev, list));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Open orders could not be loaded.");
      setOrders([]);
      setIndex(-1);
    } finally {
      setLoading(false);
    }
  }, [props.tenantId, props.shiftId]);

  // Refresh when the shift changes (including opening/closing one) and when
  // the operator expands the panel - the moment they are about to read it.
  useEffect(() => {
    selectedIdRef.current = null;
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (expanded) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  const selected = index >= 0 && index < orders.length ? orders[index] : null;
  selectedIdRef.current = selected?.id ?? null;

  const step = useCallback(
    (direction: 1 | -1) => {
      setIndex((prev) => {
        const next = direction === 1 ? nextOrderIndex(prev, orders.length) : previousOrderIndex(prev, orders.length);
        selectedIdRef.current = next >= 0 ? (orders[next]?.id ?? null) : null;
        return next;
      });
    },
    [orders],
  );

  /**
   * Build the selected order's receipt from the SERVER's rows and hand it to
   * the preview. Reads only: the order as stored, its lines, its snapshot
   * currency. An unpaid order previews as Unpaid - no method, no tendered, no
   * change is invented, exactly as the historical reprint path behaves.
   */
  const print = useCallback(async () => {
    const order = selected;
    if (!order || preparing) return;
    setPreparing(true);
    setError(null);
    try {
      const lines = await readOrderReceiptLines(order.id);
      const source = (["takeaway", "dine_in", "delivery"].includes(order.order_type) ? order.order_type : "takeaway") as ReceiptOrderSource;
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
          currency: (order.currency ?? props.fallbackCurrency) as CurrencyCode,
          lines,
          subtotal: order.subtotal ?? order.total_amount ?? 0,
          discount: order.discount_amount,
          total: order.total_amount ?? 0,
          shiftRef: props.shiftId ? props.shiftId.slice(0, 8) : null,
          customerName: order.order_type === "delivery" ? order.customer_name : null,
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "The order could not be read for printing.");
    } finally {
      setPreparing(false);
    }
  }, [selected, preparing, props]);

  // No active shift: an honest empty pill, never someone else's orders.
  if (!props.shiftId) {
    return (
      <div className="rounded-full border border-line bg-white/95 px-3 py-1 text-[11px] font-semibold text-sub shadow-sm">
        No active shift
      </div>
    );
  }

  const count = orders.length;
  const arrowsDisabled = count <= 1;

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex items-center gap-2 rounded-full border border-line bg-white/95 px-3 py-1 text-[11px] font-bold text-ink shadow-sm hover:bg-slate-50"
        title={expanded ? "Hide order summary" : "Show order summary"}
      >
        Open orders {count}
        <span className="text-sub">{expanded ? "▴" : "▾"}</span>
      </button>

      {expanded && (
        <div className="w-[320px] rounded-xl border border-line bg-white p-3 shadow-lg">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              <Button variant="ghost" className="px-2" disabled={arrowsDisabled} onClick={() => step(-1)} title="Previous open order">
                ←
              </Button>
              <Button variant="ghost" className="px-2" disabled={arrowsDisabled} onClick={() => step(1)} title="Next open order">
                →
              </Button>
              {count > 1 && selected && <span className="text-[11px] text-sub">{index + 1} of {count}</span>}
            </div>
            <Button variant="ghost" className="px-2" disabled={loading} onClick={() => void refresh()}>
              {loading ? "..." : "Refresh"}
            </Button>
          </div>

          {error && <p className="mt-2 rounded-lg bg-red-50 px-2 py-1 text-[11px] font-semibold text-red-700">{error}</p>}

          {!selected && !error && (
            <p className="mt-2 py-4 text-center text-[12px] text-sub">
              {loading ? "Loading open orders..." : "No open orders on this shift."}
            </p>
          )}

          {selected && (
            <div className="mt-2 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-sm font-extrabold">#{selected.order_number ?? selected.id.slice(0, 8)}</p>
                <div className="flex gap-1">
                  <Badge tone="slate">{orderRouteLabel(selected.order_type)}</Badge>
                  <Badge tone={selected.payment_status === "paid" ? "green" : "amber"}>{selected.payment_status}</Badge>
                </div>
              </div>
              <p className="text-[11px] text-sub">
                {selected.status.replaceAll("_", " ")}
                {selected.created_at ? ` · ${new Date(selected.created_at).toLocaleTimeString()}` : ""}
                {selected.order_type === "delivery" && selected.customer_name ? ` · ${selected.customer_name}` : ""}
              </p>
              {selected.notes && <p className="text-[11px] italic text-sub">{selected.notes}</p>}
              <SelectedOrderLines orderId={selected.id} currency={(selected.currency ?? props.fallbackCurrency) as CurrencyCode} />
              <div className="flex items-center justify-between border-t border-line pt-2">
                <p className="text-sm font-bold">
                  {formatMoney(selected.total_amount ?? 0, (selected.currency ?? props.fallbackCurrency) as CurrencyCode)}{" "}
                  <span className="text-[11px] font-semibold text-sub">{selected.currency ?? props.fallbackCurrency}</span>
                </p>
                <Button variant="ghost" disabled={preparing} onClick={() => void print()}>
                  {preparing ? "Preparing..." : "Print"}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The selected order's lines, read fresh per selection. Kept as its own
 * component so browsing between orders re-reads the SERVER rather than caching
 * a mix of stale lines under a fresh header.
 */
function SelectedOrderLines(props: { orderId: string; currency: CurrencyCode }) {
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

  if (lines === null) return <p className="text-[11px] text-sub">Loading items...</p>;
  if (lines.length === 0) return <p className="text-[11px] text-sub">No items readable for this order.</p>;
  return (
    <ul className="max-h-40 space-y-1 overflow-y-auto">
      {lines.map((l, i) => (
        <li key={`${l.name}-${i}`} className="text-[12px]">
          <div className="flex justify-between">
            <span>
              {l.qty}x {l.name}
            </span>
            <span>{formatMoney(l.lineTotal, props.currency)}</span>
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
