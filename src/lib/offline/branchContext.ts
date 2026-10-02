// Durable, shift-INDEPENDENT branch-context cache.
//
// WHY THIS EXISTS: the branch *id* an offline session operates in is always
// resolvable (`resolveBranchId` is pure and reads the durable context cache), but
// the branch *NAME* was only ever cached as a side effect of the open-shift
// POS-session snapshot (`posSession.ts`). So a device that reaches a backend outage
// WITHOUT a previously-hydrated open shift - first use of the day, or a shift opened
// only after going offline - resolved the branch id yet showed "Branch unavailable",
// because the only cache that held the name required an open shift.
//
// This cache fixes exactly that gap: whenever the branch name is resolved from the
// server (online), it is stored here keyed by device+tenant+branch, so an offline
// start can name the branch regardless of shift state. It is:
//   * written ONLY from authoritative online state (a real, persistable name),
//   * restored ONLY for the same device + tenant + branch that saved it,
//   * cosmetic: the branch id remains the authority and is resolved elsewhere, so a
//     foreign, absent or mismatched entry can never widen, rename or invent access.
// Pure module (localStorage + logic only, no network, no supabase import).

import { isPersistableBranchName } from "@/lib/offline/posSession";

const KEY = "breadee-desktop-branch-context";
// Match the session + POS-session caches: a week offline, then an online refresh.
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type BranchContextEntry = {
  branch_id: string;
  branch_name: string;
  /** Primary currency code, for display only. POS math never reads this. */
  currency: string;
  savedAt: number;
};

export type BranchContextCache = {
  version: 1;
  /** Provenance guard: only ever server-confirmed names are persisted. */
  source: "server";
  device_id: string;
  tenant_id: string;
  /** One entry per branch this device has validly operated in (supports OU switching). */
  entries: BranchContextEntry[];
};

export type BranchContextIdentity = {
  deviceId: string;
  tenantId: string | null;
  branchId: string | null;
};

function read(): BranchContextCache | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as BranchContextCache;
    if (!c || c.version !== 1 || c.source !== "server") return null;
    if (!c.device_id || !c.tenant_id || !Array.isArray(c.entries)) return null;
    return c;
  } catch {
    return null;
  }
}

/**
 * Persist the server-confirmed NAME for an already-resolved branch id. Refuses a
 * placeholder name (anything `isPersistableBranchName` rejects) or a missing
 * identity - a cache that restored a fiction would be worse than none. A write for a
 * different device/tenant replaces the cache wholesale (a terminal only ever serves
 * one tenant at a time); within the same scope it upserts by branch id.
 */
export function saveBranchContext(args: {
  deviceId: string;
  tenantId: string | null;
  branchId: string | null;
  branchName: string;
  currency: string;
}): void {
  if (!args.deviceId || !args.tenantId || !args.branchId) return;
  if (!isPersistableBranchName(args.branchName)) return;
  const entry: BranchContextEntry = {
    branch_id: args.branchId,
    branch_name: args.branchName.trim(),
    currency: args.currency,
    savedAt: Date.now(),
  };
  const existing = read();
  const base: BranchContextCache =
    existing && existing.device_id === args.deviceId && existing.tenant_id === args.tenantId
      ? existing
      : { version: 1, source: "server", device_id: args.deviceId, tenant_id: args.tenantId, entries: [] };
  const entries = base.entries.filter((e) => e.branch_id !== args.branchId);
  entries.push(entry);
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...base, entries }));
  } catch {
    /* storage full/unavailable: the online path still works, offline just won't name the branch */
  }
}

/**
 * The server-confirmed branch NAME to show offline for an already-resolved branch
 * id, or null to fall back to a placeholder. Pure and cosmetic. Identity-gated
 * (device + tenant + branch) and TTL-bounded; a foreign, absent, expired or
 * placeholder entry yields null.
 */
export function restoreBranchName(id: BranchContextIdentity): string | null {
  if (!id.branchId || !id.tenantId) return null;
  const c = read();
  if (!c) return null;
  if (c.device_id !== id.deviceId || c.tenant_id !== id.tenantId) return null;
  const entry = c.entries.find((e) => e.branch_id === id.branchId);
  if (!entry) return null;
  if (typeof entry.savedAt !== "number" || Date.now() - entry.savedAt >= TTL_MS) return null;
  return isPersistableBranchName(entry.branch_name) ? entry.branch_name : null;
}

/** Sign-out cleanup: drop the whole branch-context cache for this terminal. */
export function clearBranchContext(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
