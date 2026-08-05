// POS access control.
//
// These cases exist because the previous desktop gate was a hard-coded role list
// that admitted tenant OWNERS - whom pos_assert_operator (m93) rejects - and
// ignored the permission map entirely.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  canApplyDiscounts,
  canCreateOrders,
  canEndShift,
  canOpenShift,
  canOperatePOS,
  canReviewShift,
  canTakePayments,
  canUseOrderType,
  isOperationalRole,
  posAccessDenialReason,
  type PosAccessContext,
} from "@/lib/pos/access";
import { FEATURES } from "@/lib/features";

const ALL_FEATURES = {
  [FEATURES.POS]: true,
  [FEATURES.POS_TAKEAWAY]: true,
  [FEATURES.POS_SHIFTS]: true,
};

const ALL_PERMS = {
  "pos.access": true,
  "pos.create_orders": true,
  "pos.take_payments": true,
  "pos.apply_discounts": true,
  "pos.open_shift": true,
  "pos.end_own_shift": true,
  "pos.approve_shifts": true,
};

function ctx(overrides: Partial<PosAccessContext> = {}): PosAccessContext {
  return {
    membership: { role: "cashier", status: "active" },
    permissions: { ...ALL_PERMS },
    features: { ...ALL_FEATURES },
    ...overrides,
  };
}

test("an active cashier with pos.access may operate the POS", () => {
  assert.equal(canOperatePOS(ctx()), true);
  assert.equal(posAccessDenialReason(ctx()), null);
});

test("a tenant owner is excluded from operational POS, mirroring pos_assert_operator", () => {
  const owner = ctx({ membership: { role: "owner", status: "active" } });
  assert.equal(isOperationalRole("owner"), false);
  assert.equal(canOperatePOS(owner), false);
  assert.match(posAccessDenialReason(owner) ?? "", /Owners cannot perform POS operations/);
});

test("an owner is excluded even when every permission is granted", () => {
  const owner = ctx({ membership: { role: "owner", status: "active" }, permissions: { ...ALL_PERMS } });
  assert.equal(canOperatePOS(owner), false);
});

test("a missing pos feature denies access before permissions are consulted", () => {
  const noFeature = ctx({ features: {} });
  assert.equal(canOperatePOS(noFeature), false);
  assert.match(posAccessDenialReason(noFeature) ?? "", /not enabled for this plan/);
});

test("a missing pos.access permission denies access", () => {
  const noPerm = ctx({ permissions: {} });
  assert.equal(canOperatePOS(noPerm), false);
  assert.match(posAccessDenialReason(noPerm) ?? "", /not allowed to use POS/);
});

test("an inactive membership denies access", () => {
  const frozen = ctx({ membership: { role: "cashier", status: "frozen" } });
  assert.equal(canOperatePOS(frozen), false);
  assert.match(posAccessDenialReason(frozen) ?? "", /membership is not active/);
});

test("unknown permission keys fail closed", () => {
  assert.equal(canOperatePOS(ctx({ permissions: { "pos.something_else": true } })), false);
});

test("payment permission is gated independently of POS access", () => {
  const noPay = ctx({ permissions: { ...ALL_PERMS, "pos.take_payments": false } });
  assert.equal(canOperatePOS(noPay), true);
  const gate = canTakePayments(noPay);
  assert.equal(gate.allowed, false);
  assert.match(gate.reason ?? "", /permission to take payments/);
});

test("discount permission is gated independently", () => {
  const noDiscount = ctx({ permissions: { ...ALL_PERMS, "pos.apply_discounts": false } });
  const gate = canApplyDiscounts(noDiscount);
  assert.equal(gate.allowed, false);
  assert.match(gate.reason ?? "", /permission to apply discounts/);
  assert.equal(canApplyDiscounts(ctx()).allowed, true);
});

test("order creation is gated by pos.create_orders", () => {
  assert.equal(canCreateOrders(ctx()).allowed, true);
  assert.equal(canCreateOrders(ctx({ permissions: { ...ALL_PERMS, "pos.create_orders": false } })).allowed, false);
});

test("opening a shift needs BOTH the pos.shifts sub-feature and the permission", () => {
  assert.equal(canOpenShift(ctx()).allowed, true);

  const noSubFeature = ctx({ features: { [FEATURES.POS]: true, [FEATURES.POS_TAKEAWAY]: true } });
  const featureGate = canOpenShift(noSubFeature);
  assert.equal(featureGate.allowed, false);
  assert.match(featureGate.reason ?? "", /Shifts are not enabled/);

  const noPerm = ctx({ permissions: { ...ALL_PERMS, "pos.open_shift": false } });
  assert.equal(canOpenShift(noPerm).allowed, false);
});

test("ending your own shift uses end_own_shift; ending another uses approve_shifts", () => {
  const onlyOwn = ctx({ permissions: { ...ALL_PERMS, "pos.approve_shifts": false } });
  assert.equal(canEndShift(onlyOwn, true).allowed, true);
  assert.equal(canEndShift(onlyOwn, false).allowed, false);
  assert.match(canEndShift(onlyOwn, false).reason ?? "", /Only a manager/);
});

test("separation of duties: nobody may review their own shift", () => {
  const manager = ctx({ membership: { role: "manager", status: "active" } });
  assert.equal(canReviewShift(manager, true).allowed, false);
  assert.match(canReviewShift(manager, true).reason ?? "", /cannot approve your own shift/);
  assert.equal(canReviewShift(manager, false).allowed, true);
});

test("a disabled sub-feature closes that order type only", () => {
  const c = ctx();
  assert.equal(canUseOrderType(c, FEATURES.POS_TAKEAWAY), true);
  assert.equal(canUseOrderType(c, FEATURES.POS_DINE_IN), false);
});
