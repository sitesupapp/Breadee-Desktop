// Advanced Delivery Providers — operational capture (Delivery Settlement WS6.3).
//
// RPC-ONLY and server-authoritative. This module NEVER touches the
// delivery_providers / delivery_settlements tables (`.from(...)` is deliberately
// absent). It reads the ACTIVE operational provider list through the
// `delivery_providers_operational` RPC (id / name / kind / settlement_mode /
// cost_entry_mode / default_currency only — no admin or private configuration
// fields, no balances, no supplier/accounting metadata) and writes the order's
// provider + delivery cost through the single server authority
// `pos_delivery_set_provider`.
//
// It NEVER writes a settlement row, computes a settlement snapshot, a drawer
// effect, a provider payable or a cash effect — the server owns all of that at
// finalization (pos_pay_order / pos_complete_on_account → the internal
// _pos_finalize_delivery_settlement). The desktop reproduces NO financial rule as
// authoritative truth; the pre-pay guard below is UX only.
//
// NULL != 0 is preserved by `parseDeliveryCost` (shared with the ops editor): an
// empty box is UNKNOWN (not provided → the server stores NULL), and a typed 0 is
// an explicit free delivery (provided → the server stores 0).

import { asRecord, num, str, strOrNull } from "@/lib/pos/rpc";
import { parseDeliveryCost } from "@/lib/pos/deliveryOrderManagement";

// Re-exported so the editor and its tests share one parser and one distinction.
export { parseDeliveryCost };

/** One ACTIVE provider, exactly the fields delivery_providers_operational returns. */
export type OperationalProvider = {
  id: string;
  name: string;
  kind: string | null;
  settlement_mode: string;
  cost_entry_mode: string;
  default_currency: string | null;
};

function toOperationalProvider(raw: unknown): OperationalProvider | null {
  const r = asRecord(raw);
  const id = strOrNull(r.id);
  if (!id) return null;
  return {
    id,
    name: str(r.name),
    kind: strOrNull(r.kind),
    settlement_mode: str(r.settlement_mode),
    cost_entry_mode: str(r.cost_entry_mode),
    default_currency: strOrNull(r.default_currency),
  };
}

// The WS6.1 RPCs are newer than this build's generated database.types.ts, so the
// calls are cast (the same pattern the WS5 provider-settings module uses) rather
// than loosening the typed client. Supabase is imported lazily so a test that only
// exercises the pure builders/guard never drags a build-time environment in.
type UntypedRpc = (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
async function rpcCall(name: string, args: Record<string, unknown>): Promise<unknown> {
  const { supabase } = await import("@/lib/supabase");
  const rpc = supabase.rpc.bind(supabase) as unknown as UntypedRpc;
  const { data, error } = await rpc(name, args);
  if (error) throw new Error(error.message);
  return data;
}

/**
 * The active operational providers for ONE branch. Reads the operational RPC
 * (active-only, minimal fields) — never the delivery_providers table. Requires
 * pos.delivery.cost.capture (or manage) + exact-OU access, enforced server-side.
 */
export async function loadOperationalProviders(branchId: string): Promise<OperationalProvider[]> {
  const data = await rpcCall("delivery_providers_operational", { p_branch: branchId });
  return (Array.isArray(data) ? data : []).map(toOperationalProvider).filter((p): p is OperationalProvider => p !== null);
}

/** Exactly the parameters pos_delivery_set_provider consumes. Nothing else. */
export const SET_PROVIDER_PARAM_KEYS = [
  "p_order_id",
  "p_provider_id",
  "p_delivery_cost",
  "p_cost_provided",
] as const;

/**
 * Fields the provider write must NEVER carry — the financial firewall the
 * source-contract test asserts against. The server owns every settlement, drawer,
 * payable and cash-effect figure; the client sends only the provider and the cost.
 */
export const FORBIDDEN_SET_PROVIDER_FIELDS = [
  "p_delivery_fee",
  "delivery_fee",
  "p_subtotal",
  "subtotal",
  "p_total",
  "total_amount",
  "payment_status",
  "settlement_status",
  "cash_effect_snapshot",
  "provider_payable_amount",
] as const;

export type SetProviderArgs = {
  p_order_id: string;
  p_provider_id: string;
  /** NULL when not provided (unknown); the numeric value (incl. 0) when provided. */
  p_delivery_cost: number | null;
  /** false => server stores NULL (unknown); true => server stores the value (incl. 0). */
  p_cost_provided: boolean;
};

/**
 * Build the exact args pos_delivery_set_provider consumes, preserving NULL != 0.
 * `cost` is a parsed delivery-cost result (parseDeliveryCost): a blank box is not
 * provided (→ NULL), a typed 0 is provided and 0.
 */
export function buildSetProviderArgs(input: {
  orderId: string;
  providerId: string;
  cost: { value: number | null; provided: boolean };
}): SetProviderArgs {
  return {
    p_order_id: input.orderId,
    p_provider_id: input.providerId,
    p_delivery_cost: input.cost.provided ? input.cost.value : null,
    p_cost_provided: input.cost.provided,
  };
}

export type SetProviderResult = {
  order_id: string;
  delivery_provider_id: string | null;
  provider_name: string | null;
  delivery_cost: number | null;
  cost_known: boolean;
};

/**
 * Persist the order's provider + delivery cost through the single server
 * authority. RPC-only; never a direct pos_orders update, never a settlement write.
 */
export async function setDeliveryProvider(input: {
  orderId: string;
  providerId: string;
  cost: { value: number | null; provided: boolean };
}): Promise<SetProviderResult> {
  const data = await rpcCall("pos_delivery_set_provider", buildSetProviderArgs(input));
  const r = asRecord(data);
  return {
    order_id: str(r.order_id, input.orderId),
    delivery_provider_id: strOrNull(r.delivery_provider_id),
    provider_name: strOrNull(r.provider_name),
    delivery_cost: r.delivery_cost == null ? null : num(r.delivery_cost),
    cost_known: r.cost_known === true,
  };
}

/**
 * Whether the advanced provider surface is live for this order's branch: the
 * feature is on AND the branch has at least one active provider. With zero active
 * providers the server intentionally preserves legacy delivery (finalize is a
 * no-op), so the client must not switch surfaces or block payment — this mirrors
 * _pos_finalize_delivery_settlement exactly.
 */
export function providerCaptureActive(input: { featureOn: boolean; providers: OperationalProvider[] }): boolean {
  return input.featureOn && input.providers.length > 0;
}

/**
 * The friendly, UX-only pre-finalization guard. It mirrors the server rule in
 * _pos_finalize_delivery_settlement so the operator is guided before Pay — but the
 * server stays the sole authority (pos_pay_order / pos_complete_on_account re-check
 * and reject). Returns a message when finalization would be blocked, else null.
 */
export function deliveryProviderFinalizeBlock(input: {
  providerModeOn: boolean;
  providerId: string | null;
  deliveryCost: number | null;
  providers: OperationalProvider[];
}): string | null {
  if (!input.providerModeOn) return null; // feature off OR zero providers → legacy, never block
  if (!input.providerId) return "Select a delivery provider before completing this delivery order.";
  const p = input.providers.find((x) => x.id === input.providerId);
  if (p && p.cost_entry_mode === "required_before_pay" && input.deliveryCost == null) {
    return `Delivery cost is required for ${p.name} before completing this order.`;
  }
  return null;
}
