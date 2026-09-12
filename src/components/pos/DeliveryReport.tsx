// The read-only Delivery report (BI6), lightweight for the desktop.
//
// It renders EXACTLY what `pos_delivery_report` returns - the server computes both
// the rows and the summary (Total Deliveries, Total Delivery Fees, Cost Entered,
// Recorded Delivery Cost, Recorded Delivery Margin), business-day- and OU-scoped,
// gated on `pos.reports.view`. There is NO client aggregation here: the desktop
// never re-sums fees or re-derives a margin. Every money figure is the server's,
// keyed on the order's own currency; a mixed-currency range shows a bare number
// rather than inventing a rate.
//
// Two ranges, per the brief: Today (the default) and Between Two Dates. Cancelled,
// voided and refunded orders are excluded server-side.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, GatedButton, Input, Skeleton, type Gate } from "@/components/ui";
import { formatMoney, type CurrencyCode, type OperationalCurrencyCode } from "@/lib/currency";
import { loadDeliveryReport, type DeliveryReport as Report } from "@/lib/pos/deliveryOrderManagement";

const pad = (n: number) => String(n).padStart(2, "0");
const fmtDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => fmtDay(new Date());
const shortDate = (d: string | null) =>
  d ? new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "-";

/** Server currency snapshot drives formatting; MIXED (or none) shows a bare number. */
function money(ccy: string | null, amount: number | null | undefined): string {
  if (amount == null) return "-";
  if (!ccy || ccy === "MIXED") return amount.toLocaleString();
  return formatMoney(amount, ccy as CurrencyCode);
}

const handlerLabel = (t: "driver" | "delivery_company" | null) =>
  t === "driver" ? "Driver" : t === "delivery_company" ? "Company" : null;

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-line bg-white p-3">
      <p className="text-[11px] font-semibold text-sub">{label}</p>
      <p className="mt-1 text-lg font-extrabold tabular-nums text-ink">{value}</p>
    </div>
  );
}

