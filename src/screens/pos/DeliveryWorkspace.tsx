// Delivery workspace (Level 3A: customer foundation).
//
// Like Dine-in, this is a HOOK rather than a second shell - one PosShell, one
// status bar, one layout resolver.
//
// WHAT THIS LEVEL DOES: find a customer, create one, edit them, keep their
// addresses, choose which address a delivery would go to, and read their past
// orders.
//
// WHAT IT DELIBERATELY CANNOT DO: add a menu item, hold a cart, send to kitchen,
// submit an order, take payment, print a receipt or touch the cash box. That is
// not an oversight to be tidied up later - it is the scope. The workspace never
// renders the menu grid or the cart panel, never claims the shared cart buffer,
// and calls none of `pos_submit_order`, `pos_pay_order`, `pos_pay_table`,
// `pos_void_order` or `pos_edit_order`. The only write it can make is
// `pos_upsert_customer`. Level 3B adds ordering on top of this.
//
// Because it takes no money, there is no shift requirement here: looking a
// caller up, or fixing their address, is reasonable work with no shift open.
// Level 3B's ordering path will bring the shift gate with it.
//
// THE DUPLICATE RULE. `pos_customers` is unique on the RAW phone only, so the
// same person typed two ways becomes two customers and nothing on the server
// objects. Every create therefore runs through `decideCreate`, which sees the
// current shortlist and answers select / choose / create - and through one
// synchronous latch, because for customers there is no server-side state that
// would refuse a second insert the way an already-paid bill refuses a second
// payment.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useToast } from "@/components/toast";
import { CustomerSearch } from "@/components/pos/CustomerSearch";
import { CustomerCard } from "@/components/pos/CustomerCard";
import {
  AddressDialog,
  CustomerFormDialog,
  CustomerHistoryDialog,
  EMPTY_ADDRESS,
  addressToForm,
  type AddressFormValues,
  type CustomerFormValues,
} from "@/components/pos/CustomerDialogs";
import { canManageCustomers, canViewCustomers, canViewDelivery } from "@/lib/pos/access";
import { classifyError } from "@/lib/pos/errors";
import {
  buildAddressPayload,
  buildCreatePayload,
  buildEditPayload,
  customerLookupGate,
  customerWriteGate,
  decideCreate,
  performCustomerCreate,
  searchCustomers,
  upsertCustomer,
  type CustomerMatch,
} from "@/lib/pos/customers";
import { customerCreateLatch, SEARCH_DEBOUNCE_MS, useCustomers } from "@/state/customers";
import type { PosContext } from "@/state/pos";
import type { LayoutSpec } from "@/lib/layout";
import type { Gate } from "@/components/ui";

const EMPTY_CUSTOMER_FORM: CustomerFormValues = { name: "", phone: "", notes: "" };

/** Which dialog is open. One value rather than four booleans, so only one can be. */
type DeliveryDialog =
  | { kind: "none" }
  | { kind: "customer"; mode: "create" | "edit"; initial: CustomerFormValues }
  | { kind: "address"; mode: "create" | "edit"; addressId: string | null; initial: AddressFormValues };

export type DeliveryWorkspace = {
  /** The search area. Also carries the customer card on drawer-width layouts. */
  work: (layout: LayoutSpec) => React.ReactNode;
  /** The customer card, for the fixed side panel. Never a cart. */
  panel: (layout: LayoutSpec) => React.ReactNode;
  dialogs: React.ReactNode;
  /** Entering the workspace at all: POS access + the `pos.delivery` sub-feature. */
  accessGate: Gate;
  /** Reading the customer book. */
  lookupGate: Gate;
  /** Creating or editing a customer. */
  writeGate: Gate;
};

