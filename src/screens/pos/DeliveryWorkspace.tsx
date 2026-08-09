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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { customerCreateLatch, SEARCH_DEBOUNCE_MS, selectedAddress, useCustomers } from "@/state/customers";
import {
  buildDeliveryPayload,
  createDeliveryLatch,
  deliveryOrderGate,
  kitchenStateLabel,
  loadOpenDeliveryOrders,
  performDeliveryOrder,
  revalidateTarget,
  type OpenDeliveryOrder,
} from "@/lib/pos/deliveryOrder";
import { submitOrder } from "@/lib/pos/orders";
import { cartSubtotal } from "@/lib/pos/orders";
import { CartPanel } from "@/components/pos/CartPanel";
import { DeliveryOrderSummary } from "@/components/pos/DeliveryOrderSummary";
import { addressLine } from "@/components/pos/CustomerCard";
import { Button, GatedButton, Textarea } from "@/components/ui";
import { Modal } from "@/components/overlays";
import { useCart, type CartOwner } from "@/state/cart";
import { useShortcuts } from "@/lib/keyboard/provider";
import type { PosContext } from "@/state/pos";
import type { LayoutSpec } from "@/lib/layout";
import type { CurrencyCode } from "@/lib/currency";
import type { CartLine } from "@/types/pos";
import type { Gate } from "@/components/ui";

const EMPTY_CUSTOMER_FORM: CustomerFormValues = { name: "", phone: "", notes: "" };

/** Which dialog is open. One value rather than four booleans, so only one can be. */
type DeliveryDialog =
  | { kind: "none" }
  | { kind: "customer"; mode: "create" | "edit"; initial: CustomerFormValues }
  | { kind: "address"; mode: "create" | "edit"; addressId: string | null; initial: AddressFormValues };

/** Which half of Delivery is on screen. Add Items borrows the shell's menu. */
export type DeliveryView = "customer" | "add_items";

export type DeliveryWorkspace = {
  view: DeliveryView;
  /** The search area. Also carries the customer card on drawer-width layouts. */
  work: (layout: LayoutSpec) => React.ReactNode;
  /** The side panel: the customer card, the cart, or the order that was sent. */
  panel: (layout: LayoutSpec) => React.ReactNode;
  dialogs: React.ReactNode;
  /** Entering the workspace at all: POS access + the `pos.delivery` sub-feature. */
  accessGate: Gate;
  /** Reading the customer book. */
  lookupGate: Gate;
  /** Creating or editing a customer. */
  writeGate: Gate;
  /**
   * THE submit gate. Exported so the cart panel, the drawer-width action and
   * Ctrl+Enter all render from the same result - never a second opinion.
   */
  sendGate: Gate;
  /** Sends the order. Safe to call from any surface: one latch, one op id. */
  requestSend: () => void;
  /** The cart owner Delivery would claim right now, or null when it cannot. */
  cartOwner: CartOwner | null;
  /** True while an unsent basket belongs to Delivery. */
  hasCart: boolean;
  /** Leave Add Items. May open a confirmation instead of leaving. */
  requestLeaveAddItems: () => void;
  /**
   * Who the order being composed is for.
   *
   * Rendered by the SHELL, because while Add Items is open the shell owns the
   * work area and shows the menu there. Returning it as a node rather than
   * drawing it inside `work()` is the only way it can appear on the one screen
   * where it matters most - the screen where items are being chosen.
   */
  identity: React.ReactNode;
};

