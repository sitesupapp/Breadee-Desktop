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
  // Level 2A - Dine-In table foundation. Read + open only; the mutating table
  // operations (move/close/clear/pay) are deliberately NOT listed, so they
  // cannot be called before their own level lands.
  | "pos_table_map"
  | "pos_open_table";

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
