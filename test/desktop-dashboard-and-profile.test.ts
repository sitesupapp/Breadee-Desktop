// The Desktop dashboard and profile cleanup.
//
// THREE PROPERTIES THESE TESTS EXIST TO PROTECT.
//
// ONE, THE DASHBOARD TELLS THE TRUTH. A module the tenant already uses in their
// browser must never be labelled "Coming soon" - a dead card is not a neutral
// placeholder, it stops somebody looking for a feature they already own. Every
// module that is not built here declares where it IS and can be opened there.
//
// TWO, A LINK IS AN ADDRESS, NEVER A CREDENTIAL. The desktop opens a fixed set
// of paths on the build's own origin, in the operating system's browser, with no
// token, session or email travelling with it - and it never navigates the POS
// webview to a web page.
//
// THREE, THE DESKTOP DOES NOT CHANGE PASSWORDS. Change password is a link. There
// is no password field, no `auth.updateUser`, and no second reset flow to drift
// from the web app's - on the one screen where being wrong locks somebody out of
// their own business.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { stripJsxComments } from "./source-helpers.ts";
import { MODULES, everyDesktopModuleIsReachable, everyWebModuleIsReachable } from "@/lib/modules";
import { WEB_PATHS, isOpenableUrl, isWebPathKey, webUrl } from "@/lib/webApp";
import { grantedCount, groupPermissions, permissionLabel, prefixLabel } from "@/lib/permissionDisplay";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

// --- one, the dashboard tells the truth --------------------------------------

test("nothing is labelled Coming soon while it exists in the web app", () => {
  // Inventory and Reports were both `planned` and rendered as dead cards, while
  // a manager had been using them in a browser for months.
  for (const key of ["inventory", "reports"]) {
    const entry = MODULES.find((m) => m.key === key);
    assert.ok(entry, `${key} must still be in the catalog`);
    assert.equal(entry!.availability, "web", `${key} is a real web module and must say so`);
    assert.ok(entry!.web, `${key} must name the page it lives on`);
  }
  // And nothing at all currently claims to be unbuilt in both applications.
  assert.deepEqual(MODULES.filter((m) => m.availability === "planned").map((m) => m.key), []);
});

test("every web module names a reachable page, and only desktop modules hold a route", () => {
  assert.equal(everyWebModuleIsReachable(), true);
  assert.equal(everyDesktopModuleIsReachable(), true);
  for (const entry of MODULES) {
    if (entry.availability !== "web") continue;
    assert.ok(isWebPathKey(entry.web), `${entry.key} names a path this build knows`);
  }
});

test("`planned` is kept in the vocabulary, so the next unbuilt module is not mislabelled", () => {
  // Removing it would leave `web` as the only option for something that has no
  // web page either, and the tile would link nowhere.
  const source = stripJsxComments(read("src/lib/modules.ts"));
  assert.match(source, /ModuleAvailability = "desktop" \| "planned" \| "web"/);
});

test("the dashboard renders a web module as something that can be opened", () => {
  const dashboard = stripJsxComments(read("src/screens/Dashboard.tsx"));
  assert.match(dashboard, /Managed on Breadee Web/);
  assert.match(dashboard, /openExternal\(webUrl\(publicSiteOrigin\(\), m\.web\)\)/);
  // And a failure is shown rather than swallowed - a dead click reads as the
  // desktop being broken.
  assert.match(dashboard, /setWebError/);
});

test("the Desktop tools strip is gone from the dashboard, and nothing under it was deleted", () => {
  const dashboard = stripJsxComments(read("src/screens/Dashboard.tsx"));
  assert.equal(dashboard.includes("Desktop tools"), false);
  // It duplicated pages that all still exist at their own addresses.
  const settings = stripJsxComments(read("src/screens/settings/Settings.tsx"));
  for (const route of ["sync", "device", "receipt"]) {
    assert.ok(settings.includes(`path="${route}"`), `/settings/${route} must still exist`);
  }
  const app = stripJsxComments(read("src/App.tsx"));
  assert.match(app, /path="\/profile"/);
  assert.match(app, /path="\/pos"/);
  const printing = stripJsxComments(read("src/screens/settings/Printing.tsx"));
  assert.match(printing, /path="setup"/);
});

// --- two, a link is an address ------------------------------------------------

