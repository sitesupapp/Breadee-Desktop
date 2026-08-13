// The Test Center: a routing simulator for support, and nothing else.
//
// WHAT PROBLEM IT SOLVES. When a restaurant phones to say "the kitchen isn't
// getting tickets", the only way to answer today is to ring up a real order and
// watch what happens - which means a real order, real money, a real shift and a
// real void afterwards. This screen asks the SAME server resolver the real path
// will ask, for a source the technician picks, and shows the answer with the
// reason attached.
//
// WHAT IT MUST NEVER DO. Create anything. There is no order, no payment, no
// shift, no customer, no table, no inventory or accounting movement, no kitchen
// ticket row and no print job record. The documents below are in-memory strings
// built from constants; the only network call the Test Center makes is
// `resolve_print_route`, which is a read.
//
// WHY THE DOCUMENTS SAY "NOT A REAL ORDER" TWICE. A test page that looks like a
// receipt is a receipt as far as anyone who finds it on a counter is concerned -
// a customer, an auditor, or a cashier reconciling a drawer. So the synthetic
// documents carry no order number, no customer, no total that could be mistaken
// for money taken, and they announce themselves in the first line and again in
// the body.

import { paperWidthLabel, type PaperWidth } from "@/lib/nativePrinting";
import {
  orderSourceLabel,
  type PrintPurpose,
  type TestableOrderSource,
} from "@/lib/pos/printRouting";
import type { ResolvedRoute } from "@/lib/pos/printRouteResolver";

// ----------------------------------------------------- match explanation ----

/**
 * WHY this printer, in one phrase.
 *
 * Support cannot fix routing they cannot explain. "Front Cashier" alone leaves
 * open whether the branch configured takeaway deliberately or is falling through
 * to a default nobody remembers setting, and those have opposite fixes.
 */
export function matchExplanation(route: ResolvedRoute, purpose: PrintPurpose): string | null {
  if (!route.resolved) return null;
  const kind = purpose === "receipt" ? "receipt" : "kitchen";
  if (route.used_default === true) return `Default ${kind} route`;
  const source = route.matched_order_source;
  if (source === "any") return `Default ${kind} route`;
  if (source === "takeaway" || source === "dine_in" || source === "delivery" || source === "e_menu") {
    return `${orderSourceLabel(source)}-specific ${kind} route`;
  }
  // Resolved, but the server did not say which row matched. Saying "default"
  // here would be a guess presented as an explanation.
  return `Configured ${kind} route`;
}

/** What to say when nothing matched. A configuration state, never an error. */
export function unresolvedExplanation(purpose: PrintPurpose): string {
  return purpose === "receipt"
    ? "No matching receipt route is configured for this branch."
    : "No matching kitchen ticket route is configured for this branch.";
}

// -------------------------------------------------- synthetic documents -----

export const TEST_RECEIPT_TITLE = "TEST RECEIPT";
export const TEST_KITCHEN_TITLE = "TEST KITCHEN TICKET";
export const NOT_A_REAL_ORDER = "NOT A REAL ORDER";

export type SyntheticDocument = {
  title: typeof TEST_RECEIPT_TITLE | typeof TEST_KITCHEN_TITLE;
  /** Repeated in the body so a page found on a counter still says so. */
  banner: typeof NOT_A_REAL_ORDER;
  /** Plain lines. No order number, no customer, no money taken. */
  lines: string[];
  footer: string;
};

/**
 * A receipt-shaped page that could not be mistaken for a fiscal document.
 *
 * Deliberately missing: an order number, a date that reads like a transaction
 * time, a customer, a payment method, and any total presented as taken. What
 * remains is enough to prove the paper, the width and the character set.
 */
export function syntheticReceipt(source: TestableOrderSource): SyntheticDocument {
  return {
    title: TEST_RECEIPT_TITLE,
    banner: NOT_A_REAL_ORDER,
    lines: [
      `Order type: ${orderSourceLabel(source)}`,
      "Order number: none - this is a test",
      "1 x Test Item",
      "1 x Test Drink",
      "No payment was taken.",
    ],
    footer: "Printed from Breadee Test Center to check routing and paper width.",
  };
}

/** The kitchen equivalent. No ticket row is created for it anywhere. */
export function syntheticKitchenTicket(source: TestableOrderSource): SyntheticDocument {
  return {
    title: TEST_KITCHEN_TITLE,
    banner: NOT_A_REAL_ORDER,
    lines: [
      `Order type: ${orderSourceLabel(source)}`,
      "Ticket number: none - this is a test",
      "1 x Test Pizza",
      "1 x Test Drink",
      "Do not prepare these items.",
    ],
    footer: "Printed from Breadee Test Center to check routing and paper width.",
  };
}

export function syntheticDocument(purpose: PrintPurpose, source: TestableOrderSource): SyntheticDocument {
  return purpose === "receipt" ? syntheticReceipt(source) : syntheticKitchenTicket(source);
}

// ------------------------------------------------------- confirmation -------

/**
 * The sentence shown before any physical output, naming every fact that decides
 * where paper appears.
 *
 * All six are here on purpose. The Breadee alias alone is not enough - two
 * branches call different devices "Kitchen" - and the Windows queue alone is not
 * enough either, because it is the alias the operator recognises. The width and
 * the copy count are what makes the difference between one correct page and
 * three clipped ones.
 */
export function confirmationSentence(input: {
  document: SyntheticDocument["title"];
  source: TestableOrderSource;
  printerAlias: string;
  windowsPrinterName: string;
  paperWidth: PaperWidth;
  copies: number;
}): string {
  const copies = `${input.copies} ${input.document}${input.copies === 1 ? "" : "S"}`;
  return (
    `${copies} for a ${orderSourceLabel(input.source)} order will be sent to ` +
    `${input.printerAlias} (${input.windowsPrinterName}) at ${paperWidthLabel(input.paperWidth)}.`
  );
}

/**
 * Physical output is not part of this phase.
 *
 * The confirmation is built and shown - it is the contract the next phase has to
 * honour, and reviewing it now is cheaper than reviewing it beside a printer -
 * but the Test Center sends nothing. The native layer's only page today is the
 * printer diagnostic page from Quick Setup, which is a different document from
 * the two above; rendering these would be a Rust change, and inventing it as a
 * side effect of a routing screen is how a phase boundary stops meaning anything.
 */
export const PHYSICAL_TEST_UNAVAILABLE =
  "Sending a test document to paper arrives in the next printing phase. Nothing is printed from this screen.";
