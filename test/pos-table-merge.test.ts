// Phase 4 (Desktop 1.0.31): Merge Tables.
//
// Folds other occupied tables' open bills into a primary table in ONE server
// transaction (pos_merge_tables). The desktop only shapes the request, gates the
// button on pos.tables.merge, and offers occupied tables as sources; the server
// owns every eligibility rule and the atomic fold. These tests pin the permission
// key + gate, the source picker, the RPC payload shape, and the UI wiring.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { POS_PERMISSIONS, canMergeTables, type PosAccessContext } from "@/lib/pos/access";
import { mergeableSources } from "@/lib/pos/tableOps";
import { FEATURES } from "@/lib/features";
import type { TableSummary } from "@/types/tables";
import { stripJsxComments } from "./source-helpers.ts";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (...p: string[]) => readFileSync(join(srcRoot, ...p), "utf8");

const FEATS = { [FEATURES.POS]: true, [FEATURES.POS_DINE_IN]: true, [FEATURES.POS_SHIFTS]: true };
const PERMS = { "pos.access": true, "pos.tables.view": true, "pos.tables.merge": true };
function ctx(overrides: Partial<PosAccessContext> = {}): PosAccessContext {
  return { membership: { role: "manager", status: "active" }, permissions: { ...PERMS }, features: { ...FEATS }, ...overrides };
}
const tbl = (o: Partial<TableSummary>): TableSummary =>
  ({ id: "t", name: "T", orders: 0, status: "available", pos_entity_version: 1, ...o } as TableSummary);

// --- A. the permission key matches the server ---

test("A the merge permission key is pos.tables.merge", () => {
  assert.equal(POS_PERMISSIONS.TABLES_MERGE, "pos.tables.merge");
});

// --- B. the gate ---

test("B a manager with pos.tables.merge may merge", () => {
  assert.equal(canMergeTables(ctx()).allowed, true);
});

test("C without the merge key the gate refuses (custom roles default false)", () => {
  const g = canMergeTables(ctx({ permissions: { "pos.access": true, "pos.tables.view": true } }));
  assert.equal(g.allowed, false);
  assert.match(g.reason ?? "", /permission to merge tables/i);
});

test("D without pos.tables.view the gate refuses (seeing the map is a prerequisite)", () => {
  const g = canMergeTables(ctx({ permissions: { "pos.access": true, "pos.tables.merge": true } }));
  assert.equal(g.allowed, false);
});

// --- E. the source picker offers only OTHER occupied tables ---

test("E mergeableSources: occupied tables other than the primary, never free/empty ones", () => {
  const primary = tbl({ id: "p", orders: 1, status: "occupied" });
  const occ1 = tbl({ id: "a", orders: 1, status: "occupied" });
  const occ2 = tbl({ id: "b", orders: 2, status: "occupied" });
  const free = tbl({ id: "c", orders: 0, status: "available" });
  const out = mergeableSources([primary, occ1, occ2, free], primary);
  assert.deepEqual(out.map((t) => t.id).sort(), ["a", "b"]);
});

test("F mergeableSources returns nothing without a primary", () => {
  assert.deepEqual(mergeableSources([tbl({ id: "a", orders: 1, status: "occupied" })], null), []);
});

// --- G. the RPC payload shape (what pos_merge_tables reads) ---

test("G the merge wrapper sends primary + sources + expected + client_op_id in p_payload", () => {
  const code = stripJsxComments(read("lib", "pos", "tableOps.ts"));
  assert.match(code, /callPosRpc\("pos_merge_tables"/);
  assert.match(code, /primary_table_id: input\.primaryTableId/);
  assert.match(code, /source_table_ids: input\.sourceTableIds/);
  assert.match(code, /expected: input\.expected/);
  assert.match(code, /client_op_id: input\.clientOpId/);
});

// --- H. the RPC is in the desktop allow-list ---

test("H pos_merge_tables is in the PosRpcName union", () => {
  const code = stripJsxComments(read("lib", "pos", "rpc.ts"));
  assert.match(code, /"pos_merge_tables"/);
});

// --- I. the UI is wired: button + dialog + confirm ---

test("I the table bill panel exposes a gated Merge action", () => {
  const code = stripJsxComments(read("components", "pos", "TableBillPanel.tsx"));
  assert.match(code, /mergeGate: Gate/);
  assert.match(code, /onMerge: \(\) => void/);
  assert.match(code, /gate={props\.mergeGate}/);
  assert.match(code, /Merge tables/);
});

test("J the dine-in workspace opens the merge dialog and confirms through the server", () => {
  const code = stripJsxComments(read("screens", "pos", "DineInWorkspace.tsx"));
  assert.match(code, /<MergeTablesDialog/);
  assert.match(code, /opDialog === "merge"/);
  assert.match(code, /mergeableSources\(tables\.map\.tables, selected\)/);
  // confirmMerge sends the tables' versions (stale guard) and a client_op_id (replay).
  assert.match(code, /mergeTables\(\{/);
  assert.match(code, /expected\[t\.id\] = t\.pos_entity_version/);
  assert.match(code, /clientOpId: crypto\.randomUUID\(\)/);
  // merge is a success-toned op routed through the shared runOp.
  assert.match(code, /runOp\("merge"/);
});

test("K the merge dialog offers occupied sources and is confirm-gated", () => {
  const code = stripJsxComments(read("components", "pos", "TableOpsDialogs.tsx"));
  assert.match(code, /export function MergeTablesDialog/);
  assert.match(code, /selected\.length > 0/);
});
