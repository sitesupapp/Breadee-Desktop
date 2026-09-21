// Floor DESIGNER (Phase 3A) — the wiring, asserted against the source itself.
//
// The logic tests prove the edit math and the lossless save; these prove the
// STRUCTURE the preservation gate depends on: the designer edits a DRAFT and never
// publishes, it owns a lease but touches none of the operational Dine-In engine
// (no bill, no payment, no order, no `useTables`), its selection never invokes the
// bill panel, and the whole feature is gated on `pos.tables.floor_manage` on top
// of everything viewing the floor already requires.

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

const LIB = "src/lib/pos/floorDesigner.ts";
const STORE = "src/state/floorDesigner.ts";
const CANVAS = "src/components/pos/floor/designer/DesignerCanvas.tsx";
const NODE = "src/components/pos/floor/designer/DesignerTableNode.tsx";
const SHELL = "src/components/pos/floor/designer/FloorDesigner.tsx";

// --- Phase 3A edits a DRAFT and NEVER publishes ------------------------------

test("the designer uses the draft/lease RPCs and never publishes", () => {
  const lib = ts(LIB);
  for (const rpc of [
    "floor_draft",
    "floor_autosave_draft",
    "floor_acquire_lease",
    "floor_heartbeat",
    "floor_release_lease",
    "floor_takeover_lease",
    "floor_unplaced_tables",
  ]) {
    assert.ok(lib.includes(rpc), `floorDesigner.ts must call ${rpc}`);
  }
  // Phase 3A does not publish, and the designer never reads the published service
  // layout — that is the Service Floor's job, on the other side of the boundary.
  assert.ok(!lib.includes("floor_publish"), "Phase 3A must not publish");
  assert.ok(!lib.includes("floor_service_layout"), "the designer edits a draft, not the published read");
});

test("the RPC union adds the six draft/lease RPCs but NOT floor_publish", () => {
  const rpc = ts("src/lib/pos/rpc.ts");
  for (const name of [
    "floor_draft",
    "floor_autosave_draft",
    "floor_acquire_lease",
    "floor_heartbeat",
    "floor_release_lease",
    "floor_takeover_lease",
    "floor_unplaced_tables",
  ]) {
    assert.match(rpc, new RegExp(`"${name}"`), `${name} is in the union`);
  }
  assert.ok(!rpc.includes('"floor_publish"'), "no publish RPC is wired in Phase 3A");
});

test("every autosave echoes the published-revision CAS key", () => {
  const lib = ts(LIB);
  assert.match(lib, /p_base_revision_id/, "autosave is CAS-guarded on the base revision");
});

// --- the draft store touches NONE of the operational POS engine --------------

test("the designer store never imports or names the canonical POS engine", () => {
  const store = ts(STORE);
  for (const forbidden of [
    "useTables",
    "useCart",
    "TableBillPanel",
    "loadBill",
    "pos_pay",
    "pos_open_table",
    "pos_move_table",
    "pos_close_table",
    "pos_clear_table",
    "pos_submit_order",
  ]) {
    assert.ok(!store.includes(forbidden), `the designer store must not reference ${forbidden}`);
  }
});

test("the designer state is separate from the service floor store", () => {
  const store = ts(STORE);
  // It reuses the pure geometry/section helpers, but not the read-only service
  // store — the two must not share editing state.
  assert.ok(!store.includes('from "@/state/floor"'), "the draft store is not the service store");
  assert.match(store, /create<DesignerState>/, "a dedicated designer state boundary");
});

// --- the canvas selection is designer-only, never the bill panel -------------

test("the designer canvas and node never reach the bill/operational surface", () => {
  for (const rel of [CANVAS, NODE, SHELL]) {
    const src = ts(rel);
    for (const forbidden of ["useTables", "useCart", "TableBillPanel", "onSelectTable", "pos_pay", "requestPay"]) {
      assert.ok(!src.includes(forbidden), `${rel} must not reference ${forbidden}`);
    }
  }
});

test("selection routes to the designer store, not the table selection channel", () => {
  const shell = jsx(SHELL);
  assert.match(shell, /d\.selectElement/, "selection is the designer's own element selection");
  assert.ok(!shell.includes("tables.select"), "never the canonical table selection");
});

// --- editing stays in intrinsic logical coordinates --------------------------

test("edits are computed in logical units from a screen delta over the view scale", () => {
  const lib = ts(LIB);
  // Screen deltas are divided by scale; nothing viewport-shaped is persisted.
  assert.match(lib, /screenDx\s*\/\s*s/, "drag converts screen px to logical by the scale");
  // No text-direction / RTL flipping of coordinates — the plane is physical.
  assert.ok(!/\brtl\b/i.test(lib) && !lib.includes('dir="rtl"'), "coordinates are physical, not RTL-relative");
});

// --- permission gating -------------------------------------------------------

