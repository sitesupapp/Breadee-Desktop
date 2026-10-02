// In-session permission refresh (1.0.32) — asserted against source (no store/DOM harness
// in this repo). A role/permission change made on the web while a till is already running
// otherwise only reaches it on sign-in/restart, because loadContextOnline runs only at
// startup/sign-in. This fix re-fetches ONLY features + permissions, in place, on window
// focus and on reconnect — de-duped, offline-safe, and never blanking a working session.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripJsxComments } from "./source-helpers.ts";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const code = (rel: string) => stripJsxComments(readFileSync(join(srcRoot, rel), "utf8"));

test("App wires focus + online (+ visibilitychange) to refreshPermissions", () => {
  const app = code("App.tsx");
  assert.match(app, /addEventListener\("online"/);
  assert.match(app, /addEventListener\("focus"/);
  assert.match(app, /addEventListener\("visibilitychange"/);
  assert.match(app, /refreshPermissions\(\)/);
  // Hidden-tab visibility events must not trigger a refresh.
  assert.match(app, /visibilityState === "hidden"/);
});

test("refreshPermissions is de-duped and fetches only perms + features (no full reload)", () => {
  const s = code("state/session.ts");
  assert.match(s, /let permissionRefreshInFlight/);
  assert.match(s, /if \(permissionRefreshInFlight\) return permissionRefreshInFlight/);
  assert.match(s, /rpc\("current_user_permissions"/);
  assert.match(s, /rpc\("get_tenant_effective_features"/);
});

test("refreshPermissions no-ops offline / in offline-mode / with no tenant", () => {
  const s = code("state/session.ts");
  // The early-return guard covers all three.
  assert.match(s, /if \(!navigator\.onLine \|\| offlineMode \|\| !membership\?\.tenant_id\) return/);
});

test("a refresh never blanks a working session and keeps the offline cache coherent", () => {
  const s = code("state/session.ts");
  // Empty-map guard: only replace permissions when the RPC returned a real catalog map.
  assert.match(s, /Object\.keys\(permsMap\)\.length > 0 \? permsMap : cur\.permissions/);
  // Late responses after a session change are discarded.
  assert.match(s, /cur\.userId !== userId \|\| cur\.membership\?\.tenant_id !== tenantId/);
  // Cache is only rewritten for the same user.
  assert.match(s, /cache\.userId === userId.*writeCache/s);
});
