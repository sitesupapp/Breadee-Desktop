// The Order / Collection ticket.
//
// WHAT IT IS FOR. A great many restaurants take the money at the counter and
// then call a number when the food is ready. The customer needs something to
// hold with that number on it and a list of what they are waiting for - and they
// specifically do NOT need a second copy of the prices they have already paid.
// Handing over two financial documents invites "why does this one say something
// different", and on a split or discounted bill it eventually will.
//
// SO THIS DOCUMENT HAS NO MONEY IN IT, STRUCTURALLY. `CollectionLine` has a name
// and a quantity and no third numeric field; `CollectionTicket` has no subtotal,
// no discount, no tax, no total, no payment method, no tendered, no change and
// no currency. There is nowhere to put an amount, so a future edit cannot add
// one by accident - it would have to add a field first, and the test that walks
// this module's exported types would fail when it did.
//
// IT IS THE WHOLE ORDER, NOT A STATION'S SHARE. Station tickets split a batch by
// where it is prepared; this is the customer's copy of everything they ordered,
// and splitting it would defeat the point of handing somebody one piece of paper.
//
// NOT A SECOND PRINTER IMPLEMENTATION. It renders through `printReport`, the
// existing generic label/value document the end-of-shift report already uses -
// so it inherits the same GDI renderer, the same paper-width rules, the same
// Arabic/bidi handling, the same copy bounds and the same cleanup. Nothing was
// added to the native layer for this feature.
//
// OFF BY DEFAULT, EVERYWHERE. An existing installation upgrades with every route
// disabled and prints exactly what it printed before. A restaurant that does not
// call numbers never sees it.

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
import { autoPrintLatch } from "@/lib/pos/autoPrint";
import { formatQuantity } from "@/lib/pos/itemOptions";
import { loadServerPrinters } from "@/lib/pos/printerRegistry";
import { resolvePrintRoute } from "@/lib/pos/printRouteResolver";
import type { ResolverOrderSource } from "@/lib/pos/printRouting";
import { describeBlock, resolveRouteTarget, type PrintResolution } from "@/lib/pos/printTarget";
import { printerById, routeFromPrinter } from "@/lib/pos/stationTickets";

// ------------------------------------------------------------- settings -----

/** Where this terminal's collection-ticket settings live. */
export const COLLECTION_TICKET_KEY = "breadee.desktop.collectionTicket";

/**
 * The routes a collection ticket may print for.
 *
 * All three, because a restaurant that calls numbers at the counter may equally
 * hand a dine-in customer a docket, and a delivery packer a picking slip. Each
 * is switched independently: they are different pieces of paper for different
 * people, and turning one on is not a statement about the others.
 */
export const COLLECTION_SOURCES = ["takeaway", "dine_in", "delivery"] as const;
export type CollectionSource = (typeof COLLECTION_SOURCES)[number];

export type CollectionTicketSettings = {
  /** Per route. Absent or non-boolean reads as OFF. */
  enabled: Record<CollectionSource, boolean>;
  /**
   * The printer this terminal sends it to.
   *
   * `null` means "wherever the customer receipt goes" - the branch's existing
   * receipt route - which is the right default because the collection ticket is
   * handed over at the same counter, usually by the same machine. Choosing a
   * printer here is a THIS TERMINAL decision and never rewrites branch routing.
   */
  printerId: string | null;
  copies: number;
};

/** Off everywhere. What every existing installation upgrades into. */
export const COLLECTION_DEFAULTS: CollectionTicketSettings = {
  enabled: { takeaway: false, dine_in: false, delivery: false },
  printerId: null,
  copies: MIN_COPIES,
};

function boundCopies(value: unknown): number {
  const n = typeof value === "number" ? Math.trunc(value) : NaN;
  if (!Number.isFinite(n)) return MIN_COPIES;
  return Math.min(Math.max(n, MIN_COPIES), MAX_COPIES);
}

/** Parse whatever is in storage. Anything unrecognised becomes the defaults. */
export function parseCollectionSettings(raw: unknown): CollectionTicketSettings {
  if (typeof raw !== "string" || raw.trim() === "") return COLLECTION_DEFAULTS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return COLLECTION_DEFAULTS;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return COLLECTION_DEFAULTS;
  const r = parsed as Record<string, unknown>;
  const storedEnabled = r.enabled && typeof r.enabled === "object" ? (r.enabled as Record<string, unknown>) : {};
  return {
    // Only an explicit `true` enables a route. A stray string or number would
    // otherwise become a truthy "on" that nobody chose, and paper nobody wanted.
    enabled: {
      takeaway: storedEnabled.takeaway === true,
      dine_in: storedEnabled.dine_in === true,
      delivery: storedEnabled.delivery === true,
    },
    printerId: typeof r.printerId === "string" && r.printerId !== "" ? r.printerId : null,
    copies: boundCopies(r.copies),
  };
}

