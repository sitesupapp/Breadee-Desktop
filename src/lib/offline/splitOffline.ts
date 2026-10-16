// Phase D (D3) — offline SPLIT capture + local projection.
//
// Turns a split selection into a durable split_settle leg while offline, and keeps a restart-safe
// local projection of remaining quantities so the cashier sees split progress immediately. The
// server (pos_split_settle) stays the authoritative settlement amount — the local amount is a UI
// projection only, never persisted as the payment value. Legs replay strictly in order (each new
// leg depends on the previous leg for the same bill). Deterministic client_op_id (content-addressed
// by order + sorted allocations + method) makes a double-tap / restart exactly-once.
//
// STEP 1 here covers a HYDRATED bill (its split state — order + canonical order_item_ids + already-
// allocated quantities — was cached online). A fully-offline-created session's items have no server
// ids yet; that path is captured with local line ids + resolved via the generic entityMap once the
// round syncs (added with the item-id mapping increment); this module exposes orderLocal/migOpId +
// a per-line canonical/local id so the same capture serves both.

import { localdb, cacheSplitState, readSplitState } from "@/lib/offline/db";
import { type OfflineOperation, OPERATION_SCHEMA_VERSION, getOperation } from "@/lib/offline/operationLog";
import type { OperationScope } from "@/lib/offline/operationLog";
import { deterministicUuid } from "@/lib/offline/dineinOffline";

export type SplitScope = {
  tenantId: string;
  branchId: string | null;
  cashierUserId: string;
  deviceId: string;
  terminalId: string | null;
};

function opScope(s: SplitScope): OperationScope {
  return { tenant_id: s.tenantId, branch_id: s.branchId, device_id: s.deviceId, terminal_id: s.terminalId ?? "", cashier_user_id: s.cashierUserId };
}

/** One bill line in the cached split state. `order_item_id` is the canonical id (hydrated bill);
 *  `allocated_qty` is what the SERVER already allocated to prior (synced) splits. */
export type CachedSplitLine = {
  order_item_id: string;
  name: string;
  original_qty: number;
  allocated_qty: number;
  final_unit_price: number;
};

export type CachedSplit = {
  order_id: string;
  order_number: string | null;
  table_id: string | null;
  currency: string;
  pos_entity_version: number | null;
  lines: CachedSplitLine[];
};

/** Mirror a bill's split state for offline use (call after a successful ONLINE split-state load). */
export async function cacheSplitForOffline(scope: SplitScope, split: CachedSplit): Promise<void> {
  await cacheSplitState(split.order_id, split, scope.tenantId, scope.branchId);
}

const SPLIT_OP_PREFIX = "split:";

function inScope(op: OfflineOperation, s: SplitScope): boolean {
  return (
    op.scope.tenant_id === s.tenantId &&
    (op.scope.branch_id ?? null) === (s.branchId ?? null) &&
    op.scope.cashier_user_id === s.cashierUserId &&
    op.scope.device_id === s.deviceId &&
    (s.terminalId == null || (op.scope.terminal_id || null) === s.terminalId)
  );
}

