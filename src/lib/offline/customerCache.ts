// Delivery customer OFFLINE adapter.
//
// ONLINE  -> the production authority (searchCustomers / loadCustomerProfile in
//            lib/pos/customers.ts) is used UNCHANGED, and its result is mirrored
//            into the local cache so the same caller can be found again offline.
// OFFLINE -> the local cache (posCustomers, tenant+branch scoped) is searched;
//            no remote request is attempted, so a raw "Failed to fetch" can never
//            surface for the search/select path.
//
// This is a thin adapter: it never re-implements the customer matching rules, the
// upsert contract or the duplicate logic - those stay in lib/pos/customers.ts.
// New-customer CREATION is deliberately NOT handled here; offline creation is
// blocked in this hotfix (the caller shows a "reconnect to create" message).

import { isBackendReachable } from "@/lib/offline/reachability";
import {
  cacheCustomers,
  getCachedCustomer,
  listCachedCustomers,
  type CachedCustomer,
} from "@/lib/offline/db";
import {
  searchCustomers,
  loadCustomerProfile,
  upsertCustomer,
  CustomerWriteOfflineError,
  SEARCH_LIMIT,
  type CustomerAddress,
  type CustomerMatch,
  type CustomerProfile,
} from "@/lib/pos/customers";
import { looksLikePhone, normalizePhoneE164, phoneDigits, samePhone } from "@/lib/pos/phone";

export type CustomerScope = { tenantId: string | null; branchId: string | null };

/** The tenant + OPERATIONAL branch the customer cache is scoped to. Derived from
 *  the live session so callers never need to thread scope through their stores. */
export async function currentCustomerScope(): Promise<CustomerScope> {
  // Both imported LAZILY: @/state/session and @/lib/branch statically pull the
  // Supabase client (build-time env), so a top-level import would make this module
  // unloadable in the pure-logic test runtime. The offline search/caching helpers
  // never need scope, so they stay import-safe.
  const { useSession } = await import("@/state/session");
  const { resolveBranchId } = await import("@/lib/branch");
  const s = useSession.getState();
  return { tenantId: s.tenant?.id ?? null, branchId: resolveBranchId(s.tenant, s.membership) };
}

/** The immutable 5-D scope an offline customer WRITE is captured under (the same dimensions the
 *  drain replays by). Lazy imports for the same test-safety reason as currentCustomerScope. */
export async function currentCustomerOpScope(): Promise<{
  tenantId: string | null;
  branchId: string | null;
  cashierUserId: string | null;
  deviceId: string | null;
  terminalId: string | null;
}> {
  const base = await currentCustomerScope();
  const { useSession } = await import("@/state/session");
  const { getDeviceIdentity } = await import("@/lib/device");
  const s = useSession.getState();
  const dev = getDeviceIdentity();
  return { ...base, cashierUserId: s.userId ?? null, deviceId: dev.device_id, terminalId: dev.terminal_id };
}

/** Thrown offline when the selected customer has no cached full profile (no
 *  addresses cached yet). A clean, human-readable reason - never a raw error. */
export class CustomerOfflineUnavailableError extends Error {
  constructor() {
    super("Reconnect to load this customer's saved details.");
    this.name = "CustomerOfflineUnavailableError";
  }
}

// --- caching (online writes to the local mirror) -----------------------------

/** Cache compact search matches. Never downgrades an existing full profile. */
export async function cacheCustomerMatches(matches: CustomerMatch[], scope: CustomerScope): Promise<void> {
  if (!scope.tenantId || matches.length === 0) return;
  const records: CachedCustomer[] = [];
  for (const m of matches) {
    const existing = await getCachedCustomer(m.id, scope.tenantId, scope.branchId).catch(() => undefined);
    records.push({
      id: m.id,
      tenant_id: scope.tenantId,
      branch_id: scope.branchId,
      name: m.name,
      phone: m.phone,
      phone_e164: m.phone_e164,
      // Preserve a previously-cached full profile (addresses) rather than
      // overwriting it with a compact match.
      addresses: existing?.has_profile ? (existing.addresses ?? null) : null,
      notes: existing?.has_profile ? (existing.notes ?? null) : null,
      has_profile: existing?.has_profile ?? false,
      cached_at: new Date().toISOString(),
    });
  }
  await cacheCustomers(records);
}

/** Cache the FULL profile (with addresses) after an online profile load. */
export async function cacheCustomerProfile(profile: CustomerProfile, scope: CustomerScope): Promise<void> {
  if (!scope.tenantId) return;
  await cacheCustomers([
    {
      id: profile.id,
      tenant_id: scope.tenantId,
      branch_id: scope.branchId,
      name: profile.name,
      phone: profile.phone,
      phone_e164: profile.phone_e164,
      addresses: profile.addresses as unknown[],
      notes: profile.notes,
      has_profile: true,
      cached_at: new Date().toISOString(),
    },
  ]);
}

