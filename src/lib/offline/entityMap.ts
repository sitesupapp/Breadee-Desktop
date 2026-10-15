// Phase B — the generalized temp-id -> canonical-id dependency engine.
//
// Generalizes Phase A's single shift->order remap into a reusable mechanism that any
// future chain can use WITHOUT new engine code:
//   LOCAL SHIFT -> LOCAL ORDER -> LOCAL PAYMENT
//   LOCAL CUSTOMER -> LOCAL ADDRESS -> LOCAL DELIVERY ORDER
//   LOCAL TABLE/BILL -> LOCAL ROUND -> LOCAL ORDER -> LOCAL PAYMENT
//
// Invariants (do not weaken):
//   * local ids are IMMUTABLE; a resolved mapping is write-once (idempotent canonicalization).
//   * a dependent op cannot proceed until every prerequisite local id is resolved.
//   * the map is durable (survives restart/crash).
//   * a circular dependency is detected and reported (caller quarantines).
//   * a missing/unresolvable dependency is reported as blocked, never silently dropped.
//
// Phase B ships ONLY this machinery + its tests. No future business handler is wired to
// a multi-level chain yet (the one live chain remains shift->order, via the compat handler).

import { localdb } from "@/lib/offline/db";
import type { OfflineOperation } from "@/lib/offline/operationLog";

/** A durable local->canonical mapping row. PK = local_entity_id. Write-once on resolve.
 *  Carries the FULL immutable scope that created it, so a lookup can fail closed when the
 *  live scope differs — a mapping from another tenant/branch/OU/cashier/device/terminal
 *  must NEVER satisfy a dependency or leak its canonical id into another context's replay. */
export interface EntityMapping {
  local_entity_id: string;
  entity_type: string; // "shift" | "order" | "customer" | "address" | "table" | ...
  canonical_id: string;
  resolved_at: string;
  tenant_id: string;
  branch_id: string | null;
  device_id: string;
  cashier_user_id: string;
  terminal_id: string | null;
}

/** True when a mapping was created under EXACTLY the given immutable scope (all dimensions).
 *  Used to fail closed on cross-context resolution. */
export function scopeMatchesMapping(m: EntityMapping, scope: OfflineOperation["scope"]): boolean {
  return (
    m.tenant_id === scope.tenant_id &&
    (m.branch_id ?? null) === (scope.branch_id ?? null) &&
    m.device_id === scope.device_id &&
    m.cashier_user_id === scope.cashier_user_id &&
    (m.terminal_id ?? null) === (scope.terminal_id ?? null)
  );
}

/** Record a local->canonical resolution. Idempotent: re-resolving to the SAME id is a
 *  no-op; a DIFFERENT id for an already-resolved local entity is refused (returns false)
 *  so canonicalization can never be silently rewritten. */
export async function resolveEntity(m: EntityMapping): Promise<boolean> {
  return localdb.transaction("rw", localdb.entityMap, async () => {
    const existing = await localdb.entityMap.get(m.local_entity_id);
    if (existing) return existing.canonical_id === m.canonical_id; // idempotent / refuse divergent
    await localdb.entityMap.add(m);
    return true;
  });
}

/** The canonical id for a local entity, or null if unresolved. */
export async function canonicalIdFor(localEntityId: string): Promise<string | null> {
  const row = await localdb.entityMap.get(localEntityId);
  return row ? row.canonical_id : null;
}

/** The canonical id for a local entity ONLY when its mapping was created under exactly the
 *  given immutable scope; otherwise null. This is the fail-closed lookup replay uses so a
 *  foreign-scope mapping can never be returned or remapped into this context. */
export async function canonicalIdForInScope(
  localEntityId: string,
  scope: OfflineOperation["scope"],
): Promise<string | null> {
  const row = await localdb.entityMap.get(localEntityId);
  return row && scopeMatchesMapping(row, scope) ? row.canonical_id : null;
}

/** Bulk lookup of canonical ids for a set of local entity ids. */
export async function canonicalIds(localEntityIds: string[]): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const id of localEntityIds) out[id] = await canonicalIdFor(id);
  return out;
}

