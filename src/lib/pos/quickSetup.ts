// Quick Setup: the decisions behind the printer installation screen.
//
// Pure on purpose. Everything here is a function of (server rows, what Windows
// enumerated, what the operator typed), so the rules a support technician
// depends on - is this printer usable, may I test it, what exactly will be
// saved - are testable without a printer, without Windows and without React.
//
// THE SHAPE OF THE PROBLEM. A printer is usable from this till only if four
// separate things line up: a row exists for this branch, its connection is one
// this app can drive, the Windows queue it names is actually installed HERE, and
// the width it declares is one the renderer can lay out. Any of the four can
// fail on its own, each has a different fix, and "it won't print" is useless to
// the person holding the roll. So the status is an enumeration with a sentence
// each, not a boolean.

import {
  CUSTOM_PAPER_MAX_MM,
  CUSTOM_PAPER_MIN_MM,
  MAX_COPIES,
  MIN_COPIES,
  customPaperWidth,
  paperWidthLabel,
  type InstalledPrinter,
  type PaperWidth,
} from "@/lib/nativePrinting";
import {
  effectivePaperWidth,
  type PrinterDraft,
  type ServerPrinter,
  type ServerPrinterType,
} from "@/lib/pos/printerRegistry";

/** The roles the database accepts, with the wording support staff read. */
export const PRINTER_ROLES: { value: ServerPrinterType; label: string; hint: string }[] = [
  { value: "cashier", label: "Cashier", hint: "Customer receipts" },
  { value: "kitchen", label: "Kitchen", hint: "Order tickets" },
  { value: "other", label: "Other", hint: "Not used for printing yet" },
];

/**
 * Permission keys, transcribed from the live `pos_printer_settings_write`
 * policy. Role names are deliberately absent - the policy names permissions,
 * and a UI that guessed from a role would disagree with the server the moment
 * a tenant customises one.
 */
export const PRINTER_PERMISSIONS = {
  /** Either of these may write the registry. */
  MANAGE: "kitchen.manage_printers",
  MANAGE_ALT: "pos.settings.manage",
  /** Sending a physical test page. */
  TEST: "kitchen.test_printers",
} as const;

export type PermissionMap = Record<string, boolean> | null | undefined;

const can = (perms: PermissionMap, key: string) => Boolean(perms?.[key]);

/** May this operator create or change a printer row? */
export function canManagePrinters(perms: PermissionMap): boolean {
  return can(perms, PRINTER_PERMISSIONS.MANAGE) || can(perms, PRINTER_PERMISSIONS.MANAGE_ALT);
}

/**
 * May this operator send a test page?
 *
 * Managing printers implies testing them: the policy that lets someone
 * configure a printer already trusts them with the device, and a technician who
 * can save a printer but not prove it works has not finished the install.
 */
export function canTestPrinters(perms: PermissionMap): boolean {
  return can(perms, PRINTER_PERMISSIONS.TEST) || canManagePrinters(perms);
}

// ---------------------------------------------------------------- status ----

export type SetupStatus =
  /** Bound to an installed queue, width supported: this till can print to it. */
  | "ready"
  /** Configured, but the Windows queue it names is not installed here. */
  | "missing"
  /** Configured with no Windows queue recorded yet. */
  | "unbound"
  /** Bound, but the declared width is not one the renderer can lay out. */
  | "unsupported_paper"
  /** usb / network / desktop_connector - not drivable from this phase. */
  | "unsupported_connection"
  /** Switched off. Kept visible so it can be switched back on. */
  | "disabled";

export type ConfiguredPrinter = {
  printer: ServerPrinter;
  status: SetupStatus;
  /** The matched Windows printer, when the status is `ready`. */
  installed: InstalledPrinter | null;
  /** The width to print at, when the status is `ready`. */
  paperWidth: PaperWidth | null;
};

