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
import { QrSymbol } from "@/components/pos/QrSymbol";
import {
  buildCollectionTicket,
  collectionLinesFromReceipt,
  printCollectionTicketNow,
} from "@/lib/pos/collectionTicket";
import { customerRenderOptions, type ReceiptRenderOptions } from "@/lib/pos/receiptRender";
import { readReceiptDesignSafe } from "@/lib/pos/receiptSettings";
import { readShowPaymentQr } from "@/lib/pos/qrCode";
import { resolvePrintRoute } from "@/lib/pos/printRouteResolver";
import {
  blockMessage,
  receiptOrderSource,
  receiptPrintGate,
  resolveReceiptTarget,
  type CashierResolution,
} from "@/lib/pos/cashierPrinter";

/**
 * The 80mm thermal preview.
 *
 * DELIBERATELY NOT THEMED. `paper`/`paper-ink` are literal black and white in
 * `tailwind.config.ts` with no variable behind them, so this panel looks the
 * same under all ten themes. Themed paper would show a cashier a burgundy
 * receipt and print a black one - a preview of a different document.
 *
 * `render` is the tenant's template, from `pos_receipt_settings`. Absent means
 * "no template configured", and everything is drawn - the same direction the
 * native renderer takes, for the same reason: a preview that silently lost the
 * TOTAL because a settings read failed would be worse than one showing a line
 * somebody had switched off.
 */
