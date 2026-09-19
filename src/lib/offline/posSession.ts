// Durable "last-known-valid POS session" snapshot.
//
// The problem this solves: on a cold start with no connectivity the tenant,
// membership and permissions come back from the session cache, but the BRANCH
// NAME and the OPEN SHIFT are read live from the server (branches / pos_shifts).
// Offline that read fails, so a cashier who had a validated open shift before an
// outage returns to "Branch unavailable / No open shift" and cannot take the
// cash sales this whole offline capability exists to keep alive.
//
// This snapshot records the branch name and the open shift EXACTLY as the server
// last confirmed them, so an offline restart can restore the SAME operating
// context - and only that context. It is:
//   * written ONLY from authoritative online state (source: "server"),
//   * restored ONLY for the same device + tenant + cashier that saved it,
//   * never a substitute for the server: the moment the backend is reachable the
//     shift store re-reads pos_shifts and the snapshot is reconciled to truth
//     (a shift closed during the outage disappears, and any queued sale that
//     referenced it fails replay into needs_attention rather than reopening it).
//
// It never invents a shift, never widens a branch, and never carries another
// user's or tenant's context - identity is checked on every restore. This is a
// pure module (localStorage + logic only, no network, no supabase import), so it
// is exercised directly by the unit tests.

const KEY = "breadee-desktop-pos-session";
// Match the context cache: a week offline, then a fresh online login is required.
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type PosSessionSnapshotShift = {
  id: string;
  status: "open";
  opened_at: string | null;
  opening_cash_amount: number;
  branch_id: string | null;
};

export type PosSessionSnapshot = {
  version: 1;
  /** Provenance guard: only ever server-confirmed state is persisted. */
  source: "server";
  savedAt: number;
  device_id: string;
  tenant_id: string;
  cashier_user_id: string;
  branch_id: string | null;
  branch_name: string;
  /** Primary currency code, for display only. POS math never reads this. */
  currency: string;
  shift: PosSessionSnapshotShift;
};

export type SnapshotIdentity = {
  deviceId: string;
  tenantId: string | null;
  cashierUserId: string | null;
};

// A label that means "we could not resolve a branch" must never be persisted as
// if it were a real name, or it would come back as a fake label after a restart.
const NON_BRANCH_NAMES = new Set(["Branch unavailable", "No branch", "Unnamed branch"]);

/** True when `name` is a real, restorable branch label (not a fallback placeholder). */
export function isPersistableBranchName(name: string | null | undefined): boolean {
  return typeof name === "string" && name.trim() !== "" && !NON_BRANCH_NAMES.has(name.trim());
}

/**
 * Persist a snapshot. Refuses anything that is not a KNOWN-GOOD context: an
 * unresolved branch, a non-open shift, or a missing identity are all worse than
 * no snapshot at all, because a restart would restore a fiction.
 */
export function savePosSessionSnapshot(s: PosSessionSnapshot): void {
  if (s.version !== 1 || s.source !== "server") return;
  if (!s.branch_id || !isPersistableBranchName(s.branch_name)) return;
  if (!s.shift || s.shift.status !== "open" || !s.shift.id) return;
  if (!s.tenant_id || !s.cashier_user_id || !s.device_id) return;
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage full/unavailable: the online path still works, offline just won't restore */
  }
}

/** Read the snapshot, or null when absent, malformed, expired, or not a server-open shift. */
export function readPosSessionSnapshot(): PosSessionSnapshot | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as PosSessionSnapshot;
    if (!s || s.version !== 1 || s.source !== "server") return null;
    if (typeof s.savedAt !== "number" || Date.now() - s.savedAt >= TTL_MS) return null;
    if (!s.shift || s.shift.status !== "open" || !s.shift.id) return null;
    if (!s.tenant_id || !s.cashier_user_id || !s.device_id) return null;
    return s;
  } catch {
    return null;
  }
}

export function clearPosSessionSnapshot(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Identity gate. A snapshot is only ever restored for the SAME physical terminal,
 * tenant and cashier that saved it - never another context's session.
 */
export function snapshotMatchesIdentity(s: PosSessionSnapshot, id: SnapshotIdentity): boolean {
  return (
    !!id.tenantId &&
    !!id.cashierUserId &&
    s.device_id === id.deviceId &&
    s.tenant_id === id.tenantId &&
    s.cashier_user_id === id.cashierUserId
  );
}

/**
 * The open shift to restore offline, or null when nothing valid applies. Pure.
 * Restores the SAME shift id the server last confirmed; never fabricates one.
 */
export function restoreShiftFromSnapshot(
  s: PosSessionSnapshot | null,
  id: SnapshotIdentity,
): PosSessionSnapshotShift | null {
  if (!s) return null;
  if (!snapshotMatchesIdentity(s, id)) return null;
  if (s.shift.status !== "open" || !s.shift.id) return null;
  return s.shift;
}

/**
 * The branch NAME to show offline for an already-resolved branch id, or null to
 * fall back to "Branch unavailable". Pure and cosmetic - the branch id is the
 * authority and is resolved separately from the session cache, so this only
 * spares the cashier a placeholder label for a branch they validly operate in.
 * A foreign, absent, or mismatched snapshot yields null (the honest fallback).
 */
export function restoreBranchNameFromSnapshot(
  s: PosSessionSnapshot | null,
  args: { branchId: string | null; tenantId: string | null; deviceId: string },
): string | null {
  if (!s || !args.branchId) return null;
  if (s.device_id !== args.deviceId) return null;
  if (!args.tenantId || s.tenant_id !== args.tenantId) return null;
  if (s.branch_id !== args.branchId) return null;
  return isPersistableBranchName(s.branch_name) ? s.branch_name : null;
}
