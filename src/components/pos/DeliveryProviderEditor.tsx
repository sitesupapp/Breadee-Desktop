// The compact editor for a delivery order's advanced settlement PROVIDER and its
// delivery COST (Delivery Settlement WS6.3). Presentational, like
// `DeliveryOpsEditor`: it owns the form and its validation and hands the parsed
// values up. The parent is the ONLY caller of `setDeliveryProvider`, so this
// component never touches an RPC or `pos_orders`, never writes a settlement, and
// never computes a drawer effect. It never shows or edits the customer total, the
// delivery FEE, payment or the receipt.
//
// NULL vs 0 is preserved with the SAME `parseDeliveryCost` the ops editor uses: an
// empty cost box is NOT PROVIDED (the server stores NULL/unknown), and a typed 0 is
// an explicit free delivery (stored as 0). The required-cost hint is UX only; the
// server re-enforces cost-before-pay at finalization.

import { useState } from "react";
import { Button, GatedButton, Input, type Gate } from "@/components/ui";
import type { CurrencyCode } from "@/lib/currency";
import { parseDeliveryCost, type OperationalProvider } from "@/lib/pos/deliveryProviderCapture";

export type DeliveryProviderEditorProps = {
  /** Persisted state for THIS order: the chosen provider and its recorded cost. */
  initial: { delivery_provider_id: string | null; delivery_cost: number | null };
  /** The ACTIVE operational providers for the order's branch (from the RPC). */
  providers: OperationalProvider[];
  currency: CurrencyCode;
  /** `pos.delivery.cost.capture`. The server re-enforces it; this only gates Save. */
  gate: Gate;
  busy: boolean;
  error: string | null;
  onSave: (values: {
    providerId: string;
    cost: { value: number | null; provided: boolean };
  }) => void;
  onCancel: () => void;
};

export function DeliveryProviderEditor(props: DeliveryProviderEditorProps) {
  const [providerId, setProviderId] = useState<string>(props.initial.delivery_provider_id ?? "");
  // Raw string so an empty box (not provided -> null) stays distinct from a typed "0".
  const [cost, setCost] = useState(props.initial.delivery_cost == null ? "" : String(props.initial.delivery_cost));

  const selected = props.providers.find((p) => p.id === providerId) ?? null;
  const costParsed = parseDeliveryCost(cost);
  // Friendly, UX-only required-cost hint. Never authority — the server re-enforces.
  const costRequiredMissing = !!selected && selected.cost_entry_mode === "required_before_pay" && !costParsed.provided;
  const canSave = props.gate.allowed && !props.busy && providerId !== "" && costParsed.valid;

  function save() {
    if (!canSave) return;
    props.onSave({ providerId, cost: { value: costParsed.value, provided: costParsed.provided } });
  }

  return (
    <div className="mt-3 rounded-2xl border border-line bg-slate-50 p-4">
      <p className="text-[11px] font-extrabold uppercase tracking-wide text-sub">Delivery provider</p>

      <div className="mt-2">
        <label className="mb-1 block text-[11px] font-semibold text-sub">Provider</label>
        <select
          value={providerId}
          onChange={(e) => setProviderId(e.target.value)}
          disabled={props.busy}
          className="h-10 w-full rounded-xl border border-line bg-white px-3 text-xs font-semibold text-ink outline-none focus:border-ink disabled:opacity-60"
        >
          <option value="">Select a provider...</option>
          {props.providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-2">
        <label className="mb-1 block text-[11px] font-semibold text-sub">
          Delivery cost ({props.currency}) - what you pay the provider, not charged to the customer
        </label>
        <Input
          inputMode="decimal"
          value={cost}
          onChange={(e) => setCost(e.target.value)}
          placeholder="Leave empty if not provided yet"
          aria-invalid={!costParsed.valid}
          disabled={props.busy}
        />
        <p className="mt-1 text-[11px] text-sub">Empty = not provided yet. 0 = free delivery.</p>
        {!costParsed.valid && (
          <p className="mt-1 text-[11px] font-semibold text-amber-800">
            Delivery cost must be 0 or more. Leave it empty if not provided yet.
          </p>
        )}
        {costParsed.valid && costRequiredMissing && (
          <p className="mt-1 text-[11px] font-semibold text-amber-800">
            Delivery cost is required for {selected!.name} before completing this order.
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
        <GatedButton
          gate={props.gate}
          className="flex-1"
          onClick={save}
          disabled={props.busy || providerId === "" || !costParsed.valid}
        >
          {props.busy ? "Saving..." : "Save provider"}
        </GatedButton>
      </div>
    </div>
  );
}
