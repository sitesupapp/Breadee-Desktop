// Desktop 1.0.35 (B2) — Transfer Center contract + behavior (desktop). Pins the client surface added for
// Force Transfer + Sender Cancel + the Transfer Center UI, AND proves the runtime rules Konan flagged:
// exactly-once id rotation (identical-payload retry reuses the id; a changed payload rotates it), the
// stable per-intent cancel/reapprove key, and the re-approve target-shift OMISSION (server auto-resolves).
// Server authority lives in the SECURITY DEFINER RPCs (proven by the staging B1 certification, Konan PASS
// sess_0762bbe3); this guards the desktop wiring + the client-side exactly-once lifecycle from drift.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  buildCancelPayload,
  buildForcePayload,
  buildReapprovePayload,
  keepAvailable,
  nextOpId,
} from "@/lib/pos/transfers";
import {
  initialManageState,
  intentKey,
  manageReducer,
  type ManageState,
} from "@/lib/pos/transferIntents";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

// --- Contract (source) -------------------------------------------------------

test("the B2 Transfer Center RPCs are allow-listed (and the B3-only settings write is NOT)", () => {
  const rpc = read("src/lib/pos/rpc.ts");
  for (const name of ["pos_order_transfer_force", "pos_order_transfer_cancel", "pos_transfer_force_enabled"]) {
    assert.match(rpc, new RegExp(`\\|\\s*"${name}"`), `${name} must be allow-listed`);
  }
  // (The Force-setting WRITE pos_transfer_settings_set is a B3 addition — covered by pos-transfer-settings.test.ts.)
});

test("the 2 B2 permission keys and their gates exist (manage-force-setting is B3, absent here)", () => {
  const access = read("src/lib/pos/access.ts");
  for (const [konst, key] of [
    ["ORDERS_FORCE_TRANSFER", "pos.orders.force_transfer"],
    ["TRANSFERS_CANCEL_OTHERS", "pos.transfers.cancel_others"],
  ] as const) {
    assert.match(access, new RegExp(`${konst}:\\s*"${key.replace(/\./g, "\\.")}"`));
  }
  for (const fn of ["canForceTransfer", "canCancelOthersTransfer"]) {
    assert.match(access, new RegExp(`export function ${fn}`));
  }
  // Force requires BOTH force_transfer AND select_recipient (matches pos_order_transfer_force_core).
  assert.match(access, /export function canForceTransfer[\s\S]{0,260}ORDERS_FORCE_TRANSFER[\s\S]{0,200}TRANSFERS_SELECT_RECIPIENT/);
  // (manage_force_setting / canManageForceSetting are a B3 addition — covered by pos-transfer-settings.test.ts.)
});

