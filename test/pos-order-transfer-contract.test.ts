// POS Final W4/W5 (Part 6) — Open-Orders Transfer contract wiring (desktop). Pins the
// client surface: the transfer RPCs are allow-listed, the permission keys + gates exist,
// the data layer maps every RPC and round-trips the concurrency tokens, the error
// classifications exist, and the UI wires the End-Shift Transfer gate + the recipient's
// Approve/Reject surface. Server authority lives in the SECURITY DEFINER RPCs and is proven
// by the staging contract suite; this guards the desktop wiring from silent drift.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { classifyError } from "@/lib/pos/errors";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

test("all 7 transfer RPCs + the unresolved-orders read are in the desktop allow-list", () => {
  const rpc = read("src/lib/pos/rpc.ts");
  for (const name of [
    "pos_order_transfer_create",
    "pos_order_transfer_decide",
    "pos_order_transfer_reapprove",
    "pos_order_transfers_for_recipient",
    "pos_order_transfers_list",
    "pos_order_transfer_detail",
    "pos_order_transfer_eligible_recipients",
    "pos_shift_unresolved_orders",
  ]) {
    assert.match(rpc, new RegExp(`\\|\\s*"${name}"`), `${name} must be allow-listed`);
  }
});

test("the 6 transfer permission keys and their gates exist", () => {
  const access = read("src/lib/pos/access.ts");
  for (const [konst, key] of [
    ["TRANSFERS_VIEW", "pos.transfers.view"],
    ["TRANSFERS_CREATE", "pos.transfers.create"],
    ["TRANSFERS_SELECT_RECIPIENT", "pos.transfers.select_recipient"],
    ["TRANSFERS_APPROVE", "pos.transfers.approve"],
    ["TRANSFERS_REJECT", "pos.transfers.reject"],
    ["TRANSFERS_REAPPROVE", "pos.transfers.reapprove"],
  ] as const) {
    assert.match(access, new RegExp(`${konst}:\\s*"${key.replace(/\./g, "\\.")}"`));
  }
  // create requires BOTH create AND select_recipient (matches pos_order_transfer_create).
  assert.match(access, /export function canCreateTransfer/);
  assert.match(access, /TRANSFERS_CREATE[\s\S]{0,200}TRANSFERS_SELECT_RECIPIENT/);
  for (const fn of ["canApproveTransfer", "canRejectTransfer", "canViewTransfers", "canReapproveTransfer"]) {
    assert.match(access, new RegExp(`export function ${fn}`));
  }
});

