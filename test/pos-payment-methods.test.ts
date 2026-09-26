// Phase B — dynamic payment methods (Desktop).
//
// Unit-tests the pure catalog helpers (active filter, deterministic order, stable-key vs
// label, cash-only fallback, historical label resolution) and source-asserts the wiring
// (PaymentDialog consumes the synchronized catalog; the session caches it; the method key
// is a dynamic string). The project has no DOM test library, so UI wiring is asserted
// against source exactly like floor-service-source.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { activePaymentChoices, paymentMethodLabel, type PaymentMethodDef } from "@/lib/pos/paymentMethods";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (rel: string) => readFileSync(join(srcRoot, rel), "utf8");

const catalog: PaymentMethodDef[] = [
  { key: "cash", label: "Cash", is_cash: true, is_active: true, sort_order: 0 },
  { key: "card", label: "Card", is_cash: false, is_active: true, sort_order: 1 },
  { key: "whish", label: "Whish", is_cash: false, is_active: true, sort_order: 4 },
  { key: "old_wallet", label: "Old Wallet", is_cash: false, is_active: false, sort_order: 5 },
];

test("activePaymentChoices: active only, ordered by sort_order, stable key as value + label display", () => {
  const c = activePaymentChoices(catalog);
  assert.deepEqual(c.map((x) => x.value), ["cash", "card", "whish"]); // inactive old_wallet hidden
  assert.deepEqual(c.find((x) => x.value === "whish"), { value: "whish", label: "Whish" });
});

test("activePaymentChoices: sort_order ties break deterministically by label", () => {
  const c = activePaymentChoices([
    { key: "b", label: "Bravo", is_cash: false, is_active: true, sort_order: 1 },
    { key: "a", label: "Alpha", is_cash: false, is_active: true, sort_order: 1 },
  ]);
  assert.deepEqual(c.map((x) => x.label), ["Alpha", "Bravo"]);
});

test("activePaymentChoices: empty / all-inactive / null → cash-only fallback (offline-safe)", () => {
  const cashOnly = [{ value: "cash", label: "Cash" }];
  assert.deepEqual(activePaymentChoices([]), cashOnly);
  assert.deepEqual(activePaymentChoices(null), cashOnly);
  assert.deepEqual(
    activePaymentChoices([{ key: "x", label: "X", is_cash: false, is_active: false, sort_order: 1 }]),
    cashOnly,
  );
});

test("paymentMethodLabel: resolves active + inactive (renamed/deactivated), falls back to key not a UUID", () => {
  assert.equal(paymentMethodLabel(catalog, "whish"), "Whish");
  assert.equal(paymentMethodLabel(catalog, "old_wallet"), "Old Wallet"); // historical row still readable
  assert.equal(paymentMethodLabel(catalog, "gone_method"), "gone_method"); // slug fallback, never a UUID
  assert.equal(paymentMethodLabel(catalog, null), "");
});

test("wiring: PaymentDialog renders the synchronized catalog, not a hard-coded method list", () => {
  const dlg = read("components/pos/PaymentDialog.tsx");
  assert.match(dlg, /useSession\(\(s\) => s\.paymentMethods\)/);
  assert.match(dlg, /activePaymentChoices\(catalog\)/);
  assert.match(dlg, /methodChoices\.map/);
  assert.doesNotMatch(dlg, /PAYMENT_METHODS\.map/); // selection is never driven by the fallback constant
});

test("wiring: session caches the tenant catalog (offline) and clears it on sign-out", () => {
  const s = read("state/session.ts");
  assert.match(s, /from\("pos_payment_methods"\)/); // RLS-scoped fetch at login
  assert.match(s, /paymentMethods: PaymentMethodDef\[\]/); // typed in state + cache
  assert.match(s, /paymentMethods: \[\]/); // reset on signOut / initial
});

test("wiring: PaymentMethod is a dynamic stable-key string; cash remains the fallback", () => {
  const p = read("lib/pos/payments.ts");
  assert.match(p, /export type PaymentMethod = string;/);
  assert.match(p, /value: "cash", label: "Cash"/);
});
