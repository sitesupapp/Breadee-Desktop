// The Customer Account Payment / Receivable Collection confirmation.
//
// WHAT IT IS, AND IS NOT. When a cashier collects money against a customer's
// outstanding balance, they and the customer both want a slip that says how much
// was paid and what is still owed. That is NOT a sale receipt: no item lines, no
// cart, no subtotal/tax/total-of-goods, no tendered/change block. It records a
// PAYMENT AGAINST A DEBT, so it carries the customer, the original order it pays
// down, the amount collected, the method, the balance before and the balance
// after - and nothing that would let it be mistaken for a second copy of the
// original bill.
//
// SO IT HAS NO ITEM LINES, STRUCTURALLY. `ReceivableConfirmation` has no line
// array and no goods total; there is nowhere to put one. This is deliberately
// unlike the on-account SALE receipt (`paymentCompletion.ts`), which is the sale
// itself and does carry the ordered items.
//
// EVERY BALANCE FIGURE IS THE SERVER'S, AND IN USD. `pos_receivable_collect`
// returns `collected_usd` and `outstanding_usd` - the USD-normalised truth. The
// confirmation shows those, and captures the balance BEFORE from the same
// authority (the order's `outstandingUsd`, read before the collection). The
// amount the cashier keyed is in the ORDER's currency, so it is shown separately
// and labelled with that currency - the two are never added together, because a
// USD balance and an LBP tender do not sum.
//
// NOT A SECOND PRINTER IMPLEMENTATION. Native printing renders through
// `printReport`, the generic label/value document the end-of-shift report and the
// collection ticket already use - so it inherits the same GDI renderer, paper
// rules, bidi handling and cleanup. NOTHING was added to the native (Rust) layer:
// there is no receivable-confirmation command, no new `ReceiptDoc` field. A sale
// receipt has item lines and belongs on the receipt renderer; a debt payment is a
// label/value slip and belongs on the report renderer, which already exists.

import {
  MAX_COPIES,
  MIN_COPIES,
  isNativeAvailable,
  listPrinters,
  printReport,
  type ReportDoc,
  type ReportDocLine,
} from "@/lib/nativePrinting";
import { canPrintReceipts, type PosAccessContext } from "@/lib/pos/access";
import { formatMoney, type CurrencyCode } from "@/lib/currency";
import { resolvePrintRoute } from "@/lib/pos/printRouteResolver";
import { describeBlock, resolveRouteTarget } from "@/lib/pos/printTarget";
import type { CollectResult } from "@/lib/pos/receivables";

/** The confirmation, as pure data. Renders on-screen and, natively, as a report. */
export type ReceivableConfirmation = {
  businessName: string;
  branchName: string;
  cashierName: string | null;
  customerName: string | null;
  customerPhone: string | null;
  /** The original receivable order this payment pays down. */
  orderNumber: string;
  at: string;
  /** All three balance figures are the server's USD-normalised truth. */
  collectedUsd: number;
  previousBalanceUsd: number;
  remainingBalanceUsd: number;
  /** What the cashier keyed, in the ORDER's currency - shown, never summed into USD. */
  paidAmount: number;
  paidCurrency: CurrencyCode;
  method: string | null;
  paymentStatus: string;
};

/**
 * Build the confirmation from the SERVER's answer plus the balance read BEFORE
 * the collection. Nothing is recomputed: `collectedUsd`/`remainingBalanceUsd` are
 * the server's, and `previousBalanceUsd` is the order's own pre-collection
 * outstanding - captured, not derived by addition.
 */
export function buildReceivableConfirmation(input: {
  businessName: string | null | undefined;
  branchName: string;
  cashierName: string | null;
  customerName: string | null;
  customerPhone: string | null;
  previousBalanceUsd: number;
  paidAmount: number;
  paidCurrency: CurrencyCode;
  method: string | null;
  at: string;
  result: CollectResult;
}): ReceivableConfirmation {
  return {
    businessName: input.businessName?.trim() || "Breadee",
    branchName: input.branchName,
    cashierName: input.cashierName,
    customerName: input.customerName,
    customerPhone: input.customerPhone,
    orderNumber: input.result.orderNumber,
    at: input.at,
    collectedUsd: input.result.collectedUsd,
    previousBalanceUsd: input.previousBalanceUsd,
    remainingBalanceUsd: input.result.outstandingUsd,
    paidAmount: input.paidAmount,
    paidCurrency: input.paidCurrency,
    method: input.method,
    paymentStatus: input.result.paymentStatus,
  };
}

function boundCopies(value: unknown): number {
  const n = typeof value === "number" ? Math.trunc(value) : NaN;
  if (!Number.isFinite(n)) return MIN_COPIES;
  return Math.min(Math.max(n, MIN_COPIES), MAX_COPIES);
}

