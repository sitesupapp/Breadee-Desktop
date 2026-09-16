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
} from "@/lib/nativePrinting";
import type { ReceiptData } from "@/lib/receipt";
import { canPrintKitchenTickets, canPrintReceipts, type PosAccessContext } from "@/lib/pos/access";
import {
  autoPrintLatch,
  decideAutoPrint,
  receiptEventKey,
} from "@/lib/pos/autoPrint";
import { receiptOrderSource, blockMessage } from "@/lib/pos/cashierPrinter";
import {
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
import { loadServerPrinters } from "@/lib/pos/printerRegistry";
import { splitTicketByStation, stationEventKey } from "@/lib/pos/stationTickets";
import {
  blockedPlanFix,
  classifyKitchenDispatch,
  planKitchenRouting,
  unresolvedItemNames,
  type JobDispatchResult,
  type KitchenPrinterJob,
} from "@/lib/pos/kitchenRoutingPlan";
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
 * Print the kitchen ticket for a batch the server has just accepted, if the
 * branch prints them automatically - and NEVER a partial one.
 *
 * ROUTING IS RESOLVED IN FULL, BEFORE ANY PAPER. The batch is split into groups,
 * every group is resolved to a reachable destination, and the resulting plan is
 * validated BEFORE the first job is dispatched. If any eligible line has no
 * reachable kitchen printer, this returns `blocked` without dispatching a single
 * job or spending a single latch key: the resolvable subset is not printed and
 * not called a success. That is the whole fix for production #260916-0003, where
 * six of nine lines printed and three with no route were dropped in silence.
 *
 * ONE ATTEMPT PER DESTINATION PER BATCH. Once routing is proven complete, each
 * coalesced destination is printed exactly once, latched on the order, the batch
 * and the printer. No second attempt is ever made automatically; a failure after
 * dispatch is reported with the order's success stated first.
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

  const permission = canPrintKitchenTickets(input.access);

  const defaultResolution = await resolveFor({
    branchId: input.branchId,
    purpose: "kitchen_ticket",
    orderSource: input.source,
    installed,
  });

  // STATION ROUTING. Read after the settings, on the same post-transaction path,
  // and never allowed to fail the print: a rules read that throws is treated as
  // NO RULES, which is the behaviour of every release before station routing.
  const routes = await loadItemRoutes({ tenantId: input.tenantId, branchId: input.branchId }).catch(() => []);
  const groups = splitTicketByStation({ ticket: input.ticket, routes, orderSource: input.source });

  // Only read when an explicit rule actually matched. A branch with no station
  // routing pays nothing for this feature - not a query, not a round trip.
  const needsPrinters = groups.some((g) => g.printerId !== null);
  const printers = needsPrinters
    ? await loadServerPrinters({ tenantId: input.tenantId, branchId: input.branchId }).catch(() => [])
    : [];

  const plan = planKitchenRouting({
    ticket: input.ticket,
    groups,
    defaultResolution,
    printers,
    installed: installed.ok ? installed.value : [],
  });

  // THE PREFLIGHT GATE. Returns before any dispatch when the plan is not fully
  // routable: nothing is printed, no latch is spent, and the operator is shown
  // exactly which items had nowhere to go and the one fix to make.
  if (!plan.routable) {
    return { kind: "blocked", message: blockedPlanFix(plan), items: unresolvedItemNames(plan) };
  }

  // Routing is complete; only now can printing begin. A permission the operator
  // lacks stops every job and is reported rather than swallowed.
  if (!permission.allowed) {
    return {
      kind: "auto_failed",
      message: `${ORDER_SUCCEEDED_TICKET_DID_NOT} ${permission.reason ?? "You do not have permission to print."}`,
    };
  }

  const render = kitchenRenderOptions(design);
  const results: JobDispatchResult[] = [];
  for (const job of plan.jobs) {
    results.push(
      await dispatchKitchenJob({
        job,
        baseTicket: input.ticket,
        orderId: input.orderId,
        batchNo: input.batchNo,
        render,
      }),
    );
  }

  return kitchenStatus(results);
}

