// The kitchen ticket preview, and the one place a ticket reaches paper by hand.
//
// WHY THERE IS A PREVIEW AT ALL. A cashier never reads a kitchen ticket in
// normal service - it prints by itself and goes to a cook. This modal exists for
// the two cases where that did not happen: automatic printing is off, or it was
// on and failed. In both, someone has to decide what to do about food the
// kitchen has not been told about, and they can only do that if they can see
// what would be sent.
//
// THE ORDER HAS ALREADY SUCCEEDED BY THE TIME THIS EXISTS. Nothing below calls
// an RPC, touches a cart, a shift or a cash box, or reports failure anywhere
// except into this modal. A spooler problem cannot reach the order it describes,
// and the modal says so in the one sentence that matters:
// "The order was sent successfully. Only the kitchen ticket failed."
//
// SENDING IS ALWAYS DELIBERATE HERE. The automatic path has its own latch and
// lives in `lib/pos/autoPrintRun.ts`; this screen prints only from an operator
// confirmation, and prints again only if they ask again. A reprint of a ticket
// is a normal kitchen event - paper falls behind a station, a cook throws one
// away - so it is never suppressed.

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, GatedButton } from "@/components/ui";
import { Modal } from "@/components/overlays";
import { usePosContext } from "@/state/pos";
import { canPrintKitchenTickets } from "@/lib/pos/access";
import {
  ACCEPTED_MESSAGE,
  isNativeAvailable,
  listPrinters,
  paperWidthLabel,
  printKitchenTicket,
  type NativePrintError,
  type PrintOutcome,
} from "@/lib/nativePrinting";
import { resolvePrintRoute } from "@/lib/pos/printRouteResolver";
import {
  kitchenBlockMessage,
  kitchenPrintGate,
  resolveKitchenTarget,
  type KitchenResolution,
  type KitchenTicket,
} from "@/lib/pos/kitchenPrinter";
import type { ResolverOrderSource } from "@/lib/pos/printRouting";
import { kitchenRenderOptions, type KitchenRenderOptions } from "@/lib/pos/receiptRender";
import { readReceiptDesignSafe } from "@/lib/pos/receiptSettings";
import { useKitchenTicket, shouldShowKitchenTicket, type KitchenTicketStatus } from "@/state/kitchenTicket";

/** The order source this ticket is routed for, from the wording it carries. */
function ticketSource(ticket: KitchenTicket): ResolverOrderSource | null {
  switch (ticket.orderType.trim().toLowerCase()) {
    case "takeaway":
      return "takeaway";
    case "dine-in":
      return "dine_in";
    case "delivery":
      return "delivery";
    default:
      return null;
  }
}

/**
 * The ticket preview.
 *
 * Non-themed for the same reason `ReceiptPaper` is: it predicts thermal paper,
 * and the ten themes must not be able to change what a cook is shown. `render`
 * carries the tenant's kitchen template; absent means no template configured
 * and everything is drawn.
 */
