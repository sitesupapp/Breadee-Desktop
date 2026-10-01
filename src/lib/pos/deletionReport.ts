// Deletion / reduction reason report (1.0.31).
//
// READ ONLY. Reads back the audited removal/reduction events the server already
// writes to activity_logs (via pos_edit_order_line / pos_remove_order_item) and
// presents them for a date range and branch. This module computes nothing — the
// server (pos_deletion_reason_report) owns the join, the scoping and the figures;
// the desktop renders the rows. The activity-log event remains the authoritative
// source.

import { asRecord, bool, callPosRpc, str, strOrNull } from "@/lib/pos/rpc";

export type DeletionReasonRow = {
  /** ISO timestamp of the audited event. */
  at: string;
  /** Who performed it (profiles.full_name), or "" when unresolved. */
  actor: string;
  orderNumber: string | null;
  tableName: string | null;
  item: string | null;
  /** The raw activity action (dinein_line_removed / _qty_changed / _modifier_changed / order_item_removed[_refunded]). */
  action: string;
  /** Quantity removed, as text (numeric string) when the event carries it. */
  quantityRemoved: string | null;
  /** "full" | "partial" | "modifier". */
  removalType: string;
  reason: string | null;
  refunded: boolean;
};

function toRow(raw: unknown): DeletionReasonRow {
  const r = asRecord(raw);
  return {
    at: str(r.at),
    actor: str(r.actor),
    orderNumber: strOrNull(r.order_number),
    tableName: strOrNull(r.table_name),
    item: strOrNull(r.item),
    action: str(r.action),
    quantityRemoved: strOrNull(r.quantity_removed),
    removalType: str(r.removal_type),
    reason: strOrNull(r.reason),
    refunded: bool(r.refunded),
  };
}

export async function loadDeletionReport(input: {
  from: string;
  to: string;
  branchId: string;
}): Promise<DeletionReasonRow[]> {
  const root = asRecord(
    await callPosRpc("pos_deletion_reason_report", {
      p_from: input.from,
      p_to: input.to,
      p_branch: input.branchId,
    }),
  );
  const list = Array.isArray(root.rows) ? root.rows : [];
  return list.map(toRow);
}

/** A short, human label for the removal type shown in the report. */
export function removalTypeLabel(removalType: string): string {
  switch (removalType) {
    case "full":
      return "Full removal";
    case "partial":
      return "Reduced";
    case "modifier":
      return "Options changed";
    default:
      return removalType || "—";
  }
}
