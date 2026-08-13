// `resolve_print_route`: asking the server which printer a document goes to.
//
// THE SERVER IS THE RESOLVER. Precedence - exact order source first, then the
// `any` default - is decided by one function in the database, and this module
// only asks it and reads the answer. That matters more than it looks: the same
// RPC will later grow station, category, item and preparation-component
// precedence, and any client that had re-implemented today's two rules would
// then quietly disagree with the kitchen about where a ticket went.
//
// NOT A POS RPC. This deliberately does not go through `lib/pos/rpc.ts`. That
// module's `PosRpcName` union is the list of RPCs that create orders, take money
// and move shifts; routing resolution creates nothing, and adding it to that
// union would blur a boundary the tests assert on. The one structural cast below
// is the same documented pattern, kept local to this file.
//
// NOTHING HERE PRINTS. Resolving is a read. No paper follows from calling it,
// on mount, on a timer or otherwise.

import { asRecord, bool, num, numOrNull, strOrNull } from "@/lib/pos/rpc";
import type { PrintPurpose, ResolverOrderSource } from "@/lib/pos/printRouting";

export const RESOLVE_PRINT_ROUTE = "resolve_print_route";

/**
 * The shared contract's result row, hand-written.
 *
 * Hand-written on purpose: regenerating `database.types.ts` for one RPC would
 * pull in the whole drifted schema as a side effect of a routing change. The
 * runtime parser below is what actually guarantees the shape.
 */
export type ResolvedRoute = {
  resolved: boolean;
  route_id: string | null;
  printer_id: string | null;
  printer_name: string | null;
  printer_type: string | null;
  connection_type: string | null;
  system_printer_name: string | null;
  paper_width: string | null;
  custom_paper_width: number | null;
  copies: number | null;
  print_purpose: string | null;
  matched_order_source: string | null;
  used_default: boolean | null;
};

/** Nothing matched. Not an error - an unconfigured branch is a normal state. */
export const UNRESOLVED: ResolvedRoute = {
  resolved: false,
  route_id: null,
  printer_id: null,
  printer_name: null,
  printer_type: null,
  connection_type: null,
  system_printer_name: null,
  paper_width: null,
  custom_paper_width: null,
  copies: null,
  print_purpose: null,
  matched_order_source: null,
  used_default: null,
};

/**
 * Turn whatever PostgREST returned into the contract shape.
 *
 * A set-returning RPC arrives as an ARRAY of one row; a scalar-returning one
 * would arrive as an object; a branch with no routes can arrive as an empty
 * array or as null. All four are handled, and anything unrecognised becomes
 * `UNRESOLVED` rather than a thrown error - "no route configured" is what the
 * operator needs to see, and an exception would show them a stack instead.
 */
export function parseResolvedRoute(raw: unknown): ResolvedRoute {
  const row = Array.isArray(raw) ? raw[0] : raw;
  if (!row || typeof row !== "object") return UNRESOLVED;
  const r = asRecord(row);
  const resolved = bool(r.resolved);
  if (!resolved) return { ...UNRESOLVED, print_purpose: strOrNull(r.print_purpose) };
  return {
    resolved: true,
    route_id: strOrNull(r.route_id),
    printer_id: strOrNull(r.printer_id),
    printer_name: strOrNull(r.printer_name),
    printer_type: strOrNull(r.printer_type),
    connection_type: strOrNull(r.connection_type),
    system_printer_name: strOrNull(r.system_printer_name),
    paper_width: strOrNull(r.paper_width),
    custom_paper_width: numOrNull(r.custom_paper_width),
    // The route's own copy count is authoritative. Falling back to the
    // printer's default would print a different number of pages than the
    // route says, which is exactly the sort of quiet disagreement routing
    // exists to remove.
    copies: r.copies === null || r.copies === undefined ? null : Math.max(1, num(r.copies, 1)),
    print_purpose: strOrNull(r.print_purpose),
    matched_order_source: strOrNull(r.matched_order_source),
    used_default: r.used_default === null || r.used_default === undefined ? null : bool(r.used_default),
  };
}

export class ResolvePrintRouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResolvePrintRouteError";
  }
}

/**
 * Ask the server where this document goes.
 *
 * The three parameters are the whole contract: the branch, the document kind,
 * and the order's source. No printer, no printer type and no local state is
 * sent - a terminal does not get a vote on which printer a branch's route names.
 */
export async function resolvePrintRoute(input: {
  branchId: string;
  purpose: PrintPurpose;
  orderSource: ResolverOrderSource;
}): Promise<ResolvedRoute> {
  const { supabase } = await import("@/lib/supabase");
  // The one documented cast, for the same reason as `callPosRpc`: `rpc` is
  // invoked as a METHOD so the client keeps `this`.
  const client = supabase as unknown as {
    rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
  };
  const { data, error } = await client.rpc(RESOLVE_PRINT_ROUTE, {
    p_branch: input.branchId,
    p_purpose: input.purpose,
    p_order_source: input.orderSource,
  });
  if (error) throw new ResolvePrintRouteError(error.message);
  return parseResolvedRoute(data);
}
