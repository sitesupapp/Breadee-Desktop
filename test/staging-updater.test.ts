// Staging update delivery (PO decision 2026-10-27, staging parity).
//
// The updater gate now admits staging builds, so the property that keeps a
// staging till off the production channel - and a production till off the
// staging one - has to hold in the COMPILED CONFIG, not in the JS gate. These
// tests compute each build's effective Tauri config exactly the way the CLI does
// (`--config` = RFC 7396 JSON merge patch over tauri.conf.json) and pin:
//
//   * a STAGING build (tauri.staging.conf.json) can reach only the staging
//     channel and trusts only the staging public key;
//   * a PRODUCTION build (base, or base + tauri.release.conf.json) can reach only
//     the production channel and trusts only the production public key;
//   * the two keys differ, so neither can install the other's artifact;
//   * the workflows wire each config to its own environment and nothing else.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./source-helpers.ts";

const root = dirname(fileURLToPath(import.meta.url));
const read = (...p: string[]) => readFileSync(join(root, "..", ...p), "utf8");
const yamlCode = (src: string) => src.replace(/^[^\S\r\n]*#[^\r\n]*$/gm, "");
const dropLineComments = (src: string) => src.replace(/^[^\S\r\n]*\/\/[^\r\n]*(\r?\n)/gm, "");

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** RFC 7396 JSON merge patch - what `tauri build --config <file>` applies. */
function mergePatch(target: Json, patch: Json): Json {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const out: { [k: string]: Json } =
    target !== null && typeof target === "object" && !Array.isArray(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k] ?? null, v);
  }
  return out;
}

const base = JSON.parse(read("src-tauri", "tauri.conf.json"));
const stagingOverlay = JSON.parse(read("src-tauri", "tauri.staging.conf.json"));
const releaseOverlay = JSON.parse(read("src-tauri", "tauri.release.conf.json"));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const effective = (overlay?: Json): any => (overlay ? mergePatch(base, overlay) : base);

const STAGING_CHANNEL = "https://raw.githubusercontent.com/sitesupapp/Breadee-Desktop/desktop-staging-channel/latest.json";
const PRODUCTION_CHANNEL = "https://raw.githubusercontent.com/sitesupapp/Breadee-Desktop/desktop-production-channel/latest.json";
const STAGING_KEY_ID = "E6DC29B33D806B46";
const PRODUCTION_KEY_ID = "B77999D821F82FD7";
const STAGING_REF = "azjxprewycygsocusxjn";
const PRODUCTION_REF = "cltlqfqormkhppmbvyrv";

const keyId = (pubkeyB64: string) => {
  const decoded = Buffer.from(pubkeyB64, "base64").toString("utf8");
  assert.match(decoded, /minisign public key/i, "must be a PUBLIC key");
  assert.equal(/secret key|private key/i.test(decoded), false, "a private key must never be in a config");
  return /public key: ([0-9A-F]+)/.exec(decoded)?.[1];
};

// --- the merge model itself ----------------------------------------------------

test("merge model: objects merge, arrays and scalars replace (as Tauri's --config does)", () => {
  assert.deepEqual(mergePatch({ a: { b: 1, c: [1, 2] } }, { a: { c: [3] } }), { a: { b: 1, c: [3] } });
  assert.deepEqual(mergePatch({ a: 1 }, { a: null }), {});
});

// --- a staging build can only reach staging ------------------------------------