export function DeliveryReport(props: { gate: Gate; currency: OperationalCurrencyCode; branchId: string | null }) {
  const [from, setFrom] = useState(todayStr());
  const [to, setTo] = useState(todayStr());
  const [applied, setApplied] = useState<{ from: string; to: string }>({ from: todayStr(), to: todayStr() });
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rangeError, setRangeError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!props.gate.allowed) {
      setLoading(false);
      setError(props.gate.reason ?? "You do not have permission to view POS reports.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const r = await loadDeliveryReport({ from: applied.from, to: applied.to, branch: props.branchId });
      setReport(r);
    } catch (e) {
      setReport(null);
      setError(e instanceof Error ? e.message : "Could not load the delivery report.");
    } finally {
      setLoading(false);
    }
  }, [applied, props.branchId, props.gate.allowed, props.gate.reason]);

  useEffect(() => {
    void load();
  }, [load]);

  function applyRange() {
    if (from > to) {
      setRangeError("From date cannot be after To date.");
      return;
    }
    setRangeError(null);
    setApplied({ from, to });
  }
  function applyToday() {
    const t = todayStr();
    setFrom(t);
    setTo(t);
    setRangeError(null);
    setApplied({ from: t, to: t });
  }

  const s = report?.summary;
  const rows = useMemo(() => report?.rows ?? [], [report]);
  const ccy = report?.currency ?? null;
  const mixed = ccy === "MIXED";
  const isToday = applied.from === applied.to && applied.from === todayStr();
  const periodLabel = applied.from === applied.to ? applied.from : `${applied.from} -> ${applied.to}`;

  return (
    <section aria-label="Delivery report" className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
      <div className="rounded-2xl border border-line bg-white p-4">
        <div className="flex flex-wrap items-end gap-2">
          <Button variant={isToday ? "primary" : "ghost"} size="md" onClick={applyToday}>
            Today
          </Button>
          <div>
            <label className="block text-[11px] font-semibold text-sub">From</label>
            <Input type="date" value={from} max={todayStr()} onChange={(e) => setFrom(e.target.value || todayStr())} className="mt-0.5" />
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-sub">To</label>
            <Input type="date" value={to} max={todayStr()} onChange={(e) => setTo(e.target.value || todayStr())} className="mt-0.5" />
          </div>
          <Button variant="primary" size="md" onClick={applyRange}>
            Apply
          </Button>
        </div>
        {rangeError && <p className="mt-2 text-[11px] font-semibold text-amber-800">{rangeError}</p>}
        <p className="mt-2 text-xs font-extrabold text-ink">{periodLabel}</p>
      </div>

      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      ) : error ? (
        <div className="rounded-2xl border border-line bg-white p-6 text-center text-sm font-semibold text-red-700">
          {error}
        </div>
      ) : report && s ? (
        <>
          {/* Summary. Recorded figures cover ONLY orders that have a Delivery Cost. */}
          <div className="grid grid-cols-2 gap-2">
            <Stat label="Total Deliveries" value={String(s.total_delivery_orders)} />
            <Stat label="Total Delivery Fees" value={money(ccy, s.total_delivery_fees)} />
            <Stat label="Cost Entered" value={`${s.orders_with_cost} / ${s.total_delivery_orders}`} />
            <Stat label="Recorded Delivery Cost" value={money(ccy, s.recorded_delivery_cost)} />
            <Stat label="Recorded Delivery Margin" value={money(ccy, s.recorded_delivery_margin)} />
          </div>

          {s.orders_with_cost < s.total_delivery_orders && (
            <p className="rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-[11px] text-amber-800">
              <span className="font-bold">Recorded Delivery Margin is partial.</span> {s.orders_with_cost} of{" "}
              {s.total_delivery_orders} delivery order{s.total_delivery_orders === 1 ? "" : "s"} have a Delivery Cost
              entered. Recorded Cost and Margin sum only those - they are not a full-period profit.
            </p>
          )}
          {mixed && (
            <p className="rounded-lg border border-slate-200 bg-slate-50 p-2.5 text-[11px] text-slate-700">
              This range spans multiple currencies, so the totals above are not a single-currency figure. Filter by a
              single branch for a currency-consistent total.
            </p>
          )}

          <p className="mt-1 text-[11px] font-bold uppercase tracking-wide text-sub">Delivery orders</p>
          {rows.length === 0 ? (
            <div className="rounded-2xl border border-line bg-white p-6 text-center text-sm font-semibold text-sub">
              No delivery orders for this period.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-2xl border border-line bg-white">
              <table className="w-full min-w-[560px] border-collapse text-[11px]">
                <thead>
                  <tr className="text-left font-bold uppercase tracking-wide text-slate-400">
                    <th className="border-b border-line px-2 py-2">Date</th>
                    <th className="border-b border-line px-2 py-2">Order #</th>
                    <th className="border-b border-line px-2 py-2 text-right">Fee</th>
                    <th className="border-b border-line px-2 py-2">Delivered By</th>
                    <th className="border-b border-line px-2 py-2 text-right">Cost</th>
                    <th className="border-b border-line px-2 py-2 text-right">Margin</th>
                    <th className="border-b border-line px-2 py-2">Collection</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.order_id}>
                      <td className="whitespace-nowrap border-b border-slate-50 px-2 py-2 font-semibold">
                        {shortDate(r.date)}
                        {r.time ? <span className="ml-1 font-normal text-sub">{r.time}</span> : null}
                      </td>
                      <td className="whitespace-nowrap border-b border-slate-50 px-2 py-2 text-sub">
                        {r.order_number ?? "-"}
                      </td>
                      <td className="whitespace-nowrap border-b border-slate-50 px-2 py-2 text-right font-semibold">
                        {money(r.currency, r.delivery_fee)}
                      </td>
                      <td className="border-b border-slate-50 px-2 py-2">
                        {r.delivered_by ? (
                          <span>
                            {r.delivered_by}
                            {handlerLabel(r.delivery_handler_type) && (
                              <span className="ml-1 text-slate-400">· {handlerLabel(r.delivery_handler_type)}</span>
                            )}
                          </span>
                        ) : (
                          <span className="text-slate-400">-</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap border-b border-slate-50 px-2 py-2 text-right text-sub">
                        {r.delivery_cost == null ? <span className="text-slate-400">-</span> : money(r.currency, r.delivery_cost)}
                      </td>
                      <td className="whitespace-nowrap border-b border-slate-50 px-2 py-2 text-right font-extrabold text-ink">
                        {r.delivery_margin == null ? (
                          <span className="font-normal text-slate-400">-</span>
                        ) : (
                          money(r.currency, r.delivery_margin)
                        )}
                      </td>
                      <td className="whitespace-nowrap border-b border-slate-50 px-2 py-2">
                        <Badge tone={r.collected ? "green" : "amber"}>{r.collected ? "Collected" : "Not collected"}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="text-[11px] text-sub">
            Delivery Fee is the customer charge persisted on the order (never total - subtotal). Delivery Cost is the
            internal fulfilment cost and never affects the customer total or receipt. Recorded Margin = Fee - Cost,
            counted only where a cost is entered. Collection follows payment status. Cancelled, voided and refunded
            orders are excluded. Days are grouped by the branch business day{report.timezone ? ` (${report.timezone})` : ""}.
          </p>
        </>
      ) : null}

      {!props.gate.allowed && (
        <div className="rounded-2xl border border-line bg-white p-4">
          <GatedButton gate={props.gate} size="md" className="w-full" onClick={() => void load()}>
            Reload report
          </GatedButton>
        </div>
      )}
    </section>
  );
}
