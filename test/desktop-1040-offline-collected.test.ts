// 1.0.40 (BUG 01 / BUG 06, offline leg) — the production pos_table_map carries no `collected`; the cached
// canonical bill does (loadTableBill reads the PAID split settlements). The offline projection must take
// it, so an offline Pay after an ONLINE split never asks for money the server already holds.
import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? (this.m.get(k) as string) : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
(globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage();

import { projectTableBill } from "@/lib/offline/operationalProjection";
import type { TableBill, TableSummary } from "@/types/tables";

const occupied = (over: Partial<TableSummary> = {}): TableSummary =>
  ({ id: "TBL-1", name: "green", seats: 4, occupied: true, status: "occupied", canonical: true, configured: true, sort_order: 1, orders: 1, order_number: "261105-0003", opened_at: null, total: 35.5, collected: null, outstanding: null, currency: "USD", mixed_currency: false, pos_entity_version: 1, ...over }) as TableSummary;

const bill = (collected: number | undefined): TableBill => ({
  tableId: "TBL-1",
  orders: [{ id: "ORD-A", order_number: "261105-0003", status: "sent_to_kitchen", payment_status: "unpaid", pos_entity_version: 1, shift_id: "S1", branch_id: "b1", tenant_id: "t1", subtotal: 35.5, discount_amount: 0, total_amount: 35.5, currency: "USD", exchange_rate: null, created_at: new Date().toISOString(), collected, lines: [{ id: "L1", menu_item_id: "m", name: "Chicken Sub", quantity: 1, base_price: 35.5, modifiers_total: 0, final_unit_price: 35.5, line_total: 35.5, kitchen_note: null, batch_no: 1, modifiers: [] }] }],
  subtotal: 35.5, total: 35.5, currency: "USD", mixedCurrency: false, splitShift: false, batches: [1],
});

test("prod map without `collected` + cached bill that read a paid $21 split → the offline projection holds collected 21", () => {
  const p = projectTableBill({ tableId: "TBL-1", mapRow: occupied(), canonical: { bill: bill(21), fetchedAt: Date.now() }, draft: null, ops: [] });
  assert.equal((p as unknown as { collected: number }).collected, 21);
});

test("staging map WITH `collected` is still honoured (no double count: the larger figure, not the sum)", () => {
  const p = projectTableBill({ tableId: "TBL-1", mapRow: occupied({ collected: 21, outstanding: 14.5 }), canonical: { bill: bill(21), fetchedAt: Date.now() }, draft: null, ops: [] });
  assert.equal((p as unknown as { collected: number }).collected, 21);
});

test("a cached bill from a pre-1.0.40 build (no collected field) behaves exactly as 1.0.39", () => {
  const p = projectTableBill({ tableId: "TBL-1", mapRow: occupied(), canonical: { bill: bill(undefined), fetchedAt: Date.now() }, draft: null, ops: [] });
  assert.equal((p as unknown as { collected: number }).collected, 0);
});
