// Per-printer automatic-printing switches, for THIS terminal.
//
// WHAT THIS IS FOR. The branch already decides two things on the server:
// whether customer receipts print by themselves, whether internal tickets do
// (`pos_receipt_settings.auto_print_*`), and - through Printing & Routing -
// WHERE each document goes. What neither answers is "the bar printer is out of
// paper this evening, stop sending to it from this till". That is a local,
// temporary, operational fact, and putting it on the server would mean one
// terminal silencing a printer for the whole branch.
//
// SO THIS IS A VETO, NEVER A DESTINATION. Nothing here can route a document,
// choose a printer, or cause a print that routing did not already ask for. The
// only thing a disabled switch can do is turn an automatic print into the
// manual one that was always available. Routing decides WHERE; the server
// switches decide WHETHER the document type prints by itself; these decide
// whether THIS terminal participates for THAT printer.
//
// UNKNOWN MEANS ENABLED, and that is the whole backward-compatibility story.
// An installation that has never opened the new screen has an empty map, so
// every printer resolves to "on" and behaves exactly as it did before this
// module existed. A printer added later through Quick Setup is likewise on from
// the moment it appears, because a printer an operator has just configured and
// routed is one they expect to receive paper.

/** Where the switches live. Namespaced alongside the theme key. */
export const AUTO_PRINT_PRINTERS_KEY = "breadee.desktop.autoPrintPrinters";

/**
 * `pos_printer_settings.id` -> participates in automatic printing here.
 *
 * Only explicit decisions are stored. An absent id is not "unknown"; it is
 * "never switched off", which is the same thing as enabled.
 */
export type PrinterAutoPrintMap = Record<string, boolean>;

export const NO_PRINTER_OVERRIDES: PrinterAutoPrintMap = {};

/**
 * Is this printer allowed to receive automatic prints from this terminal?
 *
 * A null id - a route that resolved without naming a printer row - is treated
 * as enabled. Refusing on a missing id would mean a routing shape this module
 * does not recognise silently stopped the kitchen being told about food, which
 * is the one failure worth being permissive about.
 */
export function printerAutoPrintEnabled(map: PrinterAutoPrintMap, printerId: string | null | undefined): boolean {
  if (!printerId) return true;
  return map[printerId] !== false;
}

/** Parse whatever is in storage. Anything unrecognised becomes an empty map. */
export function parsePrinterAutoPrintMap(raw: unknown): PrinterAutoPrintMap {
  if (typeof raw !== "string" || raw.trim() === "") return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: PrinterAutoPrintMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      // Only booleans survive. A stray string or number would otherwise become
      // a truthy "enabled" that nobody chose.
      if (typeof value === "boolean") out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/** Read the switches. Never throws; a terminal with no storage prints as before. */
export function readPrinterAutoPrintMap(storage?: Pick<Storage, "getItem">): PrinterAutoPrintMap {
  try {
    const store = storage ?? (typeof localStorage === "undefined" ? null : localStorage);
    return parsePrinterAutoPrintMap(store?.getItem(AUTO_PRINT_PRINTERS_KEY));
  } catch {
    return {};
  }
}

/**
 * Persist one decision.
 *
 * Enabling REMOVES the key rather than storing `true`. The stored map is then
 * only ever a list of deliberate exceptions, so a printer that is later
 * replaced or re-created cannot inherit a stale "on" that was never a decision.
 */
export function writePrinterAutoPrint(
  printerId: string,
  enabled: boolean,
  storage?: Pick<Storage, "getItem" | "setItem">,
): PrinterAutoPrintMap {
  const store = storage ?? (typeof localStorage === "undefined" ? null : localStorage);
  const next = { ...readPrinterAutoPrintMap(store ?? undefined) };
  if (enabled) delete next[printerId];
  else next[printerId] = false;
  try {
    store?.setItem(AUTO_PRINT_PRINTERS_KEY, JSON.stringify(next));
  } catch {
    /* No storage: the switch applies to this session and is forgotten. */
  }
  return next;
}
