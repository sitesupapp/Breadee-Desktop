// Delivery Settlement WS6.3 — Desktop POS operational provider + cost capture.
//
// Server-authoritative and RPC-only. These pin the client's half of the contract:
// NULL != 0 is preserved end-to-end, the friendly pre-pay guard reproduces the
// server's own wording, zero-provider preservation matches the server no-op, the
// capture permission is the cashier-default `pos.delivery.cost.capture` (never the
// manager's providers.manage), and the module never writes a settlement, drawer
// effect or provider payable. Pure functions, so no database and no browser.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  SET_PROVIDER_PARAM_KEYS,
  FORBIDDEN_SET_PROVIDER_FIELDS,
  buildSetProviderArgs,
  deliveryProviderFinalizeBlock,
  parseDeliveryCost,
  providerCaptureActive,
  type OperationalProvider,
} from "@/lib/pos/deliveryProviderCapture";
import { canCaptureDeliveryCost, POS_PERMISSIONS } from "@/lib/pos/access";
import { FEATURES } from "@/lib/features";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (...p: string[]) => readFileSync(join(srcRoot, ...p), "utf8");

const provider = (over: Partial<OperationalProvider> = {}): OperationalProvider => ({
  id: "p1",
  name: "ABC Delivery",
  kind: "external_provider",
  settlement_mode: "immediate_cash",
  cost_entry_mode: "required_before_pay",
  default_currency: "LBP",
  ...over,
});

// --- NULL != 0 ---------------------------------------------------------------

test("parseDeliveryCost keeps blank (NULL) distinct from an explicit 0", () => {
  assert.deepEqual(parseDeliveryCost(""), { valid: true, value: null, provided: false });
  assert.deepEqual(parseDeliveryCost("   "), { valid: true, value: null, provided: false });
  assert.deepEqual(parseDeliveryCost("0"), { valid: true, value: 0, provided: true });
  assert.deepEqual(parseDeliveryCost("5"), { valid: true, value: 5, provided: true });
  assert.equal(parseDeliveryCost("-1").valid, false);
  assert.equal(parseDeliveryCost("abc").valid, false);
});

test("buildSetProviderArgs maps NULL != 0 to the RPC's two-arg contract", () => {
  // Blank -> not provided -> the server stores NULL (unknown).
  assert.deepEqual(buildSetProviderArgs({ orderId: "o1", providerId: "p1", cost: parseDeliveryCost("") }), {
    p_order_id: "o1",
    p_provider_id: "p1",
    p_delivery_cost: null,
    p_cost_provided: false,
  });
  // Explicit 0 -> provided -> the server stores 0 (free delivery), never NULL.
  assert.deepEqual(buildSetProviderArgs({ orderId: "o1", providerId: "p1", cost: parseDeliveryCost("0") }), {
    p_order_id: "o1",
    p_provider_id: "p1",
    p_delivery_cost: 0,
    p_cost_provided: true,
  });
  // A positive value passes through exactly.
  assert.equal(buildSetProviderArgs({ orderId: "o1", providerId: "p1", cost: parseDeliveryCost("90000") }).p_delivery_cost, 90000);
});

test("the set-provider args carry ONLY the four RPC params — no money/settlement field", () => {
  const args = buildSetProviderArgs({ orderId: "o1", providerId: "p1", cost: parseDeliveryCost("0") }) as Record<string, unknown>;
  assert.deepEqual(Object.keys(args).sort(), [...SET_PROVIDER_PARAM_KEYS].sort());
  for (const forbidden of FORBIDDEN_SET_PROVIDER_FIELDS) {
    assert.equal(Object.prototype.hasOwnProperty.call(args, forbidden), false, `${forbidden} must never be sent`);
  }
});

// --- zero-provider preservation ---------------------------------------------

test("provider mode is on ONLY when the feature is on AND there is an active provider", () => {
  assert.equal(providerCaptureActive({ featureOn: false, providers: [provider()] }), false);
  assert.equal(providerCaptureActive({ featureOn: true, providers: [] }), false); // zero-provider preservation
  assert.equal(providerCaptureActive({ featureOn: true, providers: [provider()] }), true);
});

// --- friendly pre-pay guard (mirrors the server) -----------------------------

test("the finalize guard never blocks in legacy / zero-provider mode", () => {
  assert.equal(
    deliveryProviderFinalizeBlock({ providerModeOn: false, providerId: null, deliveryCost: null, providers: [] }),
    null,
  );
});

