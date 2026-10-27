import { create } from "zustand";
import { supabase } from "@/lib/supabase";
import { getDeviceIdentity } from "@/lib/device";
import { purgeForeignSnapshots, clearSnapshotCache, purgeForeignCachedCustomers, clearCachedCustomers, localdb } from "@/lib/offline/db";
import { localEntityIdsNeededByUnsettledOps } from "@/lib/offline/operationLog";

/**
 * 1.0.38 — drop cached customers (sign-out privacy / foreign-scope purge) EXCEPT the offline-created
 * (pending-local) customers that unsettled offline work still needs: the customer create that has not
 * synced yet and the orders/payments chained to it. Through 1.0.37 sign-out cleared them all, so after
 * a re-login the picker lost the customer while its order still waited to replay. Their personal data
 * already lives in that unsettled op's payload (which is never dropped), so nothing new is retained.
 * `foreignOnly` limits the drop to rows outside the given tenant/branch (the login purge).
 */
async function dropCachedCustomersKeepingUnsettled(foreignOnly?: { tenantId: string | null; branchId: string | null }): Promise<void> {
  const keep = await localEntityIdsNeededByUnsettledOps().catch(() => new Set<string>());
  if (keep.size === 0) {
    if (foreignOnly) await purgeForeignCachedCustomers(foreignOnly.tenantId, foreignOnly.branchId);
    else await clearCachedCustomers();
    return;
  }
  const rows = await localdb.posCustomers.toArray();
  const drop = rows.filter((c) => {
    if (c.pending_local === true && keep.has(c.id)) return false;
    if (!foreignOnly) return true;
    return c.tenant_id !== foreignOnly.tenantId || (foreignOnly.branchId != null && (c.branch_id ?? null) !== foreignOnly.branchId);
  });
  await localdb.posCustomers.bulkDelete(drop.map((c) => c.id));
}
/**
 * Offline-first recovery — on an online sign-in, drop cached POS data (snapshots + customers) of
 * tenants that NO saved user of this device belongs to. Through 1.0.38 the purge was branch-scoped
 * for the single remembered user, which deleted the data a second saved cashier of the same business
 * needs offline. Reads stay tenant + branch keyed and the branch picker is bounded by each user's own
 * authority, so a user never sees another branch's cache. Offline-created customers still needed by
 * unsettled work are kept, as before.
 */
async function purgeTenantsWithoutSavedUsers(currentTenantId: string | null): Promise<void> {
  const keepTenants = await vault.vaultTenantIds().catch(() => new Set<string>());
  if (currentTenantId) keepTenants.add(currentTenantId);
  const snaps = await localdb.snapshots.toArray();
  // The authority mirror is owned by offlineAuthority (rewritten right after this purge).
  const foreignSnaps = snaps.filter((x) => x.key !== "auth.context" && !keepTenants.has(x.tenant_id));
  if (foreignSnaps.length > 0) await localdb.snapshots.bulkDelete(foreignSnaps.map((x) => x.key));
  const keep = await localEntityIdsNeededByUnsettledOps().catch(() => new Set<string>());
  const customers = await localdb.posCustomers.toArray();
  const foreignCustomers = customers.filter((c) => !keepTenants.has(c.tenant_id) && !(c.pending_local === true && keep.has(c.id)));
  if (foreignCustomers.length > 0) await localdb.posCustomers.bulkDelete(foreignCustomers.map((c) => c.id));
}
import { clearPosSessionSnapshot } from "@/lib/offline/posSession";
import { clearBranchContext } from "@/lib/offline/branchContext";
import type { Membership, Tenant, TenantStatus } from "@/lib/types";
import type { FeatureMap } from "@/lib/features";
import { isCurrencyCode, type CurrencyCode } from "@/lib/currency";
import { isBackendReachable, lastKnownReachable } from "@/lib/offline/reachability";
import { AUTH_STORAGE_KEY, sealedAuthStorage } from "@/lib/security/sealedAuthStorage";
import * as vault from "@/lib/security/offlineVault";
import { markStart, recordSince } from "@/lib/perf/timings";
import { applyCaptureLock, type CaptureLockReason } from "@/lib/security/captureLock";
import { setEntitledBranchScope } from "@/state/operationalBranch";
import { overlayAuthorityWithEntitlement } from "@/lib/security/entitlement";
import {
  checkDeviceStanding,
  clearEntitlement,
  entitlementEnforced,
  entitlementRefreshDue,
  installEntitlementSlot,
  observeDeviceClock,
  readEntitlementSlot,
  refreshEntitlement,
  resetClockAfterOnlineAuth,
  verifyStoredEntitlement,
  type DeviceClock,
} from "@/lib/security/deviceAuthority";
import {
  OFFLINE_SIGNIN_MESSAGE,
  REAUTH_MESSAGE,
  clearAuthorityCache,
  decideOfflineAuthority,
  isAuthInvalidation,
  isAuthTransportError,
  readAuthorityCache,
  writeAuthorityCache,
  type AuthorityCache,
  type OfflineAuthDecision,
} from "@/lib/offline/offlineAuthority";

// Read-only tenant currency settings for display (dual USD/LBP). Never used for POS math.
export type CurrencySettings = { primary: CurrencyCode; rate: number | null };
const DEFAULT_CURRENCY: CurrencySettings = { primary: "USD", rate: null };

// Mirrors the web app's SessionContext + resolvePostLoginPath, plus an offline cache
// so the app can restore the last valid role/tenant/branch/permissions after a first
// successful online login. The cache is non-sensitive (ids + role + permission flags).

// rc.10 — the offline authority (key, 7-day TTL, durable mirror, decision) lives in
// lib/offline/offlineAuthority; this store only applies it.

// De-dupes concurrent in-session permission refreshes: window "focus" and "online"
// can fire together, and we never want two overlapping RPC round-trips for the same thing.
let permissionRefreshInFlight: Promise<void> | null = null;