export function KitchenTicketPaper({
  ticket,
  render,
}: {
  ticket: KitchenTicket;
  render?: KitchenRenderOptions;
}) {
  const show = (key: string) => !render?.sections || render.sections.includes(key);
  return (
    <div className="mx-auto w-[320px] rounded-lg border border-paper-line bg-paper p-4 font-mono text-[12px] leading-tight text-paper-ink">
      <div className="text-center">
        <p className="text-sm font-extrabold uppercase tracking-widest">Kitchen</p>
        {ticket.test && <p className="text-[11px] font-bold">TEST PRINT - NOT A REAL ORDER</p>}
        {show("business_name") && <p className="text-[11px] text-paper-sub">{ticket.businessName}</p>}
        {show("branch_name") && <p className="text-[11px] text-paper-sub">{ticket.branchName}</p>}
      </div>
      <div className="my-2 border-t border-dashed border-paper-line" />
      {(show("order_type") || show("order_number")) && (
        <div className="flex justify-between text-[12px] font-bold">
          <span>{show("order_type") ? ticket.orderType : ""}</span>
          <span>{show("order_number") ? `#${ticket.orderNumber}` : ""}</span>
        </div>
      )}
      {/* The tenant's stored table name, verbatim - never prefixed (m256).
          The ROUND label is not switchable: a kitchen that cannot tell round 2
          from a duplicate of round 1 cooks the same food twice. */}
      {((show("table_info") && ticket.tableName) || ticket.batchLabel) && (
        <div className="flex justify-between text-[12px] font-bold">
          <span>{(show("table_info") && ticket.tableName) || ""}</span>
          <span>{ticket.batchLabel ?? ""}</span>
        </div>
      )}
      {show("customer_info") && ticket.customerName && <p className="text-[11px]">{ticket.customerName}</p>}
      {(show("datetime") || show("staff")) && (
        <div className="flex justify-between text-[11px] text-paper-sub">
          <span>{show("datetime") ? ticket.at : ""}</span>
          {show("staff") && ticket.staffName && <span className="truncate pl-2">{ticket.staffName}</span>}
        </div>
      )}
      {ticket.orderNote && (
        <>
          <div className="my-2 border-t border-dashed border-paper-line" />
          <p className="text-[12px]">{ticket.orderNote}</p>
        </>
      )}
      <div className="my-2 border-t border-dashed border-paper-line" />
      {show("items") && (
        <ul className="space-y-1">
          {ticket.lines.map((l, i) => (
            <li key={`${l.name}-${i}`}>
              {/* Quantity carries the emphasis on paper, so it does here too - the
                  preview has to look like what will come out of the printer. */}
              <p className="text-[13px] font-bold">
                {l.qty}x {l.name}
              </p>
              {l.modifiers.map((m) => (
                <p key={m.name} className="pl-3 text-[12px]">
                  + {m.quantity > 1 ? `${m.quantity} x ` : ""}
                  {m.name}
                </p>
              ))}
              {l.note && <p className="pl-3 text-[12px]">{l.note}</p>}
            </li>
          ))}
        </ul>
      )}
      <div className="my-2 border-t border-dashed border-paper-line" />
      {show("footer") && render?.footer?.trim() && (
        <p className="text-center text-[11px] text-paper-sub">{render.footer.trim()}</p>
      )}
      {/* No total, no price, no payment status. See printing/kitchen.rs. */}
    </div>
  );
}

