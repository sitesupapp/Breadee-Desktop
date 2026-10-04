// Open shift / End shift / Shift summary.
//
// Every figure shown here is read from the server (pos_shift_expected,
// pos_cash_box_shift, pos_end_shift). The dialog computes nothing: it collects
// the opening float and the counted cash, and it displays what came back. That
// is what guarantees the desktop can never disagree with the shift report.

import { useEffect, useState } from "react";
import { Modal } from "@/components/overlays";
import { Badge, Button, Input, cn, type Gate } from "@/components/ui";
import { NumericKeypad } from "@/components/pos/NumericKeypad";
import { CASH_CONTRACT_CURRENCY, formatMoney, parseAmount, type CurrencyCode } from "@/lib/currency";
import { differenceLabel } from "@/lib/pos/shifts";
import { buildShiftReportDetail, itemReductionsFromReport, type ShiftReportDetail } from "@/lib/pos/shiftReport";
import { paymentSummary } from "@/lib/pos/paymentBreakdown";
import type { ShiftOpenOrder } from "@/lib/pos/shiftOrderSummary";
import type { DeliveryFeeCashTreatment, ShiftExpected, ShiftReport } from "@/types/pos";

export function OpenShiftDialog({
  open,
  busy,
  branchName,
  currency,
  gate,
  error,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  busy: boolean;
  branchName: string;
  currency: CurrencyCode;
  gate: Gate;
  error: string | null;
  onCancel: () => void;
  onConfirm: (openingCash: number) => void;
}) {
  const [float, setFloat] = useState("");

  useEffect(() => {
    if (open) setFloat("");
  }, [open]);

  return (
    <Modal
      open={open}
      title="Open shift"
      subtitle={`${branchName} - the branch is confirmed by the server, not chosen here.`}
      size="sm"
      onClose={onCancel}
      footer={
        <div className="flex items-center justify-between gap-3">
          {error ? <p className="truncate text-xs font-semibold text-red-700">{error}</p> : <span />}
          <div className="flex shrink-0 gap-2">
            <Button variant="ghost" size="lg" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
            <Button
              size="lg"
              onClick={() => onConfirm(parseAmount(float))}
              disabled={busy || !gate.allowed}
              title={gate.reason ?? undefined}
            >
              {busy ? "Opening..." : "Open shift"}
            </Button>
          </div>
        </div>
      }
    >
      <p className="mb-3 text-sm text-sub">
        Count the cash already in the drawer and enter it as the opening float. Leave it empty for an empty drawer. The
        float is added to the expected cash at end of shift.
      </p>
      {/* USD, whatever the tenant's primary currency is. The server adds this
          straight onto a USD cash aggregate, so a float typed as LBP would be
          recorded as that many DOLLARS. Decimals must stay available for the
          same reason - they are cents here, not an LBP artefact. */}
      <label className="mb-1 block text-sm font-bold text-ink" htmlFor="opening-float">
        Opening float ({CASH_CONTRACT_CURRENCY})
      </label>
      <Input
        id="opening-float"
        size="lg"
        inputMode="decimal"
        value={float}
        onChange={(e) => setFloat(e.target.value)}
        placeholder="0.00"
        className="text-right text-lg font-bold"
      />
      <NumericKeypad className="mt-3" value={float} onChange={setFloat} allowDecimal />
    </Modal>
  );
}

