// 1.0.41 (Staging 1.0.52 native QA, D-4) — the state of a delivery order this terminal settled OFFLINE, read from
// the settle operation itself (the one durable truth), for the "sent delivery order" panel.
//
//   pending_sync   cash / COD collected on this terminal, the payment has not reached Breadee yet
//   confirmed      Breadee applied the payment (the op synced)
//   refused        cash was collected here, but Breadee did not accept the payment (or the sale) — needs a manager
//
// In every one of these states the money is already recorded: the panel never offers Pay again.

import type { OfflineOperation } from "@/lib/offline/operationLog";

export type DeliveryOfflineSettleState = "pending_sync" | "confirmed" | "refused";

/** PURE — null when there is no offline settle to describe (unknown op id / op not found yet). */
export function deliverySettleState(op: Pick<OfflineOperation, "status"> | null | undefined): DeliveryOfflineSettleState | null {
  if (!op) return null;
  switch (op.status) {
    case "synced":
      return "confirmed";
    case "needs_attention":
    case "cancelled": // withdrawn after a refusal: still never applied by Breadee
      return "refused";
    default:
      return "pending_sync"; // pending · syncing · retryable · blocked_dependency
  }
}

/** The Pay gate's reason while this terminal holds an unresolved settle of the order (never a second collection). */
export function deliverySettleBlockReason(state: DeliveryOfflineSettleState | null): string | null {
  if (state === "pending_sync") return "This order was settled on this terminal — it will sync when Breadee answers. Do not collect it again.";
  if (state === "refused") return "Breadee did not accept the payment recorded on this terminal for this order. Review it in Sync Center with a manager — do not collect it again.";
  return null;
}

export const DELIVERY_SETTLE_TEXT: Record<DeliveryOfflineSettleState, { badge: string; tone: "amber" | "green" | "red"; note: string }> = {
  pending_sync: {
    badge: "Collected · pending sync",
    tone: "amber",
    note: "Collected on this terminal while offline. It syncs automatically when Breadee answers — do not collect it again.",
  },
  confirmed: {
    badge: "Paid",
    tone: "green",
    note: "Paid and confirmed by Breadee. Nothing further is needed for this order.",
  },
  refused: {
    badge: "Needs attention",
    tone: "red",
    note: "Cash was collected on this terminal, but Breadee did not accept this payment. Do not collect it again — review it in Sync Center with a manager.",
  },
};
