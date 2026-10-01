// Phase 1 (Desktop 1.0.31): customer display precedence — name -> phone -> fallback.
//
// The behaviour lives in ONE helper, `customerDisplayName`, and the proofs below
// are (1) the helper's precedence and whitespace handling, and (2) static reads
// that every customer-identity renderer the deep audit found now routes through
// it. The product rule: a customer with a real name NEVER shows a generic
// placeholder, and a phone-only customer is identified by their phone instead of
// an unhelpful "Unnamed"/"Customer" label. Each call site keeps its OWN fallback
// literal (so wording never drifts); the helper only fixes the precedence.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { customerDisplayName } from "@/lib/pos/customerDisplay";
import { stripJsxComments } from "./source-helpers.ts";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (...p: string[]) => readFileSync(join(srcRoot, ...p), "utf8");

// --- A–F. the helper precedence ---------------------------------------------

test("A a name wins over a phone", () => {
  assert.equal(customerDisplayName("Ali", "03123456", "Fallback"), "Ali");
});

test("B a name-only customer shows the name", () => {
  assert.equal(customerDisplayName("Ali", null, "Fallback"), "Ali");
});

test("C a phone-only customer shows the phone, never the fallback", () => {
  assert.equal(customerDisplayName(null, "03123456", "Fallback"), "03123456");
  assert.equal(customerDisplayName("", "03123456", "Fallback"), "03123456");
  assert.equal(customerDisplayName(undefined, "03123456", "Fallback"), "03123456");
});

test("D neither present shows the caller's own fallback literal, unchanged", () => {
  assert.equal(customerDisplayName(null, null, "Unnamed customer"), "Unnamed customer");
  assert.equal(customerDisplayName("  ", "  ", "Customer"), "Customer");
  assert.equal(customerDisplayName(undefined, undefined, "—"), "—");
});

test("E a whitespace-only name falls through to the phone", () => {
  assert.equal(customerDisplayName("   ", "03123456", "Fallback"), "03123456");
});

test("F a real name/phone is trimmed, not shown with its padding", () => {
  assert.equal(customerDisplayName("  Ali  ", null, "Fallback"), "Ali");
  assert.equal(customerDisplayName(null, "  03123456  ", "Fallback"), "03123456");
});

// --- G. every identified renderer routes through the shared helper ----------

const RENDERERS: string[][] = [
  ["screens", "CustomerAccounts.tsx"],
  ["components", "pos", "CustomerSearch.tsx"],
  ["components", "pos", "CustomerCard.tsx"],
  ["components", "pos", "PaymentDialog.tsx"],
  ["components", "pos", "DeliveryOrderDetail.tsx"],
  ["components", "pos", "DeliveryOrderQueue.tsx"],
  ["components", "pos", "DeliveryOrderSummary.tsx"],
  ["components", "pos", "CustomerDialogs.tsx"],
  ["screens", "pos", "DeliveryWorkspace.tsx"],
];

test("G every customer-identity renderer imports and uses the shared helper", () => {
  for (const p of RENDERERS) {
    const code = stripJsxComments(read(...p));
    assert.match(code, /from "@\/lib\/pos\/customerDisplay"/, `${p.join("/")} should import the helper`);
    assert.match(code, /customerDisplayName\(/, `${p.join("/")} should call the helper`);
  }
});

// --- H. the old name-only identity patterns that SKIPPED the phone are gone --

test("H no renderer still shows a bare name-only identity that skips the phone", () => {
  // The generic literals must survive ONLY as the helper's third argument, never
  // as the second operand of a bare ||/?? that never consults the phone.
  const gone: Array<[string[], RegExp, string]> = [
    [["screens", "CustomerAccounts.tsx"], /\.name\s*\|\|\s*"Unnamed customer"/, "CustomerAccounts name||Unnamed"],
    [["screens", "CustomerAccounts.tsx"], /customerName\s*\|\|\s*"—"/, "CustomerAccounts collection ||—"],
    [["components", "pos", "CustomerSearch.tsx"], /\.name\s*\|\|\s*"Unnamed customer"/, "CustomerSearch name||Unnamed"],
    [["components", "pos", "CustomerCard.tsx"], /\.name\s*\|\|\s*"New customer"/, "CustomerCard name||New"],
    [["components", "pos", "DeliveryOrderDetail.tsx"], /party\.customerName\s*\?\?\s*"Customer"/, "DeliveryOrderDetail ??Customer"],
    [["components", "pos", "DeliveryOrderQueue.tsx"], /party\.customerName\s*\?\?\s*"Customer"/, "DeliveryOrderQueue ??Customer"],
  ];
  for (const [p, re, label] of gone) {
    const code = stripJsxComments(read(...p));
    assert.equal(re.test(code), false, `${label} should be gone`);
  }
});

// --- I. preservation: the privacy-scoped printed ticket is NOT changed -------

test("I the collection ticket still carries the NAME only (never the phone)", () => {
  // collectionTicket.ts intentionally excludes the phone from a hand-over paper
  // ticket. Phase 1 must not fold the phone into its customerName.
  const code = stripJsxComments(read("lib", "pos", "collectionTicket.ts"));
  assert.match(code, /input\.source === "delivery" \? \(input\.customerName \?\? null\) : null/);
  assert.equal(code.includes("customerDisplayName"), false);
});