test("editing is gated on pos.tables.floor_manage, on top of viewing the floor", () => {
  const access = ts("src/lib/pos/access.ts");
  assert.match(access, /TABLES_FLOOR_MANAGE:\s*"pos\.tables\.floor_manage"/);
  assert.match(access, /export function canManageFloor/);
  assert.match(access, /canManageFloor[\s\S]{0,220}canViewFloor\(ctx\)[\s\S]{0,220}TABLES_FLOOR_MANAGE/);
});

test("the Edit-floor entry is offered only on the Map and only with the manage permission", () => {
  const dw = jsx("src/screens/pos/DineInWorkspace.tsx");
  assert.match(dw, /canManageFloor\(pos\.access\)/, "the manage gate is computed");
  assert.match(dw, /showFloor && floorManageGate\.allowed/, "the button needs the Map view AND the permission");
  assert.match(dw, /<FloorDesigner\b/, "the overlay is mounted");
  assert.match(dw, /setEditingFloor\(true\)/, "the button opens the designer");
});

// --- the lease lifecycle is present ------------------------------------------

test("the store runs the full lease lifecycle with a read-only fallback", () => {
  const store = ts(STORE);
  for (const fn of ["floorAcquireLease", "floorHeartbeat", "floorReleaseLease", "floorTakeoverLease"]) {
    assert.ok(store.includes(fn), `the store must use ${fn}`);
  }
  assert.match(store, /readOnly:\s*true/, "a lost lease drops to read-only rather than losing work");
  assert.match(store, /FLOOR_HEARTBEAT_MS\s*=\s*45_000/, "heartbeat is well under the 150s server TTL");
});

// --- Phase 3B: identity is a one-way, read-only metadata projection ----------

const INSPECTOR = "src/components/pos/floor/designer/DesignerInspector.tsx";
const TRAY = "src/components/pos/floor/designer/UnplacedTray.tsx";
const ADD_DIALOG = "src/components/pos/floor/designer/AddTableDialog.tsx";
const SECTIONS_DIALOG = "src/components/pos/floor/designer/SectionsDialog.tsx";

test("the metadata adapter projects {id, name, seats} and carries nothing operational", () => {
  const lib = ts(LIB);
  assert.match(lib, /floorLoadTableMeta/, "the adapter exists");
  assert.match(lib, /loadTableMap/, "it reuses the canonical pos_table_map read");
  // Once comments are stripped, no operational field of TableSummary survives
  // into this module — the projection happens inside the adapter, immediately.
  for (const forbidden of ["mixed_currency", "opened_at", "order_number", "occupied", "total", "currency"]) {
    assert.ok(!lib.includes(forbidden), `floorDesigner.ts must not carry the operational field ${forbidden}`);
  }
});

test("every designer surface stays clear of the operational POS engine and of canonical writes", () => {
  for (const rel of [LIB, STORE, CANVAS, NODE, SHELL, INSPECTOR, TRAY, ADD_DIALOG, SECTIONS_DIALOG]) {
    const src = ts(rel);
    for (const forbidden of [
      "useTables",
      "useCart",
      "TableBillPanel",
      "pos_open_table",
      "pos_configure_tables",
      "floor_publish",
      "supabase",
    ]) {
      assert.ok(!src.includes(forbidden), `${rel} must not reference ${forbidden}`);
    }
  }
});

