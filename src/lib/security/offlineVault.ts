// Offline-first recovery — the PER-USER OFFLINE SIGN-IN VAULT.
//
// Through 1.0.38 the device held ONE offline authority (the last signed-in user) and Sign Out erased
// it, so a second cashier — or the same cashier after signing out — could never sign in offline. The
// vault keeps one record per user who has signed in ONLINE on this device:
//
//   * a password VERIFIER (PBKDF2-SHA256, per-user random salt) — never the password;
//   * the authority snapshot of their last full online authorization (role / tenant / OU / features /
//     permissions / currency; `cachedAt` = that authorization, the 7-day window's anchor);
//   * while the user is NOT the active one: their PARKED Supabase session and signed entitlement, so
//     switching back (or replaying their captured work) never needs their password online again.
//
// The whole document is sealed with Windows DPAPI under the closed seal name "offline-vault" (Rust
// allowlist), bound to this app identity and Windows user — copying the file to another machine or
// profile yields nothing. Outside the packaged app (vite dev, node tests) it is plain localStorage,
// exactly like the other sealed secrets' dev fallback.
//
// Nothing here ever touches an operation, shift, draft or history row.

import { securityNative } from "@/lib/security/native";
import type { AuthorityCache } from "@/lib/offline/offlineAuthority";

const DEV_KEY = "breadee-desktop-secure:offline-vault";
/** OWASP-range PBKDF2-SHA256 cost; the blob is additionally DPAPI-sealed to this device + user. */
export const VERIFIER_ITERATIONS = 210_000;
/** Wrong passwords tolerated before a back-off lock; the lock doubles per further failure (max 15 min). */
export const FREE_ATTEMPTS = 5;
const LOCK_BASE_MS = 30_000;
const LOCK_MAX_MS = 15 * 60_000;

export type VaultVerifier = { alg: "PBKDF2-SHA256"; iter: number; salt: string; hash: string };

export type VaultUser = {
  userId: string;
  /** Lower-cased sign-in email (the lookup key on the sign-in screen). */
  email: string;
  tenantId: string | null;
  tenantName: string | null;
  /** The authority snapshot of the last FULL online authorization. */
  context: AuthorityCache;
  verifier: VaultVerifier | null;
  /** Supabase session JSON, present only while this user is parked (not the active user). */
  parkedSession: string | null;
  parkedEntitlement: string | null;
  parkedEntitlementReceivedAtMs: number | null;
  failedAttempts: number;
  lockedUntilMs: number;
  updatedAt: number;
};

type VaultDoc = { v: 1; users: Record<string, VaultUser> };

export type SavedUser = {
  userId: string;
  email: string;
  tenantName: string | null;
  /** The user has a verifier, i.e. can sign in with a password offline. */
  offlineReady: boolean;
};

// --- storage --------------------------------------------------------------------------------

let cache: VaultDoc | null = null;
let chain: Promise<unknown> = Promise.resolve();

async function readRaw(): Promise<string | null> {
  const n = securityNative();
  if (n.available()) return n.unsealSecret("offline-vault");
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem(DEV_KEY) : null;
  } catch {
    return null;
  }
}

async function writeRaw(value: string): Promise<void> {
  const n = securityNative();
  if (n.available()) return n.sealSecret("offline-vault", value);
  try {
    localStorage.setItem(DEV_KEY, value);
  } catch {
    /* dev only */
  }
}

function parse(raw: string | null): VaultDoc {
  try {
    const d = raw ? (JSON.parse(raw) as VaultDoc) : null;
    if (d && d.v === 1 && d.users && typeof d.users === "object") return d;
  } catch {
    /* unreadable = empty vault (never throws a cashier out of the app) */
  }
  return { v: 1, users: {} };
}

async function load(): Promise<VaultDoc> {
  if (cache) return cache;
  let raw: string | null = null;
  try {
    raw = await readRaw();
  } catch {
    raw = null;
  }
  cache = parse(raw);
  return cache;
}

