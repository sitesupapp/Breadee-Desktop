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
import { clearPosSessionSnapshot } from "@/lib/offline/posSession";
import { clearBranchContext } from "@/lib/offline/branchContext";
import type { Membership, Tenant, TenantStatus } from "@/lib/types";
import type { FeatureMap } from "@/lib/features";
import { isCurrencyCode, type CurrencyCode } from "@/lib/currency";
import { isBackendReachable, lastKnownReachable } from "@/lib/offline/reachability";
import { applyCaptureLock, type CaptureLockReason } from "@/lib/security/captureLock";
import { setEntitledBranchScope } from "@/state/operationalBranch";
import { overlayAuthorityWithEntitlement } from "@/lib/security/entitlement";
import {
  checkDeviceStanding,
  clearEntitlement,
  entitlementEnforced,
  entitlementRefreshDue,
  observeDeviceClock,
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
async function refreshEntitlementForSession(): Promise<void> {
  const s = useSession.getState();
  if (!s.userId || !s.tenant?.id || s.offlineMode) return;
  const r = await refreshEntitlement({ userId: s.userId, tenantId: s.tenant.id, terminalId: getDeviceIdentity().terminal_id });
  if (!r.ok && (r.reason === "device_revoked" || r.reason === "access_revoked")) {
    standingLock = r.reason;
    await clearEntitlement();
  }
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
  } else if (standing === "ok" || standing === "unregistered") {
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
  init: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signInWithGoogle: () => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
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

  init: async () => {
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
        const c = d.cache as unknown as CachedContext;
        grantedPermissions = c.permissions ?? {};
        set({
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
        setCaptureLock(clock.rollback ? "clock_rollback" : standingLock);
        void securityTick().catch(() => undefined);
        return;
      }
      set({
        loading: false,
        offlineMode: false,
        userId: null,
        authNotice: d.kind === "expired" ? REAUTH_MESSAGE : offline ? OFFLINE_SIGNIN_MESSAGE : null,
      });
    };
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
      const [{ data: t, error: tErr }, { data: feat, error: fErr }, { data: perms, error: pErr }, { data: cur }] = await Promise.all([
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
      currency = {
        primary: isCurrencyCode(curRow?.primary_currency) ? curRow.primary_currency : "USD",
        rate: typeof curRow?.usd_to_lbp_rate === "number" ? curRow.usd_to_lbp_rate : null,
      };
    }

    // Cache-scope hardening: drop any cached snapshots that don't belong to this
    // tenant/branch before continuing, so a previous session's cache can't leak.
    await purgeForeignSnapshots(tenant?.id ?? null, (membership as Membership)?.branch_id ?? null).catch(() => {});
    // Same hardening for the delivery customer cache (phones/addresses): a
    // previous session's callers must never surface for a different tenant/branch.
    // (1.0.38: offline-created customers still needed by unsettled offline work are kept.)
    await dropCachedCustomersKeepingUnsettled({ tenantId: tenant?.id ?? null, branchId: (membership as Membership)?.branch_id ?? null }).catch(() => {});

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
    await writeCache({ ...next, cachedAt: Date.now() });
    // Final Foundation — online and server-validated: obtain / renew the device-bound signed
    // entitlement and re-evaluate the capture lock. Background only; never blocks sign-in.
    void securityTick().catch(() => undefined);
  },

  refreshPermissions: async () => {
    const { membership, offlineMode, userId } = get();
    // Only a live, online, signed-in tenant session refreshes. Offline mode keeps its
    // cached snapshot untouched; no membership means there is nothing to refresh.
    if (!navigator.onLine || offlineMode || !membership?.tenant_id) return;
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

  signIn: async (email, password) => {
    // rc.10 — a NETWORK failure is a controlled message, never the raw "Failed to fetch".
    const offlineMsg = async () => {
      const d = decideOfflineAuthority(await readAuthorityCache().catch(() => null), Date.now());
      return d.kind === "expired" ? REAUTH_MESSAGE : OFFLINE_SIGNIN_MESSAGE;
    };
    let error: { message: string } | null = null;
    try {
      const r = await supabase.auth.signInWithPassword({ email, password });
      error = r.error;
      if (error && isAuthTransportError(error)) return { error: await offlineMsg() };
    } catch (e) {
      if (isAuthTransportError(e)) return { error: await offlineMsg() };
      return { error: e instanceof Error ? e.message : "Could not sign in." };
    }
    if (error) return { error: error.message };
    try {
      await get().loadContextOnline();
    } catch (e) {
      if (isAuthTransportError(e)) return { error: await offlineMsg() };
      return { error: e instanceof Error ? e.message : "Could not load your account." };
    }
    return { error: null };
  },

  signInWithGoogle: async () => {
    // NOTE (desktop): OAuth redirect flow needs a registered redirect + deep-link
    // handling in Tauri. Documented as a Phase-1 limitation; email/password is primary.
    const { error } = await supabase.auth.signInWithOAuth({ provider: "google" });
    return { error: error?.message ?? null };
  },

  signOut: async () => {
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
