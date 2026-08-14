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
import {
  canCancelOrders,
  canEditOrders,
  canManageCustomers,
  canViewCustomers,
  canViewDelivery,
  canViewOrders,
} from "@/lib/pos/access";
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
import {
  buildDeliveryPaymentPayload,
  checkSettlementTarget,
  countPaymentRows,
  createSettlementLatch,
  deliveryIsSettled,
  deliveryPaymentGate,
  payDeliveryOrder,
  performDeliverySettlement,
  readOrderReceiptLines,
  readSettledOrder,
  validateDeliveryDiscount,
} from "@/lib/pos/deliverySettlement";
import {
  buildEditPayload as buildOrderEditPayload,
  checkOrderContext,
  createMutationLatch,
  editDeliveryOrder,
  editOrderGate,
  loadDeliveryOrderLines,
  loadDeliveryQueue,
  performEdit,
  performVoid,
  queueCounts,
  readDeliveryOrder,
  validateVoidReason,
  voidActionFor,
  voidDeliveryOrder,
  voidOrderGate,
  OrderChangedError,
  type DeliveryOrderLine,
  type DeliveryQueueOrder,
} from "@/lib/pos/deliveryOrderManagement";
import {
  editReached,
  loadOrderParties,
  loadShiftOpenMap,
  orderShiftOpen,
  readHistoricalReceipt,
  toOpenDeliveryOrder,
  type OrderParty,
} from "@/lib/pos/deliveryHistory";
import { DeliveryOrderQueue } from "@/components/pos/DeliveryOrderQueue";
import { DeliveryOrderDetail } from "@/components/pos/DeliveryOrderDetail";
import { EditOrderDialog, VoidOrderDialog, type EditOrderIntent } from "@/components/pos/DeliveryOrderDialogs";
import { computeDiscount } from "@/lib/pos/discounts";
import { PaymentDialog } from "@/components/pos/PaymentDialog";
import { computeChange, paymentBlockedReason, type PaymentMethod } from "@/lib/pos/payments";
import { buildReceipt, type ReceiptData } from "@/lib/receipt";
import type { DiscountType } from "@/lib/pos/discounts";
import { submitOrder } from "@/lib/pos/orders";
import type { KitchenSourceLine } from "@/lib/pos/kitchenPrinter";
import type { ResolverOrderSource } from "@/lib/pos/printRouting";
import { cartSubtotal } from "@/lib/pos/orders";
import { CartPanel } from "@/components/pos/CartPanel";
import { DeliveryOrderSummary } from "@/components/pos/DeliveryOrderSummary";
import { addressLine } from "@/components/pos/CustomerCard";
import { Button, EmptyState, GatedButton, Textarea } from "@/components/ui";
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

/**
 * Which part of Delivery is on screen.
 *
 * `orders` is Level 3D's operational queue. It is a VIEW of this workspace, not
 * a second POS architecture: the same shell, the same status bar, the same
 * payment dialog and the same receipt layer. A cross-order-type Orders screen is
 * deliberately out of scope - this one shows deliveries, which is what the
 * person answering the phone is responsible for.
 */
