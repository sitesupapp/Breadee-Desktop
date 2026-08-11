// The one place the frontend talks to native code.
//
// Every `invoke` in the application goes through this module. That is not tidiness
// for its own sake: the native boundary is the only path from the webview to the
// operating system, and a boundary with one door can be reviewed, typed and tested
// in a way that scattered `invoke("...")` calls cannot.
//
// WHAT THIS MODULE REFUSES TO DO.
//   - It never builds a request from a free-form string. Command names are
//     constants; the paper width is a union of two values; copies are clamped.
//   - It sends no bytes, no file path, no address and no port. The native side
//     owns the page content, so there is nothing for a caller to inject.
//   - It never falls back to `window.print()`. This feature is native printing;
//     silently substituting a browser dialog would report success for something
//     entirely different from what was asked for.
//
// In the browser dev server there is no Tauri runtime, so every call reports
// `native_unavailable` and the UI says so plainly. A fake printer list would be
// worse than none: it would make a broken build look like a working one.

/** Commands the Rust side exposes. Must match `EXPOSED_COMMANDS` in printing/mod.rs. */
export const NATIVE_COMMANDS = ["list_printers", "print_test_page", "print_receipt"] as const;
export type NativeCommand = (typeof NATIVE_COMMANDS)[number];

/** Paper widths this phase can print. Mirrors the Rust `PaperWidth` enum. */
export const PAPER_WIDTHS = ["58mm", "80mm"] as const;
export type PaperWidth = (typeof PAPER_WIDTHS)[number];

export const MIN_COPIES = 1;
export const MAX_COPIES = 5;

export type PrinterStatus = "ready" | "not_ready" | "unknown";

export type InstalledPrinter = {
  name: string;
  is_default: boolean;
  status: PrinterStatus;
};

export type TestPrintRequest = {
  printer_name: string;
  paper_width: PaperWidth;
  copies: number;
};

export type PrintOutcome = {
  accepted: boolean;
  printer_name: string;
  copies_requested: number;
  copies_accepted: number;
  job_ids: number[];
  warning: string | null;
};

/** Error codes the Rust side can return, plus the one this layer adds. */
export type NativePrintErrorCode =
  | "printer_enumeration_failed"
  | "printer_not_found"
  | "invalid_paper_width"
  | "invalid_copy_count"
  | "render_failed"
  | "invalid_receipt"
  | "open_printer_failed"
  | "start_document_failed"
  | "write_failed"
  | "finish_document_failed"
  | "unsupported_platform"
  /** Raised HERE, not by Rust: there is no Tauri runtime (browser dev server). */
  | "native_unavailable"
  /** Anything that did not arrive in the documented shape. */
  | "unexpected";

export type NativePrintError = {
  code: NativePrintErrorCode;
  /** Operator-facing sentence. Never a Win32 dump. */
  message: string;
  /** Technical remainder, for logs and developer diagnostics. */
  detail?: string;
};

/**
 * THE success sentence.
 *
 * The spooler accepting a document is not the same event as ink reaching paper:
 * everything past the queue - cable, power, roll, driver, the printer's own
 * memory - is invisible from here. Saying "printed successfully" would be
 * claiming knowledge this process does not have, and an operator who then finds
 * no paper has been told something false by the till.
 */
export const ACCEPTED_MESSAGE = "Print job accepted by Windows.";

