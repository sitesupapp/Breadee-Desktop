// 1.0.40 — BUG 05 (customer / Pay On Account OU isolation) + BUG 09 (pending order transfer lock).
//
// The server is the authority (pos_complete_*_on_account_core refuse ON_ACCOUNT_CUSTOMER_OTHER_OU;
// every mutating order core refuses ORDER_TRANSFER_PENDING right after the order lock). These tests pin
// the desktop half: the on-account picker's OU filter, and that both new refusal codes are classified as
// clean, definitive business refusals (never transient, never "try again", message shown verbatim).

import { test } from "node:test";
import assert from "node:assert/strict";

import { chargeableBranchFilter, isChargeableInBranch } from "@/lib/pos/customers";
import { classifyReplayError, posErrorCode, terminalKind } from "@/lib/offline/posTxnSync";
import { isDefinitiveOnAccountRefusal } from "@/lib/pos/onAccount";

const BITE = "11111111-1111-4111-8111-111111111111";
const MAIN = "22222222-2222-4222-8222-222222222222";

// The exact wire shape pos_op_error produces through PostgREST.
const refusal = (code: string, message: string) => ({
  code: "P0001",
  status: 400,
  message,
  details: JSON.stringify({ pos_error_code: code }),
});
const OTHER_OU_MSG = "This customer belongs to another operating unit and cannot be charged here.";
const PENDING_MSG =
  "This order is waiting for a transfer decision and cannot be changed until the transfer is accepted, rejected or cancelled.";

// --- BUG 05: picker OU filter -------------------------------------------------

test("BUG05: chargeable filter = operational branch OR tenant-wide", () => {
  assert.equal(chargeableBranchFilter(BITE), `branch_id.eq.${BITE},branch_id.is.null`);
});

test("BUG05: an unresolved branch fails closed to tenant-wide customers only", () => {
  assert.equal(chargeableBranchFilter(null), "branch_id.is.null");
  assert.equal(chargeableBranchFilter(undefined), "branch_id.is.null");
});

test("BUG05: result guard keeps own-OU and tenant-wide, drops another OU (owner case)", () => {
  assert.equal(isChargeableInBranch({ branch_id: BITE }, BITE), true);
  assert.equal(isChargeableInBranch({ branch_id: null }, BITE), true);
  assert.equal(isChargeableInBranch({ branch_id: MAIN }, BITE), false);
  assert.equal(isChargeableInBranch({ branch_id: MAIN }, null), false);
  // Column not read → left to the server's refusal (never silently dropped).
  assert.equal(isChargeableInBranch({}, BITE), true);
});

// --- error classification -----------------------------------------------------

test("ON_ACCOUNT_CUSTOMER_OTHER_OU: structured code, business refusal, definitive on-account refusal", () => {
  const e = refusal("ON_ACCOUNT_CUSTOMER_OTHER_OU", OTHER_OU_MSG);
  assert.equal(posErrorCode(e), "ON_ACCOUNT_CUSTOMER_OTHER_OU");
  assert.equal(classifyReplayError(e), "business");
  assert.equal(terminalKind(OTHER_OU_MSG), "validation");
  assert.equal(isDefinitiveOnAccountRefusal(e), true);
});

test("ORDER_TRANSFER_PENDING: structured code, business refusal, definitive on-account refusal", () => {
  const e = refusal("ORDER_TRANSFER_PENDING", PENDING_MSG);
  assert.equal(posErrorCode(e), "ORDER_TRANSFER_PENDING");
  assert.equal(classifyReplayError(e), "business");
  assert.equal(terminalKind(PENDING_MSG), "validation");
  assert.equal(isDefinitiveOnAccountRefusal(e), true);
});

test("ORDER_TRANSFER_PENDING is recognised from the message alone (call sites that keep only the message)", () => {
  assert.equal(posErrorCode({ message: `ORDER_TRANSFER_PENDING: ${PENDING_MSG}` }), "ORDER_TRANSFER_PENDING");
  assert.equal(posErrorCode({ message: `ON_ACCOUNT_CUSTOMER_OTHER_OU ${OTHER_OU_MSG}` }), "ON_ACCOUNT_CUSTOMER_OTHER_OU");
});

test("the 1.0.39 contract still holds: P0001 + 'cannot' wording alone is a validation refusal", () => {
  // A running 1.0.39 client that does not know the codes still parks/shows these as refusals.
  assert.equal(classifyReplayError({ code: "P0001", status: 400, message: PENDING_MSG }), "business");
  assert.equal(classifyReplayError({ code: "P0001", status: 400, message: OTHER_OU_MSG }), "business");
});

test("unrelated refusals are not misread as the new codes", () => {
  assert.equal(isDefinitiveOnAccountRefusal(refusal("VERSION_CONFLICT", "This order changed since it was loaded.")), false);
  assert.equal(posErrorCode({ message: "ORDER_NOT_FOUND" }), null);
});