export type DeliveryView = "customer" | "add_items" | "orders";

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
  /** Level 3C. Settlement needs the payment permission and the tenant rate. */
  takePayments: Gate;
  applyDiscounts: Gate;
  /** Tenant USD->LBP rate. LBP is refused without one - never guessed. */
  rate: number | null;
  /**
   * Receipt presentation, routed through the caller so it reaches the SAME
   * store-owned layer takeaway and dine-in use - mounted outside this
   * component's loading states on purpose.
   */
  onPresentReceipt: (receipt: ReceiptData) => void;
  /**
   * Kitchen ticket for the batch that was just submitted, routed through the
   * caller for the same reason the receipt is - one implementation of "print
   * what was just sent", shared by all three POS routes.
   */
  onKitchenBatch: (input: {
    source: ResolverOrderSource;
    orderId: string;
    orderNumber: string;
    batchNo?: number | null;
    tableName?: string | null;
    customerName?: string | null;
    orderNote?: string | null;
    lines: KitchenSourceLine[];
  }) => Promise<void>;
  /** Authoritative cash-box re-read. The desktop never increments it locally. */
  refreshCashBox: () => Promise<void>;
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

  // --- Level 3C settlement state ---------------------------------------------
  const [payOpen, setPayOpen] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  /**
   * The one latch every settlement path shares - the Pay button, F4 and the
   * dialog's own confirm. A ref, not state: two confirms in the same tick would
   * both read a stale `paying === false`, and for money that is a second charge.
   */
  const payLatch = useRef(createSettlementLatch());
  /** Ensures the completion sequence - receipt included - runs once per payment. */
  const settleDone = useRef(false);
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

  // --- Level 3D order management state ---------------------------------------
  const [queue, setQueue] = useState<DeliveryQueueOrder[]>([]);
  const [queueLoading, setQueueLoading] = useState(false);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [parties, setParties] = useState<Map<string, OrderParty>>(new Map());
  /** Which of the queue's shifts are still open. Refunds depend on it. */
  const [shiftOpenMap, setShiftOpenMap] = useState<Map<string, boolean>>(new Map());
  const [detail, setDetail] = useState<DeliveryQueueOrder | null>(null);
  const [detailLines, setDetailLines] = useState<DeliveryOrderLine[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidBusy, setVoidBusy] = useState(false);
  const [voidError, setVoidError] = useState<string | null>(null);
  const [receiptBusy, setReceiptBusy] = useState(false);
  /** Which history row is assembling a receipt, so only that one shows busy. */
  const [receiptBusyId, setReceiptBusyId] = useState<string | null>(null);
  /**
   * One latch per mutation, held synchronously. Same reason as payment's: two
   * confirms in the same tick both read a stale `busy === false`, and for a
   * refund that is a second reversal request against a customer's money.
   */
  const editLatch = useRef(createMutationLatch());
  const voidLatch = useRef(createMutationLatch());

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

  // Level 3D. Three separate keys because the server checks three separate
  // things: reading the queue, editing an order, and cancelling or refunding it.
  const viewOrdersGate = useMemo(() => canViewOrders(pos.access), [pos.access]);
  const editOrdersPermission = useMemo(() => canEditOrders(pos.access), [pos.access]);
  const cancelOrdersPermission = useMemo(() => canCancelOrders(pos.access), [pos.access]);

  const editGate: Gate = useMemo(
    () =>
      editOrderGate({
        deliveryAccess: accessGate,
        canEditOrders: editOrdersPermission,
        order: detail,
        online,
        busy: editBusy,
      }),
    [accessGate, editOrdersPermission, detail, online, editBusy],
  );

  /**
   * Cancel OR refund - one gate, and the action inside it is derived from the
   * order's payment state. The refund branch asks whether the ORDER's shift is
   * open, never the operator's: `pos_void_order` locks the shift that took the
   * money, so a cashier at an open till cannot refund yesterday's order and must
   * not be shown a button that says otherwise.
   */
  const voidGate: Gate = useMemo(
    () =>
      voidOrderGate({
        deliveryAccess: accessGate,
        canCancelOrders: cancelOrdersPermission,
        order: detail,
        orderShiftOpen: orderShiftOpen(detail, shiftOpenMap),
        online,
        busy: voidBusy,
      }),
    [accessGate, cancelOrdersPermission, detail, shiftOpenMap, online, voidBusy],
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

      // The kitchen ticket, from the SNAPSHOT taken before the first await -
      // the same lines that were actually submitted, and the same discipline
      // that keeps the payload attached to the identity it was sent for. The
      // customer's NAME goes on the ticket and their address does not; a cook
      // does not deliver, and a ticket sits on an open pass.
      //
      // A recovered send prints too, and that is deliberate: the order exists
      // and this terminal has never produced a ticket for it. The latch keys on
      // the order id, so it still cannot produce a second one.
      await input.onKitchenBatch({
        source: "delivery",
        orderId: outcome.result.order_id,
        orderNumber: authoritative.order_number ?? outcome.result.order_number,
        batchNo: outcome.result.batch_no ?? 1,
        customerName: state.selected?.name ?? null,
        orderNote: snapshot.note,
        lines: snapshot.lines.map((l) => ({
          name: l.name,
          qty: l.quantity,
          modifiers: l.modifiers.map((m) => ({ name: m.name, quantity: m.quantity })),
          note: l.kitchen_note,
        })),
      });

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
  }, [sendGate.allowed, input.shiftId, input.onKitchenBatch, branchId, orderNote, pos.branch.id, pos.tenantId, toast]);

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

  // --- Level 3D: the operational queue ---------------------------------------

  /**
   * Re-read the queue, and with it the two things a row cannot answer alone:
   * who the order is for, and whether its shift is still open.
   *
   * Scope is decided entirely by `loadDeliveryQueue` - this shift when one is
   * open, today otherwise - and nothing here widens the tenant or the branch.
   */
  const refreshQueue = useCallback(async () => {
    setQueueLoading(true);
    setQueueError(null);
    try {
      const rows = await loadDeliveryQueue({
        tenantId: pos.tenantId,
        branchId,
        shiftId: input.shiftId,
        now: new Date(),
      });
      setQueue(rows);
      const [who, shifts] = await Promise.all([
        loadOrderParties(rows).catch(() => new Map<string, OrderParty>()),
        loadShiftOpenMap(rows.map((o) => o.shift_id)).catch(() => new Map<string, boolean>()),
      ]);
      setParties(who);
      setShiftOpenMap(shifts);
    } catch (e) {
      setQueueError(classifyError(e).message);
    } finally {
      setQueueLoading(false);
    }
  }, [pos.tenantId, branchId, input.shiftId]);

  /** Re-read ONE order and its lines. The authority behind every 3D control. */
  const refreshDetail = useCallback(async (orderId: string) => {
    setDetailLoading(true);
    setDetailError(null);
    try {
      const [fresh, lines] = await Promise.all([readDeliveryOrder(orderId), loadDeliveryOrderLines(orderId)]);
      setDetail(fresh);
      setDetailLines(lines);
      if (fresh?.shift_id) {
        const shifts = await loadShiftOpenMap([fresh.shift_id]).catch(() => new Map<string, boolean>());
        setShiftOpenMap((prev) => new Map([...prev, ...shifts]));
      }
    } catch (e) {
      setDetailError(classifyError(e).message);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const openDetail = useCallback(
    (order: DeliveryQueueOrder) => {
      // The row is shown immediately so the panel is never blank, then replaced
      // by an authoritative re-read - the list may be seconds old, and every
      // action on this panel is decided by the fresh copy.
      setDetail(order);
      setDetailLines([]);
      setEditError(null);
      setVoidError(null);
      void refreshDetail(order.id);
    },
    [refreshDetail],
  );

  // Load the queue when Orders is opened, and whenever the shift changes under
  // it - opening or closing a shift changes which orders the operator is
  // answerable for, and therefore which list this is.
  useEffect(() => {
    if (!active || view !== "orders" || !viewOrdersGate.allowed) return;
    void refreshQueue();
  }, [active, view, viewOrdersGate.allowed, refreshQueue]);

  // --- Level 3C: settlement ---------------------------------------------------

  /**
   * THE settlement gate. One result for the Pay button, F4 and the dialog's own
   * confirm, so no surface can hold a different opinion about whether this order
   * may be settled.
   */
  /**
   * WHICH order Pay would settle, and whether its own shift is open.
   *
   * Two surfaces can now ask for payment - the order just sent on the customer
   * half, and an order opened from the Level 3D queue - and they must reach the
   * SAME settlement path. So the target is resolved once here rather than each
   * surface passing its own order down: one gate, one dialog, one latch.
   *
   * The shift question differs between them, and that difference is real. An
   * order sent in this session belongs to this session's shift, so the open
   * shift is that shift. An order from the queue may belong to a shift that has
   * since closed, and `pos_pay_order` locks the ORDER's shift - so that one is
   * read rather than assumed.
   */
  const payTarget = useMemo(() => {
    if (view === "orders" && detail) {
      return {
        order: toOpenDeliveryOrder(detail),
        shiftOpen: orderShiftOpen(detail, shiftOpenMap),
        fromQueue: true,
      };
    }
    return { order: submitted?.order ?? null, shiftOpen: Boolean(input.shiftId), fromQueue: false };
  }, [view, detail, shiftOpenMap, submitted?.order, input.shiftId]);

  const payGate: Gate = useMemo(
    () =>
      deliveryPaymentGate({
        deliveryAccess: accessGate,
        takePayments: input.takePayments,
        order: payTarget.order,
        hasOpenShift: payTarget.shiftOpen,
        online,
        currencyBlockedReason: paymentBlockedReason(input.currency, input.rate),
        paying,
      }),
    [accessGate, input.takePayments, payTarget, online, input.currency, input.rate, paying],
  );

  /**
   * WHOSE order this is, for a receipt.
   *
   * Resolved from the ORDER's own customer and address ids - never from whoever
   * happens to be selected on the customer half of the workspace. Paying or
   * reprinting an order from the queue while a different caller is open on
   * screen would otherwise print that caller's name and address onto someone
   * else's delivery, which is the one mistake a receipt cannot survive.
   */
  const receiptIdentity = useCallback(
    (order: { id: string; customer_id: string | null; address_id: string | null }) => {
      const selected = useCustomers.getState().selected;
      if (selected && selected.id === order.customer_id) {
        const a = selected.addresses.find((x) => x.id === order.address_id) ?? null;
        return {
          customerName: selected.name ?? null,
          customerPhone: selected.phone ?? null,
          addressText: a ? addressLine(a) : null,
        };
      }
      const p = parties.get(order.id);
      return {
        customerName: p?.customerName ?? null,
        customerPhone: p?.customerPhone ?? null,
        addressText: p?.addressText ?? null,
      };
    },
    [parties],
  );

  /** Opens the dialog. Never charges - F4 and the button share this exactly. */
  const requestPay = useCallback(() => {
    if (!payGate.allowed) return;
    setPayError(null);
    setPayOpen(true);
  }, [payGate.allowed]);

  const settle = useCallback(
    async (confirm: {
      method: PaymentMethod;
      currency: CurrencyCode;
      discountType: DiscountType;
      discountValue: string;
      tendered: number | null;
    }) => {
      const order = payTarget.order;
      if (!order || !payGate.allowed) return;
      const fromQueue = payTarget.fromQueue;
      const intended = {
        orderId: order.id,
        customerId: order.customer_id,
        addressId: order.address_id,
        total: order.total_amount ?? 0,
      };
      setPayError(null);
      setPaying(true);
      settleDone.current = false;
      try {
        // The amount on screen is not authority to charge. Re-read first, and
        // refuse on ANY change to identity or money.
        const fresh = await readSettledOrder(intended.orderId);
        checkSettlementTarget(intended, fresh);

        const discount = validateDeliveryDiscount({
          canDiscount: input.applyDiscounts,
          subtotal: fresh?.total_amount ?? intended.total,
          type: confirm.discountType,
          value: confirm.discountValue,
        });

        const outcome = await performDeliverySettlement({
          payload: buildDeliveryPaymentPayload({
            orderId: intended.orderId,
            method: confirm.method,
            currency: confirm.currency,
            // Named fields only - `tendered` travels in the same object and has
            // no column on `pos_payments`.
            discount: discount.fields,
          }),
          submit: payDeliveryOrder,
          // Used only after a failure, and it asks BOTH questions: what the
          // order says, and whether a payment row exists.
          reread: async () => ({
            order: await readSettledOrder(intended.orderId),
            paymentRows: await countPaymentRows(intended.orderId),
          }),
          latch: payLatch.current,
        });

        if (!outcome.ok) {
          const c = classifyError(outcome.error);
          setPayError(c.hint ? `${c.message} ${c.hint}` : c.message);
          return;
        }
        if (settleDone.current) return;
        settleDone.current = true;

        // Completion, in the sequence `DELIVERY_COMPLETION_SEQUENCE` states, and
        // once. The order is re-read and CHECKED before anything is presented as
        // settled - a recovered payment has no response to trust.
        const settled = await readSettledOrder(intended.orderId);
        if (!deliveryIsSettled(settled)) {
          setPayError(
            "The payment was accepted but the order does not show as paid yet. Refresh before taking payment again.",
          );
          return;
        }
        await input.refreshCashBox().catch(() => {});
        await useCustomers.getState().refresh();

        const money = outcome.result;
        const lines = await readOrderReceiptLines(intended.orderId).catch(() => []);
        input.onPresentReceipt(
          buildReceipt({
            businessName: pos.tenantName,
            branchName: pos.branch.name,
            // Without this the receipt inherits the default and calls a delivery
            // "Takeaway" - wrong on the one document the customer keeps.
            orderType: "Delivery",
            orderSource: "delivery",
            staffName: pos.userName,
            orderNumber: settled!.order_number ?? "",
            at: new Date().toLocaleString(),
            paid: true,
            method: money?.method ?? confirm.method,
            currency: (money?.currency_code ?? input.currency) as CurrencyCode,
            lines,
            // Server figures win over anything computed here.
            subtotal: money?.subtotal ?? settled!.total_amount ?? 0,
            discount: money?.discount ?? 0,
            total: money?.amount ?? settled!.total_amount ?? 0,
            tenderCurrency: confirm.currency,
            tenderTotal: money?.original_amount ?? null,
            tendered: confirm.tendered,
            change:
              confirm.tendered == null
                ? null
                : computeChange(money?.original_amount ?? 0, confirm.tendered, confirm.currency).change,
            exchangeRate: money?.exchange_rate ?? null,
            shiftRef: input.shiftId,
            ...(() => {
              const who = receiptIdentity(order);
              return {
                customerName: who.customerName,
                customerPhone: who.customerPhone,
                deliveryAddress: who.addressText,
              };
            })(),
          }),
        );

        // Where the operator was decides what gets refreshed. A queue-driven
        // payment must leave the QUEUE authoritative, not swap the workspace
        // over to the customer half behind their back.
        if (fromQueue) {
          await refreshDetail(intended.orderId);
          void refreshQueue();
        } else {
          setSubmitted({ order: settled!, recovered: outcome.recovered });
        }
        setPayOpen(false);
        toast.push({
          tone: "success",
          message: outcome.recovered
            ? `Order #${settled!.order_number ?? ""} was already paid`
            : `Delivery order #${settled!.order_number ?? ""} paid`,
          detail: outcome.recovered ? "No second payment was taken." : "Completed.",
        });
      } catch (e) {
        const c = classifyError(e);
        setPayError(c.hint ? `${c.message} ${c.hint}` : c.message);
      } finally {
        setPaying(false);
      }
    },
    [payTarget, payGate.allowed, input, pos.branch.name, pos.userName, receiptIdentity, refreshDetail, refreshQueue, toast],
  );

  // --- Level 3D: edit ---------------------------------------------------------

  /**
   * Apply one edit.
   *
   * The order is re-read and re-checked immediately before the RPC, because a
   * gate that passed while the dialog was open says nothing about an order
   * another terminal has since paid or voided. `checkOrderContext` is the branch
   * check NEITHER RPC performs - it is mandatory here, not decorative.
   */
  const submitOrderEdit = useCallback(
    async (intent: EditOrderIntent) => {
      const target = detail;
      if (!target || !editGate.allowed) return;
      setEditBusy(true);
      setEditError(null);
      try {
        const fresh = await readDeliveryOrder(target.id);
        checkOrderContext(fresh, { orderId: target.id, branchOrderIds: new Set(queue.map((o) => o.id)) });
        const order = fresh as DeliveryQueueOrder;
        // Identity is not editable at this level, so it moving is a reason to
        // stop rather than something to write through.
        if (order.customer_id !== target.customer_id || order.address_id !== target.address_id) {
          throw new OrderChangedError("the customer or address changed");
        }

        const subtotal = order.subtotal ?? order.total_amount ?? 0;
        const payload = buildOrderEditPayload({
          orderId: order.id,
          note: intent.note,
          discount: intent.discount,
          isPaid: order.payment_status === "paid",
          canDiscount: input.applyDiscounts,
          subtotal,
        });
        // What the sent discount should compute to, so a lost response can be
        // resolved by looking rather than by re-sending.
        const expectedDiscountAmount =
          intent.discount === null
            ? null
            : intent.discount.type === "none"
              ? 0
              : computeDiscount(subtotal, intent.discount.type, intent.discount.value).amount;

        const outcome = await performEdit({
          payload,
          submit: editDeliveryOrder,
          reread: () => readDeliveryOrder(order.id),
          matches: (o) => editReached({ payload, expectedDiscountAmount, order: o }),
          latch: editLatch.current,
        });

        if (!outcome.ok) {
          const c = classifyError(outcome.error);
          setEditError(
            outcome.retryable
              ? `${c.message} Nothing was changed - you can try again.`
              : c.hint
                ? `${c.message} ${c.hint}`
                : c.message,
          );
          return;
        }

        setEditOpen(false);
        await refreshDetail(order.id);
        void refreshQueue();
        toast.push({
          tone: "success",
          message: outcome.recovered ? "That change was already saved" : "Order updated",
          detail: outcome.recovered ? "No second edit was sent." : undefined,
        });
      } catch (e) {
        const c = classifyError(e);
        setEditError(c.hint ? `${c.message} ${c.hint}` : c.message);
        // A refused edit means the screen is stale, so it is refreshed rather
        // than left showing the state the operator acted on.
        void refreshDetail(target.id);
      } finally {
        setEditBusy(false);
      }
    },
    [detail, editGate.allowed, queue, input.applyDiscounts, refreshDetail, refreshQueue, toast],
  );

  // --- Level 3D: cancel / refund ----------------------------------------------

  /**
   * Cancel an unpaid order, or refund a paid one.
   *
   * The action is derived from the order's payment state - twice. Once when the
   * dialog is opened, and again against the FRESH read here: if the order was
   * paid on another terminal while this dialog sat open, the operator's "cancel"
   * is no longer the action the server would perform, and it stops.
   *
   * The refund gate is also re-evaluated against a freshly read shift state, so
   * a refund whose shift has closed never reaches `pos_void_order` at all.
   */
  const submitOrderVoid = useCallback(
    async (rawReason: string) => {
      const target = detail;
      if (!target) return;
      const intendedAction = voidActionFor(target);
      setVoidBusy(true);
      setVoidError(null);
      try {
        const reason = validateVoidReason(rawReason);

        const fresh = await readDeliveryOrder(target.id);
        checkOrderContext(fresh, { orderId: target.id, branchOrderIds: new Set(queue.map((o) => o.id)) });
        const order = fresh as DeliveryQueueOrder;
        if (voidActionFor(order) !== intendedAction) {
          throw new OrderChangedError("its payment state changed - check the order again");
        }

        const shifts = await loadShiftOpenMap([order.shift_id]);
        const gate = voidOrderGate({
          deliveryAccess: accessGate,
          canCancelOrders: cancelOrdersPermission,
          order,
          orderShiftOpen: orderShiftOpen(order, shifts),
          online,
          busy: false,
        });
        setShiftOpenMap((prev) => new Map([...prev, ...shifts]));
        if (!gate.allowed) throw new Error(gate.reason ?? "This action is not available for this order.");

        const outcome = await performVoid({
          orderId: order.id,
          reason,
          // NOT a boolean. `p_refund` is derived from this by the adapter, so no
          // surface here can ask for a refund on an unpaid order or a bare void
          // on a paid one.
          action: intendedAction,
          submit: voidDeliveryOrder,
          reread: () => readDeliveryOrder(order.id),
          latch: voidLatch.current,
        });

        if (!outcome.ok) {
          const c = classifyError(outcome.error);
          setVoidError(
            outcome.retryable
              ? `${c.message} Nothing was changed - check the order before trying again.`
              : c.hint
                ? `${c.message} ${c.hint}`
                : c.message,
          );
          return;
        }

        setVoidOpen(false);
        await refreshDetail(order.id);
        void refreshQueue();
        // A recovered void is a REPLAY, not a second reversal - the server keys
        // this operation per order, so saying so is accurate and worth saying.
        toast.push({
          tone: "success",
          message: outcome.recovered
            ? intendedAction === "refund"
              ? "That refund had already been recorded"
              : "That order was already cancelled"
            : intendedAction === "refund"
              ? "Refund recorded"
              : "Order cancelled",
          detail: outcome.recovered ? "Nothing was reversed twice." : undefined,
        });
      } catch (e) {
        const c = classifyError(e);
        setVoidError(c.hint ? `${c.message} ${c.hint}` : c.message);
        void refreshDetail(target.id);
      } finally {
        setVoidBusy(false);
      }
    },
    [detail, queue, accessGate, cancelOrdersPermission, online, refreshDetail, refreshQueue, toast],
  );

  // --- Level 3D: the receipt for a past order ---------------------------------

  /**
   * Reopen a past order's receipt.
   *
   * Three reads and no writes: the order's lines, its payment row if it has one,
   * and the identity it was sent to. It takes no payment and needs none - the
   * gap this closes is that until now the ONLY way to see a delivery receipt was
   * to have just paid for it.
   */
  const openHistoricalReceipt = useCallback(
    async (order: DeliveryQueueOrder) => {
      setReceiptBusy(true);
      try {
        const receipt = await readHistoricalReceipt({
          order,
          party: receiptIdentity(order),
          tenantName: pos.tenantName,
          branchName: pos.branch.name,
          staffName: pos.userName,
          fallbackCurrency: input.currency,
          // The order's OWN time. A reprint that stamps itself with the current
          // clock claims the sale happened when it was reprinted.
          at: order.created_at ? new Date(order.created_at).toLocaleString() : "",
        });
        input.onPresentReceipt(receipt);
      } catch (e) {
        toast.push({ tone: "error", message: "Could not open the receipt", detail: classifyError(e).message });
      } finally {
        setReceiptBusy(false);
      }
    },
    [receiptIdentity, pos.tenantName, pos.branch.name, pos.userName, input, toast],
  );

  /**
   * The same receipt, reached from the customer's order history.
   *
   * The order is re-read by id rather than taken from the history row, because
   * that row carries no subtotal, discount, note or shift - and a receipt
   * assembled from a partial row would be a document with invented figures on
   * it. This is the only path to an order older than today: the queue is scoped
   * to the open shift, or to today when there is none.
   */
  const openHistoricalReceiptById = useCallback(
    async (orderId: string) => {
      setReceiptBusyId(orderId);
      try {
        const order = await readDeliveryOrder(orderId);
        if (!order) {
          toast.push({ tone: "warning", message: "That order is no longer available" });
          return;
        }
        await openHistoricalReceipt(order);
      } catch (e) {
        toast.push({ tone: "error", message: "Could not open the receipt", detail: classifyError(e).message });
      } finally {
        setReceiptBusyId(null);
      }
    },
    [openHistoricalReceipt, toast],
  );

  // F4 OPENS the dialog and never charges, through the same gate as the button.
  // Live on the customer half AND on the Orders queue, because both resolve to
  // the same `payTarget` and the same Level 3C settlement path. Off in Add Items,
  // where Ctrl+Enter owns the keyboard and there is no order to pay yet.
  useShortcuts({ openPayment: requestPay }, active && view !== "add_items" && payGate.allowed);

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

  /**
   * The one switch between taking an order and managing the ones already taken.
   *
   * Two buttons rather than a new route: Delivery is a single workspace with a
   * single shell, and an operator answering a phone must be able to move between
   * "who is calling" and "where is that order" without leaving what they are in
   * the middle of. Nothing about the cart, the customer or the shift changes
   * when this flips.
   */
  const viewSwitch = (
    <div className="flex shrink-0 gap-2">
      <Button
        variant={view === "orders" ? "ghost" : "primary"}
        size="lg"
        className="flex-1"
        onClick={() => setView("customer")}
      >
        Customers / New order
      </Button>
      <GatedButton
        gate={viewOrdersGate}
        variant={view === "orders" ? "primary" : "ghost"}
        size="lg"
        className="flex-1"
        onClick={() => setView("orders")}
      >
        Orders
      </GatedButton>
    </div>
  );

  const counts = useMemo(() => queueCounts(queue), [queue]);

  // NB there is no `add_items` branch here. While Add Items is open the SHELL
  // owns the work area and renders the menu into it; this function is not
  // called at all. The identity strip is returned as `identity` instead, so the
  // shell can pin it above that menu - see `PosWorkspace`.
  const work = (layout: LayoutSpec) =>
    view === "orders" ? (
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        {viewSwitch}
        {viewOrdersGate.allowed ? (
          <DeliveryOrderQueue
            orders={queue}
            parties={parties}
            counts={counts}
            /* The scope sentence is derived from the SAME condition the reader
               uses, so the list can never describe itself wrongly. */
            shiftScoped={Boolean(input.shiftId)}
            currency={input.currency}
            loading={queueLoading}
            error={queueError}
            selectedId={detail?.id ?? null}
            onSelect={openDetail}
            onRefresh={() => void refreshQueue()}
          />
        ) : (
          <div className="rounded-2xl border border-line bg-white p-4">
            <EmptyState title="Orders are not available for this account" hint={viewOrdersGate.reason ?? undefined} />
          </div>
        )}
      </div>
    ) : (
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
        {viewSwitch}
        <div className="rounded-2xl border border-line bg-white p-4">
          <p className="text-sm font-extrabold text-ink">Delivery customer</p>
          <p className="mt-0.5 text-xs text-sub">
            Find or add the caller, confirm their address, then add items. An unpaid order can be opened below and
            settled here.
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
            {/* Clickable, because a RECOVERED order is the normal case after a
                reload: without this the only payable order would be one sent in
                this same session, and an order sent before a crash could never
                be settled from the desktop at all. */}
            <ul className="mt-1 space-y-0.5">
              {openOrders.map((o) => (
                <li key={o.id}>
                  <button
                    type="button"
                    onClick={() => setSubmitted({ order: o, recovered: true })}
                    className="min-h-[44px] w-full rounded-lg px-2 text-left text-[11px] font-semibold text-amber-900 hover:bg-amber-100"
                  >
                    #{o.order_number ?? o.id.slice(0, 8)} · {kitchenStateLabel(o.status)} · unpaid — open to take payment
                  </button>
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
      {view === "orders" ? (
        detail ? (
          <DeliveryOrderDetail
            order={detail}
            party={parties.get(detail.id) ?? null}
            lines={detailLines}
            linesLoading={detailLoading}
            linesError={detailError}
            currency={input.currency}
            /* Derived from the order's payment state. The panel is TOLD which
               action this is; it never works it out from a checkbox. */
            voidAction={voidActionFor(detail)}
            editGate={editGate}
            voidGate={voidGate}
            payGate={payGate}
            receiptBusy={receiptBusy}
            onBack={() => setDetail(null)}
            onEdit={() => {
              setEditError(null);
              setEditOpen(true);
            }}
            onVoid={() => {
              setVoidError(null);
              setVoidOpen(true);
            }}
            /* The SAME entry point F4 and the customer half use. */
            onPay={requestPay}
            onReceipt={() => void openHistoricalReceipt(detail)}
          />
        ) : (
          <EmptyState
            icon="-"
            title="Select an order"
            hint="Open an order from the list to see its items, edit it, take payment or cancel it."
          />
        )
      ) : submitted && customers.selected ? (
        <DeliveryOrderSummary
          order={submitted.order}
          customer={customers.selected}
          address={customers.selected.addresses.find((a) => a.id === submitted.order.address_id) ?? null}
          currency={input.currency}
          recovered={submitted.recovered}
          onStartNewOrder={startNewOrder}
          /* The SAME gate F4 uses. The component renders Pay only while the
             order is unpaid, so a settled order has nothing to press again. */
          payGate={payGate}
          onPay={requestPay}
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

      {/* The SHARED payment dialog - not a delivery copy. Only the identity at
          the top differs, which is exactly the part that should. */}
      <PaymentDialog
        open={payOpen}
        busy={paying}
        /* Everything below comes from the resolved pay TARGET, so the dialog
           describes the order that would actually be charged - whether it was
           just sent, or opened from the Level 3D queue while a different
           customer happens to be selected behind it. */
        subtotal={payTarget.order?.total_amount ?? 0}
        primaryCurrency={input.currency}
        rate={input.rate}
        discountGate={input.applyDiscounts}
        payGate={payGate}
        orderNumber={payTarget.order?.order_number ?? null}
        delivery={{
          customerName: payTarget.order ? (receiptIdentity(payTarget.order).customerName ?? "Customer") : "Customer",
          address: payTarget.order ? receiptIdentity(payTarget.order).addressText : null,
        }}
        error={payError}
        onCancel={() => {
          setPayOpen(false);
          setPayError(null);
        }}
        onConfirm={(v) => void settle(v)}
      />

      {/* Level 3D. Both are opened only from the detail panel, and both re-read
          the order authoritatively before the RPC - the dialog's own state is
          never the authority for a mutation. */}
      <EditOrderDialog
        open={editOpen}
        order={detail}
        currency={input.currency}
        discountGate={input.applyDiscounts}
        saveGate={editGate}
        busy={editBusy}
        error={editError}
        onCancel={() => {
          setEditOpen(false);
          setEditError(null);
        }}
        onSubmit={(intent) => void submitOrderEdit(intent)}
      />

      <VoidOrderDialog
        open={voidOpen}
        /* Not a prop the dialog can argue with: an unpaid order gets Cancel, a
           paid one gets Refund, and `p_refund` is derived from that by the
           adapter rather than chosen anywhere in the UI. */
        action={detail ? voidActionFor(detail) : "cancel"}
        order={detail}
        customerName={detail ? (parties.get(detail.id)?.customerName ?? null) : null}
        currency={input.currency}
        gate={voidGate}
        busy={voidBusy}
        error={voidError}
        onCancel={() => {
          setVoidOpen(false);
          setVoidError(null);
        }}
        onConfirm={(reason) => void submitOrderVoid(reason)}
      />

      <CustomerHistoryDialog
        open={customers.historyOpen}
        customer={customers.selected}
        loading={customers.historyLoading}
        onClose={customers.closeHistory}
        /* Level 3D. Still read only - this reopens a receipt, it does not
           reorder, edit or refund anything. */
        onReceipt={(orderId) => void openHistoricalReceiptById(orderId)}
        receiptBusyId={receiptBusyId}
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
