// Floor Map search: find a placed table by its name or (when the map supplies
// one) its open order number, across every section. Pure and section-aware — the
// caller uses the returned `sectionId` to activate the right section, bring the
// table into view, and flash the search halo. Selection remains a separate act.

import type { FloorLayout } from "@/lib/pos/floor";
import type { TableSummary } from "@/types/tables";

export type FloorSearchMatch = {
  tableId: string;
  sectionId: string;
  name: string;
  orderNumber: string | null;
};

/**
 * Matches for a query, in section order then name order. A blank query yields no
 * matches (the floor shows normally; search is opt-in). Matching is a
 * case-insensitive substring on the tenant's own table name, and on the open
 * order number when `pos_table_map` returned one — the same fields the List
 * search already exposes, so the two behave alike. Only tables actually PLACED on
 * the floor can match; a table absent from the published doc has no location to
 * navigate to.
 */
export function searchFloor(layout: FloorLayout, tables: TableSummary[], query: string): FloorSearchMatch[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  const byId = new Map<string, TableSummary>();
  for (const t of tables) byId.set(t.id, t);

  const seen = new Set<string>();
  const matches: FloorSearchMatch[] = [];
  for (const e of layout.elements) {
    if (e.type !== "table" || !e.tableId) continue;
    if (seen.has(e.tableId)) continue;
    const table = byId.get(e.tableId);
    // A placement whose table is no longer on the map still matches by the
    // placement's own label so the operator can at least locate the tile.
    const name = table?.name ?? e.label ?? "";
    const orderNumber = table?.order_number ?? null;
    const nameHit = name.toLowerCase().includes(q);
    const orderHit = orderNumber != null && orderNumber.toLowerCase().includes(q);
    if (!nameHit && !orderHit) continue;
    seen.add(e.tableId);
    matches.push({ tableId: e.tableId, sectionId: e.sectionId, name, orderNumber });
  }
  return matches;
}

/** The section a given table is placed in, or null when it is not on the floor. */
export function sectionOfTable(layout: FloorLayout, tableId: string): string | null {
  for (const e of layout.elements) {
    if (e.type === "table" && e.tableId === tableId) return e.sectionId;
  }
  return null;
}
