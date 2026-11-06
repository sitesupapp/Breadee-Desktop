// Desktop 1.0.40 — BUG 01 native follow-up: the OUTSIDE table card (and the Open Tables list) showed the
// gross total of a bill already part paid by split (PDF Bug #25: "Outside table card still shows
// 1,483,200 LBP"). The card now shows what is still DUE. Production's `pos_table_map` reports no
// `collected`, so the desktop derives a DISPLAY-ONLY `paid_by_split` with one branch-wide read of the
// open dine-in orders' PAID split settlements. Money paths never read `paid_by_split`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { readMapPaidBySplit, tableCardAmount, type PaidSettlementRead } from "@/lib/pos/tableBill";
import { runSyncNow, syncNowText } from "@/lib/offline/syncActions";
import type { TableMap, TableSummary } from "@/types/tables";

const T = (over: Partial<TableSummary>): TableSummary => ({
  id: "t1",
  name: "QA-01",
  seats: null,
  occupied: true,
  status: "occupied",
  canonical: true,
  configured: true,
  sort_order: 1,
  orders: 1,
  order_number: "261106-0001",
  opened_at: null,
  total: 300000,
  collected: null,
  outstanding: null,
  currency: "LBP",
  mixed_currency: false,
  merged_sources: [],
  pos_entity_version: 1,
  ...over,
});
const MAP = (tables: TableSummary[]): TableMap => ({ tables, total: tables.length, occupied: tables.length, available: 0, configured: tables.length, legacy_hidden: 0 });
const CTX = { tenantId: "ten", branchId: "br" };

test("BUG 02 native: table-operation refusals (merge partial_line remedy) wrap and are announced, never clipped", () => {
  const src = readFileSync("src/components/pos/TableOpsDialogs.tsx", "utf8");
  assert.equal(/className="truncate[^"]*text-(red|amber)-(7|8)00"/.test(src), false, "no clipped error / gate paragraph remains");
  assert.equal((src.match(/role="alert" className="break-words text-xs font-semibold text-red-700"/g) ?? []).length, 4, "Move, Close, Clear and Merge");
});

test("BUG 09 native: payment / seat / transfer / edit-reason dialog refusals wrap instead of being clipped", () => {
  for (const f of ["PaymentDialog", "SeatCountDialog", "TransferDialog", "EditReasonDialog"]) {
    const src = readFileSync(`src/components/pos/${f}.tsx`, "utf8");
    assert.equal(/className="truncate[^"]*text-(red|amber)-(7|8)00"/.test(src), false, `${f}: no clipped error / gate paragraph`);
  }
  assert.match(readFileSync("src/components/pos/PaymentDialog.tsx", "utf8"), /role="alert" className="break-words text-xs font-semibold text-red-700">\{props\.error\}/);
});

test("BUG 01 native: the card, the Open Tables list and the Add-items header use the due amount", () => {
  assert.match(readFileSync("src/components/pos/TableCard.tsx", "utf8"), /tableCardAmount\(table\)/);
  assert.match(readFileSync("src/components/pos/OpenTablesModal.tsx", "utf8"), /Part paid/);
  assert.match(readFileSync("src/components/pos/DineInRoundPanel.tsx", "utf8"), /billDue\(bill\)/);
  assert.match(readFileSync("src/state/tables.ts", "utf8"), /readMapPaidBySplit\(map, ctx\)/);
});

test("BUG 03 native: Sync now never reports fewer items needing attention than are waiting for review", async () => {
  const pass = { synced: 0, needsAttention: 0, failed: 0, waiting: 0 };
  assert.equal(syncNowText(pass), "Sync finished: 0 synced · 0 still need attention · 0 failed (will retry).");
  assert.equal(syncNowText(pass, 2), "Sync finished: 0 synced · 2 still need attention · 0 failed (will retry).");
  assert.equal(syncNowText({ ...pass, needsAttention: 3 }, 2), "Sync finished: 0 synced · 3 still need attention · 0 failed (will retry).");
  assert.equal(syncNowText({ ...pass, synced: 1 }, 1), "Sync finished: 1 synced · 1 still needs attention · 0 failed (will retry).");
  const report = { executed: true, startedAt: "9999-01-01T00:00:00Z", drained: [], needsAttention: [], retryable: [], skippedBackoff: [], blocked: [] };
  const r = await runSyncNow(async () => 1, () => report as never, async () => 2);
  assert.equal(r.ran, true);
  assert.match(r.text, /0 synced · 2 still need attention/);
  const failing = await runSyncNow(async () => 1, () => report as never, async () => {
    throw new Error("db");
  });
  assert.match(failing.text, /0 still need attention/, "a failed standing read never breaks the report");
});

