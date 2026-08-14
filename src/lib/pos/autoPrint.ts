// Safe automatic printing.
//
// THE ONLY REASON THIS FEATURE IS DANGEROUS IS DUPLICATES. Everything else about
// it is trivial: a setting is on, a route resolves, a document exists, print it.
// What makes it worth this much prose is that "print it" runs without anybody
// watching, in a React app that remounts components, recovers state after a
// reload, and re-reads orders from the server whenever a screen opens. Every one
// of those is a way for the same order to look "newly successful" twice.
//
// SO THE TRIGGER IS AN EVENT, NEVER A STATE. Nothing here asks "is this order
// paid?" or "does this table have a bill?" - a question about STATE is true
// again tomorrow, and after a restart, and every time the queue is refreshed.
// The trigger is "this UI transaction just returned successfully, once", and it
// is identified by a key the caller mints for that one transaction. A key that
// has already been printed is never printed again for the life of the process.
//
// WHAT THIS DELIBERATELY DOES NOT PROMISE. Not global exactly-once. There is no
// server-side record of what has been printed - `print_jobs` exists in the
// schema and is deliberately not written by this phase - so a second terminal,
// or this one after a restart, cannot know what the first already produced. What
// IS promised is bounded and honest:
//
//   * ONE attempt per successful local transaction event. Not one per render,
//     not one per mount, not one per re-read.
//   * NO automatic retry, ever. A failed or ambiguous print asks the operator to
//     look at the printer.
//   * NO printing on application start, on session recovery, or from reading
//     historical state. Recovery restores what the SERVER knows; it never
//     re-fires an event that already happened.
//   * MANUAL print and reprint stay available, always, and are unaffected by
//     any of this.
//
// PRINTING CANNOT REACH THE TRANSACTION. Every function here is called AFTER the
// RPC has returned successfully. None of them takes an order id to act on, calls
// an RPC, touches the cart, the shift or the cash box, or returns anything the
// caller's transaction depends on. A caller that ignores the result entirely has
// lost a piece of paper and nothing else - which is the correct relative
// importance of paper and money.

import type { Gate } from "@/components/ui";
import type { PrintResolution } from "@/lib/pos/printTarget";

/** Whether a document type is set to print by itself, as the server records it. */
export type AutoPrintSettings = {
  /** `pos_receipt_settings.auto_print_customer`. */
  customer: boolean;
  /** `pos_receipt_settings.auto_print_kitchen`. */
  kitchen: boolean;
};

/**
 * What the desktop assumes when the setting cannot be read.
 *
 * BOTH OFF. The column defaults to true on the server, so this is deliberately
 * NOT the server's default - and the asymmetry is the point. Failing to a
 * printing state means an unreadable settings row produces paper nobody asked
 * for, on a terminal whose configuration is already in doubt. Failing to a
 * silent state costs an operator one button press and produces nothing they
 * have to throw away.
 */
export const AUTO_PRINT_UNKNOWN: AutoPrintSettings = { customer: false, kitchen: false };

// --- the once-per-event latch ------------------------------------------------

/**
 * A synchronous latch that remembers which transaction events have been printed.
 *
 * Two mechanisms, because there are two distinct failures:
 *
 *   * `inFlight` stops the SECOND CALL IN THE SAME TICK. React state is
 *     asynchronous, so a boolean in a component would be read stale by both. A
 *     closure decides in the calling tick, which is the only place the decision
 *     can be made in time. Same reasoning as `createPaymentLatch`.
 *   * `done` stops the SECOND CALL LATER. A component remount, a re-render
 *     triggered by a refreshed cash box, or a completion sequence that runs its
 *     steps again would all arrive with the same key, long after `inFlight`
 *     cleared.
 *
 * `done` is unbounded in principle and trivially bounded in practice: it holds
 * one short string per transaction taken on this terminal since launch, and it
 * is cleared by exiting the app - which is also the moment the "one attempt per
 * successful transaction" promise stops meaning anything anyway.
 */
export type AutoPrintLatch = {
  /** True exactly once per key, and only when nothing else is in flight. */
  claim: (key: string) => boolean;
  release: (key: string) => void;
  /** Has this key already been claimed? Reported so a UI can say "already sent". */
  claimed: (key: string) => boolean;
};

