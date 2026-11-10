// 1.0.41 (Server Off F-OWN) — while the server is off, a terminal acts only on tables it already holds or that
// sit in the floor sections assigned to it; never inferred from the cached table map alone.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? (this.m.get(k) as string) : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
const mem = new MemStorage();
(globalThis as unknown as { localStorage: MemStorage }).localStorage = mem;

import {
  readServerOffAssignment,
  writeServerOffAssignment,
  sectionOfTable,
  serverOffOwnership,
  assignmentReadinessNote,
  SERVER_OFF_NOT_ASSIGNED_MESSAGE,
  SERVER_OFF_OTHER_TERMINAL_MESSAGE,
  OFFLINE_TABLES_PERMISSION,
} from "@/lib/offline/tableOwnership";

beforeEach(() => mem.clear());

const layout = {
  elements: [
    { id: "e1", sectionId: "SEC-A", type: "table", tableId: "T1" },
    { id: "e2", sectionId: "SEC-B", type: "table", tableId: "T2" },
    { id: "e3", sectionId: "SEC-A", type: "text", tableId: null },
  ],
} as never;

test("a table this terminal already holds is always its own (opened / re-homed here)", () => {
  assert.deepEqual(serverOffOwnership({ assignment: null, hasLocalSession: true, sectionId: null }), { allowed: true, reason: null });
});

test("no assignment → only tables already held here (never the cached free map)", () => {
  assert.deepEqual(serverOffOwnership({ assignment: null, hasLocalSession: false, sectionId: "SEC-A" }), { allowed: false, reason: SERVER_OFF_NOT_ASSIGNED_MESSAGE });
  assert.match(assignmentReadinessNote(null) ?? "", /No Server Off tables are assigned/);
});

test("'all tables' (single-terminal site) and assigned sections are owned; another section is view-only", () => {
  writeServerOffAssignment("t1", "b1", { mode: "sections", sectionIds: ["SEC-A", "SEC-A"] }, "mgr");
  const a = readServerOffAssignment("t1", "b1");
  assert.equal(a?.mode, "sections");
  assert.deepEqual(a && a.mode === "sections" ? a.sectionIds : null, ["SEC-A"], "deduplicated");
  assert.equal(a?.setBy, "mgr");
  assert.equal(serverOffOwnership({ assignment: a, hasLocalSession: false, sectionId: sectionOfTable(layout, "T1") }).allowed, true);
  assert.deepEqual(serverOffOwnership({ assignment: a, hasLocalSession: false, sectionId: sectionOfTable(layout, "T2") }), { allowed: false, reason: SERVER_OFF_OTHER_TERMINAL_MESSAGE });
  assert.equal(serverOffOwnership({ assignment: a, hasLocalSession: false, sectionId: null }).allowed, false, "a table not on the published floor is not assumed ours");
  writeServerOffAssignment("t1", "b1", { mode: "all" }, "mgr");
  assert.equal(serverOffOwnership({ assignment: readServerOffAssignment("t1", "b1"), hasLocalSession: false, sectionId: null }).allowed, true);
  assert.equal(assignmentReadinessNote(readServerOffAssignment("t1", "b1")), null);
});

test("the assignment is per tenant + branch on this device, and can be cleared", () => {
  writeServerOffAssignment("t1", "b1", { mode: "all" }, null);
  assert.equal(readServerOffAssignment("t1", "b2"), null);
  assert.equal(readServerOffAssignment("t2", "b1"), null);
  writeServerOffAssignment("t1", "b1", null, null);
  assert.equal(readServerOffAssignment("t1", "b1"), null);
  mem.setItem("breadee-desktop-serveroff-tables:t1:b1", "{not json");
  assert.equal(readServerOffAssignment("t1", "b1"), null, "a corrupt value is treated as unassigned (fail closed)");
});

test("sectionOfTable reads the published floor's table placements only", () => {
  assert.equal(sectionOfTable(layout, "T1"), "SEC-A");
  assert.equal(sectionOfTable(layout, "T9"), null);
  assert.equal(sectionOfTable(null, "T1"), null);
});

test("Dine-In applies the verdict to open / add / pay / split / move / merge only while offline capture is active", () => {
  const src = readFileSync(join(process.cwd(), "src", "screens", "pos", "DineInWorkspace.tsx"), "utf8");
  assert.match(src, /const offlineCaptureNow = !input\.online && input\.offlineReady === true && input\.offlineScope != null;/);
  assert.match(src, /offlineCaptureNow && selected\s*\? serverOffOwnership\(/);
  assert.match(src, /if \(serverOffOwnershipReason\) return \{ allowed: false, reason: serverOffOwnershipReason \};/, "open + add items");
  assert.match(src, /if \(g\.allowed && serverOffOwnershipReason\) return \{ allowed: false, reason: serverOffOwnershipReason \};/, "pay");
  assert.match(src, /move: owned\(/);
  assert.match(src, /merge: owned\(/);
  assert.match(src, /const notOurs = await serverOffReasonFor\(destinationId\);/, "a move destination must be ours");
  assert.match(src, /for \(const id of sourceTableIds\) \{\s*const notOurs = await serverOffReasonFor\(id\);/, "every merge source must be ours");
  assert.match(src, /if \(ownershipReasonRef\.current\) return setSplitError\(ownershipReasonRef\.current\);/, "split");
  assert.match(src, /if \(offlineCapture && ownershipReasonRef\.current\) return setPayError\(ownershipReasonRef\.current\);/, "on account");
  const dev = readFileSync(join(process.cwd(), "src", "screens", "settings", "DeviceSettings.tsx"), "utf8");
  assert.match(dev, /s\.permissions\[OFFLINE_TABLES_PERMISSION\] === true/, "only floor managers change it");
  assert.equal(OFFLINE_TABLES_PERMISSION, "pos.tables.floor_manage");
});
