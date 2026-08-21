// Reading and writing CATEGORY and MENU ITEM print routes.
//
// SAME TABLE, SAME DOOR POLICY as `printRouteRepository.ts`. Route CRUD lives in
// a repository rather than in a screen so the set of columns this feature may
// touch stays checkable in one file. This module is the second door on
// `kitchen_print_routes`, and it is deliberately disjoint from the first: that
// one writes `scope_type = 'order_source'` and never anything else, this one
// writes `scope_type IN ('category','menu_item')` and never `order_source`
// scope. Neither can edit the other's rows.
//
// WHAT IT MAY TOUCH. Nine columns, all named as literals below. Station,
// section, preparation component, template, receipt type, ticket type, priority
// and sort order are never named in an insert or an update here - they are real
// Kitchen Ops features and a screen that cannot show them must not be able to
// blank them.
//
// AUTHORISATION IS THE SERVER'S, AND IT IS THE KITCHEN ONE. Verified against the
// deployed policy: `kitchen_print_routes_write_kitchen` covers every row whose
// `print_purpose` is `kitchen_ticket`, at ANY scope, and requires feature
// `kitchen_ops` plus `kitchen.manage_print_routing` or
// `kitchen.manage_configuration`. The UI checks the same keys through the
// EXISTING `canManageRoutes({ purpose: 'kitchen_ticket' })` so an operator is
// told before they type - never instead of the server deciding.
//
// NOTHING HERE IS CACHED LOCALLY. A routing decision is the branch's and must be
// the same at every till, which only the server can promise.

import { num, strOrNull } from "@/lib/pos/rpc";
import { isRouteOrderSource } from "@/lib/pos/printRouting";
import type { ItemRoute, ItemRouteScope } from "@/lib/pos/itemRouting";

/** The `scope_type` values this module owns. `category` is the schema's spelling. */
export const CATEGORY_SCOPE = "category" as const;
export const MENU_ITEM_SCOPE = "menu_item" as const;
export const ITEM_ROUTE_SCOPE_TYPES = [CATEGORY_SCOPE, MENU_ITEM_SCOPE] as const;

/** Category and item routing is about PREPARATION, so it is always this purpose. */
export const ITEM_ROUTE_PURPOSE = "kitchen_ticket" as const;

const COLUMNS = "id, printer_id, scope_type, menu_category_id, menu_item_id, order_source, copy_count, is_active";

function toItemRoute(raw: unknown): ItemRoute | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = strOrNull(r.id);
  const printerId = strOrNull(r.printer_id);
  const scope = r.scope_type;
  const source = r.order_source;
  if (!id || !printerId) return null;
  if (scope !== CATEGORY_SCOPE && scope !== MENU_ITEM_SCOPE) return null;
  // A row with no order source cannot be placed in the precedence ladder, and
  // guessing `any` for it would silently widen a rule somebody scoped narrowly
  // through another tool. It is left alone instead.
  if (!isRouteOrderSource(source)) return null;

  const categoryId = strOrNull(r.menu_category_id);
  const menuItemId = strOrNull(r.menu_item_id);
  // The target must match the scope, or the rule matches nothing and would sit
  // in the editor looking configured.
  if (scope === CATEGORY_SCOPE && !categoryId) return null;
  if (scope === MENU_ITEM_SCOPE && !menuItemId) return null;

  return {
    id,
    printerId,
    scope: scope as ItemRouteScope,
    categoryId,
    menuItemId,
    orderSource: source,
    copies: Math.max(1, num(r.copy_count, 1)),
    isActive: r.is_active !== false,
  };
}

/**
 * The client, widened for this table only.
 *
 * `kitchen_print_routes` is absent from the generated `database.types.ts` - the
 * documented repo/DB drift `printRouteRepository.ts` already carries. The column
 * names below are fixed literals and RLS is what authorises the statement, so
 * widening the type costs no safety.
 */
type LooseError = { message: string; code?: string } | null;

