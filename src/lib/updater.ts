// Application update delivery. The ONLY place the desktop talks to the updater.
//
// WHAT THIS IS FOR. After one manual bootstrap install, a production terminal
// should be able to take a fix without anyone visiting GitHub, downloading a
// zip, or uninstalling anything. Tauri's updater does the hard parts - fetching
// the manifest, verifying the signature against the public key compiled into the
// app, and installing - so this module is deliberately thin: it decides WHEN to
// ask, and turns the outcomes into states a screen can render.
//
// THREE RULES SHAPE EVERYTHING BELOW.
//
// 1. STAGING MUST NEVER CONSUME THE PRODUCTION CHANNEL. This repository has
//    already published a release tagged `desktop-v1.0.0-rc1-staging`. A generic
//    "latest release" endpoint would happily serve that to a production till, so
//    the endpoint is a dedicated production-only manifest AND every entry point
//    here refuses to run unless `env.IS_PRODUCTION`. Two independent guards,
//    because either one alone is a single point of failure.
//
// 2. AN UPDATE OUTAGE MUST NEVER STOP A TILL OPENING. GitHub being unreachable,
//    a malformed manifest, a rejected signature, a failed download - none of
//    these may prevent Breadee from starting or from taking money. Every path
//    here resolves to a state; nothing throws to the caller, and the startup
//    check is fire-and-forget.
//
// 3. THE CASHIER DECIDES WHEN THE APP RESTARTS. Nothing downloads or installs
//    without an explicit click, and the restart happens at the end of a flow the
//    user started. A POS that relaunches itself mid-order is worse than a POS
//    running last week's build.

import { env } from "@/env";
import { isNewerThan } from "@/lib/version";

/** What the app currently reports as its own version. */
export const CURRENT_VERSION: string = env.APP_VERSION;

/**
 * The version the RUNNING BINARY reports, read from Tauri at runtime.
 *
 * `CURRENT_VERSION` above is baked into the JS bundle by Vite (from package.json),
 * so a WebView that serves a stale frontend after an in-place update can display a
 * version older than the binary actually is - which is exactly the symptom this
 * resolves. Tauri's `getVersion()` returns the version compiled into the app from
 * `tauri.conf.json`, read across the IPC boundary from Rust, so it is always the
 * true installed version regardless of any frontend asset caching. Falls back to
 * the baked value outside Tauri (dev / browser) or if the call ever fails - the
 * display must never throw.
 */
export async function resolveRuntimeVersion(): Promise<string> {
  try {
    if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
      const { getVersion } = await import("@tauri-apps/api/app");
      const v = (await getVersion()).trim();
      if (v) return v;
    }
  } catch {
    /* fall through to the baked value */
  }
  return CURRENT_VERSION;
}

export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  /** Checked successfully; the installed version is the newest published one. */
  | { kind: "up-to-date"; checkedAt: number }
  | { kind: "available"; version: string; notes: string | null; date: string | null }
  | { kind: "downloading"; version: string; percent: number | null }
  | { kind: "installing"; version: string }
  /** Installed and waiting for the relaunch the user asked for. */
  | { kind: "ready"; version: string }
  /**
   * Something went wrong, and the app carries on regardless. `silent` marks the
   * ordinary conditions - offline, endpoint down - that a till should never be
   * nagged about; a manual check still shows them, because there the user asked.
   */
  | { kind: "error"; message: string; silent: boolean };

/**
 * Is the updater usable in this build at all?
 *
 * False in dev, in the browser, and in every staging build. Staging is excluded
 * on purpose and not as an oversight: the production manifest describes
 * production binaries, and a staging terminal that "updated" itself onto one
 * would silently change which database it talks to.
 */
