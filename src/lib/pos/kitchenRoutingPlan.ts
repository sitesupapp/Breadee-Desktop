// A COMPLETE, VALIDATED ROUTING PLAN FOR ONE KITCHEN TICKET - BEFORE ANY PAPER.
//
// THE INVARIANT THIS MODULE EXISTS TO PROTECT. A kitchen send must never report
// success while eligible order lines silently vanish from physical output. For
// every send:
//
//     eligible lines  =  routed lines  +  unresolved lines
//
// with no unexplained remainder. Production order #260916-0003 broke that: nine
// eligible lines, six routed to a category printer and printed, three with no
// matching rule and no branch default kitchen route - which resolved to
// `no_route` and were dropped while the run reported "sent". The persisted order
// and the server kitchen ticket both held all nine; the loss was purely in the
// desktop's per-line routing.
//
// SO ROUTING IS RESOLVED IN FULL, FIRST, AND SEPARATELY FROM PRINTING. This
// module takes the station groups the splitter produced, resolves a reachable
// destination for EVERY one of them, and returns a plan that says exactly which
// lines are routed and which are not. It prints nothing, reads no database and
// resolves nothing the server has not already decided - it only turns already-
// resolved answers into a plan a caller can validate before dispatching a single
// job. `autoPrintRun.ts` is that caller, and its rule is simple: if the plan is
// not fully routable, no job is dispatched at all.
//
// COALESCING IS BY RESOLVED PHYSICAL PRINTER, NOT BY LOGICAL GROUP. Two logical
// groups - the default catch-all and an explicit category rule, say - can resolve
// to the SAME configured printer (the same `pos_printer_settings` row). Left
// alone they would print two separate tickets on one device: fragmented paper for
// one order. So groups that resolve to the same printer id are merged into one
// job. Two DISTINCT printers that merely share a Windows queue are NOT merged:
// they are two intentional stations, and the operator asked for two tickets.

import type { InstalledPrinter } from "@/lib/nativePrinting";
import type { KitchenTicket } from "@/lib/pos/kitchenPrinter";
import type { PrintPurpose } from "@/lib/pos/printRouting";
import {
  describeBlock,
  resolveRouteTarget,
  type PrintBlock,
  type PrintResolution,
  type PrintTarget,
} from "@/lib/pos/printTarget";
import { printerById, routeFromPrinter, type StationTicket } from "@/lib/pos/stationTickets";
import type { ServerPrinter } from "@/lib/pos/printerRegistry";

/** One line of the built ticket, as this module carries it. Nothing about money. */
type TicketLine = KitchenTicket["lines"][number];

/** A line's identity within one ticket: its position, name and routing category. */
export type KitchenLineRef = { index: number; name: string; categoryId: string | null };

/**
 * Why an eligible line could not be given a reachable destination.
 *
 * `block` is the shared resolver's own answer (no route, printer not installed on
 * this terminal, unsupported width, and so on). `printer_missing` is the one case
 * the shared resolver cannot express: a category or item rule that names a
 * printer this branch no longer has.
 */
export type KitchenUnresolvedReason =
  | { kind: "block"; block: PrintBlock }
  | { kind: "printer_missing"; printerId: string };

export type KitchenUnresolved = { ref: KitchenLineRef; reason: KitchenUnresolvedReason };

/** One physical destination's ticket, after every group that lands on it is merged. */
export type KitchenPrinterJob = {
  /** The resolved `pos_printer_settings.id`. The coalescing and latch identity. */
  printerId: string;
  /** Where and how the reachable destination prints. */
  target: PrintTarget;
  /** Copies for this destination: the highest any merged group asked for. */
  copies: number;
  /** The merged lines, restored to the order they were taken in. */
  lines: TicketLine[];
  refs: KitchenLineRef[];
};

/**
 * The whole plan for one ticket.
 *
 * `routable` is the gate the caller reads: true exactly when `unresolved` is
 * empty, i.e. every eligible line has somewhere to go.
 */
export type KitchenRoutingPlan = {
  eligible: KitchenLineRef[];
  routed: KitchenLineRef[];
  unresolved: KitchenUnresolved[];
  jobs: KitchenPrinterJob[];
  routable: boolean;
};

