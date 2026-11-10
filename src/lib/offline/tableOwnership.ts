// 1.0.41 (Server Off F-OWN) — which tables THIS terminal may act on while Breadee's server is off.
//
// Approved policy: during a server outage several terminals keep trading with NO coordinator between them, so two
// tills must never take the same table. Each terminal is PRE-ASSIGNED, while online, the floor sections it serves
// (or "all tables" for a single-terminal site). Ownership is never inferred from a stale table map alone.
//
// While offline capture is active (server off), a table may be opened / added to / paid / split / moved / merged on
// this terminal only when:
//   - this terminal already holds the table's open local session (it opened or re-homed the bill here — proven by
//     its own durable session and operation log), or
//   - the table sits in a floor section assigned to this terminal (or the terminal serves all tables).
// Otherwise the table is view-only here. Online nothing changes: the server coordinates.
//
// NOT CONFIGURED (no assignment saved on this terminal — every restaurant on upgrade): the terminal keeps the
// 1.0.40 behaviour and may take any table, so no existing restaurant is blocked by the upgrade. The readiness
// indicator says so before an outage, and the server's table-version checks on replay still send a table taken on
// two tills to review (never a double charge). The restriction applies once a manager saves an assignment:
// "all tables", "only these sections", or "only tables already open on this terminal".
//
// The assignment is device-local (per tenant + branch), written only by a person with the setting permission.

import type { FloorLayout } from "@/lib/pos/floor";

export type ServerOffAssignment =
  | { mode: "all"; setAt: string; setBy: string | null }
  | { mode: "sections"; sectionIds: string[]; setAt: string; setBy: string | null }
  | { mode: "held"; setAt: string; setBy: string | null };

const KEY = (tenantId: string, branchId: string | null) => `breadee-desktop-serveroff-tables:${tenantId}:${branchId ?? "none"}`;

type StorageLike = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };
const store = (): StorageLike | null => {
  try {
    return (globalThis as { localStorage?: StorageLike }).localStorage ?? null;
  } catch {
    return null;
  }
};

export function readServerOffAssignment(tenantId: string | null, branchId: string | null): ServerOffAssignment | null {
  if (!tenantId) return null;
  try {
    const raw = store()?.getItem(KEY(tenantId, branchId));
    if (!raw) return null;
    const a = JSON.parse(raw) as ServerOffAssignment;
    if (a && (a.mode === "all" || a.mode === "held")) return a;
    if (a && a.mode === "sections" && Array.isArray(a.sectionIds)) return { ...a, sectionIds: a.sectionIds.filter((x) => typeof x === "string" && x !== "") };
    return null;
  } catch {
    return null;
  }
}

/** Save (or clear with null) this terminal's Server Off assignment. */
export function writeServerOffAssignment(
  tenantId: string,
  branchId: string | null,
  value: { mode: "all" } | { mode: "held" } | { mode: "sections"; sectionIds: string[] } | null,
  by: string | null,
): void {
  const s = store();
  if (!s) throw new Error("This device cannot save the setting.");
  if (value === null) {
    s.removeItem(KEY(tenantId, branchId));
    return;
  }
  const at = new Date().toISOString();
  const rec: ServerOffAssignment =
    value.mode === "sections" ? { mode: "sections", sectionIds: [...new Set(value.sectionIds)], setAt: at, setBy: by } : { mode: value.mode, setAt: at, setBy: by };
  s.setItem(KEY(tenantId, branchId), JSON.stringify(rec));
}

/** PURE — the published floor section a table sits in (null = not placed on the published floor). */
export function sectionOfTable(layout: Pick<FloorLayout, "elements"> | null | undefined, tableId: string | null | undefined): string | null {
  if (!layout || !tableId) return null;
  const e = layout.elements.find((x) => x.type === "table" && x.tableId === tableId);
  return e?.sectionId ?? null;
}

/** Who may change the assignment: the floor managers (the same people who decide the floor sections). */
export const OFFLINE_TABLES_PERMISSION = "pos.tables.floor_manage";

export const SERVER_OFF_NOT_ASSIGNED_MESSAGE =
  "Breadee's server is off and this terminal is set to continue only the tables already open on it. A manager can change this in Settings → Device → Offline tables.";
export const SERVER_OFF_OTHER_TERMINAL_MESSAGE =
  "Breadee's server is off and this table is served by another terminal. Use the terminal that serves it, so the same table is never taken on two tills.";

/** PURE — may THIS terminal act on the table while offline capture is active? */
export function serverOffOwnership(input: {
  assignment: ServerOffAssignment | null;
  hasLocalSession: boolean;
  sectionId: string | null;
}): { allowed: boolean; reason: string | null } {
  if (input.hasLocalSession) return { allowed: true, reason: null };
  const a = input.assignment;
  if (!a) return { allowed: true, reason: null }; // not configured → 1.0.40 behaviour (never blocks on upgrade)
  if (a.mode === "all") return { allowed: true, reason: null };
  if (a.mode === "held") return { allowed: false, reason: SERVER_OFF_NOT_ASSIGNED_MESSAGE };
  if (input.sectionId && a.sectionIds.includes(input.sectionId)) return { allowed: true, reason: null };
  return { allowed: false, reason: SERVER_OFF_OTHER_TERMINAL_MESSAGE };
}

/** PURE — the readiness note for this terminal's assignment (null = nothing to point out). */
export function assignmentReadinessNote(a: ServerOffAssignment | null): string | null {
  if (!a) return "Offline tables are not set for this terminal: while Breadee's server is off it can take any table, as before. If several terminals take table orders at this branch, assign each its tables in Settings → Device → Offline tables.";
  if (a.mode === "sections" && a.sectionIds.length === 0) return "This terminal's Server Off table assignment is empty.";
  return null;
}
