// RC-AUTH-1 — a sign-out on one terminal must never end the same account's sessions on other terminals.
//
// Production incident (2026-10-31): several terminals shared one cashier login; every Sign Out called the
// auth-js default `signOut()` (scope "global"), which revoked the account's sessions everywhere. The other
// terminals kept running without a token and their POS calls (order submissions included) were refused
// with 401 / 42501, which the replay classifier then treated as a business refusal.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { classifyReplayError } from "@/lib/offline/posTxnSync";
import { PosRpcError } from "@/lib/pos/rpc";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

test("RC-AUTH-1: no Supabase sign-out in the app is global (every call names scope 'local')", () => {
  const offenders: string[] = [];
  for (const file of sources(join(root, "src"))) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/auth\.signOut\(([^)]*)\)/g)) {
      if (!/scope:\s*"local"/.test(m[1])) offenders.push(`${file.slice(root.length + 1)}: ${m[0]}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("RC-AUTH-1: the session store watches for a session ended elsewhere, once the server answered (never at start-up)", () => {
  const s = readFileSync(join(root, "src", "state", "session.ts"), "utf8");
  assert.match(s, /onAuthStateChange\(/);
  assert.match(s, /event !== "SIGNED_OUT" \|\| expectedSignOuts > 0/);
  const init = s.slice(s.indexOf("init: async () => {"), s.indexOf("loadSavedUsers: async"));
  assert.doesNotMatch(init.slice(0, init.indexOf("const clock = await observeDeviceClock();")), /startAuthWatch\(\);/);
  const online = s.slice(s.indexOf("loadContextOnline: async () => {"), s.indexOf("loadContextOnline: async () => {") + 900);
  assert.match(online, /startAuthWatch\(\);/);
  // Its own Sign Out is excluded, and the sealed session is dropped even when the server is unreachable.
  const signOut = s.slice(s.indexOf("signOut: async () => {"));
  assert.match(signOut, /expectedSignOuts \+= 1;/);
  assert.match(signOut, /sealedAuthStorage\.removeItem\(AUTH_STORAGE_KEY\)/);
});

test("RC-AUTH-1: 42501 answered 401 (no valid session) is auth; answered 403 it stays a business refusal", () => {
  const e = (status: number | null) => new PosRpcError("pos_submit_order", "permission denied for function pos_submit_order", { status, code: "42501" });
  assert.equal(classifyReplayError(e(401)), "auth");
  assert.equal(classifyReplayError(e(403)), "business");
  assert.equal(classifyReplayError(e(null)), "business");
});
