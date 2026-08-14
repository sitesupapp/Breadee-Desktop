// Turning a routing answer into a destination this terminal can actually reach.
//
// WHY THIS IS ONE MODULE AND NOT TWO. Level 3E-B worked out how a routed
// document becomes a printable target: exact Windows matching against a live
// enumeration, a width the renderer can lay out, the ROUTE's copy count, and a
// named reason for every refusal. Kitchen tickets need exactly the same answer
// from exactly the same inputs.
//
// Copying it would have been fewer lines to read today and a guaranteed drift
// tomorrow: the moment one copy learns about a new connection type, or bounds
// copies differently, receipts and tickets start disagreeing about which
// printers are reachable - on the same terminal, from the same route table. So
// the resolution lives here once, and the DOCUMENT-SPECIFIC part - the wording
// an operator reads, and where they are sent to fix it - is a parameter.
//
// NOTHING HERE PRINTS, and nothing here decides WHICH printer: `resolve_print_route`
// already did that on the server. This module only answers "and can this
// terminal reach what the branch configured?".

import { MAX_COPIES, MIN_COPIES, type InstalledPrinter, type PaperWidth } from "@/lib/nativePrinting";
import { effectivePaperWidth } from "@/lib/pos/printerRegistry";
import type { ResolvedRoute } from "@/lib/pos/printRouteResolver";
import type { PrintPurpose } from "@/lib/pos/printRouting";

/** The routed destination, once this terminal has confirmed it can reach it. */
export type PrintTarget = {
  /** The route's printer, by its Breadee name. */
  printerName: string;
  /** The exact Windows printer name, matched from a live enumeration. */
  windowsName: string;
  paperWidth: PaperWidth;
  copies: number;
  /** True when the `any` default matched rather than a source-specific route. */
  usedDefault: boolean;
};

/** Why no document of this purpose can be printed, when that is the case. */
export type PrintBlock =
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
  /** The document does not say which kind of order it is, so it cannot be routed. */
  | { reason: "unknown_source" };

export type PrintResolution =
  | { kind: "single"; target: PrintTarget }
  | { kind: "blocked"; block: PrintBlock };

function boundedCopies(value: number | null): number {
  if (value === null || !Number.isFinite(value)) return MIN_COPIES;
  return Math.min(Math.max(Math.trunc(value), MIN_COPIES), MAX_COPIES);
}

/**
 * Turn the server's routing answer into a destination, or into a reason.
 *
 * Every rejection is reported with a reason rather than filtered into silence:
 * "no route is configured" and "the routed printer is not installed on this
 * till" are different problems with different fixes, and an operator told only
 * "cannot print" has to guess which.
 *
 * NOTHING IS GUESSED. No Windows default, no first printer of the right type,
 * no first configured printer. An unroutable document is refused with a
 * sentence that says what to fix - paper in the wrong room is not recoverable.
 */
export function resolveRouteTarget(input: {
  route: ResolvedRoute;
  installed: InstalledPrinter[];
}): PrintResolution {
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

  // Exact match only, against a live enumeration. A near-match is a different
  // device, and on a restaurant network the other device may be in another room.
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
        width:
          route.paper_width === "custom"
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
      // The ROUTE's copy count, not the printer row's device default. The route
      // is where an operator says "two copies of a delivery receipt".
      copies: boundedCopies(route.copies),
      usedDefault: route.used_default === true || route.matched_order_source === "any",
    },
  };
}

/**
 * One sentence per block, phrased so the operator knows what to do next.
 *
 * The purpose changes the noun and the destination of the fix, and nothing
 * else: receipt routing lives under Printing & Routing, kitchen ticket routing
 * under the same screen but a different section, and telling someone to look in
 * the wrong one wastes a service call.
 */
export function describeBlock(block: PrintBlock, purpose: PrintPurpose): string {
  const doc = purpose === "receipt" ? "receipt" : "kitchen ticket";
  const section = purpose === "receipt" ? "Customer receipts" : "Kitchen tickets";
  switch (block.reason) {
    case "no_route":
      return `No ${doc} route is configured for this branch. Set one in Settings → Printing & Routing → Routing → ${section}.`;
    case "unbound":
      return `${block.printer} is routed for ${doc}s, but no Windows printer has been recorded for it. Finish it in Settings → Printing & Routing → Quick Setup.`;
    case "unsupported_connection":
      return `${block.printer} is set to ${block.connection}. ${capitalise(doc)} printing drives Windows printers; network printing is not available yet.`;
    case "not_installed":
      return `${block.printer} is routed for ${doc}s, but ${block.windowsName} is not installed on this terminal.`;
    case "unsupported_paper":
      return `${block.printer} is set to ${block.width}. ${capitalise(doc)} printing supports 58 mm, 80 mm and custom printable widths.`;
    case "unknown_source":
      return `This ${doc} does not say which kind of order it is, so it cannot be routed to a printer.`;
  }
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
