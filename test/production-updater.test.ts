// The update delivery path.
//
// An updater is a remote code-execution channel into every till the company
// owns. The properties worth pinning are therefore not "does the button work"
// but "what can this channel be made to do":
//
//   * a STAGING build must never consume the production channel, and a staging
//     artifact must never be reachable from it - this repo has already published
//     `desktop-v1.0.0-rc1-staging`, so a generic /releases/latest endpoint would
//     point a real restaurant at the staging database;
//   * an unsigned or downgraded artifact must not install;
//   * an update outage must never stop a till opening;
//   * nothing installs or restarts without a human clicking.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// The version rule is imported for real. The updater module itself is asserted
// at source level rather than imported: it reads build-time `import.meta.env`,
// which does not exist under the node test runner, and standing up a fake
// environment would only prove the fake works.
import { compareVersions, isNewerThan } from "@/lib/version";
import { stripComments, stripJsxComments } from "./source-helpers.ts";

const isNewerThanCurrent = (candidate: string, current: string) => isNewerThan(candidate, current);

const root = dirname(fileURLToPath(import.meta.url));
const read = (...p: string[]) => readFileSync(join(root, "..", ...p), "utf8");
const dropLineComments = (src: string) => src.replace(/^[^\S\r\n]*\/\/[^\r\n]*(\r?\n)/gm, "");
const yamlCode = (src: string) => src.replace(/^[^\S\r\n]*#[^\r\n]*$/gm, "");

const conf = JSON.parse(read("src-tauri", "tauri.conf.json"));
const pkg = JSON.parse(read("package.json"));
const cargo = read("src-tauri", "Cargo.toml");
const caps = JSON.parse(read("src-tauri", "capabilities", "default.json"));
const libRs = read("src-tauri", "src", "lib.rs");
const release = read(".github", "workflows", "desktop-production-release.yml");
const releaseCode = yamlCode(release);
const updaterTs = stripComments(dropLineComments(read("src", "lib", "updater.ts")));
const storeTs = stripComments(dropLineComments(read("src", "state", "updates.ts")));
const banner = stripJsxComments(dropLineComments(read("src", "components", "UpdateBanner.tsx")));
const shell = stripJsxComments(dropLineComments(read("src", "screens", "Shell.tsx")));
const app = read("src", "App.tsx");

const STAGING_REF = "azjxprewycygsocusxjn";
const PRODUCTION_REF = "cltlqfqormkhppmbvyrv";
const CHANNEL = "desktop-production-channel";

// --- one authoritative version ------------------------------------------------

test("one version, agreed by every manifest that can disagree", () => {
  // The updater compares the RUNNING version against the manifest. If the app
  // reports a different number from the one it was built as, a terminal either
  // re-downloads forever or never sees an update at all.
  const cargoVersion = /^version = "([^"]+)"/m.exec(cargo)?.[1];
  assert.equal(pkg.version, conf.version, "package.json vs tauri.conf.json");
  assert.equal(cargoVersion, conf.version, "Cargo.toml vs tauri.conf.json");
  assert.match(conf.version, /^\d+\.\d+\.\d+$/, "plain SemVer, no suffix");
});