/** The locally-captured (not-cancelled) split_settle legs for a bill, in capture order. */
async function localLegsForOrder(orderId: string, scope: SplitScope): Promise<OfflineOperation[]> {
  const rows = await localdb.operations.where("operation_type").equals("split_settle").toArray();
  return rows
    .filter((o) => o.status !== "cancelled" && inScope(o, scope) && (o.payload as { order_id?: string } | null)?.order_id === orderId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export type SplitRemainingLine = {
  order_item_id: string;
  name: string;
  original_qty: number;
  server_allocated: number;
  local_allocated: number;
  remaining: number;
  final_unit_price: number;
};

/**
 * The restart-safe local split projection for a bill: remaining qty per line = original −
 * (server-already-allocated + locally-captured legs). Null when the bill has no cached split state
 * (→ the UI must require reconnect for that bill). Operational continuity only.
 */
export async function localSplitRemaining(orderId: string, scope: SplitScope): Promise<{ orderId: string; orderNumber: string | null; currency: string; lines: SplitRemainingLine[] } | null> {
  const cached = await readSplitState(orderId, scope.tenantId, scope.branchId);
  if (!cached) return null;
  const split = cached.state as CachedSplit;
  const legs = await localLegsForOrder(orderId, scope);
  const localByItem = new Map<string, number>();
  for (const leg of legs) {
    const allocs = ((leg.payload as { allocations?: { order_item_id: string; quantity: number }[] } | null)?.allocations) ?? [];
    for (const a of allocs) localByItem.set(a.order_item_id, (localByItem.get(a.order_item_id) ?? 0) + Number(a.quantity));
  }
  const lines: SplitRemainingLine[] = split.lines.map((l) => {
    const local = localByItem.get(l.order_item_id) ?? 0;
    const remaining = Math.max(0, l.original_qty - l.allocated_qty - local);
    return { order_item_id: l.order_item_id, name: l.name, original_qty: l.original_qty, server_allocated: l.allocated_qty, local_allocated: local, remaining, final_unit_price: l.final_unit_price };
  });
  return { orderId, orderNumber: split.order_number, currency: split.currency, lines };
}

export type SplitAllocationLine = { order_item_id: string; quantity: number };

export type CaptureSplitResult =
  | { ok: true; operationId: string; clientOpId: string; alreadyCaptured: boolean }
  | { ok: false; reason: string };

/**
 * Durably capture ONE offline split leg. Validates the requested allocation against the LOCAL
 * remaining projection (never locally over-allocates), chains after the previous leg for this bill
 * (strict replay order), and is idempotent on a content-addressed client_op_id (double-tap /
 * restart → one leg). The server re-validates remaining qty + derives the amount on replay.
 */
export async function splitSettleOffline(input: {
  scope: SplitScope;
  orderId: string;
  orderNumber?: string | null;
  allocations: SplitAllocationLine[];
  method: string;
  currency: string;
}): Promise<CaptureSplitResult> {
  const { scope, orderId } = input;
  const allocs = input.allocations.filter((a) => Number(a.quantity) > 0);
  if (allocs.length === 0) return { ok: false, reason: "Select at least one item to split." };

  const remaining = await localSplitRemaining(orderId, scope);
  if (!remaining) return { ok: false, reason: "This bill isn't available offline. Reconnect to split it." };
  // Local over-allocation guard (the server is authoritative, but never capture a doomed leg).
  for (const a of allocs) {
    const line = remaining.lines.find((l) => l.order_item_id === a.order_item_id);
    if (!line) return { ok: false, reason: "A selected line is not part of this bill." };
    if (Number(a.quantity) > line.remaining) return { ok: false, reason: `Only ${line.remaining} of "${line.name}" remain to split.` };
  }

  const sorted = [...allocs].sort((x, y) => x.order_item_id.localeCompare(y.order_item_id));
  const allocKey = sorted.map((a) => `${a.order_item_id}:${a.quantity}`).join(",");
  const clientOpId = deterministicUuid([scope.tenantId, scope.branchId ?? "", scope.cashierUserId, scope.deviceId, scope.terminalId ?? "", "split_settle", orderId, input.method, allocKey]);
  const operationId = SPLIT_OP_PREFIX + clientOpId;

  return localdb.transaction("rw", localdb.operations, async () => {
    const existing = await getOperation(operationId);
    if (existing) return { ok: true, operationId, clientOpId, alreadyCaptured: true };
    const legs = await localLegsForOrder(orderId, scope);
    const prevLegOpId = legs.length > 0 ? legs[legs.length - 1].operation_id : null;
    const op: OfflineOperation = {
      operation_id: operationId,
      operation_type: "split_settle",
      schema_version: OPERATION_SCHEMA_VERSION,
      scope: opScope(scope),
      created_at: new Date().toISOString(),
      client_op_id: clientOpId,
      local_entity_id: null,
      canonical_entity_id: orderId,
      // Strict leg order: each leg waits for the previous leg of this bill to sync.
      dependency_ids: prevLegOpId ? [prevLegOpId] : [],
      depends_on_local_entities: [],
      payload: {
        order_id: orderId,
        order_local: null,
        method: input.method,
        currency: input.currency,
        allocations: sorted,
        expected_version: null, // NULL offline — allocation-remaining + state checks are the guard
        split_seq: legs.length + 1,
        order_number: input.orderNumber ?? remaining.orderNumber,
      },
      status: "pending",
      retry_count: 0,
      last_attempt_at: null,
      last_error_code: null,
      last_error_message: null,
      result_meta: null,
      synced_at: null,
    };
    await localdb.operations.add(op);
    return { ok: true, operationId, clientOpId, alreadyCaptured: false };
  });
}
