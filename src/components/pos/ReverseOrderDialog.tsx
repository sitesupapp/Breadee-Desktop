// Cancelling or refunding one order, with a reason.
//
// ONE DIALOG FOR EVERY SURFACE. The Current Order panel, the Orders modal and
// the Delivery modal all reverse orders, and destructive logic copied three
// times is destructive logic that will eventually disagree with itself. This is
// the only place in the app that sends `pos_void_order` for a shift order.
//
// A REASON IS MANDATORY, though the server accepts an empty one. An audit row
// recording that money was reversed and nothing about why is indistinguishable
// from theft after the fact - the same policy Level 2C set for clearing a table
// and Level 3D set for the delivery queue.
//
// THE ACTION IS DERIVED, NEVER CHOSEN. `reversalActionFor` reads the order's
// payment state; a paid order is refunded and an unpaid one cancelled. No
// caller passes a boolean, so no caller can ask the server for the refusal it
// gives to `p_refund = false` on a paid order.

import { useState } from "react";
import { Button, Input } from "@/components/ui";
import { Modal } from "@/components/overlays";
import { classifyError } from "@/lib/pos/errors";
import { validateVoidReason, voidDeliveryOrder, type VoidAction } from "@/lib/pos/deliveryOrderManagement";
import { reversalTitle, reversalWarning } from "@/lib/pos/orderActions";
import type { ShiftOpenOrder } from "@/lib/pos/shiftOrderSummary";

export function ReverseOrderDialog(props: {
  order: ShiftOpenOrder | null;
  action: VoidAction | null;
  onClose: () => void;
  /** Called once the server has confirmed, so callers can re-read. */
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const order = props.order;
  const action = props.action;
  if (!order || !action) return null;

  const orderNumber = order.order_number ?? order.id.slice(0, 8);
  const reasonGiven = reason.trim() !== "";

  const confirm = async () => {
    // A synchronous guard, not React state: two clicks in the same tick would
    // both read a stale `false` and send twice. `pos_void_order` is idempotent
    // per order and would replay rather than reverse twice, but a second
    // request is still a second request.
    if (busy || !reasonGiven) return;
    setBusy(true);
    setError(null);
    try {
      const clean = validateVoidReason(reason);
      await voidDeliveryOrder({ orderId: order.id, reason: clean, action });
      props.onDone();
      props.onClose();
      setReason("");
    } catch (e) {
      const c = classifyError(e);
      setError(c.hint ? `${c.message} ${c.hint}` : c.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title={reversalTitle(action, orderNumber)}
      size="sm"
      onClose={() => {
        if (busy) return;
        setReason("");
        setError(null);
        props.onClose();
      }}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={props.onClose}>
            Keep the order
          </Button>
          <Button
            variant="danger"
            disabled={busy || !reasonGiven}
            title={reasonGiven ? undefined : "A reason is required."}
            onClick={() => void confirm()}
          >
            {busy ? "Sending..." : action === "refund" ? "Refund order" : "Cancel order"}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <p className="text-sm">
          This affects order <strong>#{orderNumber}</strong> only.
        </p>
        <p className="text-[12px] text-sub">{reversalWarning(action)}</p>
        <div>
          <label className="text-[11px] font-bold uppercase tracking-wide text-sub" htmlFor="reverse-reason">
            Reason
          </label>
          <Input
            id="reverse-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why is this being reversed?"
            className="mt-1"
            disabled={busy}
          />
          {!reasonGiven && <p className="mt-1 text-[11px] text-sub">A reason is required.</p>}
        </div>
        {error && <p className="rounded-lg bg-red-50 px-2 py-1 text-[11px] font-semibold text-red-700">{error}</p>}
      </div>
    </Modal>
  );
}