export function readCollectionSettings(storage?: Pick<Storage, "getItem">): CollectionTicketSettings {
  try {
    const store = storage ?? (typeof localStorage === "undefined" ? null : localStorage);
    return parseCollectionSettings(store?.getItem(COLLECTION_TICKET_KEY) ?? null);
  } catch {
    return COLLECTION_DEFAULTS;
  }
}

export function writeCollectionSettings(
  settings: CollectionTicketSettings,
  storage?: Pick<Storage, "setItem">,
): CollectionTicketSettings {
  const store = storage ?? (typeof localStorage === "undefined" ? null : localStorage);
  const normalised: CollectionTicketSettings = { ...settings, copies: boundCopies(settings.copies) };
  try {
    store?.setItem(COLLECTION_TICKET_KEY, JSON.stringify(normalised));
  } catch {
    /* No storage: the choice applies to this session and is forgotten. */
  }
  return normalised;
}

/** Is a collection ticket wanted for this route, on this terminal? */
export function collectionEnabledFor(settings: CollectionTicketSettings, source: ResolverOrderSource): boolean {
  if (source === "e_menu") return false;
  return settings.enabled[source] === true;
}

// ------------------------------------------------------------- the ticket ---

/**
 * One line. A name, a quantity, what was changed about it - and no amount.
 *
 * Modifiers and the item note are kept because they are what the customer is
 * waiting for: "no onions" belongs on the docket they are holding as much as on
 * the ticket the kitchen is cooking from.
 */
export type CollectionLine = {
  name: string;
  qty: number;
  modifiers?: { name: string; quantity?: number }[];
  note?: string | null;
};

export type CollectionTicket = {
  businessName: string;
  branchName: string;
  orderNumber: string;
  /** "Takeaway" / "Dine-In" / "Delivery". */
  orderType: string;
  at: string;
  tableName: string | null;
  customerName: string | null;
  orderNote: string | null;
  lines: { name: string; qty: number; modifiers: string[]; note: string | null }[];
};

const SOURCE_LABEL: Record<ResolverOrderSource, string> = {
  takeaway: "Takeaway",
  dine_in: "Dine-In",
  delivery: "Delivery",
  e_menu: "E-Menu",
};

/**
 * Build the ticket.
 *
 * A ZERO-QUANTITY LINE IS DROPPED, the same rule the kitchen ticket applies: it
 * is not something the customer is waiting for, and listing it invites them to
 * ask where it is.
 */
export function buildCollectionTicket(input: {
  businessName: string | null | undefined;
  branchName: string;
  orderNumber: string;
  source: ResolverOrderSource;
  at: string;
  lines: CollectionLine[];
  tableName?: string | null;
  customerName?: string | null;
  orderNote?: string | null;
}): CollectionTicket {
  return {
    businessName: input.businessName?.trim() || "Breadee",
    branchName: input.branchName,
    orderNumber: input.orderNumber,
    orderType: SOURCE_LABEL[input.source],
    at: input.at,
    // A table number belongs on a dine-in docket and nowhere else; a stray one
    // on a takeaway ticket sends a customer looking for a table.
    tableName: input.source === "dine_in" ? (input.tableName ?? null) : null,
    // The NAME only, and only for delivery - never the address or the phone.
    // This is a piece of paper that gets handed over a counter and left on
    // things; it must not carry somebody's address around a restaurant.
    customerName: input.source === "delivery" ? (input.customerName ?? null) : null,
    orderNote: input.orderNote?.trim() ? input.orderNote.trim() : null,
    lines: input.lines
      .filter((l) => Number(l.qty) > 0)
      .map((l) => ({
        name: l.name,
        qty: l.qty,
        modifiers: (l.modifiers ?? []).map((m) => (m.quantity && m.quantity > 1 ? `${m.name} x${m.quantity}` : m.name)),
        note: l.note?.trim() ? l.note.trim() : null,
      })),
  };
}

