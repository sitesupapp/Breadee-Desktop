// Typed wrappers for the online POS write RPCs on Supabase (staging). These call the
// SAME m140 functions the web app uses — branch is derived server-side and the paid
// amount is the server-trusted order total (the client cannot dictate it). RLS +
// permissions + pos_assert_operator are enforced by the server, not here.
//
// ONLINE-ONLY: callers must confirm connectivity before invoking these. There is no
// offline queue for paid orders in this increment (that is Phase 4).

import { supabase } from "@/lib/supabase";
import type { Json } from "@/lib/database.types";

export type SaveOrderLine = {
  menu_item_id: string;
  name: string;
  quantity: number;
  base_price: number;
  kitchen_note?: string | null;
};

export type SaveOrderPayload = {
  order_type: "takeaway";
  status?: string; // server defaults to 'sent_to_kitchen'
  discount_amount?: number;
  customer_id?: string | null;
  notes?: string | null;
  shift_id?: string | null;
  items: SaveOrderLine[];
};

export type SaveOrderResult = {
  order_id: string;
  order_number: string;
  subtotal: number;
  total: number;
};

export async function saveOrder(payload: SaveOrderPayload): Promise<SaveOrderResult> {
  const { data, error } = await supabase.rpc("pos_save_order", { p_payload: payload as unknown as Json });
  if (error) throw new Error(error.message);
  return data as unknown as SaveOrderResult;
}

export type PayOrderPayload = {
  order_id: string;
  method?: "cash";
  currency_code?: "USD" | "LBP";
};

export type PayOrderResult = {
  order_id: string;
  paid: boolean;
  method: string;
  subtotal: number;
  discount: number;
  amount: number;
  order_number: string;
  currency_code: string;
  original_amount: number;
  exchange_rate: number | null;
  loyalty?: unknown;
};

export async function payOrder(payload: PayOrderPayload): Promise<PayOrderResult> {
  const { data, error } = await supabase.rpc("pos_pay_order", {
    p_payload: { method: "cash", currency_code: "USD", ...payload } as unknown as Json,
  });
  if (error) throw new Error(error.message);
  return data as unknown as PayOrderResult;
}