// ---- Final Foundation (SEC): device-bound offline authority ---------------------------
// `grantedPermissions` is the UNLOCKED map (server / signed entitlement). The store's
// `permissions` is the view the UI gates on: identical, unless a CAPTURE LOCK is active,
// in which case lib/security/captureLock keeps only read-only grants. Nothing here ever
// deletes or rewrites an operation, shift, draft or history entry.
let grantedPermissions: Record<string, boolean> = {};
/** A revocation learned from the server on reconnect (sticky until the server says ok). */
let standingLock: CaptureLockReason | null = null;
let securityStarted = false;
/** OU list of the entitlement verified for the current offline restore (null otherwise). */
let restoredEntitledBranchIds: string[] | null = null;
export const SECURITY_TICK_MS = 60_000;

/** Offline-first recovery — the password of a LOCAL sign-in whose user had NO parked session (so the
 *  server cannot be reached with a token), held in memory ONLY until the first online revalidation of
 *  that user, never persisted, dropped on switch / sign-out / definitive refusal. */
let pendingSecret: { userId: string; email: string; password: string } | null = null;
let revalidating: Promise<void> | null = null;

export const FIRST_SIGNIN_MESSAGE = "FIRST SECURE SIGN-IN REQUIRES AN INTERNET CONNECTION. This user has not signed in online on this device yet.";
export const WRONG_PASSWORD_MESSAGE = "Incorrect password.";
/** 1.0.38 — a saved user whose signed offline access never reached this device (an older build, or the app
 *  closed during the very first online sign-in): honest, and only the server can fix it. */
export const OFFLINE_ACCESS_MISSING_MESSAGE =
  "Offline sign-in isn't set up for this user on this device yet. Sign in once with an internet connection.";

/** The server refused this identity (revoked / deleted / banned / password changed): stop NEW captures
 *  and stop future OFFLINE sign-ins for it. Recorded work is untouched and still syncs if accepted. */
async function markReauthRequired(userId: string): Promise<void> {
  pendingSecret = null;
  await vault.invalidateVaultUser(userId).catch(() => undefined);
  if (useSession.getState().userId !== userId) return;
  standingLock = "reauth_required";
  setCaptureLock("reauth_required");
}

/**
 * Offline-first recovery — NETWORK REVALIDATION of the active (locally authorized) user. Runs in the
 * background after a local sign-in / cold-start restore and on reconnect; never on the interaction
 * path. Reachable: adopt the live session (or, for a user without a parked session, the in-memory
 * password once) and reload the server-authoritative context — which leaves offline mode. A transport
 * failure keeps the device offline; a definitive refusal locks new captures (markReauthRequired).
 */
export function revalidateActiveSession(): Promise<void> {
  if (revalidating) return revalidating;
  revalidating = (async () => {
    const s = useSession.getState();
    if (!s.userId) return;
    const userId = s.userId;
    if (!(await isBackendReachable().catch(() => false))) return;
    try {
      const r = await supabase.auth.getSession();
      let live = r.data.session;
      if (!live && r.error && !isAuthInvalidation(r.error)) return; // a flapping link: stay offline
      if (!live && pendingSecret && pendingSecret.userId === userId) {
        const r2 = await supabase.auth.signInWithPassword({ email: pendingSecret.email, password: pendingSecret.password });
        if (r2.error) {
          if (isAuthTransportError(r2.error)) return;
          await markReauthRequired(userId);
          return;
        }
        live = r2.data.session;
      }
      if (useSession.getState().userId !== userId) return; // switched meanwhile
      if (!live || live.user?.id !== userId) {
        await markReauthRequired(userId);
        return;
      }
      await useSession.getState().loadContextOnline();
      pendingSecret = null;
    } catch (e) {
      if (isAuthInvalidation(e)) await markReauthRequired(userId);
    }
  })().finally(() => {
    revalidating = null;
  });
  return revalidating;
}

/** Render a locally authorized user (cold-start restore or local sign-in): their verified authority,
 *  offline mode until the background revalidation reaches the server. */
function applyRestore(cache: AuthorityCache, clockRollback: boolean): void {
  const c = cache as unknown as CachedContext;
  grantedPermissions = c.permissions ?? {};
  useSession.setState({
    loading: false,
    offlineMode: true,
    online: false,
    authNotice: null,
    userId: c.userId,
    email: c.email,
    isPlatformUser: c.isPlatformUser,
    tenant: c.tenant,
    membership: c.membership,
    features: c.features,
    permissions: c.permissions,
    currency: c.currency ?? DEFAULT_CURRENCY,
    entitledBranchIds: restoredEntitledBranchIds,
  });
  // A rolled-back clock locks NEW captures from the first frame (the tick re-evaluates).
  setCaptureLock(clockRollback ? "clock_rollback" : standingLock);
  void securityTick().catch(() => undefined);
  // 1.0.38 — the restored user's verified entitlement also becomes their own vault copy (background).
  void keepActiveEntitlementInVault(c.userId, c.tenant?.id ?? null).catch(() => undefined);
}

/**
 * Offline-first recovery — admit a SAVED user whose password matched their local verifier: install
 * their parked session + entitlement as the active slots, then require exactly what a cold-start
 * restore requires (7-day window at the guarded clock, and — where enforced — their verified,
 * device-bound signed entitlement, whose claims replace the cached role / OU / permissions). Returns
 * null on success, else the controlled message; a refused unlock leaves the device exactly as it was.
 */
