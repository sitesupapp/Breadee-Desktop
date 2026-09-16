// The two Level 3D confirmations: edit, and cancel-or-refund.
//
// EDIT AND PRESENCE. `pos_edit_order` detects its optional fields by KEY
// PRESENCE, so this dialog reports what the operator TOUCHED rather than what
// the form currently contains. A note left alone comes back as `null` (omit the
// key), a note emptied on purpose comes back as `""` (clear it), and the
// discount is reported only when the operator explicitly opts into changing it.
// Sending the whole form every time would quietly rewrite a note nobody edited,
// and would attach a discount key to an edit that was only ever about the note -
// which the server refuses outright on a paid order.
//
// CANCEL AND REFUND ARE ONE COMPONENT AND TWO DIALOGS. They share a shell
// because they share a shape - reason, confirm - and differ everywhere it
// matters: wording, colour, the warning, and whether an acknowledgement is
// required. What they never share is a flag the operator can flip. The action
// arrives already decided by the order's payment state, and this component
// cannot change it.

import { useEffect, useState } from "react";
import { Modal } from "@/components/overlays";
import { Button, GatedButton, Input, Textarea, type Gate } from "@/components/ui";
import { formatMoney, type CurrencyCode } from "@/lib/currency";
import { computeDiscount, type DiscountType } from "@/lib/pos/discounts";
import type { DeliveryQueueOrder, VoidAction } from "@/lib/pos/deliveryOrderManagement";

// --- edit --------------------------------------------------------------------

/** What the operator actually changed. `null` means "not touched" in both slots. */
export type EditOrderIntent = {
  note: string | null;
  discount: { type: DiscountType; value: string } | null;
};

export type EditOrderDialogProps = {
  open: boolean;
  order: DeliveryQueueOrder | null;
  currency: CurrencyCode;
  discountGate: Gate;
  saveGate: Gate;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (intent: EditOrderIntent) => void;
};

