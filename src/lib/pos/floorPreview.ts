// Floor DESIGNER — Preview + publish-summary model (Phase 4). PURE: no React, no
// network, no store.
//
// PREVIEW is "what the floor will look like if published." It reuses the SERVICE
// renderer (`FloorCanvas` → `FloorObject`/`FloorTableNode`) by projecting the
// current DRAFT — including staged new tables and staged renames — into the exact
// shapes that renderer already consumes: `FloorElement[]` plus a synthetic
// `TableSummary[]` that carries only NAMES. It is deliberately structural: preview
// shows every table as a neutral, available tile, because a draft has no
// operational bill/elapsed/total to show and inventing one would lie. Crucially
// this never makes the Service Floor read the draft — Service still fetches the
// published revision only; preview is a separate, read-only projection.
//
// A staged NEW table has no canonical id yet, so preview gives it a SYNTHETIC id
// (its own draft element id) purely so the renderer can key a name to it; that id
// never leaves preview and is never sent anywhere.

import type { DesignerElement, TableMeta } from "@/lib/pos/floorDesigner";
import type { FloorElement } from "@/lib/pos/floor";
import type { TableSummary } from "@/types/tables";

/** Everything `FloorCanvas` needs to render one preview, per section. */
export type PreviewModel = {
  /** Render elements (tables carry a resolved id keyed to `tables` below). */
  elements: FloorElement[];
  /** Synthetic name carriers — available tiles, nothing operational. */
  tables: TableSummary[];
};

/** A table's preview name: a staged new name, a staged rename, or the canonical name. */
export function previewTableName(el: DesignerElement, meta: Map<string, TableMeta>): string {
  if (el.tempId !== null) return el.newName ?? "New table";
  const canonical = el.tableId ? meta.get(el.tableId)?.name ?? null : null;
  return el.renameTo ?? canonical ?? el.label ?? "";
}

function previewTableSeats(el: DesignerElement, meta: Map<string, TableMeta>): number | null {
  if (el.tempId !== null) return el.seats;
  return el.tableId ? meta.get(el.tableId)?.seats ?? null : null;
}

/** A neutral, available name-carrier — a draft has no bill/elapsed/total to show. */
function availableSummary(id: string, name: string, seats: number | null): TableSummary {
  return {
    id,
    name,
    seats,
    occupied: false,
    status: "available",
    canonical: true,
    configured: true,
    sort_order: null,
    orders: 0,
    order_number: null,
    opened_at: null,
    total: null,
    currency: null,
    mixed_currency: false,
  };
}

/**
 * Project the effective draft elements into the Service renderer's inputs. Tables
 * (staged or existing) become `FloorElement`s with a resolved id plus a matching
 * available `TableSummary`; structures pass through verbatim. Read-only by
 * construction — nothing here can be selected, opened, moved or published.
 */
export function buildPreviewModel(
  elements: DesignerElement[],
  meta: Map<string, TableMeta>,
): PreviewModel {
  const out: FloorElement[] = [];
  const tables: TableSummary[] = [];
  for (const el of elements) {
    if (el.type !== "table") {
      // A structure renders exactly as the service floor draws it.
      out.push({
        id: el.id,
        sectionId: el.sectionId,
        type: el.type,
        x: el.x,
        y: el.y,
        w: el.w,
        h: el.h,
        rotation: el.rotation,
        shape: null,
        tableId: null,
        label: el.label,
      });
      continue;
    }
    // A staged new table has no canonical id — key its name to the element id so
    // the renderer can label it; an existing table keeps its canonical id.
    const renderId = el.tableId ?? el.id;
    const name = previewTableName(el, meta);
    out.push({
      id: el.id,
      sectionId: el.sectionId,
      type: "table",
      x: el.x,
      y: el.y,
      w: el.w,
      h: el.h,
      rotation: el.rotation,
      shape: el.shape,
      tableId: renderId,
      label: name || null,
    });
    tables.push(availableSummary(renderId, name || "Table", previewTableSeats(el, meta)));
  }
  return { elements: out, tables };
}

// --- Publish summary (the confirmation preflight) ----------------------------

/** One staged rename, resolved to human names for the confirmation summary. */
export type RenameSummary = { from: string; to: string };

/**
 * The concise, human summary shown before Publish. Everything here is KNOWN from
 * the draft itself — staged new tables, staged renames, the structure count — so
 * it never guesses. The SERVER remains authoritative: it re-validates all of this
 * and owns the true blockers (open bill, hidden name collision, CAS). This is
 * convenience, not a second rule engine.
 */
export type PublishSummary = {
  /** Staged NEW tables the publish will create canonically, by name. */
  newTables: string[];
  /** Staged renames of existing tables, from → to. */
  renames: RenameSummary[];
  /** Non-table objects (walls, counters, text…) on the floor. */
  structureCount: number;
  /** Canonical tables NOT on the draft map (informational — the server blocks
   *  only those among them that carry an open bill). */
  unplacedNames: string[];
  /** Advisory layout warnings carried through from the designer. */
  overlaps: number;
  tight: number;
};

export function summarizePendingPublish(args: {
  elements: DesignerElement[];
  meta: Map<string, TableMeta>;
  unplacedNames: string[];
  overlaps: number;
  tight: number;
}): PublishSummary {
  const newTables: string[] = [];
  const renames: RenameSummary[] = [];
  let structureCount = 0;
  for (const el of args.elements) {
    if (el.type !== "table") {
      structureCount += 1;
      continue;
    }
    if (el.tempId !== null) {
      newTables.push(el.newName ?? "New table");
    } else if (el.renameTo !== null) {
      const from = (el.tableId ? args.meta.get(el.tableId)?.name ?? null : null) ?? el.label ?? "";
      renames.push({ from, to: el.renameTo });
    }
  }
  return {
    newTables,
    renames,
    structureCount,
    unplacedNames: args.unplacedNames,
    overlaps: args.overlaps,
    tight: args.tight,
  };
}
