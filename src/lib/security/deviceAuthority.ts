// Final Foundation - device-bound offline authority (Tracks 4/5/6).
//
// Glue between the session store and the pure pieces:
//   * the sealed time guard (clockGuard.ts)          -> effective now, rollback
//   * the stored signed entitlement (entitlement.ts) -> offline restore + in-session expiry
//   * the device key (native.ts / Rust)              -> fingerprint, signed requests
//   * the server (desktop_device_* RPCs + Edge Fn)   -> issuance, revocation status
//
// ENFORCEMENT is on when this is the packaged app (device key available) AND the
// build's environment has at least one embedded entitlement key. Otherwise the
// legacy 7-day authority applies unchanged (dev in a browser; a production build
// before the production key exists) - the clock guard still runs everywhere.
//
// NEVER deletes or rewrites an operation, outbox row, shift, draft or history entry.
// The only things this module clears are the entitlement itself (sign-out /
// revocation) - financial history is out of its reach by construction.

import { ENTITLEMENT_PUBLIC_KEYS, type AppEnv, type EntitlementPublicKey } from "@/lib/security/entitlementKeys";
import { observeClock, parseTimeGuard, trustServerTime, type TimeGuardState } from "@/lib/security/clockGuard";
import {
  ENTITLEMENT_MAX_TTL_MS,
  entitlementRemainingMs,
  verifyEntitlement,
  type EntitlementCheck,
  type EntitlementClaims,
} from "@/lib/security/entitlement";
import { securityNative, type SealName } from "@/lib/security/native";

/** Refresh the entitlement online once less than this much offline validity is left. */
export const ENTITLEMENT_REFRESH_WITHIN_MS = 24 * 60 * 60 * 1000;
const REFRESH_FAILURE_BACKOFF_MS = 5 * 60 * 1000;
const FALLBACK_PREFIX = "breadee-desktop-secure:";

// --- secure store: sealed (DPAPI via Rust) in the app, localStorage in dev only ----

async function storeGet(name: SealName): Promise<string | null> {
  const n = securityNative();
  if (n.available()) return n.unsealSecret(name);
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem(FALLBACK_PREFIX + name) : null;
  } catch {
    return null;
  }
}

async function storeSet(name: SealName, value: string): Promise<void> {
  const n = securityNative();
  if (n.available()) return n.sealSecret(name, value);
  try {
    localStorage.setItem(FALLBACK_PREFIX + name, value);
  } catch {
    /* dev only */
  }
}

async function storeClear(name: SealName): Promise<void> {
  const n = securityNative();
  if (n.available()) return n.clearSecret(name);
  try {
    localStorage.removeItem(FALLBACK_PREFIX + name);
  } catch {
    /* dev only */
  }
}

// --- enforcement + device identity ---------------------------------------------------

let envOverride: AppEnv | null = null;

/** The build's declared environment. Read straight from the Vite define (env.ts has
 *  already validated it at startup) so this module stays importable in node tests. */
function appEnv(): AppEnv | null {
  if (envOverride) return envOverride;
  // `?.` because node tests have no import.meta.env; Vite replaces it at build time.
  const v = (import.meta.env?.VITE_APP_ENV as string | undefined)?.trim();
  return v && Object.prototype.hasOwnProperty.call(ENTITLEMENT_PUBLIC_KEYS, v) ? (v as AppEnv) : null;
}

/** Test seam only. */
export function __setAppEnvForTests(e: AppEnv | null): void {
  envOverride = e;
}

let keysOverride: readonly EntitlementPublicKey[] | null = null;

/** Test seam only: verify against test keys instead of the embedded ones. */
export function __setEntitlementKeysForTests(keys: readonly EntitlementPublicKey[] | null): void {
  keysOverride = keys;
}

function keysFor(e: AppEnv): readonly EntitlementPublicKey[] {
  return keysOverride ?? ENTITLEMENT_PUBLIC_KEYS[e];
}

export function entitlementEnforced(): boolean {
  const e = appEnv();
  return e !== null && securityNative().available() && keysFor(e).length > 0;
}

let fingerprintCache: Promise<string | null> | null = null;

/** This install's device-key fingerprint, or null outside the app / on key failure. */
export function deviceFingerprint(): Promise<string | null> {
  if (!securityNative().available()) return Promise.resolve(null);
  if (!fingerprintCache) {
    fingerprintCache = securityNative()
      .devicePublicKey()
      .then((k) => k.fingerprint)
      .catch(() => {
        fingerprintCache = null;
        return null;
      });
  }
  return fingerprintCache;
}

/** The terminal id as the signed grammar allows it ([A-Za-z0-9._-]{1,64}). */
export function signableTerminalId(raw: string | null | undefined): string {
  const t = String(raw ?? "").replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64);
  return t.length > 0 ? t : "terminal";
}

// --- time guard -------------------------------------------------------------------

let guard: TimeGuardState | null = null;
let guardPersistedSeen = 0;

