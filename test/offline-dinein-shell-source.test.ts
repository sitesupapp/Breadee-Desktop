// Phase C — the live Dine-In shell wiring, asserted against source (DOM execution is
// unavailable here). Locks the preservation + isolation invariants: online path unchanged,
// every offline branch gated on backend-unreachable + offline-ready, payment/advanced walled,
// capture scope threaded from PosWorkspace, and NO Reporting-Engine surface introduced.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./source-helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const ts = (rel: string) => stripComments(readFileSync(join(root, rel), "utf8"));

const DW = "src/screens/pos/DineInWorkspace.tsx";
const PW = "src/screens/pos/PosWorkspace.tsx";
const ENGINE = "src/lib/offline/dineinOffline.ts";

test("open: offline branch routes to the local engine, gated on unreachable + ready + scope", () => {
  const src = ts(DW);
  assert.match(src, /if \(!input\.online && input\.offlineReady && input\.offlineScope\)[\s\S]{0,400}openTableOffline\(/, "confirmOpen offline branch captures via openTableOffline");
  assert.match(src, /await openTable\(\{ branchId: ctx\.branchId, name, seats \}\)/, "the ONLINE openTable path is preserved unchanged");
  assert.match(src, /getDineDraftForTable\(input\.offlineScope/, "double-open is deduped via the scope-exact draft lookup");
});

test("send: offline branch captures a round via the engine; online performRound preserved", () => {
  const src = ts(DW);
  assert.match(src, /if \(offlineCapture && input\.offlineScope\)/, "sendRound has an offline-capture branch");
  assert.match(src, /const updated = await sendRoundOffline\(draft\.local_session_id\)/, "the offline branch captures via sendRoundOffline");
  assert.match(src, /const outcome = await performRound\(/, "the ONLINE performRound path is preserved unchanged");
  // Durable-capture-before-clear: the cart reset is INSIDE the offline branch, after capture.
  assert.match(src, /sendRoundOffline\(draft\.local_session_id\)[\s\S]{0,2200}useCart\.getState\(\)\.reset\(\);/, "cart cleared (statement form) only after durable capture");
});

test("offlineCapture is exactly backend-unreachable AND ready AND scope present", () => {
  const src = ts(DW);
  assert.match(src, /const offlineCapture = !input\.online && input\.offlineReady === true && input\.offlineScope != null;/);
});

test("payment and advanced table ops are NOT relaxed offline (financial + advanced wall)", () => {
  const src = ts(DW);
  // payGate / tableOpGate are computed from input.online only — no offlineReady relaxation.
  assert.ok(!/payTableGate\(\{[\s\S]{0,200}offlineReady/.test(src), "payTableGate must not consult offlineReady");
  assert.ok(!/tableOpGate\(\{[\s\S]{0,200}offlineReady/.test(src), "tableOpGate (move/merge/close/clear) must not consult offlineReady");
});

test("PosWorkspace threads readiness + a five-dimensional capture scope equal to the drain scope", () => {
  const src = ts(PW);
  assert.match(src, /offlineReady: offlineReadiness\.ready/, "offlineReady passed");
  assert.match(src, /offlineScope,/, "offlineScope passed");
  // All five immutable dimensions, from the SAME sources the drain ctx uses.
  assert.match(src, /tenantId,[\s\S]{0,200}branchId: pos\.branch\.id,[\s\S]{0,120}cashierUserId: userId,[\s\S]{0,200}deviceId: getDeviceIdentity\(\)\.device_id,[\s\S]{0,120}terminalId: getDeviceIdentity\(\)\.terminal_id/);
});

test("no Reporting-Engine surface is introduced by the offline engine", () => {
  const src = ts(ENGINE);
  for (const forbidden of ["report", "semantic", "analytics", "aggregation", "accounting"]) {
    assert.ok(!src.toLowerCase().includes(forbidden), `dineinOffline.ts must not reference ${forbidden}`);
  }
});
