// Offline-first recovery — Bug 01 / Domain 1: per-user LOCAL-FIRST sign-in.
//
// Driven with the backend unreachable under the network sentinel (every Supabase / fetch use is
// recorded): a user who signed in online on this device signs in again with ZERO network attempts, two
// saved users each get ONLY their own authority, Switch User parks without loss, wrong passwords back
// off, an expired authority and a never-provisioned user are refused with controlled messages, and the
// cold-start restore renders without touching the network. Real session store, real vault, real Dexie
// (fake-indexeddb), real reachability store.

import "fake-indexeddb/auto";
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { registerSentinelHook, installFetchSentinel, expectNoNetwork } from "./support/networkSentinel.ts";

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? (this.m.get(k) as string) : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  get length() { return this.m.size; }
}
(globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage();

registerSentinelHook();
installFetchSentinel();

const reach = await import("@/lib/offline/reachability");
const vault = await import("@/lib/security/offlineVault");
const { useSession, FIRST_SIGNIN_MESSAGE, WRONG_PASSWORD_MESSAGE } = await import("@/state/session");
const { REAUTH_MESSAGE, readAuthorityCache } = await import("@/lib/offline/offlineAuthority");
const { canSeeDrawer } = await import("@/lib/pos/offlineDrawer");
const { timingSamples, clearTimings } = await import("@/lib/perf/timings");

const DAY = 24 * 60 * 60 * 1000;
const TEST_ITER = 20_000; // the shipped cost is VERIFIER_ITERATIONS; a lower one keeps the suite fast

function ctx(userId: string, tenantId: string, perms: Record<string, boolean>, cachedAt = Date.now()) {
  return {
    userId,
    email: `${userId}@example.test`,
    isPlatformUser: false,
    tenant: { id: tenantId, business_name: `Biz ${tenantId}`, tenant_status: "active", main_branch_id: "b-main" },
    membership: { id: `m-${userId}`, tenant_id: tenantId, role: "manager", status: "active", branch_id: null, all_branches: true },
    features: { pos: true },
    permissions: perms,
    currency: { primary: "USD", rate: null },
    cachedAt,
  };
}

async function provision(userId: string, password: string, tenantId: string, perms: Record<string, boolean>, cachedAt?: number) {
  await vault.recordOnlineAuthorization({ context: ctx(userId, tenantId, perms, cachedAt) as never, email: `${userId}@example.test`, verifier: await vault.createVerifier(password, TEST_ITER) });
}

before(async () => {
  reach.__resetReachabilityForTests(async () => false);
  reach.markBackendUnreachable();
});

beforeEach(async () => {
  (globalThis as unknown as { localStorage: MemStorage }).localStorage.clear();
  vault.__resetOfflineVaultForTests();
  useSession.setState({ userId: null, offlineMode: false, tenant: null, membership: null, permissions: {}, features: {}, captureLock: null, entitledBranchIds: null });
  reach.markBackendUnreachable();
  await provision("user-a", "pass-A-1", "t1", { "pos.access": true, "pos.take_payments": true, "pos.view_orders": true });
  await provision("user-b", "pass-B-1", "t1", { "pos.access": true, "pos.view_orders": true });
});

test("a provisioned user signs in OFFLINE locally with zero network attempts, quickly, with only their own authority", async () => {
  clearTimings();
  const run = await expectNoNetwork(() => useSession.getState().signIn("USER-A@example.test", "pass-A-1"));
  assert.equal(run.error, null);
  assert.deepEqual(run.result, { error: null });
  assert.deepEqual(run.calls.map((c) => `${c.api}:${c.name}`), [], "no network on the offline sign-in path");
  const s = useSession.getState();
  assert.equal(s.userId, "user-a");
  assert.equal(s.offlineMode, true);
  assert.equal(s.tenant?.id, "t1");
  assert.equal(s.permissions["pos.take_payments"], true);
  assert.equal(canSeeDrawer(s.permissions, true), true, "Drawer available offline for a permitted user");
  const t = timingSamples().filter((x) => x.name === "auth.local_signin");
  assert.equal(t.length, 1);
  assert.ok(t[0].ms < 2000, `local sign-in took ${t[0].ms} ms`);
  // The active authority is A's own snapshot (anchor unchanged).
  assert.equal((await readAuthorityCache())?.userId, "user-a");
});

test("wrong password offline is refused; repeated failures back off; the right password still works after the lock", async () => {
  const r1 = await useSession.getState().signIn("user-a@example.test", "nope");
  assert.equal(r1.error, WRONG_PASSWORD_MESSAGE);
  assert.equal(useSession.getState().userId, null);
  for (let i = 0; i < 4; i++) await useSession.getState().signIn("user-a@example.test", "nope");
  const locked = await useSession.getState().signIn("user-a@example.test", "pass-A-1");
  assert.match(String(locked.error), /Too many incorrect attempts/);
  assert.equal(useSession.getState().userId, null, "no sign-in while locked, even with the right password");
  const u = await vault.getVaultUser("user-a");
  assert.ok(u && vault.lockRemainingMs(u) > 0);
  // Lock expiry (simulated) → the right password works and resets the counter.
  await vault.resetFailedAttempts("user-a");
  const ok = await useSession.getState().signIn("user-a@example.test", "pass-A-1");
  assert.equal(ok.error, null);
});

test("Switch User parks A without loss; B signs in offline and sees ONLY B's authority (no A leakage)", async () => {
  await useSession.getState().signIn("user-a@example.test", "pass-A-1");
  // A live session in A's slot (as after an online sign-in) must be parked, not lost.
  localStorage.setItem("breadee-desktop-auth", JSON.stringify({ access_token: "a-token", refresh_token: "a-refresh", user: { id: "user-a" } }));
  const sw = await expectNoNetwork(() => useSession.getState().switchUser());
  assert.deepEqual(sw.calls.map((c) => `${c.api}:${c.name}`), [], "switch user is local");
  assert.equal(useSession.getState().userId, null);
  assert.equal(localStorage.getItem("breadee-desktop-auth"), null, "the active auth slot is emptied");
  assert.equal(await readAuthorityCache(), null, "the active authority is cleared");
  const parkedA = await vault.getVaultUser("user-a");
  assert.match(String(parkedA?.parkedSession), /a-refresh/, "A's session is parked in A's own vault record");
  assert.ok(parkedA?.verifier, "A can still sign in offline later");

  const rb = await expectNoNetwork(() => useSession.getState().signIn("user-b@example.test", "pass-B-1"));
  assert.deepEqual(rb.result, { error: null });
  assert.deepEqual(rb.calls.map((c) => `${c.api}:${c.name}`), []);
  const s = useSession.getState();
  assert.equal(s.userId, "user-b");
  assert.equal(s.permissions["pos.take_payments"], undefined, "B never inherits A's financial grant");
  assert.equal(canSeeDrawer(s.permissions, true), false, "Drawer stays unavailable offline for an unpermitted user");
  assert.equal(localStorage.getItem("breadee-desktop-auth"), null, "B's slot does not carry A's session");
  // A's password does not open B, and B's does not open A.
  await useSession.getState().switchUser();
  assert.equal((await useSession.getState().signIn("user-b@example.test", "pass-A-1")).error, WRONG_PASSWORD_MESSAGE);
  assert.equal((await useSession.getState().signIn("user-a@example.test", "pass-B-1")).error, WRONG_PASSWORD_MESSAGE);
  // Switching back to A restores A's parked session into the active slot.
  assert.equal((await useSession.getState().signIn("user-a@example.test", "pass-A-1")).error, null);
  assert.match(String(localStorage.getItem("breadee-desktop-auth")), /a-refresh/);
  assert.equal((await vault.getVaultUser("user-a"))?.parkedSession, null, "unparked once active");
});

test("a user who never signed in online on this device gets the FIRST SECURE SIGN-IN message, without a network attempt", async () => {
  const r = await expectNoNetwork(() => useSession.getState().signIn("stranger@example.test", "x"));
  assert.deepEqual(r.result, { error: FIRST_SIGNIN_MESSAGE });
  assert.deepEqual(r.calls.filter((c) => c.api !== "fetch").map((c) => `${c.api}:${c.name}`), [], "no auth / PostgREST attempt");
});

test("an authority older than the 7-day window is refused offline (re-authorization required)", async () => {
  await provision("user-c", "pass-C-1", "t1", { "pos.access": true }, Date.now() - 8 * DAY);
  const r = await useSession.getState().signIn("user-c@example.test", "pass-C-1");
  assert.equal(r.error, REAUTH_MESSAGE);
  assert.equal(useSession.getState().userId, null);
});

test("the vault never stores a password; the verifier is salted per user", async () => {
  const raw = String(localStorage.getItem("breadee-desktop-secure:offline-vault"));
  assert.ok(!raw.includes("pass-A-1") && !raw.includes("pass-B-1"), "no plaintext password");
  const a = await vault.getVaultUser("user-a");
  const b = await vault.getVaultUser("user-b");
  assert.notEqual(a?.verifier?.salt, b?.verifier?.salt);
  assert.equal(await vault.checkVerifier(a!.verifier!, "pass-A-1"), true);
  assert.equal(await vault.checkVerifier(a!.verifier!, "pass-A-2"), false);
});

test("cold start with an active, valid authority restores the workspace without any network attempt", async () => {
  await useSession.getState().signIn("user-a@example.test", "pass-A-1");
  useSession.setState({ userId: null, offlineMode: false, loading: true });
  clearTimings();
  const r = await expectNoNetwork(() => useSession.getState().init());
  assert.deepEqual(r.calls.map((c) => `${c.api}:${c.name}`), [], "no network on the cold-start restore path");
  const s = useSession.getState();
  assert.equal(s.userId, "user-a");
  assert.equal(s.loading, false);
  assert.equal(s.offlineMode, true);
  const t = timingSamples().filter((x) => x.name === "startup.authority_restore");
  assert.equal(t.length, 1);
});

test("1.0.38 (native Bug 1) — Sign Out KEEPS the user's offline sign-in; Remove (forgetUser) deletes only that user's", async () => {
  await useSession.getState().signIn("user-a@example.test", "pass-A-1");
  await useSession.getState().signOut();
  assert.ok((await vault.getVaultUser("user-a"))?.verifier, "Sign Out keeps A's offline sign-in");
  assert.equal((await useSession.getState().signIn("user-a@example.test", "pass-A-1")).error, null, "A signs in again offline");
  await useSession.getState().switchUser();
  await useSession.getState().forgetUser("user-a");
  assert.equal(await vault.getVaultUser("user-a"), null);
  assert.ok(await vault.getVaultUser("user-b"));
  assert.equal((await useSession.getState().signIn("user-a@example.test", "pass-A-1")).error, FIRST_SIGNIN_MESSAGE);
  assert.equal((await useSession.getState().signIn("user-b@example.test", "pass-B-1")).error, null);
});