/**
 * Classify every configured printer against this terminal.
 *
 * Order matters. `disabled` wins because an off printer's other problems are
 * not what the operator should be told to fix first; connection is checked
 * before binding because a network printer has no Windows queue to be missing.
 */
export function classifyPrinters(
  configured: ServerPrinter[],
  installed: InstalledPrinter[],
): ConfiguredPrinter[] {
  return configured.map((printer) => {
    const paperWidth = effectivePaperWidth(printer);
    const base = { printer, installed: null, paperWidth };

    if (!printer.is_active) return { ...base, status: "disabled" as const };
    if (printer.connection_type !== "system") {
      return { ...base, status: "unsupported_connection" as const };
    }
    if (!printer.system_printer_name) return { ...base, status: "unbound" as const };

    const match = installed.find((p) => p.name === printer.system_printer_name) ?? null;
    if (!match) return { ...base, status: "missing" as const };
    if (!paperWidth) return { ...base, status: "unsupported_paper" as const, installed: match };
    return { printer, status: "ready" as const, installed: match, paperWidth };
  });
}

/** Short badge wording. */
export function statusLabel(status: SetupStatus): string {
  switch (status) {
    case "ready":
      return "Ready";
    case "missing":
      return "Not on this PC";
    case "unbound":
      return "No printer bound";
    case "unsupported_paper":
      return "Paper not supported";
    case "unsupported_connection":
      return "Connection not supported";
    case "disabled":
      return "Disabled";
  }
}

/** One sentence saying what to do about it. */
export function statusHint(entry: ConfiguredPrinter): string {
  switch (entry.status) {
    case "ready":
      return `Prints to ${entry.installed?.name} at ${entry.paperWidth ? paperWidthLabel(entry.paperWidth) : ""}.`;
    case "missing":
      return `${entry.printer.system_printer_name} is not installed on this PC. Install it in Windows and refresh, or bind this printer to a different queue.`;
    case "unbound":
      return "Choose which Windows printer this is.";
    case "unsupported_paper":
      return `Paper is set to ${entry.printer.paper_width ?? "nothing"}${
        entry.printer.paper_width === "custom" ? ` (${entry.printer.custom_paper_width ?? "no"} mm)` : ""
      }. Native printing supports 58 mm, 80 mm, and custom widths from ${CUSTOM_PAPER_MIN_MM} to ${CUSTOM_PAPER_MAX_MM} mm.`;
    case "unsupported_connection":
      return `This printer is set to ${entry.printer.connection_type}. Quick Setup configures Windows printers; network printing is not available yet.`;
    case "disabled":
      return "Switched off. Turn it back on to use it.";
  }
}

export const READY_TONES: Record<SetupStatus, "green" | "amber" | "red" | "slate"> = {
  ready: "green",
  missing: "red",
  unbound: "amber",
  unsupported_paper: "amber",
  unsupported_connection: "slate",
  disabled: "slate",
};

/** Only a `ready` printer can be sent a page. */
export function canTest(entry: ConfiguredPrinter): boolean {
  return entry.status === "ready" && entry.paperWidth !== null && entry.installed !== null;
}

// ------------------------------------------------------------ detection ----

export type DetectedPrinter = {
  installed: InstalledPrinter;
  /** The configured row already bound to this queue, if any. */
  configured: ServerPrinter | null;
};

/**
 * What Windows has, annotated with whether Breadee already knows about it.
 *
 * This is what stops a support technician creating a second row for a printer
 * that is already set up - the commonest way a branch ends up with two
 * "Front Cashier" printers and paper coming out twice.
 */
export function detectedPrinters(
  installed: InstalledPrinter[],
  configured: ServerPrinter[],
): DetectedPrinter[] {
  return installed.map((p) => ({
    installed: p,
    configured:
      configured.find(
        (c) => c.connection_type === "system" && c.system_printer_name === p.name,
      ) ?? null,
  }));
}

// ----------------------------------------------------------------- draft ----

