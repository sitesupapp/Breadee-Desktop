// Join a floor PLACEMENT (geometry) to a table's OPERATIONAL state.
//
// The two are deliberately separate sources: the placement says "where this
// table appears" (from the published floor doc); the operational state — free /
// active bill / total / elapsed — comes from `pos_table_map`, the SAME canonical
// read the List uses. Operational status is NEVER inferred from geometry.
//
// A placement can reference a table that `pos_table_map` no longer returns (it
// was deactivated after the floor was published). That is not an error and must
// not crash the floor: the node renders as a neutral, dimmed "unavailable" tile
// that cannot be opened, and the operator republishes the floor when convenient.

import type { FloorElement, FloorTableShape } from "@/lib/pos/floor";
import { elapsedMinutes, formatElapsed, tableCardState } from "@/lib/pos/tables";
import type { TableCardState, TableSummary } from "@/types/tables";

export type FloorNodeModel = {
  element: FloorElement;
  tableId: string;
  /** Operational row, or null when the placed table is no longer on the map. */
  table: TableSummary | null;
  /** Canonical card state; "unknown" when the table is missing from the map. */
  state: TableCardState;
  /** The tenant's own label, verbatim — never re-derived. */
  name: string;
  seats: number | null;
  /** "1h 20m" / "5m" style, or null when there is no open bill. */
  elapsedLabel: string | null;
  orders: number;
  total: number | null;
  currency: TableSummary["currency"];
  mixedCurrency: boolean;
  /** True when this placement points at a table absent from the current map. */
  missing: boolean;
};

/**
 * Build a node model for one table placement.
 *
 * `now` drives the elapsed badge; it is passed in (not read from the clock) so
 * the mapping is deterministic under test. A non-table element must never be
 * passed here — callers render structures separately.
 */
export function buildFloorNode(
  element: FloorElement,
  tableById: Map<string, TableSummary>,
  now: number,
): FloorNodeModel {
  const tableId = element.tableId ?? "";
  const table = tableId ? tableById.get(tableId) ?? null : null;
  if (!table) {
    return {
      element,
      tableId,
      table: null,
      state: "unknown",
      name: element.label ?? "Table",
      seats: null,
      elapsedLabel: null,
      orders: 0,
      total: null,
      currency: null,
      mixedCurrency: false,
      missing: true,
    };
  }
  const state: TableCardState = tableCardState(table);
  return {
    element,
    tableId,
    table,
    state,
    name: table.name,
    seats: table.seats,
    elapsedLabel: formatElapsed(elapsedMinutes(table.opened_at, now)),
    orders: table.orders,
    total: table.total,
    currency: table.currency,
    mixedCurrency: table.mixed_currency,
    missing: false,
  };
}

/** Index a table map by id for O(1) placement joins. */
export function indexTables(tables: TableSummary[]): Map<string, TableSummary> {
  const m = new Map<string, TableSummary>();
  for (const t of tables) m.set(t.id, t);
  return m;
}

/**
 * Corner-radius as a fraction of the node's shorter side, per shape. A circle/
 * oval is 0.5 (fully round on that axis); rectangles get a soft radius; an
 * unknown/absent shape falls back to the safe rounded rectangle (never crashes,
 * never a hard-edged CAD box).
 */
export function shapeRadiusFraction(shape: FloorTableShape | null): number {
  switch (shape) {
    case "round":
    case "oval":
      return 0.5;
    case "lounge":
      return 0.32;
    case "sq":
    case "high":
      return 0.14;
    case "bar":
      return 0.16;
    case "rect":
    case "rect6":
    case "rect8":
    case "r4":
    case "r6":
      return 0.12;
    default:
      // Unknown future shape — safe rounded rectangle.
      return 0.12;
  }
}

/** A human label for the shape (accessibility / debugging), safe for unknowns. */
export function shapeLabel(shape: FloorTableShape | null): string {
  switch (shape) {
    case "round": return "round";
    case "oval": return "oval";
    case "sq": return "square";
    case "rect": case "rect6": case "rect8": return "rectangle";
    case "r4": case "r6": return "rounded";
    case "high": return "high-top";
    case "bar": return "bar";
    case "lounge": return "lounge";
    default: return "table";
  }
}