export function createAutoPrintLatch(): AutoPrintLatch {
  const done = new Set<string>();
  let inFlight = false;
  return {
    claim: (key: string) => {
      if (inFlight || done.has(key)) return false;
      // Marked done BEFORE the attempt, not after. If the print throws, or the
      // app is closed mid-print, the key must still count as attempted: the
      // spooler may already hold the job, and a retry is exactly the duplicate
      // this latch exists to prevent.
      done.add(key);
      inFlight = true;
      return true;
    },
    release: () => {
      inFlight = false;
    },
    claimed: (key: string) => done.has(key),
  };
}

/**
 * THE process-wide latch.
 *
 * Module-level so it survives every remount, and shared by both document types
 * so a receipt and a ticket can never be in flight at the same moment on one
 * terminal. Serialising them is deliberate: two documents racing to the same
 * thermal printer is how a receipt ends up interleaved with a ticket.
 */
export const autoPrintLatch = createAutoPrintLatch();

// --- the decision ------------------------------------------------------------

/**
 * Why nothing was printed automatically. Reported rather than swallowed - an
 * operator who expected paper needs to know which of these it was.
 */
export type AutoPrintSkip =
  /** Not the installed app, so there is no native printing at all. */
  | { reason: "not_native" }
  /** The branch has this document set to manual. */
  | { reason: "disabled" }
  /** The operator may not print this document. */
  | { reason: "not_permitted"; detail: string }
  /** There is no document to print. */
  | { reason: "nothing_to_print" }
  /** Routing said no, or this terminal cannot reach what it named. */
  | { reason: "unroutable"; resolution: PrintResolution }
  /** Already attempted for this transaction event. */
  | { reason: "already_attempted" };

export type AutoPrintDecision = { kind: "print" } | { kind: "skip"; skip: AutoPrintSkip };

/**
 * Should this document print by itself?
 *
 * Pure and latch-free: the caller claims the latch only once this has said
 * "print", so the decision can be unit-tested without consuming a key, and a
 * key is never burned by a document that was never going to print.
 *
 * The order is the order an operator would want explained. "Printing is off for
 * this branch" and "no kitchen route is configured" are both silence, and they
 * are fixed in different screens by different people.
 */
export function decideAutoPrint(input: {
  nativeAvailable: boolean;
  enabled: boolean;
  permission: Gate;
  hasDocument: boolean;
  resolution: PrintResolution | null;
  alreadyAttempted: boolean;
}): AutoPrintDecision {
  if (!input.nativeAvailable) return { kind: "skip", skip: { reason: "not_native" } };
  if (!input.enabled) return { kind: "skip", skip: { reason: "disabled" } };
  if (!input.permission.allowed) {
    return {
      kind: "skip",
      skip: { reason: "not_permitted", detail: input.permission.reason ?? "You do not have permission to print." },
    };
  }
  if (!input.hasDocument) return { kind: "skip", skip: { reason: "nothing_to_print" } };
  if (!input.resolution || input.resolution.kind === "blocked") {
    return {
      kind: "skip",
      skip: { reason: "unroutable", resolution: input.resolution ?? { kind: "blocked", block: { reason: "no_route" } } },
    };
  }
  // Checked LAST, so a document that was never eligible does not report itself
  // as "already sent" - which would send an operator looking at a printer that
  // was never asked for anything.
  if (input.alreadyAttempted) return { kind: "skip", skip: { reason: "already_attempted" } };
  return { kind: "print" };
}

/**
 * Which skips are worth interrupting an operator for.
 *
 * A branch that has turned automatic printing off does not want to be told so
 * after every order, and neither does a dev-server build. An unroutable document
 * IS worth saying, once, because it means the kitchen is not being told about
 * food - and that is invisible until someone complains about a missing order.
 */
export function skipIsWorthReporting(skip: AutoPrintSkip): boolean {
  return skip.reason === "unroutable" || skip.reason === "not_permitted";
}

// --- transaction event keys --------------------------------------------------
//
// A key names ONE successful UI transaction. It is built from what the SERVER
// returned, never from a clock or a random value: two calls describing the same
// completed transaction must produce the same key, or the latch cannot recognise
// the repeat it exists to stop.

/** The kitchen ticket for one submitted batch of one order. */
export function kitchenEventKey(input: { orderId: string; batchNo?: number | null }): string {
  return `kitchen:${input.orderId}:${input.batchNo ?? 1}`;
}

/** The customer receipt for one settled order or table bill. */
export function receiptEventKey(input: { orderNumber: string; paidAt?: string | null }): string {
  return `receipt:${input.orderNumber}${input.paidAt ? `:${input.paidAt}` : ""}`;
}