/** Serialized read-modify-write: concurrent callers never lose each other's change. */
function mutate<T>(fn: (doc: VaultDoc) => T): Promise<T> {
  const run = chain.then(async () => {
    const doc = await load();
    const out = fn(doc);
    await writeRaw(JSON.stringify(doc));
    return out;
  });
  chain = run.catch(() => undefined);
  return run;
}

// --- verifier -------------------------------------------------------------------------------

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function derive(password: string, salt: Uint8Array<ArrayBuffer>, iter: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password.normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256);
  return new Uint8Array(bits);
}

export async function createVerifier(password: string, iter = VERIFIER_ITERATIONS): Promise<VaultVerifier> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { alg: "PBKDF2-SHA256", iter, salt: b64(salt), hash: b64(await derive(password, salt, iter)) };
}

export async function checkVerifier(v: VaultVerifier, password: string): Promise<boolean> {
  if (v.alg !== "PBKDF2-SHA256" || !Number.isInteger(v.iter) || v.iter < 10_000) return false;
  const got = await derive(password, unb64(v.salt), v.iter);
  const want = unb64(v.hash);
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i];
  return diff === 0;
}

// --- queries --------------------------------------------------------------------------------

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function listSavedUsers(): Promise<SavedUser[]> {
  const doc = await load();
  return Object.values(doc.users)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((u) => ({ userId: u.userId, email: u.email, tenantName: u.tenantName, offlineReady: u.verifier !== null }));
}

export async function getVaultUser(userId: string): Promise<VaultUser | null> {
  const doc = await load();
  return doc.users[userId] ?? null;
}

export async function findVaultUserByEmail(email: string): Promise<VaultUser | null> {
  const doc = await load();
  const e = normalizeEmail(email);
  return Object.values(doc.users).find((u) => u.email === e) ?? null;
}

/** Remaining lock time for a user after repeated wrong passwords (0 = not locked). */
export function lockRemainingMs(u: Pick<VaultUser, "lockedUntilMs">, nowMs = Date.now()): number {
  return Math.max(0, (u.lockedUntilMs ?? 0) - nowMs);
}

// --- writes ---------------------------------------------------------------------------------

/**
 * After a FULL successful online authorization: record / refresh the user's authority snapshot and,
 * when the password was just proven to the server, its verifier. A changed password simply replaces
 * the verifier. Parked fields are left as they are (the caller decides whether the user is active).
 */
export async function recordOnlineAuthorization(input: {
  context: AuthorityCache;
  email: string | null;
  verifier?: VaultVerifier | null;
}): Promise<void> {
  const tenant = input.context.tenant as { id?: string; business_name?: string } | null;
  await mutate((doc) => {
    const prev = doc.users[input.context.userId];
    doc.users[input.context.userId] = {
      userId: input.context.userId,
      email: normalizeEmail(input.email ?? prev?.email ?? ""),
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.business_name ?? null,
      context: input.context,
      verifier: input.verifier !== undefined ? input.verifier : prev?.verifier ?? null,
      parkedSession: prev?.parkedSession ?? null,
      parkedEntitlement: prev?.parkedEntitlement ?? null,
      parkedEntitlementReceivedAtMs: prev?.parkedEntitlementReceivedAtMs ?? null,
      failedAttempts: input.verifier ? 0 : prev?.failedAttempts ?? 0,
      lockedUntilMs: input.verifier ? 0 : prev?.lockedUntilMs ?? 0,
      updatedAt: Date.now(),
    };
  });
}

/** The password was just proven to the server: (re)place the user's verifier and clear any lock. */
export async function setVerifier(userId: string, verifier: VaultVerifier): Promise<void> {
  await mutate((doc) => {
    const u = doc.users[userId];
    if (!u) return;
    u.verifier = verifier;
    u.failedAttempts = 0;
    u.lockedUntilMs = 0;
  });
}

