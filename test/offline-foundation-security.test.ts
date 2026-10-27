// Final Foundation (Tracks 4/5/6/12) - adversarial tests for the device-bound offline
// authority. Every attack must FAIL CLOSED (no offline authority / capture lock /
// controlled refusal) and no local tampering may ever become server authority.
//
// Real crypto throughout: a test ES256 signer stands in for the Edge Function (same
// signJws + deviceMessage code that is deployed), and a test P-256 key pair stands in
// for the Windows device key (same r||s P1363 format NCryptSignHash returns).

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { signJws, deviceMessage, verifyDeviceSignature, b64uEncode, sha256Hex, ENTITLEMENT_JWS_TYP as EDGE_TYP, SELFTEST_JWS_TYP } from "../docs/offline/edge-functions/desktop-entitlement/jws.ts";
import { verifyEntitlement, overlayAuthorityWithEntitlement, isBranchEntitled, ENTITLEMENT_JWS_TYP, type EntitlementClaims } from "@/lib/security/entitlement";
import { observeClock, trustServerTime, freshTimeGuard, parseTimeGuard, ROLLBACK_TOLERANCE_MS } from "@/lib/security/clockGuard";
import { applyCaptureLock, VIEW_ONLY_PERMISSIONS } from "@/lib/security/captureLock";
import { createSealedAuthStorage, AUTH_STORAGE_KEY } from "@/lib/security/sealedAuthStorage";
import { __setSecurityNativeForTests, type SecurityNative, type SealName } from "@/lib/security/native";
import {
  __resetDeviceAuthorityForTests,
  __setAppEnvForTests,
  __setEntitlementKeysForTests,
  checkDeviceStanding,
  entitlementEnforced,
  observeDeviceClock,
  readStoredEntitlement,
  refreshEntitlement,
  signableTerminalId,
  verifyStoredEntitlement,
  type EntitlementServer,
} from "@/lib/security/deviceAuthority";
import { ENTITLEMENT_PUBLIC_KEYS } from "@/lib/security/entitlementKeys";
import { decideOfflineAuthority } from "@/lib/offline/offlineAuthority";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8");

const DAY = 24 * 60 * 60 * 1000;
const TENANT = "d735104d-ed3c-4d58-9148-f1a82e94d418";
const OTHER_TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "f1ac0885-26d5-498b-9175-b3734344ed07";
const OU = "a5469a61-2504-40e5-bc45-187b1bd4a2fa";
const FOREIGN_OU = "b323db56-15bd-48eb-9656-9bcc799e6a7f";
const T0 = Date.UTC(2026, 9, 27, 8, 0, 0);

// --- test signer (stands in for the Edge Function's Vault key) -------------------------
const signer = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
const signerJwk = await crypto.subtle.exportKey("jwk", signer.publicKey);
const KEYS = [{ kid: "staging-test0000", x: signerJwk.x as string, y: signerJwk.y as string }];
const rogue = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;

// --- test device key (stands in for the CNG key) ---------------------------------------
async function makeDevice() {
  const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const spkiBytes = new Uint8Array(await crypto.subtle.exportKey("spki", kp.publicKey));
  const spki = Buffer.from(spkiBytes).toString("base64");
  return { kp, spki, fingerprint: await sha256Hex(spkiBytes) };
}
const deviceA = await makeDevice();
const deviceB = await makeDevice();

function claims(over: Partial<EntitlementClaims> = {}): EntitlementClaims {
  const iat = Math.floor(T0 / 1000);
  return {
    ver: 1, iss: "breadee-desktop-entitlement", env: "staging", sub: USER, email: "c@x", tenant_id: TENANT,
    role: "cashier", branch_id: OU, all_branches: false, branch_ids: [OU], main_branch_id: OU,
    permissions: { "pos.access": true, "pos.create_orders": true, "pos.take_payments": true, "pos.open_shift": true, "pos.view_orders": true, "pos.refunds": false },
    features: { pos: true }, device_fp: deviceA.fingerprint, device_id: "dev-1", terminal_id: "till-1",
    iat, exp: iat + 7 * 24 * 3600, server_time_ms: T0, seq: 1, ...over,
  };
}
const sign = (c: object, key: CryptoKey = signer.privateKey, header: Record<string, unknown> = { typ: EDGE_TYP, kid: KEYS[0].kid }) =>
  signJws(header, c as Record<string, unknown>, key);
