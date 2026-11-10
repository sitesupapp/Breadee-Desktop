// 1.0.41 (Server Off F-STORE / F-READY / F-CRASH / RC-A2) — persistent storage, storage-full surfacing, integrity,
// an encrypted queue backup that round-trips, the readiness indicator, one health badge, a crash screen.

import "fake-indexeddb/auto";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? (this.m.get(k) as string) : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
(globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage();

import {
  requestPersistentStorage,
  storageStatus,
  isLowSpace,
  isStorageFullError,
  checkLocalStoreIntegrity,
  encryptBackup,
  decryptBackup,
  buildQueueBackup,
  STORAGE_FULL_MESSAGE,
  BACKUP_MIN_PASSPHRASE,
  __resetDurabilityForTests,
} from "@/lib/offline/durability";
import { readinessOf } from "@/lib/offline/readiness";
import { healthBadge } from "@/lib/offline/useBackendHealth";
import { classifyError } from "@/lib/pos/errors";
import { localdb } from "@/lib/offline/db";

const src = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");

beforeEach(() => __resetDurabilityForTests());

test("persistent storage is requested once per run (already persisted → no prompt); unsupported → null", async () => {
  let asked = 0;
  assert.equal(await requestPersistentStorage({ persisted: async () => false, persist: async () => { asked++; return true; } }), true);
  assert.equal(await requestPersistentStorage({ persist: async () => { asked++; return true; } }), true, "memoised for the run");
  assert.equal(asked, 1);
  __resetDurabilityForTests();
  assert.equal(await requestPersistentStorage({ persisted: async () => true, persist: async () => { asked++; return true; } }), true);
  assert.equal(asked, 1, "already persisted: never asks again");
  __resetDurabilityForTests();
  assert.equal(await requestPersistentStorage(null), null);
});

test("low space: under 200 MB left or over 90% used; unknown quota is never 'low'", async () => {
  assert.equal(isLowSpace(100e6, 10e9), false, "plenty left");
  assert.equal(isLowSpace(9.5e9, 10e9), true, "over 90% used");
  assert.equal(isLowSpace(9e9, 9e9 + 100 * 1024 * 1024), true, "under 200 MB left");
  assert.equal(isLowSpace(null, 1_000), false, "unknown usage is never 'low'");
  assert.equal(isLowSpace(10, 0), false, "unknown quota is never 'low'");
  const s = await storageStatus({ persisted: async () => true, estimate: async () => ({ usage: 10, quota: 10_000_000_000 }) });
  assert.deepEqual(s, { persisted: true, usageBytes: 10, quotaBytes: 10_000_000_000, lowSpace: false });
});

test("a storage-full write failure is told as NOT saved (never a generic error)", () => {
  assert.equal(isStorageFullError({ name: "QuotaExceededError", message: "x" }), true);
  assert.equal(isStorageFullError({ name: "AbortError", inner: { name: "QuotaExceededError" } }), true, "Dexie wraps it");
  assert.equal(isStorageFullError(new Error("There is not enough space on the disk.")), true);
  assert.equal(isStorageFullError(new Error("Failed to fetch")), false);
  const c = classifyError({ name: "QuotaExceededError", message: "QuotaExceededError" });
  assert.equal(c.kind, "storage_full");
  assert.equal(c.message, STORAGE_FULL_MESSAGE);
  assert.match(STORAGE_FULL_MESSAGE, /NOT saved/);
  assert.match(STORAGE_FULL_MESSAGE, /Do not collect/);
});

test("integrity check reads the operation log without writing", async () => {
  await localdb.operations.clear();
  const r = await checkLocalStoreIntegrity();
  assert.deepEqual(r, { ok: true, operations: 0 });
});

test("the encrypted queue backup round-trips; a wrong passphrase fails; a short one is refused", async () => {
  const content = { operations: [{ operation_id: "op1", payload: { method: "cash" } }] };
  await assert.rejects(encryptBackup(content, "short", { operations: 1, capture_rows: 0, sessions: 0 }), /at least/);
  const env = await encryptBackup(content, "correct horse battery", { operations: 1, capture_rows: 0, sessions: 0 });
  assert.equal(env.format, "breadee-queue-backup");
  assert.ok(!JSON.stringify(env).includes("op1"), "nothing readable without the passphrase");
  assert.deepEqual(await decryptBackup(env, "correct horse battery"), content);
  await assert.rejects(decryptBackup(env, "wrong horse battery!"));
  assert.ok(BACKUP_MIN_PASSPHRASE >= 10);
});

test("the backup holds exactly the unsynced work (synced ops excluded) and changes nothing", async () => {
  await localdb.operations.clear();
  const base = { schema_version: 1, scope: { tenant_id: "t1", branch_id: "b1", device_id: "d", terminal_id: "t", cashier_user_id: "u" }, created_at: new Date().toISOString(), local_entity_id: null, canonical_entity_id: null, dependency_ids: [], depends_on_local_entities: [], payload: {}, retry_count: 0, last_attempt_at: null, last_error_code: null, last_error_message: null, result_meta: null, synced_at: null };
  await localdb.operations.bulkPut([
    { ...base, operation_id: "p1", operation_type: "pay_table", client_op_id: "c1", status: "pending" },
    { ...base, operation_id: "s1", operation_type: "pay_table", client_op_id: "c2", status: "synced" },
  ] as never);
  const before = JSON.stringify(await localdb.operations.toArray());
  const env = await buildQueueBackup("a long enough pass");
  assert.equal(env.summary.operations, 1);
  const out = (await decryptBackup(env, "a long enough pass")) as { operations: { operation_id: string }[] };
  assert.deepEqual(out.operations.map((o) => o.operation_id), ["p1"]);
  assert.equal(JSON.stringify(await localdb.operations.toArray()), before);
});

test("readiness: data problem > no offline access > low disk > expiring > ready (with time left)", () => {
  const ok = { enforced: true, entitlementOk: true, remainingMs: 6 * 86_400_000, storage: { persisted: true, usageBytes: 1, quotaBytes: 1e10, lowSpace: false }, integrity: { ok: true as const, operations: 3 } };
  assert.deepEqual(readinessOf(ok).text, "Offline ready · 6 days");
  assert.equal(readinessOf(ok).tone, "slate");
  assert.match(readinessOf({ ...ok, remainingMs: 5 * 3_600_000 }).text, /Offline access ends in 5 h/);
  assert.equal(readinessOf({ ...ok, remainingMs: -1 }).text, "Offline access expired");
  assert.equal(readinessOf({ ...ok, storage: { ...ok.storage, lowSpace: true } }).text, "Low disk space");
  assert.equal(readinessOf({ ...ok, entitlementOk: false }).tone, "red");
  assert.equal(readinessOf({ ...ok, integrity: { ok: false, detail: "boom" } }).text, "Local data problem");
  assert.equal(readinessOf({ ...ok, enforced: false, remainingMs: null }).text, "Offline ready");
});

test("RC-A2: one health badge — internet up but Breadee not answering is never shown as 'Online'", () => {
  assert.equal(healthBadge("online", false, true).text, "Online");
  assert.equal(healthBadge("server_off", false, true).text, "Breadee server off");
  assert.equal(healthBadge("degraded", false, true).tone, "amber");
  assert.equal(healthBadge("online", false, false).text, "No internet");
  assert.equal(healthBadge("online", true, true).text, "Offline mode");
  const shell = src("src", "screens", "Shell.tsx");
  assert.match(shell, /healthBadge\(backendHealth, s\.offlineMode, s\.online\)/);
  assert.doesNotMatch(shell, /s\.online \? \(\s*<Badge tone="green">Online<\/Badge>/, "the navigator-only badge is gone");
});

test("F-CRASH: a root error boundary wraps the app; the native guard reloads only a DEAD renderer, boundedly", () => {
  const main = src("src", "main.tsx");
  assert.match(main, /<RootErrorBoundary>\s*<App \/>\s*<\/RootErrorBoundary>/);
  assert.match(main, /void requestPersistentStorage\(\);/);
  const rs = src("src-tauri", "src", "crash_guard.rs");
  assert.match(rs, /COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED/);
  assert.match(rs, /const RELOAD_BUDGET: usize = 3;/);
  assert.match(rs, /if kind != COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED \{\s*return Ok\(\(\)\);/, "every other kind is ignored");
  assert.doesNotMatch(rs, /restart\(/, "no silent relaunch");
  const lib = src("src-tauri", "src", "lib.rs");
  assert.match(lib, /crash_guard::install\(app\);/);
});
