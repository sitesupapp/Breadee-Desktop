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
const DELW = "src/screens/pos/DeliveryWorkspace.tsx";
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
  // rc.12 — the current shift rides along so a pre-rc.12 session is attached only when provably its own.
  assert.match(src, /const updated = await sendRoundOffline\(draft\.local_session_id, \{\s*currentShift:/, "the offline branch captures via sendRoundOffline");
  assert.match(src, /const outcome = await performRound\(/, "the ONLINE performRound path is preserved unchanged");
  // Durable-capture-before-clear: the cart reset is INSIDE the offline branch, after capture.
  assert.match(src, /sendRoundOffline\(draft\.local_session_id, \{[\s\S]{0,2400}useCart\.getState\(\)\.reset\(\);/, "cart cleared (statement form) only after durable capture");
});

test("offlineCapture is exactly backend-unreachable AND ready AND scope present", () => {
  const src = ts(DW);
  assert.match(src, /const offlineCapture = !input\.online && input\.offlineReady === true && input\.offlineScope != null;/);
});

// rc.12 — CONTRACT CHANGE (F3/F4, documented): Move and Merge are SERVER-COORDINATED. The rc.4–rc.11
// offline capture showed nothing on the floor and was refused at replay (shift-less orders, a non-uuid
// merge client_op_id, destinations still occupied server-side), so offline the gate now refuses them with
// an explicit, VISIBLE reason — like Close/Clear. No offline capture branch remains for any table op.
test("rc.12: Move/Merge (like Close/Clear) are online-only with an explicit offline reason — never a silent no-op", () => {
  const src = ts(DW);
  assert.match(src, /const common = \{ table: selected, hasOpenShift, online: input\.online, offlineCapable: false \};/);
  assert.match(src, /needs a connection — the server moves the whole bill \(rounds, payments, balance\) in one step/);
  // rc.14 — wrapped (online) in the historical shift-less refusal; the online-only gate itself is unchanged.
  assert.match(src, /move: (historical\()?serverCoordinated\(canMoveTable\(pos\.access\), "move"/);
  assert.match(src, /merge: (historical\()?serverCoordinated\(canMergeTables\(pos\.access\), "merge"/);
  assert.ok(!/captureMoveTableOffline\(|captureMergeTablesOffline\(|captureCloseTableOffline|captureClearTableOffline/.test(src), "no table op is captured offline");
  // The reason is SHOWN on the bill panel (a disabled button with only a hover title read as "does nothing").
  const panel = ts("src/components/pos/TableBillPanel.tsx");
  assert.match(panel, /includes\("needs a connection"\)/);
  assert.match(panel, /role="note"/);
});

test("Phase D: dine-in SETTLE is offline-capable via CAPTURE only (never a server charge offline)", () => {
  const src = ts(DW);
  // payGate treats connectivity as satisfied ONLY when offline capture is live AND a local
  // provisional bill with sent rounds exists — otherwise it stays blocked.
  assert.match(src, /online: input\.online \|\| \(offlineCapture && settleBill != null && settleBill\.orders\.length > 0\)/);
  // confirmPay branches to the local CAPTURE offline; the ONLINE charge path is preserved.
  assert.match(src, /if \(offlineCapture && input\.offlineScope\)[\s\S]{0,1400}settleTableOffline\(/, "offline settle captures via settleTableOffline");
  assert.match(src, /await performTablePayment\(/, "the ONLINE table payment path is preserved unchanged");
  // rc.9 — fail-closed via the ONE operational projection: no open bill / already settled offline /
  // part-paid bill → blocked with a controlled reason, no capture. A canonical-only occupied table
  // (no offline round yet) now settles by its table id (CanonicalTableTarget).
  assert.match(src, /const offlineSettleTarget = useCallback\(/);
  assert.match(src, /if \(p\.bill\.orders\.length === 0\) return \{ ok: false, reason: "This table has no open bill to settle\." \}/);
  // rc.10 — a bill settled offline is CLOSED locally (absent from the projection), so a second settle
  // of it is impossible by construction; the settle records exactly what it covers.
  assert.match(src, /covers: \{ orderIds: canonicalIds, summary: p\.summaryOnly \}/);
  assert.match(src, /covers: target\.covers/);
  assert.match(src, /if \(p\.paidPending > 0 \|\| p\.collected > 0\)/);
  assert.match(src, /extraDependencyIds: target\.deps/, "settle replays after every pending edit/leg");
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
  // rc.9 — the SAME projection-derived target as the settle (fail-closed with a controlled reason).
  assert.match(src, /const target = await offlineSettleTarget\(table\);[\s\S]{0,120}setPayError\(target\.reason\)/);
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

test("Phase D: Delivery On-Account is offline-capable via CAPTURE (local-vs-canonical chain)", () => {
  const src = ts(DELW);
  // settleOnAccount offline branch captures the receivable; offline-captured order (its id is the
  // local_txn_id) chains via order_local + mig op, hydrated uses canonical id; online unchanged.
  assert.match(src, /if \(!online\)[\s\S]{0,1400}orderOnAccountOffline\(/);
  assert.match(src, /const localTxn = await getPosOfflineTxn\(order\.id\)/);
  assert.match(src, /migOpId: localTxn \? takeawaySaleOpId\(order\.id\) : null/);
  assert.match(src, /await performOnAccount\(/, "online on-account path preserved");
});

test("Phase D + rc.9: Dine-In SPLIT is offline-capable via CAPTURE over the ONE operational projection", () => {
  const src = ts(DW);
  // rc.9 — openSplit offline builds the panel from the OPERATIONAL projection (cached canonical + local
  // round lines), not the draft alone; online loadSplitState kept.
  assert.match(src, /if \(offlineCapture && input\.offlineScope && selected\)[\s\S]{0,400}getOperationalTableBill\(/);
  assert.match(src, /projectionSplit\(p, selected\.name\)/);
  assert.match(src, /loadSplitState\(order\.id\)/, "online split-state load preserved");
  // paySplit offline captures a leg via the generalized split capture (same split_settle op + handler).
  assert.match(src, /if \(offlineCapture\)[\s\S]{0,2600}splitOperationalBillOffline\(/);
  assert.match(src, /await settleSplit\(/, "online settleSplit path preserved");
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
