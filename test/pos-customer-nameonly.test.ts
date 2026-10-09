// R6 (1.0.35): Desktop customer creation is not limited to phone.
//
// The delivery create surface now passes `allowNameOnly: true` to `decideCreate`
// and `buildCreatePayload` (matching the on-account picker, which already did).
// These tests pin the decision + payload rules the changed call sites rely on:
// name-only / phone-only / name+phone / both-blank / invalid-phone, that the
// phone-first duplicate rule is unchanged, and that name-only stays OPT-IN (the
// default still refuses a name-only create, so no other caller changed).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildCreatePayload,
  decideCreate,
  InvalidPhoneError,
  type CustomerMatch,
} from "@/lib/pos/customers";

const match = (over: Partial<CustomerMatch> = {}): CustomerMatch => ({
  id: "c1",
  name: "Ahmad",
  phone: "03123456",
  phone_e164: "+9613123456",
  ...over,
});

// --- decideCreate: name-only is opt-in --------------------------------------

test("default (no allowNameOnly) still REFUSES a name-only create", () => {
  const d = decideCreate({ query: "Ahmad", candidates: [] });
  assert.equal(d.kind, "refused");
});

test("allowNameOnly: a name term offers a name-only create", () => {
  const d = decideCreate({ query: "Ahmad", candidates: [], allowNameOnly: true });
  assert.equal(d.kind, "create");
  assert.equal(d.kind === "create" ? d.name : null, "Ahmad");
  assert.equal(d.kind === "create" ? d.phone : "x", undefined);
});

test("allowNameOnly: a name is NOT auto-merged onto a same-name customer (intended duplicates)", () => {
  const d = decideCreate({ query: "Ahmad", candidates: [match({ id: "existing", name: "Ahmad" })], allowNameOnly: true });
  assert.equal(d.kind, "create");
  assert.equal(d.kind === "create" ? d.name : null, "Ahmad");
});

test("allowNameOnly does NOT change the phone-first rule: an existing number still selects", () => {
  const d = decideCreate({ query: "03123456", candidates: [match()], allowNameOnly: true });
  assert.equal(d.kind, "select");
});

test("allowNameOnly: a genuinely new phone still offers a phone create", () => {
  const d = decideCreate({ query: "03999999", candidates: [], allowNameOnly: true });
  assert.equal(d.kind, "create");
  assert.equal(d.kind === "create" ? d.phone : null, "03999999");
});

test("an empty term is refused even with allowNameOnly", () => {
  assert.equal(decideCreate({ query: "   ", candidates: [], allowNameOnly: true }).kind, "refused");
});

// --- buildCreatePayload: the three valid shapes + the two refusals ----------

test("name-only payload carries the name and allow_name_only, and no phone", () => {
  const p = buildCreatePayload({ branchId: "b1", name: "Ahmad", allowNameOnly: true });
  assert.equal(p.name, "Ahmad");
  assert.equal(p.allow_name_only, true);
  assert.equal(p.phone, undefined);
  assert.equal(p.branch_id, "b1");
});

test("phone-only payload carries the raw phone and NOT allow_name_only", () => {
  const p = buildCreatePayload({ branchId: "b1", phone: "03123456", allowNameOnly: true });
  assert.equal(p.phone, "03123456");
  assert.equal(p.allow_name_only, undefined);
});

test("name+phone payload carries both; allow_name_only is not needed", () => {
  const p = buildCreatePayload({ branchId: "b1", phone: "03123456", name: "Ahmad", allowNameOnly: true });
  assert.equal(p.phone, "03123456");
  assert.equal(p.name, "Ahmad");
  assert.equal(p.allow_name_only, undefined);
});

test("both blank is refused even with allowNameOnly", () => {
  assert.throws(() => buildCreatePayload({ branchId: "b1", allowNameOnly: true }), InvalidPhoneError);
});

test("a non-empty but invalid phone is still refused with allowNameOnly", () => {
  assert.throws(() => buildCreatePayload({ branchId: "b1", phone: "12", name: "Ahmad", allowNameOnly: true }), InvalidPhoneError);
});

test("name-only WITHOUT allowNameOnly is refused (the gate holds for other callers)", () => {
  assert.throws(() => buildCreatePayload({ branchId: "b1", name: "Ahmad" }), InvalidPhoneError);
});
