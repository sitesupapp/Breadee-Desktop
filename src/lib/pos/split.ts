// READY POS Phase E — item/quantity-based Split Bill for Dine-In.
//
// A split is a SETTLEMENT, never a second sale. The server (pos_split_settle) owns
// every figure: it validates available quantity, settles the allocated items through
// the EXISTING pos_payments ledger, and completes the parent ONLY when every line is
// fully allocated. This module only shapes the request and parses the response — no
// client-side financial authority. `expected_version` + a fresh `client_op_id` give
// optimistic concurrency + idempotent retry, exactly like Phase D line editing.

import { callPosRpc, asRecord, bool, num, str, requireId } from "@/lib/pos/rpc";

export type SplitLine = {
  order_item_id: string;
  name: string;
  quantity: number;
  final_unit_price: number;
  line_total: number;
  kitchen_note: string | null;
  allocated_qty: number;
  available_qty: number;
};

export type SplitSettlement = {
  split_no: number;
  display_no: string;
  amount: number;
  method: string;
  currency: string;
  paid_at: string | null;
};

export type SplitState = {
  order_id: string;
  order_number: string;
  status: string;
  payment_status: string;
  pos_entity_version: number;
  total_amount: number;
  paid_amount_usd: number;
  currency: string;
  lines: SplitLine[];
  settlements: SplitSettlement[];
};

export type SplitResult = {
  ok: boolean;
  split_no: number;
  display_no: string;
  settlement_id: string;
  amount: number;
  amount_usd: number;
  currency_code: string;
  method: string;
  parent_completed: boolean;
  remaining_qty: number;
  pos_entity_version: number;
  order_number: string;
};

/** A method from the tenant's Phase B catalog (`pos_payment_methods`). */
export type SplitPaymentMethod = { key: string; label: string; is_cash: boolean };

export type SplitAllocationInput = { order_item_id: string; quantity: number };

export type SplitSettlePayload = {
  order_id: string;
  expected_version: number;
  method: string;
  currency_code: string;
  client_op_id: string;
  allocations: SplitAllocationInput[];
};

/** Pure — shapes exactly what the server reads. No totals are sent; the server prices it. */
export function buildSplitSettlePayload(input: {
  orderId: string;
  expectedVersion: number;
  method: string;
  currencyCode: string;
  clientOpId: string;
  allocations: SplitAllocationInput[];
}): SplitSettlePayload {
  return {
    order_id: input.orderId,
    expected_version: input.expectedVersion,
    method: input.method,
    currency_code: input.currencyCode,
    client_op_id: input.clientOpId,
    allocations: input.allocations.map((a) => ({ order_item_id: a.order_item_id, quantity: a.quantity })),
  };
}

function parseLine(v: unknown): SplitLine {
  const r = asRecord(v);
  return {
    order_item_id: str(r.order_item_id),
    name: str(r.name),
    quantity: num(r.quantity),
    final_unit_price: num(r.final_unit_price),
    line_total: num(r.line_total),
    kitchen_note: typeof r.kitchen_note === "string" ? r.kitchen_note : null,
    allocated_qty: num(r.allocated_qty),
    available_qty: num(r.available_qty),
  };
}

function parseSettlement(v: unknown): SplitSettlement {
  const r = asRecord(v);
  return {
    split_no: num(r.split_no),
    display_no: str(r.display_no),
    amount: num(r.amount),
    method: str(r.method),
    currency: str(r.currency, "USD"),
    paid_at: typeof r.paid_at === "string" ? r.paid_at : null,
  };
}

export function parseSplitState(value: unknown): SplitState {
  const r = asRecord(value);
  return {
    order_id: str(r.order_id),
    order_number: str(r.order_number),
    status: str(r.status),
    payment_status: str(r.payment_status),
    pos_entity_version: num(r.pos_entity_version),
    total_amount: num(r.total_amount),
    paid_amount_usd: num(r.paid_amount_usd),
    currency: str(r.currency, "USD"),
    lines: Array.isArray(r.lines) ? r.lines.map(parseLine) : [],
    settlements: Array.isArray(r.settlements) ? r.settlements.map(parseSettlement) : [],
  };
}

export async function loadSplitState(orderId: string): Promise<SplitState> {
  return parseSplitState(await callPosRpc("pos_split_state", { p_order_id: orderId }));
}

export async function settleSplit(payload: SplitSettlePayload): Promise<SplitResult> {
  const r = asRecord(await callPosRpc("pos_split_settle", { p_payload: payload }));
  return {
    ok: bool(r.ok),
    split_no: num(r.split_no),
    display_no: str(r.display_no),
    settlement_id: requireId(r.settlement_id, "pos_split_settle", "settlement_id"),
    amount: num(r.amount),
    amount_usd: num(r.amount_usd),
    currency_code: str(r.currency_code, "USD"),
    method: str(r.method),
    parent_completed: bool(r.parent_completed),
    remaining_qty: num(r.remaining_qty),
    pos_entity_version: num(r.pos_entity_version),
    order_number: str(r.order_number),
  };
}

/**
 * The tenant's ACTIVE payment methods (Phase B catalog). Read directly under RLS —
 * the catalog is tenant-readable and moves no money. Cash affects the drawer; every
 * other method is non-cash. Falls back to Cash if the catalog cannot be read, so a
 * split can always be taken.
 */
const CASH_ONLY: SplitPaymentMethod[] = [{ key: "cash", label: "Cash", is_cash: true }];

export async function loadSplitPaymentMethods(tenantId: string | null | undefined): Promise<SplitPaymentMethod[]> {
  if (!tenantId) return CASH_ONLY;
  try {
    const { supabase } = await import("@/lib/supabase");
    // `database.types.ts` predates `pos_payment_methods` (same reason `rpc.ts` casts the
    // client): a documented structural cast rather than a schema regen for one read.
    const client = supabase as unknown as {
      from(table: string): {
        select(cols: string): {
          eq(col: string, val: unknown): {
            eq(col: string, val: unknown): {
              order(col: string): PromiseLike<{ data: unknown; error: { message: string } | null }>;
            };
          };
        };
      };
    };
    const { data, error } = await client
      .from("pos_payment_methods")
      .select("key,label,is_cash,is_active,sort_order")
      .eq("tenant_id", tenantId)
      .eq("is_active", true)
      .order("sort_order");
    if (error || !Array.isArray(data) || data.length === 0) return CASH_ONLY;
    return (data as unknown[]).map((row) => {
      const m = asRecord(row);
      return { key: str(m.key, "cash"), label: str(m.label, "Cash"), is_cash: bool(m.is_cash) };
    });
  } catch {
    return CASH_ONLY;
  }
}
