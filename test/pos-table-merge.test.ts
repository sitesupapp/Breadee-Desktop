// Phase 4 (Desktop 1.0.31): Merge Tables.
//
// Folds other occupied tables' open bills into a primary table in ONE server
// transaction (pos_merge_tables_v3, which also folds eligible partially-paid bills).
// The desktop only shapes the request, gates the
// button on pos.tables.merge, and offers occupied tables as sources; the server
// owns every eligibility rule and the atomic fold. These tests pin the permission
// key + gate, the source picker, the RPC payload shape, and the UI wiring.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { POS_PERMISSIONS, canMergeTables, type PosAccessContext } from "@/lib/pos/access";
import {
  buildMergeExpected,
  mergeAttemptSignature,
  mergeableSources,
  stableMergeOpId,
} from "@/lib/pos/tableOps";
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
  // 1.0.36: the wrapper now calls v3 (folds partially-paid bills too); the payload
  // shape is unchanged from v2.
  assert.match(code, /callPosRpc\("pos_merge_tables_v3"/);
  assert.match(code, /primary_table_id: input\.primaryTableId/);
  assert.match(code, /source_table_ids: input\.sourceTableIds/);
  assert.match(code, /expected: input\.expected/);
  assert.match(code, /client_op_id: input\.clientOpId/);
});

// --- H. the RPC is in the desktop allow-list ---

test("H pos_merge_tables_v3 is in the PosRpcName union (v2 name kept callable)", () => {
  const code = stripJsxComments(read("lib", "pos", "rpc.ts"));
  assert.match(code, /"pos_merge_tables_v3"/);
  assert.match(code, /"pos_merge_tables"/);
});

// --- L. v3 partial-payment refusals surface as cashier guidance ---

test("L an UNSUPPORTED_STATE reason maps to a plain cashier sentence", async () => {
  const { classifyError, MERGE_REASON_HINTS } = await import("@/lib/pos/errors");
  const c = classifyError(new Error("UNSUPPORTED_STATE: cannot merge (reason: partial_line)"));
  assert.equal(c.kind, "merge_unsupported");
  assert.equal(c.expected, true);
  assert.equal(c.hint, MERGE_REASON_HINTS.partial_line);
});

test("M an unknown reason token still falls back to the server message", async () => {
  const { classifyError } = await import("@/lib/pos/errors");
  const c = classifyError(new Error("UNSUPPORTED_STATE (reason: brand_new_token)"));
  assert.equal(c.kind, "merge_unsupported");
  assert.equal(c.hint, null);
  assert.match(c.message, /brand_new_token/);
});

test("N a coded merge refusal (cross-currency) classifies with a hint", async () => {
  const { classifyError } = await import("@/lib/pos/errors");
  const c = classifyError(new Error("MERGE_CROSS_CURRENCY: tables use different currencies"));
  assert.equal(c.kind, "merge_cross_currency");
  assert.equal(c.expected, true);
  assert.match(c.hint ?? "", /different currencies/i);
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
  // rc.11 — sources come from the PROJECTED map (displayMap == tables.map online; offline a bill settled
  // locally is not offered as a source — the stale 5,455,000 Move/Merge defect).
  assert.match(code, /mergeableSources\(displayMap\.tables, selected\)/);
  // confirmMerge builds the stale-floor `expected` version map and a HOISTED,
  // retry-stable client_op_id (not a fresh UUID minted inline per call).
  assert.match(code, /mergeTables\(\{/);
  assert.match(code, /buildMergeExpected\(selected, sources\)/);
  assert.match(code, /expected,/);
  assert.match(code, /stableMergeOpId\(mergeOpId\.current, sig\)/);
  assert.match(code, /clientOpId,/);
  // The inline per-call UUID is GONE from the MERGE call specifically — the id now lives in
  // the mergeOpId ref. Scoped to the merge via its unique `sourceTableIds,` line so the other
  // ops in this screen that legitimately mint their own client_op_id (split/edit/void) don't
  // trip this assertion.
  assert.doesNotMatch(code, /sourceTableIds,\s*clientOpId: crypto\.randomUUID\(\)/);
  // merge is a success-toned op routed through the shared runOp.
  assert.match(code, /runOp\("merge"/);
});

// --- O. the stale-floor `expected` version map (migration 20261013200551) ---

test("O buildMergeExpected maps the primary + every selected source to its version", () => {
  const primary = tbl({ id: "p", orders: 1, status: "occupied", pos_entity_version: 7 });
  const s1 = tbl({ id: "a", orders: 1, status: "occupied", pos_entity_version: 3 });
  const s2 = tbl({ id: "b", orders: 2, status: "occupied", pos_entity_version: 9 });
  assert.deepEqual(buildMergeExpected(primary, [s1, s2]), { p: 7, a: 3, b: 9 });
});

test("P buildMergeExpected omits a 0/absent version (older server), never sends 0", () => {
  const primary = tbl({ id: "p", orders: 1, status: "occupied", pos_entity_version: 0 });
  const s1 = tbl({ id: "a", orders: 1, status: "occupied", pos_entity_version: 4 });
  assert.deepEqual(buildMergeExpected(primary, [s1]), { a: 4 });
});

// --- Q. the retry-stable client_op_id (mint once, reuse on transport retry) ---

test("Q a retry of the SAME merge reuses the client_op_id; a different set mints a new one", () => {
  let n = 0;
  const mint = () => `id-${++n}`;
  const sigAB = mergeAttemptSignature("p", ["a", "b"]);
  const first = stableMergeOpId(null, sigAB, mint);
  // Same target set (order-independent) → SAME id (transport retry dedupes).
  const retry = stableMergeOpId(first, mergeAttemptSignature("p", ["b", "a"]), mint);
  assert.equal(retry.id, first.id);
  assert.equal(n, 1);
  // A different target set → a fresh id (a new operation).
  const other = stableMergeOpId(retry, mergeAttemptSignature("p", ["c"]), mint);
  assert.notEqual(other.id, first.id);
  assert.equal(n, 2);
});

// --- R. a merge VERSION_CONFLICT surfaces the reload-and-retry UX ---

test("R a VERSION_CONFLICT from the merge path maps to the reload-the-floor message", async () => {
  const { classifyError } = await import("@/lib/pos/errors");
  const c = classifyError(new Error("VERSION_CONFLICT: A table changed since the merge was opened. Reload the floor."));
  assert.equal(c.kind, "version_conflict");
  assert.equal(c.expected, true);
  assert.match(c.hint ?? "", /reload|floor/i);
});

test("K the merge dialog offers occupied sources and is confirm-gated", () => {
  const code = stripJsxComments(read("components", "pos", "TableOpsDialogs.tsx"));
  assert.match(code, /export function MergeTablesDialog/);
  assert.match(code, /selected\.length > 0/);
});
