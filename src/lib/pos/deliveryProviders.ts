// Delivery provider configuration — server-authoritative via the WS3 provider RPCs.
//
// RPC-ONLY. This module NEVER touches the delivery_providers / delivery_settlements
// tables directly (`.from(...)` is deliberately absent). The server is the sole
// authority: delivery_provider_upsert / delivery_provider_set_active enforce the
// canonical feature `assert_feature_access('pos','delivery_providers')`, the
// `pos.delivery.providers.manage` permission and exact-OU access; the admin list RPC
// re-checks the permission and branch access. The desktop only renders what the RPC
// returns and writes through the RPC.
//
// Wave 1 exposes ONLY the two settlement modes and three cost-entry modes the
// delivery_provider_upsert RPC accepts. The unfinished modes (driver_payable,
// payroll, analytics_only, automatic_rate) are never offered or sent.

import { supabase } from "@/lib/supabase";

export type ProviderKind = "external_provider" | "internal_driver";
export type SettlementMode = "immediate_cash" | "provider_payable";
export type CostEntryMode = "required_before_pay" | "optional" | "entered_later";
export type StatementCycle = "weekly" | "biweekly" | "monthly" | "manual";
export type ProviderCurrency = "LBP" | "USD";

/** One provider row. Mirrors to_jsonb(delivery_providers) from delivery_providers_admin_list. */
export type DeliveryProvider = {
  id: string;
  branch_id: string;
  kind: ProviderKind;
  name: string;
  provider_ref: string | null;
  status: "active" | "inactive";
  default_currency: ProviderCurrency | null;
  settlement_mode: SettlementMode;
  cost_entry_mode: CostEntryMode;
  statement_cycle: StatementCycle;
  contact_phone: string | null;
  contact_email: string | null;
  notes: string | null;
};

/** The editable payload delivery_provider_upsert(p_payload jsonb) accepts. */
export type ProviderUpsert = {
  id?: string | null;
  branch_id: string;
  name: string;
  kind: ProviderKind;
  settlement_mode: SettlementMode;
  cost_entry_mode: CostEntryMode;
  statement_cycle: StatementCycle;
  default_currency: ProviderCurrency | null;
  provider_ref: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  notes: string | null;
  status?: "active" | "inactive";
};

// The WS3 RPCs are newer than this build's generated database.types.ts, so the calls
// are cast (the same pattern the web app uses) rather than loosening the typed client.
type UntypedRpc = (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
const rpc = supabase.rpc.bind(supabase) as unknown as UntypedRpc;

/** Full provider configuration for one authorized OU. Requires pos.delivery.providers.manage. */
export async function loadProviders(branchId: string): Promise<DeliveryProvider[]> {
  const { data, error } = await rpc("delivery_providers_admin_list", { p_branch: branchId });
  if (error) throw new Error(error.message);
  return (data as DeliveryProvider[] | null) ?? [];
}

/** Create or update a provider in exactly one OU. Feature + permission + OU enforced server-side. */
export async function saveProvider(payload: ProviderUpsert): Promise<DeliveryProvider> {
  const { data, error } = await rpc("delivery_provider_upsert", { p_payload: payload });
  if (error) throw new Error(error.message);
  return data as DeliveryProvider;
}

/** Soft activate / deactivate. Never hard-deletes (preserves settlement history). */
export async function setProviderActive(id: string, active: boolean): Promise<DeliveryProvider> {
  const { data, error } = await rpc("delivery_provider_set_active", { p_id: id, p_active: active });
  if (error) throw new Error(error.message);
  return data as DeliveryProvider;
}
