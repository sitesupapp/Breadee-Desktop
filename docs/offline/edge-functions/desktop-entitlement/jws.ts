// Pure WebCrypto helpers shared by the `desktop-entitlement` Edge Function and the
// node tests (test/offline-foundation-security.test.ts). No Deno-, Node- or
// browser-specific API beyond globalThis.crypto.subtle + atob/btoa, so the exact
// same code runs in all three.
//
// THE DEVICE MESSAGE is the one string the desktop's Rust `device_sign` command can
// sign (src-tauri/src/device_security/format.rs `build_sign_message`). The server
// rebuilds it from ITS OWN copies of every field (nonce + tenant + user from the
// challenge row, fingerprint from the SPKI hash) - never from a client-sent string.

export const SIGN_DOMAIN = "breadee-desktop-v1";
export const ENTITLEMENT_JWS_TYP = "breadee-entitlement+jws";
export const SELFTEST_JWS_TYP = "breadee-selftest+jws";

export function b64uEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64uDecode(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("bad_base64url");
  const pad = s.length % 4 === 2 ? "==" : s.length % 4 === 3 ? "=" : s.length % 4 === 0 ? "" : null;
  if (pad === null) throw new Error("bad_base64url");
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64Decode(s: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) throw new Error("bad_base64");
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function fromHex(hex: string): Uint8Array {
  if (!/^([0-9a-f]{2})*$/.test(hex)) throw new Error("bad_hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

export type DeviceMessageFields = {
  purpose: "register" | "entitlement";
  nonce: string;
  tenantId: string;
  userId: string;
  fingerprint: string;
  terminalId: string;
  counter: number;
};

/** The exact layout `format::build_sign_message` produces in Rust. */
export function deviceMessage(f: DeviceMessageFields): string {
  return [SIGN_DOMAIN, f.purpose, f.nonce, f.tenantId, f.userId, f.fingerprint, f.terminalId, String(f.counter)].join("|");
}

/** Verify a device's P1363 (r||s) ECDSA-P256-SHA256 signature over `message`. */
export async function verifyDeviceSignature(spkiB64: string, message: string, signatureB64u: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("spki", b64Decode(spkiB64), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const sig = b64uDecode(signatureB64u);
    if (sig.length !== 64) return false;
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, new TextEncoder().encode(message));
  } catch {
    return false;
  }
}

/** Compact JWS, ES256. `privateKey` is a non-extractable ECDSA P-256 signing key. */
export async function signJws(header: Record<string, unknown>, claims: Record<string, unknown>, privateKey: CryptoKey): Promise<string> {
  const enc = new TextEncoder();
  const h = b64uEncode(enc.encode(JSON.stringify({ ...header, alg: "ES256" })));
  const p = b64uEncode(enc.encode(JSON.stringify(claims)));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, enc.encode(`${h}.${p}`)));
  return `${h}.${p}.${b64uEncode(sig)}`;
}

/** kid = environment label + first 16 hex chars of SHA-256(uncompressed public point). */
export async function kidFor(env: string, publicPoint65: Uint8Array): Promise<string> {
  return `${env}-${(await sha256Hex(publicPoint65)).slice(0, 16)}`;
}
