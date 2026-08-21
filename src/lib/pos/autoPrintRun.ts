// Running an automatic print, once, after a transaction has already succeeded.
//
// WHERE THIS SITS. `autoPrint.ts` decides and latches; `printTarget.ts` resolves;
// `nativePrinting.ts` sends. This module is the one place those three are put
// together, so all three POS routes get identical behaviour from identical code
// rather than three sequences that agree today.
//
// EVERY FUNCTION HERE IS CALLED AFTER THE MONEY IS SETTLED. Not before, not
// during, and never as part of a retry. Each takes a document that already
// exists and a key naming the transaction that produced it; none takes an order
// to act on, calls an RPC, or returns anything a caller's transaction depends
// on. The strongest statement of that property is the return type: a status to
// SHOW, with no failure channel to propagate. Nothing a caller does with it can
// un-send an order or un-take a payment, because there is no path back.
//
// THE SETTINGS READ IS PART OF THE PRINT, NOT PART OF THE SALE. It happens here,
// after the fact, and it cannot throw - see `readAutoPrintSettings`. Reading it
// earlier (say, on workspace mount) would be faster and would also mean a till
// that had been open since before a manager changed the setting kept printing
// the old way.

import {
  isNativeAvailable,
  listPrinters,
  printKitchenTicket,
  printReceipt,
  type InstalledPrinter,
} from "@/lib/nativePrinting";
import type { ReceiptData } from "@/lib/receipt";
import { canPrintKitchenTickets, canPrintReceipts, type PosAccessContext } from "@/lib/pos/access";
import {
  autoPrintLatch,
  decideAutoPrint,
  receiptEventKey,
  skipIsWorthReporting,
  type AutoPrintSkip,
} from "@/lib/pos/autoPrint";
import { receiptOrderSource, blockMessage } from "@/lib/pos/cashierPrinter";
import {
  kitchenBlockMessage,
  ORDER_SUCCEEDED_TICKET_DID_NOT,
  type KitchenTicket,
} from "@/lib/pos/kitchenPrinter";
import { resolvePrintRoute } from "@/lib/pos/printRouteResolver";
import type { ResolverOrderSource } from "@/lib/pos/printRouting";
import { resolveRouteTarget, type PrintResolution } from "@/lib/pos/printTarget";
import { readAutoPrintSettings, readReceiptDesignSafe } from "@/lib/pos/receiptSettings";
import { customerRenderOptions, kitchenRenderOptions } from "@/lib/pos/receiptRender";
import { printerAutoPrintEnabled, readPrinterAutoPrintMap } from "@/lib/pos/autoPrintPrinters";
import { readShowPaymentQr } from "@/lib/pos/qrCode";
import { loadItemRoutes } from "@/lib/pos/itemRouteRepository";
import { loadServerPrinters, type ServerPrinter } from "@/lib/pos/printerRegistry";
import {
  printerById,
  routeFromPrinter,
  splitTicketByStation,
  stationEventKey,
  type StationTicket,
} from "@/lib/pos/stationTickets";
import type { Gate } from "@/components/ui";
import type { KitchenTicketStatus } from "@/state/kitchenTicket";

/**
 * Ask the server where a document goes and whether this terminal can reach it.
 *
 * Never throws: a routing read that fails is reported as "no route", which is
 * the same operator-visible state as a branch that has not configured one, and
 * leads to the same next action. An exception here would surface a stack trace
 * on the happiest path in the app - the moment an order was accepted.
 */
async function resolveFor(input: {
  branchId: string | null;
  purpose: "receipt" | "kitchen_ticket";
  orderSource: ResolverOrderSource;
  installed: Awaited<ReturnType<typeof listPrinters>>;
}): Promise<PrintResolution> {
  if (!input.branchId) return { kind: "blocked", block: { reason: "no_route" } };
  const route = await resolvePrintRoute({
    branchId: input.branchId,
    purpose: input.purpose,
    orderSource: input.orderSource,
  }).catch(() => null);
  if (!route) return { kind: "blocked", block: { reason: "no_route" } };
  const resolution = resolveRouteTarget({ route, installed: input.installed.ok ? input.installed.value : [] });
  return resolution.kind === "single"
    ? { kind: "single", target: { ...resolution.target, printerId: route.printer_id } }
    : resolution;
}

/**
 * Has this terminal switched automatic printing off for the routed printer?
 *
 * A LOCAL VETO ON AN ALREADY-MADE DECISION. Routing has chosen the printer and
 * the branch has said the document type prints by itself; this only asks
 * whether THIS till participates. It can never cause a print, choose a
 * different destination, or change what any other terminal does - see
 * `autoPrintPrinters.ts`.
 *
 * A vetoed document falls back to `manual`, silently: the operator switched
 * the printer off themselves, so telling them about it after every order would
 * be nagging them about their own decision. The Print button in the preview is
 * unaffected, which is the point of a veto rather than a block.
 */
