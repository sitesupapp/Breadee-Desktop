// Sending the right lines of one order to the right production station.
//
// THE PROBLEM. A single takeaway order can be a pizza, a crepe, a soft drink and
// a coffee. It is ONE order with one number, one bill, one payment and one
// receipt - but four different people make it, in four different places, and
// each of them needs a ticket listing only their own work. Until now the desktop
// resolved one kitchen printer per ORDER SOURCE and sent the whole batch there,
// which is correct for a one-station kitchen and useless for a four-station one.
//
// WHAT THIS IS NOT. It is not a second routing system, and it does not replace
// the existing one. `resolve_print_route` still answers "where does a kitchen
// ticket for a takeaway order go", and that answer is still what a line with no
// rule of its own follows. This module adds the two more specific questions the
// database has always had columns for and the server does not yet answer.
//
// WHY THE CLIENT RESOLVES THESE AND THE SERVER RESOLVES THE OTHER. Verified
// against the deployed function rather than assumed: `resolve_print_route`
// filters `scope_type = 'order_source'` and nothing else, so a `category` or
// `menu_item` row is INVISIBLE to it. That is the property this design rests on -
// writing the rules below cannot alter what any existing caller resolves today,
// on any tenant, including tenants with rules already configured from Kitchen
// Ops. The desktop repository authors no migrations, so extending the server
// function is not this task's to do; when it is extended, this resolver is the
// specification it should match.
//
// THE PRECEDENCE IS TOTAL AND IT IS THE ONE THE BRIEF ASKED FOR:
//
//   1. a rule for THIS ITEM and THIS order source
//   2. a rule for THIS ITEM and any order source
//   3. a rule for THIS CATEGORY and THIS order source
//   4. a rule for THIS CATEGORY and any order source
//   5. the branch's existing kitchen-ticket route for this order source
//
// Each step is checked in full before the next is considered, so an item rule
// SHADOWS its category completely rather than adding to it - "Pepsi goes to the
// counter" must mean the counter and not "the counter as well as the kitchen".
//
// NO RULES MEANS NO CHANGE. `groupLinesByPrinter` with an empty rule set returns
// exactly one group, routed to the default, containing every line in the order
// it was given. That is byte-for-byte the ticket the previous release printed,
// and it is the single most important behaviour in this file: every existing
// tenant upgrades into it.
//
// ROUTING BELONGS TO THE ITEM, NOT TO A BUTTON. Nothing here knows about the
// customized grid, and nothing in the customized grid can influence it. A line
// is routed by the canonical menu item it carries, so choosing Pepsi from the
// default menu, from a custom main-page button, or from inside a custom category
// produces the same ticket on the same printer.

import { MAX_COPIES, MIN_COPIES } from "@/lib/nativePrinting";
import type { ResolverOrderSource, RouteOrderSource } from "@/lib/pos/printRouting";

/** The two scopes this module owns. Both are real `scope_type` values. */
export const ITEM_ROUTE_SCOPES = ["category", "menu_item"] as const;
export type ItemRouteScope = (typeof ITEM_ROUTE_SCOPES)[number];

/**
 * One category-or-item routing rule, as stored.
 *
 * Deliberately narrow. `kitchen_print_routes` also carries station, section,
 * preparation component, template, receipt/ticket type, priority and sort order;
 * none of them is read here and none is written, so a rule configured in Kitchen
 * Ops with those columns set is left exactly as it is.
 */
export type ItemRoute = {
  id: string;
  printerId: string;
  scope: ItemRouteScope;
  /** Set for `category` rules. */
  categoryId: string | null;
  /** Set for `menu_item` rules. */
  menuItemId: string | null;
  /** `any` is the rule that applies when no source-specific rule exists. */
  orderSource: RouteOrderSource;
  copies: number;
  isActive: boolean;
};

/** What a line needs to carry to be routed. Nothing about money. */
export type RoutableLine = {
  menuItemId: string | null;
  categoryId: string | null;
};

export function boundCopies(value: number): number {
  if (!Number.isFinite(value)) return MIN_COPIES;
  return Math.min(Math.max(Math.trunc(value), MIN_COPIES), MAX_COPIES);
}

/** Does this branch have ANY item or category rule at all? */
export function hasItemRules(routes: ItemRoute[]): boolean {
  return routes.some((r) => r.isActive);
}

