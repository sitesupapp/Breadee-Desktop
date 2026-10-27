// 1.0.38 — the SEVEN CONFIRMED NATIVE DEFECTS (Product Owner, Breadee Staging 1.0.38 on Windows).
//
// GROUP A (Bugs 1 / 2 — offline sign-in / switch user): driven with the ENTITLEMENT ENFORCED exactly as the
// packaged app runs (fake native seal store + a real ES256 signer standing in for the Edge Function + a real
// P-256 device key), backend unreachable under the network sentinel. The root cause this pins: the signed
// entitlement lived ONLY in one device-wide active slot, was requested in the background after the sign-in
// returned, was erased on activation / sign-out, and one user's failed request backed off every user.
//
// GROUP B (Bug 3 — operation identity): the build stamp a Staging build puts on every captured operation.
//
// GROUP C (Bug 7 — Open table action) + the preservation gate of the shared Dine-In bill panel. Bugs 4 / 5 / 6
// run against the real capture / projection / replay engines in offline-1038-movemerge.test.ts.

import "fake-indexeddb/auto";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8");

const { signJws, b64uEncode, sha256Hex, deviceMessage, ENTITLEMENT_JWS_TYP } = await import("../docs/offline/edge-functions/desktop-entitlement/jws.ts");
const reach = await import("@/lib/offline/reachability");
const vault = await import("@/lib/security/offlineVault");
const native = await import("@/lib/security/native");
const da = await import("@/lib/security/deviceAuthority");
const { useSession, FIRST_SIGNIN_MESSAGE, WRONG_PASSWORD_MESSAGE, OFFLINE_ACCESS_MISSING_MESSAGE } = await import("@/state/session");
const { readAuthorityCache } = await import("@/lib/offline/offlineAuthority");
const { captureBuildStamp } = await import("@/lib/offline/operationLog");
const { buildEra } = await import("@/lib/offline/queueForensics");

const TEST_ITER = 20_000;
const TENANT = "t1";
const OU = "b-main";

// --- the signer (Edge Function stand-in) and this install's device key ---------------------------------
const signer = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
const signerJwk = await crypto.subtle.exportKey("jwk", signer.publicKey);
const KEYS = [{ kid: "staging-test0000", x: signerJwk.x as string, y: signerJwk.y as string }];
const devKp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
const devSpkiBytes = new Uint8Array(await crypto.subtle.exportKey("spki", devKp.publicKey));
const DEVICE = { spki: Buffer.from(devSpkiBytes).toString("base64"), fingerprint: await sha256Hex(devSpkiBytes) };

/** The sealed store survives a "restart" (it is the DPAPI files on disk); the in-memory caches do not. */
const sealed = new Map<string, string>();
const fakeNative: import("@/lib/security/native").SecurityNative = {
  available: () => true,
  devicePublicKey: async () => ({ spki: DEVICE.spki, fingerprint: DEVICE.fingerprint, provider: "software" }),
  deviceSign: async (r) => {
    const message = deviceMessage({ ...r, fingerprint: DEVICE.fingerprint });
    const s = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, devKp.privateKey, new TextEncoder().encode(message)));
    return { message, signature: b64uEncode(s), fingerprint: DEVICE.fingerprint };
  },
  sealSecret: async (name, value) => void sealed.set(name, value),
  unsealSecret: async (name) => sealed.get(name) ?? null,
  clearSecret: async (name) => void sealed.delete(name),
};

function claimsFor(userId: string, perms: Record<string, boolean>, iatMs = Date.now()) {
  const iat = Math.floor(iatMs / 1000);
  return {
    ver: 1, iss: "breadee-desktop-entitlement", env: "staging", sub: userId, email: `${userId}@example.test`, tenant_id: TENANT,
    role: "manager", branch_id: null, all_branches: true, branch_ids: [OU], main_branch_id: OU,
    permissions: perms, features: { pos: true }, device_fp: DEVICE.fingerprint, device_id: "dev-1", terminal_id: "till-1",
    iat, exp: iat + 7 * 24 * 3600, server_time_ms: iatMs, seq: 1,
  };
}
const entitlementFor = (userId: string, perms: Record<string, boolean>) => signJws({ typ: ENTITLEMENT_JWS_TYP, kid: KEYS[0].kid }, claimsFor(userId, perms) as Record<string, unknown>, signer.privateKey);

