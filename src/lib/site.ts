// WHERE THE BREADEE WEB APPLICATION LIVES, for this build.
//
// EXTRACTED, NOT INVENTED. This decision already existed - `lib/pos/paymentQr.ts`
// has resolved the public site per environment since the receipt QR was added,
// and it is the address the web app itself encodes. Desktop now needs the same
// origin for a second reason (opening a web-managed module in the browser), and
// two modules deciding independently which site a production till points at is
// exactly how one of them ends up naming staging.
//
// So the decision moved here and `paymentQr.ts` re-exports it. There is one
// origin, chosen once, per build.
//
// DECLARED PER BUILD, NEVER GUESSED. `VITE_PUBLIC_SITE_URL` overrides it so a
// custom domain needs no code change; otherwise the environment's own default is
// used. `env.ts` has already refused to start on an unknown environment, so the
// lookup below cannot miss.

import { env } from "@/env";

/** The site a build points at, per environment. */
export const DEFAULT_PUBLIC_SITE: Record<"staging" | "production", string> = {
  staging: "https://stagingbreadee.netlify.app",
  production: "https://breadee.com",
};

/**
 * The origin, with no trailing slash, path, query or hash.
 *
 * A misconfigured override falls back to the environment default rather than
 * throwing: a bad value must not stop a till from starting, and pointing at the
 * right environment is strictly better than pointing at nothing.
 */
export function publicSiteOrigin(): string {
  const configured = (import.meta.env.VITE_PUBLIC_SITE_URL as string | undefined)?.trim();
  const raw = configured && configured !== "" ? configured : DEFAULT_PUBLIC_SITE[env.APP_ENV];
  try {
    return new URL(raw).origin;
  } catch {
    return DEFAULT_PUBLIC_SITE[env.APP_ENV];
  }
}
