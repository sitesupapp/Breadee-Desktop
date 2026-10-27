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
// PRODUCTION: bootstrapped under the 1.0.38 production GO (2026-10-27) and published by
// the deployed production function (GET /functions/v1/desktop-entitlement); the
// selftest JWS from that deployment verifies against exactly this key. Without a
// production kid a production build ran the legacy 7-day authority (plus the clock
// guard) - it never failed open to "any key".
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
  production: [
    {
      kid: "production-a92b3164756579c9",
      x: "v-ImY8247iD14-WQdleY7-JezkbMgTiGgBflIlEGX0U",
      y: "eUpDUJ4hpb_UB_R8_Mf1bod0X6IABSu5_MwxXEE9-74",
    },
  ],
};