/**
 * The rules that decide where one line goes, or an empty list.
 *
 * An empty result means "no rule applies", which the caller turns into the
 * branch default. It never means "do not print": a line nobody wrote a rule for
 * is still food somebody has to cook.
 */
export function rulesForLine(input: {
  line: RoutableLine;
  routes: ItemRoute[];
  orderSource: ResolverOrderSource;
}): ItemRoute[] {
  const active = input.routes.filter((r) => r.isActive);
  const { line, orderSource } = input;

  const byItem = (source: RouteOrderSource) =>
    line.menuItemId
      ? active.filter((r) => r.scope === "menu_item" && r.menuItemId === line.menuItemId && r.orderSource === source)
      : [];
  const byCategory = (source: RouteOrderSource) =>
    line.categoryId
      ? active.filter((r) => r.scope === "category" && r.categoryId === line.categoryId && r.orderSource === source)
      : [];

  // Each step is returned WHOLE if it matched anything. Falling through only on
  // an empty step is what makes an item rule shadow its category rather than
  // merge with it.
  const exactItem = byItem(orderSource);
  if (exactItem.length > 0) return exactItem;
  const anyItem = byItem("any");
  if (anyItem.length > 0) return anyItem;
  const exactCategory = byCategory(orderSource);
  if (exactCategory.length > 0) return exactCategory;
  return byCategory("any");
}

/** Which precedence step decided a line. Reported by the settings preview. */
export type RoutingOrigin = "item" | "category" | "branch_default";

export function originForLine(input: {
  line: RoutableLine;
  routes: ItemRoute[];
  orderSource: ResolverOrderSource;
}): RoutingOrigin {
  const matched = rulesForLine(input);
  if (matched.length === 0) return "branch_default";
  return matched[0].scope === "menu_item" ? "item" : "category";
}

/**
 * A set of lines bound for one destination.
 *
 * `printerId: null` is the BRANCH DEFAULT - the destination
 * `resolve_print_route` already decides - and is deliberately not resolved to an
 * id here. This module must not hold an opinion about which printer the default
 * is; that is the server's answer and re-deriving it locally would be the second
 * source of truth the whole printing programme is built to avoid.
 */
export type StationGroup<L> = {
  printerId: string | null;
  /** The copies this destination asked for. `1` for the default group, which
      takes the ROUTE's own count from the server instead. */
  copies: number;
  lines: L[];
};

/**
 * Split a batch into one group per destination.
 *
 * A line routed to two printers appears in BOTH groups, which is the whole point
 * of allowing more than one: "the pass gets a copy of everything the grill gets"
 * is a normal restaurant arrangement and it is expressed as two rules.
 *
 * ORDER IS DETERMINISTIC. The default group is first - so on a branch with one
 * rule the familiar ticket still prints first - and the rest follow by printer
 * id. Two identical orders therefore produce identical paper in identical order,
 * which is what makes a duplicate visible when one happens.
 *
 * COPIES, WHEN RULES DISAGREE. If two rules put lines on the same printer and
 * ask for different copy counts, the HIGHER wins. Somebody who configured two
 * copies of one category asked for two copies of it; giving them one because a
 * different category on the same order asked for one would quietly lose a page
 * they are relying on.
 */
export function groupLinesByPrinter<L extends RoutableLine>(input: {
  lines: L[];
  routes: ItemRoute[];
  orderSource: ResolverOrderSource;
}): StationGroup<L>[] {
  // THE BACKWARD-COMPATIBILITY PATH, and it is first on purpose. A branch with
  // no rules never reaches the grouping logic below at all, so there is no way
  // for it to reorder, drop or duplicate a line.
  if (!hasItemRules(input.routes)) {
    return input.lines.length > 0 ? [{ printerId: null, copies: MIN_COPIES, lines: input.lines }] : [];
  }

  const groups = new Map<string, StationGroup<L>>();
  const push = (printerId: string | null, copies: number, line: L) => {
    const key = printerId ?? "";
    const existing = groups.get(key);
    if (existing) {
      existing.lines.push(line);
      existing.copies = Math.max(existing.copies, copies);
      return;
    }
    groups.set(key, { printerId, copies, lines: [line] });
  };

  for (const line of input.lines) {
    const matched = rulesForLine({ line, routes: input.routes, orderSource: input.orderSource });
    if (matched.length === 0) {
      push(null, MIN_COPIES, line);
      continue;
    }
    // De-duplicated by printer: two rules naming the same printer for the same
    // line - a category rule and a second category rule, say - must not put the
    // line on that printer's ticket twice.
    const seen = new Set<string>();
    for (const rule of matched) {
      if (seen.has(rule.printerId)) continue;
      seen.add(rule.printerId);
      push(rule.printerId, boundCopies(rule.copies), line);
    }
  }

  return [...groups.values()].sort((a, b) => {
    if (a.printerId === b.printerId) return 0;
    if (a.printerId === null) return -1;
    if (b.printerId === null) return 1;
    return a.printerId.localeCompare(b.printerId);
  });
}