function printerIsSilenced(resolution: PrintResolution): boolean {
  if (resolution.kind !== "single") return false;
  return !printerAutoPrintEnabled(readPrinterAutoPrintMap(), resolution.target.printerId);
}

/**
 * The tenant's public QR, when this terminal has been asked to print one.
 *
 * READS NOTHING UNLESS THE SWITCH IS ON, so a branch that never enabled it
 * pays neither the round trip nor the encoding. Never throws: a receipt without
 * a code is a receipt; an exception on the post-payment path is not.
 */
async function resolvePaymentQr(input: { tenantId: string; branchId: string | null }) {
  if (!readShowPaymentQr()) return null;
  try {
    const { readPublicQrSource, qrForSlug } = await import("@/lib/pos/paymentQr");
    const source = await readPublicQrSource(input);
    return qrForSlug(source?.slug ?? null);
  } catch {
    return null;
  }
}

// --- kitchen -----------------------------------------------------------------

/**
 * Print the kitchen ticket for a batch that has just been accepted by the
 * server, if the branch has asked for that.
 *
 * ONE ATTEMPT. The latch key names the order and its batch, both taken from the
 * server's response, so a completion sequence that runs twice, a component that
 * remounts, or a workspace that re-reads the bill all arrive with a key that has
 * already been used. There is no retry: a failure is reported to the operator
 * with the order's success stated first.
 */
export async function autoPrintKitchenTicket(input: {
  branchId: string | null;
  tenantId: string;
  access: PosAccessContext;
  source: ResolverOrderSource;
  orderId: string;
  batchNo?: number | null;
  ticket: KitchenTicket;
}): Promise<KitchenTicketStatus> {
  const native = isNativeAvailable();

  // Cheap, local refusal first: no server round trip is owed to a build that
  // cannot print at all.
  if (!native) return { kind: "manual" };

  const [settings, installed, design] = await Promise.all([
    readAutoPrintSettings({ tenantId: input.tenantId, branchId: input.branchId }),
    listPrinters(),
    readReceiptDesignSafe({ tenantId: input.tenantId, branchId: input.branchId }),
  ]);
  if (!settings.kitchen) return { kind: "manual" };

  const resolution = await resolveFor({
    branchId: input.branchId,
    purpose: "kitchen_ticket",
    orderSource: input.source,
    installed,
  });

  // STATION ROUTING. Read after the settings, on the same post-transaction path,
  // and never allowed to fail the print: a rules read that throws is treated as
  // NO RULES, which is precisely the behaviour of every release before this one.
  // A branch whose routing table is briefly unreachable prints the whole batch
  // to its usual printer rather than nothing at all.
  const routes = await loadItemRoutes({ tenantId: input.tenantId, branchId: input.branchId }).catch(() => []);
  const stations = splitTicketByStation({ ticket: input.ticket, routes, orderSource: input.source });

  // Only read when an explicit rule actually matched. A branch with no station
  // routing pays nothing for this feature - not a query, not a round trip.
  const needsPrinters = stations.some((s) => s.printerId !== null);
  const printers = needsPrinters
    ? await loadServerPrinters({ tenantId: input.tenantId, branchId: input.branchId }).catch(() => [])
    : [];

  const render = kitchenRenderOptions(design);
  const permission = canPrintKitchenTickets(input.access);
  const outcomes: StationOutcome[] = [];

  for (const station of stations) {
    outcomes.push(
      await printOneStation({
        station,
        orderId: input.orderId,
        batchNo: input.batchNo,
        native,
        enabled: settings.kitchen,
        permission,
        defaultResolution: resolution,
        printers,
        installed: installed.ok ? installed.value : [],
        render,
      }),
    );
  }

  return summariseStations(outcomes);
}

/** What one destination's attempt did. Aggregated by `summariseStations`. */
type StationOutcome =
  | { kind: "sent"; printer: string; copies: number }
  | { kind: "failed"; message: string }
  /** Nothing was attempted for this destination, and nobody needs telling. */
  | { kind: "skipped" };

/**
 * Print ONE station's copy.
 *
 * Extracted so the sequence a single destination goes through - resolve, local
 * veto, decide, latch, send - is the same sequence whether it is the branch
 * default or an explicitly routed station. A second inline copy for the default
 * case is how one of them would eventually stop honouring the terminal's own
 * printer switches.
 *
 * ONE ATTEMPT PER DESTINATION PER BATCH. The latch key names the order, the
 * batch and the PRINTER (`stationEventKey`), which is the change station
 * splitting forced: keyed on the batch alone, sending the grill's ticket would
 * burn the key and the bar would never be told - a missing order rather than a
 * missing page.
 */