const ctx = (over: Record<string, unknown> = {}) => ({ env: "staging" as const, deviceFingerprint: deviceA.fingerprint, userId: USER, tenantId: TENANT, effectiveNowMs: T0 + DAY, keys: KEYS, ...over });

// ============================================================ signature + binding

test("a genuine entitlement verifies on the device it was issued to", async () => {
  const r = await verifyEntitlement(await sign(claims()), ctx());
  assert.equal(r.ok, true);
  assert.equal(EDGE_TYP, ENTITLEMENT_JWS_TYP, "edge + client agree on the JWS typ");
});

test("ATTACK edited cached role/permissions: the restored authority comes from the SIGNED claims", async () => {
  const r = await verifyEntitlement(await sign(claims()), ctx());
  assert.ok(r.ok);
  const tamperedCache = {
    userId: USER, tenant: { id: TENANT }, features: { everything: true },
    membership: { tenant_id: TENANT, role: "owner", branch_id: null, all_branches: true, status: "active" },
    permissions: { "pos.access": true, "pos.refunds": true, "pos.close_other_shifts": true, "pos.approve_shifts": true },
  };
  const restored = overlayAuthorityWithEntitlement(tamperedCache, r.claims);
  const m = restored.membership as Record<string, unknown>;
  assert.equal(m.role, "cashier");
  assert.equal(m.all_branches, false);
  assert.equal(m.branch_id, OU);
  assert.equal(restored.permissions["pos.refunds"], false);
  assert.equal(restored.permissions["pos.close_other_shifts"], undefined);
  assert.deepEqual(restored.features, { pos: true });
});

test("ATTACK tampered entitlement payload / signature / key / alg / typ fails closed", async () => {
  const jws = await sign(claims());
  const [h, , s] = jws.split(".");
  const forgedPayload = b64uEncode(new TextEncoder().encode(JSON.stringify(claims({ role: "owner", all_branches: true, branch_ids: [OU, FOREIGN_OU] }))));
  assert.deepEqual(await verifyEntitlement(`${h}.${forgedPayload}.${s}`, ctx()), { ok: false, reason: "bad_signature" });
  const sigBytes = Buffer.from(s, "base64url");
  sigBytes[10] ^= 1;
  assert.deepEqual(await verifyEntitlement(`${h}.${jws.split(".")[1]}.${sigBytes.toString("base64url")}`, ctx()), { ok: false, reason: "bad_signature" });
  // Signed by a key the app does not embed (forged signer), same kid:
  assert.deepEqual(await verifyEntitlement(await sign(claims(), rogue.privateKey), ctx()), { ok: false, reason: "bad_signature" });
  // Unknown kid:
  assert.deepEqual(await verifyEntitlement(await sign(claims(), signer.privateKey, { typ: EDGE_TYP, kid: "staging-rogue" }), ctx()), { ok: false, reason: "unknown_kid" });
  // alg confusion / "none":
  const noneHeader = b64uEncode(new TextEncoder().encode(JSON.stringify({ alg: "none", typ: EDGE_TYP, kid: KEYS[0].kid })));
  assert.equal((await verifyEntitlement(`${noneHeader}.${jws.split(".")[1]}.`, ctx())).ok, false);
  // The deployed function's harmless SELFTEST token is never accepted as authority:
  assert.equal((await verifyEntitlement(await sign({ ver: 1, env: "staging", selftest: true }, signer.privateKey, { typ: SELFTEST_JWS_TYP, kid: KEYS[0].kid }), ctx())).ok, false);
  assert.deepEqual(await verifyEntitlement("garbage", ctx()), { ok: false, reason: "malformed" });
  assert.deepEqual(await verifyEntitlement(null, ctx()), { ok: false, reason: "missing" });
});

test("ATTACK copy the DB/profile to another PC: entitlement is bound to the device key fingerprint", async () => {
  const jws = await sign(claims());
  assert.deepEqual(await verifyEntitlement(jws, ctx({ deviceFingerprint: deviceB.fingerprint })), { ok: false, reason: "device_mismatch" });
  assert.deepEqual(await verifyEntitlement(jws, ctx({ deviceFingerprint: null })), { ok: false, reason: "device_mismatch" });
});