export function KitchenTicketModal({
  ticket,
  status,
  onClose,
}: {
  ticket: KitchenTicket;
  status: KitchenTicketStatus;
  onClose: () => void;
}) {
  const pos = usePosContext();
  const native = isNativeAvailable();

  const [resolution, setResolution] = useState<KitchenResolution | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<PrintOutcome | null>(null);
  const [error, setError] = useState<NativePrintError | null>(null);

  // Asking WHERE this ticket goes is a read - one RPC and a Windows enumeration.
  // It prints nothing, on mount or otherwise, so opening this modal can never
  // produce paper on its own.
  const branchId = pos.branch.id;
  const source = ticketSource(ticket);
  const tenantId = pos.tenantId;

  // The tenant's kitchen template, so the panel below shows what would print.
  // Read through the never-throwing helper: this modal often exists BECAUSE
  // something already went wrong with printing, and a settings error on top of
  // that would replace the ticket with a stack trace.
  const [render, setRender] = useState<KitchenRenderOptions | undefined>(undefined);
  useEffect(() => {
    if (!tenantId) return;
    let cancelled = false;
    void readReceiptDesignSafe({ tenantId, branchId }).then((design) => {
      if (!cancelled) setRender(kitchenRenderOptions(design));
    });
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
        resolvePrintRoute({ branchId, purpose: "kitchen_ticket", orderSource: source }).catch(() => null),
      ]);
      if (cancelled) return;
      if (!route) {
        setResolution({ kind: "blocked", block: { reason: "no_route" } });
        return;
      }
      setResolution(resolveKitchenTarget({ route, installed: installed.ok ? installed.value : [] }));
    })();
    return () => {
      cancelled = true;
    };
  }, [native, branchId, source]);

  const target = resolution?.kind === "single" ? resolution.target : null;

  const gate = kitchenPrintGate({
    nativeAvailable: native,
    canPrintKitchenTickets: canPrintKitchenTickets(pos.access),
    resolution,
    hasTicket: ticket.lines.length > 0,
    busy,
  });

  const send = useCallback(async () => {
    if (!target || !gate.allowed) return;
    setConfirming(false);
    setBusy(true);
    setError(null);
    setOutcome(null);
    const result = await printKitchenTicket({
      printerName: target.windowsName,
      paperWidth: target.paperWidth,
      copies: target.copies,
      // The SAME template the panel above is rendering.
      ticket: { ...ticket, sections: render?.sections ?? null, footer: render?.footer ?? null },
    });
    if (result.ok) setOutcome(result.value);
    else setError(result.error);
    setBusy(false);
  }, [target, gate.allowed, ticket, render]);

  return (
    <Modal
      open
      title="Kitchen ticket"
      subtitle={native ? undefined : "Native printing is available in the installed Desktop app."}
      size="sm"
      onClose={onClose}
      footer={
        <div className="space-y-2">
          {/* The order's success is stated FIRST and separately, every time. A
              cashier who reads only a printer error will try to fix it by
              sending the order again. */}
          {status.kind === "auto_failed" && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] font-semibold text-amber-900">
              {status.message}
            </p>
          )}

          {native && target && !confirming && !outcome && (
            <p className="text-[11px] text-sub">
              Print to <strong className="text-ink">{target.printerName}</strong> ({target.windowsName}) ·{" "}
              {paperWidthLabel(target.paperWidth)} · {target.copies} cop{target.copies === 1 ? "y" : "ies"}
              <span className="block">
                Routed by the {target.usedDefault ? "default" : ticket.orderType.toLowerCase()} kitchen route.
              </span>
            </p>
          )}

          {native && resolution?.kind === "blocked" && status.kind !== "auto_failed" && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] font-semibold text-amber-900">
              {kitchenBlockMessage(resolution.block)}
            </p>
          )}

          {confirming && target && (
            <div className="rounded-xl border-2 border-brand bg-brand-soft p-3">
              <p className="text-xs font-extrabold text-brand-dark">Send this ticket to the kitchen?</p>
              <p className="mt-1 text-[11px] text-brand-dark">
                Order #{ticket.orderNumber}
                {ticket.batchLabel ? ` · ${ticket.batchLabel}` : ""} · {target.copies} cop
                {target.copies === 1 ? "y" : "ies"} at {paperWidthLabel(target.paperWidth)} to{" "}
                <strong>{target.printerName}</strong> ({target.windowsName}).
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
            <Badge tone={native ? "slate" : "amber"}>{native ? "Kitchen ticket" : "Preview only"}</Badge>
            <div className="flex gap-2">
              <GatedButton
                gate={gate}
                variant="ghost"
                disabled={busy || !target || confirming}
                onClick={() => setConfirming(true)}
              >
                {busy ? "Sending..." : "Print ticket"}
              </GatedButton>
              <Button onClick={onClose}>Close</Button>
            </div>
          </div>
        </div>
      }
    >
      <KitchenTicketPaper ticket={ticket} render={render} />
    </Modal>
  );
}

/**
 * The store-owned layer, mounted once outside the workspace component.
 *
 * Same arrangement as `ReceiptLayer`, and for the same reason: the workspace
 * early-returns a skeleton while POS context loads, so a modal rendered inside
 * it can be unmounted by a transient not-ready state at exactly the moment an
 * order is accepted.
 */
export function KitchenTicketLayer() {
  const ticket = useKitchenTicket((s) => s.ticket);
  const status = useKitchenTicket((s) => s.status);
  const visible = useKitchenTicket((s) => s.visible);
  const hide = useKitchenTicket((s) => s.hide);
  if (!shouldShowKitchenTicket({ ticket, visible })) return null;
  return <KitchenTicketModal ticket={ticket as KitchenTicket} status={status} onClose={hide} />;
}
