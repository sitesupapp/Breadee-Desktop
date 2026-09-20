// Service Floor Map wiring — asserted against source, because the project has no
// DOM test library and these are structural guarantees about how the feature is
// wired, not runtime behaviour:
//
//   * the floor feeds the ONE canonical selection (no second bill/order/shift
//     state) — the read-only, no-duplication contract;
//   * structures render behind tables and never intercept a tap;
//   * the whole Map is gated on `pos.floor_map`, and with it off the List stands
//     alone;
//   * the SERVICE READER is the one Phase-1 read RPC and performs no write. (The
//     Phase-3A Designer now ships alongside it and adds the draft/lease RPCs to
//     the shared union — asserted in floor-designer-source.test.ts — but it is a
//     separate module; the reader here stays read-only, and no PUBLISH path ships
//     in 3A.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripJsxComments } from "./source-helpers.ts";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (rel: string) => readFileSync(join(srcRoot, rel), "utf8");
const code = (rel: string) => stripJsxComments(read(rel));

test("the RPC allow-list exposes the floor read (and the 3A draft/lease) but never a PUBLISH path", () => {
  const rpc = code("lib/pos/rpc.ts");
  assert.match(rpc, /"floor_service_layout"/);
  // Phase 3A adds the DRAFT designer (autosave + the lease RPCs) to this shared
  // union — that is expected and is asserted in floor-designer-source.test.ts. What
  // must STILL be absent is any publish/restore/history path: Phase 3A edits a
  // draft and never publishes, so the Service Floor read stays unaffected by edits.
  assert.doesNotMatch(rpc, /"floor_publish"|"floor_restore_revision"|"floor_history"/);
});

test("the reader calls floor_service_layout and performs no write", () => {
  const floor = code("lib/pos/floor.ts");
  assert.match(floor, /callPosRpc\(\s*"floor_service_layout"/);
  assert.doesNotMatch(floor, /floor_publish|floor_autosave|floor_acquire_lease/);
});

test("the floor store owns geometry only — no bill/order/shift/selection duplication", () => {
  const store = code("state/floor.ts");
  // The selection lives in useTables; the floor store must never own it.
  assert.doesNotMatch(store, /selectedTableId/);
  // No business writers/readers are imported into the floor store.
  assert.doesNotMatch(store, /loadTableBill|tablePayment|onAccount|submitOrder|pos_pay|useCart|useShift/);
});

test("ServiceFloor feeds the canonical selection and does not rebuild business state", () => {
  const svc = code("components/pos/floor/ServiceFloor.tsx");
  assert.match(svc, /onSelect\(/); // pushes the tapped table id into the existing channel
  assert.match(svc, /useFloor\(\)/);
  assert.doesNotMatch(svc, /TableBillPanel|loadTableBill|payTable|useCart/);
});

test("the floor node shows no bill total (the panel is the detail surface)", () => {
  const node = code("components/pos/floor/FloorTableNode.tsx");
  assert.doesNotMatch(node, /formatMoney/);
});

test("structures are inert and painted behind tables", () => {
  const obj = code("components/pos/floor/FloorObject.tsx");
  assert.match(obj, /pointer-events-none/);
  const canvas = code("components/pos/floor/FloorCanvas.tsx");
  // Structures are mapped before tables in the plane, so they paint behind them.
  assert.ok(canvas.indexOf("<FloorObject") < canvas.indexOf("<FloorTableNode"));
});

test("the Dine-in workspace gates the Map on canViewFloor and falls back to the List when off", () => {
  const dw = code("screens/pos/DineInWorkspace.tsx");
  assert.match(dw, /canViewFloor/);
  assert.match(dw, /<MapListToggle/);
  assert.match(dw, /<ServiceFloor/);
  // With the feature off, the List is returned with no toggle at all.
  assert.match(dw, /if \(!floorGate\.allowed\) return list;/);
});

test("no Floor DESIGNER code ships in Phase 2", () => {
  for (const rel of [
    "components/pos/floor/ServiceFloor.tsx",
    "components/pos/floor/FloorCanvas.tsx",
    "components/pos/floor/FloorTableNode.tsx",
    "state/floor.ts",
    "lib/pos/floor.ts",
  ]) {
    const src = code(rel);
    assert.doesNotMatch(src, /ToolPalette|Inspector|autosave|Publish changes|draft_doc|resize handle|onRotate/i);
  }
});

test("the feature key matches the server sub-feature", () => {
  assert.match(read("lib/features.ts"), /POS_FLOOR_MAP:\s*"pos\.floor_map"/);
});
