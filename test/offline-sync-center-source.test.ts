// Sync Center — the wiring, asserted against the source itself.
//
// The Sync Center is an OBSERVABILITY surface, not a second drainer. These assertions
// keep it that way: it reads the durable sync-history (scoped to the active tenant +
// branch) and the live summary, and it never replays, mutates, migrates, or talks to a
// server. It is also operator-worded — no engine jargon (Dexie / client_op_id / TOCTOU)
// ever reaches the cashier's screen. Finally, it is ADDITIVE: it complements the existing
// "to sync" badge in the status bar rather than replacing it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { stripComments, stripJsxComments } from "./source-helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const jsx = (rel: string) => stripJsxComments(read(rel));
const ts = (rel: string) => stripComments(read(rel));

const SYNC_CENTER = "src/components/pos/SyncCenter.tsx";
// 1.0.38 (Bug 7) — the Sync Center body (summary, operations, history, retry) is the shared panel that
// both the POS dialog and Settings → Sync Center render; its labels/summary live in the shared model.
const SYNC_PANEL = "src/components/sync/SyncCenterPanel.tsx";
const SYNC_MODEL = "src/components/sync/syncCenterModel.ts";

// --- it is a read-only observability lens ------------------------------------

test("the Sync Center reads only the durable history + summary, scoped to tenant and branch", () => {
  const src = jsx(SYNC_PANEL);
  // Reads the observability store, not the live queues.
  assert.match(src, /from "@\/lib\/offline\/syncHistory"/, "reads from the sync-history store");
  assert.match(src, /loadSyncSummary\(\s*tenantId\s*,\s*branchId\s*,/, "summary is scoped to tenant + branch");
  assert.match(src, /listHistory\(\s*tenantId\s*,\s*branchId\s*,/, "history list is scoped to tenant + branch");
  // The POS chip reads the same scoped summary.
  assert.match(jsx(SYNC_CENTER), /useSyncSummary\(\s*tenantId\s*,\s*branchId\s*\)/, "chip summary is scoped to tenant + branch");
});

test("the Sync Center never replays, mutates, migrates, or touches a server/store directly", () => {
  for (const file of [SYNC_CENTER, SYNC_PANEL]) {
  const src = ts(file);
  for (const forbidden of [
    "localdb",
    "drainOffline",
    "drainOperations",
    "addOperation",
    "updateOperation",
    "resolveEntity",
    "migrateLegacy",
    "reconcileLegacy",
    "callPosRpc",
    "supabase",
    ".rpc(",
  ]) {
    assert.ok(!src.includes(forbidden), `${file} must not contain ${forbidden} (observability only)`);
  }
  }
});

// --- it is operator-worded ---------------------------------------------------

test("the Sync Center exposes no engine jargon to the operator", () => {
  // Comment-stripped: the file's own header may NAME the jargon it promises to keep off
  // the screen (as open-tables-source.test.ts does); what must be clean is the code/UI.
  for (const file of [SYNC_CENTER, SYNC_PANEL, SYNC_MODEL]) {
    const src = jsx(file);
    for (const jargon of ["client_op_id", "Dexie", "TOCTOU", "idempoten"]) {
      assert.ok(!src.includes(jargon), `${file} must not surface "${jargon}"`);
    }
  }
  // It speaks in outcomes a cashier understands.
  const model = ts(SYNC_MODEL);
  assert.match(model, /All changes synced/, "has a plain all-clear state");
  assert.match(model, /needs attention/i, "names the attention state in plain words");
});

// --- wiring: additive, gated, and does not disturb the existing badge --------

test("the status bar imports and mounts the Sync Center, gated on an active tenant", () => {
  const bar = ts("src/components/pos/PosStatusBar.tsx");
  assert.match(bar, /import \{ SyncCenter \} from "@\/components\/pos\/SyncCenter"/, "imports the component");
  assert.match(
    bar,
    /props\.tenantId && <SyncCenter tenantId=\{props\.tenantId\} branchId=\{props\.branchId \?\? null\}/,
    "mounts it only when a tenant is in context, passing the scope through",
  );
  // ADDITIVE: the pre-existing pending-count badge is preserved, not replaced.
  assert.match(bar, /to sync/, "the existing 'to sync' count badge stays");
  assert.match(bar, /tenantId\?: string \| null/, "the status bar accepts the tenant scope as an optional prop");
});

test("the workspace passes the active tenant into the status bar", () => {
  const pw = ts("src/screens/pos/PosWorkspace.tsx");
  assert.match(pw, /<PosStatusBar[\s\S]{0,400}tenantId=\{tenantId\}/, "PosWorkspace threads tenantId to the status bar");
});
