// Where a kitchen ticket goes, and what is on it.
//
// THE SAME ROUTING MECHANISM, A DIFFERENT DOCUMENT. `resolve_print_route` was
// built for two purposes from the start; P3-B wired the first (`receipt`) and
// left the second (`kitchen_ticket`) resolvable but unused. This module wires
// the second. It re-implements no precedence, reads no `printer_type`, and adds
// no second opinion about which printer a branch has chosen - see
// `printTarget.ts`, which both documents now share.
//
// A PRINT PURPOSE IS NOT A PRINTER TYPE. A branch with one physical printer
// routes both purposes to the same cashier device and that is a legitimate
// setup - which is exactly why the kitchen path never filters by
// `printer_type = 'kitchen'`. The route decides; the device's declared role is a
// recommendation the routing screen makes and nothing here enforces.
//
// THE BATCH IS THE TICKET. `buildKitchenTicket` takes the LINES THAT WERE JUST
// SUBMITTED, never a re-read of the whole bill. On a dine-in table that is the
// entire feature: round 2's ticket must contain round 2, or the kitchen cooks
// round 1 twice. The caller holds the submitted round; this module never goes
// looking for one.
//
// NOTHING HERE IS A TRANSACTION. No RPC, no order read, no shift, no cash box.
// A ticket that cannot be printed is reported and the order stays exactly as
// the server recorded it.

import type { InstalledPrinter } from "@/lib/nativePrinting";
import type { ResolvedRoute } from "@/lib/pos/printRouteResolver";
import type { ResolverOrderSource } from "@/lib/pos/printRouting";
import {
  describeBlock,
  resolveRouteTarget,
  type PrintBlock,
  type PrintResolution,
  type PrintTarget,
} from "@/lib/pos/printTarget";
import type { Gate } from "@/components/ui";

export type KitchenTarget = PrintTarget;
export type KitchenBlock = PrintBlock;
export type KitchenResolution = PrintResolution;

/** Turn the server's routing answer into a ticket destination, or a reason. */
export function resolveKitchenTarget(input: {
  route: ResolvedRoute;
  installed: InstalledPrinter[];
}): KitchenResolution {
  return resolveRouteTarget(input);
}

/** One sentence per block, in kitchen-ticket wording. */
export function kitchenBlockMessage(block: KitchenBlock): string {
  return describeBlock(block, "kitchen_ticket");
}

// ------------------------------------------------------------- the ticket ---

/**
 * A line as the POS holds it, in any of the three routes.
 *
 * `qty`, a name, modifiers and a note - and deliberately nothing else. The cart
 * line, the round buffer line and a re-read order item all carry prices too;
 * they are dropped HERE rather than at the native boundary so there is never a
 * moment where a priced object is what the ticket is made of.
 */
export type KitchenSourceLine = {
  name: string;
  qty: number;
  modifiers?: { name: string; quantity?: number }[];
  note?: string | null;
};

export type KitchenTicket = {
  businessName: string;
  branchName: string;
  staffName: string | null;
  orderNumber: string;
  orderType: string;
  at: string;
  tableName: string | null;
  batchLabel: string | null;
  customerName: string | null;
  orderNote: string | null;
  lines: { name: string; qty: number; modifiers: { name: string; quantity: number }[]; note: string | null }[];
  test: boolean;
};

/** Display wording per source, matching what the routes and receipts say. */
export function kitchenOrderTypeLabel(source: ResolverOrderSource): string {
  switch (source) {
    case "takeaway":
      return "Takeaway";
    case "dine_in":
      return "Dine-In";
    case "delivery":
      return "Delivery";
    case "e_menu":
      return "E-Menu";
  }
}

/**
 * Build the ticket for ONE submitted batch.
 *
 * Pure, so the thing that decides what a kitchen is told can be tested without
 * a printer, a server or a React tree - which is the only way the dine-in
 * "only the new round" rule gets checked at all before paper is involved.
 *
 * A line with a quantity of zero or less is dropped: it is not something to
 * cook, and printing it invites a cook to make it.
 */