/**
 * Print ONE resolved destination's ticket, exactly once per batch.
 *
 * The destination is already resolved and reachable - the plan proved that - so
 * this only applies the terminal's local auto-print veto, claims the latch and
 * sends. The latch key names the order, the batch and the PRINTER, so one
 * destination's ticket cannot burn the key for another's.
 */
async function dispatchKitchenJob(input: {
  job: KitchenPrinterJob;
  baseTicket: KitchenTicket;
  orderId: string;
  batchNo?: number | null;
  render: ReturnType<typeof kitchenRenderOptions>;
}): Promise<JobDispatchResult> {
  const { job } = input;
  const resolution: PrintResolution = { kind: "single", target: job.target };

  // A terminal that has switched automatic printing off for this printer takes
  // the manual path instead - the FULL ticket is on the preview. Checked before
  // the latch so switching it back on does not find a key already spent.
  if (printerIsSilenced(resolution)) {
    return { kind: "skipped", printerId: job.printerId, refs: job.refs };
  }

  const key = stationEventKey({ orderId: input.orderId, batchNo: input.batchNo, printerId: job.printerId });
  if (autoPrintLatch.claimed(key)) return { kind: "skipped", printerId: job.printerId, refs: job.refs };
  if (!autoPrintLatch.claim(key)) return { kind: "skipped", printerId: job.printerId, refs: job.refs };

  try {
    const result = await printKitchenTicket({
      printerName: job.target.windowsName,
      paperWidth: job.target.paperWidth,
      copies: job.target.copies,
      // The base ticket with only this destination's lines. Spread, so every
      // operational field - number, type, table, round, note - is carried.
      ticket: { ...input.baseTicket, lines: job.lines, sections: input.render.sections, footer: input.render.footer },
    });
    if (result.ok) {
      return {
        kind: "sent",
        printerId: job.printerId,
        printer: result.value.printer_name,
        copies: result.value.copies_accepted,
        refs: job.refs,
      };
    }
    return {
      kind: "failed",
      printerId: job.printerId,
      printer: job.target.printerName,
      message: `${job.target.printerName}: ${result.error.message}`,
      refs: job.refs,
    };
  } catch (e) {
    // A throw from the native boundary is still only a lost ticket, caught here
    // so it can never reach the caller's post-submit sequence.
    return {
      kind: "failed",
      printerId: job.printerId,
      printer: job.target.printerName,
      message: `${job.target.printerName}: ${e instanceof Error ? e.message : "The ticket could not be printed."}`,
      refs: job.refs,
    };
  } finally {
    autoPrintLatch.release(key);
  }
}

/**
 * One status for the whole batch, from however many destinations it went to.
 *
 * A FAILURE ANYWHERE IS REPORTED, even when other destinations printed: each
 * station's paper is the only notice that station gets, so "three of four" is a
 * kitchen missing an order. The verdict itself is computed from evidence in
 * `classifyKitchenDispatch`; this only turns it into the operator's wording.
 */
function kitchenStatus(results: JobDispatchResult[]): KitchenTicketStatus {
  const summary = classifyKitchenDispatch({ results });
  const sent = results.filter((r): r is Extract<JobDispatchResult, { kind: "sent" }> => r.kind === "sent");
  const failed = results.filter((r): r is Extract<JobDispatchResult, { kind: "failed" }> => r.kind === "failed");

  switch (summary.overallStatus) {
    case "success":
      return {
        kind: "auto_sent",
        copies: sent.reduce((total, r) => total + r.copies, 0),
        printer: [...new Set(sent.map((r) => r.printer))].join(", "),
      };
    case "partial_physical_failure":
    case "complete_failure": {
      const others = sent.length > 0 ? ` ${sent.length} other station${sent.length === 1 ? "" : "s"} printed.` : "";
      return {
        kind: "auto_failed",
        message: `${ORDER_SUCCEEDED_TICKET_DID_NOT} ${failed.map((r) => r.message).join(" ")}${others}`,
      };
    }
    case "manual":
      return { kind: "manual" };
  }
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