async function printOneStation(input: {
  station: StationTicket;
  orderId: string;
  batchNo?: number | null;
  native: boolean;
  enabled: boolean;
  permission: Gate;
  defaultResolution: PrintResolution;
  printers: ServerPrinter[];
  installed: InstalledPrinter[];
  render: ReturnType<typeof kitchenRenderOptions>;
}): Promise<StationOutcome> {
  const { station } = input;

  // The default group keeps the SERVER's resolution untouched, copy count
  // included. An explicitly routed station is resolved through the same
  // reachability rules - see `routeFromPrinter`.
  let resolution: PrintResolution;
  if (station.printerId === null) {
    resolution = input.defaultResolution;
  } else {
    const printer = printerById(input.printers, station.printerId);
    if (!printer) {
      // The rule names a printer this branch no longer has. Reported rather
      // than silently dropped: those lines are food nobody is being told about.
      return {
        kind: "failed",
        message: "A station rule points at a printer that no longer exists. Check Settings → Printing & Routing → Item routing.",
      };
    }
    const resolved = resolveRouteTarget({
      route: routeFromPrinter(printer, station.copies),
      installed: input.installed,
    });
    resolution =
      resolved.kind === "single"
        ? { kind: "single", target: { ...resolved.target, printerId: printer.id } }
        : resolved;
  }

  // Checked before the latch is claimed, so switching a printer back on does
  // not find the event key already burned by an attempt that never happened.
  if (printerIsSilenced(resolution)) return { kind: "skipped" };

  const key = stationEventKey({ orderId: input.orderId, batchNo: input.batchNo, printerId: station.printerId });

  const decision = decideAutoPrint({
    nativeAvailable: input.native,
    enabled: input.enabled,
    permission: input.permission,
    hasDocument: station.ticket.lines.length > 0,
    resolution,
    alreadyAttempted: autoPrintLatch.claimed(key),
  });

  if (decision.kind === "skip") {
    const status = skipStatus(decision.skip, "kitchen");
    return status.kind === "auto_failed" ? { kind: "failed", message: status.message } : { kind: "skipped" };
  }
  if (resolution.kind !== "single") return { kind: "skipped" };
  if (!autoPrintLatch.claim(key)) return { kind: "skipped" };

  try {
    const result = await printKitchenTicket({
      printerName: resolution.target.windowsName,
      paperWidth: resolution.target.paperWidth,
      copies: resolution.target.copies,
      ticket: { ...station.ticket, sections: input.render.sections, footer: input.render.footer },
    });
    if (result.ok) {
      return { kind: "sent", copies: result.value.copies_accepted, printer: result.value.printer_name };
    }
    return { kind: "failed", message: `${resolution.target.printerName}: ${result.error.message}` };
  } catch (e) {
    // A throw from the native boundary is still only a lost ticket. It is
    // caught here so it can never propagate into the caller's post-submit
    // sequence, where it would look like the submission failed.
    return {
      kind: "failed",
      message: `${resolution.target.printerName}: ${e instanceof Error ? e.message : "The ticket could not be printed."}`,
    };
  } finally {
    autoPrintLatch.release(key);
  }
}

/**
 * One status for the whole batch, from however many stations it went to.
 *
 * A FAILURE ANYWHERE IS REPORTED, even when other stations printed. The whole
 * point of splitting is that each station's paper is the only notice that
 * station gets, so "three of four printed" is a kitchen missing an order - not
 * a partial success to round up. The message names the destination, because
 * which one failed is the only thing the operator can act on.
 */
function summariseStations(outcomes: StationOutcome[]): KitchenTicketStatus {
  const failed = outcomes.filter((o): o is Extract<StationOutcome, { kind: "failed" }> => o.kind === "failed");
  const sent = outcomes.filter((o): o is Extract<StationOutcome, { kind: "sent" }> => o.kind === "sent");

  if (failed.length > 0) {
    const others = sent.length > 0 ? ` ${sent.length} other station${sent.length === 1 ? "" : "s"} printed.` : "";
    return {
      kind: "auto_failed",
      message: `${ORDER_SUCCEEDED_TICKET_DID_NOT} ${failed.map((f) => f.message).join(" ")}${others}`,
    };
  }
  if (sent.length > 0) {
    return {
      kind: "auto_sent",
      copies: sent.reduce((total, s) => total + s.copies, 0),
      printer: [...new Set(sent.map((s) => s.printer))].join(", "),
    };
  }
  return { kind: "manual" };
}

