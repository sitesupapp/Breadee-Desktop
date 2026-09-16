// Open Tables - the wiring, asserted against the source itself.
//
// The logic tests (open-tables.test.ts) prove the rules; these prove the feature
// stays a LENS and never grows a second engine: no new server RPC, no new
// permission, no client-side finance, no settlement from inside the browsing
// surface, and gated exactly like Dine-in (which is what the table-map RPC
// already demands).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { stripComments, stripJsxComments } from "./source-helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const jsx = (rel: string) => stripJsxComments(read(rel));
const ts = (rel: string) => stripComments(read(rel));

// --- the projection is pure over the map -------------------------------------

test("the outstanding predicate is `orders > 0`, and the module touches no server contract", () => {
  const src = ts("src/lib/pos/openTables.ts");
  assert.match(src, /orders > 0/, "outstanding = a table that carries an open bill");
  // A lens, not a fetch: no RPC, no Supabase, no bill re-read - it operates on
  // the TableSummary rows the shared store already loaded.
  for (const forbidden of ["supabase", "callPosRpc", "rpc(", "loadTableMap", "await "]) {
    assert.ok(!src.includes(forbidden), `openTables.ts must not contain ${forbidden}`);
  }
});

test("Open Tables invents no remaining/partial finance in the client", () => {
  const src = ts("src/lib/pos/openTables.ts");
  // No conversion and no subtraction of a paid amount: the server's `total` IS
  // the outstanding for the dine-in open set (paid is always 0 there).
  for (const forbidden of ["convertUsdToLbp", "convertCurrency", "paid_amount", "* rate", "/ rate"]) {
    assert.ok(!src.includes(forbidden), `openTables.ts must not contain ${forbidden}`);
  }
});

// --- no new server surface ---------------------------------------------------

test("no new server RPC is added - Open Tables reuses pos_table_map", () => {
  const rpc = ts("src/lib/pos/rpc.ts");
  assert.match(rpc, /"pos_table_map"/, "the table-map RPC is the source");
  assert.ok(!rpc.includes('"pos_open_tables"'), "no bespoke open-tables RPC was introduced");
});

// --- the modal formats with the shared money, and settles nothing ------------

test("the modal formats money with the shared formatter and never sums currencies", () => {
  const src = jsx("src/components/pos/OpenTablesModal.tsx");
  assert.match(src, /formatMoney/, "reuses the one dual USD/LBP formatter");
  for (const forbidden of ["convertUsdToLbp", "convertCurrency", "* rate", "/ rate"]) {
    assert.ok(!src.includes(forbidden), `the modal must not contain ${forbidden}`);
  }
});

test("the browsing surface performs no settlement - it only selects a table", () => {
  const src = ts("src/components/pos/OpenTablesModal.tsx");
  for (const forbidden of ["pos_pay", "pos_clear", "pos_close", "pos_move", "pos_complete", "callPosRpc"]) {
    assert.ok(!src.includes(forbidden), `the modal must not contain ${forbidden}`);
  }
});

// --- wiring in the workspace -------------------------------------------------

test("the rail entry is gated exactly like Dine-in, badges a COUNT, and opens the modal", () => {
  const pw = ts("src/screens/pos/PosWorkspace.tsx");
  assert.match(
    pw,
    /key:\s*"open_tables"[\s\S]{0,500}enabled:\s*tablesGate\.allowed[\s\S]{0,300}badge:\s*openTablesCount/,
    "open_tables is gated on canViewTables (tablesGate) and carries the count badge",
  );
  assert.match(pw, /<OpenTablesModal/, "the modal is rendered");
  // The count comes from the already-loaded shared map, not a fetch of its own.
  assert.match(pw, /openTablesCount\s*=\s*useMemo\(\s*\(\)\s*=>\s*selectOpenTables\(tableStore\.map\.tables\)\.length/);
});

test("a row drills into the canonical Dine-in workspace with the table selected", () => {
  const pw = ts("src/screens/pos/PosWorkspace.tsx");
  assert.match(
    pw,
    /openTableInService[\s\S]{0,300}setMode\("dine_in"\)[\s\S]{0,200}\.select\(tableId/,
    "the row hands off to Dine-in via the canonical select channel",
  );
});

test("Open Tables uses the existing pos.tables.view gate - no new permission key", () => {
  // The gate is canViewTables (imported), which is exactly pos.tables.view. The
  // new modules never name a permission string of their own.
  for (const rel of ["src/lib/pos/openTables.ts", "src/components/pos/OpenTablesModal.tsx"]) {
    const src = ts(rel);
    assert.ok(!/["']pos\.[a-z_.]+["']/.test(src), `${rel} must not hardcode a permission key`);
  }
});
