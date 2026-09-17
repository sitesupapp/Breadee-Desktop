// Durable crash/restart journal for ONE unresolved online order submit.
//
// WHY THIS EXISTS
// `state/cart.ts` already mints, holds, reuses and clears a `client_op_id`, and
// `pos_submit_order` is idempotent on it (m224). That protects every SAME-SESSION
// ambiguity — double click, network retry, rerender, modal, navigation. What it
// does NOT survive is the process dying between "request sent" and "response
// received": the cart (and its `client_op_id`) is in-memory, so a restart would
// mint a NEW id for a rebuilt basket and duplicate an order that already
// committed.
//
// This module closes exactly that window and nothing more. Immediately before the
// remote submit it durably records `{ client_op_id, exact payload, context }`; on
// a definitive outcome it deletes the record; on a transport-ambiguous failure it
// LEAVES it, so a later startup can reconcile the SAME id with the SAME payload.
//
// It is NOT the offline outbox. It never calls `enqueue()`, never touches
// `sync.ts`, never queues offline work and never replays on its own — replay is an
// explicit cashier action (see PosWorkspace "Resolve pending order").

import { localdb, type InflightSubmit } from "@/lib/offline/db";

/** The tenant/branch/terminal an unresolved submit belongs to. */
export type SubmitContext = {
  tenant_id: string;
  branch_id: string | null;
  terminal_id: string | null;
  device_id: string | null;
};

/**
 * A NEW logical submit was attempted while a DIFFERENT unresolved submit still
 * exists for this context. The financial state of the earlier operation is
 * unknown, so it must be reconciled (or explicitly resolved) first — it is never
 * overwritten. Carries the blocking id so the caller can point the operator at it.
 */
export class UnresolvedSubmitExistsError extends Error {
  readonly pendingClientOpId: string;
  constructor(pendingClientOpId: string) {
    super("A previous order is still unverified. Resolve the pending order before starting another.");
    this.name = "UnresolvedSubmitExistsError";
    this.pendingClientOpId = pendingClientOpId;
  }
}

function sameContext(a: Pick<InflightSubmit, "tenant_id" | "branch_id">, b: SubmitContext): boolean {
  return a.tenant_id === b.tenant_id && (a.branch_id ?? null) === (b.branch_id ?? null);
}

/**
 * Journal an about-to-be-sent submit. Call this AND AWAIT it BEFORE the RPC.
 *
 * Idempotent for the SAME `client_op_id`: a same-session retry re-enters here with
 * the id already present and the ORIGINAL immutable payload is kept (never
 * overwritten from a possibly-changed cart). A DIFFERENT id while an unresolved
 * one exists for this context throws `UnresolvedSubmitExistsError` — unresolved
 * financial state is never overwritten.
 */
export async function beginInflightSubmit(input: {
  client_op_id: string;
  payload: unknown;
  ctx: SubmitContext;
}): Promise<void> {
  await localdb.transaction("rw", localdb.inflightSubmits, async () => {
    const same = await localdb.inflightSubmits.get(input.client_op_id);
    if (same) return; // same logical op; the first persisted payload is authoritative
    const others = await localdb.inflightSubmits.where("tenant_id").equals(input.ctx.tenant_id).toArray();
    const conflict = others.find((o) => sameContext(o, input.ctx) && o.client_op_id !== input.client_op_id);
    if (conflict) throw new UnresolvedSubmitExistsError(conflict.client_op_id);
    await localdb.inflightSubmits.add({
      client_op_id: input.client_op_id,
      payload: input.payload,
      tenant_id: input.ctx.tenant_id,
      branch_id: input.ctx.branch_id,
      terminal_id: input.ctx.terminal_id,
      device_id: input.ctx.device_id,
      status: "submitting",
      created_at: new Date().toISOString(),
    });
  });
}

/** Retire a submit whose outcome is definitively known (committed, or a certain
 * non-commit refusal). Safe to call when nothing is journaled. */
export async function clearInflightSubmit(clientOpId: string): Promise<void> {
  await localdb.inflightSubmits.delete(clientOpId);
}

/**
 * The unresolved submit for the CURRENT context, if any. Scoped by tenant + branch
 * so one tenant/branch's pending order is never surfaced — or replayed — under
 * another. RLS remains the server-side boundary on top of this.
 */
export async function getUnresolvedSubmit(tenantId: string, branchId: string | null): Promise<InflightSubmit | null> {
  if (!tenantId) return null;
  const rows = await localdb.inflightSubmits.where("tenant_id").equals(tenantId).toArray();
  const match = rows.find((r) => (r.branch_id ?? null) === (branchId ?? null));
  return match ?? null;
}

/** True when a journal entry belongs to the given authenticated context. */
export function inflightMatchesContext(entry: InflightSubmit, ctx: SubmitContext): boolean {
  return sameContext(entry, ctx);
}
