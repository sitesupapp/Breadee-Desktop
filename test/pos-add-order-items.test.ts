// Desktop 1.0.35 (R2) — Delivery Order Item Editing: add-new-item client contract + server-authority
// invariants. The desktop sends item identities + quantities ONLY (never a price); the SERVER resolves
// prices from the branch menu, validates availability/attachment, and composes the delivery total.
// Runtime behavior (server pricing, delivery total with fee, idempotency replay-before-CAS, fingerprint
// mismatch) was proven on staging (impersonated manager, QA #2101 Main, fully cleaned up). This guards the
// desktop wiring + the migration's server-authoritative shape from drift.

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

// --- Server authority + safety invariants (migration source) --------------------------------------
test("the migration resolves prices server-side and never trusts a client price", () => {
  const sql = read("supabase/migrations/20261009090000_r2_delivery_item_editing.sql");
  // price resolved from the branch menu (pos_menu predicates), not from the payload.
  assert.ok(/menu_item_branch_availability/.test(sql), "add op must read menu_item_branch_availability");
  assert.ok(/coalesce\(o\.price_override, i\.price\)/.test(sql), "base price = coalesce(price_override, menu price)");
  assert.ok(/modifier_option_ou/.test(sql), "modifier price resolved from modifier_option_ou");
  assert.ok(/menu_item_modifier_ou/.test(sql), "modifier attachment validated via menu_item_modifier_ou");
  // the add CORE must not read a client base_price out of the items payload.
  const core = /pos_add_order_items_core[\s\S]*?end; \$function\$;/.exec(sql)?.[0] ?? "";
  assert.ok(core.length > 0, "add core present");
  assert.ok(!/it->>'base_price'/.test(core), "add core must not read a client base_price");
});

test("the add wrapper locks, replays BEFORE CAS, binds actor + fingerprint, and is delivery-only", () => {
  const sql = read("supabase/migrations/20261009090000_r2_delivery_item_editing.sql");
  const wrap = /CREATE OR REPLACE FUNCTION public\.pos_add_order_items\(p_payload jsonb\)[\s\S]*?end; \$function\$;/.exec(sql)?.[0] ?? "";
  assert.ok(wrap.length > 0, "wrapper present");
  // order locked FOR UPDATE, tenant/branch derived from the locked row.
  assert.ok(/from public\.pos_orders where id = v_order_id for update/.test(wrap), "wrapper locks the order row");
  // delivery-only eligibility.
  assert.ok(/order_type = 'delivery'/.test(wrap), "add op is delivery-only");
  // replay occurs before the CAS version check (so a legitimate retry does not fail on the bumped version).
  const replayIdx = wrap.indexOf("pos_op_replay");
  const casIdx = wrap.indexOf("pos_entity_version is distinct from v_ex_ver");
  assert.ok(replayIdx > -1 && casIdx > -1 && replayIdx < casIdx, "replay must precede CAS");
  // actor + fingerprint bound on replay.
  assert.ok(/CROSS_ACTOR_REPLAY_REJECTED/.test(wrap), "replay re-checks actor");
  assert.ok(/IDEMPOTENCY_PAYLOAD_MISMATCH/.test(wrap), "replay re-checks payload fingerprint");
});

test("the add core resolves item + modifier NAMES authoritatively (never the client payload)", () => {
  const sql = read("supabase/migrations/20261009090000_r2_delivery_item_editing.sql");
  const core = /pos_add_order_items_core[\s\S]*?end; \$function\$;/.exec(sql)?.[0] ?? "";
  assert.ok(core.length > 0, "add core present");
  // item name is the catalogue row's i.name, NOT a client it->>'name'
  assert.ok(/into v_base, v_name\s*\n\s*from public\.menu_item_branch_availability/.test(core));
  assert.ok(!/coalesce\(nullif\(it->>'name'/.test(core), "add core must not take the client item name");
  // modifier name is the catalogue mo.name, resolved into v_optname and used for the snapshot
  assert.ok(/mo\.modifier_group_id, mo\.name\s*\n\s*into v_delta, v_grp, v_optname/.test(core), "modifier name resolved from mo.name");
  assert.ok(/'name', coalesce\(v_optname,'Option'\)/.test(core), "modifier snapshot name is the resolved catalogue name");
  assert.ok(!/'name', coalesce\(md->>'name'/.test(core), "add core must not take the client modifier name");
});

test("the add core rejects a non-positive modifier quantity before any mutation", () => {
  const sql = read("supabase/migrations/20261009090000_r2_delivery_item_editing.sql");
  const core = /pos_add_order_items_core[\s\S]*?end; \$function\$;/.exec(sql)?.[0] ?? "";
  assert.ok(/v_mqty := coalesce\(\(md->>'quantity'\)::int, 1\);/.test(core));
  assert.ok(/if v_mqty <= 0 then\s*\n\s*raise exception 'Modifier quantity must be a positive integer'/.test(core));
});

test("the add fingerprint binds every mutation field (note, customization, modifier quantity)", () => {
  const sql = read("supabase/migrations/20261009090000_r2_delivery_item_editing.sql");
  const wrap = /CREATE OR REPLACE FUNCTION public\.pos_add_order_items\(p_payload jsonb\)[\s\S]*?end; \$function\$;/.exec(sql)?.[0] ?? "";
  assert.ok(wrap.length > 0, "wrapper present");
  assert.ok(/v_fp := md5\(/.test(wrap), "fingerprint present");
  // These tokens appear in the wrapper ONLY inside the fingerprint expression.
  assert.ok(/it->>'kitchen_note'/.test(wrap), "fingerprint binds kitchen_note");
  assert.ok(/it->'customization_json'/.test(wrap), "fingerprint binds customization_json");
  assert.ok(/m->>'quantity'/.test(wrap), "fingerprint binds each modifier's quantity");
  assert.ok(/m->>'option_id'/.test(wrap), "fingerprint binds each modifier's option id");
});

test("delivery edit composes the authoritative total via finance; dine-in never does", () => {
  const sql = read("supabase/migrations/20261009090000_r2_delivery_item_editing.sql");
  const editCore = /CREATE OR REPLACE FUNCTION public\.pos_edit_order_line_core[\s\S]*?end; \$function\$;/.exec(sql)?.[0] ?? "";
  assert.ok(editCore.length > 0, "edit core present");
  // gate broadened to dine_in+delivery.
  assert.ok(/order_type in \('dine_in','delivery'\)/.test(editCore), "gate broadened to dine_in+delivery");
  // finance_apply is called ONLY under the delivery branch (dine-in stays byte-identical).
  assert.ok(/if v_order\.order_type = 'delivery' then\s*\n\s*perform public\.finance_apply_order_totals/.test(editCore),
    "finance_apply must be gated to delivery only");
  // dine-in action labels preserved via the prefix (dinein_*).
  assert.ok(/v_prefix := case when v_order\.order_type = 'delivery' then 'delivery' else 'dinein' end/.test(editCore),
    "action label prefix is order-type aware, preserving dinein_*");
});