// ------------------------------------------------------------- the editor ---
//
// The shapes the settings screen works in. Kept here beside the resolver so the
// thing that WRITES a rule and the thing that READS it cannot drift.

/** The three sources a rule may be written for, plus the default. */
export const ROUTING_SOURCES = ["any", "takeaway", "dine_in", "delivery"] as const;
export type RoutingSource = (typeof ROUTING_SOURCES)[number];

export function routingSourceLabel(source: RoutingSource): string {
  switch (source) {
    case "any":
      return "All orders";
    case "takeaway":
      return "Takeaway";
    case "dine_in":
      return "Dine-In";
    case "delivery":
      return "Delivery";
  }
}

/**
 * What the operator has selected for one (target, source) cell.
 *
 * A SET of printer ids, because a destination list is the unit of this decision.
 * An EMPTY set is meaningful and is the default: for a source it means "follow
 * the next rule up" (the category, then the branch default), which is the same
 * idiom basic routing already uses for "Use default" - and it is expressed the
 * same way, by there being NO ROW rather than by a row that names the same
 * printer. Two things that look identical today and diverge the first time
 * somebody changes one is precisely what that idiom exists to prevent.
 */
export type RoutingDraft = {
  printerIds: string[];
  copies: number;
};

export function draftFromRules(rules: ItemRoute[]): RoutingDraft {
  const active = rules.filter((r) => r.isActive);
  return {
    printerIds: [...new Set(active.map((r) => r.printerId))].sort(),
    copies: active.length > 0 ? boundCopies(Math.max(...active.map((r) => r.copies))) : MIN_COPIES,
  };
}

export function draftIsDirty(draft: RoutingDraft, rules: ItemRoute[]): boolean {
  const saved = draftFromRules(rules);
  const same =
    saved.printerIds.length === draft.printerIds.length &&
    saved.printerIds.every((id, i) => id === [...draft.printerIds].sort()[i]);
  return !same || saved.copies !== draft.copies;
}

/**
 * What saving one cell would do, as a plan.
 *
 * Returned rather than performed, for the same reason `planSave` in
 * `printRouting.ts` is: "clearing a cell DELETES its rows" is a decision worth
 * reading in one place rather than inferring from a click handler, and a test
 * can assert it without a database.
 */
export type RoutingPlan = {
  /** Rows to delete, by id. */
  remove: string[];
  /** Printers to create a rule for. */
  add: { printerId: string; copies: number }[];
  /** Rows whose copy count changed but whose printer did not. */
  update: { id: string; copies: number }[];
};

export function planRoutingSave(input: { draft: RoutingDraft; existing: ItemRoute[] }): RoutingPlan {
  const wanted = new Set(input.draft.printerIds);
  const copies = boundCopies(input.draft.copies);
  const remove: string[] = [];
  const update: { id: string; copies: number }[] = [];
  const kept = new Set<string>();

  for (const rule of input.existing) {
    if (!wanted.has(rule.printerId)) {
      remove.push(rule.id);
      continue;
    }
    if (kept.has(rule.printerId)) {
      // A duplicate row for the same printer. Nothing constrains these at the
      // database (the unique index covers `order_source` scopes only), so a
      // second one is removed rather than left to print a second ticket.
      remove.push(rule.id);
      continue;
    }
    kept.add(rule.printerId);
    if (boundCopies(rule.copies) !== copies || !rule.isActive) update.push({ id: rule.id, copies });
  }

  const add = [...wanted].filter((id) => !kept.has(id)).sort().map((printerId) => ({ printerId, copies }));
  return { remove, add, update };
}

export function planIsEmpty(plan: RoutingPlan): boolean {
  return plan.remove.length === 0 && plan.add.length === 0 && plan.update.length === 0;
}
