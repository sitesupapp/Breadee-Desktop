// `pos_receipt_settings`: the branch's receipt design and automatic-printing
// preference, read and - now - written from the desktop.
//
// WHY THE DESKTOP MAY WRITE THIS NOW. Level 3E-B deliberately refused to,
// because the setting was "a manager's decision made once, in the web admin".
// That was right when the desktop had no screen for it and a till flipping the
// switch would have been an accident. It is no longer right: Settings -> POS
// Settings and Settings -> Receipt are exactly that manager's screen, they are
// gated on the SAME permission the web screen is gated on (`pos.settings.manage`,
// enforced by `save_pos_receipt_settings` itself), and they write through the
// SAME RPC to the SAME row. There is no desktop-only column, no local copy of
// the template, and no second source of truth - which is the property that
// mattered, not which window the operator was standing in front of.
//
// PARTIAL WRITES ARE THE CONTRACT, NOT AN OPTIMISATION. Every column in
// `save_pos_receipt_settings` is updated only `when p_payload ? '<key>'`, so
// omitting a key preserves what is stored. The desktop sends the keys it
// changed and nothing else, which is what keeps it from clobbering the logo,
// paper size or welcome message a manager set in the web app.
//
// ...WITH ONE EXCEPTION THAT IS LOAD-BEARING. That preservation applies to the
// UPDATE branch. On INSERT - a tenant/branch that has never saved receipt
// settings - the same function `coalesce`s the automatic-printing flags to
// TRUE. So a desktop save of, say, a template config would silently switch
// automatic printing ON for a branch that had never asked for it. Every write
// below therefore states both flags explicitly, always, carrying forward what
// was read. See `buildReceiptSettingsPayload`.

import { asRecord, bool, str, strOrNull } from "@/lib/pos/rpc";
import { AUTO_PRINT_UNKNOWN, type AutoPrintSettings } from "@/lib/pos/autoPrint";
import { normalizeTemplate, type ReceiptKind, type TemplateConfig } from "@/lib/pos/receiptTemplate";

/**
 * The row, as the desktop uses it.
 *
 * Narrower than the table: `business_code`, `slogan` and `updated_by` are read
 * by nothing here, so they are not selected. Anything not listed is preserved
 * on save by the partial-update contract above.
 */
export type ReceiptDesignSettings = {
  /** Null when the row is tenant-wide rather than branch-specific. */
  branchId: string | null;
  autoPrint: AutoPrintSettings;
  paperSize: string;
  logoUrl: string | null;
  showLogo: boolean;
  headerAddress: string | null;
  headerPhone: string | null;
  welcomeMessage: string | null;
  footerMessage: string | null;
  customer: TemplateConfig;
  kitchen: TemplateConfig;
  /** False when no row exists yet, so the screen can say "not configured". */
  exists: boolean;
};

/** What a branch that has never saved anything gets. Automatic printing OFF. */
export function unconfiguredDesign(branchId: string | null): ReceiptDesignSettings {
  return {
    branchId,
    autoPrint: AUTO_PRINT_UNKNOWN,
    paperSize: "80mm",
    logoUrl: null,
    showLogo: false,
    headerAddress: null,
    headerPhone: null,
    welcomeMessage: null,
    footerMessage: null,
    customer: normalizeTemplate("customer", null),
    kitchen: normalizeTemplate("kitchen", null),
    exists: false,
  };
}

const COLUMNS =
  "branch_id, paper_size, show_logo, logo_url, header_address, header_phone, welcome_message, footer_message, " +
  "kitchen_template_config, customer_template_config, auto_print_customer, auto_print_kitchen";

/**
 * Read the automatic-printing settings for this branch.
 *
 * NEVER THROWS. A settings read that fails must not be able to interrupt
 * anything: by the time this is called an order has already been submitted or
 * paid, and turning a settings hiccup into an error on that path would be
 * exactly the coupling the whole printing design exists to avoid. An
 * unreadable row is reported as "unknown", which means both documents stay
 * manual - see `AUTO_PRINT_UNKNOWN` for why that direction and not the other.
 *
 * Still selects only the two columns it uses. The full row is a separate read
 * (`readReceiptDesign`) made by a settings screen, not by a print path: a
 * printing hot path has no business pulling a tenant's logo URL and marketing
 * copy into memory after every order.
 */
