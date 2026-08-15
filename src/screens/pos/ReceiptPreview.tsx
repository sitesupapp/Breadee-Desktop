// The receipt preview, and (Level 3E-B) the one place a receipt reaches paper.
//
// WHY ALL FOUR ROUTES ARE COVERED BY EDITING ONE FILE. Takeaway, Dine-in,
// Delivery and Level 3D's historical reprint all present their receipt through
// the same store-owned layer, which renders this modal. So native printing is
// wired once, here, and every route gets it with no per-route printing code -
// and no route can end up with a subtly different print rule.
//
// MANUAL ONLY. Nothing on this screen prints on mount, on payment or on a
// timer. `auto_print_customer` exists on the server and defaults to true; it is
// deliberately NOT honoured yet, because automatic paper is a duplicate-risk
// design of its own and this renderer has not yet printed a real receipt.
//
// PRINTING CANNOT REACH THE TRANSACTION. By the time this modal exists the
// payment has already succeeded and the receipt has been built. Nothing below
// calls an RPC, touches an order, or reports failure to anything except this
// modal, so a spooler problem cannot roll back, retry or duplicate a sale.

import { useCallback, useEffect, useState } from "react";
import type { ReceiptData } from "@/lib/receipt";
import { formatMoney } from "@/lib/currency";
import { Badge, Button, GatedButton } from "@/components/ui";
import { Modal } from "@/components/overlays";
import { usePosContext } from "@/state/pos";
import { canPrintReceipts } from "@/lib/pos/access";
import {
  ACCEPTED_MESSAGE,
  isNativeAvailable,
  listPrinters,
  paperWidthLabel,
  printReceipt,
  type NativePrintError,
  type PrintOutcome,
} from "@/lib/nativePrinting";
import { resolvePrintRoute } from "@/lib/pos/printRouteResolver";
import {
  blockMessage,
  receiptOrderSource,
  receiptPrintGate,
  resolveReceiptTarget,
  type CashierResolution,
} from "@/lib/pos/cashierPrinter";

