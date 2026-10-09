// Desktop 1.0.35 (R2) — Delivery Order Item Editing: pure eligibility + mutation-lifecycle coverage.
// These exercise the actual decision logic the UI runs (not just source patterns): eligibility gating,
// server-mirrored reason prediction, duplicate-submit serialization, op-id reuse/replay on uncertain
// failure, stale-completion rejection, and success consumption. The rendered interactive flow is a
// separate, explicit staging acceptance gate (the desktop test runner cannot render React).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deliveryItemEditGate,
  isDeliveryItemsEditableState,
  editNeedsReason,
  deliveryEditReducer,
  initialDeliveryEditState,
  editKey,
  editOpIdFor,
  addDraftSimple,
  addDraftFromOptions,
  type DeliveryEditState,
  type AddDraftItem,
} from "@/lib/pos/deliveryItemEdit";

// --- Eligibility --------------------------------------------------------------------------------
test("items are editable ONLY on an open, unpaid delivery order", () => {
  assert.equal(isDeliveryItemsEditableState({ orderType: "delivery", status: "sent_to_kitchen", paymentStatus: "unpaid" }), true);
  assert.equal(isDeliveryItemsEditableState({ orderType: "delivery", status: "sent_to_kitchen", paymentStatus: "paid" }), false);
  assert.equal(isDeliveryItemsEditableState({ orderType: "delivery", status: "completed", paymentStatus: "unpaid" }), false);
  assert.equal(isDeliveryItemsEditableState({ orderType: "dine_in", status: "sent_to_kitchen", paymentStatus: "unpaid" }), false);
  assert.equal(isDeliveryItemsEditableState({ orderType: "takeaway", status: "sent_to_kitchen", paymentStatus: "unpaid" }), false);
});

test("the gate refuses — with a reason — a paid/finalized order or a missing permission", () => {
  const open = { orderType: "delivery", status: "sent_to_kitchen", paymentStatus: "unpaid" };
  assert.deepEqual(deliveryItemEditGate(open, true), { allowed: true, reason: null });
  const paid = deliveryItemEditGate({ ...open, paymentStatus: "paid" }, true);
  assert.equal(paid.allowed, false);
  assert.match(paid.reason!, /open, unpaid delivery/i);
  const noPerm = deliveryItemEditGate(open, false);
  assert.equal(noPerm.allowed, false);
  assert.match(noPerm.reason!, /permission/i);
});

// --- Reason prediction (mirrors the server predicate) -------------------------------------------
test("a reduction / removal / modifier-drop needs a reason; a pure increase or add does not", () => {
  assert.equal(editNeedsReason({ op: "set_quantity", previousQuantity: 2, newQuantity: 1 }), true);
  assert.equal(editNeedsReason({ op: "set_quantity", previousQuantity: 2, newQuantity: 0 }), true);
  assert.equal(editNeedsReason({ op: "set_quantity", previousQuantity: 1, newQuantity: 3 }), false);
  const oldMods = [{ group_id: "g", option_id: "o1", quantity: 1 }];
  assert.equal(editNeedsReason({ op: "change_modifiers", previousQuantity: 1, newQuantity: 1, oldModifiers: oldMods, newModifiers: [] }), true);
  assert.equal(
    editNeedsReason({ op: "change_modifiers", previousQuantity: 1, newQuantity: 1, oldModifiers: oldMods, newModifiers: [...oldMods, { group_id: "g", option_id: "o2", quantity: 1 }] }),
    false,
  );
});

// --- Mutation lifecycle reducer -----------------------------------------------------------------
const K = editKey("qty", "line1");
const SNAP = { opId: "op-A", expectedVersion: 5 };

test("submit_start latches busy and snapshots once", () => {
  const s = deliveryEditReducer(initialDeliveryEditState, { t: "submit_start", key: K, snapshot: SNAP });
  assert.equal(s.busy, K);
  assert.deepEqual(s.intents[K], SNAP);
  assert.equal(s.error, null);
});

test("a second submit while busy is a NO-OP (duplicate-submit prevention)", () => {
  let s = deliveryEditReducer(initialDeliveryEditState, { t: "submit_start", key: K, snapshot: SNAP });
  const s2 = deliveryEditReducer(s, { t: "submit_start", key: editKey("qty", "line2"), snapshot: { opId: "op-B", expectedVersion: 5 } });
  assert.strictEqual(s2, s); // unchanged reference
  assert.equal(s2.busy, K);
});

