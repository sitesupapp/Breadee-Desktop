// The STAGING update path.
//
// Companion to production-updater.test.ts. The staging desktop app self-updates
// from its OWN isolated channel, and these are the properties that keep that
// safe AND working - the second half is the point of this file, because a
// regression once disabled the staging updater entirely (it reported "updates
// are delivered to production builds only") and no test caught it:
//
//   * a STAGING build updates from `desktop-staging-channel` and NEVER from the
//     production channel or a generic /releases/latest;
//   * the staging manifest is signed with the STAGING key, distinct from the
//     production key;
//   * the updater is ENABLED in a packaged staging build;
//   * the update decision reads the RUNNING binary's version, not a baked one;
//   * a downgrade or an equal version is never offered.
//
// Like the production suite, `lib/updater` is asserted at SOURCE level rather
// than imported: it reads build-time `import.meta.env`, which the node test
// runner does not provide. Only the pure version rule is imported for real.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { compareVersions, isNewerThan } from "@/lib/version";

const root = dirname(fileURLToPath(import.meta.url));
const read = (...p: string[]) => readFileSync(join(root, "..", ...p), "utf8");
// tauri.staging.conf.json is saved with a UTF-8 BOM, which JSON.parse rejects.
const readJson = (...p: string[]) => JSON.parse(read(...p).replace(/^﻿/, ""));

const baseConf = readJson("src-tauri", "tauri.conf.json");
const stagingConf = readJson("src-tauri", "tauri.staging.conf.json");
const updaterTs = read("src", "lib", "updater.ts");
const envTs = read("src", "env.ts");
const storeTs = read("src", "state", "updates.ts");
const stagingRelease = read(".github", "workflows", "desktop-staging-release.yml");

const STAGING_REF = "azjxprewycygsocusxjn";
const PRODUCTION_REF = "cltlqfqormkhppmbvyrv";
const STAGING_CHANNEL = "desktop-staging-channel";
const PRODUCTION_CHANNEL = "desktop-production-channel";
const STAGING_IDENTITY = "app.breadee.desktop.staging";

// --- staging is enabled, and availability is environment-aware ---------------

test("the updater is enabled in a packaged staging build", () => {
  // The regression: `if (!env.IS_PRODUCTION) return false` disabled staging even
  // though staging has its own channel + key. Availability must be env-aware:
  // a native build in a recognized release env, production OR staging.
  assert.match(updaterTs, /const isNativeApp = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;/);
  assert.match(updaterTs, /if \(!isNativeApp\) return false;/);
  assert.match(updaterTs, /return env\.IS_PRODUCTION \|\| env\.IS_STAGING;/);
  // env exposes the staging flag the gate reads.
  assert.match(envTs, /IS_STAGING: APP_ENV === "staging"/);
  // The obsolete production-only lockout and its message must be gone entirely.
  assert.equal(/if \(!env\.IS_PRODUCTION\) return false;/.test(updaterTs), false);
  assert.equal(/Updates are delivered to production builds only/.test(updaterTs), false);
});

test("an unrecognized environment fails safe rather than defaulting to a channel", () => {
  // A build must be BOTH native and a recognized release env. env.ts admits only
  // "staging" and "production" (and throws otherwise), so a mislabelled build can
  // never reach an updater channel by falling back to a default.
  assert.match(envTs, /const APP_ENVIRONMENTS = \["staging", "production"\]/);
  assert.match(updaterTs, /return env\.IS_PRODUCTION \|\| env\.IS_STAGING;/);
  // Both entry points - the startup check and a manual check - go through the gate.
  assert.match(storeTs, /if \(!isUpdaterAvailable\(\)\)/);
  assert.match(updaterTs, /const reason = unavailableReason\(\);\s*if \(reason\) return/);
});

// --- staging channel isolation -----------------------------------------------

