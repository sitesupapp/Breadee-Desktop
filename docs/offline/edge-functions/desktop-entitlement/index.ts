// desktop-entitlement - Breadee Desktop Final Foundation (Tracks 4/5/6).
//
// Issues the SIGNED OFFLINE ENTITLEMENT a desktop till needs to keep working
// offline for at most 7 days, bound to ONE registered device key.
//
//   GET                 -> { alg, kid, jwk, env }   public key only
//   GET ?selftest=1     -> a JWS of typ "breadee-selftest+jws" with NO authority
//                          in it (lets acceptance prove the deployed signer and the
//                          app's embedded key agree; the app refuses that typ)
//   POST {action:"register"|"entitlement", ...}  (user JWT required)
//        1. auth.getUser() with the caller's JWT (server-validated)
//        2. desktop_device_precheck AS THE USER  (challenge, POS operator gate,
//           membership, OUs via can_access_branch, permissions, features, device)
//        3. rebuild the device message from SERVER values and verify the device's
//           ECDSA P-256 signature (WebCrypto)
//        4. commit AS service_role: desktop_device_register / desktop_device_attest
//           (single-use challenge, revocation, counters, seq)
//        5. sign {tenant, OUs, user, role, permissions, features, device, terminal,
//           iat, exp = iat + 7d, server_time, seq, ver} as ES256
//
// The private key is the P-256 scalar generated INSIDE the database into Vault
// (docs/offline/migrations/foundation_desktop_entitlement_key_bootstrap.sql),
// read via the service_role-only desktop_entitlement_signing_key(). It is never
// logged or returned. Every error response carries a stable code, never a stack.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { p256 } from "npm:@noble/curves@1.4.0/p256";
import {
  ENTITLEMENT_JWS_TYP,
  SELFTEST_JWS_TYP,
  b64uEncode,
  deviceMessage,
  fromHex,
  kidFor,
  b64Decode,
  sha256Hex,
  signJws,
  verifyDeviceSignature,
} from "./jws.ts";

const TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_BODY = 8 * 1024;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const PROJECT_ENV: Record<string, string> = {
  azjxprewycygsocusxjn: "staging",
  cltlqfqormkhppmbvyrv: "production",
};
const ENV = PROJECT_ENV[new URL(SUPABASE_URL || "https://unknown.supabase.co").hostname.split(".")[0]] ?? "unknown";

const ALLOWED_ORIGINS = new Set(["http://tauri.localhost", "https://tauri.localhost", "tauri://localhost", "http://localhost:5173"]);

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  return ALLOWED_ORIGINS.has(origin)
    ? {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-breadee-client",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        Vary: "Origin",
      }
    : { Vary: "Origin" };
}

