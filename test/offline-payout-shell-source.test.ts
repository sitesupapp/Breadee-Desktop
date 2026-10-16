// Phase D (D4) — the Payouts offline wiring, asserted against source (DOM execution is
// unavailable here). Locks the preservation + fail-closed invariants: the ONLINE payout path is
// unchanged, the offline branch captures via the proof-gated engine, the 5-D scope + pending-shift
// id are threaded from PayoutsPage, and sources are read offline-aware (cached proofs).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./source-helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const ts = (rel: string) => stripComments(readFileSync(join(root, rel), "utf8"));

const MODAL = "src/components/pos/PayoutsModal.tsx";
const PAGE = "src/screens/PayoutsPage.tsx";

test("modal: the ONLINE payout path (createPayout) is preserved unchanged", () => {
  const src = ts(MODAL);
  assert.match(src, /if \(online\)[\s\S]{0,200}createPayout\(/, "online branch still calls createPayout");
  assert.match(src, /buildPayoutCreatePayload\(/, "online payload shaping preserved");
});

test("modal: the OFFLINE branch captures via the proof-gated engine, fail-closed without a scope", () => {
  const src = ts(MODAL);
  assert.match(src, /if \(!offlineScope\) throw new PayoutOfflineError\(\)/, "no scope → fail closed offline");
  assert.match(src, /await provePayoutSourceOffline\(kind, source\.id, offlineScope\)/, "proves the source offline");
  assert.match(src, /if \(!proof\.ok\) throw new Error\(proof\.reason\)/, "unprovable source → refused");
  assert.match(src, /await capturePayoutOffline\(\{[\s\S]{0,400}clientOpId: opId\.current/, "captures via the engine with the attempt id");
  assert.match(src, /amountUsd: payoutAmountUsd\(amountNum, currency, usdRate\)/, "drawer USD computed at capture");
});

test("modal: sources are read offline-aware (cached proofs offline, write-through online)", () => {
  const src = ts(MODAL);
  assert.match(src, /loadPayoutSourcesOfflineAware\(sourceScope, k, online\)/);
  assert.ok(!/loadPayoutSources\(tenantId, branchId/.test(src), "the raw online-only source read is no longer used directly");
});

test("modal: offline capture is gated on offline-ready AND a full 5-D scope", () => {
  const src = ts(MODAL);
  assert.match(src, /const offlineCapable = !online && offlineReady && offlineScope != null;/);
  assert.match(src, /disabled=\{busy \|\| !\(online \|\| offlineCapable\) \|\| !canCreate\.allowed \|\| amountNum <= 0\}/);
});

test("page: resolves the shift via the shared store (offline-capable) and threads the offline context", () => {
  const src = ts(PAGE);
  assert.match(src, /useShift\(\)/, "uses the shared shift store (resolves server/snapshot/pending)");
  assert.match(src, /shiftLocalId=\{shiftStore\.pendingLocalId\}/, "passes the offline-opened shift local id");
  assert.match(src, /offlineScope=\{offlineScope\}/, "threads the 5-D scope");
  assert.match(src, /usdRate=\{session\.currency\.rate\}/, "threads the USD rate for the drawer projection");
});

test("page: writes payout-source proofs through ONLY while online", () => {
  const src = ts(PAGE);
  assert.match(src, /if \(!online \|\| !shiftId \|\| !offlineScope\) return;[\s\S]{0,120}hydratePayoutSourceProofs\(offlineScope\)/);
});
