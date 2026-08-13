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
import {
  customPaperWidth,
  isPaperWidth,
  type InstalledPrinter,
  type PaperWidth,
} from "@/lib/nativePrinting";

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
  /** Millimetres, only meaningful when `paper_width` is `custom`. */
  custom_paper_width: number | null;
  default_copy_count: number;
  auto_cut_enabled: boolean;
  cash_drawer_enabled: boolean;
  status: string;
  station_id: string | null;
  branch_id: string | null;
  is_active: boolean;
};

const COLUMNS =
  "id, name, printer_type, connection_type, system_printer_name, paper_width, custom_paper_width, default_copy_count, auto_cut_enabled, cash_drawer_enabled, status, station_id, branch_id, is_active";

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
    custom_paper_width: numOrNull(r.custom_paper_width),
    default_copy_count: num(r.default_copy_count, 1),
    auto_cut_enabled: r.auto_cut_enabled === true,
    cash_drawer_enabled: r.cash_drawer_enabled === true,
    status: str(r.status, "unknown"),
    station_id: strOrNull(r.station_id),
    branch_id: strOrNull(r.branch_id),
    // Absent only if a caller narrows COLUMNS; treated as active, which matches
    // the column default rather than hiding a row that is really there.
    is_active: r.is_active !== false,
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
  /**
   * Include disabled rows. Setup needs them - a printer you cannot see is a
   * printer you cannot re-enable, and the operator would create a duplicate
   * instead. Everything that PRINTS keeps the default and sees active rows only.
   */
  includeInactive?: boolean;
}): Promise<ServerPrinter[]> {
  if (!input.tenantId) return [];
  const { supabase } = await import("@/lib/supabase");
  let query = supabase.from("pos_printer_settings").select(COLUMNS).eq("tenant_id", input.tenantId);
  if (!input.includeInactive) query = query.eq("is_active", true);
  const { data, error } = await query.order("name");
  if (error) throw new Error(error.message);
  return ((data ?? []) as unknown[])
    .map(toServerPrinter)
    .filter((p): p is ServerPrinter => p !== null)
    .filter((p) => p.branch_id === null || p.branch_id === input.branchId);
}

/**
 * The width this printer should actually be laid out against, or null.
 *
 * TWO COLUMNS, ONE FACT. The server stores the roll CLASS in `paper_width` and,
 * when that class is `custom`, the printable millimetres in
 * `custom_paper_width`. Neither column is the answer on its own: `custom` with
 * no width is unusable, and `80mm` on a head that marks 72mm clips the
 * right-hand column of every total. This is the single place the two are
 * combined, so no caller can accidentally use the class as though it were the
 * geometry.
 *
 * Returns null - never a fallback - for `a4`, for `custom` with a missing or
 * out-of-range width, and for anything unrecognised. A guessed width is a
 * physically wrong page, so the caller is told it cannot print and why.
 */
