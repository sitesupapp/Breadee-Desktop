// Delivery REPORT offline continuity (rc.7).
//
// The desktop NEVER recomputes report metrics (that stays the server's / the Reporting Engine's job).
// This is a READ-ONLY snapshot adapter: ONLINE it calls the production loadDeliveryReport authority and
// write-throughs the EXACT response for the (branch, range); OFFLINE it serves the last synced snapshot
// read-only (clearly labelled "last synced"), or reports a controlled connection-required state. It
// NEVER fabricates zero totals and NEVER lets the live RPC hang the UI into an indefinite skeleton
// (the reachability probe settles within its own timeout).

import { isBackendReachable } from "@/lib/offline/reachability";
import { cacheDeliveryReport, readCachedDeliveryReport } from "@/lib/offline/db";
import { loadDeliveryReport, type DeliveryReport } from "@/lib/pos/deliveryOrderManagement";

export type DeliveryReportLoad = { report: DeliveryReport | null; offline: boolean; cachedAt: string | null };

async function resolveTenantId(): Promise<string | null> {
  try {
    const { useSession } = await import("@/state/session");
    return useSession.getState().tenant?.id ?? null;
  } catch {
    return null;
  }
}

/** Injectable seams (tests only). */
export type DeliveryReportDeps = {
  reachable?: () => Promise<boolean>;
  load?: (input: { from: string; to: string; branch: string | null }) => Promise<DeliveryReport>;
  tenantId?: () => Promise<string | null>;
};

export async function loadDeliveryReportOfflineAware(
  input: { from: string; to: string; branch: string | null },
  deps: DeliveryReportDeps = {},
): Promise<DeliveryReportLoad> {
  const reachable = deps.reachable ?? isBackendReachable;
  const load = deps.load ?? loadDeliveryReport;
  const tenantId = deps.tenantId ?? resolveTenantId;
  const t = await tenantId();
  if (await reachable()) {
    const report = await load(input);
    await cacheDeliveryReport(report, t, input.branch, input.from, input.to).catch(() => {});
    return { report, offline: false, cachedAt: null };
  }
  const cached = await readCachedDeliveryReport(t, input.branch, input.from, input.to).catch(() => null);
  if (cached) return { report: cached.report as DeliveryReport, offline: true, cachedAt: cached.cachedAt };
  return { report: null, offline: true, cachedAt: null };
}
