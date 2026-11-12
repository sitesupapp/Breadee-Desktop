// Floor Mapping display regression: published empty floors, partially mapped
// and fully mapped floors. Uses authorized pos_table_map rows and published
// geometry only; never accesses a draft or another tenant/OU.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { summarizeUnplacedTables } from "@/lib/pos/floorStatus";
import { parseTableMap } from "@/lib/pos/tables";
import type { FloorElement, FloorLayout } from "@/lib/pos/floor";

const section = { id: "s1", name: "Main", sort: 1, w: null, h: null };
const placed = (id: string, sectionId = "s1"): FloorElement => ({
  id: "node-" + id, sectionId, type: "table", tableId: id, label: null,
  x: 0, y: 0, w: 60, h: 60, rotation: 0, shape: "sq",
});
const layout = (elements: FloorElement[] = []): FloorLayout => ({
  hasPublished: true, revisionId: "published-1", revisionNo: 1,
  publishedAt: null, sections: [section], elements,
});
const rows = (entries: Record<string, unknown>[]) => parseTableMap({ tables: entries }).tables;

test("published floor with zero placed tables reports every active table unplaced", () => {
  const actual = summarizeUnplacedTables(layout(), rows([
    { id: "a", status: "available" },
    { id: "b", status: "occupied", orders: 1 },
    { id: "inactive", status: "inactive" },
  ]));
  assert.deepEqual(actual, { activeUnplaced: 2, withOpenBills: 1 });
});

test("partially mapped floor counts only active tables absent from all sections", () => {
  const actual = summarizeUnplacedTables(layout([placed("a"), placed("b", "s2")]), rows([
    { id: "a", status: "available" },
    { id: "b", status: "occupied", orders: 1 },
    { id: "c", status: "reserved" },
  ]));
  assert.deepEqual(actual, { activeUnplaced: 1, withOpenBills: 0 });
});

test("unplaced occupied table with an open bill is highlighted, but status alone is not a bill", () => {
  const actual = summarizeUnplacedTables(layout([placed("a")]), rows([
    { id: "a", status: "occupied", orders: 1 },
    { id: "b", status: "occupied", orders: 2 },
    { id: "c", status: "occupied", orders: 0 },
  ]));
  assert.deepEqual(actual, { activeUnplaced: 2, withOpenBills: 1 });
});

test("fully mapped floor has zero unplaced and zero open-bill warnings", () => {
  const actual = summarizeUnplacedTables(layout([placed("a"), placed("b")]), rows([
    { id: "a", status: "occupied", orders: 1 },
    { id: "b", status: "available" },
  ]));
  assert.deepEqual(actual, { activeUnplaced: 0, withOpenBills: 0 });
});

test("duplicate table ids in operational input are counted once", () => {
  const actual = summarizeUnplacedTables(layout(), rows([
    { id: "a", status: "available" },
    { id: "a", status: "occupied", orders: 1 },
  ]));
  assert.deepEqual(actual, { activeUnplaced: 1, withOpenBills: 0 });
});

test("service floor displays empty published section and an explicit List escape without write APIs", () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src/components/pos/floor/ServiceFloor.tsx"),
    "utf8",
  );
  assert.match(source, /!sectionHasTables/);
  assert.match(source, /No tables placed on this floor/);
  assert.match(source, /data-unplaced-tables/);
  assert.match(source, /data-unplaced-open-bills/);
  assert.match(source, /Go to Dine-In List/);
  assert.match(source, /onClick={onSwitchToList}/);
  assert.doesNotMatch(source, /floor_publish|floor_autosave|saveFloor|updateFloor/);
});
