// The `pos_upsert_customer` contract, and the boundary around it.
//
// Two things are asserted here, and the second matters more than the first.
//
// 1. WHAT IS SENT. The RPC reads a payload of six keys. `phone_e164` heads the
//    forbidden list because the server DERIVES it from `phone`: sending our own
//    copy would let a row exist whose raw and normalised forms disagree, which
//    is precisely the state the duplicate rule depends on not happening.
//
// 2. WHAT LEVEL 3A CANNOT DO. Delivery ordering and payment are Levels 3B/3C.
//    The proofs below are static reads of the source, because "the button isn't
//    there" is not the same guarantee as "the call site does not exist". A
//    delivery order submitted from this level would be an order with no cart, no
//    shift check and no receipt - so it must be impossible, not merely hidden.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  AddressStreetRequiredError,
  CUSTOMER_PAYLOAD_KEYS,
  FORBIDDEN_CUSTOMER_FIELDS,
  InvalidPhoneError,
  buildAddressPayload,
  buildCreatePayload,
  buildEditPayload,
} from "@/lib/pos/customers";
import { stripComments } from "./source-helpers.ts";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (...p: string[]) => readFileSync(join(srcRoot, ...p), "utf8");

const customersSrc = read("lib", "pos", "customers.ts");
const workspaceSrc = read("screens", "pos", "DeliveryWorkspace.tsx");
const stateSrc = read("state", "customers.ts");
const deliverySources = [customersSrc, workspaceSrc, stateSrc];

// --- the payload -------------------------------------------------------------

test("the payload has exactly the six keys the RPC reads", () => {
  assert.deepEqual([...CUSTOMER_PAYLOAD_KEYS], ["branch_id", "id", "phone", "name", "notes", "address"]);
});

test("phone_e164 is the first forbidden field - the server derives it", () => {
  assert.equal(FORBIDDEN_CUSTOMER_FIELDS[0], "phone_e164");
  for (const f of ["tenant_id", "created_by", "updated_by", "source"]) {
    assert.ok(FORBIDDEN_CUSTOMER_FIELDS.includes(f as never), `${f} should be forbidden`);
  }
});

test("a create sends the RAW phone and nothing forbidden", () => {
  const payload = buildCreatePayload({ branchId: "b1", phone: "03 123 456", name: "Desktop Level 3A QA" });
  assert.equal(payload.phone, "03 123 456");
  assert.equal(payload.branch_id, "b1");
  assert.equal(payload.name, "Desktop Level 3A QA");
  for (const key of Object.keys(payload)) {
    assert.ok(CUSTOMER_PAYLOAD_KEYS.includes(key as never), `unexpected key ${key}`);
    assert.ok(!FORBIDDEN_CUSTOMER_FIELDS.includes(key as never), `forbidden key ${key}`);
  }
});

test("a create omits blank optional fields rather than sending empty strings", () => {
  const payload = buildCreatePayload({ branchId: null, phone: "03123456", name: "  ", notes: "" });
  assert.deepEqual(Object.keys(payload).sort(), ["branch_id", "phone"]);
});

test("a create refuses a phone the server could not normalise", () => {
  assert.throws(() => buildCreatePayload({ branchId: "b1", phone: "ahmad" }), InvalidPhoneError);
  assert.throws(() => buildCreatePayload({ branchId: "b1", phone: "312345" }), InvalidPhoneError);
  assert.throws(() => buildCreatePayload({ branchId: "b1", phone: "  " }), InvalidPhoneError);
});

test("an edit carries the customer id and only the fields being changed", () => {
  const payload = buildEditPayload({ branchId: "b1", customerId: "c1", name: "New Name" });
  assert.deepEqual(payload, { branch_id: "b1", id: "c1", name: "New Name" });
});

test("an edit that omits the phone does not send one", () => {
  // `_customer_capture` COALESCEs, so an omitted field is left alone. Sending a
  // blank phone would be a different operation entirely.
  const payload = buildEditPayload({ branchId: "b1", customerId: "c1", name: "X", phone: null });
  assert.equal("phone" in payload, false);
});

test("an edit still validates a phone it is asked to change", () => {
  assert.throws(() => buildEditPayload({ branchId: "b1", customerId: "c1", phone: "nope" }), InvalidPhoneError);
});

test("an address requires a street, because the server silently drops one without", () => {
  assert.throws(
    () => buildAddressPayload({ branchId: "b1", customerId: "c1", address: { street: "   " } }),
    AddressStreetRequiredError,
  );
});

