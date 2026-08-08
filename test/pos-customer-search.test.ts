// Customer lookup and the create decision.
//
// `decideCreate` is the P0 rule in one pure function: given what the operator
// typed and the shortlist currently on file, may a new customer be inserted?
//
// It answers "no" far more often than a naive flow would, and every "no" here
// corresponds to a duplicate the database would have accepted - `pos_customers`
// is unique on the RAW phone, so a second row for the same person is a perfectly
// legal insert. This function is the only thing standing in its way.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  HISTORY_LIMIT,
  SEARCH_LIMIT,
  customerLookupGate,
  customerWriteGate,
  decideCreate,
  mergeMatches,
  sanitizeSearchTerm,
  type CustomerMatch,
} from "@/lib/pos/customers";

const allow = { allowed: true, reason: null };

const match = (over: Partial<CustomerMatch> = {}): CustomerMatch => ({
  id: "c1",
  name: "Desktop Level 3A QA",
  phone: "03123456",
  phone_e164: "+9613123456",
  ...over,
});

// --- search plumbing ---------------------------------------------------------

test("the search term is stripped of characters that would break the or() grammar", () => {
  // Replaced with a space rather than deleted, so two tokens never fuse into a
  // third word that matches nothing.
  assert.equal(sanitizeSearchTerm("ahmad%"), "ahmad");
  assert.equal(sanitizeSearchTerm("ahmad,fadi"), "ahmad fadi");
  assert.equal(sanitizeSearchTerm("  03123456  "), "03123456");
  assert.equal(sanitizeSearchTerm(",,,"), "");
});

test("the shortlist and history caps are the web's", () => {
  assert.equal(SEARCH_LIMIT, 10);
  assert.equal(HISTORY_LIMIT, 25);
});

test("merging two passes keeps first occurrence and drops repeats", () => {
  const a = match({ id: "a" });
  const b = match({ id: "b", name: "Second" });
  assert.deepEqual(mergeMatches([a, b], [a]), [a, b]);
});

test("merging is capped at the shortlist size", () => {
  const many = Array.from({ length: 14 }, (_, i) => match({ id: `c${i}` }));
  assert.equal(mergeMatches(many).length, SEARCH_LIMIT);
});

// --- gates -------------------------------------------------------------------

test("lookup needs delivery access and the view permission", () => {
  assert.equal(customerLookupGate({ deliveryAccess: allow, canView: true }).allowed, true);
  assert.equal(customerLookupGate({ deliveryAccess: allow, canView: false }).allowed, false);
  const noDelivery = { allowed: false, reason: "Delivery is not enabled for this plan." };
  assert.equal(customerLookupGate({ deliveryAccess: noDelivery, canView: true }).reason, noDelivery.reason);
});

test("writing accepts EITHER customers.manage OR create_orders, exactly like the RPC", () => {
  const base = { deliveryAccess: allow, canView: true, online: true, saving: false };
  assert.equal(customerWriteGate({ ...base, canManageCustomers: true, canCreateOrders: false }).allowed, true);
  assert.equal(customerWriteGate({ ...base, canManageCustomers: false, canCreateOrders: true }).allowed, true);
  assert.equal(customerWriteGate({ ...base, canManageCustomers: false, canCreateOrders: false }).allowed, false);
});

test("writing is refused offline and while a save is in flight", () => {
  const base = { deliveryAccess: allow, canView: true, canManageCustomers: true, canCreateOrders: true };
  assert.match(customerWriteGate({ ...base, online: false, saving: false }).reason ?? "", /needs a connection/i);
  assert.match(customerWriteGate({ ...base, online: true, saving: true }).reason ?? "", /already being saved/i);
});

test("a write refusal reports the lookup problem first, in the server's order", () => {
  const gate = customerWriteGate({
    deliveryAccess: allow,
    canView: false,
    canManageCustomers: true,
    canCreateOrders: true,
    online: true,
    saving: false,
  });
  assert.match(gate.reason ?? "", /permission to view customers/i);
});

// --- the create decision -----------------------------------------------------

test("an empty query creates nothing", () => {
  assert.deepEqual(decideCreate({ query: "   ", candidates: [] }), {
    kind: "refused",
    reason: "Enter a customer name or phone number.",
  });
});

test("a name-only query NEVER offers to create", () => {
  const d = decideCreate({ query: "ahmad", candidates: [] });
  assert.equal(d.kind, "refused");
  assert.match(d.kind === "refused" ? d.reason : "", /Enter a phone number/i);
});

test("an unnormalisable phone-like query is refused rather than stored raw", () => {
  const d = decideCreate({ query: "312345", candidates: [] });
  assert.equal(d.kind, "refused");
  assert.match(d.kind === "refused" ? d.reason : "", /not valid/i);
});

test("a genuinely new number may be created, and the RAW form is carried forward", () => {
  const d = decideCreate({ query: "03 123 456", candidates: [] });
  assert.deepEqual(d, { kind: "create", phone: "03 123 456" });
});

test("an unrelated candidate does not block a create", () => {
  const d = decideCreate({ query: "03123456", candidates: [match({ id: "x", phone: "03999999", phone_e164: "+9613999999" })] });
  assert.equal(d.kind, "create");
});

test("THE RULE: a differently-typed existing number selects instead of inserting", () => {
  const existing = match({ id: "c9", phone: "+961 3 123 456", phone_e164: "+9613123456" });
  const d = decideCreate({ query: "03123456", candidates: [existing] });
  assert.deepEqual(d, { kind: "select", candidate: existing });
});

test("every equivalent typing of an existing number resolves to select", () => {
  const existing = match({ id: "c9", phone: "03123456", phone_e164: "+9613123456" });
  for (const typed of ["03123456", "03 123 456", "+9613123456", "009613123456", "+961 03 123456", "(03)123-456"]) {
    const d = decideCreate({ query: typed, candidates: [existing] });
    assert.equal(d.kind, "select", `"${typed}" should have selected the existing customer`);
  }
});

test("a row written before phone_e164 existed still participates, via its raw phone", () => {
  const legacy = match({ id: "old", phone: "03 123 456", phone_e164: null });
  const d = decideCreate({ query: "+9613123456", candidates: [legacy] });
  assert.deepEqual(d, { kind: "select", candidate: legacy });
});

test("two equivalent rows are handed back to the operator, never guessed between", () => {
  const a = match({ id: "a", phone: "03123456", phone_e164: "+9613123456" });
  const b = match({ id: "b", phone: "+9613123456", phone_e164: "+9613123456" });
  const d = decideCreate({ query: "03123456", candidates: [a, b] });
  assert.equal(d.kind, "choose");
  assert.deepEqual(d.kind === "choose" ? d.candidates.map((c) => c.id) : [], ["a", "b"]);
});

test("a candidate whose phone cannot be normalised is not treated as a match", () => {
  const junk = match({ id: "j", phone: "call the shop", phone_e164: null });
  assert.equal(decideCreate({ query: "03123456", candidates: [junk] }).kind, "create");
});