export function useDeliveryWorkspace(input: {
  pos: PosContext;
  active: boolean;
  online: boolean;
}): DeliveryWorkspace {
  const { pos, active, online } = input;
  const toast = useToast();
  const customers = useCustomers();

  const [dialog, setDialog] = useState<DeliveryDialog>({ kind: "none" });
  const [dialogError, setDialogError] = useState<string | null>(null);
  /**
   * Mirrors the create latch for RE-RENDERING only. The latch itself is the
   * authority; this flag exists so the gate can grey the button out.
   */
  const [saving, setSaving] = useState(false);

  const branchId = pos.branch.id;

  // --- gates -----------------------------------------------------------------

  const accessGate = useMemo(() => canViewDelivery(pos.access), [pos.access]);
  const lookupGate = useMemo(
    () => customerLookupGate({ deliveryAccess: accessGate, canView: canViewCustomers(pos.access) }),
    [accessGate, pos.access],
  );
  const writeGate = useMemo(
    () =>
      customerWriteGate({
        deliveryAccess: accessGate,
        canView: canViewCustomers(pos.access),
        canManageCustomers: canManageCustomers(pos.access),
        canCreateOrders: pos.gates.createOrders.allowed,
        online,
        saving,
      }),
    [accessGate, pos.access, pos.gates.createOrders.allowed, online, saving],
  );

  // --- search ----------------------------------------------------------------

  const query = customers.query;

  // Debounced search. The store drops results whose query has moved on, so a
  // slow response cannot overwrite a newer shortlist.
  useEffect(() => {
    if (!active || !lookupGate.allowed) return;
    const term = query.trim();
    if (term === "") return;
    const id = window.setTimeout(() => void useCustomers.getState().search(term), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [active, lookupGate.allowed, query]);

  // Customer state is tenant/branch scoped: a branch switch must not leave the
  // previous branch's customer selected and ready to be delivered to.
  useEffect(() => {
    useCustomers.getState().reset();
  }, [pos.tenantId, branchId]);

  // --- create ----------------------------------------------------------------

  /**
   * "Find / create". A SEARCH that may end in a create - never the reverse.
   *
   * The shortlist is re-read here rather than trusted from the screen, because
   * the debounce may not have fired yet and a stale empty list is exactly what
   * would produce the duplicate.
   */
  const findOrCreate = useCallback(async () => {
    const term = useCustomers.getState().query.trim();
    if (term === "" || !lookupGate.allowed) return;

    let candidates: CustomerMatch[];
    try {
      candidates = await searchCustomers(term);
    } catch (e) {
      toast.push({ tone: "error", message: "Could not search customers", detail: classifyError(e).message });
      return;
    }

    const decision = decideCreate({ query: term, candidates });

    if (decision.kind === "select") {
      // Already on file, however it was typed. Open them; never insert.
      await useCustomers.getState().select(decision.candidate.id);
      toast.push({ tone: "info", message: "This number is already on file", detail: "Opened the existing customer." });
      return;
    }

    if (decision.kind === "choose") {
      // The duplicate the raw-phone constraint already allowed. Show them and
      // let the operator pick - guessing could attach the wrong person.
      useCustomers.setState({ results: decision.candidates });
      toast.push({
        tone: "warning",
        message: "More than one customer has this number",
        detail: "Pick the right one. Do not add another.",
      });
      return;
    }

    if (decision.kind === "refused") {
      // Name-only searches land here: a shortlist, and no create offered.
      useCustomers.setState({ results: candidates });
      if (candidates.length === 0) toast.push({ tone: "info", message: decision.reason });
      return;
    }

    if (!writeGate.allowed) {
      toast.push({ tone: "warning", message: "Cannot add a customer", detail: writeGate.reason ?? "" });
      return;
    }
    setDialogError(null);
    setDialog({ kind: "customer", mode: "create", initial: { ...EMPTY_CUSTOMER_FORM, phone: decision.phone } });
  }, [lookupGate.allowed, toast, writeGate.allowed, writeGate.reason]);

  const submitCreate = useCallback(
    async (values: CustomerFormValues) => {
      if (!writeGate.allowed) return;
      setDialogError(null);
      setSaving(true);
      try {
        const payload = buildCreatePayload({
          branchId,
          phone: values.phone,
          name: values.name,
          notes: values.notes,
        });
        const outcome = await performCustomerCreate({
          payload,
          submit: upsertCustomer,
          // Used ONLY after a failure: the write may have landed before the
          // response was lost, so the phone is re-read rather than retried.
          recoverSearch: (phone) => searchCustomers(phone),
          latch: customerCreateLatch,
        });

        if (outcome.ok) {
          await useCustomers.getState().select(outcome.customerId);
          setDialog({ kind: "none" });
          toast.push({
            tone: "success",
            message: outcome.recovered ? "That customer was already saved" : "Customer added",
            detail: outcome.recovered ? "No second record was created." : undefined,
          });
          return;
        }

        const classified = classifyError(outcome.error);
        setDialogError(classified.hint ? `${classified.message} ${classified.hint}` : classified.message);
        if (!outcome.retryable) {
          // Ambiguous or duplicate: the operator must look before acting, so the
          // shortlist is refreshed rather than the create being offered again.
          void useCustomers.getState().search(values.phone);
        }
      } catch (e) {
        const classified = classifyError(e);
        setDialogError(classified.hint ? `${classified.message} ${classified.hint}` : classified.message);
      } finally {
        setSaving(false);
      }
    },
    [branchId, toast, writeGate.allowed],
  );

  // --- edit ------------------------------------------------------------------

  const submitEdit = useCallback(
    async (values: CustomerFormValues) => {
      const selected = useCustomers.getState().selected;
      if (!selected || !writeGate.allowed) return;
      setDialogError(null);
      setSaving(true);
      try {
        await upsertCustomer(
          buildEditPayload({
            branchId,
            customerId: selected.id,
            name: values.name,
            notes: values.notes,
            // Only sent when it actually changed - re-sending the same number is
            // harmless but pointless, and the field is the risky one.
            phone: values.phone.trim() === (selected.phone ?? "").trim() ? null : values.phone,
          }),
        );
        // Authoritative re-read. What the server stored is what the card shows.
        await useCustomers.getState().refresh();
        setDialog({ kind: "none" });
        toast.push({ tone: "success", message: "Customer updated" });
      } catch (e) {
        const classified = classifyError(e);
        setDialogError(classified.hint ? `${classified.message} ${classified.hint}` : classified.message);
      } finally {
        setSaving(false);
      }
    },
    [branchId, toast, writeGate.allowed],
  );

  // --- addresses -------------------------------------------------------------

  const submitAddress = useCallback(
    async (values: AddressFormValues) => {
      const state = useCustomers.getState();
      const selected = state.selected;
      if (!selected || !writeGate.allowed || dialog.kind !== "address") return;
      setDialogError(null);
      setSaving(true);
      try {
        const result = await upsertCustomer(
          buildAddressPayload({
            branchId,
            customerId: selected.id,
            address: { ...values, id: dialog.addressId },
          }),
        );
        await useCustomers.getState().refresh();
        // A newly added address becomes the chosen one - the operator asked for
        // it while looking at this customer, so it is the obvious intent.
        if (result.address_id) useCustomers.getState().selectAddress(result.address_id);
        setDialog({ kind: "none" });
        toast.push({ tone: "success", message: dialog.addressId ? "Address updated" : "Address added" });
      } catch (e) {
        const classified = classifyError(e);
        setDialogError(classified.hint ? `${classified.message} ${classified.hint}` : classified.message);
      } finally {
        setSaving(false);
      }
    },
    [branchId, dialog, toast, writeGate.allowed],
  );

  // --- render ----------------------------------------------------------------

  const openEditCustomer = useCallback(() => {
    const selected = useCustomers.getState().selected;
    if (!selected) return;
    setDialogError(null);
    setDialog({
      kind: "customer",
      mode: "edit",
      initial: { name: selected.name ?? "", phone: selected.phone ?? "", notes: selected.notes ?? "" },
    });
  }, []);

  const openAddAddress = useCallback(() => {
    setDialogError(null);
    setDialog({ kind: "address", mode: "create", addressId: null, initial: EMPTY_ADDRESS });
  }, []);

  const openEditAddress = useCallback((addressId: string) => {
    const selected = useCustomers.getState().selected;
    const address = selected?.addresses.find((a) => a.id === addressId);
    if (!address) return;
    setDialogError(null);
    setDialog({ kind: "address", mode: "edit", addressId, initial: addressToForm(address) });
  }, []);

  const card = (
    <CustomerCard
      customer={customers.selected}
      selectedAddressId={customers.selectedAddressId}
      loading={customers.loadingProfile}
      error={customers.profileError}
      writeGate={writeGate}
      onSelectAddress={customers.selectAddress}
      onEditCustomer={openEditCustomer}
      onAddAddress={openAddAddress}
      onEditAddress={openEditAddress}
      onOpenHistory={() => void customers.openHistory()}
      onClear={customers.clearSelection}
    />
  );

  const search = (
    <CustomerSearch
      query={customers.query}
      results={customers.results}
      searching={customers.searching}
      error={customers.searchError}
      lookupGate={lookupGate}
      writeGate={writeGate}
      saving={saving}
      onQueryChange={customers.setQuery}
      onFindOrCreate={() => void findOrCreate()}
      onPick={(id) => void customers.select(id)}
      onClear={() => {
        customers.setQuery("");
        customers.clearResults();
      }}
    />
  );

  const work = (layout: LayoutSpec) => (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
      <div className="rounded-2xl border border-line bg-white p-4">
        <p className="text-sm font-extrabold text-ink">Delivery customer</p>
        {/* Stated rather than implied by the absence of controls. */}
        <p className="mt-0.5 text-xs text-sub">
          Find or add the caller and confirm their address. Taking the delivery order itself is not available on the
          desktop yet.
        </p>
        <div className="mt-3">{search}</div>
      </div>

      {/* On drawer-width layouts there is no side panel and no bottom bar for
          Delivery, so the card lives here instead. */}
      {layout.cartAsDrawer && card}
    </div>
  );

  const panel = (_layout: LayoutSpec) => (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto border-l border-line bg-slate-50/60 p-3">
      {card}
    </div>
  );

  const dialogs = (
    <>
      <CustomerFormDialog
        open={dialog.kind === "customer"}
        mode={dialog.kind === "customer" ? dialog.mode : "create"}
        initial={dialog.kind === "customer" ? dialog.initial : EMPTY_CUSTOMER_FORM}
        saving={saving}
        error={dialogError}
        onSubmit={(values) =>
          void (dialog.kind === "customer" && dialog.mode === "create" ? submitCreate(values) : submitEdit(values))
        }
        onClose={() => {
          setDialog({ kind: "none" });
          setDialogError(null);
        }}
      />

      <AddressDialog
        open={dialog.kind === "address"}
        mode={dialog.kind === "address" ? dialog.mode : "create"}
        initial={dialog.kind === "address" ? dialog.initial : EMPTY_ADDRESS}
        saving={saving}
        error={dialogError}
        onSubmit={(values) => void submitAddress(values)}
        onClose={() => {
          setDialog({ kind: "none" });
          setDialogError(null);
        }}
      />

      <CustomerHistoryDialog
        open={customers.historyOpen}
        customer={customers.selected}
        loading={customers.historyLoading}
        onClose={customers.closeHistory}
      />
    </>
  );

  return { work, panel, dialogs, accessGate, lookupGate, writeGate };
}
