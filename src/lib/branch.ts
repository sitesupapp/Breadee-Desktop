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
import { getDeviceIdentity } from "@/lib/device";
import { readPosSessionSnapshot, restoreBranchNameFromSnapshot } from "@/lib/offline/posSession";
import { restoreBranchName, saveBranchContext } from "@/lib/offline/branchContext";
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
 * The branch NAME to show offline for an already-resolved branch id, from the
 * durable caches, or null. Tries the shift-INDEPENDENT branch-context cache first
 * (works with no open shift - the gap that caused "Branch unavailable"), then the
 * open-shift POS-session snapshot. Both are identity-gated (device+tenant+branch);
 * the id is always the authority, so this can never widen, rename or invent access.
 */
function cachedBranchName(branchId: string, tenantId: string, deviceId: string): string | null {
  return (
    restoreBranchName({ deviceId, tenantId, branchId }) ??
    restoreBranchNameFromSnapshot(readPosSessionSnapshot(), { branchId, tenantId, deviceId })
  );
}

/**
 * Resolve the branch and read its NAME. A uuid fragment is never an acceptable
 * label for a cashier, so a failed/offline lookup falls back to the durable caches,
 * then to plain words. `currency` (the operational display currency, when known) is
 * cached alongside the name so an offline restart can name the branch regardless of
 * shift state.
 */
export async function loadBranchContext(
  tenant: Tenant | null,
  membership: Membership | null,
  opts?: { currency?: string },
): Promise<BranchContext> {
  const id = resolveBranchId(tenant, membership);
  if (!id || !tenant) return UNKNOWN_BRANCH;
  const pinned = !membership?.all_branches;
  const deviceId = getDeviceIdentity().device_id;

  // Known-offline: do not even attempt the network (it would fail with a raw
  // "Failed to fetch" in the console). Serve the cached name straight away. A
  // backend that is unreachable while navigator.onLine stays true (the WebView2
  // Wi-Fi-drop quirk) is handled by the try/catch below instead.
  const netOffline = typeof navigator !== "undefined" && navigator.onLine === false;
  if (netOffline) {
    return { id, name: cachedBranchName(id, tenant.id, deviceId) ?? "Branch unavailable", pinned };
  }

  try {
    const { data, error } = await supabase
      .from("branches")
      .select("id, name")
      .eq("id", id)
      .eq("tenant_id", tenant.id)
      .maybeSingle();
    // A transport failure can surface as either a thrown TypeError or an {error}
    // result depending on the runtime; treat both as "unreachable" (caught below).
    if (error || !data) throw error ?? new Error("branch name unavailable");
    const name = typeof data.name === "string" && data.name.trim() !== "" ? data.name.trim() : "Unnamed branch";
    // Cache the server-confirmed name (shift-independent) for the next offline start.
    saveBranchContext({ deviceId, tenantId: tenant.id, branchId: id, branchName: name, currency: opts?.currency ?? "USD" });
    return { id, name, pinned };
  } catch {
    // Offline (or the name row is momentarily unreadable): name from the durable
    // caches, else the honest placeholder. Never a raw network error to the UI.
    return { id, name: cachedBranchName(id, tenant.id, deviceId) ?? "Branch unavailable", pinned };
  }
}
