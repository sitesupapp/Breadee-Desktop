// 1.0.41 (Server Off F-READY) — is this terminal ready to keep trading if Breadee's server goes off, and until when?
//
// A small, non-intrusive header indicator. It answers three questions a manager needs BEFORE an outage, not
// during one:
//   - offline access: the device's signed offline entitlement is valid, and how long it still lasts (offline
//     captures stop when it expires — captureLock "entitlement_expired");
//   - storage: the local store opens and reads (integrity), it is persistent, and the disk is not nearly full;
//   - the ONE health truth (reachability.getBackendHealth) for the connectivity label beside it.
// Read-only. It never refreshes an entitlement, writes, or changes what the POS allows.

import type { StorageStatus, IntegrityResult } from "@/lib/offline/durability";

export const READINESS_WARN_MS = 24 * 3_600_000;

export type ReadinessInput = {
  /** False on a build where offline entitlements are not enforced (e.g. a dev build): nothing to expire. */
  enforced: boolean;
  /** The stored entitlement verified OK for this user / tenant on this device (null = could not check). */
  entitlementOk: boolean | null;
  remainingMs: number | null;
  storage: StorageStatus | null;
  integrity: IntegrityResult | null;
};

export type Readiness = { tone: "slate" | "amber" | "red"; text: string; detail: string };

function span(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  if (h >= 48) return `${Math.floor(h / 24)} days`;
  if (h >= 1) return `${h} h`;
  return `${Math.max(1, Math.floor(ms / 60_000))} min`;
}

/** PURE — the indicator for one set of facts. The worst fact wins. */
export function readinessOf(i: ReadinessInput): Readiness {
  if (i.integrity && !i.integrity.ok) {
    return {
      tone: "red",
      text: "Local data problem",
      detail: `This terminal could not read its own saved data (${i.integrity.detail}). Do not clear the app's data — copy diagnostics and call support.`,
    };
  }
  if (i.enforced && i.entitlementOk === false) {
    return {
      tone: "red",
      text: "Not ready for offline",
      detail: "This terminal has no valid offline access for the signed-in user. Stay connected and sign in again so it can take sales if Breadee's server goes off.",
    };
  }
  if (i.storage?.lowSpace) {
    return {
      tone: "amber",
      text: "Low disk space",
      detail: "This computer is nearly out of disk space. Offline sales need room to be saved — free some space.",
    };
  }
  if (i.enforced && i.remainingMs != null && i.remainingMs <= READINESS_WARN_MS) {
    return {
      tone: "amber",
      text: i.remainingMs <= 0 ? "Offline access expired" : `Offline access ends in ${span(i.remainingMs)}`,
      detail: "Connect to Breadee while signed in to renew offline access; offline sales stop when it ends.",
    };
  }
  const persisted = i.storage?.persisted === true ? " Saved data is kept even under disk pressure." : "";
  if (!i.enforced) return { tone: "slate", text: "Offline ready", detail: `This terminal can keep recording cash sales if Breadee's server goes off.${persisted}` };
  return {
    tone: "slate",
    text: i.remainingMs != null ? `Offline ready · ${span(i.remainingMs)}` : "Offline ready",
    detail: `This terminal can keep recording cash sales if Breadee's server goes off${i.remainingMs != null ? `, for ${span(i.remainingMs)} without reconnecting` : ""}.${persisted}`,
  };
}

/** Load the facts for the signed-in user on this device. Never throws. */
export async function loadReadiness(ids: { userId: string | null; tenantId: string | null; branchId?: string | null }): Promise<Readiness> {
  const [{ entitlementEnforced, verifyStoredEntitlement, observeDeviceClock }, { entitlementRemainingMs }, { storageStatus, checkLocalStoreIntegrity }] = await Promise.all([
    import("@/lib/security/deviceAuthority"),
    import("@/lib/security/entitlement"),
    import("@/lib/offline/durability"),
  ]);
  let enforced = false;
  let ok: boolean | null = null;
  let remaining: number | null = null;
  try {
    enforced = entitlementEnforced();
    if (enforced && ids.userId) {
      const clock = await observeDeviceClock();
      const check = await verifyStoredEntitlement(ids, clock);
      ok = check.ok;
      remaining = check.ok ? entitlementRemainingMs(check.claims, clock.effectiveNowMs) : null;
    }
  } catch {
    ok = null;
  }
  const [storage, integrity] = await Promise.all([storageStatus().catch(() => null), checkLocalStoreIntegrity().catch(() => null)]);
  const r = readinessOf({ enforced, entitlementOk: ok, remainingMs: remaining, storage, integrity });
  // 1.0.41 (F-OWN) — say, before any outage, whether this terminal has Server Off tables assigned (tooltip only:
  // a takeaway-only site needs none).
  if (ids.branchId !== undefined) {
    const { readServerOffAssignment, assignmentReadinessNote } = await import("@/lib/offline/tableOwnership");
    const note = assignmentReadinessNote(readServerOffAssignment(ids.tenantId, ids.branchId ?? null));
    if (note) return { ...r, detail: `${r.detail} ${note}` };
  }
  return r;
}