test("a STAGING build reaches only the staging channel and trusts only the staging key", () => {
  const s = effective(stagingOverlay);
  assert.equal(s.identifier, "app.breadee.desktop.staging");
  assert.equal(s.productName, "Breadee Staging");
  assert.deepEqual(s.plugins.updater.endpoints, [STAGING_CHANNEL], "exactly the staging channel");
  assert.equal(keyId(s.plugins.updater.pubkey), STAGING_KEY_ID);
  assert.notEqual(s.plugins.updater.pubkey, base.plugins.updater.pubkey, "never the production key");
  const all = JSON.stringify(s.plugins.updater);
  assert.equal(all.includes("desktop-production-channel"), false);
  assert.equal(all.includes(PRODUCTION_REF), false);
  // Signed updater artifacts are produced (the Staging workflow holds the key).
  assert.equal(s.bundle.createUpdaterArtifacts, true);
  // Passive in-place install is inherited unchanged.
  assert.equal(s.plugins.updater.windows.installMode, "passive");
  for (const forbidden of ["dangerousInsecureTransportProtocol", "dangerousAcceptInvalidCerts", "dangerousAcceptInvalidHostnames"]) {
    assert.equal(forbidden in s.plugins.updater, false, forbidden);
  }
});

test("the staging overlay keeps the Breadee Staging install identity of 1.0.35 (in-place upgrade)", () => {
  // Same identifier => same install dir + same %LOCALAPPDATA% data folder; no
  // mainBinaryName => the same executable name the earlier staging builds used,
  // so NSIS replaces it in place instead of installing a second app.
  assert.equal("mainBinaryName" in stagingOverlay, false);
  assert.equal("mainBinaryName" in base, false);
  // The overlay defines identity + updater only; it is not a second place for
  // the version, windows, CSP or anything else to drift.
  assert.deepEqual(Object.keys(stagingOverlay).sort(), ["$schema", "bundle", "identifier", "plugins", "productName"]);
  assert.deepEqual(Object.keys(stagingOverlay.bundle), ["createUpdaterArtifacts"]);
  assert.deepEqual(Object.keys(stagingOverlay.plugins), ["updater"]);
  assert.deepEqual(Object.keys(stagingOverlay.plugins.updater).sort(), ["endpoints", "pubkey"]);
});

// --- a production build can only reach production ------------------------------

test("a PRODUCTION build reaches only the production channel and trusts only the production key", () => {
  for (const p of [effective(), effective(releaseOverlay)]) {
    assert.equal(p.identifier, "app.breadee.desktop");
    assert.equal(p.productName, "Breadee");
    assert.deepEqual(p.plugins.updater.endpoints, [PRODUCTION_CHANNEL]);
    assert.equal(keyId(p.plugins.updater.pubkey), PRODUCTION_KEY_ID);
    const all = JSON.stringify(p.plugins.updater);
    assert.equal(all.includes("desktop-staging-channel"), false);
    assert.equal(all.includes(STAGING_REF), false);
  }
  assert.notEqual(STAGING_KEY_ID, PRODUCTION_KEY_ID);
});

test("only the staging overlay knows the staging channel or key", () => {
  const dir = join(root, "..", "src-tauri");
  for (const f of readdirSync(dir).filter((n) => /^tauri.*\.json$/.test(n))) {
    if (f === "tauri.staging.conf.json") continue;
    const src = readFileSync(join(dir, f), "utf8");
    assert.equal(src.includes("desktop-staging-channel"), false, `${f} must not name the staging channel`);
    assert.equal(src.includes(stagingOverlay.plugins.updater.pubkey), false, `${f} must not carry the staging key`);
  }
});

// --- the JS gate binds a staging build to the staging identity -----------------

test("a staging build without the staging identity never asks its channel", () => {
  const updaterTs = stripComments(dropLineComments(read("src", "lib", "updater.ts")));
  // The identity the gate requires is exactly the overlay's - endpoint, key and
  // identifier come from the same file, so the identity proves the channel.
  // The gate requires `${APP_IDENTIFIER_ROOT}.${APP_ENV}`: for a staging build that
  // is exactly the overlay's identifier, and the root is the production one.
  const rootId = /export const APP_IDENTIFIER_ROOT = "([^"]+)";/.exec(updaterTs)?.[1];
  assert.equal(rootId, base.identifier);
  assert.equal(`${rootId}.staging`, stagingOverlay.identifier);
  assert.match(updaterTs, /const expected = `\$\{APP_IDENTIFIER_ROOT\}\.\$\{env\.APP_ENV\}`;/);
  // And the check runs before the updater plugin is even loaded.
  const fn = updaterTs.slice(updaterTs.indexOf("export async function checkForUpdate"));
  const mismatchAt = fn.indexOf("await stagingChannelMismatch()");
  const pluginAt = fn.indexOf('import("@tauri-apps/plugin-updater")');
  assert.ok(mismatchAt > 0 && pluginAt > mismatchAt, "identity check precedes check()");
});

