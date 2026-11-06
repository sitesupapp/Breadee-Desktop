// Desktop 1.0.40 (BUG 08) — payout -> Web Accounting (opt-in, backend-advertised contract).
//
// Pins the request shape: WITHOUT the contract the payload is byte-identical to 1.0.39 (no new keys);
// WITH it, only an EXPENSE payout carries post_to_accounting, and a new petty-cash expense sends
// source_id = null + new_expense. Every other source keeps its drawer-only treatment.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { buildPayoutCreatePayload } from "@/lib/pos/payouts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p: string[]) => readFileSync(join(here, "..", "src", ...p), "utf8");
const base = { shiftId: "s1", amount: 100, note: " gas ", clientOpId: "op1" } as const;

test("08-1 without the contract the payload is exactly the 1.0.39 shape", () => {
  const p = buildPayoutCreatePayload({ ...base, sourceType: "expense", sourceId: "e1" });
  assert.deepEqual(p, { shift_id: "s1", amount: 100, source_type: "expense", source_id: "e1", note: "gas", client_op_id: "op1" });
  const q = buildPayoutCreatePayload({ ...base, sourceType: "expense", sourceId: "e1", postToAccounting: false });
  assert.deepEqual(Object.keys(q).sort(), ["amount", "client_op_id", "note", "shift_id", "source_id", "source_type"]);
});

test("08-2 an existing-expense payout settles it from drawer cash (no new expense)", () => {
  const p = buildPayoutCreatePayload({ ...base, sourceType: "expense", sourceId: "e1", postToAccounting: true });
  assert.equal(p.post_to_accounting, true);
  assert.equal(p.source_id, "e1");
  assert.equal(p.new_expense, undefined);
});

test("08-3 a new petty-cash expense sends source_id null + the trimmed expense", () => {
  const p = buildPayoutCreatePayload({
    ...base, sourceType: "expense", sourceId: "ignored", postToAccounting: true,
    newExpense: { categoryId: "c1", description: "  Gas for generator ", payee: "  " },
  });
  assert.equal(p.source_id, null);
  assert.deepEqual(p.new_expense, { category_id: "c1", description: "Gas for generator", payee: null });
});

test("08-4 non-expense payouts never carry the accounting contract", () => {
  for (const t of ["purchase_invoice", "supplier_payment", "maintenance_job"] as const) {
    const p = buildPayoutCreatePayload({ ...base, sourceType: t, sourceId: "x", postToAccounting: true, newExpense: { categoryId: "c", description: "d", payee: null } });
    assert.equal(p.post_to_accounting, undefined, t);
    assert.equal(p.new_expense, undefined, t);
    assert.equal(p.source_id, "x", t);
  }
});

test("08-5 the UI only offers the new flow when the backend advertises it; offline replay forwards the flag", () => {
  const modal = read("components", "pos", "PayoutsModal.tsx");
  assert.match(modal, /loadPayoutAccountingCapability\(\)/);
  assert.match(modal, /kind === "expense" && accounting && online/);
  const handlers = read("lib", "offline", "handlers.ts");
  assert.match(handlers, /p\.post_to_accounting === true \? \{ postToAccounting: true \}/);
  const capture = read("lib", "offline", "payoutOffline.ts");
  assert.match(capture, /input\.postToAccounting === true && proof\.source_type === "expense"/);
});
