// Desktop 1.0.31 release-readiness closure:
//   - Floor Map merged-state label (data-driven from pos_table_merges provenance,
//     surfaced through pos_table_map -> TableSummary -> FloorNodeModel -> node).
//   - Deletion/reduction reason report (read-only, over activity_logs via
//     pos_deletion_reason_report, shown in the Analytics reports surface).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { buildFloorNode } from "@/lib/pos/floorStatus";
import type { TableSummary } from "@/types/tables";
import { stripJsxComments } from "./source-helpers.ts";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (...p: string[]) => readFileSync(join(srcRoot, ...p), "utf8");

const sumTable = (o: Partial<TableSummary>): TableSummary =>
  ({
    id: "t1", name: "5", seats: null, occupied: true, status: "occupied", canonical: true,
    configured: true, sort_order: null, orders: 1, order_number: "260101-0001", opened_at: null,
    total: null, currency: null, mixed_currency: false, merged_sources: [], ...o,
  } as TableSummary);

// --- A. buildFloorNode carries merge provenance through to the node model ---

test("A a merged table's node model exposes its source names; a plain one is empty", () => {
  const el = { id: "e1", tableId: "t1", x: 0, y: 0, w: 10, h: 10, shape: "rect", rotation: 0, label: "5" } as never;
  const merged = buildFloorNode(el, new Map([["t1", sumTable({ merged_sources: ["6", "8"] })]]), Date.now());
  assert.deepEqual(merged.mergedSources, ["6", "8"]);
  const plain = buildFloorNode(el, new Map([["t1", sumTable({ merged_sources: [] })]]), Date.now());
  assert.deepEqual(plain.mergedSources, []);
  const missing = buildFloorNode(el, new Map(), Date.now());
  assert.deepEqual(missing.mergedSources, []);
});

// --- B. the data path + render for the merged label ---

test("B TableSummary + pos_table_map parser carry merged_sources", () => {
  assert.match(stripJsxComments(read("types", "tables.ts")), /merged_sources: string\[\]/);
  assert.match(stripJsxComments(read("lib", "pos", "tables.ts")), /merged_sources:/);
});

test("C the floor node renders the merged sources (badge + aria), data-driven", () => {
  const node = stripJsxComments(read("components", "pos", "floor", "FloorTableNode.tsx"));
  assert.match(node, /model\.mergedSources\.length > 0/);
  assert.match(node, /model\.mergedSources\.join/);
  assert.match(node, /merged with/); // aria-label
});

// --- D. the deletion/reduction report ---

test("D pos_deletion_reason_report is in the allow-list and the lib calls it with the range + branch", () => {
  assert.match(stripJsxComments(read("lib", "pos", "rpc.ts")), /"pos_deletion_reason_report"/);
  const lib = stripJsxComments(read("lib", "pos", "deletionReport.ts"));
  assert.match(lib, /callPosRpc\("pos_deletion_reason_report"/);
  assert.match(lib, /p_from: input\.from/);
  assert.match(lib, /p_to: input\.to/);
  assert.match(lib, /p_branch: input\.branchId/);
});

test("E the Analytics reports surface shows the Deletions & Reductions section", () => {
  const an = stripJsxComments(read("screens", "Analytics.tsx"));
  assert.match(an, /loadDeletionReport/);
  assert.match(an, /<DeletionsReport/);
  assert.match(an, /Deletions & Reductions/);
});
