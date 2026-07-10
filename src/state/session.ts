import { create } from "zustand";
import { supabase } from "@/lib/supabase";
import { getDeviceIdentity } from "@/lib/device";
import { purgeForeignSnapshots, clearSnapshotCache } from "@/lib/offline/db";
import type { Membership, Tenant, TenantStatus } from "@/lib/types";
import type { FeatureMap } from "@/lib/features";
import { isCurrencyCode, type CurrencyCode } from "@/lib/currency";

// Read-only tenant currency settings for display (dual USD/LBP). Never used for POS math.
export type CurrencySettings = { primary: CurrencyCode; rate: number | null };
const DEFAULT_CURRENCY: CurrencySettings = { primary: "USD", rate: null };

// Mirrors the web app's SessionContext + resolvePostLoginPath, plus an offline cache
// so the app can restore the last valid role/tenant/branch/permissions after a first
// successful online login. The cache is non-sensitive (ids + role + permission flags).

const CACHE_KEY = "breadee-desktop-context";
const OFFLINE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // require online re-auth after 7 days

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
  init: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signInWithGoogle: () => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  loadContextOnline: () => Promise<void>;
  can: (perm: string) => boolean;
};

function readCache(): CachedContext | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as CachedContext) : null;
  } catch {
    return null;
  }
}

function writeCache(c: CachedContext) {
  localStorage.setItem(CACHE_KEY, JSON.stringify(c));
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

  init: async () => {
    getDeviceIdentity(); // ensure device identity exists early
    set({ online: navigator.onLine });
    const { data } = await supabase.auth.getSession();
    if (data.session) {
      try {
        await get().loadContextOnline();
        set({ loading: false, offlineMode: false });
        return;
      } catch {
        /* fall through to cache (likely offline) */
      }
    }
    // No live session (or context load failed) — try the offline cache.
    const cache = readCache();
    if (cache && Date.now() - cache.cachedAt < OFFLINE_TTL_MS && data.session) {
      set({
        loading: false,
        offlineMode: true,
        userId: cache.userId,
        email: cache.email,
        isPlatformUser: cache.isPlatformUser,
        tenant: cache.tenant,
        membership: cache.membership,
        features: cache.features,
        permissions: cache.permissions,
        currency: cache.currency ?? DEFAULT_CURRENCY,
      });
      return;
    }
    set({ loading: false, offlineMode: false, userId: null });
  },

  loadContextOnline: async () => {
    const { data: userRes } = await supabase.auth.getUser();
    const user = userRes.user;
    if (!user) throw new Error("no user");

    const [{ data: platformUser }, { data: selfProfile }] = await Promise.all([
      supabase.from("platform_users").select("*").eq("user_id", user.id).maybeSingle(),
      supabase.from("profiles").select("must_change_password").eq("id", user.id).maybeSingle(),
    ]);
    void selfProfile;

    const { data: membership } = await supabase
      .from("tenant_users")
      .select("id, tenant_id, role, status, branch_id, all_branches")
      .eq("user_id", user.id)
      .order("created_at")
      .limit(1)
      .maybeSingle();

    let tenant: Tenant | null = null;
    let features: FeatureMap = {};
    let permissions: Record<string, boolean> = {};
    let currency: CurrencySettings = DEFAULT_CURRENCY;
    if (membership?.tenant_id) {
      const [{ data: t }, { data: feat }, { data: perms }, { data: cur }] = await Promise.all([
        supabase.from("tenants").select("id, business_name, tenant_status, verification_status, selected_plan_id, main_branch_id").eq("id", membership.tenant_id).maybeSingle(),
        supabase.rpc("get_tenant_effective_features", { p_tenant: membership.tenant_id }),
        supabase.rpc("current_user_permissions", { p_tenant: membership.tenant_id }),
        // Read-only display setting (dual USD/LBP). If RLS blocks it, we fall back to USD.
        supabase.from("tenant_currency_settings").select("primary_currency, usd_to_lbp_rate").eq("tenant_id", membership.tenant_id).maybeSingle(),
      ]);
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
    set({ ...next, offlineMode: false, online: true });
    writeCache({ ...next, cachedAt: Date.now() });
  },

  signIn: async (email, password) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { error: error.message };
    await get().loadContextOnline();
    return { error: null };
  },

  signInWithGoogle: async () => {
    // NOTE (desktop): OAuth redirect flow needs a registered redirect + deep-link
    // handling in Tauri. Documented as a Phase-1 limitation; email/password is primary.
    const { error } = await supabase.auth.signInWithOAuth({ provider: "google" });
    return { error: error?.message ?? null };
  },

  signOut: async () => {
    await supabase.auth.signOut();
    localStorage.removeItem(CACHE_KEY);
    // Drop the read-only snapshot cache so no cached data survives into the next login.
    // The durable outbox (unsynced work) is preserved by design — never dropped here.
    await clearSnapshotCache().catch(() => {});
    set({ userId: null, email: null, isPlatformUser: false, tenant: null, membership: null, features: {}, permissions: {}, currency: DEFAULT_CURRENCY, offlineMode: false });
  },

  can: (perm) => Boolean(get().permissions[perm]),
}));

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
