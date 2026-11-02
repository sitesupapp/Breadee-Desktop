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
  /**
   * The branch/OU the restore is for. A Case-1 snapshot is restored ONLY when its
   * branch matches exactly, so a snapshot saved in a sibling branch/OU (same device,
   * tenant and cashier) can never surface as this branch's active shift. Callers must
   * pass the resolved branch explicitly rather than relying on the default.
   */
  branchId?: string | null;
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
    // Offline-first recovery — ONE snapshot PER CASHIER: through 1.0.38 a single key meant the next
    // user's shift overwrote the previous user's, so switching back offline lost their open shift.
    localStorage.setItem(cashierKey(s.cashier_user_id), JSON.stringify(s));
    writeIndex([...readIndex(), s.cashier_user_id]);
    // 1.0.42 (DESK-O3) — and ONE PER CASHIER PER BRANCH/OU: the cashier slot holds only the LAST branch saved,
    // so a cashier with open shifts in two OUs who switched OU offline found "No open shift" in the other one.
    localStorage.setItem(branchKey(s.cashier_user_id, s.branch_id), JSON.stringify(s));
    writeIndex([...readIndex(BRANCH_INDEX_KEY), branchKey(s.cashier_user_id, s.branch_id)], BRANCH_INDEX_KEY);
    const legacy = parseSnapshot(localStorage.getItem(KEY));
    if (legacy && legacy.cashier_user_id === s.cashier_user_id) localStorage.removeItem(KEY);
  } catch {
    /* storage full/unavailable: the online path still works, offline just won't restore */
  }
}

const cashierKey = (cashierUserId: string) => `${KEY}:${cashierUserId}`;
const branchKey = (cashierUserId: string, branchId: string) => `${KEY}:${cashierUserId}@${branchId}`;

function parseSnapshot(raw: string | null): PosSessionSnapshot | null {
  try {
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

// The cashiers holding a snapshot on this device: an explicit index (no Storage enumeration needed).
const INDEX_KEY = `${KEY}.cashiers`;
// 1.0.42 (DESK-O3) — the per-branch slots on this device (their full storage keys).
const BRANCH_INDEX_KEY = `${KEY}.branches`;

function readIndex(indexKey = INDEX_KEY): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(indexKey) ?? "[]") as unknown;
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string" && x !== "") : [];
  } catch {
    return [];
  }
}

function writeIndex(list: string[], indexKey = INDEX_KEY): void {
  try {
    if (list.length === 0) localStorage.removeItem(indexKey);
    else localStorage.setItem(indexKey, JSON.stringify([...new Set(list)]));
  } catch {
    /* unavailable */
  }
}

function removeBranchSlots(keys: string[]): void {
  for (const k of keys) localStorage.removeItem(k);
  writeIndex(readIndex(BRANCH_INDEX_KEY).filter((k) => !keys.includes(k)), BRANCH_INDEX_KEY);
}

/** Every snapshot key on this device: each indexed cashier's, plus a pre-recovery single-key snapshot. */
function snapshotKeys(): string[] {
  return [KEY, ...readIndex().map(cashierKey)];
}

/**
 * Read the snapshot, or null when absent, malformed, expired, or not a server-open shift. With a
 * cashier: THAT cashier's snapshot (incl. a pre-recovery single-key snapshot of theirs). Without one:
 * the most recent of all. 1.0.42 (DESK-O3) — with a cashier AND a branch: THAT branch's snapshot only (its own
 * slot, else the cashier slot / single-key snapshot when they hold that branch).
 */
export function readPosSessionSnapshot(cashierUserId?: string | null, branchId?: string | null): PosSessionSnapshot | null {
  try {
    if (cashierUserId) {
      if (branchId) {
        const forBranch = parseSnapshot(localStorage.getItem(branchKey(cashierUserId, branchId)));
        if (forBranch && forBranch.cashier_user_id === cashierUserId && forBranch.branch_id === branchId) return forBranch;
      }
      const inBranch = (s: PosSessionSnapshot | null) => (s && (!branchId || (s.branch_id ?? null) === branchId) ? s : null);
      const own = parseSnapshot(localStorage.getItem(cashierKey(cashierUserId)));
      if (own) return inBranch(own);
      const legacy = parseSnapshot(localStorage.getItem(KEY));
      return inBranch(legacy && legacy.cashier_user_id === cashierUserId ? legacy : null);
    }
    // No cashier: a single-key snapshot (only older builds write it) is the latest single-slot write;
    // otherwise the most recently saved per-cashier snapshot.
    const legacyRaw = localStorage.getItem(KEY);
    if (legacyRaw !== null) return parseSnapshot(legacyRaw);
    return readAllPosSessionSnapshots().sort((a, b) => b.savedAt - a.savedAt)[0] ?? null;
  } catch {
    return null;
  }
}