type GroupResolution =
  | { kind: "single"; printerId: string; target: PrintTarget; copies: number }
  | { kind: "unresolved"; reason: KitchenUnresolvedReason };

/**
 * The id a default-group destination coalesces and latches under when the server
 * route did not carry a printer id. Never a real printer; only a stable key so
 * two default lines still merge into one job instead of fragmenting.
 */
const DEFAULT_PRINTER_KEY = "__default__";

/** Resolve ONE logical group to a reachable printer, or to a named reason. */
function resolveGroup(input: {
  group: StationTicket;
  defaultResolution: PrintResolution;
  printers: ServerPrinter[];
  installed: InstalledPrinter[];
}): GroupResolution {
  const { group, defaultResolution, printers, installed } = input;

  // The branch default: the destination `resolve_print_route` already chose. Not
  // re-derived here - re-deriving the default would be the second source of truth
  // the whole printing programme avoids.
  if (group.printerId === null) {
    if (defaultResolution.kind === "blocked") {
      return { kind: "unresolved", reason: { kind: "block", block: defaultResolution.block } };
    }
    const target = defaultResolution.target;
    return { kind: "single", printerId: target.printerId ?? DEFAULT_PRINTER_KEY, target, copies: target.copies };
  }

  // An explicit category or item rule. The printer must still exist and be
  // reachable from this terminal, checked through the ONE shared resolver.
  const printer = printerById(printers, group.printerId);
  if (!printer) return { kind: "unresolved", reason: { kind: "printer_missing", printerId: group.printerId } };

  const resolved = resolveRouteTarget({ route: routeFromPrinter(printer, group.copies), installed });
  if (resolved.kind === "blocked") return { kind: "unresolved", reason: { kind: "block", block: resolved.block } };
  return {
    kind: "single",
    printerId: printer.id,
    target: { ...resolved.target, printerId: printer.id },
    copies: resolved.target.copies,
  };
}

/**
 * Build the complete plan for a ticket that has already been split into groups.
 *
 * Pure and deterministic: same inputs, same plan, in the same order, every time.
 * It resolves every group, collects the lines of any that cannot be reached as
 * `unresolved`, and coalesces the rest by resolved printer id into `jobs`.
 */
export function planKitchenRouting(input: {
  ticket: KitchenTicket;
  groups: StationTicket[];
  defaultResolution: PrintResolution;
  printers: ServerPrinter[];
  installed: InstalledPrinter[];
}): KitchenRoutingPlan {
  const { ticket, groups, defaultResolution, printers, installed } = input;

  // Identity by position in the built ticket. Lines are the same objects the
  // splitter carried, so their index is exact and stable.
  const indexOf = (line: TicketLine) => ticket.lines.indexOf(line);
  const refOf = (line: TicketLine): KitchenLineRef => ({
    index: indexOf(line),
    name: line.name,
    categoryId: line.categoryId,
  });
  const eligible = ticket.lines.map(refOf);

  const unresolved: KitchenUnresolved[] = [];
  const merged = new Map<string, { target: PrintTarget; copies: number; lines: TicketLine[] }>();

  for (const group of groups) {
    const lines = group.ticket.lines;
    const resolution = resolveGroup({ group, defaultResolution, printers, installed });
    if (resolution.kind === "unresolved") {
      for (const line of lines) unresolved.push({ ref: refOf(line), reason: resolution.reason });
      continue;
    }
    const existing = merged.get(resolution.printerId);
    if (existing) {
      existing.lines.push(...lines);
      existing.copies = Math.max(existing.copies, resolution.copies);
    } else {
      merged.set(resolution.printerId, { target: resolution.target, copies: resolution.copies, lines: [...lines] });
    }
  }

  const jobs: KitchenPrinterJob[] = [...merged.entries()]
    .map(([printerId, acc]) => {
      // One printer's ticket reads top-to-bottom in the order the lines were
      // taken, not default-group-then-rule-group. Sorted by original index.
      const lines = [...acc.lines].sort((a, b) => indexOf(a) - indexOf(b));
      return {
        printerId,
        target: { ...acc.target, copies: acc.copies },
        copies: acc.copies,
        lines,
        refs: lines.map(refOf),
      };
    })
    .sort((a, b) => a.printerId.localeCompare(b.printerId));

  return {
    eligible,
    routed: jobs.flatMap((job) => job.refs),
    unresolved,
    jobs,
    routable: unresolved.length === 0,
  };
}