export type DependencyState =
  | { ready: true }
  | { ready: false; reason: "blocked"; unresolved: string[] }
  | { ready: false; reason: "dependency_failed"; failed: string[] }
  | { ready: false; reason: "circular"; cycle: string[] }
  | { ready: false; reason: "missing"; missing: string[] };

/**
 * Decide whether `op` may replay now, given the full operation set (by id) and the
 * durable entity map. Pure (no writes). An op is READY when:
 *   - every operation in dependency_ids is `synced`, AND
 *   - every local entity in depends_on_local_entities has a canonical id.
 * Detects a circular dependency among operations and reports an operation whose declared
 * dependency id does not exist (missing) so the caller can quarantine rather than wait forever.
 */
export function evaluateDependencies(
  op: OfflineOperation,
  byId: Map<string, OfflineOperation>,
  resolvedLocalEntities: Set<string>,
): DependencyState {
  // 1. Circular-dependency detection over the operation dependency graph (DFS).
  const cycle = findCycle(op.operation_id, byId);
  if (cycle) return { ready: false, reason: "circular", cycle };

  // 2. Missing declared operation dependencies.
  const missing = op.dependency_ids.filter((d) => !byId.has(d));
  if (missing.length) return { ready: false, reason: "missing", missing };

  // 3. SCOPE guard: a prerequisite that belongs to a DIFFERENT scope
  //    (tenant/OU-branch/device/cashier) than the dependent is cross-context
  //    contamination — fail CLOSED (never resolve/remap across scopes), even if that
  //    prerequisite is already synced. This preserves the Phase-A rule that a shift's
  //    canonical id never leaks into another context's replay.
  const sameScope = (a: OfflineOperation["scope"], b: OfflineOperation["scope"]) =>
    a.tenant_id === b.tenant_id &&
    (a.branch_id ?? null) === (b.branch_id ?? null) &&
    a.device_id === b.device_id &&
    a.cashier_user_id === b.cashier_user_id;
  const scopeMismatch = op.dependency_ids.filter((d) => !sameScope(byId.get(d)!.scope, op.scope));
  if (scopeMismatch.length) return { ready: false, reason: "dependency_failed", failed: scopeMismatch };

  // 4. A prerequisite that reached a TERMINAL non-synced state (needs_attention /
  //    cancelled) can never resolve — the dependent must itself go needs_attention
  //    rather than wait forever.
  const failed = op.dependency_ids.filter((d) => {
    const s = byId.get(d)!.status;
    return s === "needs_attention" || s === "cancelled";
  });
  if (failed.length) return { ready: false, reason: "dependency_failed", failed };

  // 4. Unsynced operation prerequisites OR unresolved local-entity prerequisites.
  const unsyncedDeps = op.dependency_ids.filter((d) => byId.get(d)!.status !== "synced");
  const unresolvedEntities = op.depends_on_local_entities.filter((e) => !resolvedLocalEntities.has(e));
  const unresolved = [...unsyncedDeps, ...unresolvedEntities];
  if (unresolved.length) return { ready: false, reason: "blocked", unresolved };

  return { ready: true };
}

/** DFS cycle detection starting from `start` over dependency_ids edges. Returns the cycle path or null. */
function findCycle(start: string, byId: Map<string, OfflineOperation>): string[] | null {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];

  function visit(id: string): string[] | null {
    const node = byId.get(id);
    if (!node) return null; // missing handled separately
    color.set(id, GRAY);
    stack.push(id);
    for (const dep of node.dependency_ids) {
      const c = color.get(dep) ?? WHITE;
      if (c === GRAY) {
        // Back-edge → cycle. Return the path from dep to current.
        const i = stack.indexOf(dep);
        return stack.slice(i).concat(dep);
      }
      if (c === WHITE) {
        const found = visit(dep);
        if (found) return found;
      }
    }
    color.set(id, BLACK);
    stack.pop();
    return null;
  }
  return visit(start);
}