/**
 * The printable document. `printReport`'s generic label/value model - a title and
 * a column of label/value rows, with rules between sections. No item lines exist
 * to draw, which is the whole point.
 */
export function toReceivableReport(c: ReceivableConfirmation): ReportDoc {
  const lines: ReportDocLine[] = [];
  lines.push({ label: c.businessName, kind: "body" });
  lines.push({ label: c.branchName, kind: "body" });
  lines.push({ label: "", kind: "rule" });
  lines.push({ label: "Customer Account Payment", kind: "heading" });
  lines.push({ label: c.at, kind: "body" });
  lines.push({ label: "", kind: "rule" });

  if (c.customerName) lines.push({ label: "Customer", value: c.customerName, kind: "body" });
  if (c.customerPhone) lines.push({ label: "Phone", value: c.customerPhone, kind: "body" });
  lines.push({ label: "Order", value: `#${c.orderNumber}`, kind: "body" });
  if (c.method) lines.push({ label: "Method", value: c.method, kind: "body" });
  if (c.cashierName) lines.push({ label: "Cashier", value: c.cashierName, kind: "body" });
  lines.push({ label: "", kind: "rule" });

  // The tender the cashier keyed, in the ORDER currency, shown for their record.
  lines.push({ label: "Paid", value: formatMoney(c.paidAmount, c.paidCurrency), kind: "body" });
  // The three balance figures - all USD, all the server's. Labelled so a USD
  // total and an LBP tender are never read as the same number.
  lines.push({ label: "Balance before (USD)", value: formatMoney(c.previousBalanceUsd, "USD"), kind: "body" });
  lines.push({ label: "Collected (USD)", value: formatMoney(c.collectedUsd, "USD"), kind: "body" });
  lines.push({ label: "Balance now (USD)", value: formatMoney(c.remainingBalanceUsd, "USD"), kind: "total" });

  lines.push({ label: "", kind: "rule" });
  lines.push({
    label: c.remainingBalanceUsd > 0 ? "Balance remaining on account" : "Account settled - paid in full",
    kind: "body",
  });

  return { title: "RECEIVABLE COLLECTION", lines };
}

export type ReceivablePrintStatus =
  | { kind: "sent"; copies: number; printer: string }
  | { kind: "failed"; message: string }
  | { kind: "off" };

/**
 * Print the confirmation, if this terminal can.
 *
 * MANUAL ONLY, like the cashier receipt: called from an explicit operator action
 * after the collection has already settled server-side, never on mount and never
 * wired into the collection call itself - a print failure must not be able to
 * reach a booked payment. It performs no RPC, reads no order and returns nothing
 * the collection depends on. "Follow the receipt" resolves the branch's own
 * receipt route through `resolve_print_route`, exactly as the receipt does.
 */
export async function printReceivableConfirmationNow(input: {
  tenantId: string;
  branchId: string | null;
  access: PosAccessContext;
  confirmation: ReceivableConfirmation;
  copies?: number;
}): Promise<ReceivablePrintStatus> {
  if (!isNativeAvailable()) {
    return { kind: "failed", message: "Printing is available only in the installed Desktop app." };
  }
  // A confirmation is a customer money document, so it needs the same permission
  // the customer receipt does.
  const permission = canPrintReceipts(input.access);
  if (!permission.allowed) return { kind: "failed", message: permission.reason ?? "Not permitted to print." };
  if (!input.branchId) return { kind: "failed", message: "This terminal has no branch receipt route configured." };

  const installedResult = await listPrinters();
  const installed = installedResult.ok ? installedResult.value : [];
  const route = await resolvePrintRoute({
    branchId: input.branchId,
    purpose: "receipt",
    orderSource: "takeaway",
  }).catch(() => null);
  if (!route) return { kind: "failed", message: "No receipt printer is routed for this branch." };
  const resolution = resolveRouteTarget({ route, installed });
  if (resolution.kind !== "single") {
    return { kind: "failed", message: describeBlock(resolution.block, "receipt") };
  }

  try {
    const result = await printReport({
      printerName: resolution.target.windowsName,
      paperWidth: resolution.target.paperWidth,
      copies: boundCopies(input.copies ?? resolution.target.copies),
      report: toReceivableReport(input.confirmation),
    });
    return result.ok
      ? { kind: "sent", copies: result.value.copies_accepted, printer: result.value.printer_name }
      : { kind: "failed", message: result.error.message };
  } catch (e) {
    return { kind: "failed", message: e instanceof Error ? e.message : "The confirmation could not be printed." };
  }
}