// --- local search (offline reads) --------------------------------------------

/** Search the local cache by normalized phone, raw phone, or name. Pure over the
 *  cached rows; mirrors the online two-pass (text + normalized phone) intent. */
export function matchCachedCustomers(rows: CachedCustomer[], query: string): CustomerMatch[] {
  const term = query.trim();
  if (term === "") return [];
  const lower = term.toLowerCase();
  const e164 = looksLikePhone(term) ? normalizePhoneE164(term) : null;
  const digits = phoneDigits(term);
  const hits = rows.filter((c) => {
    const nameHit = c.name != null && c.name.toLowerCase().includes(lower);
    const phoneHit =
      (e164 != null && c.phone_e164 === e164) ||
      (c.phone != null && samePhone(c.phone, term)) ||
      (digits.length >= 4 && ((c.phone ?? "").replace(/\D/g, "").includes(digits) || (c.phone_e164 ?? "").includes(digits)));
    return nameHit || phoneHit;
  });
  return hits
    .slice(0, SEARCH_LIMIT)
    .map((c) => ({ id: c.id, name: c.name, phone: c.phone, phone_e164: c.phone_e164 }));
}

// --- the offline-aware wrappers the stores call ------------------------------

export async function searchCustomersOfflineAware(query: string): Promise<CustomerMatch[]> {
  const scope = await currentCustomerScope();
  if (await isBackendReachable()) {
    const results = await searchCustomers(query);
    void cacheCustomerMatches(results, scope).catch(() => {});
    return results;
  }
  const rows = await listCachedCustomers(scope.tenantId, scope.branchId).catch(() => []);
  return matchCachedCustomers(rows, query);
}

/** The result of an offline-aware customer write — the online CustomerUpsertResult, plus a
 *  `pending_local` flag when it was CAPTURED offline (customer_id is then a LOCAL id). */
export type OfflineAwareUpsertResult = { customer_id: string; address_id: string | null; is_new: boolean; pending_local: boolean };

/**
 * Create/edit a customer OFFLINE-AWARE. ONLINE: the production upsertCustomer authority is used
 * UNCHANGED (duplicate/conflict/latch logic intact). OFFLINE: capture a durable customer_upsert op
 * and return the LOCAL ids so the UI flow continues; the op syncs exactly-once on reconnect and a
 * same-OU conflict surfaces as needs_attention. `payload` is the pos_upsert_customer shape WITHOUT
 * client_op_id. The caller mints `clientOpId` once per save (reused on retry).
 */
export async function upsertCustomerOfflineAware(
  payload: Record<string, unknown>,
  clientOpId: string,
): Promise<OfflineAwareUpsertResult> {
  if (await isBackendReachable()) {
    const r = await upsertCustomer(payload as never);
    return { customer_id: r.customer_id, address_id: r.address_id, is_new: r.is_new, pending_local: false };
  }
  const scope = await currentCustomerOpScope();
  if (!scope.tenantId || !scope.cashierUserId || !scope.deviceId) {
    throw new CustomerWriteOfflineError();
  }
  const { captureCustomerUpsertOffline } = await import("@/lib/offline/customerOffline");
  const cap = await captureCustomerUpsertOffline({
    scope: { tenantId: scope.tenantId, branchId: scope.branchId, cashierUserId: scope.cashierUserId, deviceId: scope.deviceId, terminalId: scope.terminalId },
    upsert: payload,
    clientOpId,
    display: { name: typeof payload.name === "string" ? payload.name : null, phone: typeof payload.phone === "string" ? payload.phone : null, phone_e164: null },
  });
  const isEdit = typeof payload.id === "string" && (payload.id as string).length > 0;
  return {
    customer_id: cap.localCustomerId ?? (payload.id as string),
    address_id: cap.localAddressId,
    is_new: !isEdit,
    pending_local: cap.localCustomerId != null,
  };
}

export async function loadCustomerProfileOfflineAware(customerId: string): Promise<CustomerProfile> {
  const scope = await currentCustomerScope();
  if (await isBackendReachable()) {
    const profile = await loadCustomerProfile(customerId);
    void cacheCustomerProfile(profile, scope).catch(() => {});
    return profile;
  }
  const c = await getCachedCustomer(customerId, scope.tenantId, scope.branchId).catch(() => undefined);
  if (!c || !c.has_profile) throw new CustomerOfflineUnavailableError();
  return {
    id: c.id,
    name: c.name,
    phone: c.phone,
    phone_e164: c.phone_e164,
    notes: c.notes,
    addresses: (c.addresses as CustomerAddress[]) ?? [],
    // History is a live-only read; offline shows none rather than a stale list.
    orders: [],
  };
}
