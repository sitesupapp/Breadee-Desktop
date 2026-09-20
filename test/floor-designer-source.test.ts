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