export function buildKitchenTicket(input: {
  businessName: string | null | undefined;
  branchName: string;
  staffName?: string | null;
  orderNumber: string;
  source: ResolverOrderSource;
  at: string;
  lines: KitchenSourceLine[];
  tableName?: string | null;
  /** The server's own round number for a dine-in batch, when it is known. */
  batchNo?: number | null;
  customerName?: string | null;
  orderNote?: string | null;
  test?: boolean;
}): KitchenTicket {
  return {
    businessName: input.businessName?.trim() || "Breadee",
    branchName: input.branchName,
    staffName: input.staffName ?? null,
    orderNumber: input.orderNumber,
    orderType: kitchenOrderTypeLabel(input.source),
    at: input.at,
    // A table name only means anything for dine-in, and a stray one on a
    // takeaway ticket would send a cook looking for a table that has no order.
    tableName: input.source === "dine_in" ? (input.tableName ?? null) : null,
    batchLabel:
      input.source === "dine_in" && typeof input.batchNo === "number" && input.batchNo > 0
        ? `Round ${input.batchNo}`
        : null,
    // Delivery only: the name, never the address or the phone. A cook does not
    // deliver, and a ticket left on a pass is a customer's address in a room
    // that has no reason to hold one.
    customerName: input.source === "delivery" ? (input.customerName ?? null) : null,
    orderNote: input.orderNote?.trim() ? input.orderNote.trim() : null,
    lines: input.lines
      .filter((l) => Number(l.qty) > 0)
      .map((l) => ({
        name: l.name,
        qty: l.qty,
        modifiers: (l.modifiers ?? []).map((m) => ({ name: m.name, quantity: m.quantity ?? 1 })),
        note: l.note?.trim() ? l.note.trim() : null,
      })),
    test: input.test ?? false,
  };
}

// -------------------------------------------------------------- the gate ----

/**
 * THE kitchen-ticket print gate.
 *
 * One result shared by every surface that can send a ticket - the button, the
 * confirmation and the automatic path - so no caller can hold a different
 * opinion about whether this ticket may be printed.
 *
 * Note the ORDER of the first two checks. Native availability comes first
 * because it is a fact about this build rather than about this operator, and
 * telling a cashier they lack a permission when the real answer is "you are in
 * the dev server" sends them to the wrong person.
 */
export function kitchenPrintGate(input: {
  nativeAvailable: boolean;
  canPrintKitchenTickets: Gate;
  resolution: KitchenResolution | null;
  hasTicket: boolean;
  busy: boolean;
}): Gate {
  if (!input.nativeAvailable) {
    return { allowed: false, reason: "Native printing is available only in the installed Desktop app." };
  }
  if (!input.canPrintKitchenTickets.allowed) return input.canPrintKitchenTickets;
  if (!input.hasTicket) return { allowed: false, reason: "There is nothing to send to the kitchen." };
  if (!input.resolution) return { allowed: false, reason: "Looking for a printer..." };
  if (input.resolution.kind === "blocked") {
    return { allowed: false, reason: kitchenBlockMessage(input.resolution.block) };
  }
  if (input.busy) return { allowed: false, reason: "This ticket is already being sent." };
  return { allowed: true, reason: null };
}

/**
 * THE sentence shown when an order succeeded but its ticket could not print.
 *
 * Stated once, as a constant, because it is the single most important thing this
 * feature says to an operator: the order is fine, the paper is not, and the two
 * facts are separate. Anything vaguer invites a cashier to "fix" a successful
 * order by sending it again.
 */
export const ORDER_SUCCEEDED_TICKET_DID_NOT = "The order was sent successfully. Only the kitchen ticket failed.";

/** The unresolved-route case, which is a configuration state and not a fault. */
export function unroutableNotice(block: KitchenBlock): string {
  return `${ORDER_SUCCEEDED_TICKET_DID_NOT} ${kitchenBlockMessage(block)}`;
}