async function activateLocalUser(u: vault.VaultUser, password: string): Promise<string | null> {
  const clock = await observeDeviceClock();
  const base = decideOfflineAuthority(u.context, clock.effectiveNowMs);
  if (base.kind !== "restore") return REAUTH_MESSAGE;
  const parked = await vault.unparkUser(u.userId);
  if (parked.session) await sealedAuthStorage.setItem(AUTH_STORAGE_KEY, parked.session).catch(() => undefined);
  else await sealedAuthStorage.removeItem(AUTH_STORAGE_KEY).catch(() => undefined);
  await installEntitlementSlot(parked.entitlement, parked.entitlementReceivedAtMs).catch(() => undefined);
  const decision = await gateOfflineRestore(base, clock);
  if (decision.kind !== "restore") {
    await vault.parkUser(u.userId, { session: parked.session, entitlement: parked.entitlement, entitlementReceivedAtMs: parked.entitlementReceivedAtMs }).catch(() => undefined);
    await sealedAuthStorage.removeItem(AUTH_STORAGE_KEY).catch(() => undefined);
    await installEntitlementSlot(null, null).catch(() => undefined);
    return parked.entitlement ? REAUTH_MESSAGE : OFFLINE_ACCESS_MISSING_MESSAGE;
  }
  // The active authority = this user's own snapshot (its 7-day anchor unchanged).
  await writeAuthorityCache(u.context);
  standingLock = null;
  pendingSecret = parked.session ? null : { userId: u.userId, email: u.email, password };
  applyRestore(decision.cache, clock.rollback);
  return null;
}

/** Reset every in-memory POS store that may hold the previous user's working state (cart, selected
 *  table / bill, customer, shift view, receipt). Durable work (op log, drafts) is never touched. */
async function resetUserScopedStores(): Promise<void> {
  const [cart, shift, shiftOrders, customers, tables, receipt, kitchen] = await Promise.all([
    import("@/state/cart"),
    import("@/state/shift"),
    import("@/state/shiftOrders"),
    import("@/state/customers"),
    import("@/state/tables"),
    import("@/state/receipt"),
    import("@/state/kitchenTicket"),
  ]);
  cart.useCart.getState().reset();
  shift.useShift.getState().clear();
  shiftOrders.useShiftOrders.getState().reset();
  customers.useCustomers.getState().reset();
  tables.useTables.getState().reset();
  receipt.useReceipt.getState().clear();
  kitchen.useKitchenTicket.getState().clear();
}

/** Offline restore needs a VERIFIED, device-bound, unexpired entitlement for the cached
 *  user + tenant; the restored role / OU / permissions / features come from its signed
 *  claims. Without one the device must re-authorize online (fresh devices and never-
 *  authorized users were already online-only). Non-enforced builds: unchanged. */
async function gateOfflineRestore(d: OfflineAuthDecision, clock: DeviceClock): Promise<OfflineAuthDecision> {
  restoredEntitledBranchIds = null;
  if (d.kind !== "restore" || !entitlementEnforced()) return d;
  const c = d.cache as unknown as CachedContext;
  const check = await verifyStoredEntitlement({ userId: c.userId, tenantId: c.tenant?.id ?? null }, clock).catch(() => null);
  if (!check || !check.ok) return { kind: "expired", cache: d.cache };
  restoredEntitledBranchIds = [...check.claims.branch_ids];
  return { kind: "restore", cache: overlayAuthorityWithEntitlement(c, check.claims) as unknown as AuthorityCache };
}

/** Apply (or lift) the capture lock over the granted permissions. */
function setCaptureLock(lock: CaptureLockReason | null): void {
  useSession.setState({ captureLock: lock, permissions: applyCaptureLock(grantedPermissions, lock) });
}

function backendLooksOffline(offlineMode: boolean): boolean {
  return offlineMode || (typeof navigator !== "undefined" && navigator.onLine === false) || lastKnownReachable() === false;
}

/** Online: obtain / renew the signed entitlement for this device (never blocks the UI). */
async function refreshEntitlementForSession(force = false): Promise<void> {
  const s = useSession.getState();
  if (!s.userId || !s.tenant?.id || s.offlineMode) return;
  const userId = s.userId;
  const r = await refreshEntitlement(
    { userId, tenantId: s.tenant.id, terminalId: getDeviceIdentity().terminal_id },
    {
      force,
      // 1.0.38 (native Bug 1/2) — the issuance is this user's OWN offline authority (vault), and becomes the
      // active slot only while they are still the active user (a late answer never lands on the next user).
      isActive: () => useSession.getState().userId === userId,
      onIssued: (jws, at) => vault.storeUserEntitlement(userId, jws, at),
    },
  );
  if (!r.ok && (r.reason === "device_revoked" || r.reason === "access_revoked")) {
    standingLock = r.reason;
    await clearEntitlement();
  }
}

/** Upper bound on how long a FIRST online sign-in waits for this device's offline access (entitlement). */
export const PROVISION_WAIT_MS = 10_000;

/**
 * 1.0.38 (native Bug 1/2) — make an ONLINE sign-in a complete OFFLINE PROVISIONING of this user on this
 * device. Through the first 1.0.38 build the signed entitlement was requested in the background AFTER the
 * sign-in returned (≈4–6 s on staging); closing the app or losing the link inside that window left a user
 * whose next offline sign-in could only answer "re-authorize". Now the sign-in waits (bounded) until the
 * user's entitlement is verified on the device — immediately when a valid one is already held.
 */
async function provisionOfflineAccess(userId: string, tenantId: string | null): Promise<void> {
  if (!entitlementEnforced()) return;
  const held = await verifyStoredEntitlement({ userId, tenantId }).catch(() => null);
  if (held?.ok) {
    await keepActiveEntitlementInVault(userId, tenantId);
    return;
  }
  await Promise.race([refreshEntitlementForSession(true).catch(() => undefined), new Promise((r) => setTimeout(r, PROVISION_WAIT_MS))]);
}

/** 1.0.38 — the ACTIVE slot holds a VERIFIED entitlement of this user that the vault does not have yet
 *  (an install upgraded from the first 1.0.38 build, or an issuance before this change): copy it. */
async function keepActiveEntitlementInVault(userId: string, tenantId: string | null): Promise<void> {
  const u = await vault.getVaultUser(userId).catch(() => null);
  if (!u) return;
  const slot = await readEntitlementSlot().catch(() => ({ jws: null, receivedAtMs: null }));
  if (!slot.jws || slot.jws === u.parkedEntitlement) return;
  const check = await verifyStoredEntitlement({ userId, tenantId }).catch(() => null);
  if (check?.ok) await vault.storeUserEntitlement(userId, slot.jws, slot.receivedAtMs ?? Date.now()).catch(() => undefined);
}