/**
 * Turn a skip into something to show, or into silence.
 *
 * The two reported cases are the ones where FOOD IS NOT BEING COOKED and nobody
 * would otherwise find out until a customer asked where their order was. A
 * branch that has switched automatic printing off, or a dev build with no
 * native layer, is not a problem to interrupt anyone about.
 *
 * `not_permitted` is reported rather than swallowed even though it is close to
 * unreachable - the same `pos.create_orders` key gates submitting the order and
 * printing its ticket, so an operator who got this far normally holds both. If
 * the two ever come apart, silently not telling the kitchen is the worst of the
 * available behaviours.
 */
function skipStatus(skip: AutoPrintSkip, doc: "kitchen" | "receipt"): KitchenTicketStatus {
  if (!skipIsWorthReporting(skip)) return { kind: "manual" };
  if (skip.reason === "not_permitted") {
    return { kind: "auto_failed", message: `${ORDER_SUCCEEDED_TICKET_DID_NOT} ${skip.detail}` };
  }
  if (skip.reason === "unroutable" && skip.resolution.kind === "blocked") {
    const why = doc === "kitchen" ? kitchenBlockMessage(skip.resolution.block) : blockMessage(skip.resolution.block);
    return { kind: "auto_failed", message: `${ORDER_SUCCEEDED_TICKET_DID_NOT} ${why}` };
  }
  return { kind: "manual" };
}

// --- customer receipt --------------------------------------------------------

/** What the automatic receipt attempt did, for the caller to show. */
export type ReceiptAutoPrintStatus =
  | { kind: "sent"; copies: number; printer: string }
  | { kind: "failed"; message: string }
  /** Nothing automatic was attempted; the preview's Print button is the path. */
  | { kind: "manual" };

/**
 * Print the customer receipt for a payment that has just succeeded, if the
 * branch has asked for that.
 *
 * The preview is presented either way, and its Print button stays live either
 * way: automatic printing is a convenience laid on top of the manual path, never
 * a replacement for it. A cashier who does not see paper can always send it
 * again deliberately - and that second copy is their decision, made while
 * looking at the printer, which is the only place the decision can be made
 * correctly.
 */
export async function autoPrintReceipt(input: {
  branchId: string | null;
  tenantId: string;
  access: PosAccessContext;
  receipt: ReceiptData;
  /** The moment the payment settled, used only to key the latch. */
  paidAt?: string | null;
}): Promise<ReceiptAutoPrintStatus> {
  const native = isNativeAvailable();
  const key = receiptEventKey({ orderNumber: input.receipt.orderNumber, paidAt: input.paidAt });

  if (!native) return { kind: "manual" };
  if (autoPrintLatch.claimed(key)) return { kind: "manual" };

  const source = receiptOrderSource(input.receipt);
  if (!source) return { kind: "manual" };

  const [settings, installed, design] = await Promise.all([
    readAutoPrintSettings({ tenantId: input.tenantId, branchId: input.branchId }),
    listPrinters(),
    readReceiptDesignSafe({ tenantId: input.tenantId, branchId: input.branchId }),
  ]);
  if (!settings.customer) return { kind: "manual" };

  const resolution = await resolveFor({
    branchId: input.branchId,
    purpose: "receipt",
    orderSource: source,
    installed,
  });
  if (printerIsSilenced(resolution)) return { kind: "manual" };

  const decision = decideAutoPrint({
    nativeAvailable: native,
    enabled: settings.customer,
    permission: canPrintReceipts(input.access),
    hasDocument: input.receipt.lines.length > 0,
    resolution,
    alreadyAttempted: autoPrintLatch.claimed(key),
  });

  if (decision.kind === "skip") {
    if (decision.skip.reason === "unroutable" && decision.skip.resolution.kind === "blocked") {
      return { kind: "failed", message: blockMessage(decision.skip.resolution.block) };
    }
    return { kind: "manual" };
  }
  if (resolution.kind !== "single") return { kind: "manual" };
  if (!autoPrintLatch.claim(key)) return { kind: "manual" };

  try {
    // The QR is encoded here, on the print path, and only when this terminal
    // has been asked for one - so a branch that never switched it on pays
    // nothing for it, and an encoder failure produces a receipt without a code
    // rather than no receipt.
    const render = customerRenderOptions({
      design,
      qr: await resolvePaymentQr({ tenantId: input.tenantId, branchId: input.branchId }),
    });
    const result = await printReceipt({
      printerName: resolution.target.windowsName,
      paperWidth: resolution.target.paperWidth,
      copies: resolution.target.copies,
      receipt: { ...input.receipt, ...render },
    });
    if (result.ok) {
      return { kind: "sent", copies: result.value.copies_accepted, printer: result.value.printer_name };
    }
    return { kind: "failed", message: result.error.message };
  } catch (e) {
    return { kind: "failed", message: e instanceof Error ? e.message : "The receipt could not be printed." };
  } finally {
    autoPrintLatch.release(key);
  }
}