test("ATTACK change tenant / user / OU ids in the cache: mismatch, and foreign OUs are not entitled", async () => {
  const jws = await sign(claims());
  assert.deepEqual(await verifyEntitlement(jws, ctx({ tenantId: OTHER_TENANT })), { ok: false, reason: "tenant_mismatch" });
  assert.deepEqual(await verifyEntitlement(jws, ctx({ userId: "3a465d34-0000-4000-8000-000000000002" })), { ok: false, reason: "user_mismatch" });
  const r = await verifyEntitlement(jws, ctx());
  assert.ok(r.ok);
  assert.equal(isBranchEntitled(r.claims, OU), true);
  assert.equal(isBranchEntitled(r.claims, FOREIGN_OU), false);
  assert.equal(isBranchEntitled(r.claims, null), false);
});

test("staging entitlements are refused by a production build (env + separate keys)", async () => {
  assert.deepEqual(await verifyEntitlement(await sign(claims()), ctx({ env: "production" })), { ok: false, reason: "wrong_env" });
  assert.equal(ENTITLEMENT_PUBLIC_KEYS.production.length, 0, "production key is PREPARED only - none embedded yet");
  assert.ok(ENTITLEMENT_PUBLIC_KEYS.staging.every((k) => k.kid.startsWith("staging-")));
  assert.equal((await verifyEntitlement(await sign(claims({ env: "production" })), ctx({ env: "production", keys: undefined }))).ok, false);
});

// ============================================================ time

test("ATTACK expired entitlement (7 days) fails closed; an over-long signed lease is refused", async () => {
  const jws = await sign(claims());
  assert.equal((await verifyEntitlement(jws, ctx({ effectiveNowMs: T0 + 7 * DAY - 1000 }))).ok, true);
  assert.deepEqual(await verifyEntitlement(jws, ctx({ effectiveNowMs: T0 + 7 * DAY })), { ok: false, reason: "expired" });
  const iat = Math.floor(T0 / 1000);
  assert.deepEqual(await verifyEntitlement(await sign(claims({ exp: iat + 30 * 24 * 3600 })), ctx()), { ok: false, reason: "lease_too_long" });
  // Received more than 7 days ago by the local (sealed) clock guard = expired too.
  assert.deepEqual(await verifyEntitlement(jws, ctx({ effectiveNowMs: T0 + DAY, receivedAtMs: T0 + DAY - 7 * DAY })), { ok: false, reason: "expired" });
  assert.deepEqual(await verifyEntitlement(jws, ctx({ effectiveNowMs: T0 - DAY })), { ok: false, reason: "not_yet_valid" });
});

test("ATTACK clock rollback: effective now never goes back, rollback is sticky until a trusted server time", async () => {
  let g = freshTimeGuard(T0 + 8 * DAY); // the device has seen day 8 (entitlement expired)
  const back = observeClock(g, T0 + DAY); // user winds Windows back to day 1
  assert.equal(back.rollback, true);
  assert.equal(back.effectiveNowMs, T0 + 8 * DAY, "effective now = last seen, not the rolled-back clock");
  assert.deepEqual(await verifyEntitlement(await sign(claims()), ctx({ effectiveNowMs: back.effectiveNowMs })), { ok: false, reason: "expired" });
  g = back.state;
  const later = observeClock(g, T0 + 8 * DAY + 60_000);
  assert.equal(later.rollback, true, "moving the clock forward again does not clear the lock");
  const trusted = trustServerTime(later.state, T0 + 8 * DAY + 61_000, T0 + 8 * DAY + 60_000);
  assert.equal(observeClock(trusted, T0 + 8 * DAY + 70_000).rollback, false, "online re-authorization clears it");
  // Small jitter (NTP correction) is not a rollback.
  assert.equal(observeClock(freshTimeGuard(T0), T0 - ROLLBACK_TOLERANCE_MS + 1000).rollback, false);
  // A clock that runs BEHIND the server cannot stretch the lease: the server offset is added.
  const behind = trustServerTime(freshTimeGuard(T0), T0 + 2 * DAY, T0);
  assert.equal(observeClock(behind, T0 + 6 * DAY).effectiveNowMs, T0 + 8 * DAY);
  // A corrupted/edited sealed state cannot reset the guard to "never seen".
  assert.equal(parseTimeGuard("{not json", T0).lastSeenLocalMs, T0);
});

test("legacy 7-day authority is evaluated at the guarded effective now (rollback cannot renew it)", () => {
  const cache = { userId: USER, email: null, isPlatformUser: false, tenant: { id: TENANT }, membership: {}, features: {}, permissions: {}, currency: null, cachedAt: T0 };
  const g = observeClock(freshTimeGuard(T0 + 9 * DAY), T0 + DAY);
  assert.equal(decideOfflineAuthority(cache, T0 + DAY).kind, "restore", "raw local clock would have restored");
  assert.equal(decideOfflineAuthority(cache, g.effectiveNowMs).kind, "expired");
});

