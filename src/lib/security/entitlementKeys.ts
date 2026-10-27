// Final Foundation - the ONLY keys an offline entitlement may be signed with.
//
// Public keys only (P-256 JWK x/y). Each environment's private scalar lives in that
// environment's Supabase Vault (generated in-database, never exported) and is used
// solely by the `desktop-entitlement` Edge Function. A forged signer would need a
// signed app update to get its key in here.
//
// STAGING: published by the deployed staging function (GET /functions/v1/
// desktop-entitlement) on 2026-10-27; the selftest JWS from that deployment verifies
// against exactly this key.
//
// PRODUCTION: intentionally EMPTY until the production key is bootstrapped under an
// exact GO (docs/offline/migrations/foundation_desktop_devices_PROD_README.md). While
// it is empty a production build runs the legacy 7-day authority (plus the clock
// guard) - it does not fail open to "any key" and it does not lock every till out.
// Rotation: ADD the new kid here first (ship), then switch the signer; never remove a
// kid that unexpired entitlements still carry until 7 days after the switch.

import type { env } from "@/env";

/** The build environments (type-only: names come from env.ts, never restated here). */
export type AppEnv = typeof env.APP_ENV;

export type EntitlementPublicKey = { kid: string; x: string; y: string };

export const ENTITLEMENT_PUBLIC_KEYS: Readonly<Record<AppEnv, readonly EntitlementPublicKey[]>> = {
  staging: [
    {
      kid: "staging-b9e35d0a78f72566",
      x: "gA_7Yzs-NsK4w-r7ZCVSKIZKfBAjoWhI9zW9_43psPE",
      y: "iX2_LRM2C-UBaG8M24t048aYnK8gni23dxtIkBfUXiY",
    },
  ],
  production: [],
};