function ctx(userId: string, perms: Record<string, boolean>) {
  return {
    userId, email: `${userId}@example.test`, isPlatformUser: false,
    tenant: { id: TENANT, business_name: "Biz", tenant_status: "active", main_branch_id: OU },
    membership: { id: `m-${userId}`, tenant_id: TENANT, role: "manager", status: "active", branch_id: null, all_branches: true },
    features: { pos: true }, permissions: perms, currency: { primary: "LBP", rate: 89_500 }, cachedAt: Date.now(),
  };
}
const PERMS_A = { "pos.access": true, "pos.take_payments": true, "pos.tables.open": true };
const PERMS_B = { "pos.access": true, "pos.tables.open": true };

/** What an ONLINE sign-in of `userId` leaves in the vault after this fix: verifier + their own entitlement. */
async function provisionedOnline(userId: string, password: string, perms: Record<string, boolean>, withEntitlement = true) {
  await vault.recordOnlineAuthorization({ context: ctx(userId, perms) as never, email: `${userId}@example.test`, verifier: await vault.createVerifier(password, TEST_ITER) });
  if (withEntitlement) await vault.storeUserEntitlement(userId, await entitlementFor(userId, perms), Date.now());
}

/** App restart: every in-memory cache is gone; only sealed files + IndexedDB + localStorage remain. */
function restart() {
  vault.__resetOfflineVaultForTests();
  da.__resetDeviceAuthorityForTests();
  useSession.setState({ userId: null, offlineMode: false, loading: true, tenant: null, membership: null, permissions: {}, features: {}, captureLock: null, entitledBranchIds: null, authNotice: null });
}

beforeEach(async () => {
  (globalThis as unknown as { localStorage: MemStorage }).localStorage.clear();
  sealed.clear();
  native.__setSecurityNativeForTests(fakeNative);
  da.__setAppEnvForTests("staging");
  da.__setEntitlementKeysForTests(KEYS);
  restart();
  reach.__resetReachabilityForTests(async () => false);
  reach.markBackendUnreachable();
});

// ======================================================================== GROUP A — Bugs 1 / 2

test("BUG 1: provisioned online, app CLOSED before any switch (entitlement only in the user's own vault copy) → offline sign-in PASS, zero network", async () => {
  assert.equal(da.entitlementEnforced(), true, "the packaged app's enforced mode");
  await provisionedOnline("user-a", "pass-A-1", PERMS_A);
  restart(); // network OFF, cold start: no active authority, no active entitlement slot
  assert.equal(sealed.get("entitlement"), undefined, "the active slot is empty (the first-1.0.38 failure state)");
  const r = await expectNoNetwork(() => useSession.getState().signIn("user-a@example.test", "pass-A-1"));
  assert.deepEqual(r.result, { error: null });
  assert.deepEqual(r.calls.map((c) => `${c.api}:${c.name}`), [], "no network on the offline sign-in path");
  const s = useSession.getState();
  assert.equal(s.userId, "user-a");
  assert.equal(s.offlineMode, true);
  assert.deepEqual(s.entitledBranchIds, [OU], "scope from the VERIFIED signed claims");
  assert.equal(s.permissions["pos.take_payments"], true);
  assert.equal((await readAuthorityCache())?.userId, "user-a");
  // The user's copy is never consumed by activation: a later close + offline sign-in works again.
  assert.ok((await vault.getVaultUser("user-a"))?.parkedEntitlement, "entitlement copy kept while active");
});

