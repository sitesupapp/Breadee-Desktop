// The single boundary where the desktop app calls a Supabase POS RPC.
//
// WHY THIS EXISTS
// `src/lib/database.types.ts` was generated before m216/m224 and therefore does
// not know about `pos_submit_order` (nor `pos_void_order`'s `p_refund`). Rather
// than regenerate the whole schema as part of this level - or sprinkle `as never`
// casts through feature code, which is what the old `orders.ts` did - every POS
// RPC goes through here. There is exactly ONE structural cast, it is documented,
// and every response is parsed at runtime into a real type. Feature code above
// this file never sees `unknown`.
//
// IMPORTANT (learned the hard way): never detach `supabase.rpc` into a bare
// const and call it - the Supabase client loses `this` and throws
// "Cannot read properties of undefined (reading 'rest')". The call below is a
// method invocation on the client object, so `this` is preserved.
//
// The client is imported LAZILY. Constructing it reads build-time env, so a
// top-level import would drag an environment into every module that merely wants
// to build a payload - and would make the contract layer untestable in isolation.

type RpcResponse = { data: unknown; error: { message: string } | null };

/** The POS RPCs this level is allowed to call. Narrow on purpose. */
export type PosRpcName =
  | "pos_open_shift"
  | "pos_end_shift"
  | "pos_shift_expected"
  | "pos_cash_box_shift"
  | "pos_submit_order"
  | "pos_pay_order"
  // Level 2A - Dine-In table foundation. Read + open.
  | "pos_table_map"
  | "pos_open_table"
  // 1.0.4 - the branch's configured table capacity, and the SAME contract the
  // Breadee web app calls. Listed here rather than reached through a desktop
  // helper of its own precisely because there must be one answer to "how many
  // tables does this branch have"; `pos.settings.manage` is enforced server-side.
  | "pos_configure_tables"
  // Level 2C - table operations.
  | "pos_move_table"
  | "pos_close_table"
  | "pos_clear_table"
  // Level 2D - settlement. Note this RPC has NO idempotency key, unlike
  // `pos_submit_order`: duplicate-payment safety is state-based on the server
  // (a second call finds no open unpaid order), and the client must recover a
  // lost response by authoritative re-read rather than by retrying blindly.
  // See `lib/pos/tablePayment.ts`.
  | "pos_pay_table"
  // Level 3A - Delivery customer foundation. The ONLY write the customer flow
  // performs: `pos_customers` and `pos_customer_addresses` are read directly
  // under RLS but never written directly, because this RPC owns the phone
  // matching, the address defaulting and the activity log.
  //
  // Note what is still absent: Delivery ORDERING and PAYMENT reuse
  // `pos_submit_order` / `pos_pay_order`, which are already listed above - so
  // Level 3A adds no order or money RPC, and the delivery workspace calls
  // neither. Those arrive with Levels 3B and 3C.
  | "pos_upsert_customer"
  // Level 3D - Delivery order management. The two mutations the web's delivery
  // panel already exposes, and nothing else.
  //
  // `pos_edit_order` changes an order's note, and its discount while unpaid. It
  // takes no shift lock and writes no payment row.
  //
  // `pos_void_order` is the financial one, and it is TWO actions behind one
  // name: on an unpaid order it voids, and on a paid order it refunds - the
  // server refuses to void a paid order without the refund flag. Unusually for
  // this codebase it is IDEMPOTENT, keyed per order in
  // `pos_operation_idempotency`, so a repeat replays the first result instead of
  // reversing the money twice.
  //
  // Still absent, deliberately: `pos_remove_order_item`. Removing a line from a
  // paid order re-settles it, and that belongs with its own verification rather
  // than riding along here.
  | "pos_edit_order"
  | "pos_void_order";

/** Raised for any server-side refusal, carrying the server's own wording. */
export class PosRpcError extends Error {
  readonly rpc: PosRpcName;
  constructor(rpc: PosRpcName, message: string) {
    super(message);
    this.name = "PosRpcError";
    this.rpc = rpc;
  }
}

export async function callPosRpc(rpc: PosRpcName, args: Record<string, unknown>): Promise<unknown> {
  const { supabase } = await import("@/lib/supabase");
  // The one documented cast. `rpc` is invoked as a method so `this` is intact.
  const client = supabase as unknown as {
    rpc(name: string, args: Record<string, unknown>): PromiseLike<RpcResponse>;
  };
  const { data, error } = await client.rpc(rpc, args);
  if (error) throw new PosRpcError(rpc, error.message);
  return data;
}

// --- Runtime parsing helpers -------------------------------------------------
//
// A SECURITY DEFINER RPC returns jsonb, so the wire shape is genuinely unknown at
// compile time. These turn it into typed data without pretending.

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function num(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function strOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

export function bool(value: unknown): boolean {
  return value === true;
}

/**
 * A required id in an RPC response. Missing means the contract changed, which is
 * never something to paper over with a fallback.
 */
export function requireId(value: unknown, rpc: PosRpcName, field: string): string {
  if (typeof value === "string" && value !== "") return value;
  throw new PosRpcError(rpc, `${rpc} returned no ${field}. The server contract may have changed.`);
}
