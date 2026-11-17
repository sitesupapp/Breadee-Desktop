// 1.0.63 (native Staging 1.0.62, D-B) — the bill the Dine-In PANEL shows while offline capture is active.
//
// The operational projection already knows what an unsynced offline split leg paid: each leg's allocations
// raise the line's `meta.paidQty`, and `paidPending` / `outstanding` carry the amount (Pay Full Bill and the
// floor tile use them). But the projection's `bill` — the ONE bill payment, split and print read — carries
// neither, so the panel (which hides paid quantities through `paid_quantity` and shows the Due through
// `collected`) kept showing the whole bill as unpaid after an offline split.
//
// This PURE helper returns a DISPLAY-ONLY copy for the panel: each line's `paid_quantity` gains its pending
// split quantity (capped at the line quantity), and `collected` = the server-held amount + the pending legs,
// marked known. The panel's Due is then `total − collected − paidPending` = the projection's `outstanding`,
// the exact figure Pay Full Bill charges. Nothing here is written anywhere, and the projection's own `bill`
// is never mutated: payment, split and print keep reading exactly what they read before.

import type { TableBill } from "@/types/tables";
import type { OperationalTableBill } from "@/lib/offline/operationalProjection";

const round2 = (n: number) => Math.round(n * 100) / 100;

export function offlineDisplayBill(p: Pick<OperationalTableBill, "bill" | "meta" | "collected" | "paidPending">): TableBill {
  const pendingPaid = (id: string) => Math.max(0, Number(p.meta.get(id)?.paidQty ?? 0) || 0);
  const anyPending = p.bill.orders.some((o) => o.lines.some((l) => pendingPaid(l.id) > 0));
  const held = round2(Math.max(0, Number(p.collected ?? 0) || 0) + Math.max(0, Number(p.paidPending ?? 0) || 0));
  if (!anyPending && held <= 0) return p.bill;
  const orders = anyPending
    ? p.bill.orders.map((o) => ({
        ...o,
        lines: o.lines.map((l) => {
          const extra = pendingPaid(l.id);
          if (extra <= 0) return l;
          const already = Math.max(0, Number(l.paid_quantity ?? 0) || 0);
          return { ...l, paid_quantity: Math.min(l.quantity, already + extra) };
        }),
      }))
    : p.bill.orders;
  return held > 0 ? { ...p.bill, orders, collected: held, collectedKnown: true } : { ...p.bill, orders };
}