/** Is the Tauri runtime present? False under `npm run dev` in a browser. */
export function isNativeAvailable(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Human wording for each failure, kept beside the codes they explain. */
const MESSAGES: Record<NativePrintErrorCode, string> = {
  printer_enumeration_failed: "Windows could not list the printers on this terminal.",
  printer_not_found: "That printer is no longer installed on this terminal.",
  invalid_paper_width: "That paper width is not supported.",
  invalid_copy_count: `Choose between ${MIN_COPIES} and ${MAX_COPIES} copies.`,
  render_failed: "The page could not be drawn.",
  invalid_receipt: "This receipt cannot be printed.",
  open_printer_failed: "Windows could not open that printer.",
  start_document_failed: "Windows would not start a print job on that printer.",
  write_failed: "The test page could not be sent to that printer.",
  finish_document_failed: "Windows could not finish the print job.",
  unsupported_platform: "Native printing is available on Windows only.",
  native_unavailable: "Native printing is available only in the installed Desktop app.",
  unexpected: "Printing failed for an unexpected reason.",
};

const CODES = new Set<string>(Object.keys(MESSAGES));

/**
 * Turn whatever came back into a typed error.
 *
 * Rust serialises `PrintError` as `{ code, ...detail }`. Anything else - a
 * thrown string, a plugin error, a shape from a future version - becomes
 * `unexpected` rather than being trusted or displayed raw.
 */
export function toNativeError(raw: unknown): NativePrintError {
  if (raw && typeof raw === "object" && "code" in raw) {
    const code = (raw as { code: unknown }).code;
    if (typeof code === "string" && CODES.has(code)) {
      const typed = code as NativePrintErrorCode;
      const rest = { ...(raw as Record<string, unknown>) };
      delete rest.code;
      const detail = Object.keys(rest).length > 0 ? JSON.stringify(rest) : undefined;
      return { code: typed, message: MESSAGES[typed], detail };
    }
  }
  return {
    code: "unexpected",
    message: MESSAGES.unexpected,
    detail: typeof raw === "string" ? raw : safeStringify(raw),
  };
}

function safeStringify(value: unknown): string | undefined {
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/** Bounds a copy count before it leaves the UI. Rust re-checks it regardless. */
export function validateCopies(copies: number): NativePrintError | null {
  if (!Number.isInteger(copies) || copies < MIN_COPIES || copies > MAX_COPIES) {
    return { code: "invalid_copy_count", message: MESSAGES.invalid_copy_count };
  }
  return null;
}

export function isPaperWidth(value: unknown): value is PaperWidth {
  return typeof value === "string" && (PAPER_WIDTHS as readonly string[]).includes(value);
}

/**
 * Build the request.
 *
 * Named field by field rather than spread from a form object, for the same
 * reason the payment payloads are: a spread is all it would take for a stray UI
 * field to become part of a native call.
 */
export function buildTestPrintRequest(input: {
  printerName: string;
  paperWidth: PaperWidth;
  copies: number;
}): TestPrintRequest {
  return {
    printer_name: input.printerName,
    paper_width: input.paperWidth,
    copies: input.copies,
  };
}

async function invokeNative<T>(command: NativeCommand, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

export type NativeResult<T> = { ok: true; value: T } | { ok: false; error: NativePrintError };

/** The printers Windows offers this terminal. Read-only; prints nothing. */
export async function listPrinters(): Promise<NativeResult<InstalledPrinter[]>> {
  if (!isNativeAvailable()) {
    return { ok: false, error: { code: "native_unavailable", message: MESSAGES.native_unavailable } };
  }
  try {
    const printers = await invokeNative<InstalledPrinter[]>("list_printers");
    return { ok: true, value: Array.isArray(printers) ? printers : [] };
  } catch (e) {
    return { ok: false, error: toNativeError(e) };
  }
}

/**
 * Print the diagnostic page.
 *
 * Only ever called from an explicit operator action against a printer they
 * picked by name - never on mount, never on a timer, never as a side effect of
 * loading this screen. Paper is a physical event in someone's restaurant.
 */
export async function printTestPage(input: {
  printerName: string;
  paperWidth: PaperWidth;
  copies: number;
}): Promise<NativeResult<PrintOutcome>> {
  if (!isNativeAvailable()) {
    return { ok: false, error: { code: "native_unavailable", message: MESSAGES.native_unavailable } };
  }
  const invalid = validateCopies(input.copies);
  if (invalid) return { ok: false, error: invalid };
  if (!isPaperWidth(input.paperWidth)) {
    return { ok: false, error: { code: "invalid_paper_width", message: MESSAGES.invalid_paper_width } };
  }
  try {
    const outcome = await invokeNative<PrintOutcome>("print_test_page", {
      request: buildTestPrintRequest(input),
    });
    return { ok: true, value: outcome };
  } catch (e) {
    return { ok: false, error: toNativeError(e) };
  }
}

// --- cashier receipts (Level 3E-B) -------------------------------------------

/** The receipt as Rust receives it. Mirrors `ReceiptDoc` in printing/receipt.rs. */
export type ReceiptDoc = {
  businessName: string;
  branchName: string;
  staffName: string | null;
  orderNumber: string;
  orderType: string;
  at: string;
  paid: boolean;
  method: string | null;
  currency: string;
  lines: {
    name: string;
    qty: number;
    lineTotal: number;
    modifiers: { name: string; price_delta: number; quantity: number }[];
    note: string | null;
  }[];
  subtotal: number;
  discount: number;
  total: number;
  tenderCurrency: string | null;
  tenderTotal: number | null;
  tendered: number | null;
  change: number | null;
  shiftRef: string | null;
  tableName: string | null;
  seats: number | null;
  customerName: string | null;
  customerPhone: string | null;
  deliveryAddress: string | null;
};

/**
 * Map the on-screen receipt onto the document Rust prints.
 *
 * Every field is named. A spread would be shorter and would also be the way an
 * unrelated field - a future UI-only flag, a cached object, anything someone
 * later hangs off `ReceiptData` - silently crosses the native boundary.
 *
 * `tendered` and `change` pass through as whatever the caller holds, which is
 * exactly right: the live payment flow has them, and Level 3D's historical
 * reconstruction deliberately sets them null. Neither is invented here.
 */
export function toReceiptDoc(receipt: {
  businessName: string;
  branchName: string;
  staffName?: string | null;
  orderNumber: string;
  orderType: string;
  at: string;
  paid: boolean;
  method?: string | null;
  currency: string;
  lines: {
    name: string;
    qty: number;
    lineTotal: number;
    modifiers?: { name: string; price_delta: number; quantity: number }[];
    note?: string | null;
  }[];
  subtotal: number;
  discount: number;
  total: number;
  tenderCurrency?: string | null;
  tenderTotal?: number | null;
  tendered?: number | null;
  change?: number | null;
  shiftRef?: string | null;
  tableName?: string | null;
  seats?: number | null;
  customerName?: string | null;
  customerPhone?: string | null;
  deliveryAddress?: string | null;
}): ReceiptDoc {
  return {
    businessName: receipt.businessName,
    branchName: receipt.branchName,
    staffName: receipt.staffName ?? null,
    orderNumber: receipt.orderNumber,
    orderType: receipt.orderType,
    at: receipt.at,
    paid: receipt.paid,
    method: receipt.method ?? null,
    currency: receipt.currency,
    lines: receipt.lines.map((l) => ({
      name: l.name,
      qty: l.qty,
      lineTotal: l.lineTotal,
      modifiers: (l.modifiers ?? []).map((m) => ({
        name: m.name,
        price_delta: m.price_delta,
        quantity: m.quantity,
      })),
      note: l.note ?? null,
    })),
    subtotal: receipt.subtotal,
    discount: receipt.discount,
    total: receipt.total,
    tenderCurrency: receipt.tenderCurrency ?? null,
    tenderTotal: receipt.tenderTotal ?? null,
    tendered: receipt.tendered ?? null,
    change: receipt.change ?? null,
    shiftRef: receipt.shiftRef ?? null,
    tableName: receipt.tableName ?? null,
    seats: receipt.seats ?? null,
    customerName: receipt.customerName ?? null,
    customerPhone: receipt.customerPhone ?? null,
    deliveryAddress: receipt.deliveryAddress ?? null,
  };
}

/**
 * Print a cashier receipt.
 *
 * MANUAL ONLY. Called from one place - the operator pressing Print in the
 * receipt preview and confirming a named printer. It is never wired to payment,
 * to order submission or to the preview opening, because a print failure must
 * not be able to reach a settled transaction, and the simplest way to guarantee
 * that is for the two never to share a code path.
 */
export async function printReceipt(input: {
  printerName: string;
  paperWidth: PaperWidth;
  copies: number;
  receipt: Parameters<typeof toReceiptDoc>[0];
}): Promise<NativeResult<PrintOutcome>> {
  if (!isNativeAvailable()) {
    return { ok: false, error: { code: "native_unavailable", message: MESSAGES.native_unavailable } };
  }
  const invalid = validateCopies(input.copies);
  if (invalid) return { ok: false, error: invalid };
  if (!isPaperWidth(input.paperWidth)) {
    return { ok: false, error: { code: "invalid_paper_width", message: MESSAGES.invalid_paper_width } };
  }
  try {
    const outcome = await invokeNative<PrintOutcome>("print_receipt", {
      request: {
        printerName: input.printerName,
        paperWidth: input.paperWidth,
        copies: input.copies,
        receipt: toReceiptDoc(input.receipt),
      },
    });
    return { ok: true, value: outcome };
  } catch (e) {
    return { ok: false, error: toNativeError(e) };
  }
}