test("card amount: an unpaid bill shows exactly the server total (unchanged)", () => {
  assert.deepEqual(tableCardAmount(T({ collected: null })), { amount: 300000, partPaid: false });
  assert.deepEqual(tableCardAmount(T({ collected: 0 })), { amount: 300000, partPaid: false });
});

test("card amount: part paid shows DUE = total − paid (server collected first, else paid_by_split)", () => {
  assert.deepEqual(tableCardAmount(T({ collected: 100000 })), { amount: 200000, partPaid: true });
  assert.deepEqual(tableCardAmount(T({ collected: null, paid_by_split: 100000 })), { amount: 200000, partPaid: true });
  // the server's own figure wins over the derived one
  assert.deepEqual(tableCardAmount(T({ collected: 50000, paid_by_split: 100000 })), { amount: 250000, partPaid: true });
  // PDF Bug #25 numbers
  assert.deepEqual(tableCardAmount(T({ total: 1483200, paid_by_split: 1169100 })), { amount: 314100, partPaid: true });
});

test("card amount: a mixed-currency bill (no total) stays absent, never a number", () => {
  assert.deepEqual(tableCardAmount(T({ total: null, mixed_currency: true, paid_by_split: 5 })), { amount: null, partPaid: false });
});

test("paid_by_split: one branch-wide read; sums PAID settlements per table; leaves the rest untouched", async () => {
  const map = MAP([T({ id: "t1" }), T({ id: "t2", total: 50000 }), T({ id: "t3", orders: 0, total: null, occupied: false })]);
  let ordersCalls = 0;
  let settlementIds: string[] = [];
  const out = await readMapPaidBySplit(map, CTX, {
    readOrders: async (ids) => {
      ordersCalls += 1;
      assert.deepEqual(ids, ["t1", "t2"]);
      return [
        { id: "o1", table_id: "t1" },
        { id: "o2", table_id: "t2" },
      ];
    },
    readSettlements: async (ids): Promise<PaidSettlementRead> => {
      settlementIds = ids;
      return {
        ok: true,
        rows: [
          { id: "s1", parent_order_id: "o1", status: "paid", amount_order_ccy: 60000 },
          { id: "s2", parent_order_id: "o1", status: "paid", amount_order_ccy: 40000 },
          { id: "s3", parent_order_id: "o2", status: "void", amount_order_ccy: 50000 },
        ],
      };
    },
  });
  assert.equal(ordersCalls, 1);
  assert.deepEqual(settlementIds, ["o1", "o2"]);
  assert.equal(out.tables[0].paid_by_split, 100000);
  assert.equal(tableCardAmount(out.tables[0]).amount, 200000);
  assert.equal(out.tables[1].paid_by_split, undefined, "a non-paid settlement never counts");
  assert.equal(out.tables[2].paid_by_split, undefined);
  // money inputs untouched
  assert.equal(out.tables[0].collected, null);
  assert.equal(out.tables[0].total, 300000);
});

test("paid_by_split: skipped entirely when the server map already reports collected (staging)", async () => {
  const map = MAP([T({ collected: 100000 }), T({ id: "t2", collected: 0 })]);
  const out = await readMapPaidBySplit(map, CTX, {
    readOrders: async () => assert.fail("no read when the server reports collected"),
  });
  assert.equal(out, map);
});

test("paid_by_split: any failure returns the map unchanged (card shows the gross total as before)", async () => {
  const map = MAP([T({})]);
  assert.equal(await readMapPaidBySplit(map, CTX, { readOrders: async () => null }), map);
  assert.equal(
    await readMapPaidBySplit(map, CTX, { readOrders: async () => [{ id: "o1", table_id: "t1" }], readSettlements: async () => ({ ok: false }) }),
    map,
  );
  assert.equal(
    await readMapPaidBySplit(map, CTX, {
      readOrders: async () => {
        throw new Error("network");
      },
    }),
    map,
  );
  assert.equal(await readMapPaidBySplit(map, { tenantId: null, branchId: "br" }), map);
});
