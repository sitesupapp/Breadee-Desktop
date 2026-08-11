// Which printer a cashier receipt may go to.
//
// THE CONTRACT, read from the current server and web app rather than assumed:
//
//   * ELIGIBILITY. `pos_printer_settings` rows that are `is_active`, of
//     `printer_type = 'cashier'`, with `connection_type = 'system'` and a
//     `system_printer_name` that EXACTLY matches a printer Windows enumerates.
//     A kitchen row is not a cashier printer, and this file will not reinterpret
//     one as though it were.
//
//   * BRANCH. Strict equality. The web app's Receipts & Printers screen queries
//     `.eq("tenant_id", …).eq("branch_id", …)` and always writes `branch_id` on
//     insert, so a tenant-wide (NULL branch) printer row is not something the
//     product creates and is not something an operator can see or manage. Making
//     one apply to every branch here would be inventing a rule the product does
//     not have - and the consequence would be paper coming out at another site.
//
//   * PRECEDENCE. There is none. Nothing in the schema or the web app ranks two
//     cashier printers against each other: no `is_default`, no priority, no
//     ordering. So when more than one is eligible this module refuses to choose,
//     and the operator picks. A hidden automatic choice is exactly the kind of
//     rule that is invisible until a receipt prints in the wrong room.
//
//   * PAPER WIDTH comes from the PRINTER row, not from `pos_receipt_settings`.
//     The web app lays its browser receipt out using `pos_receipt_settings
//     .paper_size` because it is rendering a design; this is driving a physical
//     device, and the roll loaded in that device is described by the printer
//     row. Rendering 80mm onto a 58mm roll clips the amounts off the right-hand
//     edge, so the device's own width wins and anything that is not 58/80 is
//     refused rather than approximated.
//
//   * COPIES come from the printer row's `default_copy_count`, bounded 1..=5.
//
//   * `desktop_connector` has no documented semantics anywhere in the web app,
//     so it stays unsupported rather than being guessed at.

import { MAX_COPIES, MIN_COPIES, type InstalledPrinter, type PaperWidth } from "@/lib/nativePrinting";
import type { ServerPrinter } from "@/lib/pos/printerRegistry";
import type { Gate } from "@/components/ui";

/** A configured cashier printer that this terminal can actually print to. */
export type CashierTarget = {
  /** The server row it came from. */
  printer: ServerPrinter;
  /** The exact Windows printer name, matched from a live enumeration. */
  windowsName: string;
  paperWidth: PaperWidth;
  copies: number;
};

/** Why no receipt can be printed, when that is the case. */
export type CashierBlock =
  | { reason: "none_configured" }
  | { reason: "not_installed"; printers: string[] }
  | { reason: "unsupported_paper"; printers: string[]; widths: string[] }
  | { reason: "unbound" };

export type CashierResolution =
  /** Exactly one eligible target. Preselected, still printed manually. */
  | { kind: "single"; target: CashierTarget }
  /** More than one. The operator must choose - see PRECEDENCE above. */
  | { kind: "choice"; targets: CashierTarget[] }
  /** Nothing printable, with a reason the UI can act on. */
  | { kind: "blocked"; block: CashierBlock };

function toPaperWidth(value: string | null): PaperWidth | null {
  return value === "58mm" || value === "80mm" ? value : null;
}

function boundedCopies(value: number): number {
  if (!Number.isFinite(value)) return MIN_COPIES;
  return Math.min(Math.max(Math.trunc(value), MIN_COPIES), MAX_COPIES);
}

/** Configured cashier rows for THIS branch, active, on a supported connection. */
export function cashierCandidates(printers: ServerPrinter[], branchId: string | null): ServerPrinter[] {
  return printers.filter(
    (p) => p.printer_type === "cashier" && p.connection_type === "system" && p.branch_id === branchId,
  );
}

/**
 * Resolve where a receipt may print.
 *
 * Every rejection is reported with a reason rather than being filtered into
 * silence: "no cashier printer is configured" and "the configured one is not
 * installed on this till" are different problems with different fixes, and an
 * operator who is only told "cannot print" has to guess which.
 */
export function resolveCashierTarget(input: {
  printers: ServerPrinter[];
  installed: InstalledPrinter[];
  branchId: string | null;
}): CashierResolution {
  const candidates = cashierCandidates(input.printers, input.branchId);
  if (candidates.length === 0) {
    return { kind: "blocked", block: { reason: "none_configured" } };
  }

  const named = candidates.filter((p) => !!p.system_printer_name);
  if (named.length === 0) {
    // Configured, but nobody has recorded WHICH Windows printer it is.
    return { kind: "blocked", block: { reason: "unbound" } };
  }

  // Exact match only. A near-match is a different device, and on a restaurant
  // network the other device may be in another room.
  const installedNames = new Set(input.installed.map((p) => p.name));
  const present = named.filter((p) => installedNames.has(p.system_printer_name as string));
  if (present.length === 0) {
    return {
      kind: "blocked",
      block: { reason: "not_installed", printers: named.map((p) => p.system_printer_name as string) },
    };
  }

  const targets: CashierTarget[] = [];
  const badWidths: { name: string; width: string }[] = [];
  for (const printer of present) {
    const paperWidth = toPaperWidth(printer.paper_width);
    if (!paperWidth) {
      badWidths.push({ name: printer.name, width: printer.paper_width ?? "not set" });
      continue;
    }
    targets.push({
      printer,
      windowsName: printer.system_printer_name as string,
      paperWidth,
      copies: boundedCopies(printer.default_copy_count),
    });
  }

  if (targets.length === 0) {
    // a4 / custom / missing. Deliberately stricter than the web app, which
    // silently falls back to 80mm: that is survivable for a browser preview and
    // is not survivable when it clips a real total off a real roll.
    return {
      kind: "blocked",
      block: {
        reason: "unsupported_paper",
        printers: badWidths.map((b) => b.name),
        widths: badWidths.map((b) => b.width),
      },
    };
  }

  if (targets.length === 1) return { kind: "single", target: targets[0] };
  return { kind: "choice", targets };
}

/** One sentence per block, phrased so the operator knows what to do next. */
export function blockMessage(block: CashierBlock): string {
  switch (block.reason) {
    case "none_configured":
      return "No cashier printer is configured for this branch. Add one in the Breadee web app.";
    case "unbound":
      return "A cashier printer is configured for this branch, but no Windows printer name has been recorded for it.";
    case "not_installed":
      return `${block.printers.join(", ")} is configured for this branch but is not installed on this terminal.`;
    case "unsupported_paper":
      return `${block.printers.join(", ")} is set to ${block.widths.join(", ")}. Native receipt printing supports 58mm and 80mm only.`;
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
