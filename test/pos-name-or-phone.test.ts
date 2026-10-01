// Phase 3 (Desktop 1.0.31): name-OR-phone customer creation for general A-R, with
// Delivery still phone-required.
//
// The server (_customer_capture) keeps phone REQUIRED by default and only permits a
// name-only create when the payload carries allow_name_only=true. On the client, the
// two shared choke points (decideCreate + buildCreatePayload) gain an opt-in; the
// A-R on-account picker sets it, delivery does not. These tests pin that split and
// the payload shape; both-blank is always refused.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  CUSTOMER_PAYLOAD_KEYS,
  FORBIDDEN_CUSTOMER_FIELDS,
  InvalidPhoneError,
  buildCreatePayload,
  decideCreate,
} from "@/lib/pos/customers";
import { stripJsxComments } from "./source-helpers.ts";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (...p: string[]) => readFileSync(join(srcRoot, ...p), "utf8");

// --- A. decideCreate: a NAME is creatable only when name-only is allowed ---

test("A a name query is REFUSED by default (delivery keeps phone-required)", () => {
  const d = decideCreate({ query: "Ahmad Saleh", candidates: [] });
  assert.equal(d.kind, "refused");
});

test("B a name query CREATES by name when allowNameOnly is set (general A-R)", () => {
  const d = decideCreate({ query: "Ahmad Saleh", candidates: [], allowNameOnly: true });
  assert.deepEqual(d, { kind: "create", name: "Ahmad Saleh" });
});

test("C an empty query is refused even when name-only is allowed", () => {
  assert.equal(decideCreate({ query: "   ", candidates: [], allowNameOnly: true }).kind, "refused");
});

test("D a phone query still creates by phone, name-only flag or not", () => {
  const a = decideCreate({ query: "03123456", candidates: [], allowNameOnly: true });
  const b = decideCreate({ query: "03123456", candidates: [] });
  assert.deepEqual(a, { kind: "create", phone: "03123456" });
  assert.deepEqual(b, { kind: "create", phone: "03123456" });
});

// --- B. buildCreatePayload: name-or-phone ---

test("E a phone create is unchanged and carries no allow_name_only", () => {
  const p = buildCreatePayload({ branchId: "b1", phone: "03 123 456", name: "Ali" });
  assert.equal(p.phone, "03 123 456");
  assert.equal(p.name, "Ali");
  assert.equal("allow_name_only" in p, false);
});

test("F a name-only create carries the name and allow_name_only, and no phone", () => {
  const p = buildCreatePayload({ branchId: "b1", name: "Ahmad Saleh", allowNameOnly: true });
  assert.equal(p.name, "Ahmad Saleh");
  assert.equal(p.allow_name_only, true);
  assert.equal("phone" in p, false);
});

test("G a name WITHOUT the allow flag is still refused (delivery default)", () => {
  assert.throws(() => buildCreatePayload({ branchId: "b1", name: "Ahmad Saleh" }), InvalidPhoneError);
});

test("H neither name nor phone is refused even with the flag", () => {
  assert.throws(() => buildCreatePayload({ branchId: "b1", allowNameOnly: true }), InvalidPhoneError);
  assert.throws(() => buildCreatePayload({ branchId: "b1", name: "   ", allowNameOnly: true }), InvalidPhoneError);
});

test("I an invalid phone is still refused even with the flag", () => {
  assert.throws(() => buildCreatePayload({ branchId: "b1", phone: "nope", allowNameOnly: true }), InvalidPhoneError);
});

test("J a name-only payload contains only allowed, non-forbidden keys", () => {
  const p = buildCreatePayload({ branchId: "b1", name: "Ahmad", allowNameOnly: true });
  for (const key of Object.keys(p)) {
    assert.ok(CUSTOMER_PAYLOAD_KEYS.includes(key as never), `unexpected key ${key}`);
    assert.ok(!FORBIDDEN_CUSTOMER_FIELDS.includes(key as never), `forbidden key ${key}`);
  }
  assert.ok(CUSTOMER_PAYLOAD_KEYS.includes("allow_name_only" as never));
});

// --- C. wiring: only the A-R picker opts in; delivery does not ---

test("K the A-R on-account picker opts into name-only; delivery does not", () => {
  const picker = stripJsxComments(read("state", "customerPicker.ts"));
  // The picker allows name-only in both the decision and the search surface.
  assert.match(picker, /decideCreate\(\{ query: term, candidates, allowNameOnly: true \}\)/);
  assert.match(picker, /allowNameOnly: true,/); // searchProps
  // And it carries the name into the create payload.
  assert.match(picker, /buildCreatePayload\(\{ branchId, phone: decision\.phone, name: decision\.name, allowNameOnly: true \}\)/);

  const delivery = stripJsxComments(read("screens", "pos", "DeliveryWorkspace.tsx"));
  // Delivery's decideCreate must NOT pass allowNameOnly (phone stays required there).
  assert.match(delivery, /decideCreate\(\{ query: term, candidates \}\)/);
  assert.equal(/decideCreate\([^)]*allowNameOnly/.test(delivery), false, "delivery must not enable name-only");
});

test("L the delivery customer form keeps its phone-required create gate", () => {
  const form = stripJsxComments(read("components", "pos", "CustomerDialogs.tsx"));
  // create-mode: a blank phone is not valid (unchanged by Phase 3).
  assert.match(form, /values\.phone\.trim\(\) === "" \? props\.mode === "edit" : normalized !== null/);
});

// --- D. soft duplicate-name warning is a non-blocking confirm (never auto-merge) ---

test("M the picker warns once on a duplicate name, then lets the operator continue", () => {
  const picker = stripJsxComments(read("state", "customerPicker.ts"));
  assert.match(picker, /already exists\. Tap "Find \/ create" again to add another\./);
  // It never merges or hard-blocks: it arms a confirm ref and returns, no upsert.
  assert.match(picker, /nameConfirmRef\.current = decision\.name/);
});