export function effectivePaperWidth(printer: {
  paper_width: string | null;
  custom_paper_width: number | null;
}): PaperWidth | null {
  const klass = (printer.paper_width ?? "").trim().toLowerCase();
  if (klass === "58mm" || klass === "80mm") return klass;
  if (klass === "custom") {
    return printer.custom_paper_width === null ? null : customPaperWidth(printer.custom_paper_width);
  }
  // Some rows carry the web app's `custom:<mm>` spelling directly.
  return isPaperWidth(klass) ? klass : null;
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

// --- writing the registry (Quick Setup) --------------------------------------
//
// Level 3E-A deliberately offered no create/update: a terminal that could
// silently rewrite a branch's printers would be a second source of truth for
// something the web app owned. Quick Setup changes the INTENT, not that rule.
// A support technician installing a till is the person who knows which Windows
// queue is the cashier printer and what the head actually marks, and making
// them alt-tab to a browser to type it in is the reason installs take an
// afternoon. So the desktop may now write - to the SAME table, under the SAME
// RLS, with no desktop-only column and no local cache.
//
// AUTHORISATION IS THE SERVER'S. `pos_printer_settings_write` requires
// `tenant_id = current_tenant_id() AND can_access_branch(branch_id) AND
// assert_feature_access('pos') AND (current_user_can('kitchen.manage_printers')
// OR current_user_can('pos.settings.manage'))`. The UI checks the same
// permission keys so the operator is told before they type, never instead of
// the server deciding.

/** What Quick Setup can set. Anything absent keeps its stored value. */
export type PrinterDraft = {
  name: string;
  printer_type: ServerPrinterType;
  system_printer_name: string | null;
  paper_width: PaperWidth;
  default_copy_count: number;
  is_active: boolean;
};

/**
 * Split a native width back into the two columns the server stores.
 *
 * The inverse of `effectivePaperWidth`, kept beside it so the pair cannot drift.
 */
export function toStoredPaper(width: PaperWidth): {
  paper_width: string;
  custom_paper_width: number | null;
} {
  if (width === "58mm" || width === "80mm") {
    // Clearing `custom_paper_width` matters: a row that was custom and is now a
    // preset must not keep a stale millimetre value that a later reader could
    // mistake for the truth.
    return { paper_width: width, custom_paper_width: null };
  }
  return { paper_width: "custom", custom_paper_width: Number(width.slice("custom:".length)) };
}

/**
 * The client, widened for this table only.
 *
 * `pos_printer_settings` gained 21 columns in m162 that never reached the
 * generated `database.types.ts` - the repo↔DB drift CLAUDE.md documents, and the
 * same reason the web app's PrintersManager reads it schema-loose. The generated
 * type would reject `connection_type`, `paper_width` and `custom_paper_width`
 * as excess properties even though every one of them is a real column this
 * module has just read back.
 *
 * Widening the WRITE path is narrower than it sounds: the column names are
 * fixed literals below, and RLS - not the TypeScript type - is what actually
 * authorises the statement. Regenerating the types is the real fix and belongs
 * with the drift reconciliation, not here.
 */
async function looseClient() {
  const { supabase } = await import("@/lib/supabase");
  return supabase as unknown as {
    from: (table: string) => {
      insert: (row: Record<string, unknown>) => Promise<{ error: { message: string } | null }>;
      update: (row: Record<string, unknown>) => {
        eq: (column: string, value: string) => Promise<{ error: { message: string } | null }>;
      };
    };
  };
}

function draftToRow(draft: PrinterDraft) {
  return {
    name: draft.name.trim(),
    printer_type: draft.printer_type,
    // Quick Setup configures Windows queues. `usb`/`network`/`desktop_connector`
    // are not written here because this phase cannot drive them, and storing a
    // connection the app cannot use would be a printer that looks configured
    // and never prints.
    connection_type: "system" as const,
    system_printer_name: draft.system_printer_name,
    ...toStoredPaper(draft.paper_width),
    default_copy_count: draft.default_copy_count,
    is_active: draft.is_active,
  };
}

/** Create one printer for this tenant/branch. */
export async function createPrinter(input: {
  tenantId: string;
  branchId: string | null;
  draft: PrinterDraft;
}): Promise<void> {
  const db = await looseClient();
  const { error } = await db.from("pos_printer_settings").insert({
    tenant_id: input.tenantId,
    branch_id: input.branchId,
    ...draftToRow(input.draft),
  });
  if (error) throw new Error(error.message);
}

/**
 * Update one printer by id.
 *
 * Scoped by id alone: RLS re-checks tenant, branch, feature and permission on
 * the row itself, so adding client-side filters here would only hide a denial
 * as an empty result.
 */
export async function updatePrinter(input: { id: string; draft: PrinterDraft }): Promise<void> {
  const db = await looseClient();
  const { error } = await db
    .from("pos_printer_settings")
    .update(draftToRow(input.draft))
    .eq("id", input.id);
  if (error) throw new Error(error.message);
}

/**
 * Enable or disable a printer.
 *
 * Disabling is offered instead of deleting: a printer referenced by a print
 * route cannot be removed without deciding what happens to the route, and that
 * decision belongs to routing (P3), not to a setup screen.
 */
export async function setPrinterActive(input: { id: string; active: boolean }): Promise<void> {
  const { supabase } = await import("@/lib/supabase");
  const { error } = await supabase
    .from("pos_printer_settings")
    .update({ is_active: input.active })
    .eq("id", input.id);
  if (error) throw new Error(error.message);
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