/** A permission / feature refresh (not a re-authentication): update the snapshot, keep its anchor. */
export async function updateVaultContext(userId: string, patch: Partial<AuthorityCache>): Promise<void> {
  await mutate((doc) => {
    const u = doc.users[userId];
    if (u) u.context = { ...u.context, ...patch };
  });
}

/** Park a user (switch user): keep their session + entitlement sealed in the vault. */
export async function parkUser(userId: string, parked: { session: string | null; entitlement: string | null; entitlementReceivedAtMs: number | null }): Promise<void> {
  await mutate((doc) => {
    const u = doc.users[userId];
    if (!u) return;
    u.parkedSession = parked.session;
    u.parkedEntitlement = parked.entitlement;
    u.parkedEntitlementReceivedAtMs = parked.entitlementReceivedAtMs;
    u.updatedAt = Date.now();
  });
}

/** Activate a parked user: hand back their parked session + entitlement and clear the parked copy. */
export async function unparkUser(userId: string): Promise<{ session: string | null; entitlement: string | null; entitlementReceivedAtMs: number | null }> {
  return mutate((doc) => {
    const u = doc.users[userId];
    const out = { session: u?.parkedSession ?? null, entitlement: u?.parkedEntitlement ?? null, entitlementReceivedAtMs: u?.parkedEntitlementReceivedAtMs ?? null };
    if (u) {
      u.parkedSession = null;
      u.parkedEntitlement = null;
      u.parkedEntitlementReceivedAtMs = null;
      u.updatedAt = Date.now();
    }
    return out;
  });
}

/** A parked user's session was refreshed (token rotation) by a background replay: keep the new one. */
export async function updateParkedSession(userId: string, session: string | null): Promise<void> {
  await mutate((doc) => {
    const u = doc.users[userId];
    if (u && u.parkedSession !== null) u.parkedSession = session;
  });
}

export async function recordFailedAttempt(userId: string, nowMs = Date.now()): Promise<number> {
  return mutate((doc) => {
    const u = doc.users[userId];
    if (!u) return 0;
    u.failedAttempts = (u.failedAttempts ?? 0) + 1;
    const over = u.failedAttempts - FREE_ATTEMPTS;
    if (over >= 0) u.lockedUntilMs = nowMs + Math.min(LOCK_MAX_MS, LOCK_BASE_MS * 2 ** over);
    return lockRemainingMs(u, nowMs);
  });
}

export async function resetFailedAttempts(userId: string): Promise<void> {
  await mutate((doc) => {
    const u = doc.users[userId];
    if (u && (u.failedAttempts !== 0 || u.lockedUntilMs !== 0)) {
      u.failedAttempts = 0;
      u.lockedUntilMs = 0;
    }
  });
}

/** The server no longer accepts this identity (revoked / deleted / banned / password changed). */
export async function invalidateVaultUser(userId: string): Promise<void> {
  await mutate((doc) => {
    const u = doc.users[userId];
    if (!u) return;
    u.verifier = null;
    u.parkedSession = null;
    u.parkedEntitlement = null;
    u.parkedEntitlementReceivedAtMs = null;
  });
}

/** Remove a user from this device entirely. */
export async function forgetVaultUser(userId: string): Promise<void> {
  await mutate((doc) => {
    delete doc.users[userId];
  });
}

/** Every tenant a saved user of this device belongs to (their cached POS data must be kept). */
export async function vaultTenantIds(): Promise<Set<string>> {
  const doc = await load();
  return new Set(Object.values(doc.users).map((u) => u.tenantId).filter((t): t is string => typeof t === "string" && t !== ""));
}

/** Users (other than `exceptUserId`) parked with a session — candidates for a background replay. */
export async function parkedUsersWithSession(exceptUserId: string | null): Promise<VaultUser[]> {
  const doc = await load();
  return Object.values(doc.users).filter((u) => u.userId !== exceptUserId && typeof u.parkedSession === "string" && u.parkedSession !== "");
}

/** Test seam: forget the in-memory copy (the next call re-reads storage). */
export function __resetOfflineVaultForTests(): void {
  cache = null;
  chain = Promise.resolve();
}