export function ReceiptPaper({ data, render }: { data: ReceiptData; render?: ReceiptRenderOptions }) {
  const show = (key: string) => !render?.sections || render.sections.includes(key);
  return (
    <div className="mx-auto w-[320px] rounded-lg border border-paper-line bg-paper p-4 font-mono text-[12px] leading-tight text-paper-ink">
      <div className="text-center">
        {show("business_name") && (
          <p className="text-sm font-bold uppercase tracking-wide">{data.businessName}</p>
        )}
        {show("branch_name") && <p className="text-[11px] text-paper-sub">{data.branchName}</p>}
        {show("address") && render?.address && <p className="text-[11px] text-paper-sub">{render.address}</p>}
        {show("phone") && render?.phone && <p className="text-[11px] text-paper-sub">Tel: {render.phone}</p>}
        {show("welcome") && render?.welcome && <p className="text-[11px] text-paper-sub">{render.welcome}</p>}
      </div>
      <div className="my-2 border-t border-dashed border-paper-line" />
      {(show("order_type") || show("order_number")) && (
        <div className="flex justify-between text-[11px] text-paper-sub">
          <span>{show("order_type") ? data.orderType : ""}</span>
          <span>{show("order_number") ? `#${data.orderNumber}` : ""}</span>
        </div>
      )}
      {/* The tenant's STORED table name, printed verbatim (m256).
          It is never prefixed: a tenant may legitimately call a table "5",
          "Table 5", "Terrace" or "VIP 2", and prepending "Table " produced
          "Table Table 4" on the first staging receipt - the same doubled-label
          defect the web POS already carries. The order type line above supplies
          the "Dine-in" context, so the name needs no decoration. */}
      {show("table_info") && data.tableName && (
        <div className="flex justify-between text-[11px] text-paper-sub">
          <span>{data.tableName}</span>
          {data.seats != null && <span>{data.seats} seats</span>}
        </div>
      )}
      {/* Delivery identity. Without it the receipt says who took the money but
          not who the food is for or where it goes - the two things a delivery
          receipt exists to carry. */}
      {((show("customer_name") && data.customerName) || (show("customer_address") && data.deliveryAddress)) && (
        <div className="text-[11px] text-paper-sub">
          {show("customer_name") && data.customerName && (
            <div className="flex justify-between">
              <span className="truncate">{data.customerName}</span>
              {show("customer_phone") && data.customerPhone && <span className="pl-2">{data.customerPhone}</span>}
            </div>
          )}
          {show("customer_address") && data.deliveryAddress && <p className="mt-0.5">{data.deliveryAddress}</p>}
        </div>
      )}
      {(show("datetime") || show("staff")) && (
        <div className="flex justify-between text-[11px] text-paper-sub">
          <span>{show("datetime") ? data.at : ""}</span>
          {show("staff") && data.staffName && <span className="truncate pl-2">{data.staffName}</span>}
        </div>
      )}
      <div className="my-2 border-t border-dashed border-paper-line" />

      {show("items") && (
        <table className="w-full">
          <tbody>
            {data.lines.map((l, i) => (
              <tr key={`${l.name}-${i}`}>
                <td className="py-0.5 pr-1 align-top">{l.qty}x</td>
                <td className="py-0.5 pr-1 align-top">
                  <span>{l.name}</span>
                  {l.modifiers?.map((m) => (
                    <span key={m.name} className="block pl-2 text-[11px] text-paper-sub">
                      + {m.name}
                      {m.price_delta !== 0 ? ` (${formatMoney(m.price_delta, data.currency)})` : ""}
                    </span>
                  ))}
                  {l.note && <span className="block pl-2 text-[11px] italic text-paper-sub">{l.note}</span>}
                </td>
                <td className="py-0.5 text-right align-top">{formatMoney(l.lineTotal, data.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="my-2 border-t border-dashed border-paper-line" />
      {show("subtotal") && (
        <div className="flex justify-between">
          <span>Subtotal</span>
          <span>{formatMoney(data.subtotal, data.currency)}</span>
        </div>
      )}
      {show("discount") && data.discount > 0 && (
        <div className="flex justify-between">
          <span>Discount</span>
          <span>-{formatMoney(data.discount, data.currency)}</span>
        </div>
      )}
      {/* Delivery fee: its own line between discount and total, present only when
          the server actually charged one. Data gated (like the native renderer),
          so the paper and the preview show the same line. */}
      {data.deliveryFee != null && data.deliveryFee > 0 && (
        <div className="flex justify-between">
          <span>Delivery Fee</span>
          <span>{formatMoney(data.deliveryFee, data.currency)}</span>
        </div>
      )}
      {show("total") && (
        <div className="mt-1 flex justify-between text-sm font-bold">
          <span>Total</span>
          <span>{formatMoney(data.total, data.currency)}</span>
        </div>
      )}

      {data.tenderCurrency && data.tenderCurrency !== data.currency && data.tenderTotal != null && (
        <div className="mt-1 flex justify-between text-[11px] text-paper-sub">
          <span>Charged in {data.tenderCurrency}</span>
          <span>{formatMoney(data.tenderTotal, data.tenderCurrency)}</span>
        </div>
      )}
      {data.tendered != null && data.tenderCurrency && (
        <>
          <div className="mt-1 flex justify-between text-[11px] text-paper-sub">
            <span>Tendered</span>
            <span>{formatMoney(data.tendered, data.tenderCurrency)}</span>
          </div>
          <div className="flex justify-between text-[11px] text-paper-sub">
            <span>Change</span>
            <span>{formatMoney(data.change ?? 0, data.tenderCurrency)}</span>
          </div>
        </>
      )}

      {show("payment_method") && (
        <div className="mt-1 flex justify-between text-[11px] text-paper-sub">
          <span>{data.paid ? `Paid - ${data.method ?? "cash"}` : "Unpaid"}</span>
          <span>{data.currency}</span>
        </div>
      )}
      {/* The shift reference is deliberately NOT shown. It is an internal code
          that means nothing to the customer, it does not print on the paper any
          more, and a preview that shows a line the printer will not produce is
          a preview of a different document. `ReceiptData.shiftRef` still
          carries it for the routes that use it elsewhere. */}
      <div className="my-2 border-t border-dashed border-paper-line" />
      {/* After the total, before the footer - where a customer looks once they
          have seen what they owe, and the same position the printer uses. */}
      {render?.qr && (
        <div className="my-2 flex justify-center">
          <QrSymbol matrix={render.qr} size={112} />
        </div>
      )}
      {show("footer") && (
        <p className="text-center text-[11px] text-paper-sub">{render?.footer?.trim() || "Thank you!"}</p>
      )}
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
  const tenantId = pos.tenantId;

  /**
   * The tenant's template, so THIS PREVIEW SHOWS WHAT WILL PRINT.
   *
   * Loaded here rather than threaded through `ReceiptData` because every route
   * already funnels its receipt into this one modal, and the print path reads
   * the same settings from the same helper - so the two cannot describe
   * different documents. Undefined until it arrives, which renders the full
   * receipt: a customer waiting at a till should not watch lines appear.
   */
  const [render, setRender] = useState<ReceiptRenderOptions | undefined>(undefined);
  useEffect(() => {
    if (!tenantId) return;
    let cancelled = false;
    void (async () => {
      const design = await readReceiptDesignSafe({ tenantId, branchId });
      // The QR is only fetched and encoded when this terminal asked for one.
      let qr = null;
      if (readShowPaymentQr()) {
        try {
          const { readPublicQrSource, qrForSlug } = await import("@/lib/pos/paymentQr");
          const src = await readPublicQrSource({ tenantId, branchId });
          qr = qrForSlug(src?.slug ?? null);
        } catch {
          qr = null;
        }
      }
      if (!cancelled) setRender(customerRenderOptions({ design, qr }));
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId, branchId]);

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
      // The SAME options the panel above is rendering. What the operator
      // approved on screen is what leaves the spooler.
      receipt: { ...data, ...(render ?? {}) },
    });
    if (result.ok) setOutcome(result.value);
    else setError(result.error);
    setBusy(false);
  }, [target, gate.allowed, data, render]);

  // A reprint of an order settled earlier is labelled as one. Repeating it is
  // intentional and is never suppressed - see the manual-print contract.
  const isReprint = data.tendered == null && data.paid;

  /**
   * The customer's non-financial ORDER TICKET, printed by hand.
   *
   * HERE because this is already the one surface every route's receipt arrives
   * at, and the one an operator reopens with Ctrl+P - so "print the customer
   * another docket" needs no new screen and no new way to reach a printer.
   *
   * Deliberately unlatched (see `printCollectionTicketNow`): a cashier asking
   * for another copy has looked at the printer and decided. It takes no payment,
   * touches no order, and carries no amount of any kind.
   */
  const [ticketBusy, setTicketBusy] = useState(false);
  const [ticketNote, setTicketNote] = useState<string | null>(null);
  const printOrderTicket = useCallback(async () => {
    if (!source || !tenantId) return;
    setTicketBusy(true);
    setTicketNote(null);
    const result = await printCollectionTicketNow({
      tenantId,
      branchId,
      source,
      ticket: buildCollectionTicket({
        businessName: pos.tenantName,
        branchName: pos.branch.name,
        orderNumber: data.orderNumber,
        source,
        at: data.at,
        lines: collectionLinesFromReceipt(data.lines),
        tableName: data.tableName ?? null,
        customerName: data.customerName ?? null,
      }),
    });
    setTicketNote(
      result.kind === "sent"
        ? `${ACCEPTED_MESSAGE} ${result.copies} to ${result.printer}.`
        : result.kind === "failed"
          ? result.message
          : "There is nothing on this order to put on a ticket.",
    );
    setTicketBusy(false);
  }, [branchId, data, pos.branch.name, pos.tenantName, source, tenantId]);

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

          {ticketNote && (
            <p className="rounded-lg bg-slate-100 px-3 py-2 text-[11px] font-semibold text-sub">{ticketNote}</p>
          )}

          <div className="flex items-center justify-between gap-2">
            <Badge tone={native ? "slate" : "amber"}>{native ? "Receipt" : "Preview only"}</Badge>
            <div className="flex gap-2">
              {/* The customer's number ticket: the whole order, no money.
                  Available whether or not automatic printing is switched on. */}
              <GatedButton
                gate={gate}
                variant="ghost"
                /* `GatedButton` owns `title` - it is where the gate's refusal
                   reason is surfaced - so the explanation goes in the label
                   rather than fighting it for the tooltip. */
                disabled={ticketBusy || busy || confirming || !source}
                onClick={() => void printOrderTicket()}
              >
                {ticketBusy ? "Sending..." : "Order ticket"}
              </GatedButton>
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
      <ReceiptPaper data={data} render={render} />
    </Modal>
  );
}
