// The selected Delivery customer.
//
// This card is the whole point of Level 3A: it establishes WHO the order is for
// and WHICH address it would go to. It stops there. There is no menu, no cart
// and no Pay on this screen, and the panel says so rather than leaving an
// operator to discover it by pressing something that is not there.
//
// The address a delivery would use is shown explicitly and changes only when
// the operator picks one. Nothing here re-defaults it behind their back.

import { Badge, Button, GatedButton, PanelTitle, Skeleton, cn, type Gate } from "@/components/ui";
import { addressText } from "@/lib/pos/deliveryHistory";
import type { CustomerAddress, CustomerProfile } from "@/lib/pos/customers";

/**
 * RE-EXPORTED, not re-implemented (Level 3D).
 *
 * The queue row, the detail panel and the reprinted receipt all render an
 * address too, and they cannot import from a `.tsx` module. Rather than let a
 * second formatter exist - and eventually disagree with this one about where the
 * building number goes - the single implementation moved to `deliveryHistory.ts`
 * and every caller of `addressLine` keeps working unchanged.
 */
export function addressLine(a: CustomerAddress): string {
  return addressText(a);
}

/** Latest order date, shown short. The server's timestamp, never a local clock. */
function lastOrderDate(customer: CustomerProfile): string | null {
  const iso = customer.orders[0]?.created_at;
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString() : null;
}

export type CustomerCardProps = {
  customer: CustomerProfile | null;
  selectedAddressId: string | null;
  loading: boolean;
  error: string | null;
  writeGate: Gate;
  onSelectAddress: (addressId: string) => void;
  onEditCustomer: () => void;
  onAddAddress: () => void;
  onEditAddress: (addressId: string) => void;
  onOpenHistory: () => void;
  onClear: () => void;
};

export function CustomerCard(props: CustomerCardProps) {
  const c = props.customer;

  if (props.loading && !c) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-24" />
        <Skeleton className="h-12" />
      </div>
    );
  }

  if (!c) {
    return (
      <div className="rounded-xl border border-dashed border-line bg-white px-4 py-8 text-center">
        <p className="text-sm font-bold text-ink">No customer selected</p>
        <p className="mt-1 text-xs text-sub">
          Search by name or phone to open a customer, or enter a phone number to add one.
        </p>
      </div>
    );
  }

  const selected = c.addresses.find((a) => a.id === props.selectedAddressId) ?? null;

  return (
    <section aria-label="Selected customer" className="rounded-2xl border border-line bg-white p-4">
      <PanelTitle right={selected ? <Badge tone="green">Address chosen</Badge> : undefined}>
        {c.name || "New customer"}
      </PanelTitle>

      <p className="mt-0.5 text-sm text-sub">{c.phone || "No phone"}</p>
      {/* The normalised form is shown when it differs, so a cashier can SEE that
          "03123456" and "+9613123456" are the same person. That difference is
          exactly what creates duplicates when it stays invisible. */}
      {c.phone_e164 && c.phone_e164 !== c.phone && (
        <p className="text-[11px] text-sub">Dials as {c.phone_e164}</p>
      )}
      {!c.name && <p className="mt-1 text-[11px] font-semibold text-amber-800">Add a name so the driver knows who to ask for.</p>}

      <div className="mt-3">
        <p className="text-xs font-bold text-ink">Delivery address</p>
        {selected ? (
          <p className="mt-0.5 text-[13px] text-ink">{addressLine(selected)}</p>
        ) : (
          <p className="mt-0.5 text-[13px] text-sub">No address yet — add one before this customer can be delivered to.</p>
        )}

        {c.addresses.length > 1 && (
          <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Choose delivery address">
            {c.addresses.map((a) => (
              <button
                key={a.id}
                type="button"
                aria-pressed={a.id === props.selectedAddressId}
                onClick={() => props.onSelectAddress(a.id)}
                className={cn(
                  "min-h-[44px] rounded-xl border px-3 text-xs font-bold transition",
                  a.id === props.selectedAddressId
                    ? "border-brand bg-brand text-onbrand"
                    : "border-line bg-white text-ink hover:border-brand/40",
                )}
              >
                {a.address_label ?? "Address"}
                {a.is_default ? " ·  default" : ""}
              </button>
            ))}
          </div>
        )}
      </div>

      <p className="mt-3 text-[11px] text-sub">
        {c.orders.length} previous order{c.orders.length === 1 ? "" : "s"}
        {lastOrderDate(c) ? ` · last ${lastOrderDate(c)}` : ""}
      </p>

      {props.error && (
        <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">{props.error}</p>
      )}

      <div className="mt-3 grid grid-cols-2 gap-2">
        <GatedButton gate={props.writeGate} variant="ghost" size="lg" onClick={props.onEditCustomer}>
          Edit customer
        </GatedButton>
        <Button variant="ghost" size="lg" onClick={props.onOpenHistory}>
          Order history
        </Button>
        <GatedButton gate={props.writeGate} variant="ghost" size="lg" onClick={props.onAddAddress}>
          Add address
        </GatedButton>
        <GatedButton
          gate={props.writeGate}
          variant="ghost"
          size="lg"
          disabled={!props.writeGate.allowed || !selected}
          onClick={() => selected && props.onEditAddress(selected.id)}
        >
          Edit address
        </GatedButton>
      </div>

      <div className="mt-2 border-t border-dashed border-line pt-2">
        <Button variant="ghost" size="lg" className="w-full" onClick={props.onClear}>
          Choose a different customer
        </Button>
      </div>
    </section>
  );
}