/**
 * The in-session check (every SECURITY_TICK_MS, on reconnect, after restore): clock
 * rollback, revocation, and - while the backend is unreachable - entitlement expiry. A
 * running offline session therefore expires on time, not only at cold start.
 */
export async function securityTick(): Promise<void> {
  let clock = await observeDeviceClock();
  const s = useSession.getState();
  if (!s.userId) return;
  const offline = backendLooksOffline(s.offlineMode);
  if (!offline && !standingLock) {
    if (entitlementEnforced()) {
      const check = await verifyStoredEntitlement({ userId: s.userId, tenantId: s.tenant?.id ?? null }, clock).catch(() => null);
      if (clock.rollback || !check || entitlementRefreshDue(check, clock.effectiveNowMs)) {
        await refreshEntitlementForSession().catch(() => undefined);
        clock = await observeDeviceClock();
      }
    } else if (clock.rollback && !s.offlineMode) {
      // No server clock in a non-enforced build: an online, server-validated session
      // is the re-authorization that resets the baseline.
      await resetClockAfterOnlineAuth().catch(() => undefined);
      clock = await observeDeviceClock();
    }
  }
  let lock: CaptureLockReason | null = null;
  if (clock.rollback) lock = "clock_rollback";
  else if (standingLock) lock = standingLock;
  else if (offline && entitlementEnforced()) {
    const check = await verifyStoredEntitlement({ userId: s.userId, tenantId: s.tenant?.id ?? null }, clock).catch(() => null);
    if (!check || !check.ok) lock = check?.reason === "expired" ? "entitlement_expired" : "entitlement_invalid";
  }
  if (lock !== useSession.getState().captureLock) setCaptureLock(lock);
}

/** Reconnect: check device / user standing with the server BEFORE trusting the
 *  offline authority again. A revoked device or user stops NEW captures; already-
 *  captured work keeps draining and the server decides (never deleted locally). */
export async function securityReconnect(): Promise<void> {
  if (!useSession.getState().userId) return;
  const standing = await checkDeviceStanding();
  if (standing === "device_revoked" || standing === "access_revoked") {
    standingLock = standing;
    await clearEntitlement();
  } else if ((standing === "ok" || standing === "unregistered") && standingLock !== "reauth_required") {
    // A reauth_required lock is lifted only by a successful online context load (loadContextOnline).
    standingLock = null;
  }
  await securityTick().catch(() => undefined);
}

function startSecurityLoop(): void {
  if (securityStarted || typeof window === "undefined") return;
  securityStarted = true;
  window.setInterval(() => void securityTick().catch(() => undefined), SECURITY_TICK_MS);
  window.addEventListener("online", () => void securityReconnect().catch(() => undefined));
}

type CachedContext = {
  userId: string;
  email: string | null;
  isPlatformUser: boolean;
  tenant: Tenant | null;
  membership: Membership | null;
  features: FeatureMap;
  permissions: Record<string, boolean>;
  currency: CurrencySettings;
  cachedAt: number;
};

type SessionState = {
  loading: boolean;
  online: boolean;
  offlineMode: boolean; // running from cache without a live session
  userId: string | null;
  email: string | null;
  isPlatformUser: boolean;
  tenant: Tenant | null;
  membership: Membership | null;
  features: FeatureMap;
  permissions: Record<string, boolean>;
  currency: CurrencySettings;
  /** rc.10 — a controlled sign-in notice (e.g. expired offline authority), shown on the login screen. */
  authNotice: string | null;
  /** Final Foundation — non-null while NEW financial captures are locked (see lib/security/captureLock). */
  captureLock: CaptureLockReason | null;
  /** Final Foundation — OUs the VERIFIED offline entitlement allows (null = online / not enforced). */
  entitledBranchIds: string[] | null;
  /** Offline-first recovery — users who signed in online on this device (sign-in screen list). */
  savedUsers: vault.SavedUser[];
  init: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signInWithGoogle: () => Promise<{ error: string | null }>;
  /** Offline-first recovery — park this user on the DEVICE (they can sign in again offline, and their
   *  recorded work keeps its own identity) and return to the sign-in screen. No network, no data loss. */
  switchUser: () => Promise<void>;
  /** Sign out AND remove this user's offline sign-in from the device. */
  signOut: () => Promise<void>;
  /** Remove a saved (parked) user from this device. */
  forgetUser: (userId: string) => Promise<void>;
  loadSavedUsers: () => Promise<void>;
  /** Leave offline mode through the canonical online path (reconnect). Rejects when still offline. */
  goOnline: () => Promise<void>;
  loadContextOnline: () => Promise<void>;
  /** Re-fetch ONLY features + permissions for the current tenant, in place, without a
   *  full context reload. Lets a web-side role change reach a running till on focus/online. */
  refreshPermissions: () => Promise<void>;
  can: (perm: string) => boolean;
};

function writeCache(c: CachedContext): Promise<void> {
  return writeAuthorityCache(c as unknown as AuthorityCache);
}

