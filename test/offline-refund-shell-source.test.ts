// Phase D — the live refund shell wiring, asserted against source (DOM execution is unavailable
// here). Locks the preservation + isolation invariants: the ONLINE path is byte-identical, the
// offline capture is reachable ONLY when the backend is unreachable AND offline-ready AND a
// scope-exact local proof exists AND a reason is given, and the online write-through is gated on
// connectivity. Mirrors offline-dinein-shell-source for the reversal surface.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./source-helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const ts = (rel: string) => stripComments(readFileSync(join(root, rel), "utf8"));

const DIALOG = "src/components/pos/ReverseOrderDialog.tsx";
const PW = "src/screens/pos/PosWorkspace.tsx";

test("dialog: captureOffline is EXACTLY (offline context present AND backend unreachable)", () => {
  const src = ts(DIALOG);
  assert.match(src, /const captureOffline = props\.offline != null && props\.offline\.online === false;/);
});

test("dialog: the ONLINE reversal path is preserved unchanged", () => {
  const src = ts(DIALOG);
  // The live RPC is still called, in the non-capture (else) branch.
  assert.match(src, /await voidDeliveryOrder\(\{ orderId: order\.id, reason: clean, action \}\)/);
});

test("dialog: a reason is validated BEFORE either path (audit preserved)", () => {
  const src = ts(DIALOG);
  assert.match(src, /const clean = validateVoidReason\(reason\);[\s\S]{0,200}if \(captureOffline\)/);
});

test("dialog: offline capture is fail-closed — ready + scope + local proof required", () => {
  const src = ts(DIALOG);
  // Must be offline-ready with a scope, else refuse with a connection message.
  assert.match(src, /if \(!off\.offlineReady \|\| !off\.scope\)[\s\S]{0,120}needs a connection/);
  // Must PROVE the original/balance locally; an unprovable order is blocked with its reason.
  assert.match(src, /const proof = await proveOfflineReversible\(order\.id, off\.scope\);/);
  assert.match(src, /if \(!proof\.ok\)[\s\S]{0,80}setError\(proof\.reason\)/);
  // Only then capture durably.
  assert.match(src, /await captureOfflineRefund\(\{[\s\S]{0,200}proof: proof\.proof/);
});

test("PosWorkspace: passes the offline reversal context (online + ready + scope) to the dialog", () => {
  const src = ts(PW);
  assert.match(src, /<ReverseOrderDialog[\s\S]{0,600}offline=\{\{[\s\S]{0,200}online,[\s\S]{0,200}offlineReady: offlineReadiness\.ready,[\s\S]{0,200}scope: offlineScope/);
});

test("PosWorkspace: the refund-proof write-through runs ONLY online and per shift", () => {
  const src = ts(PW);
  assert.match(src, /if \(!online \|\| !shiftId \|\| !offlineScope\) return;[\s\S]{0,400}hydrateRefundProofs\(/);
});
