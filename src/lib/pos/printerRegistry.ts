// The SERVER's printer registry, read only.
//
// `pos_printer_settings` is owned by the web app's Receipts & Printers screen and
// by whoever administers a branch. Level 3E-A only reads it, and deliberately
// does not offer create/update/delete: a desktop terminal that could silently
// rewrite a branch's printer configuration would be a second source of truth for
// something the web app already owns properly.
//
// RLS ALREADY SCOPES THIS. The select policy on `pos_printer_settings` is
// `tenant_id = current_tenant_id() AND can_access_branch(branch_id)` with no
// permission or feature gate, so an ordinary cashier session can read it and no
// `kitchen_ops` subscription is involved. The tenant/branch filters below are
// therefore belt-and-braces, not the boundary.
//
// THIS IS NOT `lib/printers.ts`. That module is an older local-only model kept
// in localStorage, with a vocabulary the server does not share (it has a "bar"
// role the database rejects, and no `desktop_connector`). Nothing in the native
// printing path reads it - see `test/native-printing.test.ts`.

import { asRecord, num, numOrNull, str, strOrNull } from "@/lib/pos/rpc";
import type { InstalledPrinter } from "@/lib/nativePrinting";

/** Exactly the values `pos_printer_settings.printer_type` allows. */
export type ServerPrinterType = "cashier" | "kitchen" | "other";
/** Exactly the values `pos_printer_settings.connection_type` allows. */
export type ServerConnectionType = "usb" | "network" | "system" | "desktop_connector";

export type ServerPrinter = {
  id: string;
  name: string;
  printer_type: ServerPrinterType;
  /** Null in the database for older rows; shown as unknown rather than guessed. */
  connection_type: ServerConnectionType | null;
  system_printer_name: string | null;
  paper_width: string | null;
  default_copy_count: number;
  auto_cut_enabled: boolean;
  cash_drawer_enabled: boolean;
  status: string;
  station_id: string | null;
  branch_id: string | null;
};

const COLUMNS =
  "id, name, printer_type, connection_type, system_printer_name, paper_width, default_copy_count, auto_cut_enabled, cash_drawer_enabled, status, station_id, branch_id, is_active";

function toServerPrinter(raw: unknown): ServerPrinter | null {
  const r = asRecord(raw);
  const id = strOrNull(r.id);
  if (!id) return null;
  const type = str(r.printer_type, "other");
  const connection = strOrNull(r.connection_type);
  return {
    id,
    name: str(r.name, "Printer"),
    printer_type: type === "cashier" || type === "kitchen" ? type : "other",
    connection_type:
      connection === "usb" || connection === "network" || connection === "system" || connection === "desktop_connector"
        ? connection
        : null,
    system_printer_name: strOrNull(r.system_printer_name),
    paper_width: strOrNull(r.paper_width),
    default_copy_count: num(r.default_copy_count, 1),
    auto_cut_enabled: r.auto_cut_enabled === true,
    cash_drawer_enabled: r.cash_drawer_enabled === true,
    status: str(r.status, "unknown"),
    station_id: strOrNull(r.station_id),
    branch_id: strOrNull(r.branch_id),
  };
}

/**
 * Active printers configured for this tenant and branch.
 *
 * A row with a null `branch_id` is tenant-wide and applies to every branch, so
 * it is included rather than filtered out - that is what the column means.
 */
export async function loadServerPrinters(input: {
  tenantId: string | null;
  branchId: string | null;
}): Promise<ServerPrinter[]> {
  if (!input.tenantId) return [];
  const { supabase } = await import("@/lib/supabase");
  const { data, error } = await supabase
    .from("pos_printer_settings")
    .select(COLUMNS)
    .eq("tenant_id", input.tenantId)
    .eq("is_active", true)
    .order("name");
  if (error) throw new Error(error.message);
  return ((data ?? []) as unknown[])
    .map(toServerPrinter)
    .filter((p): p is ServerPrinter => p !== null)
    .filter((p) => p.branch_id === null || p.branch_id === input.branchId);
}

/**
 * How a configured printer relates to what Windows actually has.
 *
 * Diagnostic only. Nothing here changes a server row, and a mismatch is
 * reported rather than repaired - a terminal quietly rewriting
 * `system_printer_name` to whatever it found locally is how one branch's
 * configuration ends up describing one particular till.
 */
export type BindingState =
  /** `connection_type = system` and the configured name is installed here. */
  | "bound"
  /** `connection_type = system` but the configured name is not installed here. */
  | "missing"
  /** `connection_type = system` with no `system_printer_name` recorded yet. */
  | "unbound"
  /** usb / network / desktop_connector: not something this phase can drive. */
  | "not_supported_yet";

export type PrinterBinding = {
  printer: ServerPrinter;
  state: BindingState;
  /** The matched Windows printer, when the state is `bound`. */
  installed: InstalledPrinter | null;
};

/**
 * Match configured printers against the installed ones.
 *
 * EXACT string equality, deliberately. A near-match is a different device, and
 * on a restaurant network the other device may be in the kitchen while the
 * operator is looking at the till. Fuzzy matching here would turn a
 * configuration mistake into paper coming out of the wrong room.
 */
export function bindPrinters(
  configured: ServerPrinter[],
  installed: InstalledPrinter[],
): PrinterBinding[] {
  return configured.map((printer) => {
    if (printer.connection_type !== "system") {
      // `desktop_connector` is named in the schema but its semantics are not
      // documented anywhere in the web app, so this phase does not invent them.
      return { printer, state: "not_supported_yet" as const, installed: null };
    }
    const wanted = printer.system_printer_name;
    if (!wanted) {
      return { printer, state: "unbound" as const, installed: null };
    }
    const match = installed.find((p) => p.name === wanted) ?? null;
    return { printer, state: match ? ("bound" as const) : ("missing" as const), installed: match };
  });
}

/** Installed printers with no configured row pointing at them. Diagnostic only. */
export function unconfiguredPrinters(
  configured: ServerPrinter[],
  installed: InstalledPrinter[],
): InstalledPrinter[] {
  const claimed = new Set(
    configured
      .filter((p) => p.connection_type === "system" && p.system_printer_name)
      .map((p) => p.system_printer_name as string),
  );
  return installed.filter((p) => !claimed.has(p.name));
}

/** One short sentence per binding state, for the diagnostics table. */
export function bindingLabel(state: BindingState): string {
  switch (state) {
    case "bound":
      return "Configured and installed";
    case "missing":
      return "Configured, but not installed on this terminal";
    case "unbound":
      return "No Windows printer recorded yet";
    case "not_supported_yet":
      return "Connection type not supported yet";
  }
}
