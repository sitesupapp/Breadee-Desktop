// Final Foundation - compact JWS (ES256) verification for the offline entitlement.
// Pure WebCrypto: runs in WebView2 and in node tests unchanged. Verification only -
// the desktop never holds an entitlement SIGNING key.

import type { EntitlementPublicKey } from "@/lib/security/entitlementKeys";

export type JwsFailure = "malformed" | "wrong_alg" | "wrong_typ" | "unknown_kid" | "bad_signature";

export type JwsResult =
  | { ok: true; header: Record<string, unknown>; claims: Record<string, unknown> }
  | { ok: false; reason: JwsFailure };

export function b64uDecode(s: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) throw new Error("bad_base64url");
  const pad = s.length % 4 === 2 ? "==" : s.length % 4 === 3 ? "=" : "";
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeJson(part: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(new TextDecoder().decode(b64uDecode(part))) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function importKey(k: EntitlementPublicKey): Promise<CryptoKey> {
  const id = `${k.kid}|${k.x}|${k.y}`;
  let p = keyCache.get(id);
  if (!p) {
    p = crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: k.x, y: k.y, ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    keyCache.set(id, p);
  }
  return p;
}

/** Verify an ES256 compact JWS against a closed key list and an expected `typ`. */
export async function verifyEs256Jws(jws: unknown, keys: readonly EntitlementPublicKey[], expectedTyp: string): Promise<JwsResult> {
  if (typeof jws !== "string" || jws.length > 64 * 1024) return { ok: false, reason: "malformed" };
  const parts = jws.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const header = decodeJson(parts[0]);
  const claims = decodeJson(parts[1]);
  if (!header || !claims) return { ok: false, reason: "malformed" };
  if (header.alg !== "ES256") return { ok: false, reason: "wrong_alg" };
  if (header.typ !== expectedTyp) return { ok: false, reason: "wrong_typ" };
  const key = keys.find((k) => k.kid === header.kid);
  if (!key) return { ok: false, reason: "unknown_kid" };
  let sig: Uint8Array<ArrayBuffer>;
  try {
    sig = b64uDecode(parts[2]);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (sig.length !== 64) return { ok: false, reason: "bad_signature" };
  try {
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      await importKey(key),
      sig,
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    return ok ? { ok: true, header, claims } : { ok: false, reason: "bad_signature" };
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
}
