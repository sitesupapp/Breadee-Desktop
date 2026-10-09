// Desktop 1.0.35 (B2) — pure state machine for the Transfer Center "Manage" tab's mutation lifecycle.
//
// Extracted as a PURE reducer so the exactly-once + serialization + context invariants are unit-testable
// without a DOM/render harness (the desktop test runner has none). The component (ManageTab) drives this
// reducer and performs the RPC between a `*_start` and the resolving `*_ok` / `*_fail` event, so these are
// exactly the transitions that matter for safe replay:
//
//   • SERIALIZE — a begin/confirm is a NO-OP while any mutation is in flight (one at a time).
//   • SNAPSHOT  — the op id + expected_version are captured ONCE at begin_ok and kept in `intents`.
//   • REPLAY    — confirm_fail (uncertain outcome) KEEPS the step + the snapshot, so an identical retry
//                 replays; confirm_ok CONSUMES the snapshot so a fresh lifecycle re-snapshots.
//   • CONTEXT   — reset (surface close / context change) clears everything atomically.
//
// Authority is always the server's (the B1 RPCs are idempotent + CAS + permission/OU enforced); this only
// governs the client's retry ergonomics so an uncertain response can be replayed, never silently changed.

export type ManageAction = "cancel" | "reapprove";
export type IntentSnapshot = { opId: string; expectedVersion: number };

export type ManageState = {
  /** The mutation currently in flight (begin OR confirm), or null when idle. */
  busy: { transferId: string; action: ManageAction } | null;
  /** The row whose confirm step is open, or null. */
  step: { transferId: string; action: ManageAction } | null;
  /** Captured-once snapshots, keyed per (action, transfer). */
  intents: Record<string, IntentSnapshot>;
  error: string | null;
};

export const initialManageState: ManageState = { busy: null, step: null, intents: {}, error: null };

export function intentKey(transferId: string, action: ManageAction): string {
  return `${action}:${transferId}`;
}

export type ManageEvent =
  | { t: "begin_start"; transferId: string; action: ManageAction }
  | { t: "begin_ok"; transferId: string; action: ManageAction; snapshot: IntentSnapshot }
  | { t: "begin_fail"; transferId: string; action: ManageAction; error: string }
  | { t: "confirm_start"; transferId: string; action: ManageAction }
  | { t: "confirm_ok"; transferId: string; action: ManageAction }
  | { t: "confirm_fail"; transferId: string; action: ManageAction; error: string }
  | { t: "abandon"; transferId: string; action: ManageAction }
  | { t: "reset" };

function without(map: Record<string, IntentSnapshot>, key: string): Record<string, IntentSnapshot> {
  if (!(key in map)) return map;
  const next = { ...map };
  delete next[key];
  return next;
}

/** A resolution event (begin_ok/fail, confirm_ok/fail) is honoured ONLY if it resolves the operation that
 *  is actually in flight. A late completion arriving after a reset / context transition (state.busy now
 *  null or different) is IGNORED, so it can never repopulate or alter cleared state. */
function resolvesActive(s: ManageState, transferId: string, action: ManageAction): boolean {
  return !!s.busy && s.busy.transferId === transferId && s.busy.action === action;
}

export function manageReducer(s: ManageState, e: ManageEvent): ManageState {
  switch (e.t) {
    case "begin_start":
      // Serialize at the LIFECYCLE level: never start a new intent while one is in flight OR while an
      // earlier intent is still unresolved (a retained replay snapshot after an uncertain outcome). The
      // operator must resolve (retry to success) or explicitly abandon the outstanding one first.
      if (s.busy || Object.keys(s.intents).length > 0) return s;
      return { ...s, busy: { transferId: e.transferId, action: e.action }, error: null };
    case "begin_ok":
      if (!resolvesActive(s, e.transferId, e.action)) return s; // stale/foreign completion → ignore
      // Snapshot captured ONCE; reveal the confirm step.
      return {
        ...s,
        busy: null,
        step: { transferId: e.transferId, action: e.action },
        intents: { ...s.intents, [intentKey(e.transferId, e.action)]: e.snapshot },
      };
    case "begin_fail":
      if (!resolvesActive(s, e.transferId, e.action)) return s;
      return { ...s, busy: null, error: e.error };
    case "confirm_start":
      if (s.busy) return s; // serialize
      // Must have a snapshot to confirm; otherwise the intent expired — close the step.
      if (!s.intents[intentKey(e.transferId, e.action)]) return { ...s, step: null, error: "This action expired. Reload and try again." };
      return { ...s, busy: { transferId: e.transferId, action: e.action }, error: null };
    case "confirm_ok":
      if (!resolvesActive(s, e.transferId, e.action)) return s;
      // Consume the snapshot on acknowledged success; close the step.
      return { ...s, busy: null, step: null, intents: without(s.intents, intentKey(e.transferId, e.action)) };
    case "confirm_fail":
      if (!resolvesActive(s, e.transferId, e.action)) return s;
      // UNCERTAIN: keep the step AND the snapshot so an identical retry replays.
      return { ...s, busy: null, error: e.error };
    case "abandon":
      if (s.busy) return s; // cannot abandon an in-flight mutation
      return { ...s, step: null, intents: without(s.intents, intentKey(e.transferId, e.action)) };
    case "reset":
      return initialManageState;
    default:
      return s;
  }
}