async function loadGuard(nowMs: number): Promise<TimeGuardState> {
  if (guard) return guard;
  let raw: string | null = null;
  try {
    raw = await storeGet("time-guard");
  } catch {
    raw = null;
  }
  guard = parseTimeGuard(raw, nowMs);
  guardPersistedSeen = guard.lastSeenLocalMs;
  return guard;
}

async function persistGuard(force = false): Promise<void> {
  if (!guard) return;
  // Bounded writes: persist when forced, or once the high-water mark moved >= 30 s.
  if (!force && guard.lastSeenLocalMs - guardPersistedSeen < 30_000) return;
  try {
    await storeSet("time-guard", JSON.stringify(guard));
    guardPersistedSeen = guard.lastSeenLocalMs;
  } catch {
    /* sealing unavailable: the in-memory guard still protects this run */
  }
}

export type DeviceClock = { effectiveNowMs: number; rollback: boolean };

/** Observe the clock (persisting the high-water mark). Never throws. */
export async function observeDeviceClock(nowMs = Date.now()): Promise<DeviceClock> {
  try {
    const prev = await loadGuard(nowMs);
    const wasRollback = prev.rollbackAtMs !== null;
    const o = observeClock(prev, nowMs);
    guard = o.state;
    await persistGuard(o.rollback !== wasRollback);
    return { effectiveNowMs: o.effectiveNowMs, rollback: o.rollback };
  } catch {
    return { effectiveNowMs: nowMs, rollback: false };
  }
}

/** Non-enforced builds have no server time source: an ONLINE re-authorization resets
 *  the baseline to the local clock (the server is authoritative while online anyway). */
export async function resetClockAfterOnlineAuth(nowMs = Date.now()): Promise<void> {
  const g = await loadGuard(nowMs);
  guard = trustServerTime(g, nowMs, nowMs);
  await persistGuard(true);
}

// --- stored entitlement -------------------------------------------------------------

export async function readStoredEntitlement(): Promise<string | null> {
  try {
    return await storeGet("entitlement");
  } catch {
    return null;
  }
}

export async function clearEntitlement(): Promise<void> {
  await storeClear("entitlement").catch(() => undefined);
  if (guard) {
    guard = { ...guard, entitlementReceivedAtMs: null };
    await persistGuard(true);
  }
}

/** Verify the stored entitlement for this device + user (+ tenant) at the effective now. */
export async function verifyStoredEntitlement(ids: { userId: string | null; tenantId: string | null }, clock?: DeviceClock): Promise<EntitlementCheck> {
  const c = clock ?? (await observeDeviceClock());
  const g = await loadGuard(Date.now());
  const e = appEnv();
  if (!e) return { ok: false, reason: "wrong_env" };
  return verifyEntitlement(await readStoredEntitlement(), {
    env: e,
    keys: keysFor(e),
    deviceFingerprint: await deviceFingerprint(),
    userId: ids.userId,
    tenantId: ids.tenantId,
    effectiveNowMs: c.effectiveNowMs,
    receivedAtMs: g.entitlementReceivedAtMs,
  });
}

/** True when an online refresh is due (missing, invalid, or < 24 h left). */
export function entitlementRefreshDue(check: EntitlementCheck, effectiveNowMs: number): boolean {
  return !check.ok || entitlementRemainingMs(check.claims, effectiveNowMs) < ENTITLEMENT_REFRESH_WITHIN_MS;
}

// --- online issuance ----------------------------------------------------------------

export type RefreshOutcome =
  | { ok: true; claims: EntitlementClaims; counterRegressed: boolean }
  | { ok: false; reason: string };

/** Server I/O, injected so tests never need a live client. */
export type EntitlementServer = {
  status(fingerprint: string): Promise<{ registered: boolean; revoked: boolean; membership_active: boolean; pos_access: boolean } | null>;
  challenge(purpose: "register" | "entitlement"): Promise<{ challenge_id: string; nonce: string; tenant_id: string; user_id: string }>;
  issue(body: Record<string, unknown>): Promise<{ entitlement?: string; server_time_ms?: number; counter_regressed?: boolean; error?: string }>;
};