test("a rename stays rename_to and a new table stays a temp: intent — no canonical create/rename path", () => {
  const lib = ts(LIB);
  assert.match(lib, /rename_to/, "renames are staged in the draft");
  assert.match(lib, /`temp:\$\{/, "temp identities use the server's temp: namespace");
  const store = ts(STORE);
  assert.ok(!store.includes("pos_tables"), "the store never names the canonical table store");
  assert.match(store, /edits\.renames/, "renames flow through the edits model");
  // Inspecting a loaded raw field ("rename_to" in raw) is fine — WRITING one
  // directly would not be. The serializer is the only writer.
  assert.ok(!/\.rename_to\s*=/.test(store), "the store never writes rename_to directly");
});

test("the inspector and dialogs speak restaurant language — no developer identifiers", () => {
  for (const rel of [INSPECTOR, TRAY, ADD_DIALOG, SECTIONS_DIALOG]) {
    const src = ts(rel);
    for (const forbidden of ['"temp_id"', '"table_id"', "JSON.stringify", "layout_id"]) {
      assert.ok(!src.includes(forbidden), `${rel} must not surface ${forbidden}`);
    }
  }
});

test("the shell keeps the section nav in a fixed ROW so the canvas dominates (the 3A gap fix)", () => {
  const shell = jsx(SHELL);
  assert.match(
    shell,
    /flex shrink-0 items-center[\s\S]{0,200}<FloorSectionNav/,
    "FloorSectionNav sits in a fixed-height row, not loose in the column",
  );
  assert.match(shell, /UnplacedTray/, "the unplaced tray is mounted");
  assert.match(shell, /DesignerInspector/, "the inspector is mounted");
});

// --- Phase 3C: precision tools stay Designer-owned ---------------------------

const SNAP_LIB = "src/lib/pos/floorSnap.ts";
const COLLISION_LIB = "src/lib/pos/floorCollision.ts";
const ARRANGE_LIB = "src/lib/pos/floorArrange.ts";
const BULK_PANEL = "src/components/pos/floor/designer/DesignerBulkPanel.tsx";

test("the SERVICE floor and Open Tables know nothing about snap/collision/multi-select", () => {
  for (const rel of [
    "src/components/pos/floor/ServiceFloor.tsx",
    "src/components/pos/floor/FloorCanvas.tsx",
    "src/components/pos/floor/FloorTableNode.tsx",
    "src/lib/pos/floor.ts",
    "src/state/floor.ts",
    "src/components/pos/OpenTablesModal.tsx",
    "src/lib/pos/openTables.ts",
  ]) {
    const src = ts(rel);
    for (const forbidden of ["floorSnap", "floorCollision", "floorArrange", "analyzeCollisions", "computeMoveSnap", "selectedIds", "DesignerBulkPanel"]) {
      assert.ok(!src.includes(forbidden), `${rel} must not reference ${forbidden}`);
    }
  }
});

test("the 3C geometry libs are pure: no network, no store, no React", () => {
  for (const rel of [SNAP_LIB, COLLISION_LIB, ARRANGE_LIB]) {
    const src = ts(rel);
    for (const forbidden of ["callPosRpc", "supabase", "zustand", "useFloorDesigner", 'from "react"', "floor_autosave", "floor_publish"]) {
      assert.ok(!src.includes(forbidden), `${rel} must not reference ${forbidden}`);
    }
  }
});

test("collision is ADVISORY: nothing gates the autosave path on a collision result", () => {
  const store = ts(STORE);
  assert.ok(!store.includes("analyzeCollisions"), "the store never consults collision before saving");
  assert.ok(!store.includes("floorCollision"), "collision feedback lives in the render layer only");
});

test("group operations flow through ONE mutation: commitGeoms in the store, onCommitGroup from the canvas", () => {
  const store = ts(STORE);
  assert.match(store, /commitGeoms:\s*\(entries\)/, "the store exposes the single group commit");
  const canvas = ts(CANVAS);
  assert.match(canvas, /onCommitGroup\(/, "the canvas commits a group as one call");
  assert.ok(!canvas.includes("forEach(onCommit"), "never a per-table commit loop");
  const shell = jsx(SHELL);
  assert.match(shell, /d\.commitGeoms/, "bulk tools apply through the same single path");
});

test("snapping is zoom-normalised and bypassable, and guides are gesture-scoped", () => {
  const snap = ts(SNAP_LIB);
  assert.match(snap, /SNAP_THRESHOLD_PX\s*\/\s*Math\.max\(scale/, "screen threshold ÷ scale");
  const canvas = ts(CANVAS);
  assert.match(canvas, /bypass:\s*e\.altKey/, "Alt bypasses snapping during a gesture");
  assert.match(canvas, /setGuides\(\[\]\)/, "guides are cleared when the gesture ends");
});

test("multi-select is Ctrl/Cmd+click on tables; structures stay single-select", () => {
  const canvas = ts(CANVAS);
  assert.match(canvas, /e\.ctrlKey \|\| e\.metaKey/, "the toggle modifier");
  const store = ts(STORE);
  assert.match(store, /el\.type !== "table"/, "toggling a structure demotes to single-select");
});

test("the bulk panel never offers a cross-table rename and speaks restaurant language", () => {
  const bulk = ts(BULK_PANEL);
  assert.ok(!bulk.includes("onRename") && !bulk.includes("TABLE NAME"), "no rename across canonical tables");
  assert.match(bulk, /tables selected/, "an honest count");
  assert.match(bulk, /min-h-\[44px\]/, "44px touch targets on bulk actions");
});

// --- Phase-3B follow-ups pinned ----------------------------------------------

test("meta-less legacy placements cannot be renamed, and a staged rename is always discardable", () => {
  const insp = jsx(INSPECTOR);
  assert.match(insp, /isLegacy/, "the legacy branch exists");
  assert.match(insp, /Legacy table/, "honest identity, nothing fabricated");
  assert.match(insp, /Discard draft rename/, "the narrow escape hatch");
  const store = ts(STORE);
  assert.match(store, /discardRename:\s*\(id\)/, "the store clears a rename without the canonical name");
});

test("the inspector reveals the selection instead of re-fitting (zoom preserved)", () => {
  const shell = jsx(SHELL);
  assert.match(shell, /panToReveal/, "minimal reveal, not Fit");
  assert.ok(!/selectedElementId[\s\S]{0,200}requestFit\(\)/.test(shell), "selection never triggers a full Fit");
});

test("inspector steppers meet the 44px touch floor", () => {
  const insp = jsx(INSPECTOR);
  assert.match(insp, /h-11 w-11/, "44px stepper hit targets");
});
