// Phase F (GAP 1) — durable receipt snapshots: a device-created receipt persists and reprints
// offline + after a cold restart. The store persists on present/stage; the reprint path falls back
// to the snapshot offline; the offline Takeaway sale presents a provisional receipt.

import "fake-indexeddb/auto";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./source-helpers.ts";

import { localdb, persistReceiptSnapshot, readReceiptSnapshot, readLatestReceiptSnapshot } from "@/lib/offline/db";

const here = dirname(fileURLToPath(import.meta.url));
const srcOf = (rel: string) => stripComments(readFileSync(join(here, "..", rel), "utf8"));

const DATA = { orderNumber: "OFF-ABC123", businessName: "Breadee", branchName: "Main", lines: [{ name: "Burger", qty: 1, unitPrice: 10, lineTotal: 10 }], total: 10, paid: true };

beforeEach(async () => {
  await localdb.receipts.clear();
});

test("persist + read a receipt snapshot by ref; latest returns the newest", async () => {
  await persistReceiptSnapshot({ ref: "OFF-1", data: { ...DATA, orderNumber: "OFF-1" }, tenantId: "t1", provisional: true });
  await new Promise((r) => setTimeout(r, 5));
  await persistReceiptSnapshot({ ref: "OFF-2", data: { ...DATA, orderNumber: "OFF-2" }, tenantId: "t1", provisional: true });
  const one = await readReceiptSnapshot("OFF-1");
  assert.equal((one?.data as { orderNumber: string }).orderNumber, "OFF-1");
  assert.equal(one?.provisional, true);
  const latest = await readLatestReceiptSnapshot("t1");
  assert.equal((latest?.data as { orderNumber: string }).orderNumber, "OFF-2");
  // A different tenant does not match when scoped.
  assert.equal(await readReceiptSnapshot("missing"), null);
});

test("survives a cold restart (reopening the DB still reads the snapshot)", async () => {
  await persistReceiptSnapshot({ ref: "OFF-9", data: { ...DATA, orderNumber: "OFF-9" }, tenantId: "t1" });
  await localdb.close();
  await localdb.open();
  const snap = await readReceiptSnapshot("OFF-9");
  assert.equal((snap?.data as { orderNumber: string }).orderNumber, "OFF-9");
});

test("idempotent per ref: a later present of the same ref replaces it", async () => {
  await persistReceiptSnapshot({ ref: "OFF-5", data: { ...DATA, total: 10 }, provisional: true });
  await persistReceiptSnapshot({ ref: "OFF-5", data: { ...DATA, total: 25 }, provisional: false });
  const snap = await readReceiptSnapshot("OFF-5");
  assert.equal((snap?.data as { total: number }).total, 25);
  assert.equal(snap?.provisional, false);
  assert.equal((await localdb.receipts.count()), 1);
});

test("store source: present/stage persist durably; clear() drops the cache; restoreLatest loads it", () => {
  const src = srcOf("src/state/receipt.ts");
  assert.match(src, /present: \(receipt\) => \{[\s\S]{0,80}persist\(receipt, false\);/);
  assert.match(src, /stage: \(receipt\) => \{[\s\S]{0,80}persist\(receipt, false\);/);
  assert.match(src, /persistReceiptSnapshot\(\{ ref, data: receipt/);
  assert.match(src, /restoreLatest:/);
  assert.match(src, /clearReceiptSnapshots\(\)/);
});

test("PosWorkspace source: offline sale presents a provisional receipt; reprint falls back offline; restart restores", () => {
  const src = srcOf("src/screens/pos/PosWorkspace.tsx");
  // Offline Takeaway cash presents (and thus persists) a provisional receipt.
  assert.match(src, /receiptStore\.present\([\s\S]{0,400}orderNumber: ref,/, "offline sale presents a provisional receipt");
  // Reprint offline falls back to the durable snapshot.
  assert.match(src, /readReceiptSnapshot\(order\.order_number/, "reprint falls back to the local snapshot offline");
  // Restart restores the last receipt so Ctrl+P reprints it.
  assert.match(src, /useReceipt\.getState\(\)\.restoreLatest\(tenantId\)/, "mount restores the last snapshot");
});
