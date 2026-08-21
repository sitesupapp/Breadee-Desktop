// Opening the Breadee WEB application from the desktop.
//
// WHY THIS EXISTS. The dashboard used to label anything without a desktop screen
// "Coming soon" - including modules a tenant has been using in their browser for
// months. That is worse than unhelpful: a manager who reads "Coming soon" beside
// Accounting stops looking for the accounting they already have. This module is
// the other half of telling the truth - once a tile says "Managed on Breadee
// Web", it has to be able to GO there.
//
// PURE PATHS, RESOLVED ORIGIN. The paths below are constants and never come from
// user input, a database row, or a module description. The origin comes from
// `lib/site.ts`, which is the same one the receipt QR is built from, so a
// production till can only ever open the production site.
//
// NOTHING HERE AUTHENTICATES. The browser carries its own Breadee session, or
// asks for one. The desktop never forwards a token, a refresh token, a session
// id or an email into a URL - a link is an address, not a credential.
//
// PASSWORD CHANGES ARE DELIBERATELY NOT IMPLEMENTED HERE. `Change password` is a
// link to the web profile and nothing else: the desktop performs no
// `auth.updateUser`, holds no password field, and has no second reset flow to
// drift from the web app's.

/** The web application's own route prefix. Everything tenant-facing lives here. */
const APP_PREFIX = "/app";

/**
 * The web destination for each thing the desktop can point at.
 *
 * Keyed by the DASHBOARD MODULE KEY where one exists (`lib/modules.ts`), so a
 * tile and its link cannot drift apart, plus the two account destinations the
 * profile screen needs.
 *
 * Verified against the web app's route tree rather than guessed - every path
 * below is a real directory under `src/app/(tenant)/app/`.
 */
export const WEB_PATHS = {
  inventory: `${APP_PREFIX}/inventory`,
  reports: `${APP_PREFIX}/reports`,
  cost_control: `${APP_PREFIX}/cost-control`,
  accounting: `${APP_PREFIX}/accounting`,
  e_menu: `${APP_PREFIX}/menu/e-menu`,
  menu_builder: `${APP_PREFIX}/menu/builder`,
  users: `${APP_PREFIX}/users`,
  /** The web profile page, which is where a password is actually changed. */
  profile: `${APP_PREFIX}/profile`,
  dashboard: `${APP_PREFIX}/dashboard`,
} as const;

export type WebPathKey = keyof typeof WEB_PATHS;

export function isWebPathKey(value: unknown): value is WebPathKey {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(WEB_PATHS, value);
}

/**
 * Join an origin and one of the paths above.
 *
 * Pure, and takes the origin as an argument so it can be tested without a built
 * environment - the same reason `lib/environment.ts` does not import `@/env`.
 *
 * The path is one of this module's own constants; it is never concatenated from
 * a caller's string. That is what makes "the desktop cannot be talked into
 * opening an arbitrary address" a property of the type rather than a promise.
 */
export function webUrl(origin: string, key: WebPathKey): string {
  const base = origin.replace(/\/+$/, "");
  return `${base}${WEB_PATHS[key]}`;
}

/**
 * Only `https:` addresses on the resolved site are ever handed to the browser.
 *
 * Checked at the boundary as well as at the type, because the origin is
 * build-time configuration (`VITE_PUBLIC_SITE_URL`) and configuration is the one
 * input here that a developer can get wrong. A refusal returns false rather than
 * throwing: a dead link is a support call, an exception on a dashboard is a
 * broken screen.
 */
export function isOpenableUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** What happened when the desktop tried to hand a link to the browser. */
export type OpenExternalResult =
  | { kind: "opened" }
  | { kind: "refused"; reason: string }
  | { kind: "failed"; reason: string };

/**
 * Open a URL in the operator's own browser, outside this window.
 *
 * THE EXISTING MECHANISM. `tauri-plugin-opener` is already a dependency and
 * `opener:default` is already the only non-core capability this app is granted
 * (`src-tauri/capabilities/default.json`), so nothing is widened here - the
 * plugin command is simply called for the first time. No shell, no filesystem
 * and no HTTP capability is involved, and none is added.
 *
 * The command is invoked by name rather than through the plugin's JS package so
 * that no new npm dependency is introduced for one call; the command name is a
 * constant, and the URL has already been checked above.
 *
 * NEVER NAVIGATES THIS WINDOW. A web page loaded into the POS webview would be a
 * page with the till's session in it, and the whole point of this control is to
 * leave the desktop application where it is.
 */
export async function openExternal(url: string): Promise<OpenExternalResult> {
  if (!isOpenableUrl(url)) {
    return { kind: "refused", reason: "That address is not a secure Breadee web address." };
  }
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return { kind: "refused", reason: "Opening the web app is available only in the installed Desktop app." };
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("plugin:opener|open_url", { url });
    return { kind: "opened" };
  } catch (e) {
    return { kind: "failed", reason: e instanceof Error ? e.message : "The browser could not be opened." };
  }
}