test("provider mode requires a provider, then a cost for a required-before-pay provider", () => {
  const providers = [provider({ id: "p1", cost_entry_mode: "required_before_pay" })];
  // No provider selected yet.
  assert.match(
    deliveryProviderFinalizeBlock({ providerModeOn: true, providerId: null, deliveryCost: null, providers }) ?? "",
    /Select a delivery provider before completing this delivery order\./,
  );
  // Provider selected, required cost still missing — server's exact wording.
  assert.match(
    deliveryProviderFinalizeBlock({ providerModeOn: true, providerId: "p1", deliveryCost: null, providers }) ?? "",
    /Delivery cost is required for ABC Delivery before completing this order\./,
  );
  // Required cost present -> no block.
  assert.equal(
    deliveryProviderFinalizeBlock({ providerModeOn: true, providerId: "p1", deliveryCost: 90000, providers }),
    null,
  );
  // Explicit 0 is a provided cost -> no block (NULL != 0 all the way to the guard).
  assert.equal(
    deliveryProviderFinalizeBlock({ providerModeOn: true, providerId: "p1", deliveryCost: 0, providers }),
    null,
  );
});

test("optional / entered-later providers never require a cost before pay", () => {
  const optional = [provider({ id: "p1", cost_entry_mode: "optional" })];
  const later = [provider({ id: "p1", cost_entry_mode: "entered_later" })];
  assert.equal(deliveryProviderFinalizeBlock({ providerModeOn: true, providerId: "p1", deliveryCost: null, providers: optional }), null);
  assert.equal(deliveryProviderFinalizeBlock({ providerModeOn: true, providerId: "p1", deliveryCost: null, providers: later }), null);
});

// --- permission gate ---------------------------------------------------------

const ctx = (over: { perms?: Record<string, boolean>; features?: Record<string, boolean>; role?: string } = {}) => ({
  membership: { role: (over.role ?? "cashier") as never, status: "active" as never },
  permissions: { [POS_PERMISSIONS.ACCESS]: true, ...(over.perms ?? {}) },
  features: {
    [FEATURES.POS]: true,
    [FEATURES.POS_DELIVERY]: true,
    [FEATURES.POS_DELIVERY_PROVIDERS]: true,
    ...(over.features ?? {}),
  },
});

test("cost capture needs the feature AND the cashier cost-capture permission", () => {
  assert.equal(canCaptureDeliveryCost(ctx({ perms: { "pos.delivery.cost.capture": true } })).allowed, true);
  // Feature off -> blocked.
  const noFeat = canCaptureDeliveryCost(
    ctx({ perms: { "pos.delivery.cost.capture": true }, features: { [FEATURES.POS_DELIVERY_PROVIDERS]: false } }),
  );
  assert.equal(noFeat.allowed, false);
  assert.match(noFeat.reason ?? "", /Advanced Delivery Providers is not enabled/i);
  // Permission missing -> blocked.
  assert.equal(canCaptureDeliveryCost(ctx()).allowed, false);
});

test("cost capture does NOT require providers.manage, and owners are blocked", () => {
  // A cashier with cost.capture but WITHOUT providers.manage may still capture.
  assert.equal(
    canCaptureDeliveryCost(ctx({ perms: { "pos.delivery.cost.capture": true } })).allowed,
    true,
  );
  // providers.manage alone (no cost.capture) does NOT grant operational capture.
  assert.equal(
    canCaptureDeliveryCost(ctx({ perms: { "pos.delivery.providers.manage": true } })).allowed,
    false,
  );
  // Owners are not operational POS users (mirrors pos_assert_operator).
  assert.equal(
    canCaptureDeliveryCost(ctx({ role: "owner", perms: { "pos.delivery.cost.capture": true } })).allowed,
    false,
  );
});

// --- RPC-only, server-authoritative firewall ---------------------------------

test("the capture module is RPC-only and computes no settlement/drawer figure", () => {
  const code = read("lib", "pos", "deliveryProviderCapture.ts");
  // Never a direct table read/write of the provider or settlement tables.
  assert.equal(/\.from\(\s*["'`]delivery_providers["'`]\s*\)/.test(code), false);
  assert.equal(/\.from\(\s*["'`]delivery_settlements["'`]\s*\)/.test(code), false);
  // Exactly the two canonical RPCs, invoked by name.
  assert.match(code, /rpcCall\("delivery_providers_operational"/);
  assert.match(code, /rpcCall\("pos_delivery_set_provider"/);
  // Never INVOKES a money/finalization RPC (comments may reference them by name —
  // assert on the call form rpcCall("<name>", not bare mentions).
  for (const banned of ['rpcCall("pos_pay_order"', 'rpcCall("pos_complete_on_account"', 'rpcCall("pos_void_order"']) {
    assert.equal(code.includes(banned), false, `${banned} must not appear in the capture module`);
  }
});

test("the detail panel replaces the legacy ops editor in provider mode, never both", () => {
  const code = read("components", "pos", "DeliveryOrderDetail.tsx");
  assert.match(code, /props\.providerModeOn &&/);
  assert.match(code, /!props\.providerModeOn &&/);
  assert.match(code, /DeliveryProviderEditor/);
  // The legacy ops editor is preserved for the feature-off / zero-provider path.
  assert.match(code, /DeliveryOpsEditor/);
});