test("BUG 1/2: A and B each provisioned online → close → network OFF → A offline, switch, B offline, restart, both again; C refused; wrong password refused", async () => {
  await provisionedOnline("user-a", "pass-A-1", PERMS_A);
  await provisionedOnline("user-b", "pass-B-1", PERMS_B);
  for (let round = 0; round < 2; round++) {
    restart();
    assert.equal((await useSession.getState().signIn("user-a@example.test", "pass-A-1")).error, null, `A round ${round}`);
    assert.equal(useSession.getState().permissions["pos.take_payments"], true);
    const sw = await expectNoNetwork(() => useSession.getState().switchUser());
    assert.deepEqual(sw.calls.map((c) => `${c.api}:${c.name}`), [], "offline switch user is local");
    const rb = await expectNoNetwork(() => useSession.getState().signIn("user-b@example.test", "pass-B-1"));
    assert.deepEqual(rb.result, { error: null }, `B round ${round}`);
    assert.equal(useSession.getState().userId, "user-b");
    assert.equal(useSession.getState().permissions["pos.take_payments"], undefined, "B never inherits A's grant");
    await useSession.getState().switchUser();
  }
  assert.equal((await useSession.getState().signIn("user-a@example.test", "pass-B-1")).error, WRONG_PASSWORD_MESSAGE);
  assert.equal((await useSession.getState().signIn("stranger@example.test", "x")).error, FIRST_SIGNIN_MESSAGE);
  const saved = await vault.listSavedUsers();
  assert.deepEqual(saved.map((u) => [u.userId, u.offlineReady]).sort(), [["user-a", true], ["user-b", true]]);
});

test("BUG 1: a saved user whose entitlement never reached the device gets an honest message (not 'expired'), no network, and is listed as needing an online sign-in", async () => {
  await provisionedOnline("user-a", "pass-A-1", PERMS_A, false);
  restart();
  const r = await expectNoNetwork(() => useSession.getState().signIn("user-a@example.test", "pass-A-1"));
  assert.deepEqual(r.result, { error: OFFLINE_ACCESS_MISSING_MESSAGE });
  assert.equal(useSession.getState().userId, null);
  assert.deepEqual((await vault.listSavedUsers()).map((u) => u.offlineReady), [false]);
});

test("BUG 1: Sign Out keeps the user's own offline sign-in (verifier + entitlement); Remove deletes it", async () => {
  await provisionedOnline("user-a", "pass-A-1", PERMS_A);
  restart();
  assert.equal((await useSession.getState().signIn("user-a@example.test", "pass-A-1")).error, null);
  await useSession.getState().signOut();
  assert.equal(useSession.getState().userId, null);
  const kept = await vault.getVaultUser("user-a");
  assert.ok(kept?.verifier && kept.parkedEntitlement, "Sign Out keeps the offline sign-in");
  restart();
  assert.equal((await useSession.getState().signIn("user-a@example.test", "pass-A-1")).error, null, "offline sign-in after Sign Out");
  await useSession.getState().forgetUser("user-a"); // the explicit Remove (here: of the active user)
  assert.equal(await vault.getVaultUser("user-a"), null);
  assert.equal((await useSession.getState().signIn("user-a@example.test", "pass-A-1")).error, FIRST_SIGNIN_MESSAGE);
});

test("BUG 2: switching never parks ANOTHER user's entitlement, and an empty active slot never erases a user's own copy", async () => {
  await provisionedOnline("user-a", "pass-A-1", PERMS_A);
  await provisionedOnline("user-b", "pass-B-1", PERMS_B);
  restart();
  await useSession.getState().signIn("user-a@example.test", "pass-A-1");
  const aJws = (await vault.getVaultUser("user-a"))?.parkedEntitlement;
  // A late answer for B lands in the ACTIVE slot while A is active (the race the per-user store removes).
  sealed.set("entitlement", (await vault.getVaultUser("user-b"))!.parkedEntitlement!);
  await useSession.getState().switchUser();
  assert.equal((await vault.getVaultUser("user-a"))?.parkedEntitlement, aJws, "A keeps A's entitlement, never B's");
  // parkUser with an empty slot keeps the copy.
  await vault.parkUser("user-b", { session: null, entitlement: null, entitlementReceivedAtMs: null });
  assert.ok((await vault.getVaultUser("user-b"))?.parkedEntitlement);
  // unpark (activation) keeps the copy too.
  await vault.unparkUser("user-b");
  assert.ok((await vault.getVaultUser("user-b"))?.parkedEntitlement);
});