/** Every valid snapshot on this device (one per cashier). 1.0.42 — `perBranch` adds the per-branch slots (a
 *  snapshot then appears once per slot holding it). */
export function readAllPosSessionSnapshots(opts: { perBranch?: boolean } = {}): PosSessionSnapshot[] {
  const out: PosSessionSnapshot[] = [];
  try {
    for (const k of opts.perBranch ? [...snapshotKeys(), ...readIndex(BRANCH_INDEX_KEY)] : snapshotKeys()) {
      const s = parseSnapshot(localStorage.getItem(k));
      if (s) out.push(s);
    }
  } catch {
    /* unavailable */
  }
  return out;
}

/** Clear one cashier's snapshot, or (no argument) every snapshot on the device. 1.0.42 (DESK-O3) — with a
 *  branch: only that branch of that cashier (its own slot, and the cashier slot / single-key snapshot only while
 *  they hold that branch), so another branch's open shift stays restorable offline. */
export function clearPosSessionSnapshot(cashierUserId?: string | null, branchId?: string | null): void {
  try {
    if (cashierUserId && branchId) {
      removeBranchSlots([branchKey(cashierUserId, branchId)]);
      const holdsBranch = (raw: string | null): boolean => {
        if (raw === null) return false;
        try {
          const s = JSON.parse(raw) as { cashier_user_id?: string; branch_id?: string | null };
          return (s.cashier_user_id ?? cashierUserId) === cashierUserId && (s.branch_id ?? null) === branchId;
        } catch {
          return true; // unreadable: never restorable anyway
        }
      };
      if (holdsBranch(localStorage.getItem(cashierKey(cashierUserId)))) {
        localStorage.removeItem(cashierKey(cashierUserId));
        writeIndex(readIndex().filter((c) => c !== cashierUserId));
      }
      if (holdsBranch(localStorage.getItem(KEY))) localStorage.removeItem(KEY);
      return;
    }
    if (cashierUserId) {
      localStorage.removeItem(cashierKey(cashierUserId));
      writeIndex(readIndex().filter((c) => c !== cashierUserId));
      removeBranchSlots(readIndex(BRANCH_INDEX_KEY).filter((k) => k.startsWith(`${cashierKey(cashierUserId)}@`)));
      const raw = localStorage.getItem(KEY);
      let legacyOwner: string | null = null;
      try {
        legacyOwner = raw ? ((JSON.parse(raw) as { cashier_user_id?: string }).cashier_user_id ?? null) : null;
      } catch {
        legacyOwner = null;
      }
      if (raw !== null && (legacyOwner === null || legacyOwner === cashierUserId)) localStorage.removeItem(KEY);
      return;
    }
    for (const k of [...snapshotKeys(), ...readIndex(BRANCH_INDEX_KEY)]) localStorage.removeItem(k);
    writeIndex([]);
    writeIndex([], BRANCH_INDEX_KEY);
  } catch {
    /* ignore */
  }
}

/** 1.0.42 — clear every slot (cashier, per-branch, single-key) holding this shift: it was closed. */
export function clearPosSessionSnapshotsForShift(shiftId: string): void {
  for (const s of readAllPosSessionSnapshots({ perBranch: true })) if (s.shift.id === shiftId) clearPosSessionSnapshot(s.cashier_user_id, s.branch_id);
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
    s.cashier_user_id === id.cashierUserId &&
    // Exact branch/OU equality: a snapshot from another branch is never this
    // context's shift, even on the same device/tenant/cashier.
    (s.branch_id ?? null) === (id.branchId ?? null)
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
