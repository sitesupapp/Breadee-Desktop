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
// WHAT SURVIVED UNCHANGED:
//
//   * NOTHING IS GUESSED. No Windows default, no first cashier printer, no first
//     configured printer. An unroutable receipt is refused with a sentence that
//     says what to fix.
//   * EXACT WINDOWS MATCHING. A near-match is a different device, and on a
//     restaurant network the other device may be in another room.
//   * WIDTH DECIDES LAYOUT. A width the renderer cannot lay out blocks the print
//     rather than being approximated - clipping a total off the right-hand edge
//     is not survivable on paper the customer keeps.
//   * `desktop_connector` stays unsupported rather than guessed at.
//
// WHAT CHANGED, AND WHY:
//
//   * WIDTH now comes from P2's `effectivePaperWidth`, which combines
//     `paper_width` and `custom_paper_width` into one printable figure. The old
//     code accepted `58mm`/`80mm` only and would have refused the branch's
//     actual XP-80 (`custom` + 72), which is the printer receipts are routed to.
//     There is deliberately no second width parser in this file.
//   * COPIES come from the ROUTE, not the printer row. The route is where an
//     operator says "two copies of a delivery receipt"; the printer row's
//     `default_copy_count` is a device default the route overrides.
//   * THE OPERATOR NO LONGER PICKS. There is nothing left to pick between - the
//     resolver returns one destination or none.

import { MAX_COPIES, MIN_COPIES, type InstalledPrinter, type PaperWidth } from "@/lib/nativePrinting";
import { effectivePaperWidth } from "@/lib/pos/printerRegistry";
import type { ResolvedRoute } from "@/lib/pos/printRouteResolver";
import type { ReceiptOrderSource } from "@/lib/receipt";
import type { Gate } from "@/components/ui";

/** The routed destination, once this terminal has confirmed it can reach it. */
export type CashierTarget = {
  /** The route's printer, by its Breadee name. */
  printerName: string;
  /** The exact Windows printer name, matched from a live enumeration. */
  windowsName: string;
  paperWidth: PaperWidth;
  copies: number;
  /** True when the `any` default matched rather than a source-specific route. */
  usedDefault: boolean;
};

/** Why no receipt can be printed, when that is the case. */
export type CashierBlock =
  /** `resolve_print_route` matched nothing for this branch and source. */
  | { reason: "no_route" }
  /** Routed, but no Windows printer has been recorded for that printer. */
  | { reason: "unbound"; printer: string }
  /** Routed to a connection this app cannot drive. */
  | { reason: "unsupported_connection"; printer: string; connection: string }
  /** Routed, but the Windows queue is not installed on THIS terminal. */
  | { reason: "not_installed"; printer: string; windowsName: string }
  /** Routed, but the stored width is not one the renderer can lay out. */
  | { reason: "unsupported_paper"; printer: string; width: string }
  /** The receipt does not say which kind of order it is, so it cannot be routed. */
  | { reason: "unknown_source" };

export type CashierResolution =
  | { kind: "single"; target: CashierTarget }
  | { kind: "blocked"; block: CashierBlock };

function boundedCopies(value: number | null): number {
  if (value === null || !Number.isFinite(value)) return MIN_COPIES;
  return Math.min(Math.max(Math.trunc(value), MIN_COPIES), MAX_COPIES);
}

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

/**
 * Turn the server's routing answer into a destination, or into a reason.
 *
 * Every rejection is reported with a reason rather than filtered into silence:
 * "no receipt route is configured" and "the routed printer is not installed on
 * this till" are different problems with different fixes, and an operator told
 * only "cannot print" has to guess which.
 */
export function resolveReceiptTarget(input: {
  route: ResolvedRoute;
  installed: InstalledPrinter[];
}): CashierResolution {
  const { route } = input;
  if (!route.resolved) return { kind: "blocked", block: { reason: "no_route" } };

  const printer = route.printer_name ?? "The routed printer";

  if (route.connection_type !== null && route.connection_type !== "system") {
    return {
      kind: "blocked",
      block: { reason: "unsupported_connection", printer, connection: route.connection_type },
    };
  }
  if (!route.system_printer_name) {
    return { kind: "blocked", block: { reason: "unbound", printer } };
  }

  // Exact match only, against a live enumeration.
  const installedNames = new Set(input.installed.map((p) => p.name));
  if (!installedNames.has(route.system_printer_name)) {
    return {
      kind: "blocked",
      block: { reason: "not_installed", printer, windowsName: route.system_printer_name },
    };
  }

  const paperWidth = effectivePaperWidth({
    paper_width: route.paper_width,
    custom_paper_width: route.custom_paper_width,
  });
  if (!paperWidth) {
    return {
      kind: "blocked",
      block: {
        reason: "unsupported_paper",
        printer,
        width: route.paper_width === "custom"
          ? `custom (${route.custom_paper_width ?? "no"} mm)`
          : (route.paper_width ?? "not set"),
      },
    };
  }

  return {
    kind: "single",
    target: {
      printerName: printer,
      windowsName: route.system_printer_name,
      paperWidth,
      copies: boundedCopies(route.copies),
      usedDefault: route.used_default === true || route.matched_order_source === "any",
    },
  };
}

/** One sentence per block, phrased so the operator knows what to do next. */
export function blockMessage(block: CashierBlock): string {
  switch (block.reason) {
    case "no_route":
      return "No receipt route is configured for this branch. Set one in Settings → Printing & Routing → Routing.";
    case "unbound":
      return `${block.printer} is routed for receipts, but no Windows printer has been recorded for it. Finish it in Settings → Printing & Routing → Quick Setup.`;
    case "unsupported_connection":
      return `${block.printer} is set to ${block.connection}. Receipt printing drives Windows printers; network printing is not available yet.`;
    case "not_installed":
      return `${block.printer} is routed for receipts, but ${block.windowsName} is not installed on this terminal.`;
    case "unsupported_paper":
      return `${block.printer} is set to ${block.width}. Receipt printing supports 58 mm, 80 mm and custom printable widths.`;
    case "unknown_source":
      return "This receipt does not say which kind of order it is, so it cannot be routed to a printer.";
  }
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
