// Dine-In table domain types.
//
// Every field here maps to something the staging server actually returns.
// Nothing is invented: `pos_table_map` (m256) is the authority for the map, and
// the bill is read from `pos_orders` + `pos_order_items` because the SERVER owns
// the bill - the desktop never reconstructs one.

import type { CurrencyCode } from "@/lib/currency";
import type { SelectedModifier } from "@/types/pos";

/** Raw `pos_tables.status` values the map can emit. */
export type TableStatus = "available" | "occupied" | "reserved" | "inactive";

/**
 * One row of `pos_table_map`.
 *
 * `name` is the tenant's own label and is used VERBATIM - since m256 a
 * configured table may legitimately be called "5", "Table 5", "Terrace" or
 * "VIP 2", and the server recognises it by `is_configured`, not by its name.
 * Re-deriving or prefixing it client-side would both contradict the tenant and
 * re-create the old "Table Table 5" defect.
 */
export type TableSummary = {
  id: string;
  name: string;
  seats: number | null;
  /** True when the table row is not available OR carries an open bill. */
  occupied: boolean;
  status: TableStatus;
  /** Server's canonical flag (mirrors `is_configured` in the m256 payload). */
  canonical: boolean;
  configured: boolean;
  sort_order: number | null;
  /** Count of open unpaid dine-in orders on this table. */
  orders: number;
  /** First order number of the open bill, when there is one. */
  order_number: string | null;
  opened_at: string | null;
  /** Bill total. NULL when the server refuses to sum mixed currencies. */
  total: number | null;
  currency: CurrencyCode | null;
  /** True when the table's open orders span more than one currency snapshot. */
  mixed_currency: boolean;
};

/** The full `pos_table_map` response, including its aggregate counters. */
export type TableMap = {
  tables: TableSummary[];
  total: number;
  occupied: number;
  available: number;
  configured: number;
  /** Free legacy (non-configured) tables the server deliberately hides. */
  legacy_hidden: number;
};

export const EMPTY_TABLE_MAP: TableMap = {
  tables: [],
  total: 0,
  occupied: 0,
  available: 0,
  configured: 0,
  legacy_hidden: 0,
};

/** `pos_open_table` response. `name` is the STORED name and must be displayed. */
export type OpenTableResult = {
  table_id: string;
  name: string;
  created: boolean;
};

// --- The server-owned bill ---------------------------------------------------

export type BillLine = {
  id: string;
  name: string;
  quantity: number;
  base_price: number;
  modifiers_total: number;
  final_unit_price: number;
  line_total: number;
  kitchen_note: string | null;
  /** Server-assigned round number. Never computed here. */
  batch_no: number;
  modifiers: SelectedModifier[];
};

export type BillOrder = {
  id: string;
  order_number: string;
  status: string;
  payment_status: string;
  shift_id: string | null;
  branch_id: string | null;
  tenant_id: string;
  subtotal: number;
  discount_amount: number;
  total_amount: number;
  currency: CurrencyCode;
  exchange_rate: number | null;
  created_at: string | null;
  lines: BillLine[];
};

/** One table's open bill. `orders` is normally length 1 (m218 single-bill rule). */
export type TableBill = {
  tableId: string;
  orders: BillOrder[];
  /** Sum of order subtotals, only when every order shares one currency. */
  subtotal: number | null;
  total: number | null;
  currency: CurrencyCode | null;
  /** Orders span more than one currency snapshot - the server refuses to settle. */
  mixedCurrency: boolean;
  /** Orders span more than one shift - `pos_pay_table` refuses these. */
  splitShift: boolean;
  /** Distinct batch numbers present, ascending. */
  batches: number[];
};

export const EMPTY_BILL = (tableId: string): TableBill => ({
  tableId,
  orders: [],
  subtotal: null,
  total: null,
  currency: null,
  mixedCurrency: false,
  splitShift: false,
  batches: [],
});

/**
 * The presentation state of a table card. Derived only from what the map can
 * actually support - no state here is invented. There is deliberately no
 * "sent to kitchen", "paid" or "needs clearing" state: `pos_table_map` reports
 * only UNPAID open bills, so those are not representable from what the server
 * says, and a state nothing can produce is a state that will one day lie.
 */
export type TableCardState =
  | "available"
  | "occupied"
  | "active_bill"
  | "mixed_currency"
  | "reserved"
  | "unknown";