test("the data layer maps every RPC and round-trips the concurrency tokens", () => {
  const t = read("src/lib/pos/transfers.ts");
  assert.match(t, /callPosRpc\("pos_order_transfer_create"/);
  assert.match(t, /callPosRpc\("pos_order_transfer_decide"/);
  assert.match(t, /callPosRpc\("pos_order_transfer_reapprove"/);
  assert.match(t, /callPosRpc\("pos_order_transfers_for_recipient"/);
  assert.match(t, /callPosRpc\("pos_order_transfers_list"/);
  assert.match(t, /callPosRpc\("pos_order_transfer_detail"/);
  assert.match(t, /callPosRpc\("pos_order_transfer_eligible_recipients"/);
  assert.match(t, /callPosRpc\("pos_shift_unresolved_orders"/);
  // idempotency tokens for create + reapprove; expected_version CAS for decide + reapprove.
  assert.match(t, /create_client_token/);
  assert.match(t, /reapprove_client_token/);
  assert.match(t, /expected_version/);
});

test("transfer error classifications exist and are kept separate from the bill/payment rules", () => {
  const errors = read("src/lib/pos/errors.ts");
  assert.match(errors, /"transfer_conflict"/);
  assert.match(errors, /"open_orders_block"/);
  // a SEPARATE transfer version_conflict rule (the dine-in bill rule is untouched).
  assert.match(errors, /this transfer changed since it was loaded/i);
  assert.match(errors, /this order changed since it was loaded/i);
});

test("the End-Shift Transfer gate and recipient surface are wired into the workspace", () => {
  const ws = read("src/screens/pos/PosWorkspace.tsx");
  // Gate: offered only when blocked by open orders AND the operator may create a transfer.
  assert.match(ws, /endShiftBlocked/);
  assert.match(ws, /canCreateTransfer\(pos\.access\)\.allowed/);
  assert.match(ws, /onTransferOpenOrders=/);
  assert.match(ws, /<TransferDialog/);
  assert.match(ws, /<PendingTransfersBanner/);
  // the block is detected from the classified error, not a brittle literal.
  assert.match(ws, /c\.kind === "open_orders_block"/);

  const shift = read("src/components/pos/ShiftDialog.tsx");
  assert.match(shift, /onTransferOpenOrders\?: \(\) => void/);
  assert.match(shift, /Transfer open orders/);
});

test("the Transfer dialog enforces the typed-TRANSFER confirmation + Alt+Shift", () => {
  const dlg = read("src/components/pos/TransferDialog.tsx");
  assert.match(dlg, /const CONFIRM_WORD = "TRANSFER"/);
  assert.match(dlg, /confirmText === CONFIRM_WORD/);
  assert.match(dlg, /altKey && e\.shiftKey/);
  assert.match(dlg, /createTransfer\(/);
  // stale-session guard: a load from an earlier dialog session/branch is ignored, and an in-flight
  // load is invalidated on close (seqRef bumps on every open/close/context change).
  assert.match(dlg, /seq !== seqRef\.current/);
  assert.match(dlg, /seqRef\.current \+= 1/);
  // render + ACTION gate: ctxReady requires open + cleanly-loaded + current (shiftId, branchId);
  // canSubmit requires ctxReady, and submit() guards on canSubmit — so a stale footer or the
  // Alt+Shift shortcut cannot submit the previous session's orders/recipient during a context switch.
  assert.match(dlg, /const ctxReady = open && !loading && !loadError && loadedKey === /);
  assert.match(dlg, /const canSubmit = ctxReady /);
  assert.match(dlg, /if \(!canSubmit\) return;/);
});

test("the recipient banner approves into the operator's own shift with a two-step confirm", () => {
  const b = read("src/components/pos/PendingTransfersBanner.tsx");
  assert.match(b, /listPendingTransfersForMe/);
  assert.match(b, /decideTransfer\(/);
  // approve targets the operator's own open shift
  assert.match(b, /targetShiftId: action === "approve" \? openShiftId : null/);
  // CAS token comes from the self-scoped read (no getTransferDetail / no view perm needed)
  assert.match(b, /expectedVersion: t\.posEntityVersion/);
  assert.doesNotMatch(b, /getTransferDetail/);
  // polls while the shift is open, so a transfer arriving AFTER mount still appears (§6.7),
  // with interval cleanup + a request-generation stale-response guard (ignores out-of-order
  // poll/refresh responses and cross-context bleed; a decision bumps the generation).
  assert.match(b, /setInterval\(/);
  assert.match(b, /clearInterval\(/);
  // latest-request-wins + context guard: apply only the newest response for the current shift/OU
  assert.match(b, /seq === seqRef\.current && ctx === ctxRef\.current/);
  assert.match(b, /seqRef\.current \+= 1/);
  // render-gate: visible rows are derived from the CURRENT openShiftId DURING render (not a passive
  // effect), so a shift/OU switch shows nothing stale even on the first commit.
  assert.match(b, /loaded\.ctx === openShiftId/);
  // a decision's continuations (setError/setStep/onApproved/refresh) are scoped to the context it
  // started in, so a mid-call shift/OU change can't bleed into the new context.
  assert.match(b, /ctxRef\.current !== myCtx/);
  // shows the sender name (§6.7 "From [user]") + the order count
  assert.match(b, /t\.fromUserName/);
  assert.match(b, /From /);
  // two-step: a confirm step before the decision fires
  assert.match(b, /Confirm approve/);
  assert.match(b, /Confirm reject/);
});

test("decide AND reapprove each require a valid expected version (mandatory CAS), sourced from the self-scoped read", () => {
  const t = read("src/lib/pos/transfers.ts");
  // decide and reapprove have DISTINCT guard messages, proving each independently rejects a
  // non-integer version before issuing the RPC.
  assert.match(t, /A valid expected version is required to decide a transfer/);
  assert.match(t, /A valid expected version is required to re-approve a transfer/);
  // both always send expected_version (two occurrences — one per function).
  assert.equal((t.match(/expected_version: input\.expectedVersion/g) || []).length, 2);
  // the recipient read surfaces pos_entity_version so a view-less recipient can still pass CAS.
  assert.match(t, /posEntityVersion: num\(r\.pos_entity_version\)/);
});

test("classifyError maps the transfer refusals to the right kinds (behavioral)", () => {
  assert.equal(
    classifyError(new Error("This transfer changed since it was loaded. Reload and retry.")).kind,
    "version_conflict",
  );
  assert.equal(classifyError(new Error("This transfer was already approved.")).kind, "transfer_conflict");
  assert.equal(
    classifyError(new Error("Cannot close this shift: 2 order(s) still open. Resolve them before ending the shift.")).kind,
    "open_orders_block",
  );
  // the pre-existing dine-in bill rule stays distinct and intact
  assert.equal(classifyError(new Error("This order changed since it was loaded.")).kind, "version_conflict");
  // NEGATIVE: a generic "Cannot close this shift" must NOT be classified as open_orders_block
  // (the narrowed /order\(s\) still open/i rule), so Transfer is not offered on an unrelated refusal.
  assert.notEqual(classifyError(new Error("Cannot close this shift right now.")).kind, "open_orders_block");
});
