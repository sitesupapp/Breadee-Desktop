// Shared POS domain types for the desktop app.
//
// These mirror the shapes the staging Supabase contracts actually read and write.
// Nothing here invents a field: every property maps to a column the web POS
// already selects, or to a key `pos_submit_order` / `pos_pay_order` already parse.

import type { CurrencyCode } from "@/lib/currency";

export type OrderType = "takeaway" | "dine_in" | "delivery";

/** The additive m212/m213 currency metadata carried by every price-bearing row. */
export type PriceMetadata = {
  price_entered_amount?: number | string | null;
  price_entered_currency?: string | null;
  price_exchange_rate_usd_to_lbp?: number | string | null;
  price_amount_usd?: number | string | null;
};

export type MenuCategory = {
  id: string;
  name: string;
};

export type MenuItem = PriceMetadata & {
  id: string;
  name: string;
  price: number | string | null;
  category_id: string | null;
  image_url: string | null;
};

export type ModifierGroup = {
  id: string;
  name: string;
  selection_type: string; // 'single' | anything else = multi
  is_required: boolean;
  min_select: number;
  max_select: number;
};

export type ModifierOption = PriceMetadata & {
  id: string;
  modifier_group_id: string;
  name: string;
  extra_price: number | string | null;
};

/** Exactly the modifier shape `pos_save_order` reads out of `items[].modifiers[]`. */
export type SelectedModifier = {
  group_id: string | null;
  option_id: string | null;
  name: string;
  price_delta: number;
  quantity: number;
};

/** One cart line. `key` is a client-only identity for React and keyboard focus. */
export type CartLine = {
  key: string;
  menu_item_id: string;
  name: string;
  base_price: number;
  quantity: number;
  kitchen_note: string | null;
  modifiers: SelectedModifier[];
};

/** The full menu payload a POS route needs, loaded once per tenant/branch. */
export type MenuData = {
  categories: MenuCategory[];
  items: MenuItem[];
  groups: ModifierGroup[];
  options: ModifierOption[];
  /** menu_item_id -> attached modifier_group_id[] */
  groupsByItem: Record<string, string[]>;
};

// --- Shifts -----------------------------------------------------------------

export type ShiftStatus = "open" | "ended_by_cashier" | "pending_manager_review" | "approved" | "rejected";

export type ActiveShift = {
  id: string;
  status: ShiftStatus;
  opened_at: string | null;
  opening_cash_amount: number;
  branch_id: string | null;
};

/** `pos_shift_expected` response. Server-authoritative - never recomputed here. */
export type ShiftExpected = {
  expected: number;
  cash_sales: number;
  orders: number;
  opening_cash: number;
  cash_usd: number;
  cash_lbp_original: number;
  cash_lbp_usd: number;
  exchange_rate: number | null;
};

/** `pos_cash_box_shift` response. Server-authoritative. */
export type CashBox = {
  shift_id: string | null;
  shift_open: boolean;
  opened_at: string | null;
  opening_cash: number;
  branch_id: string | null;
  branch_name: string | null;
  exchange_rate: number | null;
  cash_usd: number;
  cash_lbp: number;
  cash_lbp_usd: number;
  total_usd: number;
  total_lbp: number | null;
  expected_cash: number;
  payment_count: number;
};

/** `pos_end_shift` report. Server-authoritative. */
export type ShiftReport = {
  shift_id: string;
  orders: number;
  gross_sales: number;
  discounts: number;
  net_sales: number;
  cancelled_void: number;
  refunded_count: number;
  cash_sales: number;
  opening_cash: number;
  expected_cash: number;
  actual_cash: number;
  difference: number;
  notes: string | null;
  opened_at: string | null;
  closed_at: string | null;
  cash_usd: number;
  cash_lbp_original: number;
  cash_lbp_usd: number;
  exchange_rate: number | null;
  by_item: { item: string; qty: number; total: number }[];
  payments: Record<string, number>;
};

// --- Orders / payments -------------------------------------------------------

export type SubmitOrderResult = {
  order_id: string;
  order_number: string;
  subtotal: number;
  total: number;
  batch_no?: number;
  appended?: boolean;
  idempotent?: boolean;
};

export type PayOrderResult = {
  order_id: string;
  paid: boolean;
  method: string;
  subtotal: number;
  discount: number;
  amount: number;
  order_number: string;
  currency_code: CurrencyCode;
  original_amount: number;
  exchange_rate: number | null;
};
