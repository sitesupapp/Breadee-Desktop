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
});

test("the recipient banner approves into the operator's own shift with a two-step confirm", () => {
  const b = read("src/components/pos/PendingTransfersBanner.tsx");
  assert.match(b, /listPendingTransfersForMe/);
  assert.match(b, /decideTransfer\(/);
  // approve targets the operator's own open shift
  assert.match(b, /targetShiftId: action === "approve" \? openShiftId : null/);
  // two-step: a confirm step before the decision fires
  assert.match(b, /Confirm approve/);
  assert.match(b, /Confirm reject/);
});
