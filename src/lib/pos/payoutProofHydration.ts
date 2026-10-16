// Phase D (D4) — ONLINE write-through of payout-source proofs.
//
// An offline cash payout is only allowed against an economic source (expense / purchase invoice /
// supplier payment / maintenance job) whose proof was cached while ONLINE. This is the producer
// side: when connected, it reads the authoritative candidate sources (exactly what the online
// picker reads, via loadPayoutSources — tenant+OU scoped, under RLS) and writes them into the
// local proof cache as a REPLACE-SET per type, so a later offline payout can prove the source
// existed and was valid. It runs ONLY online and is best-effort — a failure never blocks the UI;
// it just means payouts stay online-only (fail-closed). The server re-validates the source under
// its row lock on replay, so a source deleted/voided since hydration is caught as a conflict,
// never a blind cash-out.

import { loadPayoutSources, PAYOUT_SOURCE_TYPES, type PayoutSourceType } from "@/lib/pos/payouts";
import { cachePayoutSourceProofs, type PayoutProofScope } from "@/lib/offline/db";

/**
 * Write through payout-source proofs for every source type, for this scope. Online-only,
 * best-effort. Returns the total number of sources cached across all types. Safe to call whenever
 * connected (e.g. when the Payouts surface opens) — each type is an idempotent replace-set, so a
 * source removed upstream is evicted and a new one appears.
 */
export async function hydratePayoutSourceProofs(scope: PayoutProofScope): Promise<number> {
  if (!scope.tenantId) return 0;
  let cached = 0;
  for (const t of PAYOUT_SOURCE_TYPES) {
    try {
      const sources = await loadPayoutSources(scope.tenantId, scope.branchId, t.type as PayoutSourceType);
      await cachePayoutSourceProofs(scope, t.type, sources);
      cached += sources.length;
    } catch {
      // Best-effort: a failed type just leaves that type online-only; never blocks the others.
    }
  }
  return cached;
}