export function isUpdaterAvailable(): boolean {
  if (!env.IS_PRODUCTION) return false;
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Why the updater is unavailable, in words a support technician can act on. */
export function unavailableReason(): string | null {
  if (!isUpdaterAvailable()) {
    if (!env.IS_PRODUCTION) return `Updates are delivered to production builds only (this is ${env.APP_ENV}).`;
    return "Updates are available only in the installed Desktop app.";
  }
  return null;
}

/** True only when `candidate` is a well-formed version strictly newer than ours. */
export function isNewerThanCurrent(candidate: string, current: string = CURRENT_VERSION): boolean {
  return isNewerThan(candidate, current);
}

/**
 * The updater handle, kept between "check" and "install".
 *
 * Held here rather than in React state because it is not renderable data and
 * must survive a component unmounting mid-download.
 */
type UpdateHandle = {
  version: string;
  downloadAndInstall: (onEvent?: (e: DownloadEvent) => void) => Promise<void>;
};

type DownloadEvent =
  | { event: "Started"; data?: { contentLength?: number } }
  | { event: "Progress"; data?: { chunkLength?: number } }
  | { event: "Finished" };

let pending: UpdateHandle | null = null;

/** Forget any held update - used when a check supersedes an earlier result. */
export function clearPendingUpdate(): void {
  pending = null;
}

export function hasPendingUpdate(): boolean {
  return pending !== null;
}

/**
 * Ask the production channel whether there is a newer version.
 *
 * `silent` marks the automatic startup check, whose failures are not worth
 * interrupting anyone over.
 */
export async function checkForUpdate(options: { silent: boolean }): Promise<UpdateState> {
  const reason = unavailableReason();
  if (reason) return { kind: "error", message: reason, silent: true };

  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const found = await check();
    if (!found) {
      pending = null;
      return { kind: "up-to-date", checkedAt: Date.now() };
    }

    // Tauri already decided this is newer, and already verified the signature.
    // Re-checking the version is belt-and-braces against a manifest that
    // advertises a downgrade: installing one would be a silent rollback of a
    // financial fix, which is the worst outcome this feature can produce.
    if (!isNewerThanCurrent(found.version)) {
      pending = null;
      return { kind: "up-to-date", checkedAt: Date.now() };
    }

    pending = found as unknown as UpdateHandle;
    return {
      kind: "available",
      version: found.version,
      notes: found.body?.trim() ? found.body.trim() : null,
      date: found.date ?? null,
    };
  } catch (error) {
    pending = null;
    return {
      kind: "error",
      message: describe(error),
      silent: options.silent,
    };
  }
}

/**
 * Download and install the update that `checkForUpdate` found.
 *
 * Does NOT restart. The caller relaunches once the user is ready, so the last
 * word on when a till goes down belongs to the person standing at it.
 */
export async function downloadAndInstall(onState: (s: UpdateState) => void): Promise<UpdateState> {
  const update = pending;
  if (!update) {
    const state: UpdateState = { kind: "error", message: "No update is ready to install.", silent: false };
    onState(state);
    return state;
  }

  const version = update.version;
  let total: number | null = null;
  let received = 0;

  try {
    onState({ kind: "downloading", version, percent: null });
    await update.downloadAndInstall((event) => {
      if (event.event === "Started") {
        total = event.data?.contentLength ?? null;
        onState({ kind: "downloading", version, percent: total ? 0 : null });
      } else if (event.event === "Progress") {
        received += event.data?.chunkLength ?? 0;
        // A null percent means "we genuinely do not know" - shown as an
        // indeterminate bar rather than a fabricated number.
        const percent = total && total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null;
        onState({ kind: "downloading", version, percent });
      } else if (event.event === "Finished") {
        onState({ kind: "installing", version });
      }
    });
    pending = null;
    const ready: UpdateState = { kind: "ready", version };
    onState(ready);
    return ready;
  } catch (error) {
    // The old version is still installed and still works. Say so, because the
    // instinct after a failed update is to start uninstalling things.
    const state: UpdateState = {
      kind: "error",
      message: `${describe(error)} Breadee has not been changed - the current version is still installed.`,
      silent: false,
    };
    onState(state);
    return state;
  }
}

/** Relaunch into the version that was just installed. */
export async function relaunchApp(): Promise<void> {
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}

function describe(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const text = raw.toLowerCase();
  // The three failures worth naming, because each has a different action.
  if (text.includes("network") || text.includes("fetch") || text.includes("dns") || text.includes("connect")) {
    return "Could not reach the update server.";
  }
  if (text.includes("signature") || text.includes("verify") || text.includes("minisign")) {
    return "The update failed its signature check and was refused.";
  }
  if (text.includes("permission") || text.includes("denied") || text.includes("access")) {
    return "Windows refused the update. It may need to be installed manually.";
  }
  return raw.trim() !== "" ? raw.trim() : "The update could not be completed.";
}