// --- the dispatch result, aggregated -----------------------------------------

/** What one destination's print attempt did. Fed to `classifyKitchenDispatch`. */
export type JobDispatchResult =
  | { kind: "sent"; printerId: string; printer: string; copies: number; refs: KitchenLineRef[] }
  | { kind: "failed"; printerId: string; printer: string; message: string; refs: KitchenLineRef[] }
  /** Nothing was attempted for this destination (auto-print off for it, say). */
  | { kind: "skipped"; printerId: string; refs: KitchenLineRef[] };

/**
 * The overall status of one kitchen send, precise enough to prove completeness.
 *
 *   * `blocked_before_print` - routing was incomplete; NO job was dispatched.
 *   * `partial_physical_failure` - some destinations printed, at least one failed
 *     after dispatch began (a jam, a queue that vanished).
 *   * `complete_failure` - every destination that was attempted failed.
 *   * `success` - every attempted destination printed; any skipped destination
 *     was a deliberate local auto-print veto, recoverable from the preview.
 *   * `manual` - nothing was attempted (auto-print off, no native layer).
 */
export type KitchenOverallStatus =
  | "success"
  | "blocked_before_print"
  | "partial_physical_failure"
  | "complete_failure"
  | "manual";

/** The completeness proof for one send: which lines went where, and the verdict. */
export type KitchenDispatchSummary = {
  overallStatus: Exclude<KitchenOverallStatus, "blocked_before_print">;
  printedLineIndexes: number[];
  failedLineIndexes: number[];
};

/**
 * Turn per-destination results into one verdict, from evidence only.
 *
 * A FAILURE ANYWHERE IS A FAILURE, even when other destinations printed: each
 * station's paper is the only notice that station gets, so "three of four" is a
 * kitchen missing an order, not a success to round up. A skipped destination is
 * NOT a failure - it is a deliberate local veto whose lines are still on the
 * full ticket in the preview.
 */
export function classifyKitchenDispatch(input: { results: JobDispatchResult[] }): KitchenDispatchSummary {
  const sent = input.results.filter((r): r is Extract<JobDispatchResult, { kind: "sent" }> => r.kind === "sent");
  const failed = input.results.filter((r): r is Extract<JobDispatchResult, { kind: "failed" }> => r.kind === "failed");

  const printedLineIndexes = sent.flatMap((r) => r.refs.map((ref) => ref.index));
  const failedLineIndexes = failed.flatMap((r) => r.refs.map((ref) => ref.index));

  if (failed.length > 0) {
    return {
      overallStatus: sent.length > 0 ? "partial_physical_failure" : "complete_failure",
      printedLineIndexes,
      failedLineIndexes,
    };
  }
  if (sent.length > 0) return { overallStatus: "success", printedLineIndexes, failedLineIndexes };
  return { overallStatus: "manual", printedLineIndexes, failedLineIndexes };
}

// --- operator-facing wording -------------------------------------------------

/** The distinct affected item names, de-duplicated and in the order taken. */
export function unresolvedItemNames(plan: KitchenRoutingPlan): string[] {
  const seen = new Set<number>();
  return plan.unresolved
    .filter((u) => (seen.has(u.ref.index) ? false : (seen.add(u.ref.index), true)))
    .sort((a, b) => a.ref.index - b.ref.index)
    .map((u) => u.ref.name);
}

/** The fix for one unresolved reason, in the operator's words. */
export function unresolvedFix(reason: KitchenUnresolvedReason, purpose: PrintPurpose = "kitchen_ticket"): string {
  if (reason.kind === "printer_missing") {
    return "A station rule points at a printer that no longer exists. Check Settings → Printing & Routing → Item routing.";
  }
  return describeBlock(reason.block, purpose);
}

/**
 * The single fix sentence for a blocked plan.
 *
 * The first unresolved reason's fix: on a branch with no kitchen route at all -
 * the production case - every unresolved line shares it, so this is the whole
 * story. When reasons differ, it is still the actionable next step, and the item
 * list beside it names exactly what did not print.
 */
export function blockedPlanFix(plan: KitchenRoutingPlan): string {
  const first = plan.unresolved[0];
  return first ? unresolvedFix(first.reason) : "";
}
