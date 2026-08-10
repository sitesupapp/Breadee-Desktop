// The three Delivery customer dialogs: customer details, address, history.
//
// All three are forms over `pos_upsert_customer` - or, for history, over a plain
// read. None of them touches an order. The history dialog in particular is
// deliberately inert: it lists what happened and offers no reorder, no edit, no
// void and no pay, because Level 3A has no order path to offer them through.
//
// The phone field carries the warning it does because the server is unique on
// the RAW phone only. Retyping an existing customer's number in another format
// does not merge anything - it produces a second row for the same person.

import { useEffect, useState } from "react";
import { Modal } from "@/components/overlays";
import { Badge, Button, Input, Skeleton, Textarea, cn } from "@/components/ui";
import { normalizePhoneE164 } from "@/lib/pos/phone";
import type { CustomerAddress, CustomerOrder, CustomerProfile } from "@/lib/pos/customers";
import { addressLine } from "@/components/pos/CustomerCard";

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs font-bold text-ink">{label}</span>
      {children}
      {hint && <span className="mt-0.5 block text-[11px] text-sub">{hint}</span>}
    </label>
  );
}

// --- customer details --------------------------------------------------------

export type CustomerFormValues = { name: string; phone: string; notes: string };

export type CustomerFormDialogProps = {
  open: boolean;
  mode: "create" | "edit";
  initial: CustomerFormValues;
  saving: boolean;
  error: string | null;
  onSubmit: (values: CustomerFormValues) => void;
  onClose: () => void;
};

export function CustomerFormDialog(props: CustomerFormDialogProps) {
  const [values, setValues] = useState<CustomerFormValues>(props.initial);

  // Re-seed whenever the dialog opens so it never shows the previous customer.
  useEffect(() => {
    if (props.open) setValues(props.initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open, props.initial.name, props.initial.phone, props.initial.notes]);

  const phoneChanged = props.mode === "edit" && values.phone.trim() !== props.initial.phone.trim();
  const normalized = normalizePhoneE164(values.phone);
  const phoneValid = values.phone.trim() === "" ? props.mode === "edit" : normalized !== null;
  const canSubmit = phoneValid && !props.saving;

  const set = (patch: Partial<CustomerFormValues>) => setValues((v) => ({ ...v, ...patch }));

  return (
    <Modal
      open={props.open}
      size="sm"
      title={props.mode === "create" ? "New customer" : "Edit customer"}
      subtitle={props.mode === "create" ? "Only the phone number is required." : null}
      onClose={props.onClose}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="lg" onClick={props.onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="lg" disabled={!canSubmit} onClick={() => canSubmit && props.onSubmit(values)}>
            {props.saving ? "Saving…" : props.mode === "create" ? "Create customer" : "Save changes"}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <Field label="Phone" hint={normalized ? `Dials as ${normalized}` : undefined}>
          <Input
            size="lg"
            className="mt-1"
            value={values.phone}
            inputMode="tel"
            placeholder="03 123 456"
            onChange={(e) => set({ phone: e.target.value })}
          />
        </Field>

        {!phoneValid && values.phone.trim() !== "" && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">
            That phone number is not valid. Use a local number (7-8 digits) or an international one with its country code.
          </p>
        )}

        {phoneChanged && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">
            Changing the phone number does not merge this customer with another. If the new number already belongs to
            someone on file, close this and open THAT customer instead.
          </p>
        )}

        <Field label="Name" hint="Leaving this blank keeps the current name - it cannot be cleared from here.">
          <Input
            size="lg"
            className="mt-1"
            value={values.name}
            placeholder="Customer name"
            onChange={(e) => set({ name: e.target.value })}
          />
        </Field>

        <Field label="Notes">
          <Textarea
            className="mt-1"
            rows={2}
            value={values.notes}
            placeholder="Anything the driver should know about this customer"
            onChange={(e) => set({ notes: e.target.value })}
          />
        </Field>

        {props.error && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">{props.error}</p>
        )}
      </div>
    </Modal>
  );
}

// --- address -----------------------------------------------------------------

export type AddressFormValues = {
  address_label: string;
  area: string;
  street: string;
  building: string;
  floor: string;
  notes: string;
  location_url: string;
  is_default: boolean;
};

export const EMPTY_ADDRESS: AddressFormValues = {
  address_label: "",
  area: "",
  street: "",
  building: "",
  floor: "",
  notes: "",
  location_url: "",
  is_default: false,
};

export function addressToForm(a: CustomerAddress): AddressFormValues {
  return {
    address_label: a.address_label ?? "",
    area: a.area ?? "",
    street: a.street ?? "",
    building: a.building ?? "",
    floor: a.floor ?? "",
    notes: a.notes ?? "",
    location_url: a.location_url ?? "",
    is_default: a.is_default,
  };
}

export type AddressDialogProps = {
  open: boolean;
  mode: "create" | "edit";
  initial: AddressFormValues;
  saving: boolean;
  error: string | null;
  onSubmit: (values: AddressFormValues) => void;
  onClose: () => void;
};