// ============================================================ capture lock

test("capture lock stops NEW financial captures and keeps read-only access; never touches data", () => {
  const perms = claims().permissions;
  assert.deepEqual(applyCaptureLock(perms, null), perms);
  for (const reason of ["clock_rollback", "entitlement_expired", "entitlement_invalid", "device_revoked", "access_revoked"] as const) {
    const locked = applyCaptureLock(perms, reason);
    assert.equal(locked["pos.create_orders"], false, reason);
    assert.equal(locked["pos.take_payments"], false, reason);
    assert.equal(locked["pos.open_shift"], false, reason);
    assert.equal(locked["pos.access"], true, reason);
    assert.equal(locked["pos.view_orders"], true, reason);
  }
  assert.ok(!VIEW_ONLY_PERMISSIONS.some((k) => /create|take|open|close|refund|collect|transfer.*create|payouts\.create|end_own|apply_discounts/.test(k)));
});

test("FIRST SHIFT OFFLINE keeps working with a valid entitlement (no lock, open_shift granted)", async () => {
  const r = await verifyEntitlement(await sign(claims()), ctx());
  assert.ok(r.ok);
  const restored = overlayAuthorityWithEntitlement({ userId: USER, tenant: { id: TENANT }, membership: null, features: {}, permissions: {} }, r.claims);
  const view = applyCaptureLock(restored.permissions, null);
  assert.equal(view["pos.open_shift"], true);
  assert.equal(view["pos.create_orders"], true);
  assert.equal(view["pos.take_payments"], true);
});

test("FRESH device / never-authorized user stays online-required", async () => {
  assert.equal(decideOfflineAuthority(null, T0).kind, "none");
  assert.deepEqual(await verifyEntitlement(undefined, ctx()), { ok: false, reason: "missing" });
});

// ============================================================ device signature protocol

test("device message layout is identical in Rust, the Edge Function and the probes", () => {
  const rust = read("src-tauri", "src", "device_security", "format.rs");
  assert.match(rust, /pub const SIGN_DOMAIN: &str = "breadee-desktop-v1";/);
  assert.match(rust, /"\{SIGN_DOMAIN\}\|\{\}\|\{\}\|\{\}\|\{\}\|\{\}\|\{\}\|\{\}",\s*req\.purpose, req\.nonce, req\.tenant_id, req\.user_id, fingerprint, req\.terminal_id, req\.counter/);
  const m = deviceMessage({ purpose: "entitlement", nonce: "a".repeat(64), tenantId: TENANT, userId: USER, fingerprint: "b".repeat(64), terminalId: "till-1", counter: 7 });
  assert.equal(m, `breadee-desktop-v1|entitlement|${"a".repeat(64)}|${TENANT}|${USER}|${"b".repeat(64)}|till-1|7`);
});

test("ATTACK replayed / re-targeted device signature fails (nonce, counter, purpose, user, key bound)", async () => {
  const f = { purpose: "entitlement" as const, nonce: "c".repeat(64), tenantId: TENANT, userId: USER, fingerprint: deviceA.fingerprint, terminalId: "till-1", counter: 3 };
  const sig = b64uEncode(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, deviceA.kp.privateKey, new TextEncoder().encode(deviceMessage(f)))));
  assert.equal(await verifyDeviceSignature(deviceA.spki, deviceMessage(f), sig), true);
  assert.equal(await verifyDeviceSignature(deviceA.spki, deviceMessage({ ...f, nonce: "d".repeat(64) }), sig), false, "fresh challenge");
  assert.equal(await verifyDeviceSignature(deviceA.spki, deviceMessage({ ...f, counter: 4 }), sig), false);
  assert.equal(await verifyDeviceSignature(deviceA.spki, deviceMessage({ ...f, purpose: "register" }), sig), false);
  assert.equal(await verifyDeviceSignature(deviceA.spki, deviceMessage({ ...f, userId: "3a465d34-0000-4000-8000-000000000002" }), sig), false);
  assert.equal(await verifyDeviceSignature(deviceB.spki, deviceMessage(f), sig), false, "another device's key");
});

// ============================================================ refresh / revocation (fake native + fake server)

