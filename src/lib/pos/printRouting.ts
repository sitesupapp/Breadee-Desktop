// Basic print routing: the decisions, with no server and no React.
//
// WHAT ROUTING IS. A route answers one question - "when this branch produces
// THIS KIND OF DOCUMENT for THIS KIND OF ORDER, which printer does it go to".
// Two concepts that look alike are deliberately kept apart:
//
//   print purpose   what the document IS      receipt | kitchen_ticket
//   printer type    what the printer is FOR   cashier | kitchen | other
//
// They are not the same fact and neither implies the other. A restaurant with
// one physical printer routes both purposes to the same cashier printer, and a
// kitchen printer that a branch has decided prints customer copies is that
// branch's business. So `printer_type` is used to RECOMMEND and never to
// forbid, and a print purpose is never inferred from a printer's type.
//
// WHAT "DEFAULT" IS. Not a flag on a printer. A default is an ordinary route
// whose order source is `any`, so the server's own precedence - exact source
// first, then `any` - is the only thing that decides, and there is no second
// mechanism to disagree with it. That is also why "Use default" for a source
// means NO ROW for that source: writing a Takeaway row that names the same
// printer as the default would look identical today and silently stop following
// the default the moment someone changed it.
//
// THE SERVER RESOLVES, THIS FILE DOES NOT. `resolve_print_route` is authoritative
// for which route matches. Nothing here re-implements precedence, and the
// advanced scopes (station, section, category, item, preparation component) are
// neither read nor written - they exist on the server, they belong to a later
// phase, and a half-built client-side copy of them would be a second answer to a
// question the server already answers.

import { MAX_COPIES, MIN_COPIES, type PaperWidth } from "@/lib/nativePrinting";
import { FEATURES, hasFeature, type FeatureMap } from "@/lib/features";
import { effectivePaperWidth, type ServerPrinter } from "@/lib/pos/printerRegistry";
import type { ConfiguredPrinter, SetupStatus } from "@/lib/pos/quickSetup";

// ------------------------------------------------------------ vocabulary ----

/**
 * The document kinds routing understands.
 *
 * These two strings are the database's `print_purpose` values. "customer",
 * "cashier", "kitchen" and "ticket" are NOT purposes - the first two are how
 * people talk about receipts and the last two are printer roles.
 */
export const PRINT_PURPOSES = ["receipt", "kitchen_ticket"] as const;
export type PrintPurpose = (typeof PRINT_PURPOSES)[number];

/**
 * Every order source a route row may carry, including `e_menu`.
 *
 * `e_menu` has no UI in this phase, and that is precisely why it is in the type:
 * a row the screen cannot show must still be recognised, so it is left alone
 * rather than parsed into nothing and overwritten.
 */
export const ROUTE_ORDER_SOURCES = ["any", "takeaway", "dine_in", "delivery", "e_menu"] as const;
export type RouteOrderSource = (typeof ROUTE_ORDER_SOURCES)[number];

/** The rows the basic routing screen shows, in the order it shows them. */
export const EDITABLE_ORDER_SOURCES = ["any", "takeaway", "dine_in", "delivery"] as const;
export type EditableOrderSource = (typeof EDITABLE_ORDER_SOURCES)[number];

/** What `resolve_print_route` accepts for `p_order_source`. `any` is not an order. */
export const RESOLVER_ORDER_SOURCES = ["takeaway", "dine_in", "delivery", "e_menu"] as const;
export type ResolverOrderSource = (typeof RESOLVER_ORDER_SOURCES)[number];

/** The sources the Test Center can simulate. */
export const TESTABLE_ORDER_SOURCES = ["takeaway", "dine_in", "delivery"] as const;
export type TestableOrderSource = (typeof TESTABLE_ORDER_SOURCES)[number];

export function isPrintPurpose(value: unknown): value is PrintPurpose {
  return typeof value === "string" && (PRINT_PURPOSES as readonly string[]).includes(value);
}

export function isRouteOrderSource(value: unknown): value is RouteOrderSource {
  return typeof value === "string" && (ROUTE_ORDER_SOURCES as readonly string[]).includes(value);
}

// --------------------------------------------------------------- wording ----
//
// Nothing a normal operator reads is a database word. `scope_type`,
// `print_purpose`, `order_source`, priorities and uuids are implementation, and
// a support technician standing at a till should be able to work the screen
// without any of them.

export function purposeLabel(purpose: PrintPurpose): string {
  return purpose === "receipt" ? "Customer receipt" : "Kitchen ticket";
}