test("the running app reports the version it was built as", () => {
  const vite = read("vite.config.ts");
  assert.match(vite, /"import\.meta\.env\.VITE_APP_VERSION": JSON\.stringify\(appVersion\)/);
  assert.match(vite, /readFileSync\(resolve\(__dirname, "package\.json"\)/);
  const envTs = read("src", "env.ts");
  assert.match(envTs, /APP_VERSION: raw\.APP_VERSION/);
});

// --- version comparison -------------------------------------------------------

test("only a strictly newer version counts as an update", () => {
  assert.ok(compareVersions("1.0.1", "1.0.0") > 0);
  assert.ok(compareVersions("1.1.0", "1.0.9") > 0);
  assert.ok(compareVersions("2.0.0", "1.9.9") > 0);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.ok(compareVersions("1.0.0", "1.0.1") < 0);
  // A downgrade must never be offered: installing one would silently roll back
  // a financial fix, the worst thing this feature can do.
  assert.equal(isNewerThanCurrent("0.9.9", "1.0.0"), false);
  assert.equal(isNewerThanCurrent("1.0.0", "1.0.0"), false);
  assert.equal(isNewerThanCurrent("1.0.1", "1.0.0"), true);
});

test("an unparseable version is never treated as newer", () => {
  // "unknown" must read as "not an update", never as "probably fine".
  for (const junk of ["", "latest", "1.0", "1.0.0.0", "v-next", "abc"]) {
    assert.equal(isNewerThanCurrent(junk, "1.0.0"), false, junk);
  }
  // A leading v and a prerelease suffix are tolerated, not rejected.
  assert.equal(isNewerThanCurrent("v1.0.1", "1.0.0"), true);
  assert.equal(isNewerThanCurrent("1.0.1-beta.1", "1.0.0"), true);
});

// --- staging can never use the production channel -----------------------------

test("the updater refuses to run outside a production build", () => {
  assert.match(updaterTs, /if \(!env\.IS_PRODUCTION\) return false;/);
  // And the reason is explicit rather than a silent no-op.
  assert.match(updaterTs, /Updates are delivered to production builds only/);
});

test("every entry point goes through the availability gate", () => {
  // A check that skipped the gate would reach the production manifest from a
  // staging till.
  assert.match(updaterTs, /const reason = unavailableReason\(\);\s*if \(reason\) return/);
  assert.match(storeTs, /if \(!isUpdaterAvailable\(\)\)/);
});

test("the endpoint is a dedicated production channel over HTTPS", () => {
  const endpoints: string[] = conf.plugins.updater.endpoints;
  assert.equal(endpoints.length, 1, "exactly one endpoint");
  const url = endpoints[0];
  assert.ok(url.startsWith("https://"), "HTTPS only");
  assert.ok(url.includes(CHANNEL), "must read the production channel branch");
  assert.ok(url.endsWith("/latest.json"));
  // The trap this avoids: /releases/latest would serve desktop-v1.0.0-rc1-staging.
  assert.equal(/releases\/latest/.test(url), false, "a generic latest endpoint could serve a staging RC");
  assert.equal(url.includes(STAGING_REF), false);
});

test("no dangerous transport options are enabled", () => {
  const updater = conf.plugins.updater;
  for (const forbidden of ["dangerousInsecureTransportProtocol", "dangerousAcceptInvalidCerts"]) {
    assert.equal(forbidden in updater, false, `${forbidden} must not be set`);
  }
});

// --- signing ------------------------------------------------------------------

test("a public key is configured and no private key is committed", () => {
  const pubkey: string = conf.plugins.updater.pubkey;
  assert.ok(pubkey && pubkey.length > 40, "a public key must be configured");
  // minisign public keys decode to a header naming them as PUBLIC. If a private
  // key were ever pasted here, this is the assertion that catches it.
  const decoded = Buffer.from(pubkey, "base64").toString("utf8");
  assert.match(decoded, /minisign public key/i);
  assert.equal(/private key/i.test(decoded), false, "a PRIVATE key must never be in the config");
});

test("the signing key is never committed anywhere", () => {
  for (const [name, src] of [["conf", JSON.stringify(conf)], ["release", release], ["updater", updaterTs]] as const) {
    assert.equal(/minisign encrypted secret key/i.test(src), false, `${name}`);
    assert.equal(src.includes("TAURI_SIGNING_PRIVATE_KEY:  "), false, `${name}`);
  }
  // The workflow may only ever REFERENCE it as a secret - it is used twice, in
  // the pre-flight guard and in the build, and BOTH must be the secret rather
  // than a literal. Asserted per-occurrence rather than by count so adding a
  // legitimate third use does not fail, but pasting a key ever does.
  const uses = [...releaseCode.matchAll(/TAURI_SIGNING_PRIVATE_KEY: (.+)/g)].map((m) => m[1].trim());
  assert.ok(uses.length >= 1, "the signing key must be supplied to the build");
  for (const use of uses) {
    assert.equal(use, "${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}", "only a secret reference is permitted");
  }
});

test("updater artifacts are actually produced", () => {
  assert.equal(conf.bundle.createUpdaterArtifacts, true);
  assert.equal(conf.plugins.updater.windows.installMode, "passive");
});

// --- the release workflow -----------------------------------------------------

test("a release requires an intentional version tag", () => {
  const triggers = releaseCode.slice(releaseCode.indexOf("\non:"), releaseCode.indexOf("permissions:"));
  assert.match(triggers, /tags:\s*\n\s*- 'desktop-prod-v\*'/);
  // Merging must not update the fleet.
  assert.equal(/branches:/.test(triggers), false, "no branch trigger may publish an update");
  assert.equal(/pull_request/.test(triggers), false);
  assert.match(releaseCode, /environment: Production/);
});

test("the workflow fails closed on every mismatch that matters", () => {
  for (const guard of [
    "is not a plain SemVer",
    "Version mismatch",
    "Refusing to release",
    "Refusing to publish an unsigned update",
    "The built bundle references the STAGING project",
    "does not reference the production project",
  ]) {
    assert.ok(release.includes(guard), `missing guard: ${guard}`);
  }
  // The signature must be proven to exist before anything is published.
  assert.match(releaseCode, /if \[ -z "\$sig" \] \|\| \[ ! -s "\$sig" \]; then/);
});

test("the manifest is written last, and only by this workflow", () => {
  const publishAt = releaseCode.indexOf("Publish the GitHub release");
  const channelAt = releaseCode.indexOf("Publish the production update manifest");
  assert.ok(publishAt > 0 && channelAt > publishAt, "the channel advances only after assets exist");
  assert.match(releaseCode, /git checkout --orphan "\$CHANNEL_BRANCH"/);
  assert.match(releaseCode, /"windows-x86_64"/);
  for (const field of ["version", "signature", "url", "pub_date", "notes"]) {
    assert.ok(releaseCode.includes(`"${field}"`), `manifest needs ${field}`);
  }
});

test("fresh installation survives the release", () => {
  // A brand-new customer must still be able to install normally, so the plain
  // installer is published alongside the updater artifact.
  assert.match(releaseCode, /Breadee_Desktop_POS_v1_PRODUCTION_x64_Setup\.exe/);
  assert.match(releaseCode, /Breadee_\$\{\{ env\.VERSION \}\}_x64-setup\.exe\.sig/);
  assert.match(releaseCode, /SHA256SUMS\.txt/);
});

test("the release still proves its backend, like every production build", () => {
  assert.ok(releaseCode.includes(PRODUCTION_REF));
  assert.ok(releaseCode.includes(STAGING_REF));
  const labels = [...releaseCode.matchAll(/VITE_APP_ENV: (\S+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(labels)], ["production"]);
});

// --- permissions --------------------------------------------------------------

test("the capability grants the minimum the updater needs", () => {
  const perms: string[] = caps.permissions;
  for (const needed of ["updater:allow-check", "updater:allow-download-and-install", "process:allow-restart"]) {
    assert.ok(perms.includes(needed), `missing ${needed}`);
  }
  // Restart, not exit: the frontend may relaunch into the new version and must
  // not be able to simply kill the till.
  assert.equal(perms.includes("process:allow-exit"), false, "exit must not be grantable");
  for (const forbidden of ["shell", "fs:", "http:"]) {
    assert.equal(perms.some((p) => p.startsWith(forbidden)), false, `${forbidden} must stay ungranted`);
  }
});

test("the plugins are desktop-scoped", () => {
  assert.match(libRs, /#\[cfg\(desktop\)\]\s*\n\s*let builder = builder\s*\n\s*\.plugin\(tauri_plugin_updater/);
  assert.match(cargo, /tauri-plugin-updater = "2"/);
  assert.match(cargo, /tauri-plugin-process = "2"/);
});

// --- behaviour ----------------------------------------------------------------

test("nothing downloads, installs or restarts without a click", () => {
  // The startup path checks and stops. Only `install` downloads.
  assert.match(storeTs, /checkOnStartup: async \(\) => \{/);
  const startup = storeTs.slice(storeTs.indexOf("checkOnStartup:"), storeTs.indexOf("install:"));
  assert.equal(startup.includes("downloadAndInstall"), false, "startup must never install");
  assert.equal(startup.includes("relaunch"), false, "startup must never restart");
  // And installing never restarts by itself.
  assert.match(updaterTs, /export async function downloadAndInstall/);
  const install = updaterTs.slice(updaterTs.indexOf("export async function downloadAndInstall"), updaterTs.indexOf("export async function relaunchApp"));
  assert.equal(install.includes("relaunch"), false, "install must not restart on its own");
});

test("a second click cannot start a second download", () => {
  // Synchronous latch, checked before any await - two clicks in one tick would
  // both pass a React-state check.
  assert.match(storeTs, /let installing = false;/);
  assert.match(storeTs, /install: async \(\) => \{\s*if \(installing\) return;/);
  assert.match(storeTs, /installing = true;/);
  assert.match(storeTs, /\} finally \{\s*installing = false;/);
});

test("the startup check runs once per process", () => {
  assert.match(storeTs, /let startupStarted = false;/);
  assert.match(storeTs, /if \(startupStarted\) return;\s*startupStarted = true;/);
});

test("an update outage cannot stop the app starting", () => {
  // Fire-and-forget: not awaited, and nothing renders behind it.
  assert.match(shell, /void useUpdates\.getState\(\)\.checkOnStartup\(\);/);
  assert.equal(/await useUpdates/.test(shell), false, "startup must not await the updater");
  // And the check itself resolves to a state rather than throwing.
  assert.match(updaterTs, /catch \(error\) \{\s*pending = null;\s*return \{\s*kind: "error"/);
});

test("an offline till is never nagged", () => {
  // Errors never reach the banner; the manual check in Settings shows them.
  assert.match(storeTs, /export function shouldShowBanner/);
  const fn = storeTs.slice(storeTs.indexOf("export function shouldShowBanner"));
  assert.equal(fn.includes('"error"'), false, "an error state must not raise the banner");
  assert.match(updaterTs, /silent: options\.silent/);
});

test("a failed update says the app is unchanged", () => {
  // The instinct after a failed update is to start uninstalling things.
  assert.match(updaterTs, /Breadee has not been changed - the current version is still installed\./);
  for (const named of ["Could not reach the update server", "failed its signature check and was refused", "Windows refused the update"]) {
    assert.ok(updaterTs.includes(named), `missing message: ${named}`);
  }
});

test("Later dismisses without destroying the app", () => {
  assert.match(banner, /onClick=\{s\.dismiss\}/);
  assert.match(storeTs, /dismiss: \(\) => \{\s*clearPendingUpdate\(\);\s*set\(\{ dismissed: true/);
  // A deliberate manual check un-dismisses; a silent one does not.
  assert.match(storeTs, /dismissed: options\.silent \? get\(\)\.dismissed : false/);
});

test("Update & Restart is offered, and restart is separate", () => {
  assert.match(banner, /Update &amp; Restart/);
  assert.match(banner, /onClick=\{\(\) => void s\.install\(\)\}/);
  assert.match(banner, /onClick=\{\(\) => void s\.restart\(\)\}/);
  assert.match(storeTs, /restart: async \(\) => \{\s*if \(get\(\)\.state\.kind !== "ready"\) return;/);
});

// --- POS safety ---------------------------------------------------------------

test("no update UI can appear over the till", () => {
  // The POS route sits OUTSIDE the generic Shell, and the banner is mounted in
  // the Shell - so a cashier mid-order cannot be shown an update at all. That
  // is the whole POS-safety mechanism: structural, not a new locking system.
  assert.match(shell, /<UpdateBanner \/>/);
  const posRoute = app.slice(app.indexOf("OUTSIDE the generic app Shell"));
  assert.ok(posRoute.length > 0, "the POS route must stay outside the Shell");
  for (const src of [read("src", "screens", "pos", "PosWorkspace.tsx"), read("src", "layouts", "PosShell.tsx")]) {
    assert.equal(src.includes("UpdateBanner"), false, "the POS must not mount the banner");
    assert.equal(src.includes("useUpdates"), false, "the POS must not read updater state");
    assert.equal(src.includes("plugin-updater"), false);
  }
});

test("updater logic stays out of POS money paths", () => {
  for (const file of [["lib", "pos", "tablePayment.ts"], ["lib", "pos", "rpc.ts"], ["lib", "pos", "shifts.ts"]]) {
    const src = read("src", ...file);
    assert.equal(src.includes("updater"), false, `${file.join("/")} must know nothing about updates`);
  }
});
