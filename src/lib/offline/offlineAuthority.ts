// rc.10 — OFFLINE AUTHORITY: the cold-start contract for a previously authenticated + hydrated device.
//
// FIRST authentication always needs the network. A SUBSEQUENT cold start may restore the last validated
// identity / membership / features / permissions / tenant / currency WITHOUT the network, for at most
// OFFLINE_AUTH_TTL_MS (7 days) after the last full online authorization — never longer (no bypass of
// expiry/revocation: reconnect re-validates through the canonical online path, and server RLS remains
// the write boundary). Expired / missing authority → a controlled message, never a raw
// "TypeError: Failed to fetch".
//
// rc.9 native failure: the authority lived ONLY in localStorage; when that key was absent/stale the app
// fell to the login screen and the password sign-in surfaced the raw transport error. This module adds
// a durable IndexedDB mirror (the same store that already survived the restart — op log, drafts,
// snapshots), a single pure decision, and the controlled messages.

import { localdb } from "@/lib/offline/db";

export const OFFLINE_AUTH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const CONTEXT_CACHE_KEY = "breadee-desktop-context";
const MIRROR_KEY = "auth.context";

export const REAUTH_MESSAGE = "Connection required to re-authorize this device.";
export const OFFLINE_SIGNIN_MESSAGE =
  "You're offline. Signing in needs a connection — this device has no saved sign-in to continue offline.";

/** The cached authority snapshot (non-sensitive: ids, role, permission/feature flags, display data). */
export type AuthorityCache = {
  userId: string;
  email: string | null;
  isPlatformUser: boolean;
  tenant: unknown;
  membership: unknown;
  features: Record<string, unknown>;
  permissions: Record<string, boolean>;
  currency: unknown;
  /** Epoch ms of the last FULL online authorization (getUser + context load). */
  cachedAt: number;
};

export type OfflineAuthDecision =
  | { kind: "restore"; cache: AuthorityCache }
  | { kind: "expired"; cache: AuthorityCache }
  | { kind: "none" };

/** PURE — may this device restore its authority offline right now? */
export function decideOfflineAuthority(cache: AuthorityCache | null, now: number): OfflineAuthDecision {
  if (!cache || typeof cache.userId !== "string" || cache.userId === "" || !Number.isFinite(cache.cachedAt)) return { kind: "none" };
  const age = now - cache.cachedAt;
  // A clock that moved backwards (age < 0) is treated as expired rather than as an infinite lease.
  if (age < 0 || age >= OFFLINE_AUTH_TTL_MS) return { kind: "expired", cache };
  return { kind: "restore", cache };
}

function readLocal(): AuthorityCache | null {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(CONTEXT_CACHE_KEY) : null;
    return raw ? (JSON.parse(raw) as AuthorityCache) : null;
  } catch {
    return null;
  }
}

/** The authority cache: localStorage, else the durable IndexedDB mirror — whichever is NEWER (a stale
 *  copy can never shadow a fresher one). */
export async function readAuthorityCache(): Promise<AuthorityCache | null> {
  const local = readLocal();
  let mirror: AuthorityCache | null = null;
  try {
    const row = await localdb.snapshots.get(MIRROR_KEY);
    mirror = row ? (row.data as AuthorityCache) : null;
  } catch {
    mirror = null;
  }
  if (local && mirror) return (mirror.cachedAt ?? 0) > (local.cachedAt ?? 0) ? mirror : local;
  return local ?? mirror;
}

/** Write the authority cache to BOTH stores (call only after a FULL successful online load). */
export async function writeAuthorityCache(c: AuthorityCache): Promise<void> {
  try {
    localStorage.setItem(CONTEXT_CACHE_KEY, JSON.stringify(c));
  } catch {
    /* quota / unavailable — the durable mirror below still holds it */
  }
  const tenantId = (c.tenant as { id?: string } | null)?.id ?? "";
  await localdb.snapshots
    .put({ key: MIRROR_KEY, tenant_id: tenantId, branch_id: null, data: c, cached_at: new Date(c.cachedAt).toISOString() })
    .catch(() => undefined);
}

/** Sign-out: the authority must not survive in EITHER store. */
export async function clearAuthorityCache(): Promise<void> {
  try {
    localStorage.removeItem(CONTEXT_CACHE_KEY);
  } catch {
    /* ignore */
  }
  await localdb.snapshots.delete(MIRROR_KEY).catch(() => undefined);
}

/** True for a NETWORK-level auth failure (supabase-js AuthRetryableFetchError / a fetch TypeError),
 *  as opposed to a definitive refusal (wrong password, disabled user). */
export function isAuthTransportError(e: unknown): boolean {
  if (!e) return false;
  const name = (e as { name?: unknown }).name;
  const message = String((e as { message?: unknown }).message ?? e).toLowerCase();
  return (
    name === "AuthRetryableFetchError" ||
    name === "TypeError" ||
    message.includes("failed to fetch") ||
    message.includes("networkerror") ||
    message.includes("network request failed") ||
    message.includes("load failed")
  );
}