/** Plural section heading, e.g. "Customer receipts". */
export function purposeSectionLabel(purpose: PrintPurpose): string {
  return purpose === "receipt" ? "Customer receipts" : "Kitchen tickets";
}

export function orderSourceLabel(source: RouteOrderSource): string {
  switch (source) {
    case "any":
      return "Default";
    case "takeaway":
      return "Takeaway";
    case "dine_in":
      return "Dine-In";
    case "delivery":
      return "Delivery";
    case "e_menu":
      return "E-Menu";
  }
}

/** One sentence per row, so the screen explains itself without a manual. */
export function orderSourceHint(source: EditableOrderSource): string {
  return source === "any"
    ? "Used whenever nothing more specific is set."
    : `Used for ${orderSourceLabel(source).toLowerCase()} orders instead of the default.`;
}

// ------------------------------------------------------------ the row -------

/**
 * A basic route, as this phase understands it.
 *
 * Deliberately five fields. The table carries station, section, category, item,
 * preparation component, template, receipt/ticket type, priority and sort order
 * as well; none of them is read here and none is written, so an advanced route
 * configured elsewhere cannot be flattened by this screen.
 */
export type BasicRoute = {
  id: string;
  printer_id: string | null;
  print_purpose: PrintPurpose;
  order_source: RouteOrderSource;
  copy_count: number;
  is_active: boolean;
};

export function slotKey(purpose: PrintPurpose, source: RouteOrderSource): string {
  return `${purpose}:${source}`;
}

/**
 * The route in effect for each slot.
 *
 * An ACTIVE row always wins over an inactive one for the same slot. The server's
 * uniqueness constraint covers active basic routes only, so a disabled leftover
 * can legitimately sit beside the row that is really in use, and showing the
 * leftover would describe a printer nothing prints to.
 */
export function indexRoutes(routes: BasicRoute[]): Record<string, BasicRoute> {
  const byKey: Record<string, BasicRoute> = {};
  for (const route of routes) {
    const key = slotKey(route.print_purpose, route.order_source);
    const held = byKey[key];
    if (!held || (!held.is_active && route.is_active)) byKey[key] = route;
  }
  return byKey;
}

export function routeFor(
  indexed: Record<string, BasicRoute>,
  purpose: PrintPurpose,
  source: RouteOrderSource,
): BasicRoute | null {
  return indexed[slotKey(purpose, source)] ?? null;
}

// ---------------------------------------------------------------- draft -----

/**
 * What the operator has selected for one row, before it is saved.
 *
 * `printerId: null` is meaningful, and means two different things depending on
 * the row: for a source it is "use the default" (no row at all), and for the
 * default row it is "no default configured". Neither is a printer, and neither
 * is ever quietly replaced by the Windows default or by the first printer in
 * the list - a guessed destination is paper in the wrong room.
 */
export type RouteDraft = {
  printerId: string | null;
  copies: number;
};

export function draftForRoute(route: BasicRoute | null): RouteDraft {
  if (!route || !route.is_active) return { printerId: null, copies: 1 };
  return { printerId: route.printer_id, copies: route.copy_count };
}

export function isDirty(draft: RouteDraft, route: BasicRoute | null): boolean {
  const saved = draftForRoute(route);
  return draft.printerId !== saved.printerId || draft.copies !== saved.copies;
}

/**
 * What saving this row would actually do to the server.
 *
 * Returned as a plan rather than performed, so the rule that "Use default"
 * REMOVES a row - and that clearing the default is not offered as a way to
 * delete it - is a decision this file makes and a test can read, instead of
 * control flow buried in a click handler.
 */
export type SavePlan =
  | { kind: "none" }
  | { kind: "create"; purpose: PrintPurpose; source: RouteOrderSource; printerId: string; copies: number }
  | { kind: "update"; id: string; printerId: string; copies: number }
  | { kind: "remove"; id: string }
  | { kind: "invalid"; error: string };