async function defaultServer(): Promise<EntitlementServer> {
  const { supabase } = await import("@/lib/supabase");
  const rpc = supabase.rpc.bind(supabase) as unknown as (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
  return {
    async status(fingerprint) {
      const { data, error } = await rpc("desktop_device_status", { p_fingerprint: fingerprint });
      if (error || !data) return null;
      return data as { registered: boolean; revoked: boolean; membership_active: boolean; pos_access: boolean };
    },
    async challenge(purpose) {
      const { data, error } = await rpc("desktop_device_challenge", { p_purpose: purpose });
      if (error || !data) throw new Error(error?.message ?? "challenge_failed");
      return data as { challenge_id: string; nonce: string; tenant_id: string; user_id: string };
    },
    async issue(body) {
      const { data, error } = await supabase.functions.invoke("desktop-entitlement", { body });
      if (error) {
        // FunctionsHttpError carries the JSON body in `context`.
        const ctx = (error as { context?: { json?: () => Promise<unknown> } }).context;
        const payload = ctx?.json ? ((await ctx.json().catch(() => null)) as { error?: string } | null) : null;
        return { error: payload?.error ?? "issue_failed" };
      }
      return (data ?? {}) as { entitlement?: string; server_time_ms?: number; counter_regressed?: boolean };
    },
  };
}

let refreshInFlight: Promise<RefreshOutcome> | null = null;
let lastRefreshFailureAt = 0;

/**
 * Online only: register this device if needed, prove possession of its key with a
 * fresh server challenge, and store the signed entitlement. The response is verified
 * exactly like an offline unlock (signature, env, device, user, tenant, time) BEFORE
 * it is stored, so a bad issuance can never become the offline authority.
 */
export function refreshEntitlement(
  ids: { userId: string; tenantId: string; terminalId: string },
  opts?: { server?: EntitlementServer; force?: boolean; nowMs?: () => number },
): Promise<RefreshOutcome> {
  if (refreshInFlight) return refreshInFlight;
  const now = opts?.nowMs ?? Date.now;
  if (!opts?.force && now() - lastRefreshFailureAt < REFRESH_FAILURE_BACKOFF_MS) return Promise.resolve({ ok: false, reason: "backoff" });
  refreshInFlight = (async (): Promise<RefreshOutcome> => {
    const native = securityNative();
    const e = appEnv();
    if (!native.available() || !e) return { ok: false, reason: "no_device_key" };
    const server = opts?.server ?? (await defaultServer());
    const key = await native.devicePublicKey();
    const st = await server.status(key.fingerprint);
    if (!st) return { ok: false, reason: "status_unavailable" };
    if (st.revoked) return { ok: false, reason: "device_revoked" };
    if (!st.membership_active || !st.pos_access) return { ok: false, reason: "access_revoked" };
    const purpose = st.registered ? "entitlement" : "register";
    const ch = await server.challenge(purpose);
    if (ch.user_id !== ids.userId || ch.tenant_id !== ids.tenantId) return { ok: false, reason: "identity_changed" };
    const g = await loadGuard(now());
    const counter = g.counter + 1;
    const terminalId = signableTerminalId(ids.terminalId);
    const sig = await native.deviceSign({ purpose, nonce: ch.nonce, tenantId: ch.tenant_id, userId: ch.user_id, terminalId, counter });
    const res = await server.issue({
      action: purpose,
      challenge_id: ch.challenge_id,
      fingerprint: key.fingerprint,
      terminal_id: terminalId,
      counter,
      signature: sig.signature,
      ...(purpose === "register" ? { spki: key.spki, provider: key.provider } : {}),
    });
    if (!res.entitlement || typeof res.server_time_ms !== "number") return { ok: false, reason: res.error ?? "issue_failed" };
    const localNow = now();
    const check = await verifyEntitlement(res.entitlement, {
      env: e,
      keys: keysFor(e),
      deviceFingerprint: key.fingerprint,
      userId: ids.userId,
      tenantId: ids.tenantId,
      effectiveNowMs: res.server_time_ms,
    });
    if (!check.ok) return { ok: false, reason: `issued_${check.reason}` };
    await storeSet("entitlement", res.entitlement);
    guard = { ...trustServerTime(await loadGuard(localNow), res.server_time_ms, localNow), counter, entitlementReceivedAtMs: localNow };
    await persistGuard(true);
    return { ok: true, claims: check.claims, counterRegressed: res.counter_regressed === true };
  })()
    .catch((e: unknown): RefreshOutcome => ({ ok: false, reason: e instanceof Error ? e.message.slice(0, 80) : "refresh_failed" }))
    .then((r) => {
      if (!r.ok) lastRefreshFailureAt = now();
      return r;
    })
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

export type DeviceStanding = "ok" | "device_revoked" | "access_revoked" | "unregistered" | "unknown";

/** Reconnect check (before / alongside draining). Never throws, never deletes history. */
export async function checkDeviceStanding(opts?: { server?: EntitlementServer }): Promise<DeviceStanding> {
  try {
    const fp = await deviceFingerprint();
    if (!fp) return "unknown";
    const server = opts?.server ?? (await defaultServer());
    const st = await server.status(fp);
    if (!st) return "unknown";
    if (st.revoked) return "device_revoked";
    if (!st.membership_active || !st.pos_access) return "access_revoked";
    return st.registered ? "ok" : "unregistered";
  } catch {
    return "unknown";
  }
}

/** Test seam: forget in-memory guard / caches. */
export function __resetDeviceAuthorityForTests(): void {
  guard = null;
  guardPersistedSeen = 0;
  fingerprintCache = null;
  refreshInFlight = null;
  lastRefreshFailureAt = 0;
}

export { ENTITLEMENT_MAX_TTL_MS };
