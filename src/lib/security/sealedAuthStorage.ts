// Final Foundation - supabase-js auth STORAGE ADAPTER that keeps the session (access
// token + REFRESH TOKEN) sealed with Windows DPAPI via the Rust `seal_secret` command,
// instead of plaintext JSON in the WebView2 profile's localStorage.
//
// * Only the session key ("breadee-desktop-auth") is sealed; any other key supabase-js
//   may use (e.g. a PKCE code verifier) passes through to localStorage unchanged.
// * MIGRATION: the first read on an upgraded install finds the 1.0.37 plaintext copy,
//   seals it, and REMOVES the plaintext only after the seal succeeded - so a failed
//   seal never signs the cashier out.
// * A seal FAILURE never falls back to writing plaintext: the session is kept in
//   memory for this run (the cashier stays signed in until restart).
// * Outside the packaged app (vite dev in a browser, node) the adapter is plain
//   localStorage, exactly the 1.0.37 behaviour.

import { securityNative, type SecurityNative } from "@/lib/security/native";

export const AUTH_STORAGE_KEY = "breadee-desktop-auth";

export type AsyncStorageAdapter = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

type PlainStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function browserStore(): PlainStore | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export function createSealedAuthStorage(deps?: { native?: () => SecurityNative; plain?: () => PlainStore | null }): AsyncStorageAdapter {
  const native = deps?.native ?? securityNative;
  const plain = deps?.plain ?? browserStore;
  const memory = new Map<string, string>();
  const sealed = (key: string) => key === AUTH_STORAGE_KEY && native().available();

  return {
    async getItem(key) {
      if (!sealed(key)) return plain()?.getItem(key) ?? null;
      if (memory.has(key)) return memory.get(key) ?? null;
      let value: string | null = null;
      try {
        value = await native().unsealSecret("auth-session");
      } catch {
        value = null; // unreadable blob (other user / other machine / corrupt) = no session
      }
      const legacy = plain()?.getItem(key) ?? null;
      if (value !== null) {
        if (legacy !== null) plain()?.removeItem(key); // never leave a plaintext twin behind
        return value;
      }
      if (legacy === null) return null;
      // One-time migration of the 1.0.37 plaintext session.
      try {
        await native().sealSecret("auth-session", legacy);
        plain()?.removeItem(key);
      } catch {
        memory.set(key, legacy);
        plain()?.removeItem(key);
      }
      return legacy;
    },
    async setItem(key, value) {
      if (!sealed(key)) {
        plain()?.setItem(key, value);
        return;
      }
      try {
        await native().sealSecret("auth-session", value);
        memory.delete(key);
      } catch {
        memory.set(key, value);
      }
      plain()?.removeItem(key);
    },
    async removeItem(key) {
      memory.delete(key);
      plain()?.removeItem(key);
      if (sealed(key)) await native().clearSecret("auth-session").catch(() => undefined);
    },
  };
}

export const sealedAuthStorage = createSealedAuthStorage();