function fakeNative(device = deviceA, opts: { failSeal?: boolean } = {}) {
  const sealed = new Map<SealName, string>();
  const n: SecurityNative & { sealed: Map<SealName, string>; signed: string[] } = {
    sealed,
    signed: [],
    available: () => true,
    devicePublicKey: async () => ({ spki: device.spki, fingerprint: device.fingerprint, provider: "software" }),
    deviceSign: async (r) => {
      const message = deviceMessage({ ...r, fingerprint: device.fingerprint });
      n.signed.push(message);
      const s = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, device.kp.privateKey, new TextEncoder().encode(message)));
      return { message, signature: b64uEncode(s), fingerprint: device.fingerprint };
    },
    sealSecret: async (name, value) => {
      if (opts.failSeal) throw new Error("seal_failed:0x8009000b");
      sealed.set(name, value);
    },
    unsealSecret: async (name) => sealed.get(name) ?? null,
    clearSecret: async (name) => void sealed.delete(name),
  };
  return n;
}

function fakeServer(over: Partial<{ registered: boolean; revoked: boolean; pos: boolean; tenant: string; claimsFor: (fp: string) => EntitlementClaims }> = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const nonce = "e".repeat(64);
  const server: EntitlementServer & { calls: typeof calls } = {
    calls,
    status: async () => ({ registered: over.registered ?? false, revoked: over.revoked ?? false, membership_active: true, pos_access: over.pos ?? true }),
    challenge: async () => ({ challenge_id: "00000000-0000-4000-8000-000000000001", nonce, tenant_id: over.tenant ?? TENANT, user_id: USER }),
    issue: async (body) => {
      calls.push(body);
      // The server re-derives the message from ITS values and verifies the device signature.
      const spki = (body.spki as string) ?? deviceA.spki;
      const ok = await verifyDeviceSignature(spki, deviceMessage({ purpose: body.action as "register", nonce, tenantId: TENANT, userId: USER, fingerprint: body.fingerprint as string, terminalId: body.terminal_id as string, counter: body.counter as number }), body.signature as string);
      if (!ok) return { error: "bad_device_signature" };
      const c = over.claimsFor ? over.claimsFor(body.fingerprint as string) : claims({ device_fp: body.fingerprint as string, iat: Math.floor(T0 / 1000), exp: Math.floor(T0 / 1000) + 7 * 24 * 3600 });
      return { entitlement: await sign(c), server_time_ms: T0, counter_regressed: false };
    },
  };
  return server;
}

beforeEach(() => {
  __resetDeviceAuthorityForTests();
  __setAppEnvForTests("staging");
  __setEntitlementKeysForTests(KEYS);
  __setSecurityNativeForTests(null);
});