export function ReceiptPaper({ data }: { data: ReceiptData }) {
  return (
    <div className="mx-auto w-[320px] rounded-lg border border-line bg-white p-4 font-mono text-[12px] leading-tight text-ink">
      <div className="text-center">
        <p className="text-sm font-bold uppercase tracking-wide">{data.businessName}</p>
        <p className="text-[11px] text-sub">{data.branchName}</p>
      </div>
      <div className="my-2 border-t border-dashed border-line" />
      <div className="flex justify-between text-[11px] text-sub">
        <span>{data.orderType}</span>
        <span>#{data.orderNumber}</span>
      </div>
      {/* The tenant's STORED table name, printed verbatim (m256).
          It is never prefixed: a tenant may legitimately call a table "5",
          "Table 5", "Terrace" or "VIP 2", and prepending "Table " produced
          "Table Table 4" on the first staging receipt - the same doubled-label
          defect the web POS already carries. The order type line above supplies
          the "Dine-in" context, so the name needs no decoration. */}
      {data.tableName && (
        <div className="flex justify-between text-[11px] text-sub">
          <span>{data.tableName}</span>
          {data.seats != null && <span>{data.seats} seats</span>}
        </div>
      )}
      {/* Delivery identity. Without it the receipt says who took the money but
          not who the food is for or where it goes - the two things a delivery
          receipt exists to carry. */}
      {(data.customerName || data.deliveryAddress) && (
        <div className="text-[11px] text-sub">
          {data.customerName && (
            <div className="flex justify-between">
              <span className="truncate">{data.customerName}</span>
              {data.customerPhone && <span className="pl-2">{data.customerPhone}</span>}
            </div>
          )}
          {data.deliveryAddress && <p className="mt-0.5">{data.deliveryAddress}</p>}
        </div>
      )}
      <div className="flex justify-between text-[11px] text-sub">
        <span>{data.at}</span>
        {data.staffName && <span className="truncate pl-2">{data.staffName}</span>}
      </div>
      <div className="my-2 border-t border-dashed border-line" />

      <table className="w-full">
        <tbody>
          {data.lines.map((l, i) => (
            <tr key={`${l.name}-${i}`}>
              <td className="py-0.5 pr-1 align-top">{l.qty}x</td>
              <td className="py-0.5 pr-1 align-top">
                <span>{l.name}</span>
                {l.modifiers?.map((m) => (
                  <span key={m.name} className="block pl-2 text-[11px] text-sub">
                    + {m.name}
                    {m.price_delta !== 0 ? ` (${formatMoney(m.price_delta, data.currency)})` : ""}
                  </span>
                ))}
                {l.note && <span className="block pl-2 text-[11px] italic text-sub">{l.note}</span>}
              </td>
              <td className="py-0.5 text-right align-top">{formatMoney(l.lineTotal, data.currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="my-2 border-t border-dashed border-line" />
      <div className="flex justify-between">
        <span>Subtotal</span>
        <span>{formatMoney(data.subtotal, data.currency)}</span>
      </div>
      {data.discount > 0 && (
        <div className="flex justify-between">
          <span>Discount</span>
          <span>-{formatMoney(data.discount, data.currency)}</span>
        </div>
      )}
      <div className="mt-1 flex justify-between text-sm font-bold">
        <span>Total</span>
        <span>{formatMoney(data.total, data.currency)}</span>
      </div>

      {data.tenderCurrency && data.tenderCurrency !== data.currency && data.tenderTotal != null && (
        <div className="mt-1 flex justify-between text-[11px] text-sub">
          <span>Charged in {data.tenderCurrency}</span>
          <span>{formatMoney(data.tenderTotal, data.tenderCurrency)}</span>
        </div>
      )}
      {data.tendered != null && data.tenderCurrency && (
        <>
          <div className="mt-1 flex justify-between text-[11px] text-sub">
            <span>Tendered</span>
            <span>{formatMoney(data.tendered, data.tenderCurrency)}</span>
          </div>
          <div className="flex justify-between text-[11px] text-sub">
            <span>Change</span>
            <span>{formatMoney(data.change ?? 0, data.tenderCurrency)}</span>
          </div>
        </>
      )}

      <div className="mt-1 flex justify-between text-[11px] text-sub">
        <span>{data.paid ? `Paid - ${data.method ?? "cash"}` : "Unpaid"}</span>
        <span>{data.currency}</span>
      </div>
      {/* The shift reference is deliberately NOT shown. It is an internal code
          that means nothing to the customer, it does not print on the paper any
          more, and a preview that shows a line the printer will not produce is
          a preview of a different document. `ReceiptData.shiftRef` still
          carries it for the routes that use it elsewhere. */}
      <div className="my-2 border-t border-dashed border-line" />
      <p className="text-center text-[11px] text-sub">Thank you!</p>
    </div>
  );
}

export function ReceiptModal({ data, onClose }: { data: ReceiptData; onClose: () => void }) {
  const pos = usePosContext();
  const native = isNativeAvailable();

  const [resolution, setResolution] = useState<CashierResolution | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<PrintOutcome | null>(null);
  const [error, setError] = useState<NativePrintError | null>(null);

  // Ask the server where this receipt goes. This is a READ - one RPC and a
  // Windows enumeration - and it prints nothing. It runs on open so the operator
  // can see the destination before deciding to send.
  //
  // The SOURCE is what makes this per-route rather than one-size-fits-all: a
  // Takeaway receipt follows the Takeaway route when the branch has configured
  // one, and the `any` default otherwise. That decision belongs to
  // `resolve_print_route`, not to this modal.
  const branchId = pos.branch.id;
  const source = receiptOrderSource(data);
  useEffect(() => {
    if (!native) return;
    if (!source) {
      setResolution({ kind: "blocked", block: { reason: "unknown_source" } });
      return;
    }
    if (!branchId) {
      setResolution({ kind: "blocked", block: { reason: "no_route" } });
      return;
    }
    let cancelled = false;
    void (async () => {
      const [installed, route] = await Promise.all([
        listPrinters(),
        resolvePrintRoute({ branchId, purpose: "receipt", orderSource: source }).catch(() => null),
      ]);
      if (cancelled) return;
      if (!route) {
        setResolution({ kind: "blocked", block: { reason: "no_route" } });
        return;
      }
      setResolution(resolveReceiptTarget({ route, installed: installed.ok ? installed.value : [] }));
    })();
    return () => {
      cancelled = true;
    };
  }, [native, branchId, source]);

  // Exactly one destination or none - the server resolved it, so there is
  // nothing left for the operator to pick between.
  const target = resolution?.kind === "single" ? resolution.target : null;

  const gate = receiptPrintGate({
    nativeAvailable: native,
    canPrintReceipts: canPrintReceipts(pos.access),
    resolution,
    hasReceipt: data.lines.length > 0,
    busy,
  });

  const send = useCallback(async () => {
    if (!target || !gate.allowed) return;
    setConfirming(false);
    setBusy(true);
    setError(null);
    setOutcome(null);
    const result = await printReceipt({
      printerName: target.windowsName,
      paperWidth: target.paperWidth,
      copies: target.copies,
      receipt: data,
    });
    if (result.ok) setOutcome(result.value);
    else setError(result.error);
    setBusy(false);
  }, [target, gate.allowed, data]);

  // A reprint of an order settled earlier is labelled as one. Repeating it is
  // intentional and is never suppressed - see the manual-print contract.
  const isReprint = data.tendered == null && data.paid;

  return (
    <Modal
      open
      title="Receipt preview"
      subtitle={native ? undefined : "Native printing is available in the installed Desktop app."}
      size="sm"
      onClose={onClose}
      footer={
        <div className="space-y-2">
          {/* Where this would go, and WHY - stated before anything is sent, and
              naming the Breadee alias as well as the Windows queue, because two
              branches call different devices "Kitchen". */}
          {native && target && !confirming && !outcome && (
            <p className="text-[11px] text-sub">
              Print to <strong className="text-ink">{target.printerName}</strong> ({target.windowsName}) ·{" "}
              {paperWidthLabel(target.paperWidth)} · {target.copies} cop{target.copies === 1 ? "y" : "ies"}
              <span className="block">
                Routed by the {target.usedDefault ? "default" : `${data.orderType.toLowerCase()}`} receipt route.
              </span>
            </p>
          )}

          {native && resolution?.kind === "blocked" && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] font-semibold text-amber-900">
              {blockMessage(resolution.block)}
            </p>
          )}

          {confirming && target && (
            <div className="rounded-xl border-2 border-brand bg-brand-soft p-3">
              <p className="text-xs font-extrabold text-brand-dark">
                {isReprint ? "Reprint this receipt?" : "Print this receipt?"}
              </p>
              <p className="mt-1 text-[11px] text-brand-dark">
                Order #{data.orderNumber} · {target.copies} cop{target.copies === 1 ? "y" : "ies"} at{" "}
                {paperWidthLabel(target.paperWidth)} to <strong>{target.printerName}</strong> (
                {target.windowsName}).
              </p>
              <div className="mt-2 flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
                <Button disabled={busy} onClick={() => void send()}>
                  {busy ? "Sending to Windows..." : "Send"}
                </Button>
              </div>
            </div>
          )}

          {outcome && (
            <div className="rounded-lg bg-brand-soft px-3 py-2">
              {/* Never "printed successfully" - the spooler taking the job says
                  nothing about paper. */}
              <p className="text-[11px] font-bold text-brand-dark">{ACCEPTED_MESSAGE}</p>
              <p className="text-[11px] text-brand-dark">
                {outcome.copies_accepted} of {outcome.copies_requested} to {outcome.printer_name}. Check the printer.
              </p>
            </div>
          )}

          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2">
              <p className="text-[11px] font-bold text-red-700">{error.message}</p>
              {/* An ambiguous transport result must not invite another tap. */}
              {(error.code === "finish_document_failed" || error.code === "write_failed") && (
                <p className="text-[11px] text-red-700">
                  The printer may already have received the job. Check the printer before trying again.
                </p>
              )}
            </div>
          )}

          <div className="flex items-center justify-between gap-2">
            <Badge tone={native ? "slate" : "amber"}>{native ? "Receipt" : "Preview only"}</Badge>
            <div className="flex gap-2">
              <GatedButton
                gate={gate}
                variant="ghost"
                disabled={busy || !target || confirming}
                onClick={() => setConfirming(true)}
              >
                {busy ? "Sending..." : isReprint ? "Reprint" : "Print"}
              </GatedButton>
              <Button onClick={onClose}>Close</Button>
            </div>
          </div>
        </div>
      }
    >
      <ReceiptPaper data={data} />
    </Modal>
  );
}