export function useDeliveryWorkspace(input: {
  pos: PosContext;
  active: boolean;
  online: boolean;
  /** The open shift's id. Required on the payload - never inferred. */
  shiftId: string | null;
  createOrders: Gate;
  currency: CurrencyCode;
  cartLines: CartLine[];
  cartSelectedKey: string | null;
  onSelectLine: (key: string) => void;
  onAdjustLine: (key: string, delta: number) => void;
  onRemoveLine: (key: string) => void;
  onEditNote: (key: string) => void;
  onOpenShift: () => void;
}): DeliveryWorkspace {
  const { pos, active, online } = input;
  const toast = useToast();
  const customers = useCustomers();
  const cart = useCart();

  const [dialog, setDialog] = useState<DeliveryDialog>({ kind: "none" });
  const [dialogError, setDialogError] = useState<string | null>(null);
  /**
   * Mirrors the create latch for RE-RENDERING only. The latch itself is the
   * authority; this flag exists so the gate can grey the button out.
   */
  const [saving, setSaving] = useState(false);

  // --- Level 3B ordering state ------------------------------------------------
  const [view, setView] = useState<DeliveryView>("customer");
  const [orderNote, setOrderNote] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<{ order: OpenDeliveryOrder; recovered: boolean } | null>(null);
  const [openOrders, setOpenOrders] = useState<OpenDeliveryOrder[]>([]);
  /** Customer the operator wants to switch to while a Delivery cart is loaded. */
  const [switchTo, setSwitchTo] = useState<string | null>(null);
  /**
   * The one latch every send path shares. A ref, not state: two clicks in the
   * same tick would both read a stale `sending === false`.
   */
  const sendLatch = useRef(createDeliveryLatch());
  /** Ensures the completion sequence runs once per accepted order. */
  const completionDone = useRef(false);

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

  // --- Level 3B: the order under construction --------------------------------

  const customerId = customers.selected?.id ?? null;
  const address = selectedAddress(customers);
  const addressId = address?.id ?? null;

  /**
   * Who this cart belongs to. The CUSTOMER is part of the identity: a basket
   * built for one caller must never be sendable against another's name and
   * address (see `state/cart.ts`).
   */
  const cartOwner: CartOwner | null = customerId ? { kind: "delivery", customerId } : null;
  /** Lines currently in the shared buffer that belong to THIS delivery customer. */
  const deliveryLines = useMemo(
    () =>
      cart.owner?.kind === "delivery" && customerId && cart.owner.customerId === customerId ? input.cartLines : [],
    [cart.owner, customerId, input.cartLines],
  );
  const hasCart = cart.owner?.kind === "delivery" && input.cartLines.length > 0;
  const subtotal = useMemo(() => cartSubtotal(deliveryLines), [deliveryLines]);

  const sendGate: Gate = useMemo(
    () =>
      deliveryOrderGate({
        deliveryAccess: accessGate,
        createOrders: input.createOrders,
        hasOpenShift: Boolean(input.shiftId),
        online,
        customerId,
        addressId,
        lineCount: deliveryLines.length,
        sending,
      }),
    [accessGate, input.createOrders, input.shiftId, online, customerId, addressId, deliveryLines.length, sending],
  );

  /** Entering Add Items needs a customer and an address, but not yet a cart. */
  const addItemsGate: Gate = useMemo(() => {
    if (!accessGate.allowed) return accessGate;
    if (!input.createOrders.allowed) return input.createOrders;
    if (!customerId) return { allowed: false, reason: "Choose a customer first." };
    if (!addressId) return { allowed: false, reason: "Choose the delivery address first." };
    return { allowed: true, reason: null };
  }, [accessGate, input.createOrders, customerId, addressId]);

  // Re-read this customer's live delivery orders whenever they are opened. This
  // IS the recovery model: after a reload nothing survives in memory, and the
  // operator finds the order they sent here rather than sending it again.
  useEffect(() => {
    if (!active || !customerId) {
      setOpenOrders([]);
      return;
    }
    let cancelled = false;
    void loadOpenDeliveryOrders({ tenantId: pos.tenantId, branchId, customerId })
      .then((rows) => {
        if (!cancelled) setOpenOrders(rows);
      })
      .catch(() => {
        if (!cancelled) setOpenOrders([]);
      });
    return () => {
      cancelled = true;
    };
  }, [active, customerId, pos.tenantId, branchId, submitted?.order.id]);

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

  // --- Level 3B: sending ------------------------------------------------------

  /**
   * Send the order, once.
   *
   * Everything the request depends on is SNAPSHOTTED before the first await:
   * customer, address, shift, branch, lines and the operation id. A customer
   * switch that lands while this is in flight cannot reach the payload, and the
   * response is attached to the identity that was submitted - not to whoever is
   * selected by the time it comes back.
   */
  const send = useCallback(async () => {
    if (!sendGate.allowed) return;
    const state = useCustomers.getState();
    const snapshot = {
      customerId: state.selected?.id ?? null,
      addressId: state.selectedAddressId,
      shiftId: input.shiftId,
      branchId,
      lines: useCart.getState().lines,
      // One id per intended order: minted on the first line, reused by every
      // retry, and cleared only once an order is definitively accepted.
      clientOpId: useCart.getState().ensureOpId(),
      note: orderNote.trim() === "" ? null : orderNote.trim(),
    };
    if (!snapshot.customerId || !snapshot.addressId) return;

    setSendError(null);
    setSending(true);
    completionDone.current = false;
    try {
      // The check the server does not make. Done against the SNAPSHOT, so it
      // validates what will actually be sent.
      await revalidateTarget(
        { customerId: snapshot.customerId, addressId: snapshot.addressId, branchId: snapshot.branchId },
        pos.branch.id,
      );

      const payload = buildDeliveryPayload({
        branchId: snapshot.branchId,
        shiftId: snapshot.shiftId,
        clientOpId: snapshot.clientOpId,
        lines: snapshot.lines,
        customerId: snapshot.customerId,
        addressId: snapshot.addressId,
        orderNote: snapshot.note,
      });

      const outcome = await performDeliveryOrder({
        payload,
        submit: submitOrder,
        // Used only after a failure, and scoped to the SUBMITTED customer.
        recoverSearch: () =>
          loadOpenDeliveryOrders({
            tenantId: pos.tenantId,
            branchId: snapshot.branchId,
            customerId: snapshot.customerId as string,
          }),
        // The note is what distinguishes this attempt from a live order the
        // customer already had. Without it, an unrelated open order would be
        // reported as ours.
        matchesIntent: (o) => o.address_id === snapshot.addressId && o.notes === snapshot.note,
        latch: sendLatch.current,
      });

      if (!outcome.ok) {
        const classified = classifyError(outcome.error);
        setSendError(classified.hint ? `${classified.message} ${classified.hint}` : classified.message);
        return;
      }
      if (completionDone.current) return;
      completionDone.current = true;

      // Completion, in this order and once. The cart is cleared only after the
      // server has accepted the order, never before: clearing on a failure would
      // destroy a basket the kitchen never saw.
      const rows = await loadOpenDeliveryOrders({
        tenantId: pos.tenantId,
        branchId: snapshot.branchId,
        customerId: snapshot.customerId,
      }).catch(() => [] as OpenDeliveryOrder[]);
      const authoritative = rows.find((o) => o.id === outcome.result.order_id) ?? {
        id: outcome.result.order_id,
        order_number: outcome.result.order_number,
        status: "sent_to_kitchen",
        payment_status: "unpaid",
        total_amount: outcome.result.total,
        currency: null,
        customer_id: snapshot.customerId,
        address_id: snapshot.addressId,
        notes: snapshot.note,
        created_at: null,
      };
      setOpenOrders(rows);
      setSubmitted({ order: authoritative, recovered: outcome.recovered });
      // Only this delivery basket. Takeaway and dine-in state is untouched.
      useCart.getState().reset();
      setOrderNote("");
      setView("customer");
      // Authoritative history refresh - server values, never a local increment.
      await useCustomers.getState().refresh();
      toast.push({
        tone: "success",
        message: outcome.recovered
          ? `Delivery order #${authoritative.order_number ?? ""} was already sent`
          : `Delivery order #${authoritative.order_number ?? ""} sent to kitchen`,
        detail: outcome.recovered ? "No second order was created." : "Not paid yet.",
      });
    } catch (e) {
      const classified = classifyError(e);
      setSendError(classified.hint ? `${classified.message} ${classified.hint}` : classified.message);
    } finally {
      setSending(false);
    }
  }, [sendGate.allowed, input.shiftId, branchId, orderNote, pos.branch.id, pos.tenantId, toast]);

  const requestSend = useCallback(() => void send(), [send]);

  /**
   * Choosing a different customer while a basket is loaded.
   *
   * The basket belongs to the customer it was built for, so this does not
   * silently re-point it and does not silently throw it away either - it asks.
   * Blocking with an explicit choice is the only option that cannot produce the
   * wrong outcome by accident.
   */
  const selectCustomer = useCallback(
    (id: string) => {
      const c = useCart.getState();
      if (c.lines.length > 0 && c.owner?.kind === "delivery" && c.owner.customerId !== id) {
        setSwitchTo(id);
        return;
      }
      void useCustomers.getState().select(id);
      setSubmitted(null);
    },
    [],
  );

  const confirmSwitch = useCallback(() => {
    const id = switchTo;
    setSwitchTo(null);
    if (!id) return;
    // A new customer is a new order: the basket AND its operation id go, so the
    // next send cannot replay under the previous order's key.
    useCart.getState().reset();
    setOrderNote("");
    setSubmitted(null);
    void useCustomers.getState().select(id);
  }, [switchTo]);

  const requestLeaveAddItems = useCallback(() => setView("customer"), []);

  const startNewOrder = useCallback(() => {
    setSubmitted(null);
    setSendError(null);
    useCart.getState().reset();
    setOrderNote("");
  }, []);

  // Ctrl+Enter sends, through the SAME gate and latch as the button. Live only
  // while Delivery is composing an order, so it cannot fire from the customer
  // search box or reach any other workspace.
  useShortcuts(
    { confirmPayment: requestSend },
    active && view === "add_items" && dialog.kind === "none" && switchTo === null,
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
      onPick={selectCustomer}
      onClear={() => {
        customers.setQuery("");
        customers.clearResults();
      }}
    />
  );

  /** Who this order is for. Pinned above the menu so it is never out of sight. */
  const identityStrip = (
    <div className="flex flex-wrap items-center gap-2 rounded-xl bg-brand-soft px-3 py-2">
      <span className="text-xs font-extrabold text-brand-dark">{customers.selected?.name ?? "Customer"}</span>
      <span className="text-[11px] font-semibold text-brand-dark/80">{customers.selected?.phone ?? ""}</span>
      {address && <span className="min-w-0 truncate text-[11px] text-brand-dark/80">· {addressLine(address)}</span>}
    </div>
  );

  const cartPanel = (
    <CartPanel
      lines={deliveryLines}
      selectedKey={input.cartSelectedKey}
      currency={input.currency}
      subtotal={subtotal}
      shiftOpen={Boolean(input.shiftId)}
      busy={sending}
      savedOrderNumber={null}
      createGate={sendGate}
      /* No payGate and no onPay: the Pay control is not rendered at all. */
      sendLabel="Send to kitchen (Ctrl+Enter)"
      onSelect={input.onSelectLine}
      onAdjust={input.onAdjustLine}
      onRemove={input.onRemoveLine}
      onEditNote={input.onEditNote}
      onSendToKitchen={requestSend}
      onOpenShift={input.onOpenShift}
      onNewOrder={startNewOrder}
    />
  );

  const noteBox = (
    <div className="rounded-2xl border border-line bg-white p-3">
      <label className="block">
        <span className="text-xs font-bold text-ink">Delivery note</span>
        {/* The order-level note. Kept separate from an item's kitchen note: the
            server stores them in different columns, and concatenating them would
            put the driver's instructions on the kitchen ticket. */}
        <Textarea
          className="mt-1"
          rows={2}
          value={orderNote}
          placeholder="Anything about this order as a whole"
          onChange={(e) => setOrderNote(e.target.value)}
        />
      </label>
    </div>
  );

  // NB there is no `add_items` branch here. While Add Items is open the SHELL
  // owns the work area and renders the menu into it; this function is not
  // called at all. The identity strip is returned as `identity` instead, so the
  // shell can pin it above that menu - see `PosWorkspace`.
  const work = (layout: LayoutSpec) => (
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
        <div className="rounded-2xl border border-line bg-white p-4">
          <p className="text-sm font-extrabold text-ink">Delivery customer</p>
          <p className="mt-0.5 text-xs text-sub">
            Find or add the caller, confirm their address, then add items. Taking payment for a delivery order is not
            available on the desktop yet.
          </p>
          <div className="mt-3">{search}</div>
        </div>

        {customers.selected && (
          <div className="rounded-2xl border border-line bg-white p-4">
            <GatedButton
              gate={addItemsGate}
              variant="primary"
              size="lg"
              className="w-full"
              onClick={() => setView("add_items")}
            >
              Add items
            </GatedButton>
            {hasCart && (
              <p className="mt-2 text-[11px] font-semibold text-brand-dark">
                {deliveryLines.length} item{deliveryLines.length === 1 ? "" : "s"} waiting to be sent.
              </p>
            )}
          </div>
        )}

        {openOrders.length > 0 && !submitted && (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3">
            <p className="text-xs font-bold text-amber-900">
              {openOrders.length} unpaid delivery order{openOrders.length === 1 ? "" : "s"} for this customer
            </p>
            <ul className="mt-1 space-y-0.5">
              {openOrders.map((o) => (
                <li key={o.id} className="text-[11px] text-amber-900">
                  #{o.order_number ?? o.id.slice(0, 8)} · {kitchenStateLabel(o.status)} · unpaid
                </li>
              ))}
            </ul>
          </div>
        )}

      {layout.cartAsDrawer && card}
    </div>
  );

  const panel = (_layout: LayoutSpec) => (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto border-l border-line bg-slate-50/60 p-3">
      {submitted && customers.selected ? (
        <DeliveryOrderSummary
          order={submitted.order}
          customer={customers.selected}
          address={customers.selected.addresses.find((a) => a.id === submitted.order.address_id) ?? null}
          currency={input.currency}
          recovered={submitted.recovered}
          onStartNewOrder={startNewOrder}
        />
      ) : view === "add_items" ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          {noteBox}
          <div className="min-h-0 flex-1">{cartPanel}</div>
          {sendError && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">{sendError}</p>
          )}
        </div>
      ) : (
        card
      )}
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

      {/* A populated basket belongs to the customer it was built for. Switching
          neither re-points it nor discards it silently - the operator decides,
          because both of the silent options can be the wrong one. */}
      <Modal
        open={switchTo !== null}
        size="sm"
        title="Start a new customer's order?"
        subtitle={`${deliveryLines.length} item${deliveryLines.length === 1 ? "" : "s"} are waiting to be sent for ${customers.selected?.name ?? "this customer"}.`}
        onClose={() => setSwitchTo(null)}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="lg" onClick={() => setSwitchTo(null)}>
              Keep this order
            </Button>
            <Button variant="danger" size="lg" onClick={confirmSwitch}>
              Discard and switch
            </Button>
          </div>
        }
      >
        <p className="text-sm text-ink">
          These items were added for {customers.selected?.name ?? "the current customer"}. They cannot be sent for
          anyone else, so switching now discards them.
        </p>
        <p className="mt-2 text-xs text-sub">Send the order first if you want to keep it.</p>
      </Modal>
    </>
  );

  return {
    view,
    work,
    panel,
    dialogs,
    accessGate,
    lookupGate,
    writeGate,
    sendGate,
    requestSend,
    cartOwner,
    hasCart,
    requestLeaveAddItems,
    identity: identityStrip,
  };
}
