// Where a cashier receipt goes.
//
// RECONCILED WITH P3-B. This module used to answer the question itself: find the
// `printer_type = 'cashier'` rows for this branch, refuse to choose between two,
// and read the width off the printer row. That was the right answer while the
// product had no way to express "receipts go HERE" - there was no `is_default`,
// no priority and no ordering anywhere, so picking one would have invented a
// rule.
//
// P3-B added the mechanism that was missing. A branch now configures a **Default
// Receipt route** (`print_purpose = 'receipt'`, `order_source = 'any'`), plus
// optional per-source overrides, and `resolve_print_route` decides. So this
// module no longer decides anything about WHICH printer - it asks, and turns the
// server's answer into something the preview can print to or explain.
//
// WHY THAT MATTERS RATHER THAN BEING TIDINESS. Two mechanisms answering "which
// printer prints this receipt" is exactly the failure the routing screen exists
// to prevent: support configures the Takeaway route, the till keeps printing to
// whatever cashier row it found first, and nobody can see why. There is one
// authority now, and it is the server's.
//
// REFACTORED FOR POS v1. The route-to-destination step - exact Windows matching,
// the width the renderer can lay out, the route's copy count, and a named reason
// for every refusal - now lives in `printTarget.ts`, because the second document
// this app prints needs the identical answer from the identical inputs. Two
// copies of that logic would have drifted the first time either learned about a
// new connection type. What stays here is everything RECEIPT-specific: which
// source a receipt is routed for, and the permission gate paper is subject to.
//
// WHAT SURVIVED UNCHANGED, and is now guaranteed for both documents at once:
//
//   * NOTHING IS GUESSED. No Windows default, no first cashier printer, no first
//     configured printer. An unroutable receipt is refused with a sentence that
//     says what to fix.
//   * EXACT WINDOWS MATCHING. A near-match is a different device, and on a
//     restaurant network the other device may be in another room.
//   * WIDTH DECIDES LAYOUT. A width the renderer cannot lay out blocks the print
//     rather than being approximated - clipping a total off the right-hand edge
//     is not survivable on paper the customer keeps.
//   * COPIES COME FROM THE ROUTE, not the printer row.
//   * `desktop_connector` stays unsupported rather than guessed at.

import type { ReceiptOrderSource } from "@/lib/receipt";
import type { ResolvedRoute } from "@/lib/pos/printRouteResolver";
import {
  describeBlock,
  resolveRouteTarget,
  type PrintBlock,
  type PrintResolution,
  type PrintTarget,
} from "@/lib/pos/printTarget";
import type { InstalledPrinter } from "@/lib/nativePrinting";
import type { Gate } from "@/components/ui";

/**
 * The receipt-flavoured names for the shared shapes.
 *
 * Aliases rather than separate types: a receipt destination and a ticket
 * destination are the same fact about the same terminal, and giving them two
 * structurally different types would invite two ways of reading it.
 */
export type CashierTarget = PrintTarget;
export type CashierBlock = PrintBlock;
export type CashierResolution = PrintResolution;

/**
 * The order source a receipt should be routed for.
 *
 * Prefers the explicit `orderSource` field. The fallback reads the DISPLAY
 * string only because receipts built before that field existed still exist in
 * flight; it is deliberately conservative and returns null rather than picking a
 * source it is not sure about - a wrong source could match a Takeaway override
 * and put a delivery receipt on the wrong printer.
 */
export function receiptOrderSource(receipt: {
  orderSource?: ReceiptOrderSource;
  orderType?: string;
}): ReceiptOrderSource | null {
  if (receipt.orderSource) return receipt.orderSource;
  const t = (receipt.orderType ?? "").trim().toLowerCase();
  if (t === "takeaway" || t === "take away" || t === "take-away") return "takeaway";
  if (t === "dine-in" || t === "dine in" || t === "dine_in") return "dine_in";
  if (t === "delivery") return "delivery";
  return null;
}

/** Turn the server's routing answer into a receipt destination, or a reason. */
export function resolveReceiptTarget(input: {
  route: ResolvedRoute;
  installed: InstalledPrinter[];
}): CashierResolution {
  return resolveRouteTarget(input);
}

/** One sentence per block, in receipt wording. */
export function blockMessage(block: CashierBlock): string {
  return describeBlock(block, "receipt");
}

/**
 * THE receipt-print gate.
 *
 * One result, shared by the Print button and the confirmation, so no surface can
 * hold a different opinion about whether this receipt may be printed - the same
 * discipline every money gate in this app follows.
 *
 * `pos.print_receipts` is the authoritative permission ("Print or reprint
 * receipts", feature `pos.printing`). The web POS does not currently enforce it
 * on its browser print, but the KDS does check it, and this produces PHYSICAL
 * paper - so the desktop enforces the documented permission rather than the
 * looser current behaviour. Stricter than the server, never looser, exactly as
 * the table and delivery gates are.
 */
export function receiptPrintGate(input: {
  nativeAvailable: boolean;
  canPrintReceipts: Gate;
  resolution: CashierResolution | null;
  hasReceipt: boolean;
  busy: boolean;
}): Gate {
  if (!input.nativeAvailable) {
    return { allowed: false, reason: "Native printing is available only in the installed Desktop app." };
  }
  if (!input.canPrintReceipts.allowed) return input.canPrintReceipts;
  if (!input.hasReceipt) return { allowed: false, reason: "There is no receipt to print." };
  if (!input.resolution) return { allowed: false, reason: "Looking for a printer..." };
  if (input.resolution.kind === "blocked") {
    return { allowed: false, reason: blockMessage(input.resolution.block) };
  }
  if (input.busy) return { allowed: false, reason: "This receipt is already being sent." };
  return { allowed: true, reason: null };
}