test("the transfer glyph exists for the sidebar entry", () => {
  const g = read("src/components/Glyph.tsx");
  assert.match(g, /\|\s*"transfer"/);
  assert.match(g, /\btransfer:\s*"M/);
});

test("the Transfer Center is wired into the POS workspace sidebar", () => {
  const ws = read("src/screens/pos/PosWorkspace.tsx");
  assert.match(ws, /import \{ TransferCenterModal \}/);
  assert.match(ws, /<TransferCenterModal/);
  assert.match(ws, /transferCenterOpen/);
  assert.match(ws, /key: "transfer"/);
  assert.match(ws, /icon: "transfer"/);
  assert.match(ws, /transferRailAllowed/);
  assert.match(ws, /canForceTransfer\(pos\.access\)\.allowed/);
});

test("the Transfer Center keeps Standard/Force separate, gates Force, and resolves the active tab synchronously", () => {
  const m = read("src/components/pos/TransferCenterModal.tsx");
  assert.match(m, /"send"/);
  assert.match(m, /"incoming"/);
  assert.match(m, /"manage"/);
  // two distinct create paths — never one standing in for the other
  assert.match(m, /createTransfer\(/);
  assert.match(m, /forceTransfer\(/);
  assert.match(m, /const forceAvailable = forceGate\.allowed && forceEnabled/);
  assert.match(m, /isForceTransferEnabled\(/);
  assert.match(m, /effectiveMode === "force" \? "FORCE" : "TRANSFER"/);
  // active tab derived SYNCHRONOUSLY from the permission-gated tabs (not a post-mount effect), so an
  // incoming-only/manage-only operator never briefly mounts SendTab and fires its load RPCs.
  assert.match(m, /const activeTab: Tab \| null = tabs\.some\(\(t\) => t\.key === tab\) \? tab : \(tabs\[0\]\?\.key \?\? null\)/);
  assert.doesNotMatch(m, /useEffect\([\s\S]{0,120}setTab\(/); // no effect that corrects the tab after mount
  // Manage snapshots the CAS version + op id ONCE at begin (reads detail), via the pure reducer; CONFIRM
  // reuses the exact snapshot passed from render (no re-fetch); success consumes it; serialized via busyRef.
  assert.match(m, /const detail = await getTransferDetail\(t\.transferId\)/);
  assert.match(m, /dispatch\(\{ t: "begin_ok"[\s\S]{0,120}snapshot: \{ opId: newOpId\(\), expectedVersion: detail\.posEntityVersion \} \}\)/);
  assert.match(m, /expectedVersion: snapshot\.expectedVersion, clientOpId: snapshot\.opId/);
  assert.match(m, /expectedVersion: snapshot\.expectedVersion, clientToken: snapshot\.opId/);
  assert.match(m, /dispatch\(\{ t: "confirm_ok"[\s\S]{0,60}\); \/\/ consumes the snapshot/);
  assert.match(m, /if \(busyRef\.current\) return;/); // synchronous serialize guard
  assert.match(m, /const anyBusy = mstate\.busy !== null/);
  // SendTab: a failed submit refreshes WITHOUT auto-adding orders and invalidates the typed confirmation.
  assert.match(m, /await load\(\{ preserveSelection: true \}\)/);
  assert.match(m, /keepAvailable\(prev, openIds\)/);
  // even the error-SCREEN retry preserves the selection while an uncertain intent is pending.
  assert.match(m, /onRetry=\{\(\) => void load\(\{ preserveSelection: opStateRef\.current !== null \}\)\}/);
  // orderIds canonicalized ONCE (sorted) and used for BOTH the fingerprint and the wire payload.
  assert.match(m, /const orderIds = \[\.\.\.selected\]\.sort\(\);/);
  assert.match(m, /const fp = `\$\{effectiveMode\}\|\$\{recipientId\}\|\$\{orderIds\.join\(","\)\}`/);
  // ManageTab uncertain-error path does NOT auto-refresh: the catch only dispatches confirm_fail (identity-
  // tagged) which KEEPS the step + snapshot, so the actionable row survives for an identical replay.
  assert.match(m, /dispatch\(\{ t: "confirm_fail", transferId: t\.transferId, action, error: classifyError\(e\)\.message \}\)/);
  // ManageTab resets the lifecycle ONLY on close (never on a filter change), so a snapshot is never stranded.
  assert.match(m, /if \(!open\) \{ dispatch\(\{ t: "reset" \}\); return; \}/);
  // Manage never queries with an undefined branch — it stays blank instead of a broader fallback query.
  assert.match(m, /if \(!branchId\) \{ setRows\(\[\]\); setLoading\(false\); return; \}/);
  // IncomingTab is serialized too (no second decision while one is in flight).
  assert.match(m, /if \(busyId\) return; \/\/ serialize/);
  // Tab switching is LOCKED while the active tab holds an unresolved lifecycle (prevents unmount-and-lose).
  assert.match(m, /disabled=\{locked && activeTab !== t\.key\}/);
  assert.match(m, /const manageLocked = mstate\.busy !== null \|\| Object\.keys\(mstate\.intents\)\.length > 0/);
  assert.equal((m.match(/onLockChange=\{setLocked\}/g) || []).length, 3); // all three tabs report lock
  assert.equal((m.match(/onLockChange\?\.\(/g) || []).length >= 3, true); // each tab wires the report effect
  // modal close is REFUSED while locked (Escape/backdrop/button cannot unmount a locked lifecycle).
  assert.match(m, /const guardedClose = useCallback\(\(\) => \{ if \(!locked\) onClose\(\); \}/);
  assert.match(m, /onClose=\{guardedClose\}/);
  // Manage filters AND other-row begin actions are frozen for the FULL manageLocked lifecycle (not just busy).
  assert.match(m, /onClick=\{\(\) => setFilter\(f\.key\)\} disabled=\{manageLocked\}/);
  assert.match(m, /onClick=\{\(\) => void beginIntent\(t, "cancel"\)\} disabled=\{manageLocked\}/);
  assert.match(m, /onClick=\{\(\) => void beginIntent\(t, "reapprove"\)\} disabled=\{manageLocked\}/);
  // incoming approve targets the operator's own open shift
  assert.match(m, /targetShiftId: action === "approve" \? shiftId : null/);
});

test("the Manage reducer ignores stale/foreign resolutions (identity-guarded)", () => {
  const r = read("src/lib/pos/transferIntents.ts");
  assert.match(r, /function resolvesActive/);
  // the four resolution events are all guarded by resolvesActive before mutating state
  for (const ev of ["begin_ok", "begin_fail", "confirm_ok", "confirm_fail"]) {
    assert.match(r, new RegExp(`case "${ev}":[\\s\\S]{0,120}resolvesActive`));
  }
});

test("keepAvailable never auto-adds orders — it only keeps the still-open ones from a prior selection", () => {
  // a prior subset selection, refreshed against the still-open set, keeps only the survivors.
  const kept = keepAvailable(["a", "b", "c"], ["b", "c", "d"]);
  assert.deepEqual([...kept].sort(), ["b", "c"]);
  // an order that vanished (b, c gone) drops out; nothing from `available` is ever added.
  assert.deepEqual([...keepAvailable(["a"], ["x", "y"])], []);
  assert.deepEqual([...keepAvailable([], ["a", "b"])], []); // empty prior selection stays empty (no auto-add)
});

// --- Behavior (pure functions) ----------------------------------------------

test("buildForcePayload carries the exactly-once key + recipient + orders", () => {
  const p = buildForcePayload({ toUserId: "u1", orderIds: ["b", "a"], clientOpId: "op-1" });
  assert.equal(p.client_op_id, "op-1");
  assert.equal(p.to_user_id, "u1");
  assert.deepEqual(p.order_ids, ["b", "a"]);
  assert.ok(!("note" in p)); // blank note omitted
  // a generated id is produced when none is supplied
  const p2 = buildForcePayload({ toUserId: "u1", orderIds: ["a"] });
  assert.equal(typeof p2.client_op_id, "string");
  assert.ok((p2.client_op_id as string).length >= 32);
});

test("buildCancelPayload requires an integer expected_version and carries the op key", () => {
  const p = buildCancelPayload({ transferId: "t1", expectedVersion: 3, clientOpId: "op-c" });
  assert.equal(p.transfer_id, "t1");
  assert.equal(p.expected_version, 3);
  assert.equal(p.client_op_id, "op-c");
  assert.throws(() => buildCancelPayload({ transferId: "t1", expectedVersion: Number.NaN as unknown as number }), /valid expected version/i);
});

test("buildReapprovePayload OMITS the target shift unless a concrete one is given (never an empty string)", () => {
  const auto = buildReapprovePayload({ transferId: "t1", expectedVersion: 2 });
  assert.ok(!("target_shift_id" in auto), "no target => server auto-resolves the recipient's open shift");
  const blank = buildReapprovePayload({ transferId: "t1", expectedVersion: 2, targetShiftId: "" });
  assert.ok(!("target_shift_id" in blank), "an empty string is never sent as a shift id");
  const pinned = buildReapprovePayload({ transferId: "t1", expectedVersion: 2, targetShiftId: "shift-9" });
  assert.equal(pinned.target_shift_id, "shift-9");
  assert.equal(typeof pinned.reapprove_client_token, "string");
  assert.throws(() => buildReapprovePayload({ transferId: "t1", expectedVersion: 1.5 }), /valid expected version/i);
});

// --- Manage mutation lifecycle (pure reducer) -------------------------------

const reduce = (s: ManageState, ...events: Parameters<typeof manageReducer>[1][]): ManageState =>
  events.reduce((acc, e) => manageReducer(acc, e), s);

test("manageReducer SERIALIZES: a second begin/confirm is a no-op while a mutation is in flight", () => {
  const busy = manageReducer(initialManageState, { t: "begin_start", transferId: "t1", action: "cancel" });
  assert.deepEqual(busy.busy, { transferId: "t1", action: "cancel" });
  // a second begin while busy returns the SAME state object (ignored)
  assert.equal(manageReducer(busy, { t: "begin_start", transferId: "t2", action: "cancel" }), busy);
  // and a confirm_start while busy is likewise ignored
  assert.equal(manageReducer(busy, { t: "confirm_start", transferId: "t2", action: "cancel" }), busy);
});

test("manageReducer SNAPSHOTS at begin_ok, RETAINS on confirm_fail (replay), and CONSUMES on confirm_ok", () => {
  const key = intentKey("t1", "cancel");
  // begin -> ok : snapshot captured, confirm step revealed, no longer busy
  const ready = reduce(initialManageState,
    { t: "begin_start", transferId: "t1", action: "cancel" },
    { t: "begin_ok", transferId: "t1", action: "cancel", snapshot: { opId: "op-1", expectedVersion: 4 } });
  assert.deepEqual(ready.intents[key], { opId: "op-1", expectedVersion: 4 });
  assert.deepEqual(ready.step, { transferId: "t1", action: "cancel" });
  assert.equal(ready.busy, null);
  // confirm -> FAIL (uncertain): step AND snapshot RETAINED so an identical retry replays
  const failed = reduce(ready,
    { t: "confirm_start", transferId: "t1", action: "cancel" },
    { t: "confirm_fail", transferId: "t1", action: "cancel", error: "network lost" });
  assert.deepEqual(failed.intents[key], { opId: "op-1", expectedVersion: 4 }); // unchanged
  assert.deepEqual(failed.step, { transferId: "t1", action: "cancel" });        // still actionable
  assert.equal(failed.error, "network lost");
  assert.equal(failed.busy, null);
  // retry -> OK : snapshot CONSUMED, step cleared
  const done = reduce(failed,
    { t: "confirm_start", transferId: "t1", action: "cancel" },
    { t: "confirm_ok", transferId: "t1", action: "cancel" });
  assert.equal(done.intents[key], undefined);
  assert.equal(done.step, null);
  assert.equal(done.busy, null);
});

test("manageReducer: confirm with no snapshot expires the step; abandon drops it; reset clears everything", () => {
  const expired = manageReducer({ ...initialManageState, step: { transferId: "t1", action: "cancel" } },
    { t: "confirm_start", transferId: "t1", action: "cancel" });
  assert.equal(expired.step, null);
  assert.match(expired.error ?? "", /expired/i);
  // a second (interleaved) transfer's intent is independent and not clobbered by the first
  const two = reduce(initialManageState,
    { t: "begin_start", transferId: "tA", action: "cancel" },
    { t: "begin_ok", transferId: "tA", action: "cancel", snapshot: { opId: "a", expectedVersion: 1 } },
    { t: "abandon", transferId: "tA", action: "cancel" },
    { t: "begin_start", transferId: "tB", action: "reapprove" },
    { t: "begin_ok", transferId: "tB", action: "reapprove", snapshot: { opId: "b", expectedVersion: 2 } });
  assert.equal(two.intents[intentKey("tA", "cancel")], undefined); // abandoned
  assert.deepEqual(two.intents[intentKey("tB", "reapprove")], { opId: "b", expectedVersion: 2 });
  assert.deepEqual(manageReducer(two, { t: "reset" }), initialManageState); // context close clears all
});

test("manageReducer IGNORES late/stale resolutions that do not match the active operation", () => {
  // A begin for t1 is in flight; a reset (context close) clears it; a LATE begin_ok for t1 must be ignored.
  const afterReset = reduce(initialManageState,
    { t: "begin_start", transferId: "t1", action: "cancel" },
    { t: "reset" },
    { t: "begin_ok", transferId: "t1", action: "cancel", snapshot: { opId: "late", expectedVersion: 9 } });
  assert.deepEqual(afterReset, initialManageState); // the late completion did not repopulate state
  // A confirm for t1 is in flight; a FOREIGN confirm_ok for t2 must not resolve t1's busy/step.
  const busyT1 = reduce(initialManageState,
    { t: "begin_start", transferId: "t1", action: "cancel" },
    { t: "begin_ok", transferId: "t1", action: "cancel", snapshot: { opId: "o1", expectedVersion: 1 } },
    { t: "confirm_start", transferId: "t1", action: "cancel" });
  const foreign = manageReducer(busyT1, { t: "confirm_ok", transferId: "t2", action: "cancel" });
  assert.equal(foreign, busyT1); // unchanged — foreign resolution ignored
  // abandon is refused while busy (cannot drop an in-flight intent)
  assert.equal(manageReducer(busyT1, { t: "abandon", transferId: "t1", action: "cancel" }), busyT1);
});

test("manageReducer refuses a NEW begin while an unresolved (retained) intent exists — lifecycle serialize", () => {
  // t1 confirm failed → snapshot retained, not busy. Starting a NEW intent (t2) must be a no-op so the
  // retained replay snapshot can never be hidden/overwritten by a second lifecycle.
  const retained = reduce(initialManageState,
    { t: "begin_start", transferId: "t1", action: "cancel" },
    { t: "begin_ok", transferId: "t1", action: "cancel", snapshot: { opId: "o1", expectedVersion: 1 } },
    { t: "confirm_start", transferId: "t1", action: "cancel" },
    { t: "confirm_fail", transferId: "t1", action: "cancel", error: "lost" });
  assert.equal(retained.busy, null);
  assert.ok(retained.intents[intentKey("t1", "cancel")]);
  assert.equal(manageReducer(retained, { t: "begin_start", transferId: "t2", action: "reapprove" }), retained); // no-op
  // only after abandoning t1 can a new lifecycle begin
  const freed = manageReducer(retained, { t: "abandon", transferId: "t1", action: "cancel" });
  const begun = manageReducer(freed, { t: "begin_start", transferId: "t2", action: "reapprove" });
  assert.deepEqual(begun.busy, { transferId: "t2", action: "reapprove" });
});

test("nextOpId reuses the id for an identical fingerprint (safe replay) and rotates on change", () => {
  const a = nextOpId(null, "fp-1");
  const aRetry = nextOpId(a, "fp-1"); // identical intent → same id (a lost response replays)
  assert.equal(aRetry.id, a.id);
  assert.equal(aRetry, a); // returns the same object, no rotation
  const b = nextOpId(a, "fp-2"); // changed intent → fresh id (no collision with the server binding/CAS)
  assert.notEqual(b.id, a.id);
  assert.equal(b.fp, "fp-2");
  // stable per-intent key semantics (cancel/reapprove): same (action,transfer) key => same id across retries
  const c1 = nextOpId(null, "cancel:tX");
  const c2 = nextOpId(c1, "cancel:tX");
  assert.equal(c2.id, c1.id);
  const d = nextOpId(c2, "reapprove:tX"); // different action => different key => rotates
  assert.notEqual(d.id, c1.id);
});
