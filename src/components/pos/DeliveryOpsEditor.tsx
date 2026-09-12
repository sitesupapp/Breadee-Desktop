// The compact editor for a delivery order's INTERNAL operations - who delivered
// it, and what the fulfilment COST the business. Presentational, like
// `DeliveryOrderDetail`: it owns the form and its validation, and hands the parsed
// values up. The parent is the ONLY caller of `setDeliveryOps`, so this component
// never touches an RPC or `pos_orders` - and it never shows or edits the customer
// total, the delivery FEE, payment or the receipt. Those are a different concern
// entirely; this is the business's own cost record.
//
// NULL vs 0 is preserved with care: an empty cost box is UNKNOWN (no margin), and
// a typed 0 is an explicit free fulfilment. `parseDeliveryCost` is the one place
// that distinction is made, shared with the server-facing writer.

import { useState } from "react";
import { Button, GatedButton, Input, type Gate } from "@/components/ui";
import type { OperationalCurrencyCode } from "@/lib/currency";
import { parseDeliveryCost, type DeliveryHandlerType, type DeliveryOps } from "@/lib/pos/deliveryOrderManagement";

const HANDLERS: [DeliveryHandlerType, string][] = [
  ["driver", "Driver"],
  ["delivery_company", "Delivery Company"],
];

export type DeliveryOpsEditorProps = {
  initial: DeliveryOps;
  currency: OperationalCurrencyCode;
  /** `pos.delivery.manage`. The server re-enforces it; this only gates the Save. */
  gate: Gate;
  busy: boolean;
  error: string | null;
  onSave: (values: {
    handlerType: DeliveryHandlerType | null;
    personRef: string | null;
    cost: number | null;
  }) => void;
  onCancel: () => void;
};

export function DeliveryOpsEditor(props: DeliveryOpsEditorProps) {
  const [handler, setHandler] = useState<DeliveryHandlerType | "">(props.initial.delivery_handler_type ?? "");
  const [ref, setRef] = useState(props.initial.delivery_person_ref ?? "");
  // Raw string so an empty box (unknown -> null) stays distinct from a typed "0".
  const [cost, setCost] = useState(props.initial.delivery_cost == null ? "" : String(props.initial.delivery_cost));

  const costParsed = parseDeliveryCost(cost);
  const canSave = props.gate.allowed && !props.busy && costParsed.valid;

  function save() {
    if (!canSave) return;
    props.onSave({
      handlerType: handler === "" ? null : handler,
      personRef: ref.trim() === "" ? null : ref.trim(),
      cost: costParsed.value,
    });
  }

  return (
    <div className="mt-3 rounded-2xl border border-line bg-slate-50 p-4">
      <p className="text-[11px] font-extrabold uppercase tracking-wide text-sub">Delivery details</p>

      <div className="mt-2">
        <p className="mb-1 text-[11px] font-semibold text-sub">Delivered by</p>
        <div className="flex overflow-hidden rounded-xl border border-line">
          {HANDLERS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              disabled={props.busy}
              onClick={() => setHandler((h) => (h === value ? "" : value))}
              className={`flex-1 px-3 py-2 text-xs font-bold ${
                handler === value ? "bg-ink text-white" : "bg-white text-sub"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-2">
        <label className="mb-1 block text-[11px] font-semibold text-sub">Name / reference</label>
        <Input
          value={ref}
          onChange={(e) => setRef(e.target.value)}
          placeholder={handler === "delivery_company" ? "e.g. Toters, Wakilni" : "Driver name"}
          disabled={props.busy}
        />
      </div>

      <div className="mt-2">
        <label className="mb-1 block text-[11px] font-semibold text-sub">
          Delivery cost ({props.currency}) - internal, not charged to the customer
        </label>
        <Input
          inputMode="decimal"
          value={cost}
          onChange={(e) => setCost(e.target.value)}
          placeholder="Leave empty if unknown"
          aria-invalid={!costParsed.valid}
          disabled={props.busy}
        />
        <p className="mt-1 text-[11px] text-sub">Empty = unknown (no margin). 0 = free fulfilment.</p>
        {!costParsed.valid && (
          <p className="mt-1 text-[11px] font-semibold text-amber-800">
            Delivery cost must be 0 or more. Leave it empty if unknown.
          </p>
        )}
      </div>

      {props.error && (
        <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-[11px] font-semibold text-red-700">{props.error}</p>
      )}

      <div className="mt-3 flex gap-2">
        <Button variant="ghost" className="flex-1" onClick={props.onCancel} disabled={props.busy}>
          Cancel
        </Button>
        <GatedButton gate={props.gate} className="flex-1" onClick={save} disabled={props.busy || !costParsed.valid}>
          {props.busy ? "Saving..." : "Save details"}
        </GatedButton>
      </div>
    </div>
  );
}
