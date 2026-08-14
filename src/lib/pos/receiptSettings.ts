// Reading the branch's automatic-printing preference.
//
// ONE ROW, TWO BOOLEANS, NO WRITES. `pos_receipt_settings` also carries the
// receipt template, logo, header, slogan and paper size - none of which this
// module reads, because none of them is what "should this print by itself?"
// depends on. Reading the whole row and using two fields is the honest shape,
// but SELECTING the whole row would put a tenant's logo URL and marketing copy
// into desktop memory for no reason at all, so the select names its columns.
//
// THE DESKTOP NEVER WRITES THIS TABLE. `save_pos_receipt_settings` exists and is
// deliberately not called from anywhere in this app: the setting is a manager's
// decision made once, in the web admin, for the whole branch. A till that could
// flip it would be one terminal changing how every other terminal behaves.
//
// SCOPE. Rows may be branch-specific or tenant-wide (`branch_id is null`), and a
// branch-specific row wins - the same precedence the rest of the product uses
// for branch overrides. A tenant with neither row is not misconfigured; it is a
// tenant that has never opened the screen, and it gets the unknown default.

import { asRecord, bool } from "@/lib/pos/rpc";
import { AUTO_PRINT_UNKNOWN, type AutoPrintSettings } from "@/lib/pos/autoPrint";

/**
 * Read the automatic-printing settings for this branch.
 *
 * NEVER THROWS. A settings read that fails must not be able to interrupt
 * anything: by the time this is called an order has already been submitted or
 * paid, and turning a settings hiccup into an error on that path would be
 * exactly the coupling the whole printing design exists to avoid. An
 * unreadable row is reported as "unknown", which means both documents stay
 * manual - see `AUTO_PRINT_UNKNOWN` for why that direction and not the other.
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

    const rows = data.map(asRecord);
    // Branch-specific first, then the tenant-wide row. `find` rather than a
    // sort: there is at most one of each, and expressing the precedence as a
    // lookup order says what it means.
    const row =
      (input.branchId ? rows.find((r) => r.branch_id === input.branchId) : undefined) ??
      rows.find((r) => r.branch_id === null);
    if (!row) return AUTO_PRINT_UNKNOWN;

    return {
      customer: bool(row.auto_print_customer),
      kitchen: bool(row.auto_print_kitchen),
    };
  } catch {
    return AUTO_PRINT_UNKNOWN;
  }
}