export function planSave(input: {
  purpose: PrintPurpose;
  source: EditableOrderSource;
  draft: RouteDraft;
  existing: BasicRoute | null;
}): SavePlan {
  const { purpose, source, draft, existing } = input;

  if (draft.printerId === null) {
    // The default row offers "no default configured" only while there is no
    // default. Once one exists the picker lists printers, so this branch cannot
    // be reached for `any` - and if it ever were, deleting the branch's default
    // as a side effect of a dropdown is not what the operator asked for.
    if (source === "any") return { kind: "none" };
    return existing ? { kind: "remove", id: existing.id } : { kind: "none" };
  }

  if (!Number.isInteger(draft.copies) || draft.copies < MIN_COPIES || draft.copies > MAX_COPIES) {
    return { kind: "invalid", error: `Copies must be between ${MIN_COPIES} and ${MAX_COPIES}.` };
  }

  if (!existing) {
    return { kind: "create", purpose, source, printerId: draft.printerId, copies: draft.copies };
  }
  // An inactive row for this slot is reused rather than left behind and
  // duplicated: the server's uniqueness constraint would accept the insert, and
  // the branch would then own two rows describing one decision.
  return { kind: "update", id: existing.id, printerId: draft.printerId, copies: draft.copies };
}

// ------------------------------------------------------- printer choice -----

/**
 * A printer the operator may route to, with everything the row needs to say.
 *
 * `recommended` is a sort and a caption, never a restriction. `readiness` is
 * about THIS terminal and is deliberately separate from whether the route is
 * configured: a route to a printer in another room is correct configuration
 * seen from a till that cannot reach it, and rewriting it to something local
 * would be one terminal editing the branch's setup on its own authority.
 */
export type PrinterOption = {
  id: string;
  name: string;
  printerType: ServerPrinter["printer_type"];
  recommended: boolean;
  readiness: SetupStatus;
  /** Null when the printer's stored width is not one the app can lay out. */
  paperWidth: PaperWidth | null;
  windowsName: string | null;
};

/** Which printer role is the natural home for each document. */
export function recommendedPrinterType(purpose: PrintPurpose): ServerPrinter["printer_type"] {
  return purpose === "receipt" ? "cashier" : "kitchen";
}

function optionRank(purpose: PrintPurpose, type: ServerPrinter["printer_type"]): number {
  if (type === recommendedPrinterType(purpose)) return 0;
  if (type === "other") return 1;
  return 2;
}

/**
 * The printers offered for one route, best first.
 *
 * Disabled printers are excluded - a route to a switched-off printer is a route
 * that never prints - EXCEPT the one this route already names, which stays so
 * the operator can see what is configured and change it rather than find the
 * row silently pointing at nothing.
 */
export function printerOptions(input: {
  purpose: PrintPurpose;
  printers: ConfiguredPrinter[];
  selectedId: string | null;
}): PrinterOption[] {
  const { purpose, printers, selectedId } = input;
  return printers
    .filter((entry) => entry.printer.is_active || entry.printer.id === selectedId)
    .map((entry) => ({
      id: entry.printer.id,
      name: entry.printer.name,
      printerType: entry.printer.printer_type,
      recommended: entry.printer.printer_type === recommendedPrinterType(purpose),
      readiness: entry.status,
      paperWidth: entry.paperWidth,
      windowsName: entry.printer.system_printer_name,
    }))
    .sort((a, b) => {
      const rank = optionRank(purpose, a.printerType) - optionRank(purpose, b.printerType);
      return rank !== 0 ? rank : a.name.localeCompare(b.name);
    });
}

/** Short caption for a printer inside a route row. */
export function optionCaption(option: PrinterOption): string {
  const where = option.windowsName ? `Windows: ${option.windowsName}` : "No Windows printer chosen";
  return option.recommended ? `${where} · recommended` : where;
}

// ---------------------------------------------------------- permissions -----
//
// Transcribed from the deployed policies, which authorise the two purposes
// differently: a receipt route is POS configuration and a kitchen ticket route
// is Kitchen Ops configuration. The UI checks the same keys so an operator is
// told before they type, never instead of the server deciding - and no role name
// appears here, because the policies name permissions.

export const ROUTE_PERMISSIONS = {
  /** `print_purpose = 'receipt'`, feature `pos`. Either key is enough. */
  RECEIPT: "kitchen.manage_printers",
  RECEIPT_ALT: "pos.settings.manage",
  /** `print_purpose = 'kitchen_ticket'`, feature `kitchen_ops`. Either key is enough. */
  KITCHEN: "kitchen.manage_print_routing",
  KITCHEN_ALT: "kitchen.manage_configuration",
} as const;

export type PermissionMap = Record<string, boolean> | null | undefined;

export type RouteGate = { allowed: boolean; reason: string | null };

const can = (perms: PermissionMap, key: string) => Boolean(perms?.[key]);

/**
 * May this operator change routes of this purpose?
 *
 * Feature first, then permission, in the order the server refuses: telling
 * someone they lack a permission when the real answer is that their plan does
 * not include Kitchen Ops sends them to change the wrong thing.
 */
