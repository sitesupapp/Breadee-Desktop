// Delivery Providers (Settings) — gating, the RPC-only contract, and the exact UX
// terminology/figures shared with WS4 Web.
//
// The gate is a real unit (canManageDeliveryProviders); the terminology, worked
// examples and the "no unfinished enum" rule are pinned as source contracts so the
// desktop can never drift from the approved Web contract or offer a mode the WS3
// upsert RPC would reject.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { canManageDeliveryProviders, type PosAccessContext } from "@/lib/pos/access";
import { FEATURES } from "@/lib/features";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const SCREEN = read("../src/screens/settings/DeliveryProviders.tsx");
const LIB = read("../src/lib/pos/deliveryProviders.ts");

function ctx(over: Partial<{ role: string; status: string; features: Record<string, boolean>; permissions: Record<string, boolean> }> = {}): PosAccessContext {
  return {
    membership: { role: over.role ?? "manager", status: over.status ?? "active" } as PosAccessContext["membership"],
    features: over.features ?? { pos: true, [FEATURES.POS_DELIVERY_PROVIDERS]: true },
    permissions: over.permissions ?? { "pos.delivery.providers.manage": true },
  };
}

// --- gate --------------------------------------------------------------------
test("feature key is the canonical two-segment pos.delivery_providers", () => {
  assert.equal(FEATURES.POS_DELIVERY_PROVIDERS, "pos.delivery_providers");
});

test("allowed when the feature and the manage permission are both present", () => {
  assert.equal(canManageDeliveryProviders(ctx()).allowed, true);
});

test("owners are NOT blocked — provider settings is an admin surface, not operational POS", () => {
  assert.equal(canManageDeliveryProviders(ctx({ role: "owner" })).allowed, true);
});

test("feature OFF hides the advanced settings (and never the base delivery)", () => {
  const g = canManageDeliveryProviders(ctx({ features: { pos: true, "pos.delivery_providers": false } }));
  assert.equal(g.allowed, false);
  assert.match(g.reason ?? "", /not enabled/i);
});

test("the POS module being off denies too", () => {
  assert.equal(canManageDeliveryProviders(ctx({ features: { pos: false, "pos.delivery_providers": true } })).allowed, false);
});

test("permission OFF denies with a permission reason", () => {
  const g = canManageDeliveryProviders(ctx({ permissions: {} }));
  assert.equal(g.allowed, false);
  assert.match(g.reason ?? "", /permission/i);
});

test("inactive membership denies", () => {
  assert.equal(canManageDeliveryProviders(ctx({ status: "removed" })).allowed, false);
});

// --- RPC-only contract -------------------------------------------------------
test("the data layer calls only the WS3 provider RPCs and never a raw table", () => {
  for (const rpc of ["delivery_providers_admin_list", "delivery_provider_upsert", "delivery_provider_set_active"]) {
    assert.ok(LIB.includes(rpc), `${rpc} must be called`);
  }
  assert.doesNotMatch(LIB, /\.from\(\s*["'`]delivery_providers["'`]/);
  assert.doesNotMatch(LIB, /\.from\(\s*["'`]delivery_settlements["'`]/);
  assert.doesNotMatch(SCREEN, /\.from\(/);
});

// --- settlement labels + exact worked examples (WS4.1 contract) --------------
test("uses the approved settlement labels", () => {
  assert.ok(SCREEN.includes('"Paid from each order"'));
  assert.ok(SCREEN.includes('"Invoice me later"'));
  assert.ok(!SCREEN.includes("Paid in cash right away"));
  assert.ok(!SCREEN.includes("Billed and settled later"));
});

test("shows the exact Paid-from-each-order and Invoice-me-later drawer figures", () => {
  assert.ok(SCREEN.includes('"696,000 LBP"'));
  assert.ok(SCREEN.includes('"90,000 LBP"'));
  assert.ok(SCREEN.includes('"606,000 LBP"'));
  assert.ok(SCREEN.includes("Expected drawer"));
  assert.ok(SCREEN.includes("Breadee will deduct the provider's delivery cost from this shift's expected cash."));
  assert.ok(SCREEN.includes("Breadee records what you owe the provider but keeps the full customer payment in today's expected cash."));
  // Invoice-me-later keeps the full 696,000; no stray 900,000-style example.
  assert.ok(!SCREEN.includes('"900,000 LBP"'));
});

// --- cost-entry labels -------------------------------------------------------
test("uses the approved cost-entry labels", () => {
  assert.ok(SCREEN.includes("Require delivery cost before payment"));
  assert.ok(SCREEN.includes("Can be entered later"));
  assert.ok(SCREEN.includes('"Optional"') || SCREEN.includes("Optional</option>") || SCREEN.includes("Optional"));
});

// --- Wave-1 enum whitelist ---------------------------------------------------
test("offers only the two Wave-1 settlement modes and three cost-entry modes", () => {
  assert.ok(SCREEN.includes('"immediate_cash"'));
  assert.ok(SCREEN.includes('"provider_payable"'));
  for (const forbidden of ["driver_payable", "payroll", "analytics_only", "automatic_rate"]) {
    assert.ok(!SCREEN.includes(`"${forbidden}"`), `${forbidden} must not be offered`);
    assert.ok(!LIB.includes(`"${forbidden}"`), `${forbidden} must not appear in the data layer`);
  }
  for (const ok of ["required_before_pay", "entered_later", "optional"]) {
    assert.ok(SCREEN.includes(`"${ok}"`), `${ok} must be offered`);
  }
});

// --- first-time wizard -------------------------------------------------------
test("provides the first-time setup wizard reachable from the empty state", () => {
  assert.ok(SCREEN.includes("ProviderWizard"));
  assert.ok(SCREEN.includes("Set up your first delivery provider"));
  assert.ok(SCREEN.includes("No delivery providers are set up for this location yet."));
  // Wizard saves through the SAME canonical upsert path, not a separate model.
  assert.ok(SCREEN.includes("onSave"));
});