/**
 * The form the operator fills in, before validation.
 *
 * `paperClass` and `customMm` are separate because that is what the UI shows:
 * a preset picker plus a millimetre box that only matters for `custom`. They
 * are combined into one `PaperWidth` by `validateDraft`, which is the only
 * thing allowed to produce a value the native layer will accept.
 */
export type DraftForm = {
  name: string;
  printer_type: ServerPrinterType;
  system_printer_name: string | null;
  paperClass: "58mm" | "80mm" | "custom";
  customMm: string;
  copies: number;
  is_active: boolean;
};

/** A fresh form for a detected Windows printer. */
export function draftForDetected(installed: InstalledPrinter): DraftForm {
  return {
    // The Windows name is a sensible first guess at the alias and is what the
    // technician recognises; they are expected to rename it to "Front Cashier".
    name: installed.name,
    printer_type: "cashier",
    system_printer_name: installed.name,
    paperClass: "80mm",
    customMm: "",
    copies: 1,
    is_active: true,
  };
}

/** The form for an existing row, so Edit starts from what is stored. */
export function draftForExisting(printer: ServerPrinter): DraftForm {
  const width = effectivePaperWidth(printer);
  const isCustom = (printer.paper_width ?? "").toLowerCase().startsWith("custom");
  return {
    name: printer.name,
    printer_type: printer.printer_type,
    system_printer_name: printer.system_printer_name,
    paperClass: isCustom ? "custom" : width === "58mm" ? "58mm" : "80mm",
    customMm:
      isCustom && printer.custom_paper_width !== null ? String(printer.custom_paper_width) : "",
    copies: printer.default_copy_count,
    is_active: printer.is_active,
  };
}

export type DraftValidation =
  | { ok: true; draft: PrinterDraft }
  | { ok: false; error: string };

/**
 * Turn a form into something saveable, or say precisely what is wrong.
 *
 * Refuses rather than repairs. Silently trimming a 300mm roll to 120, or
 * defaulting a blank width to 80, would store a number the operator never chose
 * and then print at it.
 */
export function validateDraft(form: DraftForm): DraftValidation {
  const name = form.name.trim();
  if (!name) return { ok: false, error: "Give this printer a name." };

  if (!Number.isInteger(form.copies) || form.copies < MIN_COPIES || form.copies > MAX_COPIES) {
    return { ok: false, error: `Copies must be between ${MIN_COPIES} and ${MAX_COPIES}.` };
  }

  let paperWidth: PaperWidth;
  if (form.paperClass === "custom") {
    const raw = form.customMm.trim();
    if (!raw) return { ok: false, error: "Enter the printable width in millimetres." };
    if (!/^\d+$/.test(raw)) {
      return { ok: false, error: "Printable width must be a whole number of millimetres." };
    }
    const custom = customPaperWidth(Number(raw));
    if (!custom) {
      return {
        ok: false,
        error: `Printable width must be between ${CUSTOM_PAPER_MIN_MM} and ${CUSTOM_PAPER_MAX_MM} mm.`,
      };
    }
    paperWidth = custom;
  } else {
    paperWidth = form.paperClass;
  }

  return {
    ok: true,
    draft: {
      name,
      printer_type: form.printer_type,
      system_printer_name: form.system_printer_name,
      paper_width: paperWidth,
      default_copy_count: form.copies,
      is_active: form.is_active,
    },
  };
}

/**
 * Would saving this create a second row for the same Windows queue?
 *
 * `excludeId` is the row being edited, which must not count as its own
 * duplicate.
 */
export function duplicateBinding(input: {
  systemPrinterName: string | null;
  configured: ServerPrinter[];
  excludeId?: string | null;
}): ServerPrinter | null {
  if (!input.systemPrinterName) return null;
  return (
    input.configured.find(
      (c) =>
        c.id !== input.excludeId &&
        c.connection_type === "system" &&
        c.system_printer_name === input.systemPrinterName,
    ) ?? null
  );
}
