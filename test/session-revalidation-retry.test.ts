// 1.0.45 (U-1) — after the 1.0.44 updater relaunch the till stayed in "Offline mode" for minutes against a
// reachable backend: the cold-start revalidation is ONE attempt, and when the backend was not reachable at
// that instant nothing ran it again. Asserted against source (no store/DOM harness in this repo), plus the
// reachability store behaviour the retry relies on.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./source-helpers.ts";

import {
  __resetReachabilityForTests,
  isBackendReachable,
  markBackendReachable,
  markBackendUnreachable,
  subscribeReachability,
} from "@/lib/offline/reachability";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const session = () => stripComments(readFileSync(join(srcRoot, "state/session.ts"), "utf8"));

test("the retry runs only for a restored session still in offline mode, never for a reauth lock", () => {
  const s = session();
  assert.match(s, /function shouldRetryRevalidation\(\): boolean \{[\s\S]*?return !!s\.userId && s\.offlineMode && standingLock !== "reauth_required";/);
  assert.match(s, /function retryRevalidation\(\): void \{\s*if \(!shouldRetryRevalidation\(\)\) return;\s*void revalidateActiveSession\(\)\.catch\(\(\) => undefined\);/);
});

test("a reachability flip to reachable re-runs the revalidation (subscribed once, in the security loop)", () => {
  const s = session();
  const loop = s.slice(s.indexOf("function startSecurityLoop"));
  assert.match(loop.slice(0, 600), /if \(securityStarted \|\| typeof window === "undefined"\) return;/);
  assert.match(loop.slice(0, 600), /subscribeReachability\(\(reachable\) => \{\s*if \(reachable\) retryRevalidation\(\);\s*\}\);/);
});

test("every security tick retries while offline unless the backend is already known to be down", () => {
  const s = session();
  const tick = s.slice(s.indexOf("export async function securityTick"));
  assert.match(tick.slice(0, 400), /if \(s\.offlineMode && lastKnownReachable\(\) !== false\) retryRevalidation\(\);/);
});

test("the retry reuses the single de-duplicated revalidation (no second path, no direct context load)", () => {
  const s = session();
  assert.match(s, /export function revalidateActiveSession\(\): Promise<void> \{\s*if \(revalidating\) return revalidating;/);
  const retry = s.slice(s.indexOf("function retryRevalidation"), s.indexOf("function applyRestore"));
  assert.doesNotMatch(retry, /loadContextOnline|getSession|signInWithPassword/);
});

test("the unchanged cold-start contract: restore renders offline first, revalidation stays in the background", () => {
  const s = session();
  assert.match(s, /apply\(decision, true\);\s*recordSince\("startup\.authority_restore", t0\);\s*void revalidateActiveSession\(\);/);
});

test("reachability store: a failed first probe followed by a reachable answer notifies subscribers with true", async () => {
  let answer = false;
  __resetReachabilityForTests(async () => answer);
  const seen: boolean[] = [];
  const off = subscribeReachability((r) => seen.push(r));
  assert.equal(await isBackendReachable(), false, "updater relaunch: the network is not ready yet");
  answer = true;
  markBackendReachable(); // the 20 s badge poll / any answered request
  assert.deepEqual(seen, [false, true], "the flip to reachable is published — the retry's trigger");
  markBackendReachable();
  assert.deepEqual(seen, [false, true], "no repeat notification while it stays reachable");
  markBackendUnreachable();
  assert.deepEqual(seen, [false, true, false]);
  off();
  __resetReachabilityForTests(null);
});