test("online refresh: registers, proves key possession, verifies the issuance, stores it sealed, bumps the counter", async () => {
  const native = fakeNative();
  __setSecurityNativeForTests(native);
  assert.equal(entitlementEnforced(), true);
  const server = fakeServer({ registered: false });
  const r = await refreshEntitlement({ userId: USER, tenantId: TENANT, terminalId: "Cashier PC 1" }, { server, nowMs: () => T0 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(server.calls[0].action, "register");
  assert.equal(server.calls[0].spki, deviceA.spki);
  assert.equal(server.calls[0].terminal_id, "Cashier-PC-1");
  assert.equal(server.calls[0].counter, 1);
  assert.ok(native.sealed.get("entitlement"), "entitlement stored via the sealed store");
  assert.ok(native.sealed.get("time-guard"), "time guard persisted sealed");
  const again = await refreshEntitlement({ userId: USER, tenantId: TENANT, terminalId: "till-1" }, { server: fakeServer({ registered: true }), nowMs: () => T0 + 1000, force: true });
  assert.equal(again.ok, true);
  const v = await verifyStoredEntitlement({ userId: USER, tenantId: TENANT }, { effectiveNowMs: T0 + DAY, rollback: false });
  assert.equal(v.ok, true);
  assert.equal(native.signed.at(-1)?.endsWith("|till-1|2"), true, "monotonic counter");
});

test("ATTACK a bad issuance (wrong device / tenant switch mid-flight) is never stored", async () => {
  const native = fakeNative();
  __setSecurityNativeForTests(native);
  const r = await refreshEntitlement({ userId: USER, tenantId: TENANT, terminalId: "t" }, { server: fakeServer({ claimsFor: () => claims({ device_fp: deviceB.fingerprint }) }), nowMs: () => T0 });
  assert.deepEqual(r, { ok: false, reason: "issued_device_mismatch" });
  assert.equal(native.sealed.has("entitlement"), false);
  const r2 = await refreshEntitlement({ userId: USER, tenantId: TENANT, terminalId: "t" }, { server: fakeServer({ tenant: OTHER_TENANT }), nowMs: () => T0, force: true });
  assert.deepEqual(r2, { ok: false, reason: "identity_changed" });
});

test("ATTACK reconnect after revocation: no new entitlement, standing reported, local data untouched", async () => {
  const native = fakeNative();
  __setSecurityNativeForTests(native);
  native.sealed.set("entitlement", await sign(claims()));
  const before = native.sealed.get("entitlement");
  const r = await refreshEntitlement({ userId: USER, tenantId: TENANT, terminalId: "t" }, { server: fakeServer({ registered: true, revoked: true }), nowMs: () => T0 });
  assert.deepEqual(r, { ok: false, reason: "device_revoked" });
  assert.equal(native.sealed.get("entitlement"), before, "refresh itself never deletes anything");
  assert.equal(await checkDeviceStanding({ server: fakeServer({ registered: true, revoked: true }) }), "device_revoked");
  assert.equal(await checkDeviceStanding({ server: fakeServer({ registered: true, pos: false }) }), "access_revoked");
  assert.equal(await checkDeviceStanding({ server: fakeServer({ registered: true }) }), "ok");
  const failing: EntitlementServer = { status: async () => { throw new Error("offline"); }, challenge: async () => { throw new Error("x"); }, issue: async () => ({}) };
  assert.equal(await checkDeviceStanding({ server: failing }), "unknown", "an unreachable server is not a revocation");
});

test("ATTACK copied sealed entitlement on another PC fails verification there", async () => {
  const a = fakeNative(deviceA);
  __setSecurityNativeForTests(a);
  await refreshEntitlement({ userId: USER, tenantId: TENANT, terminalId: "t" }, { server: fakeServer(), nowMs: () => T0 });
  const stolen = await readStoredEntitlement();
  __resetDeviceAuthorityForTests();
  const b = fakeNative(deviceB);
  b.sealed.set("entitlement", stolen as string);
  __setSecurityNativeForTests(b);
  const v = await verifyStoredEntitlement({ userId: USER, tenantId: TENANT }, { effectiveNowMs: T0 + DAY, rollback: false });
  assert.deepEqual(v, { ok: false, reason: "device_mismatch" });
});

test("observeDeviceClock persists the high-water mark through the sealed store", async () => {
  const native = fakeNative();
  __setSecurityNativeForTests(native);
  await observeDeviceClock(T0);
  await observeDeviceClock(T0 + DAY);
  __resetDeviceAuthorityForTests(); // a restart
  const c = await observeDeviceClock(T0 + 1000); // clock wound back after restart
  assert.equal(c.rollback, true);
  assert.ok(c.effectiveNowMs >= T0 + DAY);
});

test("non-packaged builds (dev browser / node) are not enforced and never call the device", () => {
  __setSecurityNativeForTests({ ...fakeNative(), available: () => false });
  assert.equal(entitlementEnforced(), false);
  __setSecurityNativeForTests(fakeNative());
  __setEntitlementKeysForTests([]);
  assert.equal(entitlementEnforced(), false, "no embedded key for the env = legacy authority (production until its GO)");
});

test("terminal ids are reduced to the signed grammar", () => {
  assert.equal(signableTerminalId("Cashier PC 1"), "Cashier-PC-1");
  assert.equal(signableTerminalId(""), "terminal");
  assert.equal(signableTerminalId("x".repeat(80)).length, 64);
  assert.equal(signableTerminalId("till|1"), "till-1");
});

// ============================================================ sealed refresh token

function memStore() {
  const m = new Map<string, string>();
  return { m, store: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) } };
}

test("sealed auth storage: migrates the 1.0.37 plaintext session once, then removes the plaintext copy", async () => {
  const native = fakeNative();
  const { m, store } = memStore();
  m.set(AUTH_STORAGE_KEY, '{"refresh_token":"r1"}');
  const s = createSealedAuthStorage({ native: () => native, plain: () => store });
  assert.equal(await s.getItem(AUTH_STORAGE_KEY), '{"refresh_token":"r1"}');
  assert.equal(native.sealed.get("auth-session"), '{"refresh_token":"r1"}');
  assert.equal(m.has(AUTH_STORAGE_KEY), false, "plaintext removed after a successful seal");
  await s.setItem(AUTH_STORAGE_KEY, '{"refresh_token":"r2"}');
  assert.equal(m.has(AUTH_STORAGE_KEY), false, "never written back as plaintext");
  assert.equal(await s.getItem(AUTH_STORAGE_KEY), '{"refresh_token":"r2"}');
  await s.removeItem(AUTH_STORAGE_KEY);
  assert.equal(native.sealed.has("auth-session"), false, "sign-out clears the sealed session");
  // Other supabase keys pass through untouched.
  await s.setItem(`${AUTH_STORAGE_KEY}-code-verifier`, "v");
  assert.equal(m.get(`${AUTH_STORAGE_KEY}-code-verifier`), "v");
});