export function EndShiftDialog({
  open,
  busy,
  expected,
  currency,
  gate,
  error,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  busy: boolean;
  expected: ShiftExpected | null;
  currency: CurrencyCode;
  gate: Gate;
  error: string | null;
  onCancel: () => void;
  onConfirm: (input: { actual: number; notes: string | null; treatment: DeliveryFeeCashTreatment }) => void;
}) {
  const [actual, setActual] = useState("");
  const [notes, setNotes] = useState("");
  // ONE grouped shift-level choice. Defaults to "included" = current behaviour.
  const [treatment, setTreatment] = useState<DeliveryFeeCashTreatment>("included");

  useEffect(() => {
    if (open) {
      setActual("");
      setNotes("");
      setTreatment("included");
    }
  }, [open]);

  const counted = parseAmount(actual);
  // Which Expected the drawer is closed against - the SERVER computed both.
  const hasDeliveryFees = !!expected && expected.total_delivery_fees > 0;
  const expectedForClose = expected
    ? treatment === "excluded"
      ? expected.expected_excluded
      : expected.expected
    : null;
  const preview = expectedForClose === null ? null : expectedForClose - counted;
  const previewLabel = preview === null ? null : differenceLabel(preview);

  return (
    <Modal
      open={open}
      title="End shift"
      subtitle="The server calculates the final report - this only records what you counted."
      size="md"
      onClose={onCancel}
      footer={
        <div className="flex items-center justify-between gap-3">
          {error ? <p className="truncate text-xs font-semibold text-red-700">{error}</p> : <span />}
          <div className="flex shrink-0 gap-2">
            <Button variant="ghost" size="lg" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
            <Button
              size="lg"
              onClick={() => onConfirm({ actual: counted, notes: notes.trim() || null, treatment })}
              disabled={busy || !gate.allowed}
              title={gate.reason ?? undefined}
            >
              {busy ? "Closing..." : "End shift"}
            </Button>
          </div>
        </div>
      }
    >
      <div className="grid gap-4 md:grid-cols-[1fr_240px]">
        <div className="space-y-3">
          <div className="rounded-xl border border-line p-3">
            <p className="mb-2 text-sm font-bold text-ink">Expected in the drawer</p>
            {expected ? (
              <>
                {/* All USD - see CASH_CONTRACT_CURRENCY. `expected` is what
                    pos_end_shift will subtract the counted cash from, so these
                    three and the input below must share one unit. */}
                <SummaryRow label="Opening float" value={formatMoney(expected.opening_cash, CASH_CONTRACT_CURRENCY)} />
                <SummaryRow label="Cash taken" value={formatMoney(expected.cash_sales, CASH_CONTRACT_CURRENCY)} />
                {/* Phase G — cash paid OUT of the drawer this shift, already subtracted
                    from Expected by the server. Shown as a negative so opening + cash
                    taken − payouts = expected reads correctly on screen. */}
                {expected.cash_payouts > 0 && (
                  <SummaryRow label="Cash payouts" value={`- ${formatMoney(expected.cash_payouts, CASH_CONTRACT_CURRENCY)}`} tone="amber" />
                )}

                {hasDeliveryFees && (
                  <div className="mt-2 border-t border-line pt-2">
                    <SummaryRow label="Delivery orders" value={String(expected.delivery_order_count)} />
                    <SummaryRow
                      label="Delivery fees"
                      value={formatMoney(expected.total_delivery_fees, CASH_CONTRACT_CURRENCY)}
                    />
                    {/* ONE grouped choice for the whole shift. The number below is
                        the server's - selecting only picks which Expected to close
                        against; nothing is recomputed on the client. */}
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <Button
                        variant={treatment === "included" ? "primary" : "ghost"}
                        size="md"
                        onClick={() => setTreatment("included")}
                        disabled={busy}
                      >
                        Include in cash
                      </Button>
                      <Button
                        variant={treatment === "excluded" ? "primary" : "ghost"}
                        size="md"
                        onClick={() => setTreatment("excluded")}
                        disabled={busy}
                      >
                        Separate from cash
                      </Button>
                    </div>
                    {treatment === "excluded" && (
                      <p className="mt-2 rounded-lg bg-amber-50 px-2 py-1 text-xs text-amber-800">
                        Delivery-fee cash kept out of the drawer:{" "}
                        <span className="font-bold tabular-nums">
                          {formatMoney(expected.delivery_fees_cash, CASH_CONTRACT_CURRENCY)}
                        </span>
                        . The courier keeps it, so it is not expected in the till.
                      </p>
                    )}
                  </div>
                )}

                <div className="mt-1 flex items-baseline justify-between border-t border-line pt-2">
                  <span className="text-sm font-bold text-ink">Expected</span>
                  <span className="text-xl font-extrabold tabular-nums text-ink">
                    {formatMoney(expectedForClose ?? expected.expected, CASH_CONTRACT_CURRENCY)}
                  </span>
                </div>
                <p className="mt-1 text-xs text-sub">
                  {expected.orders} paid order{expected.orders === 1 ? "" : "s"} this shift
                  {treatment === "excluded" && hasDeliveryFees ? " · delivery fees kept separate" : ""}
                </p>
              </>
            ) : (
              <p className="text-sm text-sub">Reading the expected cash...</p>
            )}
          </div>

          {/* Phase C — PAYMENTS this shift, DELIBERATELY separate from the drawer
              box above. Amounts collected per tender (cash + each non-cash method);
              Total payments is NOT the expected drawer cash. Dynamic + catalog-driven. */}
          {expected && (() => {
            const psum = paymentSummary(expected);
            if (!psum.rows.length) return null;
            return (
              <div className="rounded-xl border border-line p-3">
                <p className="mb-2 text-sm font-bold text-ink">Payments this shift ({CASH_CONTRACT_CURRENCY})</p>
                {psum.rows.map((m) => (
                  <SummaryRow
                    key={m.key}
                    label={m.is_cash ? m.label : `${m.label} (non-cash)`}
                    value={formatMoney(m.amount, CASH_CONTRACT_CURRENCY)}
                  />
                ))}
                <div className="mt-1 border-t border-line pt-1">
                  <SummaryRow label="Total non-cash" value={formatMoney(psum.nonCashTotal, CASH_CONTRACT_CURRENCY)} />
                </div>
                <div className="flex items-baseline justify-between pt-0.5">
                  <span className="text-sm font-bold text-ink">Total payments</span>
                  <span className="text-base font-extrabold tabular-nums text-ink">{formatMoney(psum.grandTotal, CASH_CONTRACT_CURRENCY)}</span>
                </div>
                <p className="mt-1 text-[11px] text-sub">Includes card &amp; other non-cash tenders. Only cash is expected in the drawer.</p>
              </div>
            );
          })()}

          <div>
            <label className="mb-1 block text-sm font-bold text-ink" htmlFor="closing-note">
              Closing note
            </label>
            <Input id="closing-note" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
          </div>

          {previewLabel && counted > 0 && (
            <div className="rounded-xl border border-line px-3 py-2">
              <div className="flex items-center justify-between">
                <span className="text-sm text-sub">Difference (preview)</span>
                <Badge tone={previewLabel.tone}>
                  {previewLabel.label} {formatMoney(Math.abs(preview ?? 0), CASH_CONTRACT_CURRENCY)}
                </Badge>
              </div>
              <p className="mt-1 text-xs text-sub">The server recalculates this when the shift closes.</p>
            </div>
          )}
        </div>

        <div>
          {/* USD. pos_end_shift does `expected - actual_cash_counted` with no
              conversion, so a figure typed in LBP would produce a difference
              wrong by the exchange rate. Decimals stay enabled: they are cents. */}
          <label className="mb-1 block text-sm font-bold text-ink" htmlFor="actual-cash">
            Counted cash ({CASH_CONTRACT_CURRENCY})
          </label>
          <Input
            id="actual-cash"
            size="lg"
            inputMode="decimal"
            value={actual}
            onChange={(e) => setActual(e.target.value)}
            placeholder="0.00"
            className="text-right text-lg font-bold"
          />
          <NumericKeypad className="mt-3" value={actual} onChange={setActual} allowDecimal />
        </div>
      </div>
    </Modal>
  );
}

