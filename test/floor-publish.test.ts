// Floor PUBLISH lifecycle parsing + error mapping (Phase 4) — pure, no network.
//
// The publish/history RPCs return SECURITY DEFINER jsonb, so the wire shape is
// genuinely unknown at compile time. These prove the parsers turn it into typed
// data faithfully (materialized create/rename maps, revision metadata, the current
// marker) and that every server publish REJECTION maps to the specific, actionable
// editor state the operator needs — a blocker they can fix, never a dead end.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyFloorDesignerError,
  parseHistoryEntries,
  parsePublishResult,
} from "@/lib/pos/floorDesigner";

test("parsePublishResult reads the materialized create/rename maps", () => {
  const r = parsePublishResult({
    ok: true,
    revision_id: "rev-2",
    revision_no: 2,
    created: [{ temp_id: "temp:a", table_id: "T-new" }, { temp_id: "temp:b" /* missing id → dropped */ }],
    renamed: [{ table_id: "T1", name: "VIP 2" }],
  });
  assert.equal(r.ok, true);
  assert.equal(r.revisionId, "rev-2");
  assert.equal(r.revisionNo, 2);
  assert.deepEqual(r.created, [{ tempId: "temp:a", tableId: "T-new" }]);
  assert.deepEqual(r.renamed, [{ tableId: "T1", name: "VIP 2" }]);
});

test("parsePublishResult tolerates an empty / malformed payload", () => {
  const r = parsePublishResult({ ok: true, revision_id: "rev-3", revision_no: 3 });
  assert.deepEqual(r.created, []);
  assert.deepEqual(r.renamed, []);
  const empty = parsePublishResult(null);
  assert.equal(empty.ok, false);
  assert.equal(empty.revisionId, null);
});

test("parseHistoryEntries orders-agnostic parses metadata and the current marker", () => {
  const rows = parseHistoryEntries([
    {
      revision_id: "rev-2",
      revision_no: 2,
      published_at: "2026-09-21T10:00:00Z",
      published_by: "u1",
      change_summary: { tables: 44, created: 1, renamed: 2 },
      restored_from_revision_id: null,
      is_current: true,
    },
    {
      revision_id: "rev-1",
      revision_no: 1,
      published_at: "2026-09-20T10:00:00Z",
      change_summary: { tables: 43 },
      restored_from_revision_id: "rev-0",
      is_current: false,
    },
    { /* no revision_id → dropped */ revision_no: 9 },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].revisionId, "rev-2");
  assert.equal(rows[0].isCurrent, true);
  assert.equal(rows[0].tables, 44);
  assert.equal(rows[0].createdCount, 1);
  assert.equal(rows[0].renamedCount, 2);
  assert.equal(rows[1].restoredFromRevisionId, "rev-0");
  assert.equal(rows[1].createdCount, null);
});

test("publish rejections map to specific, ACTIONABLE editor states (not read-only)", () => {
  const openBill = classifyFloorDesignerError(new Error("FLOOR_OPEN_BILL_BLOCK: these tables have an open bill: 5, 7"));
  assert.equal(openBill.kind, "openBill");
  assert.equal(openBill.readOnly, false);

  const nameTaken = classifyFloorDesignerError(new Error("FLOOR_NAME_TAKEN: VIP 2"));
  assert.equal(nameTaken.kind, "nameTaken");
  assert.equal(nameTaken.readOnly, false);

  const noop = classifyFloorDesignerError(new Error("FLOOR_NOOP_PUBLISH: draft matches the published floor"));
  assert.equal(noop.kind, "noop");
  assert.equal(noop.readOnly, false);

  const invalidRef = classifyFloorDesignerError(new Error("FLOOR_INVALID_TABLE_REFERENCE: abc"));
  assert.equal(invalidRef.kind, "invalid");
});

test("a lost lease or a moved-out-from-under-us floor still drops to read-only", () => {
  assert.equal(classifyFloorDesignerError(new Error("FLOOR_EDITOR_BUSY")).readOnly, true);
  assert.equal(classifyFloorDesignerError(new Error("FLOOR_STALE_REVISION")).readOnly, true);
  assert.equal(classifyFloorDesignerError(new Error("FLOOR_PUBLISH_PERMISSION_DENIED")).kind, "permission");
});