test("sealed auth storage: a seal failure keeps the session in memory and NEVER writes plaintext", async () => {
  const native = fakeNative(deviceA, { failSeal: true });
  const { m, store } = memStore();
  const s = createSealedAuthStorage({ native: () => native, plain: () => store });
  await s.setItem(AUTH_STORAGE_KEY, '{"refresh_token":"r3"}');
  assert.equal(m.has(AUTH_STORAGE_KEY), false);
  assert.equal(await s.getItem(AUTH_STORAGE_KEY), '{"refresh_token":"r3"}');
  // Outside the app it is the 1.0.37 localStorage behaviour.
  const dev = createSealedAuthStorage({ native: () => ({ ...native, available: () => false }), plain: () => store });
  await dev.setItem(AUTH_STORAGE_KEY, "x");
  assert.equal(m.get(AUTH_STORAGE_KEY), "x");
});

test("supabase client uses ONLY the sealed storage adapter (PERF fetch timeout preserved)", () => {
  const s = read("src", "lib", "supabase.ts");
  assert.match(s, /storage: sealedAuthStorage,/);
  assert.match(s, /storageKey: "breadee-desktop-auth"/);
  assert.match(s, /fetch: timeoutFetch/);
});

// ============================================================ shell hardening (CSP, ACL, Rust surface)

test("strict CSP: no remote scripts, no inline/eval scripts, connect only to self/IPC/Supabase", () => {
  const conf = JSON.parse(read("src-tauri", "tauri.conf.json"));
  const csp = conf.app.security.csp as Record<string, string>;
  assert.equal(csp["default-src"], "'self'");
  assert.equal(csp["script-src"], "'self'");
  assert.equal(csp["object-src"], "'none'");
  assert.equal(csp["frame-ancestors"], "'none'");
  for (const src of csp["connect-src"].split(/\s+/)) {
    assert.ok(["'self'", "ipc:", "http://ipc.localhost", "https://*.supabase.co", "wss://*.supabase.co"].includes(src), `unexpected connect-src ${src}`);
  }
  assert.ok(!/unsafe-eval|https?:\/\/(?!\*\.supabase\.co|ipc\.localhost)/.test(JSON.stringify(csp)), "no eval, no other remote origin");
  assert.deepEqual(conf.app.security.dangerousDisableAssetCspModification, ["style-src"], "only style-src is left unmodified (React <style> in Analytics)");
  assert.equal(conf.app.withGlobalTauri, undefined);
  for (const overlay of ["tauri.staging.conf.json", "tauri.release.conf.json"]) {
    assert.equal(JSON.parse(read("src-tauri", overlay)).app?.security, undefined, `${overlay} must not override the CSP`);
  }
});

test("release builds: no devtools feature and no source maps", () => {
  const cargo = read("src-tauri", "Cargo.toml");
  assert.match(cargo, /tauri = \{ version = "2", features = \[\] \}/);
  assert.ok(!/devtools/.test(cargo));
  assert.match(read("vite.config.ts"), /sourcemap: false/);
});