test("an address payload nests under `address` and keeps the customer id", () => {
  const payload = buildAddressPayload({
    branchId: "b1",
    customerId: "c1",
    address: { street: "Hamra", area: "Beirut", address_label: "Home", is_default: true },
  });
  assert.equal(payload.id, "c1");
  assert.deepEqual(payload.address, { street: "Hamra", address_label: "Home", area: "Beirut", is_default: true });
});

test("is_default is sent only when true - never as an unrequested demotion", () => {
  const payload = buildAddressPayload({
    branchId: "b1",
    customerId: "c1",
    address: { street: "Hamra", is_default: false },
  });
  assert.equal("is_default" in (payload.address ?? {}), false);
});

// --- the boundary ------------------------------------------------------------

test("Level 3A calls no order, payment or void RPC anywhere in the delivery path", () => {
  const forbidden = ["pos_submit_order", "pos_pay_order", "pos_pay_table", "pos_void_order", "pos_edit_order"];
  for (const src of deliverySources) {
    const code = stripComments(src);
    for (const rpc of forbidden) {
      assert.equal(code.includes(rpc), false, `${rpc} must not appear in the Level 3A delivery path`);
    }
  }
});

test("pos_upsert_customer is the only RPC the customer library calls", () => {
  const calls = [...stripComments(customersSrc).matchAll(/callPosRpc\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(calls, ["pos_upsert_customer"]);
});

test("the RPC allow-list is 13 names and includes pos_upsert_customer", () => {
  const rpcSrc = stripComments(read("lib", "pos", "rpc.ts"));
  const union = rpcSrc.slice(rpcSrc.indexOf("export type PosRpcName"), rpcSrc.indexOf("export class PosRpcError"));
  const names = [...union.matchAll(/"(pos_[a-z_]+)"/g)].map((m) => m[1]);
  assert.equal(names.length, 13);
  assert.ok(names.includes("pos_upsert_customer"));
  // Level 3A added exactly one name, and it is not an order or money RPC.
  assert.equal(names.filter((n) => n.includes("customer")).length, 1);
});

test("customer tables are never written directly - only read", () => {
  const code = stripComments(customersSrc);
  for (const table of ["pos_customers", "pos_customer_addresses", "pos_orders"]) {
    const writes = [...code.matchAll(new RegExp(`from\\("${table}"\\)\\s*\\.(insert|update|upsert|delete)`, "g"))];
    assert.equal(writes.length, 0, `${table} must not be written directly`);
  }
  // The access that does exist is reads: every `.from(...)` is followed by
  // `.select(`, so RLS is the only thing these calls can exercise.
  const froms = [...code.matchAll(/\.from\("pos_[a-z_]+"\)\s*\.(\w+)/g)].map((m) => m[1]);
  assert.ok(froms.length >= 4);
  assert.deepEqual([...new Set(froms)], ["select"]);
});

test("customer writes are never queued offline", () => {
  // A queued customer is a customer whose duplicate check ran against a stale
  // world. The write gate refuses while offline instead.
  for (const src of deliverySources) {
    const code = stripComments(src);
    assert.equal(/enqueue|outbox|offline\/db|pendingCount/.test(code), false);
  }
  assert.ok(customersSrc.includes("needs a connection"));
});

// RETARGETED BY LEVEL 3B. Delivery now takes orders, so it legitimately holds a
// cart, reuses the shared cart panel and carries a shift id - all three were
// scope statements about Level 3A, not safety properties. It still builds no
// menu or cart of its own, which is the part that mattered: a second cart would
// be a second place for someone else's food to end up.
test("the delivery workspace re-implements neither the menu nor the cart", () => {
  const code = stripComments(workspaceSrc);
  for (const token of ["MenuItemGrid", "CategoryNavigation", "ModifierDialog", "loadMenu"]) {
    assert.equal(code.includes(token), false, `${token} must not be re-implemented for Delivery`);
  }
  // It imports the shared panel rather than declaring one.
  assert.match(code, /import \{ CartPanel \} from "@\/components\/pos\/CartPanel"/);
});

// RETARGETED BY LEVEL 3B for the same reason: a delivery order must carry a
// shift, because an order with a null shift can never be paid
// (`_pos_lock_open_shift`). What must still be absent is everything that
// belongs to SETTLEMENT.
test("the delivery workspace has no payment, cash box or receipt path", () => {
  const code = stripComments(workspaceSrc);
  for (const token of [
    "refreshCashBox",
    "ReceiptData",
    "presentReceipt",
    "receiptStore",
    "PaymentDialog",
    "openPayment",
    "pos_pay_order",
    "pos_pay_table",
  ]) {
    assert.equal(code.includes(token), false, `${token} must not appear in the delivery workspace`);
  }
});
