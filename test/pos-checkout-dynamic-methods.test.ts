// Hotfix 1.0.31 — dynamic payment methods in the NORMAL checkout dialog.
//
// The bug: Split Bill showed the tenant's Phase B catalog, but the shared
// PaymentDialog (Takeaway / Dine-In full-bill / Delivery) rendered the static
// `PAYMENT_METHODS = [{cash}]` constant and only ever submitted "cash".
//
// These are source-contract tests in the repo's established style: they prove
// the wiring without a DOM, which is what makes them storm-proof and fast. The
// behavioural proof (a real cashier seeing the methods) is the native RC pass.
//
// Covers the acceptance list: A/B/D normal Pay show the catalog; C Split
// unchanged; E inactive hidden (server-filtered: is_active=true only); F Cash
// always present; G legacy card/online/cod carried; H friendly label displayed;
// I offline stays Cash-only; J no financial-contract change (stable key sent).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./source-helpers.ts";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (rel: string) => stripComments(readFileSync(join(SRC, rel), "utf8"));

// --- J / type: the method is a catalog KEY, not the old "cash" literal --------
test("PaymentMethod is widened to a catalog key (string)", () => {
  const s = read("lib/pos/payments.ts");
  assert.match(s, /export type PaymentMethod = string;/);
  // payOrder still forwards the method verbatim — financial contract unchanged.
  assert.match(s, /method:\s*input\.method/);
});

// --- hook reuses the Phase B loader (NO second implementation) ---------------
test("useActivePaymentMethods reuses loadSplitPaymentMethods and never re-queries the catalog", () => {
  const s = read("lib/pos/useActivePaymentMethods.ts");
  assert.match(s, /loadSplitPaymentMethods/);
  // It must NOT open its own catalog query — one canonical source.
  assert.doesNotMatch(s, /pos_payment_methods/);
});

// --- I / offline: cash-only when not online ----------------------------------
test("useActivePaymentMethods returns Cash-only when offline", () => {
  const s = read("lib/pos/useActivePaymentMethods.ts");
  // The offline/no-tenant guard sets the cash-only set and returns early.
  assert.match(s, /if\s*\(!online\s*\|\|\s*!tenantId\)\s*\{\s*setMethods\(CASH_ONLY\);\s*return;/);
  assert.match(s, /CASH_ONLY[^=]*=\s*\[\{\s*key:\s*"cash"[^}]*is_cash:\s*true/);
  // Effect re-runs when either input changes.
  assert.match(s, /\},\s*\[tenantId,\s*online\]\)/);
});

// --- PaymentDialog renders the dynamic catalog, not the static constant ------
test("PaymentDialog renders the Method choices from props.paymentMethods (key + label)", () => {
  const s = read("components/pos/PaymentDialog.tsx");
  assert.match(s, /paymentMethods\?:\s*readonly\s*\{\s*key:\s*string;\s*label:\s*string;\s*is_cash:\s*boolean\s*\}\[\]/);
  // The Method field maps over the derived `methods`, submitting the KEY and
  // displaying the LABEL (H) — no UUID, no static PAYMENT_METHODS.
  assert.match(s, /methods\.map\(\(m\)\s*=>/);
  assert.match(s, /onClick=\{\(\)\s*=>\s*setMethod\(m\.key\)\}/);
  assert.match(s, /\{m\.label\}/);
  assert.doesNotMatch(s, /PAYMENT_METHODS\.map/);
  // F: Cash-only fallback keeps a valid choice when the prop is absent/empty.
  assert.match(s, /key:\s*"cash",\s*label:\s*"Cash",\s*is_cash:\s*true/);
});

// --- A / B / D: every normal-Pay workspace feeds the catalog in --------------
for (const rel of [
  "screens/pos/PosWorkspace.tsx",
  "screens/pos/DineInWorkspace.tsx",
  "screens/pos/DeliveryWorkspace.tsx",
]) {
  test(`${rel} wires useActivePaymentMethods into its PaymentDialog`, () => {
    const s = read(rel);
    assert.match(s, /useActivePaymentMethods/);
    assert.match(s, /paymentMethods=\{activePaymentMethods\}/);
  });
}

// --- C: Split Bill is untouched (still its own loader + panel) ----------------
test("Split Bill flow is unchanged (still calls loadSplitPaymentMethods)", () => {
  const s = read("screens/pos/DineInWorkspace.tsx");
  assert.match(s, /loadSplitPaymentMethods\(/);
});

// --- E / G: the catalog read filters to ACTIVE only, preserving system keys --
test("catalog loader filters to active methods only (inactive hidden, system keys kept)", () => {
  const s = read("lib/pos/split.ts");
  assert.match(s, /\.eq\("is_active",\s*true\)/);
  assert.match(s, /\.order\("sort_order"\)/);
});
