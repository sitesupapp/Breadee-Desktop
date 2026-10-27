// Final Foundation - the frontend side of the five device-security commands
// (src-tauri/src/device_security). Like lib/nativePrinting.ts this is the ONE place
// that invokes them, so the surface stays reviewable. Outside the packaged app
// (vite dev in a browser, node tests) `available()` is false and every caller takes
// its non-native path; tests can install a fake with `__setSecurityNativeForTests`.

export type DevicePublicKey = { spki: string; fingerprint: string; provider: "tpm" | "software" };
export type DeviceSignRequest = {
  purpose: "register" | "entitlement";
  nonce: string;
  tenantId: string;
  userId: string;
  terminalId: string;
  counter: number;
};
export type DeviceSignature = { message: string; signature: string; fingerprint: string };
export type SealName = "auth-session" | "time-guard" | "entitlement" | "offline-vault";

export type SecurityNative = {
  available(): boolean;
  devicePublicKey(): Promise<DevicePublicKey>;
  deviceSign(request: DeviceSignRequest): Promise<DeviceSignature>;
  sealSecret(name: SealName, value: string): Promise<void>;
  unsealSecret(name: SealName): Promise<string | null>;
  clearSecret(name: SealName): Promise<void>;
};

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

const tauriNative: SecurityNative = {
  available: inTauri,
  devicePublicKey: () => invoke<DevicePublicKey>("device_public_key"),
  deviceSign: (request) => invoke<DeviceSignature>("device_sign", { request }),
  sealSecret: (name, value) => invoke<void>("seal_secret", { name, value }),
  unsealSecret: (name) => invoke<string | null>("unseal_secret", { name }),
  clearSecret: (name) => invoke<void>("clear_secret", { name }),
};

let current: SecurityNative = tauriNative;

export function securityNative(): SecurityNative {
  return current;
}

/** Test seam only. Pass null to restore the real adapter. */
export function __setSecurityNativeForTests(n: SecurityNative | null): void {
  current = n ?? tauriNative;
}