export function canManageRoutes(input: {
  purpose: PrintPurpose;
  permissions: PermissionMap;
  features: FeatureMap | null | undefined;
}): RouteGate {
  const { purpose, permissions, features } = input;
  if (purpose === "receipt") {
    if (!hasFeature(features, FEATURES.POS)) {
      return { allowed: false, reason: "POS is not enabled for this plan." };
    }
    if (can(permissions, ROUTE_PERMISSIONS.RECEIPT) || can(permissions, ROUTE_PERMISSIONS.RECEIPT_ALT)) {
      return { allowed: true, reason: null };
    }
    return {
      allowed: false,
      reason: "You do not have permission to change receipt routing. It needs the “manage printers” or “manage POS settings” permission.",
    };
  }
  if (!hasFeature(features, FEATURES.KITCHEN_OPS)) {
    return { allowed: false, reason: "Kitchen Ops is not enabled for this plan, so kitchen ticket routing is unavailable." };
  }
  if (can(permissions, ROUTE_PERMISSIONS.KITCHEN) || can(permissions, ROUTE_PERMISSIONS.KITCHEN_ALT)) {
    return { allowed: true, reason: null };
  }
  return {
    allowed: false,
    reason: "You do not have permission to change kitchen ticket routing. It needs the “manage print routing” or “manage kitchen configuration” permission.",
  };
}

// --------------------------------------------------------- write errors -----

/**
 * The server's refusal, in words an operator can act on.
 *
 * Never a raw Postgres message as the primary text, and never an automatic
 * retry: a unique violation means someone else already configured this row, and
 * repeating the insert would either fail identically or - worse - succeed
 * against a row that has since changed.
 */
export function routeWriteMessage(error: unknown): string {
  const code = readField(error, "code");
  const message = readField(error, "message") ?? (typeof error === "string" ? error : "");
  const text = message.toLowerCase();

  if (code === "23505" || text.includes("duplicate key") || text.includes("unique constraint")) {
    return "A route for this source already exists. Refresh to see it, then change that route instead.";
  }
  if (
    code === "42501" ||
    text.includes("row-level security") ||
    text.includes("row level security") ||
    text.includes("permission denied") ||
    text.includes("not authorized") ||
    text.includes("not authorised")
  ) {
    return "You do not have permission to change this route.";
  }
  if (text.includes("feature") && (text.includes("access") || text.includes("enabled") || text.includes("subscription"))) {
    return "This feature is not enabled for this plan, so the route cannot be saved.";
  }
  if (text.includes("foreign key")) {
    return "That printer no longer exists. Refresh the printer list and choose again.";
  }
  return message.trim() !== "" ? message : "The route could not be saved.";
}

function readField(error: unknown, field: string): string | null {
  if (!error || typeof error !== "object") return null;
  const value = (error as Record<string, unknown>)[field];
  return typeof value === "string" ? value : null;
}

// ----------------------------------------------------------- readiness ------

/**
 * Whether a configured destination can actually print FROM THIS TERMINAL.
 *
 * Reported, never repaired. The distinction the routing screen has to keep
 * visible is "configured for the branch" versus "printable from this PC", and
 * collapsing the two is how one till's local reality gets written into the
 * branch's configuration.
 */
export type DestinationReadiness = {
  status: SetupStatus | "unknown";
  paperWidth: PaperWidth | null;
  windowsName: string | null;
};

/** Readiness of a resolver result against what Windows has here. */
export function destinationReadiness(input: {
  connectionType: string | null;
  systemPrinterName: string | null;
  paperWidth: string | null;
  customPaperWidth: number | null;
  installedNames: string[];
}): DestinationReadiness {
  const width = effectivePaperWidth({
    paper_width: input.paperWidth,
    custom_paper_width: input.customPaperWidth,
  });
  const base = { paperWidth: width, windowsName: input.systemPrinterName };

  if (input.connectionType === null) return { ...base, status: "unknown" };
  if (input.connectionType !== "system") return { ...base, status: "unsupported_connection" };
  if (!input.systemPrinterName) return { ...base, status: "unbound" };
  if (!input.installedNames.includes(input.systemPrinterName)) return { ...base, status: "missing" };
  if (!width) return { ...base, status: "unsupported_paper" };
  return { ...base, status: "ready" };
}

/** Only a locally ready destination could ever be sent a physical test page. */
export function isLocallyPrintable(readiness: DestinationReadiness): boolean {
  return readiness.status === "ready" && readiness.paperWidth !== null && readiness.windowsName !== null;
}
