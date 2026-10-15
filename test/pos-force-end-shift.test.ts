// R4 (Desktop 1.0.36) — Force End Shift contract wiring (desktop). Pins the client surface: the four
// force-end RPCs are allow-listed, the permission key + gates exist and match the self/other split the
// RPCs enforce, the data layer maps every RPC with the EXACT payload keys read from the live staging
// function definitions, the FORCE_END_* refusals classify to actionable guidance, and the UI wires the
// blocked-End-Shift Force-End entry, the supervisor modal and the recipient banner. Server authority
// lives in the SECURITY DEFINER RPCs (proven by the staging contract suite); this guards the desktop
// wiring from silent drift.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { classifyError } from "@/lib/pos/errors";
import { POS_PERMISSIONS, canRequestForceEndShift, canFinalizeForceEndShift, type PosAccessContext } from "@/lib/pos/access";
import {
  buildRequestPayload,
  buildDecidePayload,
  buildCancelPayload,
  buildFinalizePayload,
} from "@/lib/pos/forceEndShift";
import { FEATURES } from "@/lib/features";
import { stripJsxComments } from "./source-helpers.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const srcRoot = join(root, "src");
const readSrc = (...p: string[]) => readFileSync(join(srcRoot, ...p), "utf8");

const FEATS = { [FEATURES.POS]: true, [FEATURES.POS_SHIFTS]: true };
function ctx(permissions: Record<string, boolean>): PosAccessContext {
  return { membership: { role: "manager", status: "active" }, permissions, features: { ...FEATS } };
}

// --- A. the four RPCs are in the desktop allow-list ---

test("A the five force-end RPCs are allow-listed in rpc.ts", () => {
  const rpc = stripJsxComments(read("src/lib/pos/rpc.ts"));
  for (const name of [
    "pos_force_end_shift_request",
    "pos_force_end_shift_decide",
    "pos_force_end_shift_cancel",
    "pos_force_end_shift_finalize",
    "pos_force_end_eligible_recipients",
  ]) {
    assert.match(rpc, new RegExp(`\\|\\s*"${name}"`), `${name} must be allow-listed`);
  }
});

// --- B. the permission key + gates match the self/other split the RPCs enforce ---

test("B the close-other-shifts permission key is pos.close_other_shifts", () => {
  assert.equal(POS_PERMISSIONS.CLOSE_OTHER_SHIFTS, "pos.close_other_shifts");
});

test("C request (self) needs end_own_shift AND select_recipient", () => {
  // both present → allowed
  assert.equal(
    canRequestForceEndShift(ctx({ "pos.end_own_shift": true, "pos.transfers.select_recipient": true }), true).allowed,
    true,
  );
  // missing select_recipient → refused with the recipient reason
  const g = canRequestForceEndShift(ctx({ "pos.end_own_shift": true }), true);
  assert.equal(g.allowed, false);
  assert.match(g.reason ?? "", /recipient/i);
  // missing end_own_shift → refused
  assert.equal(canRequestForceEndShift(ctx({ "pos.transfers.select_recipient": true }), true).allowed, false);
});

test("D request (other cashier) needs close_other_shifts AND select_recipient", () => {
  assert.equal(
    canRequestForceEndShift(ctx({ "pos.close_other_shifts": true, "pos.transfers.select_recipient": true }), false).allowed,
    true,
  );
  const g = canRequestForceEndShift(ctx({ "pos.end_own_shift": true, "pos.transfers.select_recipient": true }), false);
  assert.equal(g.allowed, false);
  assert.match(g.reason ?? "", /close-other-shifts/i);
});

test("E finalize needs only the shift-close permission (self → end_own_shift, other → close_other_shifts)", () => {
  assert.equal(canFinalizeForceEndShift(ctx({ "pos.end_own_shift": true }), true).allowed, true);
  // finalize does NOT require select_recipient (the recipient was chosen at request time)
  assert.equal(canFinalizeForceEndShift(ctx({ "pos.end_own_shift": true }), true).allowed, true);
  assert.equal(canFinalizeForceEndShift(ctx({ "pos.close_other_shifts": true }), false).allowed, true);
  assert.equal(canFinalizeForceEndShift(ctx({ "pos.end_own_shift": true }), false).allowed, false);
});