test("submit_ok clears busy and CONSUMES the snapshot (a fresh edit re-snapshots)", () => {
  let s = deliveryEditReducer(initialDeliveryEditState, { t: "submit_start", key: K, snapshot: SNAP });
  s = deliveryEditReducer(s, { t: "submit_ok", key: K });
  assert.equal(s.busy, null);
  assert.equal(K in s.intents, false);
});

test("submit_fail clears busy but KEEPS the snapshot so an identical retry replays the same op id", () => {
  let s = deliveryEditReducer(initialDeliveryEditState, { t: "submit_start", key: K, snapshot: SNAP });
  s = deliveryEditReducer(s, { t: "submit_fail", key: K, error: "network" });
  assert.equal(s.busy, null);
  assert.deepEqual(s.intents[K], SNAP); // retained
  assert.equal(s.error, "network");
  // the retry reuses the SAME op id (replay), not a fresh one
  assert.equal(editOpIdFor(s, K), "op-A");
  // and re-submitting reuses the retained snapshot, never a new one
  const retry = deliveryEditReducer(s, { t: "submit_start", key: K, snapshot: { opId: "op-NEW", expectedVersion: 9 } });
  assert.deepEqual(retry.intents[K], SNAP);
});

test("a stale completion that does not match the in-flight key is ignored", () => {
  let s = deliveryEditReducer(initialDeliveryEditState, { t: "submit_start", key: K, snapshot: SNAP });
  const foreign = deliveryEditReducer(s, { t: "submit_ok", key: editKey("qty", "other") });
  assert.strictEqual(foreign, s); // ignored
  assert.equal(foreign.busy, K);
});

test("editOpIdFor mints a fresh id when the key has no retained snapshot", () => {
  const fresh = editOpIdFor(initialDeliveryEditState, K);
  assert.equal(typeof fresh, "string");
  assert.ok(fresh.length >= 8);
});

test("reset clears everything atomically (surface close / context change)", () => {
  let s: DeliveryEditState = deliveryEditReducer(initialDeliveryEditState, { t: "submit_start", key: K, snapshot: SNAP });
  s = deliveryEditReducer(s, { t: "submit_fail", key: K, error: "x" });
  s = deliveryEditReducer(s, { t: "reset" });
  assert.deepEqual(s, initialDeliveryEditState);
});

// --- Add-items draft builders (the picker's pending list) ---------------------------------------
test("addDraftSimple appends a bare item, and merges a repeat by bumping quantity", () => {
  let d: AddDraftItem[] = [];
  d = addDraftSimple(d, { id: "mi1", name: "Fries" }, "k1");
  assert.equal(d.length, 1);
  assert.equal(d[0].input.quantity, 1);
  d = addDraftSimple(d, { id: "mi1", name: "Fries" }, "k2"); // repeat → merge
  assert.equal(d.length, 1);
  assert.equal(d[0].input.quantity, 2);
  d = addDraftSimple(d, { id: "mi2", name: "Cola" }, "k3"); // different item → new line
  assert.equal(d.length, 2);
});

test("addDraftFromOptions carries identities + quantities ONLY, drops id-less options, and no price", () => {
  const result = {
    quantity: 2,
    modifiers: [
      { group_id: "g", option_id: "o1", name: "Large", price_delta: 1.5, quantity: 1 },
      { group_id: "g", option_id: null, name: "placeholder", price_delta: 9, quantity: 1 }, // id-less → dropped
    ],
  } as const;
  const d = addDraftFromOptions([], { id: "mi1", name: "Pizza" }, result as never, "k1");
  assert.equal(d.length, 1);
  assert.equal(d[0].input.quantity, 2);
  assert.equal(d[0].input.modifiers!.length, 1); // the id-less option was dropped
  assert.equal(d[0].input.modifiers![0].option_id, "o1");
  // The draft input must never carry a price-bearing key (the server prices everything).
  const blob = JSON.stringify(d[0].input);
  for (const banned of ["price", "price_delta", "base_price", "extra_price"]) {
    assert.ok(!blob.includes(banned), `draft input must not carry ${banned}`);
  }
});