export async function readAutoPrintSettings(input: {
  tenantId: string;
  branchId: string | null;
}): Promise<AutoPrintSettings> {
  try {
    const { supabase } = await import("@/lib/supabase");
    const { data, error } = await supabase
      .from("pos_receipt_settings")
      .select("branch_id, auto_print_customer, auto_print_kitchen")
      .eq("tenant_id", input.tenantId);
    if (error || !Array.isArray(data) || data.length === 0) return AUTO_PRINT_UNKNOWN;

    const row = pickRow(data.map(asRecord), input.branchId);
    if (!row) return AUTO_PRINT_UNKNOWN;

    return {
      customer: bool(row.auto_print_customer),
      kitchen: bool(row.auto_print_kitchen),
    };
  } catch {
    return AUTO_PRINT_UNKNOWN;
  }
}

/**
 * Branch-specific first, then the tenant-wide row.
 *
 * `find` rather than a sort: there is at most one of each, and expressing the
 * precedence as a lookup order says what it means.
 */
function pickRow(rows: Record<string, unknown>[], branchId: string | null) {
  return (
    (branchId ? rows.find((r) => r.branch_id === branchId) : undefined) ?? rows.find((r) => r.branch_id === null)
  );
}

/**
 * Read the whole design for a settings screen.
 *
 * Throws on a read error, unlike `readAutoPrintSettings`: this one is called by
 * a screen the operator is looking at, where "the settings could not be loaded"
 * is information they need, not an interruption to a sale.
 */
export async function readReceiptDesign(input: {
  tenantId: string;
  branchId: string | null;
}): Promise<ReceiptDesignSettings> {
  const { supabase } = await import("@/lib/supabase");
  const { data, error } = await supabase
    .from("pos_receipt_settings")
    .select(COLUMNS)
    .eq("tenant_id", input.tenantId);
  if (error) throw new Error(error.message);

  const rows = ((data ?? []) as unknown[]).map(asRecord);
  const row = pickRow(rows, input.branchId);
  if (!row) return unconfiguredDesign(input.branchId);

  return {
    branchId: strOrNull(row.branch_id),
    autoPrint: { customer: bool(row.auto_print_customer), kitchen: bool(row.auto_print_kitchen) },
    paperSize: str(row.paper_size, "80mm"),
    logoUrl: strOrNull(row.logo_url),
    showLogo: bool(row.show_logo),
    headerAddress: strOrNull(row.header_address),
    headerPhone: strOrNull(row.header_phone),
    welcomeMessage: strOrNull(row.welcome_message),
    footerMessage: strOrNull(row.footer_message),
    customer: normalizeTemplate("customer", row.customer_template_config),
    kitchen: normalizeTemplate("kitchen", row.kitchen_template_config),
    exists: true,
  };
}

/**
 * The same read, for a path that must never throw.
 *
 * Used by automatic printing, which runs AFTER a payment has succeeded. A
 * settings hiccup there must cost the operator a customised layout, never an
 * error on the happiest path in the app - so an unreadable row becomes null,
 * and `receiptRender.ts` turns null into "draw everything".
 */
export async function readReceiptDesignSafe(input: {
  tenantId: string;
  branchId: string | null;
}): Promise<ReceiptDesignSettings | null> {
  try {
    return await readReceiptDesign(input);
  } catch {
    return null;
  }
}

/** The fields a desktop screen may change. Everything else is left alone. */
export type ReceiptSettingsPatch = {
  autoPrintCustomer?: boolean;
  autoPrintKitchen?: boolean;
  customerTemplate?: TemplateConfig;
  kitchenTemplate?: TemplateConfig;
};

/**
 * Build the RPC payload.
 *
 * Pure, and exported, so the two rules that matter can be asserted directly
 * rather than inferred from a click handler:
 *
 *   1. ONLY THE REQUESTED KEYS APPEAR, so nothing the desktop does not edit -
 *      logo, paper size, welcome, footer, business code - can be overwritten.
 *   2. BOTH AUTOMATIC-PRINTING FLAGS ALWAYS APPEAR, carried from `current` when
 *      the patch does not change them, because the INSERT branch of
 *      `save_pos_receipt_settings` defaults them to true. Without this a branch
 *      that had never saved settings would start printing by itself the first
 *      time somebody edited a receipt template on a till.
 */