export function EditOrderDialog(props: EditOrderDialogProps) {
  const order = props.order;
  const original = order?.notes ?? "";
  const paid = order?.payment_status === "paid";
  const subtotal = order?.subtotal ?? order?.total_amount ?? 0;

  const [note, setNote] = useState(original);
  const [changeDiscount, setChangeDiscount] = useState(false);
  const [discountType, setDiscountType] = useState<DiscountType>("none");
  const [discountValue, setDiscountValue] = useState("");

  // Re-seed whenever a different order is opened. Without this the form would
  // still hold the previous order's note, and the first save would write it.
  useEffect(() => {
    if (!props.open) return;
    setNote(original);
    setChangeDiscount(false);
    setDiscountType("none");
    setDiscountValue("");
  }, [props.open, order?.id, original]);

  if (!order) return null;

  const noteTouched = note.trim() !== original.trim();
  const preview = changeDiscount && discountType !== "none" ? computeDiscount(subtotal, discountType, discountValue) : null;
  const nothingToSave = !noteTouched && !changeDiscount;

  const submit = () =>
    props.onSubmit({
      // PRESENCE, not content: an untouched note is omitted entirely, and an
      // emptied one is sent as "" so the server clears it.
      note: noteTouched ? note.trim() : null,
      discount: changeDiscount ? { type: discountType, value: discountValue } : null,
    });

  return (
    <Modal
      open={props.open}
      size="md"
      title={order.order_number ? `Edit order #${order.order_number}` : "Edit delivery order"}
      subtitle="Only the order note and, while unpaid, the discount can be changed here."
      onClose={props.onCancel}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="lg" onClick={props.onCancel}>
            Close
          </Button>
          <GatedButton
            gate={props.saveGate}
            size="lg"
            disabled={props.busy || nothingToSave}
            onClick={submit}
          >
            {props.busy ? "Saving..." : "Save changes"}
          </GatedButton>
        </div>
      }
    >
      <label className="block">
        <span className="text-xs font-bold text-ink">Delivery note</span>
        <Textarea
          className="mt-1"
          rows={3}
          value={note}
          placeholder="Anything about this order as a whole"
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <p className="mt-1 text-[11px] text-sub">
        {noteTouched
          ? note.trim() === ""
            ? "The note will be cleared."
            : "The note will be replaced."
          : "The note is unchanged and will not be sent."}
      </p>

      <div className="mt-4 border-t border-line pt-3">
        {paid ? (
          // Not a disabled control - an absent one. The server refuses a
          // discount change on a paid order, so offering the field greyed out
          // would only invite the question "why not?".
          <p className="rounded-lg bg-slate-100 px-3 py-2 text-[11px] font-semibold text-sub">
            This order is paid. Its note can still be corrected, but the discount can no longer be changed.
          </p>
        ) : (
          <>
            <label className="flex min-h-[44px] items-center gap-2">
              <input
                type="checkbox"
                className="h-5 w-5"
                checked={changeDiscount}
                disabled={!props.discountGate.allowed}
                onChange={(e) => setChangeDiscount(e.target.checked)}
              />
              <span className="text-xs font-bold text-ink">Change the discount on this order</span>
            </label>
            {!props.discountGate.allowed && (
              <p className="text-[11px] font-semibold text-amber-800">{props.discountGate.reason}</p>
            )}

            {changeDiscount && (
              <div className="mt-2 space-y-2">
                <div className="flex gap-2">
                  {(["none", "percent", "amount"] as DiscountType[]).map((t) => (
                    <Button
                      key={t}
                      variant={discountType === t ? "primary" : "ghost"}
                      onClick={() => setDiscountType(t)}
                    >
                      {t === "none" ? "No discount" : t === "percent" ? "Percent" : "Fixed amount"}
                    </Button>
                  ))}
                </div>
                {discountType !== "none" && (
                  <Input
                    inputMode="decimal"
                    value={discountValue}
                    placeholder={discountType === "percent" ? "10" : "5"}
                    onChange={(e) => setDiscountValue(e.target.value)}
                  />
                )}
                {preview && !preview.valid && (
                  <p className="text-[11px] font-semibold text-red-700">{preview.error}</p>
                )}
                {preview && preview.valid && (
                  <p className="text-[11px] font-semibold text-sub">
                    New total {formatMoney(preview.finalTotal, props.currency)} (was{" "}
                    {formatMoney(order.total_amount ?? 0, props.currency)})
                  </p>
                )}
                {discountType === "none" && (
                  <p className="text-[11px] font-semibold text-sub">Any existing discount will be removed.</p>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {props.error && (
        <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">{props.error}</p>
      )}
    </Modal>
  );
}

// --- cancel / refund ---------------------------------------------------------

export type VoidOrderDialogProps = {
  open: boolean;
  /** Decided by the order's payment state before this dialog is ever opened. */
  action: VoidAction;
  order: DeliveryQueueOrder | null;
  customerName: string | null;
  currency: CurrencyCode;
  gate: Gate;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
};

export function VoidOrderDialog(props: VoidOrderDialogProps) {
  const order = props.order;
  const refund = props.action === "refund";
  const [reason, setReason] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    if (!props.open) return;
    setReason("");
    setAcknowledged(false);
  }, [props.open, order?.id]);

  if (!order) return null;

  const currency = (order.currency as CurrencyCode) ?? props.currency;
  // DESKTOP POLICY: a reason is mandatory even though the server accepts an
  // empty one. It is recorded against the operator's account, and "no reason
  // given" is not an acceptable entry against a reversed payment.
  const reasonOk = reason.trim() !== "";
  const ready = reasonOk && (!refund || acknowledged);

  return (
    <Modal
      open={props.open}
      size="sm"
      title={refund ? "Refund this order?" : "Cancel this order?"}
      subtitle={order.order_number ? `Order #${order.order_number}` : undefined}
      onClose={props.onCancel}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="lg" onClick={props.onCancel}>
            {refund ? "Do not refund" : "Keep the order"}
          </Button>
          <GatedButton
            gate={props.gate}
            variant="danger"
            size="lg"
            disabled={props.busy || !ready}
            onClick={() => props.onConfirm(reason)}
          >
            {props.busy ? "Sending..." : refund ? "Refund the payment" : "Cancel the order"}
          </GatedButton>
        </div>
      }
    >
      <div className="space-y-1 rounded-xl border border-line bg-slate-50 p-3">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[11px] font-semibold text-sub">Customer</span>
          <span className="truncate text-xs font-bold text-ink">{props.customerName ?? "Customer"}</span>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[11px] font-semibold text-sub">{refund ? "Amount paid" : "Order total"}</span>
          <span className="text-base font-extrabold tabular-nums text-ink">
            {formatMoney(order.total_amount ?? 0, currency)}
          </span>
        </div>
      </div>

      {refund ? (
        // The strongest wording in the app, because this is the only desktop
        // action that moves money backwards.
        <div className="mt-3 rounded-xl border-2 border-red-200 bg-red-50 p-3">
          <p className="text-xs font-extrabold text-red-800">This reverses a payment that was taken.</p>
          <p className="mt-1 text-[11px] font-semibold text-red-800">
            A negative payment and a refund record are written against the shift that took the money, and the order
            becomes refunded. This cannot be undone from the desktop.
          </p>
          <label className="mt-2 flex min-h-[44px] items-center gap-2">
            <input
              type="checkbox"
              className="h-5 w-5"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
            />
            <span className="text-[11px] font-bold text-red-900">
              I understand the payment will be reversed.
            </span>
          </label>
        </div>
      ) : (
        <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-[11px] font-semibold text-amber-900">
          This order has not been paid, so no money is involved. It will be voided and will stop counting towards the
          shift.
        </p>
      )}

      <label className="mt-3 block">
        <span className="text-xs font-bold text-ink">Reason</span>
        <Textarea
          className="mt-1"
          rows={3}
          value={reason}
          placeholder={refund ? "Why is this payment being refunded?" : "Why is this order being cancelled?"}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      <p className="mt-1 text-[11px] text-sub">
        {reasonOk ? "Recorded against this order and your account." : "A reason is required."}
      </p>

      {props.error && (
        <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">{props.error}</p>
      )}
    </Modal>
  );
}
