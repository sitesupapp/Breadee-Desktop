// Branch resolution + naming.
//
// Mirrors the web app's server-side rule (POSScreen.tsx):
//   branchId = all_branches ? tenant.main_branch_id : (membership.branch_id ?? tenant.main_branch_id)
//
// The resolved id is only ever a REQUEST: pos_open_shift / pos_save_order run it
// through `pos_resolve_operational_branch` (m223) and reject anything the user is
// not scoped to, so this can never widen access. It exists so the status bar can
// name the branch instead of showing a uuid fragment, and so the payload carries
// the branch the cashier believes they are working in.

import { supabase } from "@/lib/supabase";
import type { Membership, Tenant } from "@/lib/types";

export type BranchContext = {
  id: string | null;
  name: string;
  /** True when the user is pinned to exactly one branch. */
  pinned: boolean;
};

export const UNKNOWN_BRANCH: BranchContext = { id: null, name: "No branch", pinned: false };

/** The branch id this session operates in. Pure - no I/O. */
export function resolveBranchId(tenant: Tenant | null, membership: Membership | null): string | null {
  if (!membership) return null;
  if (membership.all_branches) return tenant?.main_branch_id ?? null;
  return membership.branch_id ?? tenant?.main_branch_id ?? null;
}

/**
 * Resolve the branch and read its NAME. A uuid fragment is never an acceptable
 * label for a cashier, so a failed lookup falls back to plain words.
 */
export async function loadBranchContext(
  tenant: Tenant | null,
  membership: Membership | null,
): Promise<BranchContext> {
  const id = resolveBranchId(tenant, membership);
  if (!id || !tenant) return UNKNOWN_BRANCH;
  const pinned = !membership?.all_branches;
  const { data, error } = await supabase
    .from("branches")
    .select("id, name")
    .eq("id", id)
    .eq("tenant_id", tenant.id)
    .maybeSingle();
  if (error || !data) return { id, name: "Branch unavailable", pinned };
  const name = typeof data.name === "string" && data.name.trim() !== "" ? data.name.trim() : "Unnamed branch";
  return { id, name, pinned };
}
