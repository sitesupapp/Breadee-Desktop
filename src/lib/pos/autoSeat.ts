// READY POS Phase F — Auto-Seat / Direct Table Open (desktop read + offline cache).
//
// The tenant/branch setting lives on the canonical per-branch POS settings row
// (pos_receipt_settings.auto_seat_direct_open), managed from the Web POS Settings
// page. The desktop reads it under RLS (the same way loadSplitPaymentMethods reads
// pos_payment_methods) and caches the last synchronized value per branch so an
// OFFLINE till can still decide. It is NEVER a draft/unpublished source.
//
// Fail-safe by construction: any doubt (no cached value, read error, offline with
// no cache) resolves to OFF, which keeps the existing seat prompt. Auto-seat can
// only SKIP the prompt when the setting is known-true AND the table has a published
// seat count — the decision itself is made in the workspace, not here.

import { bool } from "@/lib/pos/rpc";

const CACHE_PREFIX = "breadee-desktop-autoseat:";

function cacheKey(branchId: string): string {
  return `${CACHE_PREFIX}${branchId}`;
}

/** Last synchronized value for this branch. Sync + offline-safe. Defaults to OFF. */
export function readCachedAutoSeat(branchId: string | null | undefined): boolean {
  if (!branchId) return false;
  try {
    return localStorage.getItem(cacheKey(branchId)) === "1";
  } catch {
    return false;
  }
}

function writeCachedAutoSeat(branchId: string, value: boolean): void {
  try {
    localStorage.setItem(cacheKey(branchId), value ? "1" : "0");
  } catch {
    /* private mode / storage disabled — the caller still gets the live value */
  }
}

/**
 * Read the branch's auto-seat setting from the canonical POS settings row and cache
 * it. On ANY failure (offline, RLS, missing row) returns the last synchronized cached
 * value, and OFF if none — never throws, never blocks opening a table.
 */
export async function loadAutoSeatDirectOpen(
  tenantId: string | null | undefined,
  branchId: string | null | undefined,
): Promise<boolean> {
  if (!tenantId || !branchId) return false;
  try {
    const { supabase } = await import("@/lib/supabase");
    // database.types.ts predates this column (same reason rpc.ts casts the client).
    const client = supabase as unknown as {
      from(table: string): {
        select(cols: string): {
          eq(col: string, val: unknown): {
            eq(col: string, val: unknown): {
              maybeSingle(): PromiseLike<{ data: unknown; error: { message: string } | null }>;
            };
          };
        };
      };
    };
    const { data, error } = await client
      .from("pos_receipt_settings")
      .select("auto_seat_direct_open")
      .eq("tenant_id", tenantId)
      .eq("branch_id", branchId)
      .maybeSingle();
    if (error) return readCachedAutoSeat(branchId);
    const value = data ? bool((data as Record<string, unknown>).auto_seat_direct_open) : false;
    writeCachedAutoSeat(branchId, value);
    return value;
  } catch {
    return readCachedAutoSeat(branchId);
  }
}
