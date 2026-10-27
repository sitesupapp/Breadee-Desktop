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
  findCachedCustomersByPhoneE164,
  getCachedCustomer,
  listCachedCustomers,
  type CachedCustomer,
} from "@/lib/offline/db";
import { canonicalIds } from "@/lib/offline/entityMap";
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
  const { useOperationalBranch } = await import("@/state/operationalBranch");
  const s = useSession.getState();
  const tenantId = s.tenant?.id ?? null;
  // 1.0.38 (C4) — the SAME operational branch the POS captures in: an all-branches operator's PINNED
  // branch (R5), not Main. Through 1.0.37 the customer cache + offline customer writes of a pinned
  // non-Main operator were scoped to Main, so the drain (and the picker) never matched them.
  const pinned = tenantId && s.userId ? useOperationalBranch.getState().getBranch(tenantId, s.userId) : null;
  return { tenantId, branchId: resolveBranchId(s.tenant, s.membership, pinned) };
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
  // Final Foundation (PERF): stop at the SEARCH_LIMIT-th hit (same rows, same order as filter + slice).
  const hits: CachedCustomer[] = [];
  for (const c of rows) {
    if (hits.length >= SEARCH_LIMIT) break;
    const nameHit = c.name != null && c.name.toLowerCase().includes(lower);
    const phoneHit =
      nameHit ||
      (e164 != null && c.phone_e164 === e164) ||
      (c.phone != null && samePhone(c.phone, term)) ||
      (digits.length >= 4 && ((c.phone ?? "").replace(/\D/g, "").includes(digits) || (c.phone_e164 ?? "").includes(digits)));
    if (nameHit || phoneHit) hits.push(c);
  }
  return hits.map((c) => ({ id: c.id, name: c.name, phone: c.phone, phone_e164: c.phone_e164 }));
}

// --- the offline-aware wrappers the stores call ------------------------------

export async function searchCustomersOfflineAware(query: string): Promise<CustomerMatch[]> {
  const scope = await currentCustomerScope();
  if (await isBackendReachable()) {
    let results: CustomerMatch[];
    try {
      results = await searchCustomers(query);
    } catch {
      // rc.13 — a server lookup that FAILS (network flap, an access token expired while offline and not
      // refreshed yet, a 5xx) is NOT an authentication failure: answer from this device's customers
      // instead of an error (the session is untouched; only a real sign-out ever leaves the POS).
      return searchCachedCustomers(scope, query);
    }
    void cacheCustomerMatches(results, scope).catch(() => {});
    // rc.13 — a customer created OFFLINE on this device that has not synced yet is not on the server:
    // keep it findable (one logical customer — its canonical twin, once synced, wins). Only when such a
    // create exists (indexed op-log read), so a normal online search never scans the local cache.
    if (!(await hasUnsyncedCustomerCreate().catch(() => false))) return results;
    return mergePendingLocalMatches(results, await searchCachedCustomersFlagged(scope, query).catch(() => []));
  }
  return searchCachedCustomers(scope, query);
}

/** rc.13 — any offline customer CREATE on this device not yet on the server (operation_type index). */
async function hasUnsyncedCustomerCreate(): Promise<boolean> {
  const { localdb } = await import("@/lib/offline/db");
  const n = await localdb.operations
    .where("operation_type")
    .equals("customer_upsert")
    .filter((o) => o.local_entity_id != null && o.status !== "synced" && o.status !== "cancelled")
    .count();
  return n > 0;
}

/** rc.13 — PURE. Server matches + this device's still-unsynced (pending-local) matches, de-duplicated by
 *  normalised phone (the server row wins — never two results for one person). */
export function mergePendingLocalMatches(server: CustomerMatch[], local: (CustomerMatch & { pending_local?: boolean })[]): CustomerMatch[] {
  const phones = new Set(server.map((s) => s.phone_e164 ?? normalizePhoneE164(s.phone)).filter((x): x is string => !!x));
  const ids = new Set(server.map((s) => s.id));
  const extra: CustomerMatch[] = [];
  for (const l of local) {
    if (l.pending_local !== true || ids.has(l.id)) continue;
    const ph = l.phone_e164 ?? normalizePhoneE164(l.phone);
    if (ph && phones.has(ph)) continue;
    // Konan rc.13 — pending-local rows are de-duplicated against EACH OTHER too (id + normalised phone).
    ids.add(l.id);
    if (ph) phones.add(ph);
    extra.push({ id: l.id, name: l.name, phone: l.phone, phone_e164: l.phone_e164 });
  }
  return [...server, ...extra].slice(0, SEARCH_LIMIT);
}

/**
 * rc.13 — remember a customer just created/edited ONLINE in the local cache immediately, so it is found
 * again offline (rc.12: an online-created customer existed only on the server until some later online
 * search happened to return it — "newly registered customer cannot be found again"). Never downgrades a
 * cached full profile.
 */
export async function rememberCustomer(c: { id: string; name: string | null; phone: string | null }): Promise<void> {
  const scope = await currentCustomerScope();
  await cacheCustomerMatches([{ id: c.id, name: c.name, phone: c.phone, phone_e164: normalizePhoneE164(c.phone) }], scope);
}

/**
 * rc.12 — the OFFLINE customer search. A full phone number is answered from the phone_e164 INDEX (the
 * same normalisation the server stores, so "78900000", "03 …", "+961 …" are one key) — no scan of the
 * customer table per keystroke. Names / partial numbers fall back to the scoped scan. A pending-local
 * row that already has a canonical twin (entity map) is never listed twice.
 */
export async function searchCachedCustomers(scope: CustomerScope, query: string): Promise<CustomerMatch[]> {
  return (await searchCachedCustomersFlagged(scope, query)).map(({ id, name, phone, phone_e164 }) => ({ id, name, phone, phone_e164 }));
}

async function searchCachedCustomersFlagged(scope: CustomerScope, query: string): Promise<(CustomerMatch & { pending_local: boolean })[]> {
  const term = query.trim();
  if (term === "") return [];
  const e164 = looksLikePhone(term) ? normalizePhoneE164(term) : null;
  let rows: CachedCustomer[] = [];
  if (e164) rows = await findCachedCustomersByPhoneE164(scope.tenantId, scope.branchId, e164).catch(() => []);
  if (rows.length === 0) rows = await listCachedCustomers(scope.tenantId, scope.branchId).catch(() => []);
  const pendingIds = new Set(rows.filter((c) => c.pending_local === true).map((c) => c.id));
  const hits = matchCachedCustomers(rows, term).map((h) => ({ ...h, pending_local: pendingIds.has(h.id) }));
  const pending = hits.filter((h) => h.pending_local);
  if (pending.length === 0) return hits;
  const canon = await canonicalIds(pending.map((c) => c.id)).catch(() => ({}) as Record<string, string | null>);
  const ids = new Set(hits.map((h) => h.id));
  return hits.filter((h) => {
    const twin = canon[h.id];
    return !(twin && ids.has(twin));
  });
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