/**
 * A ReceiptData's lines, stripped to what a collection ticket may carry.
 *
 * THE STRIPPING HAPPENS HERE, once, and every field is named. The receipt line
 * this is built from carries `lineTotal` and its modifiers carry `price_delta`;
 * a spread would put both on a document whose whole purpose is not having them.
 */
export function collectionLinesFromReceipt(
  lines: { name: string; qty: number; modifiers?: { name: string; quantity: number }[]; note?: string | null }[],
): CollectionLine[] {
  return lines.map((l) => ({
    name: l.name,
    qty: l.qty,
    modifiers: (l.modifiers ?? []).map((m) => ({ name: m.name, quantity: m.quantity })),
    note: l.note ?? null,
  }));
}

/** The printable document. `printReport`'s generic label/value model. */
export function toCollectionReport(ticket: CollectionTicket): ReportDoc {
  const lines: ReportDocLine[] = [];
  lines.push({ label: ticket.businessName, kind: "body" });
  lines.push({ label: ticket.branchName, kind: "body" });
  lines.push({ label: "", kind: "rule" });
  lines.push({ label: ticket.orderType, kind: "heading" });
  lines.push({ label: ticket.at, kind: "body" });
  if (ticket.tableName) lines.push({ label: "Table", value: ticket.tableName, kind: "body" });
  if (ticket.customerName) lines.push({ label: "For", value: ticket.customerName, kind: "body" });
  lines.push({ label: "", kind: "rule" });

  for (const line of ticket.lines) {
    // The quantity is the VALUE column, so a column of quantities lines up down
    // the right-hand edge and a customer can count their order at a glance.
    //
    // FORMATTED, never raw: a whole number reads `x2` and a portion reads
    // `x0.5`. Printing the raw value would show `x0.7500000000000001` after a
    // few taps, and rounding it would tell the customer they are getting a
    // whole pizza.
    lines.push({ label: line.name, value: `x${formatQuantity(line.qty)}`, kind: "body" });
    for (const modifier of line.modifiers) lines.push({ label: `  + ${modifier}`, kind: "body" });
    if (line.note) lines.push({ label: `  ${line.note}`, kind: "body" });
  }

  if (ticket.orderNote) {
    lines.push({ label: "", kind: "rule" });
    lines.push({ label: "Note", kind: "heading" });
    lines.push({ label: ticket.orderNote, kind: "body" });
  }

  lines.push({ label: "", kind: "rule" });
  lines.push({ label: "Please keep this ticket", kind: "body" });

  // The order NUMBER is the title, because it is the one thing on this document
  // that gets called across a room. `printReport` draws the title largest.
  return { title: `ORDER ${ticket.orderNumber}`, lines };
}

// -------------------------------------------------------------- printing ----

/** One collection ticket per settled order, per terminal. */
export function collectionEventKey(input: { orderNumber: string; paidAt?: string | null }): string {
  return `collection:${input.orderNumber}${input.paidAt ? `:${input.paidAt}` : ""}`;
}

export type CollectionPrintStatus =
  | { kind: "sent"; copies: number; printer: string }
  | { kind: "failed"; message: string }
  /** Not switched on for this route, or nothing to print. Not worth reporting. */
  | { kind: "off" };

/**
 * Where this terminal's collection ticket goes.
 *
 * Two cases and no guessing between them: a chosen printer is resolved from the
 * branch's own registry, and "follow the receipt" asks the SERVER through
 * `resolve_print_route` exactly as the receipt itself does. Neither invents a
 * destination, and neither falls back to the Windows default - paper in the
 * wrong room is not recoverable.
 */
async function resolveCollectionTarget(input: {
  settings: CollectionTicketSettings;
  tenantId: string;
  branchId: string | null;
  source: ResolverOrderSource;
}): Promise<PrintResolution> {
  const installedResult = await listPrinters();
  const installed = installedResult.ok ? installedResult.value : [];

  if (input.settings.printerId) {
    const printers = await loadServerPrinters({ tenantId: input.tenantId, branchId: input.branchId }).catch(() => []);
    const printer = printerById(printers, input.settings.printerId);
    if (!printer) return { kind: "blocked", block: { reason: "no_route" } };
    return resolveRouteTarget({
      route: routeFromPrinter(printer, input.settings.copies),
      installed,
    });
  }

  if (!input.branchId) return { kind: "blocked", block: { reason: "no_route" } };
  const route = await resolvePrintRoute({
    branchId: input.branchId,
    purpose: "receipt",
    orderSource: input.source,
  }).catch(() => null);
  if (!route) return { kind: "blocked", block: { reason: "no_route" } };
  return resolveRouteTarget({ route, installed });
}

