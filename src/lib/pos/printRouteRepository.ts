// The only place the desktop reads or writes `kitchen_print_routes`.
//
// ONE TABLE, ONE DOOR. Route CRUD lives here rather than in the screen for the
// same reason `printerRegistry.ts` exists: a component that can reach the table
// directly is a component that can be given "just one more" write, and the
// boundary that says which columns this phase may touch stops being checkable.
// The source assertions in `test/printing-basic-routing.test.ts` read this file.
//
// WHAT IT MAY TOUCH. Basic routes only: `scope_type = 'order_source'` with a
// `print_purpose`. The advanced columns - station, section, menu category, menu
// item, preparation component, receipt/ticket type, template, priority, sort
// order - are never named in an insert or an update here. They are real server
// features belonging to a later phase, and a screen that cannot show them must
// not be able to blank them.
//
// AUTHORISATION IS THE SERVER'S. Receipt routes are POS configuration
// (`assert_feature_access('pos')` plus `kitchen.manage_printers` or
// `pos.settings.manage`); kitchen ticket routes are Kitchen Ops configuration
// (`kitchen_ops` plus `kitchen.manage_print_routing` or
// `kitchen.manage_configuration`). RLS re-checks every statement below, so the
// UI's matching check is courtesy, not the boundary.
//
// NO LOCAL COPY. Routes are never cached in localStorage and never mirrored into
// `lib/printers.ts`. A route configured at one till is configured for the branch,
// and must survive a restart, a reinstall, and being read from a different
// terminal - which only the server can promise.

import {
  isPrintPurpose,
  isRouteOrderSource,
  type BasicRoute,
  type PrintPurpose,
  type RouteOrderSource,
} from "@/lib/pos/printRouting";
import { num, strOrNull } from "@/lib/pos/rpc";

/** Exactly what a basic route needs. Nothing advanced is even selected. */
const COLUMNS = "id, printer_id, print_purpose, order_source, copy_count, is_active";

/** The value `scope_type` carries for every route this phase owns. */
export const BASIC_SCOPE_TYPE = "order_source";

function toBasicRoute(raw: unknown): BasicRoute | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = strOrNull(r.id);
  const purpose = r.print_purpose;
  const source = r.order_source;
  // A row whose purpose or source this phase does not understand is dropped
  // rather than coerced. Coercing it would put an unrecognised row under a slot
  // the screen edits, and the next save would overwrite something it never read.
  if (!id || !isPrintPurpose(purpose) || !isRouteOrderSource(source)) return null;
  return {
    id,
    printer_id: strOrNull(r.printer_id),
    print_purpose: purpose,
    order_source: source,
    copy_count: Math.max(1, num(r.copy_count, 1)),
    is_active: r.is_active !== false,
  };
}

/**
 * The client, widened for this table only.
 *
 * `kitchen_print_routes` is one of the tables missing from the generated
 * `database.types.ts` - the same repo↔DB drift `printerRegistry.ts` documents.
 * The column names below are fixed literals and RLS is what authorises the
 * statement, so widening the type costs no safety; regenerating the schema is
 * the real fix and belongs with the drift reconciliation, not here.
 */
type LooseError = { message: string; code?: string } | null;

type LooseQuery = {
  select: (columns: string) => LooseFilter;
  insert: (row: Record<string, unknown>) => PromiseLike<{ error: LooseError }>;
  update: (row: Record<string, unknown>) => { eq: (c: string, v: unknown) => PromiseLike<{ error: LooseError }> };
  delete: () => { eq: (c: string, v: unknown) => PromiseLike<{ error: LooseError }> };
};

type LooseFilter = {
  eq: (column: string, value: unknown) => LooseFilter;
  order: (column: string) => PromiseLike<{ data: unknown; error: LooseError }>;
};

async function routesTable(): Promise<LooseQuery> {
  const { supabase } = await import("@/lib/supabase");
  return (supabase as unknown as { from: (t: string) => LooseQuery }).from("kitchen_print_routes");
}

/**
 * Every basic route configured for this tenant and branch.
 *
 * Inactive rows are included. A disabled route is still a row the uniqueness
 * constraint and the operator both have to reckon with, and hiding it is how a
 * screen ends up inserting a duplicate for a slot that is already taken.
 */
export async function loadBasicRoutes(input: {
  tenantId: string | null;
  branchId: string | null;
}): Promise<BasicRoute[]> {
  if (!input.tenantId || !input.branchId) return [];
  const table = await routesTable();
  const { data, error } = await table
    .select(COLUMNS)
    .eq("tenant_id", input.tenantId)
    .eq("branch_id", input.branchId)
    .eq("scope_type", BASIC_SCOPE_TYPE)
    .order("order_source");
  if (error) throw error;
  return ((data ?? []) as unknown[])
    .map(toBasicRoute)
    .filter((r): r is BasicRoute => r !== null);
}

/**
 * Create one basic route.
 *
 * Seven columns, all of them basic. `is_active` is written true because a route
 * the operator just chose a printer for is one they mean to use.
 */
export async function createBasicRoute(input: {
  tenantId: string;
  branchId: string;
  purpose: PrintPurpose;
  source: RouteOrderSource;
  printerId: string;
  copies: number;
}): Promise<void> {
  const table = await routesTable();
  const { error } = await table.insert({
    tenant_id: input.tenantId,
    branch_id: input.branchId,
    printer_id: input.printerId,
    scope_type: BASIC_SCOPE_TYPE,
    order_source: input.source,
    print_purpose: input.purpose,
    copy_count: input.copies,
    is_active: true,
  });
  if (error) throw error;
}

/**
 * Point an existing route at a printer.
 *
 * Scoped by id alone: RLS re-checks tenant, branch, feature and permission on
 * the row itself, so client-side filters here would only turn a refusal into a
 * silent no-op. Purpose and source are NOT updated - a row's slot is its
 * identity, and moving one between slots is two decisions pretending to be one.
 */
export async function updateBasicRoute(input: {
  id: string;
  printerId: string;
  copies: number;
}): Promise<void> {
  const table = await routesTable();
  const { error } = await table
    .update({ printer_id: input.printerId, copy_count: input.copies, is_active: true })
    .eq("id", input.id);
  if (error) throw error;
}

/**
 * Remove a source-specific override, so the default applies again.
 *
 * Deleting rather than deactivating is deliberate. "Use default" means there is
 * NO row for that source - that is the whole mechanism by which the server's
 * `any` route takes over - and a disabled row left behind would sit in the way
 * of the next person configuring that slot while printing nothing.
 *
 * Never called for the default row itself: see `planSave`.
 */
export async function removeBasicRoute(input: { id: string }): Promise<void> {
  const table = await routesTable();
  const { error } = await table.delete().eq("id", input.id);
  if (error) throw error;
}