export function AddressDialog(props: AddressDialogProps) {
  const [values, setValues] = useState<AddressFormValues>(props.initial);

  useEffect(() => {
    if (props.open) setValues(props.initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open, props.initial.street, props.initial.address_label, props.initial.area]);

  // The server IGNORES an address object with no street, so an empty street here
  // would look like a save and change nothing. Refuse instead.
  const canSubmit = values.street.trim() !== "" && !props.saving;
  const set = (patch: Partial<AddressFormValues>) => setValues((v) => ({ ...v, ...patch }));

  return (
    <Modal
      open={props.open}
      size="sm"
      title={props.mode === "create" ? "Add address" : "Edit address"}
      subtitle="Street is required. Everything else is optional."
      onClose={props.onClose}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="lg" onClick={props.onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="lg" disabled={!canSubmit} onClick={() => canSubmit && props.onSubmit(values)}>
            {props.saving ? "Saving…" : "Save address"}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <Field label="Street">
          <Input
            size="lg"
            className="mt-1"
            value={values.street}
            placeholder="Street"
            onChange={(e) => set({ street: e.target.value })}
          />
        </Field>
        {values.street.trim() === "" && (
          <p className="text-[11px] font-semibold text-amber-800">
            An address without a street is discarded by the server, so it cannot be saved.
          </p>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Label">
            <Input
              size="lg"
              className="mt-1"
              value={values.address_label}
              placeholder="Home, Work…"
              onChange={(e) => set({ address_label: e.target.value })}
            />
          </Field>
          <Field label="Area">
            <Input size="lg" className="mt-1" value={values.area} onChange={(e) => set({ area: e.target.value })} />
          </Field>
          <Field label="Building">
            <Input
              size="lg"
              className="mt-1"
              value={values.building}
              onChange={(e) => set({ building: e.target.value })}
            />
          </Field>
          <Field label="Floor">
            <Input size="lg" className="mt-1" value={values.floor} onChange={(e) => set({ floor: e.target.value })} />
          </Field>
        </div>

        <Field label="Directions" hint="Landmarks, gate codes, which bell to ring.">
          <Textarea
            className="mt-1"
            rows={2}
            value={values.notes}
            onChange={(e) => set({ notes: e.target.value })}
          />
        </Field>

        <Field label="Map link">
          <Input
            size="lg"
            className="mt-1"
            value={values.location_url}
            placeholder="https://…"
            onChange={(e) => set({ location_url: e.target.value })}
          />
        </Field>

        <label className="flex min-h-[44px] items-center gap-2">
          <input
            type="checkbox"
            className="h-5 w-5 accent-brand"
            checked={values.is_default}
            onChange={(e) => set({ is_default: e.target.checked })}
          />
          <span className="text-xs font-bold text-ink">Use as this customer's default address</span>
        </label>

        {props.error && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">{props.error}</p>
        )}
      </div>
    </Modal>
  );
}

// --- history (read only) -----------------------------------------------------

function orderTone(o: CustomerOrder): "green" | "amber" | "red" | "slate" {
  if (o.status === "voided" || o.status === "cancelled") return "red";
  if (o.payment_status === "paid") return "green";
  if (o.status === "completed") return "slate";
  return "amber";
}

function orderDate(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString() : "—";
}

export type CustomerHistoryDialogProps = {
  open: boolean;
  customer: CustomerProfile | null;
  loading: boolean;
  onClose: () => void;
  /**
   * Reopen a past DELIVERY order's receipt (Level 3D). Optional, so a build
   * without the historical receipt path renders no such control.
   *
   * This list is the only place an order older than today can be reached at
   * all: the Level 3D queue is scoped to the open shift, or to today when there
   * is none. Without an entry point here, a receipt could be reopened for a few
   * hours and then never again - which is not "the read-only receipt gap is
   * closed", it is the gap moved somewhere less obvious.
   */
  onReceipt?: (orderId: string) => void;
  /** Which order is being assembled right now, if any. */
  receiptBusyId?: string | null;
};

export function CustomerHistoryDialog(props: CustomerHistoryDialogProps) {
  const orders = props.customer?.orders ?? [];

  return (
    <Modal
      open={props.open}
      size="md"
      title="Order history"
      subtitle={props.customer ? `${props.customer.name ?? "Customer"} · ${props.customer.phone ?? "no phone"}` : null}
      onClose={props.onClose}
      footer={
        <div className="flex items-center justify-between gap-2">
          {/* Said plainly rather than implied by absent buttons. Reopening a
              receipt is a READ, so it does not contradict this. */}
          <p className="text-[11px] text-sub">
            Read only. Reordering and editing a past order from here are not available on the desktop.
          </p>
          <Button variant="ghost" size="lg" onClick={props.onClose}>
            Close
          </Button>
        </div>
      }
    >
      {props.loading && (
        <div className="space-y-2">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      )}

      {!props.loading && orders.length === 0 && (
        <p className="py-6 text-center text-sm text-sub">This customer has no orders yet.</p>
      )}

      {!props.loading && orders.length > 0 && (
        <ul className="divide-y divide-line">
          {orders.map((o) => {
            const addr = props.customer?.addresses.find((a) => a.id === o.address_id) ?? null;
            return (
              <li key={o.id} className="flex items-start justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="text-sm font-bold text-ink">
                    {o.order_number ? `#${o.order_number}` : "Order"}
                    <span className="ml-2 text-xs font-semibold text-sub">{o.order_type}</span>
                  </p>
                  <p className="text-[11px] text-sub">{orderDate(o.created_at)}</p>
                  {addr && <p className="truncate text-[11px] text-sub">{addressLine(addr)}</p>}
                </div>
                <div className={cn("shrink-0 text-right")}>
                  <p className="text-sm font-bold text-ink">
                    {o.total_amount == null ? "—" : o.total_amount.toLocaleString()}
                    {o.currency ? ` ${o.currency}` : ""}
                  </p>
                  <Badge tone={orderTone(o)}>{o.payment_status}</Badge>
                  {/* Delivery only: the receipt this rebuilds names itself a
                      Delivery receipt, so offering it on a takeaway row would
                      print the wrong order type onto a real document. */}
                  {props.onReceipt && o.order_type === "delivery" && (
                    <Button
                      variant="ghost"
                      className="mt-1"
                      disabled={props.receiptBusyId === o.id}
                      onClick={() => props.onReceipt?.(o.id)}
                    >
                      {props.receiptBusyId === o.id ? "Opening..." : "Receipt"}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}