test("every web destination is a fixed path under the web app's own prefix", () => {
  for (const [key, path] of Object.entries(WEB_PATHS)) {
    assert.match(path, /^\/app\//, `${key} must point inside the web application`);
    assert.equal(path.includes("?"), false, `${key} must carry no query string`);
  }
});

test("a URL is built from the resolved origin and one of those constants", () => {
  assert.equal(webUrl("https://breadee.com", "inventory"), "https://breadee.com/app/inventory");
  // A trailing slash on a configured origin must not produce a double slash.
  assert.equal(webUrl("https://breadee.com/", "reports"), "https://breadee.com/app/reports");
  assert.equal(webUrl("https://stagingbreadee.netlify.app", "profile"), "https://stagingbreadee.netlify.app/app/profile");
});

test("only https is ever handed to a browser", () => {
  assert.equal(isOpenableUrl("https://breadee.com/app/inventory"), true);
  for (const bad of ["http://breadee.com", "javascript:alert(1)", "file:///c:/", "data:text/html,x", "not a url", ""]) {
    assert.equal(isOpenableUrl(bad), false, `${bad} must be refused`);
  }
});

test("no personal data travels in a link", () => {
  const source = stripJsxComments(read("src/lib/webApp.ts"));
  for (const forbidden of ["access_token", "refresh_token", "session", "email", "password", "apikey"]) {
    assert.equal(source.toLowerCase().includes(forbidden), false, `a link must not carry ${forbidden}`);
  }
});

test("opening a module never navigates this window", () => {
  const source = stripJsxComments(read("src/lib/webApp.ts"));
  for (const forbidden of ["window.location", "location.href", "window.open", "<a href"]) {
    assert.equal(source.includes(forbidden), false, `must not use ${forbidden}`);
  }
  // It uses the opener plugin that was ALREADY granted - nothing is widened.
  assert.match(source, /plugin:opener\|open_url/);
  const capability = read("src-tauri/capabilities/default.json");
  assert.match(capability, /"opener:default"/);
  const parsed = JSON.parse(capability) as { permissions: string[] };
  for (const forbidden of ["shell:default", "fs:default", "http:default"]) {
    assert.equal(parsed.permissions.includes(forbidden), false, `${forbidden} must not be granted`);
  }
});

test("one file decides which site this build points at", () => {
  // Read RAW, not comment-stripped: the line-comment pass would eat `//` inside
  // the URL and the assertion would then be checking a mangled string.
  const site = read("src/lib/site.ts");
  assert.match(site, /production: "https:\/\/breadee\.com"/);
  // `paymentQr.ts` re-exports rather than keeping a second copy: two modules
  // deciding independently is how one of them points a production till at
  // staging.
  const qr = read("src/lib/pos/paymentQr.ts");
  assert.match(qr, /export \{ DEFAULT_PUBLIC_SITE, publicSiteOrigin \}/);
  assert.equal(/staging: "https:\/\//.test(qr), false, "the site map must live in exactly one file");
});

// --- three, the desktop does not change passwords ----------------------------

test("Change password OPENS THE WEB and mutates nothing locally", () => {
  const profile = stripJsxComments(read("src/screens/Profile.tsx"));
  assert.match(profile, /Change password/);
  assert.match(profile, /openExternal\(webUrl\(publicSiteOrigin\(\), "profile"\)\)/);
  for (const forbidden of ["updateUser", "type=\"password\"", "setPassword", "resetPasswordForEmail"]) {
    assert.equal(profile.includes(forbidden), false, `the desktop profile must not use ${forbidden}`);
  }
});

test("NO desktop source changes a password", () => {
  // The strongest form: not on this screen, and not anywhere else either.
  const offenders: string[] = [];
  for (const rel of listSources("src")) {
    const source = stripJsxComments(read(rel));
    if (/auth\.updateUser|updatePassword|resetPasswordForEmail/.test(source)) offenders.push(rel);
  }
  assert.deepEqual(offenders, []);
});

// --- the permissions list -----------------------------------------------------

test("permissions are grouped from the SAME map, and nothing is added or hidden", () => {
  const permissions = {
    "pos.access": true,
    "pos.settings.manage": true,
    "menu.view": true,
    "inventory.items.view": false,
    "kitchen.manage_printers": true,
  };
  const groups = groupPermissions(permissions);
  const keys = groups.flatMap((g) => g.rows.map((r) => r.key)).sort();
  // Exactly the granted ones. A `false` means "considered and not granted", and
  // listing it would misreport what this account can do.
  assert.deepEqual(keys, ["kitchen.manage_printers", "menu.view", "pos.access", "pos.settings.manage"]);
  assert.equal(grantedCount(permissions), 4);
  assert.deepEqual(groups.map((g) => g.key), ["kitchen", "menu", "pos"]);
});

test("labels are DERIVED from the key, never looked up in a second list", () => {
  // A hand-written table would be a second list of permissions, and it would go
  // stale the moment the registry gained a key.
  assert.equal(permissionLabel("pos.settings.manage"), "Settings · manage");
  assert.equal(permissionLabel("menu.view"), "View");
  assert.equal(permissionLabel("standalone"), "Standalone");
  assert.equal(prefixLabel("pos"), "POS");
  assert.equal(prefixLabel("hr"), "HR");
  // A module this build has never heard of still reads correctly.
  assert.equal(prefixLabel("loyalty"), "Loyalty");
  const source = stripJsxComments(read("src/lib/permissionDisplay.ts"));
  assert.equal(/PERMISSION_LABELS|KNOWN_PERMISSIONS/.test(source), false);
});

test("a missing or malformed permission map renders as nothing, never as a crash", () => {
  assert.deepEqual(groupPermissions(null), []);
  assert.deepEqual(groupPermissions(undefined), []);
  assert.deepEqual(groupPermissions({} as Record<string, boolean>), []);
  assert.equal(grantedCount(null), 0);
});

test("the profile shows the raw key beside every label", () => {
  // It is what an operator reads out to support; a friendly label alone would
  // make that conversation guesswork.
  const profile = stripJsxComments(read("src/screens/Profile.tsx"));
  assert.match(profile, /\{row\.label\}/);
  assert.match(profile, /\{row\.key\}/);
  // And the old chip wall is gone.
  assert.equal(profile.includes("flex flex-wrap gap-1.5"), false);
});

test("the permissions display cannot reach RBAC - it only formats", () => {
  const source = stripJsxComments(read("src/lib/permissionDisplay.ts"));
  for (const forbidden of ["supabase", "current_user_can", "rpc", "import {"]) {
    assert.equal(source.includes(forbidden), false, `presentation must not reach ${forbidden}`);
  }
});

/** Every .ts/.tsx under a directory, relative to the repo root. */
function listSources(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(join(root, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(root, rel)).isDirectory()) listSources(rel, acc);
    else if (/\.tsx?$/.test(name)) acc.push(rel);
  }
  return acc;
}