test("ACL: every invoke_handler command is declared in build.rs and granted by name - no wildcard", () => {
  const lib = read("src-tauri", "src", "lib.rs");
  const handler = lib.slice(lib.indexOf("invoke_handler"), lib.indexOf("]));"));
  const commands = [...handler.matchAll(/(?:printing|device_security)::(\w+)/g)].map((m) => m[1]);
  const build = read("src-tauri", "build.rs");
  const declared = [...build.slice(build.indexOf("APP_COMMANDS")).matchAll(/"(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual([...declared].sort(), [...commands].sort());
  const caps = JSON.parse(read("src-tauri", "capabilities", "default.json")) as { permissions: string[] };
  const granted = caps.permissions.filter((p) => p.startsWith("allow-")).map((p) => p.slice(6).replace(/-/g, "_"));
  assert.deepEqual([...granted].sort(), [...commands].sort());
  assert.ok(!caps.permissions.some((p) => p.includes("*")));
  assert.ok(commands.includes("device_sign") && commands.includes("seal_secret"));
});

test("Rust device key: non-exportable, public blob only, closed seal names, unsupported stub off-Windows", () => {
  const cng = read("src-tauri", "src", "device_security", "windows_cng.rs").replace(/\/\/.*$/gm, "");
  const mod = read("src-tauri", "src", "device_security", "mod.rs");
  const fmt = read("src-tauri", "src", "device_security", "format.rs");
  assert.ok(!/ALLOW_EXPORT_FLAG|ALLOW_PLAINTEXT_EXPORT|ECCPRIVATE_BLOB|PKCS8/.test(cng), "no private export anywhere");
  assert.match(cng, /BCRYPT_ECCPUBLIC_BLOB/);
  assert.match(cng, /MS_PLATFORM_CRYPTO_PROVIDER/);
  assert.match(cng, /MS_KEY_STORAGE_PROVIDER/);
  assert.match(cng, /CRYPTPROTECT_UI_FORBIDDEN/);
  assert.match(mod, /#\[cfg\(not\(target_os = "windows"\)\)\]\s*mod platform/);
  assert.match(mod, /unsupported_platform/);
  // Offline-first recovery adds exactly ONE closed name: the per-user offline sign-in vault.
  assert.match(fmt, /pub const SEAL_NAMES: \[&str; 4\] = \["auth-session", "time-guard", "entitlement", "offline-vault"\];/);
  assert.match(fmt, /deny_unknown_fields/);
  assert.match(mod, /format::validate_seal_value_for\(&name, &value\)\?;/, "the size bound is per allowlisted name");
  const native = read("src", "lib", "security", "native.ts");
  assert.match(native, /export type SealName = "auth-session" \| "time-guard" \| "entitlement" \| "offline-vault";/);
});

// ============================================================ session wiring

test("session: offline restore is gated on the verified entitlement, expiry is checked in-session, sign-out keeps history", () => {
  const s = read("src", "state", "session.ts");
  assert.match(s, /const decision = await gateOfflineRestore\(decideOfflineAuthority\(await readAuthorityCache\(\)\.catch\(\(\) => null\), clock\.effectiveNowMs\), clock\);/);
  assert.match(s, /if \(!check \|\| !check\.ok\) return \{ kind: "expired", cache: d\.cache \};/);
  assert.match(s, /overlayAuthorityWithEntitlement\(c, check\.claims\)/);
  assert.match(s, /window\.setInterval\(\(\) => void securityTick\(\)/);
  assert.match(s, /window\.addEventListener\("online", \(\) => void securityReconnect\(\)/);
  assert.match(s, /lock = check\?\.reason === "expired" \? "entitlement_expired" : "entitlement_invalid"/);
  assert.match(s, /can: \(perm\) => Boolean\(get\(\)\.permissions\[perm\]\)/);
  const signOut = s.slice(s.indexOf("signOut: async"), s.indexOf("can: (perm)"));
  assert.match(signOut, /clearEntitlement\(\)/);
  assert.ok(!/operations|syncHistory|outbox|posOfflineTxns|pendingShift/i.test(signOut.replace(/\/\/.*$/gm, "")), "sign-out never touches financial history");
  const sec = read("src", "lib", "security", "deviceAuthority.ts").replace(/\/\/.*$/gm, "");
  assert.ok(!/localdb|operationLog|syncHistory|posOfflineTxns/.test(sec), "the security layer cannot reach financial history");
});

test("edge function: device signature verified BEFORE any commit; 7-day exp; verify_jwt; no key in responses", () => {
  const fn = read("docs", "offline", "edge-functions", "desktop-entitlement", "index.ts");
  const verifyAt = fn.indexOf("verifyDeviceSignature(spki, message, b.signature)");
  const commitAt = fn.indexOf('admin.rpc("desktop_device_register"');
  assert.ok(verifyAt > 0 && commitAt > verifyAt);
  assert.match(fn, /const TTL_SECONDS = 7 \* 24 \* 60 \* 60;/);
  assert.match(fn, /exp: iat \+ TTL_SECONDS/);
  assert.ok(!/console\.(log|error|info)/.test(fn), "nothing logged");
  assert.ok(!/d: b64uEncode\(fromHex\(data\)\)[\s\S]*json\(req, 200, \{[^}]*\bd\b/.test(fn));
});
