// The production build boundary.
//
// One property, stated three ways: a Breadee Desktop build must be UNABLE to be
// wrong about which backend it talks to. Not "unlikely to be" - unable. The
// three ways a build could lie are all pinned here:
//
//   * it could point at staging while calling itself production;
//   * it could point at production while calling itself staging;
//   * it could point at nothing and start anyway, deciding for itself.
//
// The last one is why `VITE_APP_ENV ?? "staging"` had to go. The BACKEND could
// never silently fall back - a missing URL or key has always thrown - but the
// LABEL could, and a production installer whose variable was forgotten would
// call itself staging in its startup log, in IS_PRODUCTION, and in every
// support screenshot taken from it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const read = (...p: string[]) => readFileSync(join(root, "..", ...p), "utf8");

const envTs = read("src", "env.ts");
const production = read(".github", "workflows", "desktop-windows-production.yml");
const installer = read(".github", "workflows", "desktop-windows-installer.yml");
const check = read(".github", "workflows", "desktop-windows-check.yml");

// These files EXPLAIN themselves at length, and several explanations quote the
// very thing being asserted against - the comment in env.ts names the
// `?? "staging"` default it removed, and the production workflow's header quotes
// its own `VITE_APP_ENV: production`. Asserting over raw text would therefore
// pass on the prose while the code said something else, which is the exact
// failure mode these tests exist to catch. Code only.
const code = (src: string) => src.replace(/^[^\S\r\n]*\/\/[^\r\n]*$/gm, "");
const yamlCode = (src: string) => src.replace(/^[^\S\r\n]*#[^\r\n]*$/gm, "");

const envCode = code(envTs);
const productionCode = yamlCode(production);

/** The two project refs. Neither is a secret; the anon KEY is, and is never here. */
const STAGING_REF = "azjxprewycygsocusxjn";
const PRODUCTION_REF = "cltlqfqormkhppmbvyrv";

// --- the environment label ---------------------------------------------------

test("the environment is declared, never defaulted", () => {
  // The exact regression this replaces.
  assert.equal(/APP_ENV[^\n]*\?\?\s*"staging"/.test(envCode), false, "VITE_APP_ENV must have no default");
  assert.match(envTs, /const APP_ENVIRONMENTS = \["staging", "production"\] as const/);
  assert.match(envTs, /Missing VITE_APP_ENV/);
  assert.match(envTs, /There is no default/);
});

test("an unrecognised environment is refused rather than coerced", () => {
  // "prod", "PRODUCTION" and "prod-eu" are all wrong, and each would otherwise
  // read as not-production while pointing at the production database.
  assert.match(envTs, /if \(!\(APP_ENVIRONMENTS as readonly string\[\]\)\.includes\(value\)\)/);
  assert.match(envTs, /VITE_APP_ENV must be one of/);
});

test("IS_PRODUCTION follows the validated value, not the raw one", () => {
  assert.match(envTs, /const APP_ENV = requireAppEnv\(raw\.APP_ENV\);/);
  assert.match(envTs, /IS_PRODUCTION: APP_ENV === "production"/);
  assert.equal(envTs.includes("raw.APP_ENV as"), false, "no cast around the unvalidated value");
});

test("the pre-existing fail-closed rules are untouched", () => {
  // This change was allowed to make the label strict and NOTHING else.
  assert.match(envTs, /Missing VITE_SUPABASE_URL \/ VITE_SUPABASE_ANON_KEY/);
  assert.match(envTs, /SECURITY: a service_role key must never be used in the desktop app/);
  assert.match(envTs, /VITE_SUPABASE_URL must start with https:\/\//);
  assert.match(envTs, /url\.hostname\.toLowerCase\(\)\.endsWith\("\.supabase\.co"\)/);
});

test("the startup log names the host and the env, never the key", () => {
  const log = envTs.slice(envTs.indexOf("console.info"), envTs.indexOf("export const env"));
  assert.match(log, /hostname/);
  assert.equal(log.includes("ANON_KEY"), false, "the key must never reach a log line");
});

// --- the production build path -----------------------------------------------

test("production credentials come from a protected environment", () => {
  assert.match(production, /^\s*environment: Production$/m);
  // Not repository secrets: a workflow without the environment cannot read them.
  assert.match(production, /secrets\.VITE_SUPABASE_URL/);
  assert.match(production, /secrets\.VITE_SUPABASE_ANON_KEY/);
});

test("the production build states its environment in every build step", () => {
  const steps = [...productionCode.matchAll(/VITE_APP_ENV:\s*(\S+)/g)].map((m) => m[1]);
  assert.deepEqual(steps, ["production", "production"], "frontend build AND tauri build");
  // tauri:build re-runs the frontend build, so a label set only once would be
  // silently overwritten by the second, unlabelled pass.
  assert.match(production, /npm run build/);
  assert.match(production, /npm run tauri:build/);
});

test("a production build refuses to fall back to staging", () => {
  // Three independent guards, because each catches a different mistake:
  // an unconfigured environment, a mis-populated one, and a bundle that
  // disagrees with both.
  assert.match(production, /Refusing to build/);
  assert.match(production, new RegExp(`\\*${STAGING_REF}\\*\\)[\\s\\S]{0,200}Refusing to build`));
  assert.match(production, new RegExp(`grep -rl '${STAGING_REF}' dist/assets[\\s\\S]{0,200}Refusing to package`));
  assert.match(production, new RegExp(`grep -rl '${PRODUCTION_REF}' dist/assets`));
});

test("a production build is deliberate and never automatic", () => {
  const triggers = production.slice(production.indexOf("\non:"), production.indexOf("permissions:"));
  assert.match(triggers, /workflow_dispatch/);
  assert.equal(/^\s*push:/m.test(triggers), false, "a push must not produce a production installer");
  assert.equal(/^\s*pull_request:/m.test(triggers), false, "a PR must not produce a production installer");
  // Built from a named commit, not from wherever a branch points today.
  assert.match(production, /ref: \$\{\{ inputs\.source_commit \|\| github\.ref \}\}/);
});

test("the production artifact says what it is", () => {
  assert.match(production, /Breadee_Desktop_POS_v1_PRODUCTION_x64_Setup\.exe/);
  assert.match(production, /name: breadee-desktop-windows-installer-production/);
  assert.match(production, /sha256sum/);
  for (const word of ["STAGING", "RC", "test build"]) {
    assert.equal(
      new RegExp(`Breadee_Desktop[^\\n]*${word}`).test(production),
      false,
      `the installer must not be labelled ${word}`,
    );
  }
});

test("production publishes nothing on its own", () => {
  for (const forbidden of ["softprops/action-gh-release", "gh release", "createRelease", "git tag"]) {
    assert.equal(production.includes(forbidden), false, `${forbidden} must not appear`);
  }
  assert.match(production, /permissions:\s*\n\s*contents: read/);
});

// --- the staging path is unchanged -------------------------------------------

test("the staging builds still say staging, and still need no environment", () => {
  for (const [name, src] of [["installer", yamlCode(installer)], ["check", yamlCode(check)]] as const) {
    const labels = [...src.matchAll(/VITE_APP_ENV:\s*(\S+)/g)].map((m) => m[1]);
    assert.ok(labels.length > 0, `${name} must declare its environment`);
    assert.deepEqual([...new Set(labels)], ["staging"], `${name} must stay staging`);
    assert.equal(/^\s*environment: Production$/m.test(src), false, `${name} must not touch Production`);
  }
});

// --- nothing is committed that should not be ---------------------------------

test("no backend credentials are committed anywhere in the build config", () => {
  for (const [name, src] of [["env", envTs], ["production", production], ["installer", installer], ["check", check]] as const) {
    assert.equal(src.includes("service_role"), name === "env", `${name}`);
    assert.equal(/sb_publishable_[A-Za-z0-9_-]{8,}/.test(src), false, `${name} must not carry a key`);
    assert.equal(/eyJ[A-Za-z0-9_-]{20,}/.test(src), false, `${name} must not carry a JWT`);
    assert.equal(src.includes(`https://${PRODUCTION_REF}.supabase.co`), false, `${name} must not hard-code the URL`);
  }
  // The refs appear in the production workflow ONLY as guard comparisons.
  assert.equal(envTs.includes(PRODUCTION_REF), false, "runtime logic must name no project");
  assert.equal(envTs.includes(STAGING_REF), false, "runtime logic must name no project");
});