function json(req: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(req), "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

type Signer = { kid: string; key: CryptoKey; jwk: { kty: "EC"; crv: "P-256"; x: string; y: string } };
let signerPromise: Promise<Signer> | null = null;

async function loadSigner(): Promise<Signer> {
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await admin.rpc("desktop_entitlement_signing_key");
  if (error || typeof data !== "string" || !/^[0-9a-f]{64}$/.test(data)) throw new Error("signing_key_unavailable");
  const point = p256.getPublicKey(data, false); // 0x04 || X || Y
  const jwk = { kty: "EC" as const, crv: "P-256" as const, x: b64uEncode(point.slice(1, 33)), y: b64uEncode(point.slice(33, 65)) };
  const key = await crypto.subtle.importKey(
    "jwk",
    { ...jwk, d: b64uEncode(fromHex(data)), ext: false },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  return { kid: await kidFor(ENV, point), key, jwk };
}

function signer(): Promise<Signer> {
  if (!signerPromise) signerPromise = loadSigner().catch((e) => { signerPromise = null; throw e; });
  return signerPromise;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const TERMINAL = /^[A-Za-z0-9._-]{1,64}$/;
const SIG = /^[A-Za-z0-9_-]{86}$/;
const KNOWN_DB_CODES = [
  "challenge_invalid", "tenant_changed", "no_active_membership", "device_revoked", "device_not_registered",
  "fingerprint_mismatch", "device_key_mismatch", "invalid_fingerprint", "invalid_terminal_id", "invalid_counter",
  "invalid_provider", "not_authenticated", "too_many_open_challenges",
];

function dbCode(message: string | undefined): string {
  const m = message ?? "";
  if (/not allowed to use POS|POS is not enabled|Wrong tenant context/i.test(m)) return "pos_access_denied";
  return KNOWN_DB_CODES.find((c) => m.includes(c)) ?? "server_refused";
}

type Body = {
  action?: unknown; challenge_id?: unknown; fingerprint?: unknown; terminal_id?: unknown;
  counter?: unknown; signature?: unknown; spki?: unknown; provider?: unknown;
};

async function handlePost(req: Request): Promise<Response> {
  const auth = req.headers.get("authorization") ?? "";
  if (!/^Bearer\s+\S+$/i.test(auth)) return json(req, 401, { error: "not_authenticated" });
  const raw = await req.text();
  if (raw.length > MAX_BODY) return json(req, 413, { error: "body_too_large" });
  let b: Body;
  try { b = JSON.parse(raw) as Body; } catch { return json(req, 400, { error: "bad_json" }); }

  const action = b.action;
  if (action !== "register" && action !== "entitlement") return json(req, 400, { error: "invalid_action" });
  if (typeof b.challenge_id !== "string" || !UUID.test(b.challenge_id)) return json(req, 400, { error: "invalid_challenge_id" });
  if (typeof b.fingerprint !== "string" || !HEX64.test(b.fingerprint)) return json(req, 400, { error: "invalid_fingerprint" });
  if (typeof b.terminal_id !== "string" || !TERMINAL.test(b.terminal_id)) return json(req, 400, { error: "invalid_terminal_id" });
  if (typeof b.counter !== "number" || !Number.isSafeInteger(b.counter) || b.counter < 0) return json(req, 400, { error: "invalid_counter" });
  if (typeof b.signature !== "string" || !SIG.test(b.signature)) return json(req, 400, { error: "invalid_signature" });

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: who, error: whoErr } = await userClient.auth.getUser();
  const user = who?.user;
  if (whoErr || !user) return json(req, 401, { error: "not_authenticated" });

  const { data: pre, error: preErr } = await userClient.rpc("desktop_device_precheck", {
    p_challenge_id: b.challenge_id,
    p_fingerprint: b.fingerprint,
  });
  if (preErr || !pre) return json(req, 403, { error: dbCode(preErr?.message) });
  const ch = pre.challenge as { nonce: string; purpose: string; tenant_id: string; user_id: string };
  if (ch.purpose !== action || ch.user_id !== user.id) return json(req, 403, { error: "challenge_invalid" });

  // The key the signature is checked against: the SUBMITTED key for a first
  // registration (proof of possession), otherwise ONLY the registered one.
  let spki: string;
  if (action === "register") {
    if (typeof b.spki !== "string" || b.spki.length < 100 || b.spki.length > 200) return json(req, 400, { error: "invalid_spki" });
    if (b.provider !== "tpm" && b.provider !== "software") return json(req, 400, { error: "invalid_provider" });
    if (pre.device && pre.device.public_key_spki !== b.spki) return json(req, 409, { error: "device_key_mismatch" });
    spki = b.spki;
  } else {
    if (!pre.device) return json(req, 409, { error: "device_not_registered" });
    spki = pre.device.public_key_spki as string;
  }
  if (pre.device?.revoked) return json(req, 403, { error: "device_revoked" });
  let spkiBytes: Uint8Array;
  try { spkiBytes = b64Decode(spki); } catch { return json(req, 400, { error: "invalid_spki" }); }
  if ((await sha256Hex(spkiBytes)) !== b.fingerprint) return json(req, 400, { error: "fingerprint_mismatch" });

  const message = deviceMessage({
    purpose: action, nonce: ch.nonce, tenantId: ch.tenant_id, userId: user.id,
    fingerprint: b.fingerprint, terminalId: b.terminal_id, counter: b.counter,
  });
  if (!(await verifyDeviceSignature(spki, message, b.signature))) return json(req, 401, { error: "bad_device_signature" });

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const commit = action === "register"
    ? await admin.rpc("desktop_device_register", {
        p_challenge_id: b.challenge_id, p_user_id: user.id, p_fingerprint: b.fingerprint, p_spki: spki,
        p_provider: b.provider, p_terminal_id: b.terminal_id, p_counter: b.counter,
      })
    : await admin.rpc("desktop_device_attest", {
        p_challenge_id: b.challenge_id, p_user_id: user.id, p_fingerprint: b.fingerprint,
        p_terminal_id: b.terminal_id, p_counter: b.counter,
      });
  if (commit.error || !commit.data) return json(req, 403, { error: dbCode(commit.error?.message) });

  const s = await signer();
  const nowMs = Date.now();
  const iat = Math.floor(nowMs / 1000);
  const m = pre.membership as { role: string; branch_id: string | null; all_branches: boolean };
  const claims = {
    ver: 1,
    iss: "breadee-desktop-entitlement",
    env: ENV,
    sub: user.id,
    email: user.email ?? null,
    tenant_id: ch.tenant_id,
    role: m.role,
    branch_id: m.branch_id,
    all_branches: m.all_branches === true,
    branch_ids: pre.branch_ids,
    main_branch_id: pre.main_branch_id,
    permissions: pre.permissions,
    features: pre.features,
    device_fp: b.fingerprint,
    device_id: commit.data.device_id,
    terminal_id: b.terminal_id,
    iat,
    exp: iat + TTL_SECONDS,
    server_time_ms: nowMs,
    seq: commit.data.entitlement_seq,
  };
  const entitlement = await signJws({ typ: ENTITLEMENT_JWS_TYP, kid: s.kid }, claims, s.key);
  return json(req, 200, {
    entitlement,
    kid: s.kid,
    server_time_ms: nowMs,
    device_id: commit.data.device_id,
    seq: commit.data.entitlement_seq,
    counter_regressed: commit.data.counter_regressed === true,
  });
}

Deno.serve(async (req: Request) => {
  try {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
    if (req.method === "GET") {
      const s = await signer();
      if (new URL(req.url).searchParams.get("selftest") === "1") {
        const iat = Math.floor(Date.now() / 1000);
        const jws = await signJws({ typ: SELFTEST_JWS_TYP, kid: s.kid }, { ver: 1, env: ENV, selftest: true, iat }, s.key);
        return json(req, 200, { alg: "ES256", kid: s.kid, env: ENV, selftest: jws });
      }
      return json(req, 200, { alg: "ES256", kid: s.kid, env: ENV, jwk: s.jwk });
    }
    if (req.method === "POST") return await handlePost(req);
    return json(req, 405, { error: "method_not_allowed" });
  } catch (e) {
    const code = e instanceof Error && e.message === "signing_key_unavailable" ? "signing_key_unavailable" : "internal_error";
    return json(req, 500, { error: code });
  }
});
