// THE APPLICATION MUST NOT LIE ABOUT WHICH BACKEND IT IS ON.
//
// Two screens told the operator their environment, and both were wrong on a
// production till:
//
//   Dashboard: "Connected to Breadee staging."        - entirely hard-coded
//   Login:     "… production · connected to staging Supabase"
//                                ^ real            ^ hard-coded
//
// The second is worse than the first because it is half true - the environment
// name beside it was already dynamic, so the sentence contradicted itself, and a
// support screenshot of it actively misled whoever read it.
//
// The sweep at the bottom is the part that matters: it fails on ANY user-facing
// component that writes "staging" or "production" as a literal, so the bug
// cannot come back somewhere else. `env.ts` is excluded because that file is
// where the environment vocabulary is DEFINED and validated, and
// `lib/environment.ts` because it is the one place allowed to turn an
// environment into words.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { stripJsxComments } from "./source-helpers.ts";
import { APP_ENVIRONMENTS, backendLabel, connectedLabel, isAppEnvironment } from "@/lib/environment";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

// --- the labels themselves ----------------------------------------------------

test("the Dashboard sentence follows the runtime environment", () => {
  assert.equal(connectedLabel("staging"), "Connected to Breadee staging.");
  assert.equal(connectedLabel("production"), "Connected to Breadee production.");
});

test("the Login footer follows the runtime environment", () => {
  assert.equal(backendLabel("staging"), "connected to staging Supabase");
  assert.equal(backendLabel("production"), "connected to production Supabase");
});

test("an unknown environment is reported as unknown, never assumed to be staging", () => {
  // `env.ts` throws before this can be reached; the branch exists so that the
  // ABSENCE of a default is explicit rather than incidental.
  assert.equal(connectedLabel(""), "Connected to Breadee.");
  assert.equal(connectedLabel("dev"), "Connected to Breadee.");
  assert.equal(backendLabel("dev"), "connected to Supabase");
  assert.ok(!/staging/.test(connectedLabel("dev")));
  assert.ok(!/staging/.test(backendLabel("dev")));
});

test("the vocabulary matches the one env.ts validates against", () => {
  assert.deepEqual([...APP_ENVIRONMENTS], ["staging", "production"]);
  const envSource = read("src/env.ts");
  for (const name of APP_ENVIRONMENTS) {
    assert.ok(envSource.includes(`"${name}"`), `env.ts must still know about ${name}`);
  }
  assert.equal(isAppEnvironment("production"), true);
  assert.equal(isAppEnvironment("prod"), false);
});

// --- the two screens read it from the environment ----------------------------

test("the Dashboard derives its label instead of stating one", () => {
  const dashboard = stripJsxComments(read("src/screens/Dashboard.tsx"));
  assert.match(dashboard, /connectedLabel\(env\.APP_ENV\)/);
});

test("the Login footer derives its label instead of stating one", () => {
  const login = stripJsxComments(read("src/screens/Login.tsx"));
  assert.match(login, /backendLabel\(env\.APP_ENV\)/);
});

// --- and nothing anywhere may hard-code it again ------------------------------

function sources(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(join(root, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(root, rel)).isDirectory()) sources(rel, acc);
    else if (/\.tsx?$/.test(name)) acc.push(rel);
  }
  return acc;
}

test("NO source states an environment name as a user-facing literal", () => {
  // Where the vocabulary is defined and where it is turned into words.
  const ALLOWED = new Set(["src/env.ts", "src/lib/environment.ts"]);
  // `site.ts` maps each environment to its PUBLIC SITE URL. That is a real
  // per-environment value, not a label - a production till printing a staging
  // address on a customer's receipt is exactly what it prevents.
  //
  // MOVED here from `paymentQr.ts` in 1.0.6, and the allowance moved with it
  // rather than widening: the desktop now opens web-managed modules in a browser
  // as well as printing the receipt QR, so the origin is decided in ONE place
  // and `paymentQr.ts` re-exports it. Exactly one file may still name an
  // environment, which is the property this test exists to keep.
  ALLOWED.add("src/lib/site.ts");

  const offenders: string[] = [];
  for (const file of sources("src")) {
    if (ALLOWED.has(file)) continue;
    const source = stripJsxComments(read(file));
    for (const [index, line] of source.split(/\r?\n/).entries()) {
      // Only quoted occurrences: prose in a comment is already stripped, and an
      // identifier like `IS_PRODUCTION` is not a message to anybody.
      if (!/["'`][^"'`]*\b(staging|production)\b[^"'`]*["'`]/i.test(line)) continue;
      // A line that ALSO reads the runtime environment is not making a claim -
      // `updater.ts` says "Updates are delivered to production builds only (this
      // is ${env.APP_ENV})", which names the update channel and then reports the
      // actual environment. That sentence is true on both. What this test
      // forbids is asserting an environment the build has not been told it is in.
      if (/\bAPP_ENV\b|\bIS_PRODUCTION\b/.test(line)) continue;
      offenders.push(`${file}:${index + 1}  ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, [], `environment names must come from env.APP_ENV:\n${offenders.join("\n")}`);
});