export const useSession = create<SessionState>((set, get) => ({
  loading: true,
  online: navigator.onLine,
  offlineMode: false,
  userId: null,
  email: null,
  isPlatformUser: false,
  tenant: null,
  membership: null,
  features: {},
  permissions: {},
  currency: DEFAULT_CURRENCY,
  authNotice: null,
  captureLock: null,
  entitledBranchIds: null,
  savedUsers: [],

  init: async () => {
    const t0 = markStart();
    getDeviceIdentity(); // ensure device identity exists early
    set({ online: navigator.onLine });
    startSecurityLoop();
    // rc.10 — OFFLINE COLD-START CONTRACT. Read the durable authority FIRST and decide reachability
    // BEFORE any auth network call: when the backend is unreachable a still-valid authority restores
    // the shell immediately (no token-refresh stall, no network dependency at all), an expired one
    // shows a controlled re-authorization message, and nothing ever renders "Failed to fetch".
    // Final Foundation — the age check uses the clock guard's EFFECTIVE now (a rolled-back clock
    // cannot make the authority younger), and a restore additionally needs the verified,
    // device-bound signed entitlement whose claims replace the editable cached authority.
    const clock = await observeDeviceClock();
    const decision = await gateOfflineRestore(decideOfflineAuthority(await readAuthorityCache().catch(() => null), clock.effectiveNowMs), clock);
    const apply = (d: OfflineAuthDecision, offline: boolean) => {
      if (d.kind === "restore") {
        applyRestore(d.cache, clock.rollback);
        return;
      }
      set({
        loading: false,
        offlineMode: false,
        userId: null,
        authNotice: d.kind === "expired" ? REAUTH_MESSAGE : offline ? OFFLINE_SIGNIN_MESSAGE : null,
      });
    };
    void get().loadSavedUsers();
    // Offline-first recovery — LOCAL FIRST. A usable local authority renders the authorized workspace
    // at once; the network is consulted only in the BACKGROUND (revalidateActiveSession), never on the
    // start-up path. Through 1.0.38 a valid authority still waited for the reachability probe (≤2.5 s)
    // and, when anything answered it, for a token refresh plus four sequential context reads.
    if (decision.kind === "restore") {
      apply(decision, true);
      recordSince("startup.authority_restore", t0);
      void revalidateActiveSession();
      return;
    }
    if (!(await isBackendReachable().catch(() => false))) {
      apply(decision, true);
      return;
    }
    let session: unknown = null;
    try {
      const r = await supabase.auth.getSession();
      session = r.data.session;
      // The token refresh FAILED although the probe passed (a flapping link, a gateway/proxy/5xx answer):
      // this is an offline start, not a sign-out. rc.13 — only a definitive INVALIDATION (revoked / unknown
      // refresh token, deleted / banned user) is a sign-out; every other refresh failure keeps a device with
      // a valid 7-day authority inside the POS (rc.12 native: "network failure redirects to Sign In").
      if (!session && r.error && !isAuthInvalidation(r.error)) {
        apply(decision, true);
        return;
      }
      // rc.13 (Konan) — a definitive INVALIDATION also drops the cached offline authority, so a revoked /
      // banned identity can never regain offline access on a later unreachable launch.
      if (!session && r.error && isAuthInvalidation(r.error)) {
        await clearAuthorityCache().catch(() => undefined);
        set({ loading: false, offlineMode: false, userId: null, authNotice: null });
        return;
      }
    } catch (e) {
      // A definitive invalidation is a sign-out (never an offline restore); anything else is offline.
      if (isAuthInvalidation(e)) {
        await clearAuthorityCache().catch(() => undefined);
        set({ loading: false, offlineMode: false, userId: null, authNotice: null });
        return;
      }
      apply(decision, true);
      return;
    }
    if (session) {
      try {
        await get().loadContextOnline();
        set({ loading: false, offlineMode: false, authNotice: null });
        return;
      } catch {
        /* fall through to the durable authority (a context read failed mid-load) */
      }
    }
    // No live session (or context load failed) — try the offline cache.
    //
    // NATIVE OFFLINE FIX (1.0.37): this restore must NOT require `data.session` to be truthy.
    // Offline, supabase.auth.getSession() reads persisted localStorage, but once the access token
    // has expired it attempts a refresh that cannot reach the auth server and returns null — even
    // though the device is simply offline and the durable context cache is still valid. Requiring
    // `data.session` here dropped the WHOLE authenticated context on an offline relaunch, which
    // emptied `pos.access` and collapsed every permission/feature-gated POS section (Dine-In,
    // Delivery, Transfer, Force-End) to inaccessible while unconditional Takeaway survived.
    //
    // The cache is the authority offline: it is written ONLY after a successful online auth
    // (loadContextOnline), is TTL-bounded (OFFLINE_TTL_MS = 7 days), and is cleared on sign-out — so
    // a genuinely signed-out user has NO cache to restore. Reconnect still revalidates authority
    // through the canonical path (loadContextOnline / refreshPermissions), and server RLS remains the
    // mutation boundary. Restoring a valid, non-expired cache is exactly the offline-continuity intent.
    //
    // rc.10 — reachable but NO live session and no transport error = signed out / revoked: honour it
    // (login, no offline restore — revocation is not bypassed while the server is reachable).
    if (!session) {
      set({ loading: false, offlineMode: false, userId: null, authNotice: null });
      return;
    }
    apply(decision, false);
  },

  loadContextOnline: async () => {
    const { data: userRes } = await supabase.auth.getUser();
    const user = userRes.user;
    if (!user) throw new Error("no user");
    // Offline-first recovery — the live session must belong to the user who is authorized on screen;
    // a session of anyone else is never adopted under their identity.
    const shown = get().userId;
    if (shown && shown !== user.id) throw new Error("identity_mismatch");

    const [{ data: platformUser, error: platformErr }, { data: selfProfile }] = await Promise.all([
      supabase.from("platform_users").select("*").eq("user_id", user.id).maybeSingle(),
      supabase.from("profiles").select("must_change_password").eq("id", user.id).maybeSingle(),
    ]);
    void selfProfile;
    // rc.10 — a context read that FAILED (vs. legitimately empty) must abort the load: otherwise a
    // half-failed load (link dropping mid-read) overwrites the good offline authority with an empty
    // tenant / permission set, and the next offline cold start restores a crippled shell.
    if (platformErr) throw new Error(platformErr.message);

    const { data: membership, error: memErr } = await supabase
      .from("tenant_users")
      .select("id, tenant_id, role, status, branch_id, all_branches")
      .eq("user_id", user.id)
      .order("created_at")
      .limit(1)
      .maybeSingle();
    if (memErr) throw new Error(memErr.message);

    let tenant: Tenant | null = null;
    let features: FeatureMap = {};
    let permissions: Record<string, boolean> = {};
    let currency: CurrencySettings = DEFAULT_CURRENCY;
    if (membership?.tenant_id) {
      const [{ data: t, error: tErr }, { data: feat, error: fErr }, { data: perms, error: pErr }, { data: cur, error: curErr }] = await Promise.all([
        supabase.from("tenants").select("id, business_name, tenant_status, verification_status, selected_plan_id, main_branch_id").eq("id", membership.tenant_id).maybeSingle(),
        supabase.rpc("get_tenant_effective_features", { p_tenant: membership.tenant_id }),
        supabase.rpc("current_user_permissions", { p_tenant: membership.tenant_id }),
        // Read-only display setting (dual USD/LBP). If RLS blocks it, we fall back to USD.
        supabase.from("tenant_currency_settings").select("primary_currency, usd_to_lbp_rate").eq("tenant_id", membership.tenant_id).maybeSingle(),
      ]);
      const firstErr = tErr ?? fErr ?? pErr;
      if (firstErr) throw new Error(firstErr.message);
      tenant = (t as Tenant) ?? null;
      features = (feat as unknown as FeatureMap) ?? {};
      permissions = (perms as Record<string, boolean>) ?? {};
      const curRow = cur as { primary_currency?: unknown; usd_to_lbp_rate?: unknown } | null;
      if (curErr) {
        // Offline-first recovery — a FAILED currency read keeps this user's last known settings;
        // through 1.0.38 it wrote USD / no rate over a good LBP rate into the 7-day authority.
        const known = (await vault.getVaultUser(user.id).catch(() => null))?.context.currency as CurrencySettings | undefined;
        currency = known && isCurrencyCode(known.primary) ? known : get().userId === user.id ? get().currency : DEFAULT_CURRENCY;
      } else {
        currency = {
          primary: isCurrencyCode(curRow?.primary_currency) ? curRow.primary_currency : "USD",
          rate: typeof curRow?.usd_to_lbp_rate === "number" ? curRow.usd_to_lbp_rate : null,
        };
      }
    }

    // Cache-scope hardening: drop cached POS data (snapshots + customers) of tenants no saved user of
    // this device belongs to (offline-created customers still needed by unsettled work are kept).
    await purgeTenantsWithoutSavedUsers(tenant?.id ?? null).catch(() => {});

    const next = {
      userId: user.id,
      email: user.email ?? null,
      isPlatformUser: Boolean(platformUser),
      tenant,
      membership: (membership as Membership) ?? null,
      features,
      permissions,
      currency,
    };
    grantedPermissions = permissions;
    set({ ...next, permissions: applyCaptureLock(permissions, get().captureLock), offlineMode: false, online: true, authNotice: null, entitledBranchIds: null });
    // The authority timestamp = this FULL online authorization (getUser + every context read OK).
    const authorizedAt = Date.now();
    await writeCache({ ...next, cachedAt: authorizedAt });
    // Offline-first recovery — and this user's own record in the per-user offline vault.
    await vault.recordOnlineAuthorization({ context: { ...next, cachedAt: authorizedAt } as unknown as AuthorityCache, email: next.email }).catch(() => undefined);
    if (standingLock === "reauth_required") standingLock = null;
    void get().loadSavedUsers();
    // Final Foundation — online and server-validated: obtain / renew the device-bound signed
    // entitlement and re-evaluate the capture lock. Background only; never blocks sign-in.
    void securityTick().catch(() => undefined);
  },

  refreshPermissions: async () => {
    const { membership, offlineMode, userId } = get();
    // Only a live, online, signed-in tenant session refreshes. Offline mode keeps its
    // cached snapshot untouched; no membership means there is nothing to refresh.
    if (!navigator.onLine) return;
    // Offline-first recovery — a locally authorized session leaves offline mode through the
    // canonical revalidation (background, bounded by reachability), never by a bare refresh.
    if (offlineMode) {
      void revalidateActiveSession();
      return;
    }
    if (!membership?.tenant_id) return;
    if (permissionRefreshInFlight) return permissionRefreshInFlight;
    const tenantId = membership.tenant_id;
    permissionRefreshInFlight = (async () => {
      try {
        const [{ data: feat }, { data: perms }] = await Promise.all([
          supabase.rpc("get_tenant_effective_features", { p_tenant: tenantId }),
          supabase.rpc("current_user_permissions", { p_tenant: tenantId }),
        ]);
        // Bail if the session changed under us (sign-out / tenant switch / went offline)
        // so a late response can never repaint a different context.
        const cur = get();
        if (cur.offlineMode || cur.userId !== userId || cur.membership?.tenant_id !== tenantId) return;
        const features = (feat as unknown as FeatureMap) ?? cur.features;
        const permsMap = perms as Record<string, boolean> | null;
        // A valid member returns the FULL catalog map; an empty object means "no active
        // membership resolved" — never clobber a working permission set with that.
        const fetched =
          permsMap && typeof permsMap === "object" && Object.keys(permsMap).length > 0 ? permsMap : cur.permissions;
        // Final Foundation — `cur.permissions` may be the capture-LOCKED view; the unlocked grant
        // that it stands for is `grantedPermissions`.
        const permissions = fetched === cur.permissions ? grantedPermissions : fetched;
        grantedPermissions = permissions;
        set({ features, permissions: applyCaptureLock(permissions, cur.captureLock), online: true });
        // Keep the offline cache coherent so a later offline launch restores the fresh grants. rc.10 —
        // WITHOUT extending the authority lifetime (cachedAt stays the last full online authorization):
        // a permission refresh is not a re-authentication.
        const cache = (await readAuthorityCache().catch(() => null)) as CachedContext | null;
        if (cache && cache.userId === userId) {
          // Only a SERVER re-validation of the user (getUser checks the JWT with the auth server) is a
          // re-authorization that may renew the 7-day offline lifetime.
          const { data: who } = await supabase.auth.getUser().catch(() => ({ data: { user: null } }));
          const revalidated = who.user?.id === userId;
          await writeCache({ ...cache, features, permissions, ...(revalidated ? { cachedAt: Date.now() } : {}) });
        }
      } catch {
        // Transient failure — keep the existing permissions. A refresh must never blank the UI.
      } finally {
        permissionRefreshInFlight = null;
      }
      // Final Foundation — focus / reconnect is also when device + user standing is re-checked.
      await securityReconnect().catch(() => undefined);
    })();
    return permissionRefreshInFlight;
  },

  signIn: async (rawEmail, password) => {
    const t0 = markStart();
    const email = rawEmail.trim();
    // Offline-first recovery — LOCAL FIRST. A user who has signed in online on this device before is
    // verified against their sealed local verifier and admitted at once from their own authority; the
    // network only revalidates afterwards, in the background. No remote call, timeout or retry sits
    // between the cashier and the POS.
    const saved = await vault.findVaultUserByEmail(email).catch(() => null);
    if (saved?.verifier) {
      const locked = vault.lockRemainingMs(saved);
      if (locked > 0) return { error: `Too many incorrect attempts. Try again in ${Math.ceil(locked / 1000)} s.` };
      if (await vault.checkVerifier(saved.verifier, password).catch(() => false)) {
        const refused = await activateLocalUser(saved, password);
        if (refused === null) {
          await vault.resetFailedAttempts(saved.userId).catch(() => undefined);
          recordSince("auth.local_signin", t0);
          void revalidateActiveSession();
          return { error: null };
        }
        // The local authority is expired / unverifiable: only the server can re-authorize this user.
        if (!(await isBackendReachable().catch(() => false))) return { error: refused };
      } else if (!(await isBackendReachable().catch(() => false))) {
        const lock = await vault.recordFailedAttempt(saved.userId).catch(() => 0);
        return { error: lock > 0 ? `${WRONG_PASSWORD_MESSAGE} Too many attempts — try again in ${Math.ceil(lock / 1000)} s.` : WRONG_PASSWORD_MESSAGE };
      }
      // Reachable and the verifier did not match: the password may have changed on the server — ask it.
    }
    // rc.10 — a NETWORK failure is a controlled message, never the raw "Failed to fetch".
    const offlineMsg = () => (saved ? REAUTH_MESSAGE : FIRST_SIGNIN_MESSAGE);
    // No usable local authority and no backend: say so at once, without attempting the network.
    if (!(await isBackendReachable().catch(() => false))) return { error: offlineMsg() };
    let error: { message: string } | null = null;
    let signedInUserId: string | null = null;
    try {
      const r = await supabase.auth.signInWithPassword({ email, password });
      error = r.error;
      signedInUserId = r.data?.user?.id ?? null;
      if (error && isAuthTransportError(error)) return { error: offlineMsg() };
    } catch (e) {
      if (isAuthTransportError(e)) return { error: offlineMsg() };
      return { error: e instanceof Error ? e.message : "Could not sign in." };
    }
    if (error) return { error: error.message };
    // A new server session supersedes any parked copy of this user's old one. 1.0.38 — their own (kept)
    // entitlement becomes the active slot again, so provisioning below is instant when it is still valid.
    if (signedInUserId) {
      const parked = await vault.unparkUser(signedInUserId).catch(() => null);
      if (parked?.entitlement) await installEntitlementSlot(parked.entitlement, parked.entitlementReceivedAtMs).catch(() => undefined);
    }
    try {
      await get().loadContextOnline();
    } catch (e) {
      if (isAuthTransportError(e)) return { error: offlineMsg() };
      return { error: e instanceof Error ? e.message : "Could not load your account." };
    }
    // The password was just proven to the server: it becomes this user's local verifier, so the next
    // sign-in on this device works without a connection.
    const uid = get().userId;
    if (uid) await vault.setVerifier(uid, await vault.createVerifier(password)).catch(() => undefined);
    pendingSecret = null;
    // 1.0.38 (native Bug 1/2) — and its signed, device-bound entitlement (bounded wait): the sign-in returns
    // with this user provisioned for offline sign-in on this device, not "soon, in the background".
    if (uid) {
      const tp = markStart();
      await provisionOfflineAccess(uid, get().tenant?.id ?? null).catch(() => undefined);
      recordSince("auth.offline_provision", tp);
    }
    recordSince("auth.online_signin", t0);
    void get().loadSavedUsers();
    return { error: null };
  },

  signInWithGoogle: async () => {
    // NOTE (desktop): OAuth redirect flow needs a registered redirect + deep-link
    // handling in Tauri. Documented as a Phase-1 limitation; email/password is primary.
    const { error } = await supabase.auth.signInWithOAuth({ provider: "google" });
    return { error: error?.message ?? null };
  },

  switchUser: async () => {
    const { userId, email, tenant, offlineMode } = get();
    if (userId) {
      // A user switching out right after their FIRST online sign-in may not hold their signed
      // entitlement yet (it is obtained in the background): finish obtaining it first (bounded), or they
      // could not sign in offline later on this device.
      if (!offlineMode && entitlementEnforced()) {
        const held = await verifyStoredEntitlement({ userId, tenantId: tenant?.id ?? null }).catch(() => null);
        if (!held?.ok) await Promise.race([refreshEntitlementForSession().catch(() => undefined), new Promise((r) => setTimeout(r, 8_000))]);
      }
      // Park this user's live session + entitlement in THEIR vault record: they can sign in again
      // offline, and their captured work keeps replaying under their own identity.
      const session = await sealedAuthStorage.getItem(AUTH_STORAGE_KEY).catch(() => null);
      // 1.0.38 — park the active slot only when it verifiably belongs to THIS user (never another's).
      const own = entitlementEnforced() ? (await verifyStoredEntitlement({ userId, tenantId: tenant?.id ?? null }).catch(() => null))?.ok === true : true;
      const ent = own ? await readEntitlementSlot().catch(() => ({ jws: null, receivedAtMs: null })) : { jws: null, receivedAtMs: null };
      if (!(await vault.getVaultUser(userId).catch(() => null))) {
        // A user restored from an older build has no vault record yet: create it from the active
        // authority (no verifier — their next sign-in must be online once).
        const cache = await readAuthorityCache().catch(() => null);
        if (cache && cache.userId === userId) await vault.recordOnlineAuthorization({ context: cache, email }).catch(() => undefined);
      }
      await vault.parkUser(userId, { session, entitlement: ent.jws, entitlementReceivedAtMs: ent.receivedAtMs }).catch(() => undefined);
    }
    pendingSecret = null;
    await sealedAuthStorage.removeItem(AUTH_STORAGE_KEY).catch(() => undefined);
    await installEntitlementSlot(null, null).catch(() => undefined);
    grantedPermissions = {};
    standingLock = null;
    // Only the ACTIVE authority goes; the user's own record stays in the vault.
    await clearAuthorityCache();
    await resetUserScopedStores().catch(() => undefined);
    set({ userId: null, email: null, isPlatformUser: false, tenant: null, membership: null, features: {}, permissions: {}, currency: DEFAULT_CURRENCY, offlineMode: false, captureLock: null, entitledBranchIds: null, authNotice: null });
    await get().loadSavedUsers();
  },

  forgetUser: async (userId) => {
    await vault.forgetVaultUser(userId).catch(() => undefined);
    // Removed FIRST, so the sign-out below keeps nothing of this user (its park is a no-op).
    if (get().userId === userId) return get().signOut();
    await get().loadSavedUsers();
  },

  loadSavedUsers: async () => {
    set({ savedUsers: await vault.listSavedUsers().catch(() => []) });
  },

  goOnline: async () => {
    await revalidateActiveSession();
    if (get().offlineMode) throw new Error("still_offline");
  },

  signOut: async () => {
    const leaving = get().userId;
    const leavingTenant = get().tenant?.id ?? null;
    // 1.0.38 (native Bug 1/2) — Sign Out ends the SERVER session but keeps this user's own offline sign-in
    // on the device (password verifier + signed entitlement, bounded by its 7-day window): a cashier who
    // signed out can sign in again offline with their password. "Remove" on the sign-in screen
    // (forgetUser) is the one action that deletes it. Through the first 1.0.38 build Sign Out deleted it,
    // and the next offline sign-in answered "first secure sign-in requires an internet connection".
    if (leaving) {
      const own = entitlementEnforced() ? (await verifyStoredEntitlement({ userId: leaving, tenantId: leavingTenant }).catch(() => null))?.ok === true : false;
      const ent = own ? await readEntitlementSlot().catch(() => ({ jws: null, receivedAtMs: null })) : { jws: null, receivedAtMs: null };
      await vault.parkUser(leaving, { session: null, entitlement: ent.jws, entitlementReceivedAtMs: ent.receivedAtMs }).catch(() => undefined);
    }
    await supabase.auth.signOut().catch(() => undefined);
    // Final Foundation — a global sign-out that could not reach the server keeps the local
    // session; drop it locally too (this removes the SEALED session via the storage adapter).
    await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
    // The signed entitlement belongs to the signed-out user. (The clock guard is device state
    // and deliberately survives sign-out.)
    await clearEntitlement().catch(() => undefined);
    grantedPermissions = {};
    standingLock = null;
    // rc.10 — the offline authority must not survive in EITHER store (localStorage + IndexedDB mirror).
    await clearAuthorityCache();
    pendingSecret = null;
    await resetUserScopedStores().catch(() => undefined);
    // Other users saved on this device still need the business's cached POS data offline: the
    // device-wide caches below are dropped only when nobody else can sign in here.
    if ((await vault.listSavedUsers().catch(() => [])).length > 0) {
      set({ userId: null, email: null, isPlatformUser: false, tenant: null, membership: null, features: {}, permissions: {}, currency: DEFAULT_CURRENCY, offlineMode: false, captureLock: null, entitledBranchIds: null });
      await get().loadSavedUsers();
      return;
    }
    // Drop the durable POS-session snapshot too: the branch name + open shift it
    // holds belong to the user who just signed out and must never be restored for
    // whoever logs in next on this terminal.
    clearPosSessionSnapshot();
    // The durable branch-context cache (names only) also belongs to this terminal's
    // signed-out session; drop it so it never names a branch for the next login.
    clearBranchContext();
    // Drop the read-only snapshot cache so no cached data survives into the next login.
    // The durable outbox (unsynced work) is preserved by design — never dropped here.
    await clearSnapshotCache().catch(() => {});
    // The delivery customer cache holds personal data (names, phones, addresses);
    // drop it on sign-out so it never outlives the session that cached it — EXCEPT
    // offline-created customers that unsynced offline work still needs (1.0.38).
    await dropCachedCustomersKeepingUnsettled().catch(() => {});
    set({ userId: null, email: null, isPlatformUser: false, tenant: null, membership: null, features: {}, permissions: {}, currency: DEFAULT_CURRENCY, offlineMode: false, captureLock: null, entitledBranchIds: null });
    await get().loadSavedUsers();
  },

  can: (perm) => Boolean(get().permissions[perm]),
}));

// Keep the operational-branch pin/picker inside the VERIFIED entitlement scope whenever it changes.
useSession.subscribe((s, prev) => {
  if (s.entitledBranchIds !== prev.entitledBranchIds) setEntitledBranchScope(s.entitledBranchIds);
});

// Web app's routing rule, ported verbatim.
export function resolvePostLoginPath(s: {
  isPlatformUser: boolean;
  tenant: Tenant | null;
  membership: Membership | null;
}): string {
  if (s.isPlatformUser) return "/admin"; // super-admin console is web-only in Phase 1
  const t = s.tenant;
  if (!t) return "/no-tenant";
  const blocked: TenantStatus[] = ["rejected", "disabled", "expired"];
  if (blocked.includes(t.tenant_status)) return "/blocked";
  if (t.tenant_status === "active") return "/dashboard";
  return "/pending";
}