export function buildReceiptSettingsPayload(input: {
  tenantId: string;
  branchId: string;
  current: Pick<ReceiptDesignSettings, "autoPrint">;
  patch: ReceiptSettingsPatch;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    tenant_id: input.tenantId,
    branch_id: input.branchId,
    auto_print_customer: input.patch.autoPrintCustomer ?? input.current.autoPrint.customer,
    auto_print_kitchen: input.patch.autoPrintKitchen ?? input.current.autoPrint.kitchen,
  };
  if (input.patch.customerTemplate) payload.customer_template_config = input.patch.customerTemplate;
  if (input.patch.kitchenTemplate) payload.kitchen_template_config = input.patch.kitchenTemplate;
  return payload;
}

export class ReceiptSettingsWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceiptSettingsWriteError";
  }
}

/**
 * Save a patch through the web app's own RPC.
 *
 * A CONCRETE BRANCH IS REQUIRED. `pos_receipt_settings` has a plain unique
 * index on `(tenant_id, branch_id)`, and in Postgres two NULLs are distinct, so
 * `on conflict (tenant_id, branch_id)` never matches a tenant-wide row - a save
 * with a null branch would INSERT a duplicate rather than update. The desktop
 * always knows its branch, so refusing is honest and costs nothing.
 *
 * AUTHORISATION IS THE SERVER'S. The RPC checks `pos.settings.manage` itself
 * and raises when it is missing; the UI checks the same key so the operator is
 * told before they type, never instead of the server deciding.
 */
export async function saveReceiptSettings(input: {
  tenantId: string;
  branchId: string | null;
  current: Pick<ReceiptDesignSettings, "autoPrint">;
  patch: ReceiptSettingsPatch;
}): Promise<void> {
  if (!input.branchId) {
    throw new ReceiptSettingsWriteError(
      "This terminal has no branch, so receipt settings cannot be saved from here. Set them in the Breadee web app.",
    );
  }
  const payload = buildReceiptSettingsPayload({
    tenantId: input.tenantId,
    branchId: input.branchId,
    current: input.current,
    patch: input.patch,
  });
  const { supabase } = await import("@/lib/supabase");
  // The same documented cast the routing resolver uses: `rpc` is invoked as a
  // METHOD so the client keeps `this`, and the generated types predate several
  // of this table's columns.
  const client = supabase as unknown as {
    rpc(name: string, args: Record<string, unknown>): PromiseLike<{ error: { message: string } | null }>;
  };
  const { error } = await client.rpc("save_pos_receipt_settings", { p_payload: payload });
  if (error) throw new ReceiptSettingsWriteError(receiptSettingsWriteMessage(error.message));
}

/** The server's refusal, in words an operator can act on. */
export function receiptSettingsWriteMessage(raw: string): string {
  const text = (raw ?? "").toLowerCase();
  if (text.includes("not authorized") || text.includes("permission") || text.includes("row-level security")) {
    return "You do not have permission to change receipt settings. It needs the “manage POS settings” permission.";
  }
  if (text.includes("cross-tenant")) {
    return "These settings belong to a different business and cannot be changed from this terminal.";
  }
  return raw.trim() !== "" ? raw : "The receipt settings could not be saved.";
}

/** Which permission key the two desktop screens check before offering a save. */
export const RECEIPT_SETTINGS_PERMISSION = "pos.settings.manage";

export type ReceiptSettingsGate = { allowed: boolean; reason: string | null };

export function canManageReceiptSettings(permissions: Record<string, boolean> | null | undefined): ReceiptSettingsGate {
  if (permissions?.[RECEIPT_SETTINGS_PERMISSION]) return { allowed: true, reason: null };
  return {
    allowed: false,
    reason: "You do not have permission to change these settings. It needs the “manage POS settings” permission.",
  };
}

export type { ReceiptKind };