// --- workflows wire each config to its own environment --------------------------

const stagingWf = read(".github", "workflows", "desktop-staging-release.yml");
const stagingCode = yamlCode(stagingWf);

test("the staging workflow builds only with the staging overlay, in the Staging environment", () => {
  assert.match(stagingCode, /environment: Staging/);
  assert.equal(/environment: Production/.test(stagingCode), false);
  assert.match(stagingCode, /npm run tauri:build -- --config src-tauri\/tauri\.staging\.conf\.json/);
  assert.equal(stagingCode.includes("tauri.release.conf.json"), false, "never the production override");
  const labels = [...stagingCode.matchAll(/VITE_APP_ENV: (\S+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(labels)], ["staging"]);
  // The signing key is only ever a secret reference (the Staging env's own key).
  const uses = [...stagingCode.matchAll(/TAURI_SIGNING_PRIVATE_KEY: (.+)/g)].map((m) => m[1].trim());
  assert.ok(uses.length >= 1);
  for (const use of uses) assert.equal(use, "${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}");
});

test("the staging workflow fails closed on identity, endpoint, key and backend", () => {
  for (const guard of [
    "Staging identity is not",
    "Staging updater endpoint points at the PRODUCTION channel",
    "Staging updater endpoint is not the staging channel",
    "does not carry the STAGING updater public key",
    "renames the main binary",
    "The Staging environment points at the PRODUCTION project",
    "The built bundle references the PRODUCTION project",
    "The embedded bundle references the PRODUCTION project",
    "No updater signature was produced",
    "Version mismatch",
    "What's New describes",
  ]) {
    assert.ok(stagingWf.includes(guard), `missing guard: ${guard}`);
  }
  assert.match(stagingCode, /STAGING_PUBKEY_ID: E6DC29B33D806B46/);
  assert.match(stagingCode, /PRODUCTION_PUBKEY_ID: B77999D821F82FD7/);
});

test("the staging workflow publishes only on a staging tag and writes only the staging channel", () => {
  const triggers = stagingCode.slice(stagingCode.indexOf("\non:"), stagingCode.indexOf("permissions:"));
  assert.match(triggers, /tags: \['desktop-staging-v\*'\]/);
  assert.equal(/desktop-prod-v/.test(triggers), false);
  assert.match(stagingCode, /CHANNEL_BRANCH: desktop-staging-channel/);
  // Every publish step is tag-gated; a dispatch is build-only.
  for (const step of ["Publish the staging GitHub release", "Advance the STAGING channel"]) {
    const at = stagingCode.indexOf(step);
    assert.ok(at > 0, step);
    assert.match(stagingCode.slice(at, at + 200), /if: startsWith\(github\.ref, 'refs\/tags\/'\)/, step);
  }
  // The production channel appears only inside the refusal guard.
  const prodMentions = stagingCode.split("\n").filter((l) => l.includes("desktop-production-channel"));
  assert.ok(prodMentions.length >= 1 && prodMentions.every((l) => l.includes("Refusing")), prodMentions.join("\n"));
  // History-preserving advance: no orphan force-push (checkpoints survive), and
  // an older-or-equal version is refused.
  assert.equal(/push --force|push -f\b|checkout --orphan/.test(stagingCode), false);
  assert.match(stagingCode, /is not newer than the channel's/);
});

test("production workflows never use the staging overlay, channel or environment", () => {
  for (const f of ["desktop-production-release.yml", "desktop-production-build-only.yml", "desktop-windows-production.yml"]) {
    const src = yamlCode(read(".github", "workflows", f));
    assert.equal(src.includes("tauri.staging.conf.json"), false, f);
    assert.equal(src.includes("desktop-staging-channel"), false, f);
    assert.equal(/environment: Staging/.test(src), false, f);
  }
});

// --- 1.0.38 ------------------------------------------------------------------------

test("1.0.38 staging builds compile the 1.0.38 server contracts ON, and prove it", () => {
  // Both builds (explicit frontend build + tauri's beforeBuildCommand re-build).
  const flags = [...stagingCode.matchAll(/VITE_SERVER_1038_CONTRACTS: (\S+)/g)].map((m) => m[1]);
  assert.deepEqual(flags, ['"1"', '"1"']);
  assert.ok(stagingWf.includes("The 1.0.38 contracts flag is NOT enabled in the bundle"));
  assert.ok(stagingWf.includes("The embedded bundle does not have the 1.0.38 contracts flag ON"));
  // Release builds stay without RC diagnostics ("official behaviour" parity).
  assert.equal(/VITE_RC_DIAGNOSTICS/.test(stagingCode), false);
});

test("there is ONE staging identity: the acceptance installer uses the staging overlay, unsigned", () => {
  // staging1038 (a second "Breadee Staging" app with its own exe and data folder)
  // is retired - every staging build is app.breadee.desktop.staging.
  const installer = yamlCode(read(".github", "workflows", "desktop-windows-installer.yml"));
  for (const src of [installer, stagingCode, JSON.stringify(stagingOverlay)]) {
    assert.equal(src.includes("staging1038"), false);
    assert.equal(src.includes("breadee-staging.exe"), false);
  }
  assert.match(installer, /--config src-tauri\/tauri\.staging\.conf\.json --config "\$RUNNER_TEMP\/no-updater-artifacts\.json"/);
  assert.match(installer, /'\{"bundle":\{"createUpdaterArtifacts":false\}\}'/);
  // No signing key and no production override in the acceptance installer.
  assert.equal(installer.includes("TAURI_SIGNING_PRIVATE_KEY"), false);
  assert.equal(installer.includes("tauri.release.conf.json"), false);
  assert.match(installer, /test -f "src-tauri\/target\/release\/breadee-desktop\.exe"/);
});

test("What's New: the approved bilingual text leads, plus the offline-first page, describing exactly this version", () => {
  const whatsNew = read("src", "lib", "whatsNew.ts");
  assert.match(whatsNew, new RegExp(`export const WHATS_NEW_VERSION = "${base.version.replace(/\./g, "\\.")}";`));
  assert.equal(base.version, "1.0.38");
  const lit = (key: string) => JSON.parse(new RegExp(`\\b${key}:\\s*("(?:[^"\\\\]|\\\\.)*")`).exec(whatsNew)![1]);
  assert.match(whatsNew, /glyph: "sync"/);
  assert.equal(lit("title"), "Expanded Full Offline POS");
  assert.equal(lit("titleAr"), "توسعة وضع العمل الكامل دون اتصال");
  assert.equal(
    lit("body"),
    "Ready Desktop now supports a broader end-to-end offline lifecycle, including improved Dine-In Merge and Move handling, offline shift transitions, safer offline payments, stronger reconnect reconciliation, improved order history, and clearer Sync Center dependency and conflict status. Offline operations remain protected against duplicate financial effects and reconcile automatically when connectivity returns.",
  );
  assert.equal(
    lit("bodyAr"),
    "أصبح Ready Desktop يدعم دورة عمل أوسع دون اتصال، بما في ذلك تحسين عمليات الدمج والنقل في Dine-In، والانتقال بين الورديات دون اتصال، وحماية أكبر لعمليات الدفع، وتحسين المزامنة بعد عودة الاتصال، وسجل الطلبات، وحالات التعارض والانتظار في Sync Center. تتم مزامنة العمليات تلقائياً عند عودة الاتصال مع الحماية من تكرار التأثيرات المالية.",
  );
});