test("BUG 1/2: entitlement issuance is PER USER — one user's failure never backs off another; a switched-out user's late answer goes to THEIR vault copy, not the active slot", async () => {
  const challengeUser = { id: "user-a" };
  const server = (fail: boolean) => ({
    status: async () => (fail ? null : { registered: true, revoked: false, membership_active: true, pos_access: true }),
    challenge: async () => ({ challenge_id: "00000000-0000-4000-8000-000000000001", nonce: "e".repeat(64), tenant_id: TENANT, user_id: challengeUser.id }),
    issue: async () => ({ entitlement: await entitlementFor(challengeUser.id, PERMS_A), server_time_ms: Date.now() }),
  });
  const failA = await da.refreshEntitlement({ userId: "user-a", tenantId: TENANT, terminalId: "t" }, { server: server(true) });
  assert.equal(failA.ok, false);
  assert.equal((await da.refreshEntitlement({ userId: "user-a", tenantId: TENANT, terminalId: "t" }, { server: server(false) })).ok, false, "A is backed off");
  challengeUser.id = "user-b";
  const issued: string[] = [];
  const okB = await da.refreshEntitlement(
    { userId: "user-b", tenantId: TENANT, terminalId: "t" },
    { server: server(false), isActive: () => false, onIssued: (jws) => void issued.push(jws) },
  );
  assert.equal(okB.ok, true, "B is NOT blocked by A's failure (was a device-wide 5-minute backoff)");
  assert.equal(issued.length, 1, "B's own copy is delivered");
  assert.equal(sealed.get("entitlement"), undefined, "a user who is no longer active never fills the active slot");
});

