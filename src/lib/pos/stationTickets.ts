// Turning ONE order into the production tickets its stations need.
//
// THE INVARIANT THIS FILE EXISTS TO PROTECT: splitting is a PAPER operation and
// nothing else. One order stays one order - one id, one number, one cart, one
// subtotal, one tax calculation, one discount, one payment, one customer
// receipt, one accounting event, one inventory effect. Nothing in this module
// creates, reads, submits, settles or refreshes an order; it takes a ticket that
// has already been built from an already-accepted batch and returns several
// smaller tickets made of the same lines.
//
// A STATION TICKET IS THE SAME DOCUMENT, WITH FEWER LINES. It is built by
// copying the batch ticket and replacing its `lines`, so every operational field
// a cook needs - order number, order type, table, round, customer name for
// delivery, order note, the per-line modifiers and notes - is identical on every
// station's copy by construction rather than by three careful assignments. And
// because it is a `KitchenTicket`, it has nowhere to put a price: the type that
// crosses the native boundary carries no money at all.
//
// NOTHING IS INVENTED FOR AN EMPTY STATION. A station with no lines in this
// order gets NO ticket, not an empty one. A blank ticket on a pass is a cook
// checking whether they missed something.

import type { ServerPrinter } from "@/lib/pos/printerRegistry";
import type { ResolvedRoute } from "@/lib/pos/printRouteResolver";
import type { ResolverOrderSource } from "@/lib/pos/printRouting";
import type { KitchenTicket } from "@/lib/pos/kitchenPrinter";
import { groupLinesByPrinter, type ItemRoute } from "@/lib/pos/itemRouting";

/** One station's paper: where it goes, how many, and exactly what is on it. */
export type StationTicket = {
  /** Null is the branch's existing kitchen-ticket route - see `itemRouting.ts`. */
  printerId: string | null;
  /** Copies for an explicitly routed station. The default group uses the
      server route's own count, which is why this is ignored for `null`. */
  copies: number;
  ticket: KitchenTicket;
};

/**
 * Split a batch ticket by resolved destination.
 *
 * With no rules configured this returns exactly ONE ticket, routed to the
 * default, holding the original `lines` array. That is the previous release's
 * behaviour reproduced exactly, and it is the path every existing tenant takes.
 */
export function splitTicketByStation(input: {
  ticket: KitchenTicket;
  routes: ItemRoute[];
  orderSource: ResolverOrderSource;
}): StationTicket[] {
  const groups = groupLinesByPrinter({
    lines: input.ticket.lines,
    routes: input.routes,
    orderSource: input.orderSource,
  });
  return groups
    .filter((group) => group.lines.length > 0)
    .map((group) => ({
      printerId: group.printerId,
      copies: group.copies,
      // The SAME ticket, with fewer lines. Spread rather than rebuilt: a
      // hand-written copy is where a station ticket loses its table number.
      ticket: { ...input.ticket, lines: group.lines },
    }));
}

/**
 * Describe a configured printer in the shape `resolveRouteTarget` already reads.
 *
 * WHY THIS ADAPTER EXISTS RATHER THAN A SECOND RESOLVER. Deciding whether a
 * destination is reachable from this terminal - supported connection, a recorded
 * Windows queue, that queue actually installed here, a width the renderer can
 * lay out - is four rules that `printTarget.ts` already implements once for
 * receipts and kitchen tickets alike. Writing them again for station printers
 * would mean a fifth rule learned in one place and not the other, and what the
 * two copies would disagree about is which printers a terminal can reach.
 *
 * So a station printer is expressed as a routing answer, and the existing
 * resolver answers it. `resolved: true` is correct here: the row IS the routing
 * decision - an operator named this printer in a rule.
 */
export function routeFromPrinter(printer: ServerPrinter, copies: number): ResolvedRoute {
  return {
    resolved: true,
    route_id: null,
    printer_id: printer.id,
    printer_name: printer.name,
    printer_type: printer.printer_type,
    connection_type: printer.connection_type,
    system_printer_name: printer.system_printer_name,
    paper_width: printer.paper_width,
    custom_paper_width: printer.custom_paper_width,
    copies,
    print_purpose: "kitchen_ticket",
    // An item or category rule is by definition NOT the `any` default, and
    // saying otherwise would make a station ticket report itself as having
    // fallen back when it did exactly what it was told.
    matched_order_source: null,
    used_default: false,
  };
}

/**
 * The latch key for one station's copy of one batch.
 *
 * The printer is PART of the key. Without it, printing the grill's ticket would
 * burn the key for the whole batch and the bar would never be told - which is a
 * missing order rather than a missing page. With it, each destination is
 * attempted exactly once per batch and no more.
 *
 * The default group keys on the literal `default` rather than on a resolved
 * printer id, so a branch that changes its default route mid-service cannot
 * re-print a batch that has already been sent.
 */
export function stationEventKey(input: { orderId: string; batchNo?: number | null; printerId: string | null }): string {
  return `kitchen:${input.orderId}:${input.batchNo ?? 1}:${input.printerId ?? "default"}`;
}

/** A printer row by id, for turning a rule's `printerId` into a destination. */
export function printerById(printers: ServerPrinter[], id: string): ServerPrinter | null {
  return printers.find((p) => p.id === id) ?? null;
}
