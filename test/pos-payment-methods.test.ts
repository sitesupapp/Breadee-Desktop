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
import { paymentLabel } from "@/lib/pos/orderActions";
import type { ShiftOpenOrder } from "@/lib/pos/shiftOrderSummary";

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

test("receipt: friendly label via catalog; NEVER null-defaults to cash; empty method → plain Paid (D2)", () => {
  const rp = read("screens/pos/ReceiptPreview.tsx");
  // resolves stored key -> label via the synchronized catalog, with NO "cash" default
  assert.match(rp, /const methodLabel = paymentMethodLabel\(catalog, data\.method\);/);
  // the old `data.method ? ... : "cash"` default that mislabelled non-cash tenders is gone
  assert.doesNotMatch(rp, /paymentMethodLabel\(catalog, data\.method\) : "cash"/);
  // paid renders the label, or a plain "Paid" when there is genuinely no method (never "cash")
  assert.match(rp, /methodLabel[\s\S]*?`Paid - \$\{methodLabel\}`[\s\S]*?"Paid"/);
  assert.match(rp, /methodLabel[\s\S]*?`Partial - \$\{methodLabel\}`[\s\S]*?"Partial"/);
  // the printed doc carries the resolved label, not the raw key
  assert.match(rp, /method: data\.method \? paymentMethodLabel\(catalog, data\.method\) : data\.method/);
});

test("reprint (D2 root cause): both reprint builders carry the STORED method key, not null/cash", () => {
  const cop = read("components/pos/CurrentOrderPanel.tsx");
  // The order-summary reprint carries the order's stored key (resolved to a label at display),
  // replacing the `method: null` that fell back to "cash".
  assert.match(cop, /method: order\.payment_method \?\? null/);
  // status chip resolves the label from the catalog
  assert.match(cop, /paymentLabel\(order, catalog\)/);

  const pw = read("screens/pos/PosWorkspace.tsx");
  // The Orders/Delivery-modal shared reprint path carries the stored key too.
  assert.match(pw, /method: order\.payment_method \?\? null/);
});

test("status chip (D3): paid method resolves to the friendly label; key preserved; never cash", () => {
  type PayPick = Pick<ShiftOpenOrder, "payment_status" | "payment_method">;
  const ord = (status: PayPick["payment_status"], method: string | null): PayPick => ({
    payment_status: status,
    payment_method: method,
  });
  assert.equal(paymentLabel(ord("paid", "whish"), catalog), "paid · Whish");
  assert.equal(paymentLabel(ord("paid", "card"), catalog), "paid · Card");
  assert.equal(paymentLabel(ord("paid", "cash"), catalog), "paid · Cash");
  // inactive/renamed method still resolves for a historical order (E)
  assert.equal(paymentLabel(ord("paid", "old_wallet"), catalog), "paid · Old Wallet");
  // unknown key falls back to the readable key, NEVER to cash (F)
  assert.equal(paymentLabel(ord("paid", "gone_method"), catalog), "paid · gone_method");
  // no catalog available → raw readable key, never cash
  assert.equal(paymentLabel(ord("paid", "whish")), "paid · whish");
  // no method / non-paid states unchanged
  assert.equal(paymentLabel(ord("paid", null), catalog), "paid");
  assert.equal(paymentLabel(ord("unpaid", null), catalog), "unpaid");
  assert.equal(paymentLabel(ord("refunded", "card"), catalog), "refunded");
});

test("financial invariant (H): the submitted/stored method is the stable key, unchanged by display", () => {
  // PaymentDialog value IS the stable key (activePaymentChoices maps m.key -> value)
  const pm = read("lib/pos/paymentMethods.ts");
  assert.match(pm, /value: m\.key, label: m\.label/);
  // the display helper never writes back to the stored field
  const oa = read("lib/pos/orderActions.ts");
  assert.doesNotMatch(oa, /payment_method\s*=[^=]/);
});

test("payment review + delivery detail (D3): POS history surfaces resolve labels via the catalog", () => {
  const ca = read("screens/CustomerAccounts.tsx");
  const hits = ca.split("paymentMethodLabel(useSession.getState().paymentMethods").length - 1;
  assert.ok(hits >= 2, `both payment-review spots resolve the label (found ${hits})`);
  const dod = read("components/pos/DeliveryOrderDetail.tsx");
  assert.match(dod, /paymentMethodLabel\(useSession\.getState\(\)\.paymentMethods, o\.payment_method\)/);
  assert.doesNotMatch(dod, /value=\{o\.payment_method\}/); // raw key no longer rendered
});

test("order lists (D3): Orders + Delivery modals resolve the chip label via the catalog", () => {
  for (const rel of ["components/pos/OrdersModal.tsx", "components/pos/DeliveryModal.tsx"]) {
    const src = read(rel);
    assert.match(src, /paymentLabel\(o, useSession\.getState\(\)\.paymentMethods\)/);
  }
});