test("BUG 1: the ONLINE sign-in waits (bounded) for the offline provisioning; the switch path parks only verified own entitlements", () => {
  const src = read("src", "state", "session.ts");
  assert.match(src, /export const PROVISION_WAIT_MS = 10_000;/);
  assert.match(src, /await provisionOfflineAccess\(uid, get\(\)\.tenant\?\.id \?\? null\)/, "signIn awaits provisioning before returning");
  assert.match(src, /onIssued: \(jws, at\) => vault\.storeUserEntitlement\(userId, jws, at\)/, "every issuance is the user's own vault copy");
  assert.match(src, /isActive: \(\) => useSession\.getState\(\)\.userId === userId/);
  assert.doesNotMatch(src, /Sign Out also removes this user's offline sign-in/);
});

// ======================================================================== GROUP B — Bug 3

test("BUG 3: every operation a Staging build captures carries a build stamp (SHA, else app version) → classified CURRENT, never rc.8/9", () => {
  assert.equal(captureBuildStamp("79d60e83a2f4", "1.0.38"), "79d60e83a2f4");
  assert.equal(captureBuildStamp("", "1.0.38"), "v1.0.38");
  assert.equal(captureBuildStamp(undefined, "0.0.0"), null);
  const stamp = captureBuildStamp("", "1.0.38");
  assert.equal(buildEra(stamp, stamp), "CURRENT");
  assert.equal(buildEra(null, stamp), "HISTORICAL_RC8_RC9", "a genuinely unstamped capture stays historical");
  assert.equal(buildEra("v1.0.37", "v1.0.38"), "OTHER_BUILD");
  const wf = read(".github", "workflows", "desktop-staging-release.yml");
  assert.equal((wf.match(/VITE_BUILD_SHA: \$\{\{ github\.sha \}\}/g) ?? []).length, 2, "both staging build steps inject the build SHA");
  assert.match(read("src", "main.tsx"), /setCaptureBuild\(captureBuildStamp\(env\.BUILD_SHA, env\.APP_VERSION\)\)/);
});

// ======================================================================== GROUP C — Bug 7 + preservation gate

test("BUG 7: the bill panel offers Open table for a selected table with no open bill even when no bill object is known; offline it reads the table's OWN projection", () => {
  const panel = read("src", "components", "pos", "TableBillPanel.tsx");
  assert.match(panel, /const noOpenBill = table != null && \(bill \? bill\.orders\.length === 0 : !props\.loading && !props\.error\);/);
  assert.match(panel, /\{noOpenBill && props\.openGate\.allowed && \(/);
  assert.match(panel, /\{noOpenBill && !props\.openGate\.allowed && props\.openGate\.reason && \(/, "a blocked open always says why");
  const ws = read("src", "screens", "pos", "DineInWorkspace.tsx");
  assert.match(ws, /bill=\{offlineCapture \? \(selectedProj \? selectedProj\.bill : null\) : tables\.bill\}/, "offline: the selected table's own projection (never another table's stale bill)");
  assert.doesNotMatch(ws, /bill=\{offlineCapture \? \(offlineBill \?\? tables\.bill\) : tables\.bill\}\s*loading=\{offlineCapture \? false : tables\.billLoading\}\s*error=\{offlineCapture \? null : tables\.billError\}\s*openGate=/, "the table panel no longer falls back to the server / another table's bill");
  // The open gate itself is unchanged (permission, shift, table eligibility, offline readiness).
  assert.match(ws, /const base = canOpenTable\(pos\.access, hasOpenShift\);/);
  assert.match(ws, /if \(!isOpenable\(selected\)\) return \{ allowed: false, reason: "This table already has an open bill\." \};/);
});

test("PRESERVATION: every approved Dine-In bill-panel control is still rendered, behind its unchanged gate", () => {
  const panel = read("src", "components", "pos", "TableBillPanel.tsx");
  for (const [label, wiring] of [
    ["Open table", /onClick=\{props\.onOpenTable\}/],
    ["Open shift", /onClick=\{props\.onOpenShift\}/],
    ["Pay Full Bill", /gate=\{props\.payGate\}[^>]*onClick=\{props\.onPay\}/],
    ["Split Bill", /gate=\{props\.splitGate\}[^>]*onClick=\{props\.onSplit\}/],
    ["Add Items", /onClick=\{props\.onAddItems\}/],
    ["Print", /onClick=\{props\.onPrintBill\}/],
    ["Move", /gate=\{props\.moveGate\}[^>]*onClick=\{props\.onMove\}/],
    ["Close", /gate=\{props\.closeGate\}[^>]*onClick=\{props\.onClose\}/],
    ["Merge", /gate=\{props\.mergeGate\}[^>]*onClick=\{props\.onMerge\}/],
    ["Clear", /onClick=\{props\.onClear\}/],
  ] as const) {
    assert.match(panel, wiring, `${label} control present`);
  }
  const ws = read("src", "screens", "pos", "DineInWorkspace.tsx");
  for (const prop of ["openGate={openGate}", "addItemsGate={addItemsGate}", "moveGate={opGates.move}", "mergeGate={opGates.merge}", "payGate={payGate}", "splitGate={splitGate}", "onPrintBill={() => void printBill()}"]) {
    assert.ok(ws.includes(prop), `bill panel wiring kept: ${prop}`);
  }
  // Open Tables / Orders / Drawer surfaces are still wired.
  const pos = read("src", "screens", "pos", "PosWorkspace.tsx");
  assert.match(pos, /label: "Open Tables"/);
  assert.match(pos, /<OpenTablesModal/);
  assert.match(pos, /<OrdersModal/);
  assert.match(read("src", "components", "pos", "PosStatusBar.tsx"), /drawerVisible/);
});

test("BUG 6: Open Tables and its rail count read the SAME effective floor the Dine-In map renders (no second calculation over the raw map)", () => {
  const pos = read("src", "screens", "pos", "PosWorkspace.tsx");
  assert.match(pos, /const effectiveTables = dineIn\.effectiveTables;/);
  assert.match(pos, /selectOpenTables\(effectiveTables\)\.length/);
  assert.match(pos, /tables=\{effectiveTables\}/);
  assert.doesNotMatch(pos, /selectOpenTables\(tableStore\.map\.tables\)/);
  assert.match(read("src", "screens", "pos", "DineInWorkspace.tsx"), /effectiveTables: displayMap\.tables,/);
});

test("BUG 5: an offline quantity INCREASE of a sent line is a new round (never the version-checked line edit); decrease / remove stay audited edits", () => {
  const ws = read("src", "screens", "pos", "DineInWorkspace.tsx");
  assert.match(ws, /if \(newQuantity > line\.quantity\) \{\s*await sendExtraQuantityOffline\(line, newQuantity - line\.quantity\);\s*return;\s*\}/);
  assert.match(ws, /const extraLine = additionalRoundLineFor\(line, extra, sentLocal\);/);
  assert.match(ws, /if \(!input\.offlineScope \|\| !selected \|\| roundInFlight\.current\) return;/, "one click = one round (shared in-flight latch)");
  assert.match(ws, /if \(next < line\.quantity\) setReasonPrompt\(\{ kind: "quantity", line, newQuantity: next \}\);/, "a reduction stays audited");
});
