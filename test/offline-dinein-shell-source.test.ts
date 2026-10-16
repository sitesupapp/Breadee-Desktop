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

test("advanced table ops (move/merge/close/clear) stay WALLED offline", () => {
  const src = ts(DW);
  // The shared op context is online-only (no offline readiness/capture), and each tableOpGate
  // call's OWN braces never consult offline.
  assert.match(src, /const common = \{ table: selected, hasOpenShift, online: input\.online \};/);
  assert.ok(!/tableOpGate\(\{[^}]{0,120}offline/.test(src), "no tableOpGate call consults offline");
});

test("Phase D: dine-in SETTLE is offline-capable via CAPTURE only (never a server charge offline)", () => {
  const src = ts(DW);
  // payGate treats connectivity as satisfied ONLY when offline capture is live AND a local
  // provisional bill with sent rounds exists — otherwise it stays blocked.
  assert.match(src, /online: input\.online \|\| \(offlineCapture && settleBill != null && settleBill\.orders\.length > 0\)/);
  // confirmPay branches to the local CAPTURE offline; the ONLINE charge path is preserved.
  assert.match(src, /if \(offlineCapture && input\.offlineScope\)[\s\S]{0,1400}settleTableOffline\(/, "offline settle captures via settleTableOffline");
  assert.match(src, /await performTablePayment\(/, "the ONLINE table payment path is preserved unchanged");
  // Fail-closed: no local draft for the table → blocked with a reconnect message, no capture.
  assert.match(src, /if \(!draft\)[\s\S]{0,160}isn't available offline/);
});

test("PosWorkspace threads readiness + a five-dimensional capture scope equal to the drain scope", () => {
  const src = ts(PW);
  assert.match(src, /offlineReady: offlineReadiness\.ready/, "offlineReady passed");
  assert.match(src, /offlineScope,/, "offlineScope passed");
  // All five immutable dimensions, from the SAME sources the drain ctx uses.
  assert.match(src, /tenantId,[\s\S]{0,200}branchId: pos\.branch\.id,[\s\S]{0,120}cashierUserId: userId,[\s\S]{0,200}deviceId: getDeviceIdentity\(\)\.device_id,[\s\S]{0,120}terminalId: getDeviceIdentity\(\)\.terminal_id/);
});

test("Phase D: dine-in ON-ACCOUNT is offline-capable via CAPTURE only, cached-customer gated", () => {
  const src = ts(DW);
  // Reachable offline when hydrated (online OR ready+scope) — the picker then uses cached customers.
  assert.match(src, /onAccountReachable\s*=[\s\S]{0,160}input\.online \|\| \(input\.offlineReady === true && input\.offlineScope != null\)/);
  // confirmTableOnAccount captures offline via tableOnAccountOffline; a customer is still required;
  // the ONLINE performOnAccount path is preserved.
  assert.match(src, /if \(offlineCapture && input\.offlineScope\)[\s\S]{0,700}tableOnAccountOffline\(/);
  assert.match(src, /await performOnAccount\(/, "online on-account path preserved");
  assert.match(src, /if \(!draft\)[\s\S]{0,160}Reconnect to put it on account/);
});

test("Phase D: Takeaway On-Account is offline-capable via CAPTURE (order → chained receivable)", () => {
  const src = ts(PW);
  // Reachable offline when a shift is open.
  assert.match(src, /onAccountReachable = payIntent !== null && pos\.gates\.takeOnAccount\.allowed && \(online \|\| Boolean\(shiftId\)\)/);
  // confirmOnAccount offline branch: capture the order (saveOfflineSend) then chain the receivable.
  assert.match(src, /await saveOfflineSend\(lines\);[\s\S]{0,500}orderOnAccountOffline\(/);
  assert.match(src, /migOpId: takeawaySaleOpId\(txn\.local_txn_id\)/);
  // The ONLINE performOnAccount path is preserved.
  assert.match(src, /await performOnAccount\(/, "online on-account path preserved");
});

test("the customer picker is offline-aware (cached customers), not a second cache", () => {
  const cp = ts("src/state/customerPicker.ts");
  assert.match(cp, /searchCustomersOfflineAware\(/);
});

test("no Reporting-Engine surface is introduced by the offline engine", () => {
  const src = ts(ENGINE);
  for (const forbidden of ["report", "semantic", "analytics", "aggregation", "accounting"]) {
    assert.ok(!src.toLowerCase().includes(forbidden), `dineinOffline.ts must not reference ${forbidden}`);
  }
});