/**
 * The end-of-shift report.
 *
 * EVERY MONEY FIGURE IS THE SERVER'S. `pos_end_shift` computed gross,
 * discounts, net, expected, counted, the difference and `by_item`, and nothing
 * here recomputes any of them - least of all by re-converting LBP at today's
 * rate, which would make a reprint of last week's shift disagree with the
 * receipts that shift produced.
 *
 * What the desktop ADDS is the operational detail the RPC does not return: the
 * routes the orders came from, and what was reversed. Those are derived from
 * the shift's own orders and never netted off sales - a voided order is shown
 * because it happened, not counted because it did not.
 */
export function ShiftReportDialog({
  report,
  currency,
  shiftOrders = [],
  onPrint,
  onClose,
}: {
  report: ShiftReport | null;
  currency: CurrencyCode;
  /** The shift's orders, for the route and reversal detail. */
  shiftOrders?: ShiftOpenOrder[];
  /** Print the whole report as ONE document. Absent outside the packaged app. */
  onPrint?: (detail: ShiftReportDetail) => void;
  onClose: () => void;
}) {
  if (!report) return null;
  const diff = differenceLabel(report.difference);
  const detail = buildShiftReportDetail(shiftOrders, report.by_item);
  return (
    <Modal
      open
      title="End of shift report"
      subtitle="Sent for manager review - it is not approved yet."
      size="md"
      onClose={onClose}
      footer={
        <div className="flex items-center justify-end gap-2">
          {onPrint && (
            <Button variant="ghost" size="lg" onClick={() => onPrint(detail)}>
              Print
            </Button>
          )}
          <Button size="lg" onClick={onClose}>
            Done
          </Button>
        </div>
      }
    >
      <div className="mb-3 flex items-center gap-2">
        <Badge tone="amber">Pending manager review</Badge>
        <Badge tone={diff.tone}>
          {diff.label} {formatMoney(Math.abs(report.difference), CASH_CONTRACT_CURRENCY)}
        </Badge>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {/* CASH is USD and SALES are in the order currency. That is not an
            inconsistency to tidy away - `cash_sales` sums USD payment amounts
            while `net_sales` sums pos_orders.total_amount in the order's own
            currency. Labelling both with one currency is what produced
            "114 LBP" against 10,220,000 LBP of orders. */}
        <div className="rounded-xl border border-line p-3">
          <p className="mb-2 text-sm font-bold text-ink">Cash ({CASH_CONTRACT_CURRENCY})</p>
          <SummaryRow label="Opening float" value={formatMoney(report.opening_cash, CASH_CONTRACT_CURRENCY)} />
          <SummaryRow label="Cash sales" value={formatMoney(report.cash_sales, CASH_CONTRACT_CURRENCY)} />
          {/* Phase G — cash paid out of the drawer, already subtracted from Expected. */}
          {report.cash_payouts > 0 && (
            <SummaryRow label="Cash payouts" value={`- ${formatMoney(report.cash_payouts, CASH_CONTRACT_CURRENCY)}`} tone="amber" />
          )}
          <SummaryRow label="Expected" value={formatMoney(report.expected_cash, CASH_CONTRACT_CURRENCY)} />
          <SummaryRow label="Counted" value={formatMoney(report.actual_cash, CASH_CONTRACT_CURRENCY)} />
          {report.total_delivery_fees > 0 && (
            <div className="mt-1 border-t border-line pt-1">
              {/* Delivery fees stay visible and reportable regardless of treatment. */}
              <SummaryRow
                label={`Delivery fees (${report.delivery_order_count})`}
                value={formatMoney(report.total_delivery_fees, CASH_CONTRACT_CURRENCY)}
              />
              <SummaryRow
                label="Fee treatment"
                value={report.delivery_fee_cash_treatment === "excluded" ? "Kept separate" : "In cash"}
                tone={report.delivery_fee_cash_treatment === "excluded" ? "amber" : undefined}
              />
              {report.delivery_fee_cash_treatment === "excluded" && (
                <SummaryRow
                  label="Kept out of drawer"
                  value={formatMoney(report.delivery_fees_cash, CASH_CONTRACT_CURRENCY)}
                  tone="amber"
                />
              )}
            </div>
          )}
        </div>
        <div className="rounded-xl border border-line p-3">
          <p className="mb-2 text-sm font-bold text-ink">Sales ({currency})</p>
          <SummaryRow label="Orders" value={String(report.orders)} />
          <SummaryRow label="Gross" value={formatMoney(report.gross_sales, currency)} />
          <SummaryRow label="Discounts" value={formatMoney(report.discounts, currency)} />
          <SummaryRow label="Net" value={formatMoney(report.net_sales, currency)} />
          <SummaryRow label="Cancelled / void" value={String(report.cancelled_void)} />
          <SummaryRow label="Refunded" value={String(report.refunded_count)} />
        </div>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {/* Payments, by what was actually taken. LBP appears only when some
            was, and in its own units - never converted for display. */}
        <div className="rounded-xl border border-line p-3">
          {/* Phase C — dynamic, catalog-driven per-tender breakdown (cash + each
              non-cash method) with Total non-cash and Total payments — collected
              amounts, distinct from the expected drawer cash on the left. A pre-Phase-C
              report (no payment_methods) keeps the cash-only view. */}
          <p className="mb-2 text-sm font-bold text-ink">Payments ({CASH_CONTRACT_CURRENCY})</p>
          {(() => {
            const psum = paymentSummary(report);
            if (psum.rows.length) {
              return (
                <>
                  {psum.rows.map((m) => (
                    <SummaryRow
                      key={m.key}
                      label={m.is_cash ? m.label : `${m.label} (non-cash)`}
                      value={formatMoney(m.amount, CASH_CONTRACT_CURRENCY)}
                    />
                  ))}
                  <div className="mt-1 border-t border-line pt-1">
                    <SummaryRow label="Total non-cash" value={formatMoney(psum.nonCashTotal, CASH_CONTRACT_CURRENCY)} />
                    <SummaryRow label="Total payments" value={formatMoney(psum.grandTotal, CASH_CONTRACT_CURRENCY)} />
                  </div>
                </>
              );
            }
            return <SummaryRow label="Cash sales" value={formatMoney(report.cash_sales, CASH_CONTRACT_CURRENCY)} />;
          })()}
          <div className="mt-1 border-t border-line pt-1">
            <SummaryRow label="Cash USD" value={formatMoney(report.cash_usd, "USD")} />
            {report.cash_lbp_original > 0 && (
              <SummaryRow label="Cash LBP" value={formatMoney(report.cash_lbp_original, "LBP")} />
            )}
          </div>
        </div>

        {/* Routes and reversals: derived from the shift's orders, which is
            detail `pos_end_shift` does not return. Reversed money is shown for
            visibility and is NOT part of net sales. */}
        <div className="rounded-xl border border-line p-3">
          <p className="mb-2 text-sm font-bold text-ink">By route</p>
          {detail.routes.length === 0 && <p className="text-xs text-sub">No orders on this shift.</p>}
          {detail.routes.map((r) => (
            <SummaryRow
              key={r.route}
              label={`${r.route === "dine_in" ? "Dine-In" : r.route === "takeaway" ? "Takeaway" : r.route === "delivery" ? "Delivery" : r.route} x${r.orders}`}
              value={formatMoney(r.total, currency)}
            />
          ))}
          {(detail.reversals.voided > 0 || detail.reversals.cancelled > 0 || detail.reversals.refunded > 0) && (
            <div className="mt-2 border-t border-line pt-2">
              <SummaryRow
                label="Reversed orders"
                value={String(detail.reversals.voided + detail.reversals.cancelled + detail.reversals.refunded)}
                tone="amber"
              />
              <p className="text-[11px] text-sub">
                {formatMoney(detail.reversals.amount, currency)} not counted as sales
              </p>
            </div>
          )}
        </div>

        {/* Part 1 — items REDUCED or CANCELLED on submitted lines this shift
            (report_json.item_reductions). Distinct from the reversed-ORDERS block
            above; the value is informational and never netted off sales. Rendered
            only when the server supplied it and something was actually reduced, so
            an untouched shift or a pre-Part-1 report shows nothing. */}
        {(() => {
          const ir = itemReductionsFromReport(report.item_reductions);
          if (!ir || (ir.removalEventsCount === 0 && ir.reductionEventsCount === 0)) return null;
          const irCur = ir.currency ?? currency;
          return (
            <div className="rounded-xl border border-line p-3">
              <p className="mb-2 text-sm font-bold text-ink">Items reduced / removed</p>
              <SummaryRow label="Items removed" value={String(ir.removalEventsCount)} />
              <SummaryRow label="Items reduced" value={String(ir.reductionEventsCount)} />
              <SummaryRow label="Quantity removed" value={String(ir.totalRemovedQuantity)} />
              <SummaryRow
                label={ir.valueUnavailableCount > 0 ? `Value removed (${ir.valueUnavailableCount} unpriced)` : "Value removed"}
                value={formatMoney(ir.removedValueKnownSubtotal, irCur)}
                tone="amber"
              />
              <p className="text-[11px] text-sub">On submitted items; not netted off sales.</p>
            </div>
          );
        })()}
      </div>

      <div className="mt-3 grid gap-3 text-xs sm:grid-cols-2">
        <SummaryRow label="Opened" value={report.opened_at ? new Date(report.opened_at).toLocaleString() : "-"} />
        <SummaryRow label="Closed" value={report.closed_at ? new Date(report.closed_at).toLocaleString() : "-"} />
      </div>
      {report.notes && <p className="mt-2 text-xs italic text-sub">Note: {report.notes}</p>}

      {report.by_item.length > 0 && (
        <div className="mt-3 rounded-xl border border-line p-3">
          <p className="mb-2 text-sm font-bold text-ink">By item</p>
          <ul className="max-h-48 space-y-1 overflow-y-auto">
            {report.by_item.map((row) => (
              <li key={row.item} className="flex justify-between gap-2 text-xs">
                <span className="truncate text-ink">
                  {row.qty} x {row.item}
                </span>
                <span className="shrink-0 font-semibold tabular-nums text-sub">{formatMoney(row.total, currency)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Modal>
  );
}

function SummaryRow({ label, value, tone }: { label: string; value: string; tone?: "amber" }) {
  return (
    <div className="flex items-baseline justify-between py-0.5">
      <span className="text-xs text-sub">{label}</span>
      <span className={cn("text-sm font-bold tabular-nums", tone === "amber" ? "text-amber-700" : "text-ink")}>{value}</span>
    </div>
  );
}