test("the staging build reads ONLY the staging channel over HTTPS", () => {
  const endpoints: string[] = stagingConf.plugins.updater.endpoints;
  assert.equal(endpoints.length, 1, "exactly one endpoint");
  const url = endpoints[0];
  assert.ok(url.startsWith("https://"), "HTTPS only");
  assert.ok(url.includes(STAGING_CHANNEL), "must read the staging channel branch");
  assert.ok(url.endsWith("/latest.json"));
  // Never the production channel, the production project, or a generic latest.
  assert.equal(url.includes(PRODUCTION_CHANNEL), false, "must never read the production channel");
  assert.equal(url.includes(PRODUCTION_REF), false, "must never mention the production project");
  assert.equal(/releases\/latest/.test(url), false, "a generic latest endpoint could serve a staging RC");
});

test("the staging build carries the isolated staging identity", () => {
  assert.equal(stagingConf.identifier, STAGING_IDENTITY);
  assert.equal(stagingConf.productName, "Breadee Staging");
});

test("the staging manifest is signed with a distinct staging public key", () => {
  const stagingKey: string = stagingConf.plugins.updater.pubkey;
  const productionKey: string = baseConf.plugins.updater.pubkey;
  assert.ok(stagingKey && stagingKey.length > 40, "a staging public key must be configured");
  const decoded = Buffer.from(stagingKey, "base64").toString("utf8");
  assert.match(decoded, /minisign public key/i);
  assert.equal(/private key/i.test(decoded), false, "a PRIVATE key must never be in the config");
  assert.notEqual(stagingKey, productionKey, "staging and production must not share a signing key");
});

test("staging turns updater artifacts ON so the channel gets a signature", () => {
  assert.equal(stagingConf.bundle.createUpdaterArtifacts, true, "staging must produce the .sig the channel serves");
  // ...while the base config keeps them off (only an override enables them).
  assert.equal(baseConf.bundle.createUpdaterArtifacts, false);
});

// --- production isolation, cross-checked from the staging side ----------------

test("the production build reads ONLY the production channel", () => {
  const url: string = baseConf.plugins.updater.endpoints[0];
  assert.ok(url.includes(PRODUCTION_CHANNEL), "the base config must read the production channel");
  assert.equal(url.includes(STAGING_CHANNEL), false, "the production build must never read the staging channel");
  assert.equal(url.includes(STAGING_REF), false);
});

// --- the update decision uses the RUNNING binary version ----------------------

test("the update comparison uses the running binary version, not the baked one", () => {
  // A stale frontend asset can leave the Vite-baked CURRENT_VERSION behind the
  // real installed version; the re-check must read the native version so it never
  // suppresses or re-offers an update against a number the binary does not report.
  const check = updaterTs.slice(updaterTs.indexOf("export async function checkForUpdate"));
  assert.match(check, /const runningVersion = await resolveRuntimeVersion\(\);/);
  assert.match(check, /isNewerThanCurrent\(found\.version, runningVersion\)/);
  assert.match(updaterTs, /export async function resolveRuntimeVersion/);
  assert.match(updaterTs, /getVersion/);
});

test("only a strictly newer version is offered; equal and older are refused", () => {
  assert.equal(isNewerThan("1.0.25", "1.0.24"), true, "a newer version is an update");
  assert.equal(isNewerThan("1.0.24", "1.0.24"), false, "the same version is not an update");
  assert.equal(isNewerThan("1.0.23", "1.0.24"), false, "a downgrade is never offered");
  assert.ok(compareVersions("1.0.25", "1.0.24") > 0);
});

// --- the staging release workflow --------------------------------------------

test("the staging release builds with the staging config and advances only the staging channel", () => {
  assert.match(stagingRelease, /tags:\s*\[['"]desktop-staging-v\*['"]\]/);
  assert.match(stagingRelease, /--config src-tauri\/tauri\.staging\.conf\.json/);
  assert.match(stagingRelease, /CHANNEL_BRANCH: desktop-staging-channel/);
  // Fail-closed: it asserts the staging identity and backend, and refuses to
  // publish a build whose updater endpoint points at the production channel.
  assert.ok(stagingRelease.includes(STAGING_IDENTITY), "asserts the staging identity");
  assert.ok(stagingRelease.includes(STAGING_REF), "asserts the staging backend");
  assert.match(stagingRelease, /desktop-production-channel\*\) echo/);
});
