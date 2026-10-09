// Desktop 1.0.35 (R2) — Delivery Order Item Editing: add-new-item CLIENT contract. The desktop sends item
// identities + quantities ONLY (never a price); the SERVER resolves prices from the branch menu, validates
// availability/attachment, and composes the delivery total. Runtime behavior (server pricing, delivery total
// with fee, idempotency replay-before-CAS, fingerprint mismatch) was proven on staging (impersonated
// manager, QA #2101 Main, fully cleaned up).
// NOTE: the server-authoritative SQL shape lives in the web/server repo and is guarded by that repo's tests.
// The desktop repo ships NO database migrations (a 1.0.34 architectural invariant), so the migration-SQL
// contract tests are intentionally not part of this file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildAddItemsPayload } from "@/lib/pos/orders";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

// --- Client contract: the add payload carries NO price (server-authoritative) --------------------
test("buildAddItemsPayload carries item identities + quantities, and NEVER a price", () => {
  const payload = buildAddItemsPayload({
    orderId: "o1",
    expectedVersion: 3,
    clientOpId: "op1",
    items: [
      {
        menu_item_id: "mi1",
        quantity: 2,
        modifiers: [{ option_id: "opt1", name: "Large", quantity: 1 }],
        kitchen_note: "no onion",
      },
      { menu_item_id: "mi2", quantity: 1 },
    ],
  });
  assert.equal(payload.order_id, "o1");
  assert.equal(payload.expected_version, 3);
  assert.equal(payload.client_op_id, "op1");
  assert.equal(payload.items.length, 2);
  // The WHOLE payload must contain no price-bearing key anywhere.
  const blob = JSON.stringify(payload);
  for (const banned of ["base_price", "price", "price_delta", "extra_price", "final_unit_price", "line_total"]) {
    assert.ok(!blob.includes(banned), `add payload must not carry ${banned}`);
  }
  // Modifiers carry option_id (+ optional name/quantity) only.
  const m = payload.items[0].modifiers![0];
  assert.deepEqual(Object.keys(m).sort(), ["name", "option_id", "quantity"].sort());
  assert.equal(m.option_id, "opt1");
});

test("buildAddItemsPayload omits empty modifiers / kitchen_note / customization cleanly", () => {
  const payload = buildAddItemsPayload({
    orderId: "o1",
    expectedVersion: 1,
    clientOpId: "op1",
    items: [{ menu_item_id: "mi1", quantity: 1 }],
  });
  const it = payload.items[0] as Record<string, unknown>;
  assert.ok(!("modifiers" in it));
  assert.ok(!("kitchen_note" in it));
  assert.ok(!("customization_json" in it));
});

// --- Contract (source): the RPC is allow-listed and the client calls exactly it -------------------
test("pos_add_order_items is on the RPC allow-list and addOrderItems calls exactly it", () => {
  const rpc = read("src/lib/pos/rpc.ts");
  assert.ok(/\|\s*"pos_add_order_items"/.test(rpc), "pos_add_order_items must be in PosRpcName");
  const orders = read("src/lib/pos/orders.ts");
  assert.ok(/callPosRpc\("pos_add_order_items"/.test(orders), "addOrderItems must call pos_add_order_items");
});
