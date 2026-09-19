import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  canResolveDeliveryRow,
  parseResolveDeliveryCost,
} from "../src/lib/pos/deliveryOrderManagement.ts";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

const baseRow = (over: Record<string, unknown> = {}) => ({
  delivery_cost: null,
  cost_status: "unknown",
  has_settlement: true,
  status: "completed",
  ...over,
}) as Parameters<typeof canResolveDeliveryRow>[0];

test("WS7B desktop parseResolveDeliveryCost preserves NULL != 0", () => {
  assert.equal(parseResolveDeliveryCost("   ").valid, false); // blank is not a resolution
  assert.deepEqual(parseResolveDeliveryCost("0"), { valid: true, value: 0, reason: null });
  assert.deepEqual(parseResolveDeliveryCost("90000"), { valid: true, value: 90000, reason: null });
  assert.equal(parseResolveDeliveryCost("-5").valid, false);
  assert.equal(parseResolveDeliveryCost("abc").valid, false);
});

test("WS7B desktop canResolveDeliveryRow offers only a first resolution, only with permission", () => {
  assert.equal(canResolveDeliveryRow(baseRow(), true), true);
  assert.equal(canResolveDeliveryRow(baseRow(), false), false); // no permission
  assert.equal(canResolveDeliveryRow(baseRow({ delivery_cost: 5, cost_status: "entered" }), true), false); // known cost
  assert.equal(canResolveDeliveryRow(baseRow({ has_settlement: false }), true), false); // legacy/no settlement
  assert.equal(canResolveDeliveryRow(baseRow({ status: "refunded" }), true), false); // terminal
});

test("WS7B desktop provider settings — internal-driver employee link contract", () => {
  const providers = read("src/lib/pos/deliveryProviders.ts");
  assert.match(providers, /delivery_provider_eligible_employees/);
  const screen = read("src/screens/settings/DeliveryProviders.tsx");
  // employee_id sent only for internal_driver (external forced null)
  assert.match(screen, /f\.kind === "internal_driver"\s*\?\s*\(f\.employee_id \|\| null\)\s*:\s*null/);
  // picker rendered only for internal drivers
  assert.match(screen, /form\.kind === "internal_driver" && \(/);
});

test("WS7B desktop delivery report — resolution is RPC-only and permission-gated", () => {
  const mgmt = read("src/lib/pos/deliveryOrderManagement.ts");
  assert.match(mgmt, /"pos_delivery_resolve_cost"/);
  const report = read("src/components/pos/DeliveryReport.tsx");
  assert.match(report, /canResolveDeliveryRow\(r, canReconcile\)/);
  // no client-side settlement status computed
  assert.doesNotMatch(report, /immediate_paid/);
  assert.doesNotMatch(report, /payable_open/);
});

test("WS7B desktop — pos_delivery_resolve_cost is a declared POS RPC", () => {
  const rpc = read("src/lib/pos/rpc.ts");
  assert.match(rpc, /"pos_delivery_resolve_cost"/);
});

test("WS7B desktop — settlements.manage gate exists and is threaded", () => {
  const access = read("src/lib/pos/access.ts");
  assert.match(access, /pos\.delivery\.settlements\.manage/);
  assert.match(access, /canReconcileDeliverySettlements/);
  const state = read("src/state/pos.ts");
  assert.match(state, /reconcileDeliverySettlements/);
});