/**
 * Print the collection ticket for a settled order, if this terminal wants one.
 *
 * CALLED AFTER THE MONEY IS SETTLED, like every other function on this path, and
 * with the same guarantee: no RPC, no order read, no cart, no shift, no cash
 * box, and no failure channel that a caller's transaction could depend on. A
 * caller that ignores the result has lost a piece of paper.
 *
 * ONE PER SETTLEMENT. Keyed on the order number and the moment it was paid,
 * through the SAME process-wide latch the receipt and the station tickets use -
 * so a completion sequence that runs twice, or a component that remounts, cannot
 * hand the customer two dockets for one order.
 */
export async function autoPrintCollectionTicket(input: {
  tenantId: string;
  branchId: string | null;
  access: PosAccessContext;
  source: ResolverOrderSource;
  ticket: CollectionTicket;
  paidAt?: string | null;
  settings?: CollectionTicketSettings;
}): Promise<CollectionPrintStatus> {
  if (!isNativeAvailable()) return { kind: "off" };

  const settings = input.settings ?? readCollectionSettings();
  if (!collectionEnabledFor(settings, input.source)) return { kind: "off" };
  if (input.ticket.lines.length === 0) return { kind: "off" };

  // The same permission the customer receipt needs. A collection ticket is a
  // customer document, so an operator who may not print one may not print the
  // other either.
  const permission = canPrintReceipts(input.access);
  if (!permission.allowed) return { kind: "off" };

  const key = collectionEventKey({ orderNumber: input.ticket.orderNumber, paidAt: input.paidAt });
  if (autoPrintLatch.claimed(key)) return { kind: "off" };

  const resolution = await resolveCollectionTarget({
    settings,
    tenantId: input.tenantId,
    branchId: input.branchId,
    source: input.source,
  });
  if (resolution.kind !== "single") {
    return { kind: "failed", message: describeBlock(resolution.block, "receipt") };
  }
  if (!autoPrintLatch.claim(key)) return { kind: "off" };

  try {
    const result = await printReport({
      printerName: resolution.target.windowsName,
      paperWidth: resolution.target.paperWidth,
      copies: settings.printerId ? resolution.target.copies : boundCopies(settings.copies),
      report: toCollectionReport(input.ticket),
    });
    if (result.ok) {
      return { kind: "sent", copies: result.value.copies_accepted, printer: result.value.printer_name };
    }
    return { kind: "failed", message: result.error.message };
  } catch (e) {
    return { kind: "failed", message: e instanceof Error ? e.message : "The collection ticket could not be printed." };
  } finally {
    autoPrintLatch.release(key);
  }
}

/**
 * Print one by hand.
 *
 * DELIBERATELY UNLATCHED, and that is the difference between this and the
 * automatic path. A cashier asking for another copy has looked at the printer
 * and decided they need one; refusing them because the automatic attempt already
 * used the key would leave a customer with no ticket and no way to get one. The
 * automatic path is the one that must never repeat itself, because nobody is
 * watching it.
 */
export async function printCollectionTicketNow(input: {
  tenantId: string;
  branchId: string | null;
  source: ResolverOrderSource;
  ticket: CollectionTicket;
  settings?: CollectionTicketSettings;
}): Promise<CollectionPrintStatus> {
  if (!isNativeAvailable()) {
    return { kind: "failed", message: "Printing is available only in the installed Desktop app." };
  }
  if (input.ticket.lines.length === 0) return { kind: "off" };
  const settings = input.settings ?? readCollectionSettings();
  const resolution = await resolveCollectionTarget({
    settings,
    tenantId: input.tenantId,
    branchId: input.branchId,
    source: input.source,
  });
  if (resolution.kind !== "single") {
    return { kind: "failed", message: describeBlock(resolution.block, "receipt") };
  }
  try {
    const result = await printReport({
      printerName: resolution.target.windowsName,
      paperWidth: resolution.target.paperWidth,
      copies: settings.printerId ? resolution.target.copies : boundCopies(settings.copies),
      report: toCollectionReport(input.ticket),
    });
    return result.ok
      ? { kind: "sent", copies: result.value.copies_accepted, printer: result.value.printer_name }
      : { kind: "failed", message: result.error.message };
  } catch (e) {
    return { kind: "failed", message: e instanceof Error ? e.message : "The collection ticket could not be printed." };
  }
}