type LooseFilter = {
  eq: (column: string, value: unknown) => LooseFilter;
  order: (column: string) => PromiseLike<{ data: unknown; error: LooseError }>;
};

type LooseQuery = {
  select: (columns: string) => LooseFilter;
  insert: (row: Record<string, unknown>) => PromiseLike<{ error: LooseError }>;
  update: (row: Record<string, unknown>) => { eq: (c: string, v: unknown) => PromiseLike<{ error: LooseError }> };
  delete: () => { eq: (c: string, v: unknown) => PromiseLike<{ error: LooseError }> };
};

async function routesTable(): Promise<LooseQuery> {
  const { supabase } = await import("@/lib/supabase");
  return (supabase as unknown as { from: (t: string) => LooseQuery }).from("kitchen_print_routes");
}

/**
 * Every category and item rule for this branch.
 *
 * Read in ONE query and filtered in memory rather than two queries per scope:
 * the print path calls this on the way to a kitchen ticket, and a second round
 * trip there is a second thing that can be slow while a cashier waits.
 *
 * Inactive rows are included so the editor can see and reuse them, exactly as
 * basic routing does.
 */
export async function loadItemRoutes(input: {
  tenantId: string | null;
  branchId: string | null;
}): Promise<ItemRoute[]> {
  if (!input.tenantId || !input.branchId) return [];
  const table = await routesTable();
  const { data, error } = await table
    .select(COLUMNS)
    .eq("tenant_id", input.tenantId)
    .eq("branch_id", input.branchId)
    .eq("print_purpose", ITEM_ROUTE_PURPOSE)
    .order("scope_type");
  if (error) throw error;
  return ((data ?? []) as unknown[])
    .map(toItemRoute)
    .filter((r): r is ItemRoute => r !== null);
}

export type RouteTarget =
  | { scope: typeof CATEGORY_SCOPE; categoryId: string }
  | { scope: typeof MENU_ITEM_SCOPE; menuItemId: string };

/** Create one rule. Nine columns, every one of them named. */
export async function createItemRoute(input: {
  tenantId: string;
  branchId: string;
  target: RouteTarget;
  orderSource: string;
  printerId: string;
  copies: number;
}): Promise<void> {
  const table = await routesTable();
  const { error } = await table.insert({
    tenant_id: input.tenantId,
    branch_id: input.branchId,
    printer_id: input.printerId,
    scope_type: input.target.scope,
    menu_category_id: input.target.scope === CATEGORY_SCOPE ? input.target.categoryId : null,
    menu_item_id: input.target.scope === MENU_ITEM_SCOPE ? input.target.menuItemId : null,
    order_source: input.orderSource,
    print_purpose: ITEM_ROUTE_PURPOSE,
    copy_count: input.copies,
    is_active: true,
  });
  if (error) throw error;
}

/**
 * Change a rule's copy count, or re-enable it.
 *
 * The PRINTER and the TARGET are never updated. A rule's destination and what it
 * applies to are its identity; moving one between printers is two decisions
 * (stop printing there, start printing here) pretending to be one, and the
 * editor expresses them as a delete and an insert so both are visible.
 */
export async function updateItemRouteCopies(input: { id: string; copies: number }): Promise<void> {
  const table = await routesTable();
  const { error } = await table.update({ copy_count: input.copies, is_active: true }).eq("id", input.id);
  if (error) throw error;
}

/**
 * Remove a rule, so the next step of the precedence ladder applies again.
 *
 * Deleting rather than deactivating, for the reason basic routing deletes: the
 * mechanism by which a category rule takes over from an item rule IS the absence
 * of the item rule, and a disabled row left behind is something the next person
 * to configure this cell has to reason about while it prints nothing.
 */
export async function removeItemRoute(input: { id: string }): Promise<void> {
  const table = await routesTable();
  const { error } = await table.delete().eq("id", input.id);
  if (error) throw error;
}