// --- F. the data layer maps every RPC ---

test("F the data layer calls all four force-end RPCs with p_payload", () => {
  const t = read("src/lib/pos/forceEndShift.ts");
  assert.match(t, /callPosRpc\("pos_force_end_shift_request", \{ p_payload:/);
  assert.match(t, /callPosRpc\("pos_force_end_shift_decide", \{ p_payload:/);
  assert.match(t, /callPosRpc\("pos_force_end_shift_cancel", \{ p_payload:/);
  assert.match(t, /callPosRpc\("pos_force_end_shift_finalize", \{ p_payload:/);
  // reads the hand-over row directly under RLS (no reader RPC) and uses the Force-End recipient reader
  assert.match(t, /\.from\("pos_shift_force_close"\)/);
  assert.match(t, /callPosRpc\("pos_force_end_eligible_recipients"/);
  // the recipient picker must NOT fall back to the transfer-flow reader (Konan BLOCKER fix)
  assert.doesNotMatch(t, /callPosRpc\("pos_order_transfer_eligible_recipients"/);
  // finalize maps the close report through the SHARED shiftReportFromRow (one source of truth)
  assert.match(t, /shiftReportFromRow\(r, "pos_force_end_shift_finalize"\)/);
});

test("F2 the recipient picker uses the Force-End-specific reader, not the transfer reader", () => {
  const t = read("src/lib/pos/forceEndShift.ts");
  // listForceEndRecipientCandidates binds to pos_force_end_eligible_recipients with { p_branch }
  assert.match(
    t,
    /listForceEndRecipientCandidates[\s\S]{0,200}callPosRpc\("pos_force_end_eligible_recipients", \{ p_branch: branchId \}\)/,
  );
});

test("F3 the supervisor browser reader lists shifts via pos_shifts_list and resolves names from profiles", () => {
  const t = read("src/lib/pos/forceEndShift.ts");
  // the open-shift browser read calls pos_shifts_list and filters to status 'open'
  assert.match(t, /callPosRpc\("pos_shifts_list", \{ p_branch: branchId, p_limit: 200 \}\)/);
  assert.match(t, /status === "open"/);
  // display names come from the SAME source the status bar uses (profiles.full_name ?? email)
  assert.match(t, /\.from\("profiles"\)[\s\S]{0,120}full_name/);
});

// --- G. the payload builders emit EXACTLY the keys the live RPCs read ---

test("G request payload: shift_id, recipient_user_id, client_op_id (+ optional note)", () => {
  const p = buildRequestPayload({ shiftId: "s1", recipientUserId: "u1", clientOpId: "op-1" });
  assert.deepEqual(p, { shift_id: "s1", recipient_user_id: "u1", client_op_id: "op-1" });
  const withNote = buildRequestPayload({ shiftId: "s1", recipientUserId: "u1", clientOpId: "op-1", note: "  cover  " });
  assert.equal(withNote.note, "cover");
  // a blank note is never sent
  assert.equal("note" in buildRequestPayload({ shiftId: "s1", recipientUserId: "u1", clientOpId: "op-1", note: "   " }), false);
});

test("H decide payload: request_id + accept; reason only on a reject with text", () => {
  assert.deepEqual(buildDecidePayload({ requestId: "r1", accept: true }), { request_id: "r1", accept: true });
  // reason is dropped on accept even if supplied
  assert.deepEqual(buildDecidePayload({ requestId: "r1", accept: true, reason: "x" }), { request_id: "r1", accept: true });
  assert.deepEqual(buildDecidePayload({ requestId: "r1", accept: false, reason: " busy " }), { request_id: "r1", accept: false, reason: "busy" });
  assert.equal("reason" in buildDecidePayload({ requestId: "r1", accept: false }), false);
});

test("I cancel payload: request_id (+ optional reason)", () => {
  assert.deepEqual(buildCancelPayload({ requestId: "r1" }), { request_id: "r1" });
  assert.deepEqual(buildCancelPayload({ requestId: "r1", reason: " mistake " }), { request_id: "r1", reason: "mistake" });
});

test("J finalize payload: request_id + actual_cash_counted; currency/treatment/notes only when present", () => {
  const base = buildFinalizePayload({ requestId: "r1", actualCashCounted: 12.5 });
  assert.deepEqual(base, { request_id: "r1", actual_cash_counted: 12.5 });
  const full = buildFinalizePayload({
    requestId: "r1",
    actualCashCounted: 0,
    currency: "USD",
    deliveryFeeCashTreatment: "excluded",
    notes: " close ",
  });
  assert.deepEqual(full, {
    request_id: "r1",
    actual_cash_counted: 0,
    currency: "USD",
    delivery_fee_cash_treatment: "excluded",
    notes: "close",
  });
  // a non-numeric actual coerces to 0, never NaN
  assert.equal(buildFinalizePayload({ requestId: "r1", actualCashCounted: Number.NaN }).actual_cash_counted, 0);
});

// --- K. the FORCE_END_* refusals classify to actionable guidance (behavioral) ---

test("K FORCE_END refusals map to the right kinds with hints", () => {
  assert.equal(classifyError(new Error("The recipient has not accepted this hand-over yet.")).kind, "force_end_not_accepted");
  assert.equal(
    classifyError(new Error("This shift has paid or part-paid orders that must be settled or voided before a force-end. 2 order(s) blocked.")).kind,
    "force_end_has_paid_orders",
  );
  assert.equal(
    classifyError(new Error("The shift's open orders changed since the hand-over was requested. Start a new force-end.")).kind,
    "force_end_snapshot_changed",
  );
  for (const msg of [
    "The recipient can no longer access this branch.",
    "The recipient is no longer an active member.",
    "The recipient no longer has exactly one open shift on this branch. Start a new force-end.",
    "The recipient shift is no longer open.",
    "The recipient shift no longer belongs to the recipient.",
    "The recipient has no open shift in this branch; they must open one first",
    "The recipient has more than one open shift; force-end requires exactly one",
  ]) {
    assert.equal(classifyError(new Error(msg)).kind, "force_end_recipient_ineligible", msg);
  }
  for (const msg of [
    "You cannot hand orders to yourself",
    "This shift has no open orders; end it normally instead of forcing.",
    "The source shift is no longer open.",
    "This hand-over is no longer pending.",
    "This hand-over can no longer be cancelled.",
  ]) {
    assert.equal(classifyError(new Error(msg)).kind, "force_end_conflict", msg);
  }
  // every force-end classification carries a plain next step
  assert.ok(classifyError(new Error("The recipient has not accepted this hand-over yet.")).hint);
});

test("L a force-end message containing 'branch' is NOT swallowed by the generic branch rule", () => {
  // placed before the generic /branch/ rule → stays a recipient-eligibility refusal
  assert.equal(classifyError(new Error("The recipient has no access to this branch")).kind, "force_end_recipient_ineligible");
  // and the pre-existing generic branch rule is untouched
  assert.equal(classifyError(new Error("Your account is not assigned to a branch.")).kind, "branch");
});

// --- M. the UI is wired: End-Shift entry, modal, recipient banner ---

test("M the End-Shift dialog exposes the gated Force-End entry", () => {
  const shift = stripJsxComments(readSrc("components", "pos", "ShiftDialog.tsx"));
  assert.match(shift, /onForceEndShift\?: \(\) => void/);
  assert.match(shift, /Force end shift/);
});

test("N the workspace gates + opens the Force-End modal from the blocked End-Shift dialog", () => {
  const ws = stripJsxComments(readSrc("screens", "pos", "PosWorkspace.tsx"));
  assert.match(ws, /canRequestForceEndShift\(pos\.access, true\)/);
  assert.match(ws, /canFinalizeForceEndShift\(pos\.access, true\)/);
  // offered only when blocked by open orders AND the self-request gate allows it
  assert.match(ws, /endShiftBlocked && forceEndRequestGate\.allowed/);
  assert.match(ws, /<ForceEndShiftModal/);
  assert.match(ws, /<ForceEndIncomingBanner/);
  // a successful finalize re-reads the (now closed) own shift
  assert.match(ws, /shiftStore\.refresh\(tenantId, userId, pos\.branch\.id\)/);
});

test("O the supervisor modal requests + finalizes through the server with a typed confirmation", () => {
  const m = stripJsxComments(readSrc("components", "pos", "ForceEndShiftModal.tsx"));
  assert.match(m, /const CONFIRM_WORD = "FORCE-END"/);
  assert.match(m, /confirmText === CONFIRM_WORD/);
  assert.match(m, /requestForceEndShift\(/);
  assert.match(m, /finalizeForceEndShift\(/);
  // the recipient picker reuses the eligible-recipient candidate reader
  assert.match(m, /listForceEndRecipientCandidates\(/);
  // exactly-once request key via the shared nextOpId
  assert.match(m, /nextOpId\(/);
  // GENERALIZED: the modal takes an isOwnShift flag (own vs another cashier's shift) with a doc comment
  assert.match(m, /isOwnShift\?: boolean/);
});

test("C2 the request/finalize gates branch on isOwnShift to the matching backend permission", () => {
  // own shift → end_own_shift path; another cashier's shift → close_other_shifts path. Pins that the
  // generalized modal's gates (computed by the caller with isOwnShift) map to the right permission.
  assert.equal(canRequestForceEndShift(ctx({ "pos.close_other_shifts": true, "pos.transfers.select_recipient": true }), false).allowed, true);
  assert.equal(canRequestForceEndShift(ctx({ "pos.end_own_shift": true, "pos.transfers.select_recipient": true }), false).allowed, false);
  assert.equal(canFinalizeForceEndShift(ctx({ "pos.close_other_shifts": true }), false).allowed, true);
  assert.equal(canFinalizeForceEndShift(ctx({ "pos.close_other_shifts": true }), true).allowed, false);
});

test("Q the supervisor browser lists OPEN shifts and opens the modal targeting another cashier (isOwnShift=false)", () => {
  const b = stripJsxComments(readSrc("components", "pos", "ForceEndShiftBrowser.tsx"));
  // lists the branch's open shifts + resolves names + counts blocking orders
  assert.match(b, /listOpenBranchShifts\(/);
  assert.match(b, /resolveUserNames\(/);
  assert.match(b, /getUnresolvedOrders\(/);
  // excludes the caller's OWN open shift (that has the self path) — fail-closed on the close-other gate
  assert.match(b, /cashierUserId !== userId/);
  assert.match(b, /canRequestForceEndShift\(access, false\)/);
  assert.match(b, /canFinalizeForceEndShift\(access, false\)/);
  // opens the GENERALIZED modal targeting the chosen shift with isOwnShift={false}
  assert.match(b, /<ForceEndShiftModal/);
  assert.match(b, /isOwnShift=\{false\}/);
  // the entry is hidden entirely without the close-other request gate (fail-closed)
  assert.match(b, /!requestGate\.allowed/);
});

test("R the workspace exposes a discoverable supervisor Force-End entry, gated on close-other", () => {
  const ws = stripJsxComments(readSrc("screens", "pos", "PosWorkspace.tsx"));
  // the rail entry + browser are gated on canRequestForceEndShift(access, false) (close-other)
  assert.match(ws, /canRequestForceEndShift\(pos\.access, false\)\.allowed/);
  assert.match(ws, /<ForceEndShiftBrowser/);
  // the rail "Force-End" entry only appears when that gate passes (fail-closed)
  assert.match(ws, /forceEndBrowserAllowed/);
  assert.match(ws, /key: "force_end"/);
});

test("P the recipient banner accepts/rejects via decide, self-scoped + polling", () => {
  const b = stripJsxComments(readSrc("components", "pos", "ForceEndIncomingBanner.tsx"));
  assert.match(b, /listIncomingForceEnds\(/);
  assert.match(b, /decideForceEndShift\(/);
  assert.match(b, /accept: action === "accept"/);
  assert.match(b, /setInterval\(/);
  assert.match(b, /clearInterval\(/);
  // latest-request-wins + context guard, mirroring PendingTransfersBanner
  assert.match(b, /seq === seqRef\.current && ctx === ctxRef\.current/);
});
