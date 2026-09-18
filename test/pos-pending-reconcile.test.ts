// Regression coverage for the crash-recovery reconciliation SURFACING fix.
//
// Native acceptance proved the durable journal survived restart, overwrite
// protection worked, and nothing auto-submitted - but the "Resolve pending order"
// prompt never surfaced. Root cause: the old reconcile latched a one-shot ref and
// queried getUnresolvedSubmit(tenantId, pos.branch.id) as soon as pos.allowed &&
// tenantId were true, while pos.branch was still the async UNKNOWN_BRANCH sentinel
// (id null). A concrete-branch journal never matches a null-branch lookup, and the
// latched ref blocked any re-check once the real branch loaded.
//
// The fix: gate on pos.ready (true only AFTER loadBranchContext resolves), drop the
// one-shot latch, re-check on context change, and drive a PERSISTENT banner from
// pendingSubmit state (not an ephemeral toast action).

import "fake-indexeddb/auto";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { localdb } from "@/lib/offline/db";
import { beginInflightSubmit, getUnresolvedSubmit } from "@/lib/pos/inflightSubmit";
import { stripComments } from "./source-helpers.ts";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (...p: string[]) => readFileSync(join(srcRoot, ...p), "utf8");
const posSrc = () => stripComments(read("screens", "pos", "PosWorkspace.tsx"));

beforeEach(async () => {
  await localdb.inflightSubmits.clear();
});

// --- ROOT-CAUSE behavioral guard -------------------------------------------

test("C/root-cause: a concrete-branch pending entry is INVISIBLE to a null-branch lookup", async () => {
  // This is exactly the UNKNOWN_BRANCH (id null) window the old reconcile queried in.
  await beginInflightSubmit({
    client_op_id: "opX",
    payload: { client_op_id: "opX", items: [] },
    ctx: { tenant_id: "t1", branch_id: "b1", terminal_id: null, device_id: null },
  });
  assert.equal(await getUnresolvedSubmit("t1", null), null, "null (UNKNOWN_BRANCH) branch must not surface a real-branch order");
  const found = await getUnresolvedSubmit("t1", "b1");
  assert.ok(found, "once the REAL branch is resolved, the pending order surfaces");
  assert.equal(found!.client_op_id, "opX");
});

test("H: with no journal, the lookup is null (normal POS behavior is unaffected)", async () => {
  assert.equal(await getUnresolvedSubmit("t1", "b1"), null);
});

// --- FIX source contracts (lock in the corrected lifecycle) ------------------

test("A/B: reconcile waits for pos.ready (branch loaded), not merely pos.allowed", () => {
  const src = posSrc();
  assert.match(src, /if \(!pos\.ready \|\| !tenantId\)/, "refresh is gated on pos.ready so branch is resolved first");
  assert.match(src, /getUnresolvedSubmit\(tenantId, pos\.branch\.id\)/, "lookup uses the resolved tenant+branch");
  assert.match(src, /useEffect\(\(\) => \{\s*void refreshPendingSubmit\(\);/, "the reconcile runs via an effect on context readiness");
});

test("the buggy one-shot latch is GONE (no reconcileCheckedRef, no ephemeral toast action)", () => {
  const src = posSrc();
  assert.ok(!/reconcileCheckedRef/.test(src), "the one-shot latch that blocked re-checks was removed");
  assert.ok(!/action: \{ label: "Resolve pending order"/.test(src), "the ephemeral toast-action surfacing was replaced");
});

test("B: recovery UI is a PERSISTENT banner driven by pendingSubmit state", () => {
  const src = posSrc();
  assert.match(src, /const \[pendingSubmit, setPendingSubmit\] = useState<InflightSubmit \| null>\(null\)/, "pending state exists");
  assert.match(src, /\{pendingSubmit && \(/, "banner renders only when a pending submit exists");
  assert.match(src, /Resolve pending order\s*<\/button>/, "banner exposes an explicit Resolve action");
  assert.match(src, /onClick=\{\(\) => void resolvePendingSubmit\(pendingSubmit\)\}/, "the action resolves the exact pending entry");
});

test("D: mount/reconcile NEVER auto-submits - submitOrder has exactly two call sites (send + explicit resolve)", () => {
  const src = posSrc();
  assert.equal((src.match(/submitOrder\(/g) ?? []).length, 2, "one send in ensureOrder + one in cashier-initiated resolvePendingSubmit; none on mount");
});

test("E: resolve replays the EXACT persisted payload + id and clears only on success", () => {
  const src = posSrc();
  assert.match(src, /submitOrder\(entry\.payload as SubmitOrderPayload\)/, "same immutable payload, never rebuilt from cart");
  assert.match(src, /await clearInflightSubmit\(entry\.client_op_id\);\s*setPendingSubmit\(null\);/, "journal + banner cleared only after a successful resolve");
  assert.equal((src.match(/clearInflightSubmit\(entry\.client_op_id\)/g) ?? []).length, 1, "cleared in exactly one place (the success path)");
});

test("F: a resolve that fails keeps the journal and the banner (no clear on uncertainty)", () => {
  const src = posSrc();
  // The resolve catch surfaces a warning but must NOT clear the journal or banner.
  assert.match(src, /Could not verify the pending order yet\./, "ambiguous resolve keeps the pending order");
});

test("G: a new submit stays BLOCKED while an unresolved journal exists", () => {
  const src = posSrc();
  assert.match(src, /if \(e instanceof UnresolvedSubmitExistsError\)/, "the overwrite guard is honoured in ensureOrder");
  assert.match(src, /A previous order still needs verification\./, "and the cashier is told to resolve first");
});
