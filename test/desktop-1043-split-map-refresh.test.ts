// Desktop 1.0.43 - regression found in the Desktop 1.0.42 native ONLINE acceptance (2026-11-03, R3).
//   An online split leg re-read only the selected BILL, never the table MAP. The map is what carries each
//   table's collected / outstanding, so after a leg the Merge dialog still showed the pre-leg values: no
//   "Part-paid" badge and "To collect 300,000" where the server would (and did) charge 200,000. The same stale
//   map was what the offline cache held if the connection dropped next. The fix re-reads the map after the
//   leg (refresh also re-reads the selected bill), on success and on a refused leg alike.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync("src/screens/pos/DineInWorkspace.tsx", "utf8").replace(/\r\n/g, "\n");

/** The ONLINE split-settle path: from the server call to the busy reset. */
function onlineSplitBlock(): string {
  const start = src.indexOf("const result = await settleSplit(");
  assert.ok(start > 0, "online split settle call not found");
  const end = src.indexOf("setSplitBusy(false);", start);
  assert.ok(end > start, "end of the online split path not found");
  return src.slice(start, end);
}

test("R3/1.0.43: a settled online split leg re-reads the table map (not just the bill)", () => {
  const block = onlineSplitBlock();
  const success = block.slice(0, block.indexOf("} catch (e) {"));
  assert.match(success, /await tables\.refresh\(ctx\);/);
  assert.doesNotMatch(success, /tables\.loadBill\(ctx\)/);
});

test("R3/1.0.43: a refused online split leg also re-reads the table map", () => {
  const block = onlineSplitBlock();
  const failure = block.slice(block.indexOf("} catch (e) {"));
  assert.match(failure, /setSplitError\(classifyError\(e\)\.message\);[\s\S]*await tables\.refresh\(ctx\);/);
  assert.doesNotMatch(failure, /tables\.loadBill\(ctx\)/);
});

test("R3/1.0.43: the store's map refresh re-reads the selected bill, so nothing the leg showed is lost", () => {
  const store = readFileSync("src/state/tables.ts", "utf8").replace(/\r\n/g, "\n");
  assert.match(store, /if \(stillThere\) await get\(\)\.loadBill\(ctx\);/);
});
