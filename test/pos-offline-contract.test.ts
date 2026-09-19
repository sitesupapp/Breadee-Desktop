// Phase B1 — source contracts that the behavioural tests cannot see: the offline
// capture wiring in PosWorkspace, the additive Dexie migration, and the replay
// engine's structural safety rails. Reading source (comments stripped) keeps these
// honest without a live React tree.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { stripComments, stripJsxComments } from "./source-helpers.ts";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (...p: string[]) => readFileSync(join(srcRoot, ...p), "utf8");

test("db: v3 is ADDITIVE — v1/v2 carried forward, only posOfflineTxns added", () => {
  const src = stripComments(read("lib", "offline", "db.ts"));
  assert.match(src, /this\.version\(1\)\.stores\(/, "v1 retained");
  assert.match(src, /this\.version\(2\)\.stores\(/, "v2 retained (Phase-A journal)");
  assert.match(src, /this\.version\(3\)\.stores\(\{/, "v3 present");
  assert.match(src, /posOfflineTxns:\s*"local_txn_id/, "v3 adds the posOfflineTxns store");
  // v3 must not destroy prior stores: no explicit store deletion / clear in migration.
  assert.doesNotMatch(src, /version\(3\)[\s\S]*?deleteObjectStore/, "no destructive v3 migration");
});

test("engine: single-flight lock guards the replay queue", () => {
  const src = stripComments(read("lib", "offline", "posTxnSync.ts"));
  assert.match(src, /let syncing = false/, "module-level lock");
  assert.match(src, /if \(syncing\) return report/, "second concurrent run is a no-op");
});

test("engine: live-session guard scopes replay to tenant + branch + cashier", () => {
  const src = stripComments(read("lib", "offline", "posTxnSync.ts"));
  assert.match(src, /t\.tenant_id !== ctx\.tenantId/, "tenant match required");
  assert.match(src, /ctx\.branchId/, "branch match required");
  assert.match(src, /t\.cashier_user_id !== ctx\.cashierUserId/, "cashier match required");
  assert.match(src, /report\.deferred\.push/, "mismatch is deferred, not replayed");
});

test("engine: payment idempotency + no-guess recovery", () => {
  const src = stripComments(read("lib", "offline", "posTxnSync.ts"));
  assert.match(src, /already paid/i, "treats 'already paid' as a state signal");
  assert.match(src, /d\.recover\(/, "asks the server after an ambiguous payment");
  assert.match(src, /status: "needs_attention"/, "terminal refusals surface for a human");
  // A live session is required before any replay (no offline bypass).
  assert.match(src, /await d\.hasSession\(\)/);
});

test("engine: only queued/syncing work is replayed, FIFO by capture time", () => {
  const src = stripComments(read("lib", "offline", "posTxnSync.ts"));
  assert.match(src, /anyOf\("queued", "syncing"\)/, "needs_attention is not auto-replayed");
  assert.match(src, /created_at\.localeCompare/, "FIFO ordering");
});

test("PosWorkspace: offline capture is gated to Takeaway + Cash while offline", () => {
  const src = stripJsxComments(read("screens", "pos", "PosWorkspace.tsx"));
  assert.match(
    src,
    /!navigator\.onLine && intent\.kind === "draft" && input\.method === "cash"/,
    "offline path only for a fully-offline takeaway cash draft",
  );
});

test("PosWorkspace: durable commit before the cart clears; no fabricated server number", () => {
  const src = stripJsxComments(read("screens", "pos", "PosWorkspace.tsx"));
  // Anchor on the offline-capture CONDITION (code, not a comment the stripper removes).
  const capture = src.slice(src.indexOf('!navigator.onLine && intent.kind === "draft"'));
  const commitAt = capture.indexOf("addPosOfflineTxn(");
  const clearAt = capture.indexOf("newOrder();");
  assert.ok(commitAt > -1 && clearAt > -1, "both the commit and the cart reset exist");
  assert.ok(commitAt < clearAt, "the sale is durably committed BEFORE the cart is cleared");
  // The provisional reference is an OFF- ref, never a server order number.
  assert.match(src, /Ref OFF-\$\{localId/, "provisional offline reference shown, not a server order number");
  assert.match(src, /Saved offline/, "cashier is told the sale is offline");
});

test("PosWorkspace: reconnect drives the replay engine", () => {
  const src = stripComments(read("screens", "pos", "PosWorkspace.tsx"));
  assert.match(src, /addEventListener\("online"/, "auto-sync on reconnect");
  assert.match(src, /syncPosTxns\(/, "reconnect calls the replay engine");
});
