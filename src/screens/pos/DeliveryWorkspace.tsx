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
  canCaptureDeliveryCost,
  canEditOrders,
  canManageCustomers,
  canViewCustomers,
  canViewDelivery,
  canViewOrders,
} from "@/lib/pos/access";
import { FEATURES, hasFeature } from "@/lib/features";
import {
  deliveryProviderFinalizeBlock,
  loadOperationalProviders,
  providerCaptureActive,
  setDeliveryProvider,
  type OperationalProvider,
} from "@/lib/pos/deliveryProviderCapture";
import { classifyError } from "@/lib/pos/errors";
import {
  buildAddressPayload,
  buildCreatePayload,
  buildEditPayload,
  customerLookupGate,
  customerWriteGate,
  decideCreate,
  performCustomerCreate,
  resolveCustomerConflict,
  searchCustomers,
  upsertCustomer,
  CustomerIdentityConflictError,
  type CustomerMatch,
  type CustomerUpsertPayload,
} from "@/lib/pos/customers";
import { CustomerConflictDialog } from "@/components/pos/CustomerConflictDialog";
import { searchCustomersOfflineAware, upsertCustomerOfflineAware } from "@/lib/offline/customerCache";
import { loadDeliveryQueueOfflineAware } from "@/lib/offline/deliveryQueueOffline";
import { proveOfflineReversible, captureOfflineRefund } from "@/lib/offline/refundOffline";
import { captureDeliveryOpsOffline, captureEditOrderNoteOffline } from "@/lib/offline/deliveryActionOffline";
import { deterministicUuid } from "@/lib/offline/dineinOffline";
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
  parseDeliveryFee,
  payDeliveryOrder,
  performDeliverySettlement,
  readOrderReceiptLines,
  readSettledOrder,
  validateDeliveryDiscount,
} from "@/lib/pos/deliverySettlement";
import {
  completeOnAccount,
  createOnAccountLatch,
  performOnAccount,
  type OnAccountVerdict,
} from "@/lib/pos/onAccount";
import {
  buildEditPayload as buildOrderEditPayload,
  checkOrderContext,
  createMutationLatch,
  editDeliveryOrder,
  editOrderGate,
  loadDeliveryOrderLines,
  performEdit,
  performVoid,
  queueCounts,
  readDeliveryOrder,
  setDeliveryOps,
  validateVoidReason,
  voidActionFor,
  voidDeliveryOrder,
  voidOrderGate,
  OrderChangedError,
  type DeliveryHandlerType,
  type DeliveryOrderLine,
  type DeliveryQueueOrder,
} from "@/lib/pos/deliveryOrderManagement";
import {
  editReached,
  loadOrderParties,
  loadShiftOpenMap,
  orderShiftOpen,
  readHistoricalReceipt,
  buildHistoricalReceipt,
  toOpenDeliveryOrder,
  type OrderParty,
} from "@/lib/pos/deliveryHistory";
import {
  deliveryEditBlock,
  editTargetFor,
  getOperationalOrderProjection,
  orderChainFor,
  overlayDeliveryQueue,
  type OperationalDeliveryOrder,
} from "@/lib/offline/operationalProjection";
import { captureDeliveryProviderOffline } from "@/lib/offline/deliveryActionOffline";
import { isOfflineCreatedAddress, normalizeCustomerRef } from "@/lib/offline/operationLog";
import { cacheDeliveryLines, cacheDeliveryProviders, readCachedDeliveryProviders } from "@/lib/offline/db";
import { DeliveryOrderQueue } from "@/components/pos/DeliveryOrderQueue";
import { DeliveryOrderDetail } from "@/components/pos/DeliveryOrderDetail";
import { DeliveryReport } from "@/components/pos/DeliveryReport";
// R2 — Delivery Order Item Editing (add / quantity / modifier / remove on an open, unpaid delivery order).
import { useDeliveryItemEditing } from "@/screens/pos/useDeliveryItemEditing";
import { DeliveryAddItemsPicker } from "@/components/pos/DeliveryAddItemsPicker";
import { EditReasonDialog } from "@/components/pos/EditReasonDialog";
import { ModifierDialog } from "@/components/pos/ModifierDialog";
import { groupsForItem } from "@/lib/pos/modifiers";
import type { RoundMenu } from "@/lib/pos/tableRounds";
import type { ModifierOption, SelectedModifier } from "@/types/pos";
import { EditOrderDialog, VoidOrderDialog, type EditOrderIntent } from "@/components/pos/DeliveryOrderDialogs";
import { customerDisplayName } from "@/lib/pos/customerDisplay";
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
import { Button, EmptyState, GatedButton, Input, Textarea } from "@/components/ui";
import { Modal } from "@/components/overlays";
import { useCart, type CartOwner } from "@/state/cart";
import { isBackendReachable } from "@/lib/offline/reachability";
import { capturePayOrderOffline, payOrderClientOpId } from "@/lib/offline/payOrderOffline";
import { useActivePaymentMethods } from "@/lib/pos/useActivePaymentMethods";
import { addPosOfflineTxn, getPosOfflineTxnByOp, getPosOfflineTxn, updatePosOfflineTxn, getCachedCustomer } from "@/lib/offline/db";
import { getDeviceIdentity } from "@/lib/device";
import { orderOnAccountOffline, takeawaySaleOpId } from "@/lib/offline/orderOnAccountOffline";
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
export type DeliveryView = "customer" | "add_items" | "orders" | "report";

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
  /** R2: the shared POS menu (items/groups/options). Used to offer modifier editing on a sent line and to
   *  resolve which lines have modifier groups. The SAME menu the dine-in editor and the cart use. */
  menu: RoundMenu;
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
  /** Delivery Management. `manageDelivery` gates the internal Delivered-By /
      Delivery-Cost editor (`pos.delivery.manage`); `viewDeliveryReport` gates the
      read-only delivery report (`pos.reports.view`). Both are re-enforced by their
      RPCs server-side. */
  manageDelivery: Gate;
  viewDeliveryReport: Gate;
  /** Post-close cost reconciliation (pos.delivery.settlements.manage); re-enforced by
      pos_delivery_resolve_cost server-side. Gates the "Resolve cost" action in the report. */
  reconcileDeliverySettlements: Gate;
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
  // Delivery settlement methods: the Phase B catalog Split uses, Cash-only when
  // offline. Only the checkout CHOICES change — delivery accounting / COD semantics
  // are untouched (the server still owns every figure).
  const activePaymentMethods = useActivePaymentMethods(pos.tenantId, online);

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
  // The manual delivery fee, entered during the delivery order flow BEFORE the
  // order is sent — the fee belongs to the order, not only to payment. Held as a
  // raw string and parsed by the shared helper; sent to pos_save_order, which
  // persists it and applies the finance layer. Empty = no fee (0).
  const [orderDeliveryFee, setOrderDeliveryFee] = useState("");
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
  // Customer Receivables / On Account. Its own latch; the customer is fixed (the
  // order's own), so there is no picker here - unlike takeaway and dine-in.
  const onAccountLatch = useRef(createOnAccountLatch());
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
  /** True when the queue was served from the offline snapshot/local projection (controls the empty-state wording). */
  const [queueOffline, setQueueOffline] = useState(false);
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
  // Delivery Management: the internal Delivered-By / Delivery-Cost editor.
  const [opsEditing, setOpsEditing] = useState(false);
  const [opsBusy, setOpsBusy] = useState(false);
  const [opsError, setOpsError] = useState<string | null>(null);
  const opsLatch = useRef(createMutationLatch());
  // Advanced Delivery Providers (WS6.3): the operational provider/cost capture on
  // the order detail. `providers` is the branch's ACTIVE operational list; its
  // presence (with the feature on) is what turns provider mode on — mirroring the
  // server's zero-provider preservation.
  const [providers, setProviders] = useState<OperationalProvider[]>([]);
  const [provEditing, setProvEditing] = useState(false);
  const [provBusy, setProvBusy] = useState(false);
  const [provError, setProvError] = useState<string | null>(null);
  const provLatch = useRef(createMutationLatch());
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

  // --- Advanced Delivery Providers (WS6.3) -----------------------------------
  //
  // Provider mode is live only when the canonical `pos.delivery_providers` feature
  // is on AND the branch has at least one ACTIVE operational provider. With zero
  // active providers the server intentionally preserves legacy delivery (finalize
  // is a no-op), so the client must not switch surfaces or block payment — this
  // mirrors _pos_finalize_delivery_settlement exactly.
  const providersFeatureOn = hasFeature(pos.access.features, FEATURES.POS_DELIVERY_PROVIDERS);
  const costCaptureGate = useMemo(() => canCaptureDeliveryCost(pos.access), [pos.access]);
  const providerModeOn = providerCaptureActive({ featureOn: providersFeatureOn, providers });

  // Load the ACTIVE operational providers for this branch through the canonical
  // operational RPC (active-only, minimal fields — never the delivery_providers
  // table). Only when the advanced feature is on; the server re-checks the feature,
  // the permission and exact-OU access. A branch switch reloads.
  // rc.9 — the authorized catalog is mirrored per tenant+OU after every successful online read, and
  // served from that mirror offline, so a previously-synced provider can be CHOSEN offline (an internal
  // Breadee record — no external provider call; the server re-validates it at replay). `providersKnown`
  // = the catalog is known on this device (live or mirrored) — offline settlement requires it so a
  // provider-mode order is never settled without the provider rule being checkable.
  const [providersKnown, setProvidersKnown] = useState(false);
  useEffect(() => {
    if (!active || !providersFeatureOn || !branchId) {
      setProviders([]);
      setProvidersKnown(!providersFeatureOn);
      return;
    }
    let cancelled = false;
    void loadOperationalProviders(branchId)
      .then((rows) => {
        if (cancelled) return;
        setProviders(rows);
        setProvidersKnown(true);
        void cacheDeliveryProviders(rows, pos.tenantId, branchId).catch(() => {});
      })
      .catch(async () => {
        const cached = await readCachedDeliveryProviders(pos.tenantId, branchId).catch(() => null);
        if (cancelled) return;
        setProviders(cached ? (cached.providers as OperationalProvider[]) : []);
        setProvidersKnown(cached != null);
      });
    return () => {
      cancelled = true;
    };
  }, [active, providersFeatureOn, branchId, pos.tenantId, online]);

  // The friendly, UX-only pre-pay guard for the order on the detail panel and for
  // the just-sent summary. It mirrors the server rule; the server stays the sole
  // authority (pos_pay_order / pos_complete_on_account re-check and reject).
  const detailFinalizeBlock = useMemo(
    () =>
      detail
        ? deliveryProviderFinalizeBlock({
            providerModeOn,
            providerId: detail.delivery_provider_id ?? null,
            deliveryCost: detail.delivery_cost ?? null,
            providers,
          })
        : null,
    [detail, providerModeOn, providers],
  );
  // A just-sent order carries no provider yet (it is captured on the order detail),
  // so in provider mode the quick Pay on the summary directs the operator to Orders.
  const summaryFinalizeBlock = useMemo(
    () =>
      providerModeOn && submitted?.order
        ? "Select a delivery provider in Orders before completing this delivery order."
        : null,
    [providerModeOn, submitted?.order],
  );
  const activePayBlock = view === "orders" ? detailFinalizeBlock : summaryFinalizeBlock;

  // --- gates -----------------------------------------------------------------

  const accessGate = useMemo(() => canViewDelivery(pos.access), [pos.access]);
  // Offline-ready for a customer WRITE: the device has a resolved 5-D scope (tenant + cashier), so a
  // new/edited customer or address can be CAPTURED to the durable op log and replayed on reconnect —
  // the SAME Phase-E path the offline delivery SEND already consumes (customer_local / address_local).
  const customerOfflineReady = Boolean(pos.tenantId && pos.userId);
  // Offline-ready for a void/cancel: the device has a 5-D scope so the CERTIFIED refund engine
  // (refundOffline: proof-gated void_refund op) can capture a cancel/refund for replay. The actual
  // reversibility is fail-closed at confirm time (proveOfflineReversible), so enabling the gate here
  // only removes the blanket "needs a connection"; a non-reversible order still shows a clear reason.
  const voidOfflineReady = Boolean(pos.tenantId && pos.userId);
  const lookupGate = useMemo(
    () => customerLookupGate({ deliveryAccess: accessGate, canView: canViewCustomers(pos.access) }),
    [accessGate, pos.access],
  );
  const writeGate = useMemo(() => {
    const gate = customerWriteGate({
      deliveryAccess: accessGate,
      canView: canViewCustomers(pos.access),
      canManageCustomers: canManageCustomers(pos.access),
      canCreateOrders: pos.gates.createOrders.allowed,
      online,
      saving,
    });
    // Phase E: OFFLINE a customer can still be CAPTURED when the device is offline-ready and the
    // operator holds the create/manage permission. The base gate refused ONLY on connectivity
    // (permission was already checked), so a ready-offline session upgrades it to allowed — the
    // capture is durable and syncs exactly-once. Permission and access are never widened.
    if (
      !gate.allowed &&
      !online &&
      customerOfflineReady &&
      !saving &&
      (canManageCustomers(pos.access) || pos.gates.createOrders.allowed)
    ) {
      return { allowed: true as const, reason: null };
    }
    return gate;
  }, [accessGate, pos.access, pos.gates.createOrders.allowed, online, saving, customerOfflineReady]);

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
        // OFFLINE: a NOTE edit is captured durably (pos_edit_order replay-safe); lift the blanket
        // refusal when offline-ready. A DISCOUNT change offline is refused at confirm (it needs a
        // server-authoritative pricing recompute the local projection can't reflect).
        online: online || voidOfflineReady,
        busy: editBusy,
      }),
    [accessGate, editOrdersPermission, detail, online, voidOfflineReady, editBusy],
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
        // OFFLINE: lift the blanket connection refusal when the device is offline-ready — the handler
        // reverses through the certified fail-closed refund engine. A paid refund still needs the
        // order's shift open (voidOrderGate enforces it), so only a safe cancel/proven refund proceeds.
        online: online || voidOfflineReady,
        busy: voidBusy,
      }),
    [accessGate, cancelOrdersPermission, detail, shiftOpenMap, online, voidOfflineReady, voidBusy],
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
        // Offline is allowed for an ALREADY-CACHED customer + address: the order is
        // queued durably (idempotent pos_submit_order on reconnect), never a live
        // submit. The customer/address/lines/shift checks still apply above; only
        // the connection requirement is satisfied by the offline-queue capability.
        // (A customer can only be selected from cache offline, so it always has a
        // real server id - offline customer CREATION stays blocked.)
        online: online || (Boolean(customerId) && Boolean(addressId)),
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
      // Offline-aware: online searches the server + mirrors to the cache; offline reads the cached
      // customers so a lookup never raises a raw "Failed to fetch". An uncached number offline
      // yields no candidates → the create path (below) captures a new customer locally.
      candidates = await searchCustomersOfflineAware(term);
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
    setDialog({ kind: "customer", mode: "create", initial: { ...EMPTY_CUSTOMER_FORM, phone: decision.phone ?? "" } });
  }, [lookupGate.allowed, toast, writeGate.allowed, writeGate.reason]);

  // R6 (1.0.36): a live CUSTOMER_IDENTITY_CONFLICT from a create, awaiting the operator's
  // verify-and-link. The original payload is kept so the link re-sends exactly it plus the token.
  const [custConflict, setCustConflict] = useState<{
    error: CustomerIdentityConflictError;
    payload: CustomerUpsertPayload;
    name: string | null;
    phone: string | null;
  } | null>(null);
  const [custConflictSaving, setCustConflictSaving] = useState(false);
  const [custConflictError, setCustConflictError] = useState<string | null>(null);

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
        // Phase E — OFFLINE: capture a durable customer_upsert and select the LOCAL customer so the
        // delivery flow continues; the op syncs exactly-once on reconnect (a same-OU clash surfaces as
        // needs_attention). A deterministic client_op_id makes a double-tap idempotent.
        if (customerOfflineReady && (!online || !(await isBackendReachable()))) {
          try {
            const clientOpId = deterministicUuid([branchId ?? "", values.phone ?? "", values.name ?? "", "delivery_customer_create"]);
            const r = await upsertCustomerOfflineAware(payload as unknown as Record<string, unknown>, clientOpId);
            await useCustomers.getState().select(r.customer_id);
            setDialog({ kind: "none" });
            toast.push({ tone: "success", message: "Customer saved offline", detail: "It will sync when you reconnect." });
          } catch (e) {
            setDialogError(classifyError(e).message);
          } finally {
            setSaving(false);
          }
          return;
        }
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

        if (outcome.conflict) {
          // R6: a same-OU number already held by a differently-named customer. Verify-and-link,
          // never silently reuse — keep the original payload so the link re-sends exactly it.
          setCustConflictError(null);
          setCustConflict({ error: outcome.conflict, payload, name: values.name || null, phone: values.phone || null });
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
    [branchId, toast, writeGate.allowed, online, customerOfflineReady],
  );

  // R6 (1.0.36): resolve the conflict by LINKING to the matched customer — re-send the original
  // capture plus the single-use token. Cancel changes nothing (nothing was written on conflict).
  const confirmCustConflict = useCallback(() => {
    void (async () => {
      if (!custConflict) return;
      setCustConflictSaving(true);
      setCustConflictError(null);
      try {
        const r = await resolveCustomerConflict(custConflict.payload, custConflict.error.conflictToken);
        await useCustomers.getState().select(r.customer_id);
        setCustConflict(null);
        setDialog({ kind: "none" });
        toast.push({ tone: "success", message: "Linked to the existing customer" });
      } catch (e) {
        setCustConflictError(classifyError(e).message);
      } finally {
        setCustConflictSaving(false);
      }
    })();
  }, [custConflict, toast]);

  const cancelCustConflict = useCallback(() => {
    setCustConflict(null);
    setCustConflictError(null);
  }, []);

  // --- edit ------------------------------------------------------------------

  const submitEdit = useCallback(
    async (values: CustomerFormValues) => {
      const selected = useCustomers.getState().selected;
      if (!selected || !writeGate.allowed) return;
      setDialogError(null);
      setSaving(true);
      try {
        const editPayload = buildEditPayload({
          branchId,
          customerId: selected.id,
          name: values.name,
          notes: values.notes,
          // Only sent when it actually changed - re-sending the same number is
          // harmless but pointless, and the field is the risky one.
          phone: values.phone.trim() === (selected.phone ?? "").trim() ? null : values.phone,
        });
        // Phase E — OFFLINE: capture the edit as a durable customer_upsert (it replays exactly-once;
        // a same-OU clash surfaces as needs_attention). The card keeps its locally-known details.
        if (customerOfflineReady && (!online || !(await isBackendReachable()))) {
          const clientOpId = deterministicUuid([selected.id, values.name ?? "", values.phone ?? "", values.notes ?? "", "delivery_customer_edit"]);
          await upsertCustomerOfflineAware(editPayload as unknown as Record<string, unknown>, clientOpId);
          await useCustomers.getState().refresh();
          setDialog({ kind: "none" });
          toast.push({ tone: "success", message: "Customer update saved offline", detail: "It will sync when you reconnect." });
          return;
        }
        await upsertCustomer(editPayload);
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
    [branchId, toast, writeGate.allowed, online, customerOfflineReady],
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
        const addressPayload = buildAddressPayload({
          branchId,
          customerId: selected.id,
          address: { ...values, id: dialog.addressId },
        });
        // Phase E — OFFLINE: capture the address as a durable customer_upsert. For a locally-created
        // (pending-local) customer a LOCAL address id is minted and appended to the cached profile so
        // it is immediately selectable and a dependent offline order chains to address_local; the
        // handler remaps it on replay. A deterministic client_op_id makes a double-tap idempotent.
        if (customerOfflineReady && (!online || !(await isBackendReachable()))) {
          const clientOpId = deterministicUuid([selected.id, values.street ?? "", dialog.addressId ?? "", "delivery_address"]);
          const r = await upsertCustomerOfflineAware(addressPayload as unknown as Record<string, unknown>, clientOpId);
          await useCustomers.getState().refresh();
          if (r.address_id) useCustomers.getState().selectAddress(r.address_id);
          setDialog({ kind: "none" });
          toast.push({ tone: "success", message: "Address saved offline", detail: "It will sync when you reconnect." });
          return;
        }
        const result = await upsertCustomer(addressPayload);
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
    [branchId, dialog, toast, writeGate.allowed, online, customerOfflineReady],
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
      // The manual fee, parsed once against the SNAPSHOT so it validates exactly
      // what will be sent. Blank = no fee (null); 0 = free delivery.
      deliveryFee: parseDeliveryFee(orderDeliveryFee),
    };
    if (!snapshot.customerId || !snapshot.addressId) return;
    if (snapshot.deliveryFee.provided && !snapshot.deliveryFee.valid) {
      setSendError("Enter a valid delivery fee (0 or more), or leave it blank for no fee.");
      return;
    }

    // OFFLINE delivery order (cached customer only): the backend-reachability
    // probe is the deciding authority. The order is committed DURABLY (UNPAID,
    // sent to kitchen) with the cart's stable client_op_id and replayed exactly
    // once via pos_submit_order on reconnect - the same engine and guarantees as
    // the accepted Takeaway offline path. No payment is taken offline (delivery
    // settlement stays online). The customer/address are a real server identity
    // from the local cache; offline customer creation is not possible here.
    if (!(await isBackendReachable())) {
      if (!snapshot.customerId || !snapshot.addressId) return;
      setSendError(null);
      setSending(true);
      completionDone.current = false;
      try {
        const custName = state.selected?.name ?? null;
        const built = buildDeliveryPayload({
          branchId: snapshot.branchId,
          shiftId: snapshot.shiftId,
          clientOpId: snapshot.clientOpId,
          lines: snapshot.lines,
          customerId: snapshot.customerId,
          addressId: snapshot.addressId,
          orderNote: snapshot.note,
          deliveryFee: snapshot.deliveryFee.provided ? snapshot.deliveryFee.value : null,
        });
        // rc.9 — every line of an OFFLINE order carries a stable uuid client_line_id (stored by the
        // server, read back via pos_order_item_map), so a later OFFLINE item edit of this not-yet-synced
        // order can target its exact canonical line on replay. Online payloads are unchanged.
        const payload = { ...built, items: built.items.map((it) => ({ ...it, client_line_id: crypto.randomUUID() })) };
        const dev = getDeviceIdentity();
        const feeValue = snapshot.deliveryFee.provided ? (snapshot.deliveryFee.value ?? 0) : 0;
        const subtotal = cartSubtotal(snapshot.lines);
        const total = subtotal + feeValue;
        const existing = await getPosOfflineTxnByOp(snapshot.clientOpId);
        const localId = existing?.local_txn_id ?? crypto.randomUUID();
        // Phase E (E3): if the chosen customer was CREATED offline, its customer/address ids are
        // LOCAL. Carry them so replay waits for the customer_upsert and remaps them to canonical
        // before pos_submit_order (never submits a local id). A cached server customer → nulls.
        // rc.10 — decided from the OPERATION LOG (scope-independent), not a cache lookup whose OU key could
        // miss: an id minted by an offline customer create is LOCAL; an address minted by an offline
        // upsert (new address on a local OR a canonical customer) is LOCAL independently of its customer.
        const cachedCust = await getCachedCustomer(snapshot.customerId, pos.tenantId, snapshot.branchId).catch(() => undefined);
        const custRef = await normalizeCustomerRef(snapshot.customerId, cachedCust?.pending_local === true ? snapshot.customerId : null);
        const customerLocal = custRef.customerLocal;
        const addressLocal = customerLocal || (await isOfflineCreatedAddress(snapshot.addressId)) ? snapshot.addressId : null;
        if (existing) {
          await updatePosOfflineTxn(existing.local_txn_id, { order_payload: payload, sent_to_kitchen: true, status: "queued", customer_local: customerLocal, address_local: addressLocal });
        } else {
          await addPosOfflineTxn({
            local_txn_id: localId,
            client_op_id: snapshot.clientOpId,
            tenant_id: pos.tenantId as string,
            branch_id: snapshot.branchId,
            device_id: dev.device_id,
            terminal_id: dev.terminal_id,
            cashier_user_id: pos.userId as string,
            cashier_user_name: pos.userName,
            shift_id: snapshot.shiftId as string,
            created_at: new Date().toISOString(),
            order_payload: payload,
            // No payment offline - the delivery order syncs UNPAID, exactly as an
            // online delivery send produces. Settlement stays online.
            payment_intent: null,
            sent_to_kitchen: true,
            currency: input.currency,
            total,
            status: "queued",
            attempts: 0,
            customer_local: customerLocal,
            address_local: addressLocal,
          });
        }
        const ref = `OFF-${localId.slice(0, 6).toUpperCase()}`;
        completionDone.current = true;
        setSubmitted({
          order: {
            id: localId,
            order_number: ref,
            status: "sent_to_kitchen",
            payment_status: "unpaid",
            subtotal,
            delivery_fee: snapshot.deliveryFee.provided ? snapshot.deliveryFee.value : null,
            total_amount: total,
            currency: null,
            customer_id: snapshot.customerId,
            address_id: snapshot.addressId,
            notes: snapshot.note,
            created_at: new Date().toISOString(),
          },
          recovered: false,
        });
        // Local kitchen ticket, best-effort: an offline print hiccup must never
        // undo a durably-committed order. Latched on the local id, so a resend
        // cannot double-print.
        try {
          await input.onKitchenBatch({
            source: "delivery",
            orderId: localId,
            orderNumber: ref,
            batchNo: 1,
            customerName: custName,
            orderNote: snapshot.note,
            lines: snapshot.lines.map((l) => ({
              name: l.name,
              qty: l.quantity,
              modifiers: l.modifiers.map((m) => ({ name: m.name, quantity: m.quantity })),
              note: l.kitchen_note,
              menuItemId: l.menu_item_id,
            })),
          });
        } catch {
          /* offline print is non-fatal */
        }
        useCart.getState().reset();
        setOrderNote("");
        setOrderDeliveryFee("");
        setView("customer");
        toast.push({
          tone: "success",
          message: "Delivery order saved offline",
          detail: `Ref ${ref}. It will sync when the connection returns.`,
        });
      } catch (e) {
        const classified = classifyError(e);
        setSendError(classified.hint ? `${classified.message} ${classified.hint}` : classified.message);
      } finally {
        setSending(false);
      }
      return;
    }

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
        // The fee travels with the order at creation. Only when actually entered;
        // blank leaves the order with no fee (it can still be set at settlement).
        deliveryFee: snapshot.deliveryFee.provided ? snapshot.deliveryFee.value : null,
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
        // The server's own figures from the submit result, plus the fee we sent,
        // so the just-created order shows Subtotal + Delivery Fee = Total even on
        // the rare fallback path where the re-read did not find the row.
        subtotal: outcome.result.subtotal,
        delivery_fee: snapshot.deliveryFee.provided ? snapshot.deliveryFee.value : null,
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
          // The canonical item, so a delivery order's lines route to their
          // stations exactly as a takeaway order's do.
          menuItemId: l.menu_item_id,
        })),
      });

      // Only this delivery basket. Takeaway and dine-in state is untouched.
      useCart.getState().reset();
      setOrderNote("");
      setOrderDeliveryFee("");
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
  }, [sendGate.allowed, input.shiftId, input.onKitchenBatch, input.currency, branchId, orderNote, orderDeliveryFee, pos.branch.id, pos.tenantId, pos.userId, pos.userName, toast]);

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
      // Offline-aware: ONLINE loads the server queue + write-throughs the durable snapshot; OFFLINE
      // reads that snapshot merged with locally-known offline delivery orders — never a raw
      // "Failed to fetch". `loadOrderParties` / `loadShiftOpenMap` already fail soft to empty maps
      // offline, so no raw network error reaches the UI from them either.
      const { orders: rows, offline } = await loadDeliveryQueueOfflineAware({
        tenantId: pos.tenantId,
        branchId,
        shiftId: input.shiftId,
        now: new Date(),
      });
      // rc.9 — keep the RAW rows as the projection base (never re-project a projected row), and
      // offline show every row through the ONE operational projection (list == detail == pay).
      for (const r of rows) baseRows.current.set(r.id, r);
      const scope = itemEditOfflineScopeRef.current;
      setQueue(offline && scope ? await overlayDeliveryQueue(scope, rows).catch(() => rows) : rows);
      setQueueOffline(offline);
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

  /** rc.9 — the selected order's ONE operational projection (offline only; null online). */
  const [detailProj, setDetailProj] = useState<OperationalDeliveryOrder | null>(null);
  /** The last order row each order was opened from (the queue row / snapshot), keyed by id — the base
   *  the offline projection overlays (never a re-projected row, so nothing is applied twice). */
  const baseRows = useRef(new Map<string, DeliveryQueueOrder>());
  /** The 5-D offline scope (declared below with the item-edit hook); a ref so the loaders above read it. */
  const itemEditOfflineScopeRef = useRef<{ tenantId: string; branchId: string | null; cashierUserId: string; deviceId: string; terminalId: string | null } | null>(null);

  /** rc.9 — build the ONE operational projection for an order from what this device knows. */
  const projectOrder = useCallback(
    async (orderId: string): Promise<OperationalDeliveryOrder | null> => {
      const row = baseRows.current.get(orderId) ?? null;
      if (!row || !itemEditOfflineScopeRef.current) return null;
      return getOperationalOrderProjection(itemEditOfflineScopeRef.current, row);
    },
    [],
  );

  /** Re-read ONE order and its lines. The authority behind every 3D control. */
  const refreshDetail = useCallback(async (orderId: string) => {
    setDetailLoading(true);
    setDetailError(null);
    try {
      // rc.9 — OFFLINE: the order's lines/totals/provider/ops come from the ONE operational projection
      // (local offline order payload or the cached line snapshot + unsynced local mutations), never a
      // raw "Failed to fetch" with no lines (the rc.8 gap that hid every line control offline).
      if (!(await isBackendReachable())) {
        const p = await projectOrder(orderId).catch(() => null);
        setDetailProj(p);
        if (p) {
          setDetail(p.row);
          setDetailLines(p.lines);
          // The list row follows the SAME projection (list == detail == payment base).
          setQueue((prev) => prev.map((r) => (r.id === orderId ? p.row : r)));
          if (!p.linesKnown) setDetailError("This order's items aren't saved on this device yet. Reconnect to see them.");
        }
        return;
      }
      setDetailProj(null);
      const fetchedAt = Date.now();
      const [fresh, lines] = await Promise.all([readDeliveryOrder(orderId), loadDeliveryOrderLines(orderId)]);
      setDetail(fresh);
      setDetailLines(lines);
      if (fresh) baseRows.current.set(orderId, fresh);
      // Write-through so the same order is visible + editable offline later.
      void cacheDeliveryLines(orderId, lines, pos.tenantId, branchId, fetchedAt).catch(() => {});
      if (fresh?.shift_id) {
        const shifts = await loadShiftOpenMap([fresh.shift_id]).catch(() => new Map<string, boolean>());
        setShiftOpenMap((prev) => new Map([...prev, ...shifts]));
      }
    } catch (e) {
      setDetailError(classifyError(e).message);
    } finally {
      setDetailLoading(false);
    }
  }, [projectOrder, pos.tenantId, branchId]);

  const openDetail = useCallback(
    (order: DeliveryQueueOrder) => {
      // The queue row may already be a PROJECTED row offline; the raw base was recorded by refreshQueue.
      if (!baseRows.current.has(order.id)) baseRows.current.set(order.id, order);
      // rc.10 — never let the previous order's projection serve this one (a captured Add could
      // otherwise target the wrong order while the new detail loads).
      setDetailProj(null);
      // The row is shown immediately so the panel is never blank, then replaced
      // by an authoritative re-read - the list may be seconds old, and every
      // action on this panel is decided by the fresh copy.
      setDetail(order);
      setDetailLines([]);
      setEditError(null);
      setVoidError(null);
      setOpsEditing(false);
      setOpsError(null);
      setProvEditing(false);
      setProvError(null);
      void refreshDetail(order.id);
    },
    [refreshDetail],
  );

  // rc.10 — when connectivity flips, rebuild the open detail (and the list) from the right source: an
  // order opened ONLINE has no offline projection, so after a drop every edit refused until the order
  // was re-opened; and back online the projection must yield to the server read. Skips the first run.
  const onlineSeen = useRef<boolean | null>(null);
  const detailIdRef = useRef<string | null>(null);
  detailIdRef.current = detail?.id ?? null;
  useEffect(() => {
    if (onlineSeen.current === null) {
      onlineSeen.current = online;
      return;
    }
    if (onlineSeen.current === online) return;
    onlineSeen.current = online;
    if (!active) return;
    if (detailIdRef.current) void refreshDetail(detailIdRef.current);
    if (view === "orders") void refreshQueue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online]);

  // R2 — Delivery Order Item Editing. The hook owns the mutation lifecycle (serialize, op-id replay, reason
  // gating); the workspace supplies the menu-derived modifier context. Every success re-reads via reloadDetail.
  const reloadDetail = useCallback(
    () => (detail ? refreshDetail(detail.id) : Promise.resolve()),
    [detail, refreshDetail],
  );
  const itemEditOfflineScope = useMemo(
    () =>
      pos.tenantId && pos.userId
        ? { tenantId: pos.tenantId, branchId: pos.branch.id, cashierUserId: pos.userId, deviceId: getDeviceIdentity().device_id, terminalId: getDeviceIdentity().terminal_id }
        : null,
    [pos.tenantId, pos.userId, pos.branch.id],
  );
  itemEditOfflineScopeRef.current = itemEditOfflineScope;
  // rc.10 — the projection belongs to THIS detail only.
  const liveProj = detailProj && detail && detailProj.row.id === detail.id ? detailProj : null;
  const itemEditing = useDeliveryItemEditing({
    order: detail,
    access: pos.access,
    reload: reloadDetail,
    toast,
    // rc.10 — ONE connectivity decision for edits: a detail that was loaded OFFLINE (its projection
    // exists) always CAPTURES — even while the slow navigator/probe `online` flag is still stale-true —
    // so an edit never hits the live RPC after the device already found the backend unreachable.
    online: input.online && liveProj == null,
    // An edit needs the order loaded (its version is known) + the 5-D scope; the detail is already
    // in memory when the connection drops, so a captured edit replays exactly-once on reconnect.
    offlineReady: itemEditOfflineScope != null && detail != null,
    offlineScope: itemEditOfflineScope,
    // rc.9 — offline, every edit resolves its exact replay target + version chain from the ONE
    // operational projection (never `pos_entity_version ?? 0` against a fake line id — the rc.8 OFF-*
    // defect), and the paid-item / discount / lines-unknown walls refuse with a controlled reason.
    offlinePlan: {
      lineTarget: (lineId) => {
        if (!liveProj) return { ok: false, reason: "This order is still loading offline. Try again in a moment." };
        const block = deliveryEditBlock(liveProj);
        if (block) return { ok: false, reason: block };
        return editTargetFor(liveProj, lineId);
      },
      orderTarget: () => {
        if (!liveProj) return { ok: false, reason: "This order is still loading offline. Try again in a moment." };
        const block = deliveryEditBlock(liveProj);
        if (block) return { ok: false, reason: block };
        return orderChainFor(liveProj.orders[0]);
      },
    },
  });
  const [addPickerOpen, setAddPickerOpen] = useState(false);
  const canEditLineModifiers = useCallback(
    (line: DeliveryOrderLine) =>
      !!line.menuItemId && groupsForItem(line.menuItemId, input.menu.groupsByItem, input.menu.groups).length > 0,
    [input.menu.groupsByItem, input.menu.groups],
  );
  const editModItem = useMemo(() => {
    const l = itemEditing.modifierLine;
    return l?.menuItemId ? input.menu.items.find((m) => m.id === l.menuItemId) ?? null : null;
  }, [itemEditing.modifierLine, input.menu.items]);
  const editModGroups = useMemo(
    () => (editModItem ? groupsForItem(editModItem.id, input.menu.groupsByItem, input.menu.groups) : []),
    [editModItem, input.menu.groupsByItem, input.menu.groups],
  );
  const editModOptionsByGroup = useMemo(() => {
    const map: Record<string, ModifierOption[]> = {};
    for (const o of input.menu.options) (map[o.modifier_group_id] ??= []).push(o);
    return map;
  }, [input.menu.options]);
  const editModInitial = useMemo<SelectedModifier[]>(
    () =>
      (itemEditing.modifierLine?.modifiers ?? []).map((m) => ({
        group_id: m.groupId,
        option_id: m.optionId,
        name: m.name,
        price_delta: m.priceDelta,
        quantity: m.quantity,
      })),
    [itemEditing.modifierLine],
  );

  // Save the internal delivery ops through the ONE server authority
  // (`pos_set_delivery_ops`), then re-read the order so the panel shows what the
  // server actually stored. Never a direct `pos_orders` update from the client;
  // never a fee/total/payment field. A latch keeps a double-tap to one write.
  const saveOps = useCallback(
    async (values: { handlerType: DeliveryHandlerType | null; personRef: string | null; cost: number | null }) => {
      const target = detail;
      if (!target) return;
      if (!input.manageDelivery.allowed) {
        setOpsError(input.manageDelivery.reason ?? "You do not have permission to manage delivery details.");
        return;
      }
      // OFFLINE: delivered-by / handler / cost are internal, deterministic Breadee state and
      // pos_set_delivery_ops is replay-safe on client_op_id — so CAPTURE a durable delivery_ops op
      // (exactly-once, order_local → canonical remap, conflict → needs_attention) instead of a doomed
      // live RPC. The provider/cost-settlement path (external coordination) stays online (saveProvider).
      if (!online) {
        if (!itemEditOfflineScope) {
          setOpsError("Editing delivery details needs the POS to be ready offline.");
          return;
        }
        if (!opsLatch.current.acquire()) return;
        setOpsBusy(true);
        setOpsError(null);
        try {
          const txn = await getPosOfflineTxn(target.id).catch(() => undefined);
          const pending = txn ? txn.status !== "synced" : false;
          const clientOpId = deterministicUuid([
            target.id, "delivery_ops", values.handlerType ?? "", target.delivered_by_user_id ?? "", values.personRef ?? "", String(values.cost ?? ""),
          ]);
          await captureDeliveryOpsOffline({
            scope: itemEditOfflineScope,
            orderId: pending ? null : target.id,
            orderLocal: pending ? target.id : null,
            payload: {
              order_id: target.id,
              handler_type: values.handlerType,
              delivered_by_user_id: target.delivered_by_user_id ?? null,
              person_ref: values.personRef,
              cost: values.cost,
              client_op_id: clientOpId,
            },
            clientOpId,
          });
          setOpsEditing(false);
          await refreshDetail(target.id);
          toast.push({ tone: "success", message: "Delivery details saved offline", detail: "They will sync when you reconnect." });
        } catch (e) {
          setOpsError(classifyError(e).message);
        } finally {
          setOpsBusy(false);
          opsLatch.current.release();
        }
        return;
      }
      if (!opsLatch.current.acquire()) return;
      setOpsBusy(true);
      setOpsError(null);
      try {
        await setDeliveryOps({
          orderId: target.id,
          handlerType: values.handlerType,
          deliveredByUserId: target.delivered_by_user_id ?? null,
          personRef: values.personRef,
          cost: values.cost,
        });
        setOpsEditing(false);
        await refreshDetail(target.id);
        void refreshQueue();
        toast.push({ tone: "success", message: "Delivery details saved" });
      } catch (e) {
        setOpsError(classifyError(e).message);
      } finally {
        setOpsBusy(false);
        opsLatch.current.release();
      }
    },
    [detail, input.manageDelivery, online, itemEditOfflineScope, refreshDetail, refreshQueue, toast],
  );

  // Save the order's advanced settlement PROVIDER + delivery cost through the ONE
  // server authority (`pos_delivery_set_provider`), then re-read the order so the
  // panel shows what the server stored. Never a direct `pos_orders` update, never a
  // settlement write, never a drawer/payable computation. A latch keeps a double-tap
  // to one write. NULL != 0 is carried through in `values.cost` unchanged.
  const saveProvider = useCallback(
    async (values: { providerId: string; cost: { value: number | null; provided: boolean } }) => {
      const target = detail;
      if (!target) return;
      if (!costCaptureGate.allowed) {
        setProvError(costCaptureGate.reason ?? "You do not have permission to set the delivery provider or cost.");
        return;
      }
      // rc.9 — OFFLINE: choosing a provider is an INTERNAL Breadee record (pos_delivery_set_provider,
      // replay-safe on p_client_op_id) — no external provider is contacted. Allowed ONLY for a provider in
      // the previously-synced AUTHORIZED operational catalog cached on this device; the server re-validates
      // it at replay (an invalid provider → needs_attention, never silently dropped). The external
      // settlement itself still runs server-side at finalization (pay), unchanged.
      if (!online) {
        if (!itemEditOfflineScope) {
          setProvError("Setting the delivery provider needs the POS to be ready offline.");
          return;
        }
        if (!providers.some((p) => p.id === values.providerId)) {
          setProvError("That provider isn't in this device's saved provider list. Reconnect to choose it.");
          return;
        }
        if (!provLatch.current.acquire()) return;
        setProvBusy(true);
        setProvError(null);
        try {
          const txn = await getPosOfflineTxn(target.id).catch(() => undefined);
          const pending = txn ? txn.status !== "synced" : false;
          const clientOpId = deterministicUuid([
            target.id, "delivery_set_provider", values.providerId, values.cost.provided ? String(values.cost.value ?? "") : "~",
          ]);
          await captureDeliveryProviderOffline({
            scope: itemEditOfflineScope,
            orderId: pending ? null : target.id,
            orderLocal: pending ? target.id : null,
            payload: {
              order_id: target.id,
              provider_id: values.providerId,
              cost: values.cost.provided ? values.cost.value : null,
              cost_provided: values.cost.provided,
              client_op_id: clientOpId,
            },
            clientOpId,
          });
          setProvEditing(false);
          await refreshDetail(target.id);
          toast.push({ tone: "success", message: "Delivery provider saved offline", detail: "It will sync when you reconnect." });
        } catch (e) {
          setProvError(classifyError(e).message);
        } finally {
          setProvBusy(false);
          provLatch.current.release();
        }
        return;
      }
      if (!provLatch.current.acquire()) return;
      setProvBusy(true);
      setProvError(null);
      try {
        await setDeliveryProvider({ orderId: target.id, providerId: values.providerId, cost: values.cost });
        setProvEditing(false);
        await refreshDetail(target.id);
        void refreshQueue();
        toast.push({ tone: "success", message: "Delivery provider saved" });
      } catch (e) {
        setProvError(classifyError(e).message);
      } finally {
        setProvBusy(false);
        provLatch.current.release();
      }
    },
    [detail, costCaptureGate, online, refreshDetail, refreshQueue, toast, itemEditOfflineScope, providers],
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
        // rc.9 — offline the shift-open map is unreadable (pos_shifts) and fell back to EMPTY, which
        // refused Pay on EVERY order ("This order's shift is closed") — the rc.8 Pay-disabled root
        // cause. Offline, an order of THIS session's open shift (or a locally-created, not-yet-synced
        // order) is known open on this device; any other shift stays unproven → refused (unchanged).
        shiftOpen: orderShiftOpen(detail, shiftOpenMap) ||
          (!online && ((input.shiftId != null && detail.shift_id === input.shiftId) || detailProj?.localPending === true)),
        fromQueue: true,
      };
    }
    return { order: submitted?.order ?? null, shiftOpen: Boolean(input.shiftId), fromQueue: false };
  }, [view, detail, shiftOpenMap, submitted?.order, input.shiftId, online, detailProj]);

  const payGate: Gate = useMemo(() => {
    const g = deliveryPaymentGate({
      deliveryAccess: accessGate,
      takePayments: input.takePayments,
      order: payTarget.order,
      hasOpenShift: payTarget.shiftOpen,
      // Phase F (GAP 3) + rc.9: a delivery can settle OFFLINE by capturing a pay_order op (the
      // replay-safe pos_pay_order engine), so connectivity is satisfied for the gate when the 5-D scope
      // exists AND — with advanced providers on — the AUTHORIZED provider catalog is known on this
      // device (so the provider-before-pay rule is checkable locally; the server re-checks at replay).
      online: online || (itemEditOfflineScope != null && (!providersFeatureOn || providersKnown)),
      currencyBlockedReason: paymentBlockedReason(input.currency, input.rate),
      paying,
    });
    // Never offer a SECOND offline settle of an order already settled on this device.
    if (g.allowed && !online && payTarget.fromQueue && detailProj?.settlingOpId) {
      return { allowed: false, reason: "This order was settled offline — it will sync when you reconnect." };
    }
    return g;
  }, [accessGate, input.takePayments, payTarget, online, providersFeatureOn, providersKnown, itemEditOfflineScope, input.currency, input.rate, paying, detailProj]);

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
    // Friendly, UX-only settlement guard: in provider mode the order must carry a
    // provider (and a required cost) before it can be finalized. The server
    // re-enforces this; here it stops the dialog opening on a blocked order and
    // tells the operator why (F4 has no visible disabled state of its own).
    if (activePayBlock) {
      toast.push({ tone: "warning", message: activePayBlock });
      return;
    }
    setPayError(null);
    setPayOpen(true);
  }, [payGate.allowed, activePayBlock, toast]);

  const settle = useCallback(
    async (confirm: {
      method: PaymentMethod;
      currency: CurrencyCode;
      discountType: DiscountType;
      discountValue: string;
      tendered: number | null;
      /** The manual delivery fee entered at the pay step; null when none. */
      deliveryFee: number | null;
    }) => {
      const order = payTarget.order;
      if (!order || !payGate.allowed) return;

      // Phase F (GAP 3) — OFFLINE in-house COD cash settlement. Capture a pay_order op (reuses the
      // replay-safe pos_pay_order engine) instead of charging the server. Restricted to NON-provider
      // delivery, where the cash is unambiguously Breadee-recorded; a provider order keeps its online
      // settlement so a provider's external step is never faked offline. An offline-created order is
      // remapped local→canonical on replay; a settle conflict → needs_attention, never a second charge.
      if (!online && itemEditOfflineScope) {
        setPaying(true);
        setPayError(null);
        try {
          const localTxn = await getPosOfflineTxn(order.id).catch(() => undefined);
          const orderLocal = localTxn && localTxn.status !== "synced" ? order.id : null;
          // rc.9 — the settle replays only AFTER every unsynced mutation of this order (item edits,
          // provider, ops, note) from the ONE operational projection, so the server never charges a
          // pre-edit total or finalizes before the provider is recorded.
          const proj = payTarget.fromQueue ? await projectOrder(order.id) : null;
          if (proj?.settlingOpId) {
            setPayError("This order was settled offline — it will sync when you reconnect.");
            return;
          }
          if (providerModeOn) {
            const block = deliveryProviderFinalizeBlock({
              providerModeOn,
              providerId: proj?.row.delivery_provider_id ?? (payTarget.fromQueue ? detail?.delivery_provider_id ?? null : null),
              deliveryCost: proj?.row.delivery_cost ?? (payTarget.fromQueue ? detail?.delivery_cost ?? null : null),
              providers,
            });
            if (block) {
              setPayError(block);
              return;
            }
          }
          const clientOpId = payOrderClientOpId(itemEditOfflineScope, order.id, confirm.method, confirm.currency);
          await capturePayOrderOffline({
            scope: itemEditOfflineScope,
            orderId: orderLocal ? null : order.id,
            orderLocal,
            method: confirm.method,
            currency: confirm.currency,
            clientOpId,
            orderNumber: order.order_number ?? null,
            dependencyIds: proj?.mutationOpIds ?? [],
          });
          setPayOpen(false);
          toast.push({ tone: "success", message: "Delivery settled offline", detail: "Recorded on this device — it will sync when you reconnect." });
          if (payTarget.fromQueue && detail) void refreshDetail(detail.id);
          await input.refreshCashBox().catch(() => {});
        } catch (e) {
          setPayError(e instanceof Error ? e.message : "The delivery could not be settled offline.");
        } finally {
          setPaying(false);
        }
        return;
      }

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
          // The ITEMS subtotal is the discount base — the delivery fee is not
          // discountable. Falls back to the total for a legacy order that carried
          // no separate subtotal.
          subtotal: fresh?.subtotal ?? fresh?.total_amount ?? intended.total,
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
            // The manual delivery fee. pos_pay_order persists it and the finance
            // engine computes the total - the client sends only the fee.
            deliveryFee: confirm.deliveryFee,
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
            // THE TRANSACTION SNAPSHOT, never the payment response. This line
            // used to read `money?.currency_code`, which is the currency the
            // customer was CHARGED in - so a USD order tendered in LBP rendered
            // its USD figures labelled "LBP" on the first open (real repro:
            // order 260814-0009, $43.00 shown as "43 LBP"). Reopening went
            // through the historical path, which reads the order's own
            // `primary_currency_snapshot` and was correct - the first open and
            // the reopen must be financially identical, so both now read the
            // same stored snapshot. The tender currency has its own field two
            // lines down, where "Charged in LBP" belongs.
            currency: (settled!.currency ?? input.currency) as CurrencyCode,
            lines,
            // Server figures win over anything computed here.
            subtotal: money?.subtotal ?? settled!.total_amount ?? 0,
            discount: money?.discount ?? 0,
            // The delivery fee the server actually charged, read from the finance
            // breakdown - its own receipt line, already inside `total`. Null on the
            // recovered path (no payment response), where the fee simply isn't
            // itemised; the total still includes it.
            deliveryFee: money?.delivery_fee ?? null,
            total: money?.amount ?? settled!.total_amount ?? 0,
            tenderCurrency: (money?.currency_code ?? confirm.currency) as CurrencyCode,
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
    [payTarget, payGate.allowed, input, pos.branch.name, pos.userName, receiptIdentity, refreshDetail, refreshQueue, toast, online, providerModeOn, itemEditOfflineScope, projectOrder, providers, detail],
  );

  /**
   * Put a delivery order ON ACCOUNT. Exactly one submit, ever.
   *
   * The sibling of `settle`: the same re-read-then-once shape and the same
   * post-completion refresh, but the money call is `pos_complete_on_account` and
   * the receipt is a receivable. The customer is the ORDER's own (never whoever
   * is selected on the customer half), which is why delivery needs no picker.
   * ONLINE ONLY.
   */
  const settleOnAccount = useCallback(
    async (confirm: {
      mode: "account" | "partial";
      amountNow: number;
      customerId: string;
      method: PaymentMethod;
      discountType: DiscountType;
      discountValue: string;
    }) => {
      const order = payTarget.order;
      if (!order || !payGate.allowed) return;

      // Phase D — OFFLINE delivery on-account CAPTURE. The order's own customer is authority. An
      // offline-captured delivery order (its id IS the local_txn_id → mig:txn:<id>) is chained via
      // order_local so the receivable settles after the order syncs; a hydrated order uses its
      // canonical id. No server RPC offline; the ONLINE path below is unchanged.
      if (!online) {
        const offCustomerId = order.customer_id;
        if (!offCustomerId) {
          setPayError("This delivery order has no customer, so it cannot be put on account.");
          return;
        }
        if (!pos.tenantId || !pos.userId) {
          setPayError("On-account sales need a connection. Reconnect before putting an order on account.");
          return;
        }
        setPayError(null);
        setPaying(true);
        settleDone.current = false;
        try {
          const dev = getDeviceIdentity();
          const scope = { tenantId: pos.tenantId, branchId: pos.branch.id, cashierUserId: pos.userId, deviceId: dev.device_id, terminalId: dev.terminal_id };
          const offDiscount =
            confirm.discountType !== "none" && confirm.discountValue.trim() !== ""
              ? { discount_type: confirm.discountType, discount_value: Number(confirm.discountValue) }
              : undefined;
          const localTxn = await getPosOfflineTxn(order.id);
          await orderOnAccountOffline({
            scope,
            orderId: localTxn ? null : order.id,
            orderLocal: localTxn ? order.id : null,
            migOpId: localTxn ? takeawaySaleOpId(order.id) : null,
            customerId: offCustomerId,
            amount: confirm.amountNow,
            method: confirm.method,
            orderNumber: order.order_number ?? null,
            discount: offDiscount,
          });
          settleDone.current = true;
          setPayOpen(false);
          void refreshQueue();
          toast.push({ tone: "success", message: "Put on account offline", detail: "Recorded on this device — it will sync automatically when you reconnect." });
        } catch (e) {
          const c = classifyError(e);
          setPayError(c.hint ? `${c.message} ${c.hint}` : c.message);
        } finally {
          setPaying(false);
        }
        return;
      }

      // The order's own customer is authority - not the dialog, not the selection.
      const customerId = order.customer_id;
      if (!customerId) {
        setPayError("This delivery order has no customer, so it cannot be put on account.");
        return;
      }
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
      const discountFields =
        confirm.discountType !== "none" && confirm.discountValue.trim() !== ""
          ? { discountType: confirm.discountType as "percent" | "amount", discountValue: Number(confirm.discountValue) }
          : {};
      try {
        // The amount on screen is not authority. Re-read and refuse on any change.
        const fresh = await readSettledOrder(intended.orderId);
        checkSettlementTarget(intended, fresh);

        const outcome = await performOnAccount({
          latch: onAccountLatch.current,
          submit: () =>
            completeOnAccount({
              orderId: intended.orderId,
              customerId,
              amount: confirm.amountNow,
              method: confirm.method,
              ...discountFields,
            }),
          reread: async (): Promise<OnAccountVerdict> => {
            const o = await readSettledOrder(intended.orderId);
            if (!o) return "ambiguous";
            return o.status === "completed" ? "committed" : "open";
          },
        });

        if (!outcome.ok) {
          const c = classifyError(outcome.error);
          setPayError(c.hint ? `${c.message} ${c.hint}` : c.message);
          return;
        }
        if (settleDone.current) return;
        settleDone.current = true;

        const settled = await readSettledOrder(intended.orderId);
        if (!settled || settled.status !== "completed") {
          setPayError("The sale was accepted but the order does not show completed yet. Refresh before trying again.");
          return;
        }
        await input.refreshCashBox().catch(() => {});
        await useCustomers.getState().refresh();

        const money = outcome.result;
        const lines = await readOrderReceiptLines(intended.orderId).catch(() => []);
        // Operational money, exact and delivery-fee-inclusive: `total` is the
        // server's order total (fee already folded in), `paidNow` = total minus
        // the operational balance, `balance` is the server's operational
        // outstanding. Never `subtotal - discount` (drops the fee, and prints 0
        // when the server omits subtotal) and never the USD paid/outstanding.
        const total = money ? money.total : (settled.total_amount ?? 0);
        const balance = money ? money.outstanding : Math.max(0, total - (confirm.mode === "partial" ? confirm.amountNow : 0));
        const paidNow = money ? Math.max(0, money.total - money.outstanding) : confirm.mode === "partial" ? confirm.amountNow : 0;
        const who = receiptIdentity(order);
        input.onPresentReceipt(
          buildReceipt({
            businessName: pos.tenantName,
            branchName: pos.branch.name,
            orderType: "Delivery",
            orderSource: "delivery",
            staffName: pos.userName,
            orderNumber: settled.order_number ?? "",
            at: new Date().toLocaleString(),
            paid: false,
            paymentStatus: money ? money.payment_status : paidNow > 0 ? "partial" : "unpaid",
            paidAmount: paidNow,
            balanceDue: balance,
            method: confirm.method,
            // The order's OWN selling currency - classic USD/LBP, no historical
            // currency or decimal-digits layer on this production baseline.
            currency: (settled.currency ?? input.currency) as CurrencyCode,
            lines,
            subtotal: money?.subtotal ?? settled.total_amount ?? 0,
            discount: money?.discount ?? 0,
            // Delivery fee on its own line between Subtotal and Total (already
            // folded into `total`). Absent/0 prints nothing.
            deliveryFee: money?.delivery_fee ?? null,
            total,
            // A receivable takes no cash tender at the drawer.
            tenderCurrency: null,
            shiftRef: input.shiftId,
            customerName: who.customerName,
            customerPhone: who.customerPhone,
            deliveryAddress: who.addressText,
          }),
        );

        if (fromQueue) {
          await refreshDetail(intended.orderId);
          void refreshQueue();
        } else {
          setSubmitted({ order: settled, recovered: outcome.recovered });
        }
        setPayOpen(false);
        toast.push({
          tone: "success",
          message: outcome.recovered
            ? `Order #${settled.order_number ?? ""} was already on account`
            : paidNow > 0
              ? `Order #${settled.order_number ?? ""} partly paid - balance on account`
              : `Order #${settled.order_number ?? ""} put on account`,
        });
      } catch (e) {
        const c = classifyError(e);
        setPayError(c.hint ? `${c.message} ${c.hint}` : c.message);
      } finally {
        setPaying(false);
      }
    },
    [payTarget, payGate.allowed, online, input, pos.branch.name, pos.branch.id, pos.tenantId, pos.tenantName, pos.userId, pos.userName, receiptIdentity, refreshDetail, refreshQueue, toast],
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
        // OFFLINE: capture a NOTE-only edit durably (pos_edit_order replay-safe on client_op_id; note is
        // a SET so replay converges). A DISCOUNT change is refused offline — it needs a
        // server-authoritative pricing recompute the local delivery projection cannot show. Never a
        // doomed live RPC.
        if (!online) {
          if (intent.discount !== null) {
            setEditError("Changing the discount needs a connection. You can edit the order note offline.");
            return;
          }
          if (!itemEditOfflineScope) {
            setEditError("Editing the order needs the POS to be ready offline.");
            return;
          }
          const noteText = (intent.note ?? "").trim();
          const txn = await getPosOfflineTxn(target.id).catch(() => undefined);
          const pending = txn ? txn.status !== "synced" : false;
          const clientOpId = deterministicUuid([target.id, "edit_order_note", noteText]);
          await captureEditOrderNoteOffline({
            scope: itemEditOfflineScope,
            orderId: pending ? null : target.id,
            orderLocal: pending ? target.id : null,
            payload: { order_id: target.id, note: noteText, client_op_id: clientOpId },
            clientOpId,
          });
          setEditOpen(false);
          void refreshDetail(target.id);
          toast.push({ tone: "success", message: "Order note saved offline", detail: "It will sync when you reconnect." });
          return;
        }

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
    [detail, editGate.allowed, queue, input.applyDiscounts, online, itemEditOfflineScope, refreshDetail, refreshQueue, toast],
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

        // OFFLINE: reverse through the CERTIFIED refund engine (the same proveOfflineReversible +
        // captureOfflineRefund path ReverseOrderDialog uses for Takeaway/Dine-in). FAIL-CLOSED: only a
        // locally-proven original/balance may be reversed; an order with no local proof (e.g. a
        // server-only order never hydrated here) gets a clear reason, never a raw fetch. Durable,
        // deterministic op id, exactly-once on replay, conflict → needs_attention.
        if (!online && itemEditOfflineScope) {
          const proof = await proveOfflineReversible(target.id, itemEditOfflineScope);
          if (!proof.ok) {
            setVoidError(proof.reason);
            return;
          }
          await captureOfflineRefund({
            scope: itemEditOfflineScope,
            proof: proof.proof,
            action: proof.action,
            reason,
            tender: target.payment_method === "cash" ? "cash" : "other",
          });
          setVoidOpen(false);
          await refreshDetail(target.id);
          void refreshQueue();
          toast.push({
            tone: "success",
            message: proof.action === "refund" ? "Refund saved offline" : "Order cancelled offline",
            detail: "It will sync when you reconnect.",
          });
          return;
        }

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
    [detail, queue, accessGate, cancelOrdersPermission, online, itemEditOfflineScope, refreshDetail, refreshQueue, toast],
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
      // OFFLINE: the full delivery receipt is assembled from authoritative server reads
      // (readHistoricalReceipt), which would raise a raw "Failed to fetch". Instead REPRINT the durable
      // local receipt snapshot for THIS order — keyed by its own order number / id (the same keyed
      // lookup the shift-order reprint uses), so a locally-known order that has a stored receipt prints
      // offline with no backend call. If none is stored yet (e.g. an unpaid order never presented), show
      // a controlled message — the order itself stays available offline.
      if (!online) {
        const { readReceiptSnapshot } = await import("@/lib/offline/db");
        const snap =
          (order.order_number ? await readReceiptSnapshot(order.order_number).catch(() => null) : null) ??
          (await readReceiptSnapshot(order.id).catch(() => null));
        if (snap) {
          input.onPresentReceipt(snap.data as ReceiptData);
          return;
        }
        // rc.9 — no stored receipt (an unpaid order never presented): print the order CHECK from the ONE
        // operational projection — the SAME pure builder the online reprint uses (buildHistoricalReceipt;
        // it already renders unpaid orders as paid:false), fed the projection's lines + totals instead of
        // server reads. A provisional check, never a payment receipt; nothing is stored or mutated.
        const proj = await projectOrder(order.id).catch(() => null);
        if (proj && proj.linesKnown && proj.lines.length > 0) {
          input.onPresentReceipt(
            buildHistoricalReceipt({
              tenantName: pos.tenantName,
              branchName: pos.branch.name,
              staffName: pos.userName,
              order: proj.row,
              payment: null,
              lines: proj.lines.map((l) => ({
                name: l.name,
                qty: l.quantity,
                unitPrice: l.quantity > 0 ? l.lineTotal / l.quantity : 0,
                lineTotal: l.lineTotal,
                modifiers: l.modifiers.map((m) => ({ name: m.name, price_delta: m.priceDelta, quantity: m.quantity })),
                ...(l.kitchenNote ? { note: l.kitchenNote } : {}),
              })),
              party: receiptIdentity(order),
              fallbackCurrency: input.currency,
              at: order.created_at ? new Date(order.created_at).toLocaleString() : "",
            }),
          );
          return;
        }
        toast.push({
          tone: "info",
          message: "Reconnect to open this order's receipt",
          detail: "This order's items aren't saved on this device yet; the order stays available offline.",
        });
        return;
      }
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
    [online, receiptIdentity, pos.tenantName, pos.branch.name, pos.userName, input, toast, projectOrder],
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
      <span className="text-xs font-extrabold text-brand-dark">{customerDisplayName(customers.selected?.name, customers.selected?.phone, "Customer")}</span>
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
   * The delivery fee, entered on the ORDER before it is sent.
   *
   * The fee belongs to the order, not only to the Pay action: entering it here
   * lets the server persist it and apply the canonical finance layer, so an
   * unpaid delivery order already shows the fee on its bill/receipt and settlement
   * reuses the same value. Blank = no fee; 0 = free delivery. The number is
   * validated the same way the settlement input is.
   */
  const feeInputParsed = parseDeliveryFee(orderDeliveryFee);
  const deliveryFeeBox = (
    <div className="rounded-2xl border border-line bg-white p-3">
      <label className="block">
        <span className="text-xs font-bold text-ink">Delivery fee ({input.currency})</span>
        <p className="mt-0.5 text-[11px] text-sub">
          Saved with the order and shown on the bill before payment. Leave blank for none; 0 = free delivery.
        </p>
        <Input
          className="mt-1 w-32 text-right font-bold"
          inputMode="decimal"
          value={orderDeliveryFee}
          placeholder="0"
          aria-invalid={feeInputParsed.provided && !feeInputParsed.valid}
          onChange={(e) => setOrderDeliveryFee(e.target.value)}
        />
        {feeInputParsed.provided && !feeInputParsed.valid && (
          <p className="mt-1 text-[11px] font-semibold text-amber-800">Enter a fee of 0 or more, or leave it blank.</p>
        )}
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
        variant={view === "orders" || view === "report" ? "ghost" : "primary"}
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
      {/* The read-only delivery report. Gated on `pos.reports.view`; a cashier
          without it sees the button refused rather than a missing feature. */}
      <GatedButton
        gate={input.viewDeliveryReport}
        variant={view === "report" ? "primary" : "ghost"}
        size="lg"
        className="flex-1"
        onClick={() => setView("report")}
      >
        Report
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
            offline={queueOffline}
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
    ) : view === "report" ? (
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        {viewSwitch}
        <DeliveryReport gate={input.viewDeliveryReport} currency={input.currency} branchId={branchId || null} canReconcile={input.reconcileDeliverySettlements.allowed} />
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
            /* R2 — item editing on an open, unpaid delivery order. The server re-enforces eligibility +
               permission; this only offers the controls. Add-item picker is wired separately. */
            itemEdit={{
              gate: itemEditing.gate,
              busyLineId: itemEditing.busyLineId,
              busy: itemEditing.busy,
              onChangeQty: itemEditing.changeQuantity,
              onRemove: itemEditing.removeLine,
              onEditModifiers: itemEditing.editModifiers,
              canEditModifiers: canEditLineModifiers,
              onAddItems: () => setAddPickerOpen(true),
            }}
            manageDeliveryGate={input.manageDelivery}
            opsEditing={opsEditing}
            opsBusy={opsBusy}
            opsError={opsError}
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
            onEditOps={() => {
              setOpsError(null);
              setOpsEditing(true);
            }}
            onCancelOps={() => {
              setOpsError(null);
              setOpsEditing(false);
            }}
            onSaveOps={(values) => void saveOps(values)}
            providerModeOn={providerModeOn}
            providers={providers}
            costCaptureGate={costCaptureGate}
            provEditing={provEditing}
            provBusy={provBusy}
            provError={provError}
            finalizeBlock={detailFinalizeBlock}
            onEditProvider={() => {
              setProvError(null);
              setProvEditing(true);
            }}
            onCancelProvider={() => {
              setProvError(null);
              setProvEditing(false);
            }}
            onSaveProvider={(values) => void saveProvider(values)}
          />
        ) : (
          <EmptyState
            icon="-"
            title="Select an order"
            hint="Open an order from the list to see its items, edit it, take payment or cancel it."
          />
        )
      ) : submitted && customers.selected && !(view === "add_items" && deliveryLines.length > 0) ? (
        // rc.10 — once the operator starts a NEW basket (Add items + a line), the cart/Send panel wins
        // over the previous order's summary; before that the summary (with its Pay) stays.
        <DeliveryOrderSummary
          order={submitted.order}
          customer={customers.selected}
          address={customers.selected.addresses.find((a) => a.id === submitted.order.address_id) ?? null}
          currency={input.currency}
          recovered={submitted.recovered}
          onStartNewOrder={startNewOrder}
          /* The SAME gate F4 uses. The component renders Pay only while the
             order is unpaid, so a settled order has nothing to press again. In
             provider mode a just-sent order has no provider captured yet, so Pay is
             disabled here with a reason that points to Orders (the server would
             otherwise reject the finalize). */
          payGate={summaryFinalizeBlock ? { allowed: false, reason: summaryFinalizeBlock } : payGate}
          onPay={requestPay}
        />
      ) : view === "add_items" ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          {noteBox}
          {deliveryFeeBox}
          <div className="min-h-0 flex-1">{cartPanel}</div>
          {sendError && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">{sendError}</p>
          )}
        </div>
      ) : view === "report" ? (
        <EmptyState
          icon="-"
          title="Delivery report"
          hint="Fees, delivery cost and recorded margin for the period you pick. Read-only; it moves no money."
        />
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

      {/* R6 (1.0.36): delivery customer create verify-and-link prompt (same-OU phone + differing
          name). Shown instead of silently linking; confirm links to the matched customer. */}
      <CustomerConflictDialog
        open={custConflict !== null}
        existingName={custConflict?.error.existingName ?? null}
        incomingName={custConflict?.error.incomingName ?? custConflict?.name ?? null}
        saving={custConflictSaving}
        error={custConflictError}
        onUseExisting={confirmCustConflict}
        onClose={cancelCustConflict}
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
        /* The ITEMS subtotal, not the total: the fee lives on the order now, so
           the dialog shows Subtotal + Delivery Fee = Total rather than adding a
           fee on top of a total that already contains one. Falls back to the total
           for a legacy order saved before the fee was applied at creation. */
        subtotal={payTarget.order?.subtotal ?? payTarget.order?.total_amount ?? 0}
        /* Pre-fill the fee already persisted on the order, so settlement REUSES the
           one canonical fee instead of asking again. */
        initialDeliveryFee={payTarget.order?.delivery_fee ?? null}
        primaryCurrency={input.currency}
        rate={input.rate}
        discountGate={input.applyDiscounts}
        payGate={payGate}
        paymentMethods={activePaymentMethods}
        orderNumber={payTarget.order?.order_number ?? null}
        delivery={{
          customerName: payTarget.order ? customerDisplayName(receiptIdentity(payTarget.order).customerName, receiptIdentity(payTarget.order).customerPhone, "Customer") : "Customer",
          address: payTarget.order ? receiptIdentity(payTarget.order).addressText : null,
        }}
        onAccountDisabledReason={
          !pos.gates.takeOnAccount.allowed
            ? pos.gates.takeOnAccount.reason
            : !payTarget.order?.customer_id
              ? "This delivery order has no customer, so it cannot be put on account."
              : null
        }
        onAccount={(() => {
          const o = payTarget.order;
          // Online OR offline (offline captures a receivable against the order's own cached
          // customer; settleOnAccount branches internally). A customer on the order is required.
          if (!pos.gates.takeOnAccount.allowed || !o || !o.customer_id) return undefined;
          // The customer is the ORDER's own, read-only - no picker on delivery.
          const who = receiptIdentity(o);
          return {
            enabled: true,
            customer: { id: o.customer_id, name: who.customerName, phone: who.customerPhone },
            onConfirmAccount: (v) => void settleOnAccount(v),
          };
        })()}
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
        customerName={detail ? (parties.get(detail.id)?.customerName?.trim() || parties.get(detail.id)?.customerPhone?.trim() || null) : null}
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

      {/* R2 — change a SENT delivery line's options. The SAME shared chooser the add/dine-in flows use,
          pre-filled with the line's current modifiers; confirm sends op=change_modifiers for this line. */}
      <ModifierDialog
        open={Boolean(itemEditing.modifierLine && editModItem)}
        item={editModItem}
        basePrice={Number(editModItem?.price ?? 0)}
        groups={editModGroups}
        optionsByGroup={editModOptionsByGroup}
        currency={input.currency}
        rate={input.rate}
        ingredientCustomization={false}
        seedKey={itemEditing.modifierLine ? `deliv-edit:${itemEditing.modifierLine.id}` : null}
        initialModifiers={editModInitial}
        initialQuantity={itemEditing.modifierLine?.quantity ?? 1}
        confirmLabel="Save changes"
        onCancel={itemEditing.closeModifier}
        onConfirm={(result) => itemEditing.reviewModifiers(result)}
      />
      {/* R2 — the mandatory reason for a persisted removal/reduction/modifier-drop on a delivery line. The
          reason is sent on the SAME edit RPC and audited server-side (mirrors pos_edit_order_line_core). */}
      <EditReasonDialog
        open={itemEditing.reasonPrompt !== null}
        busy={itemEditing.busy}
        title={
          itemEditing.reasonPrompt?.kind === "modifier"
            ? "Why change these options?"
            : itemEditing.reasonForRemoval
              ? "Why remove this item?"
              : "Why reduce this item?"
        }
        subtitle="A reason is required and recorded in the activity log."
        onConfirm={itemEditing.submitReason}
        onCancel={itemEditing.cancelReason}
      />
      {/* R2 — Add items to this open delivery order. Reuses the canonical MenuItemGrid + ModifierDialog;
          commits identities + quantities ONLY through the idempotent addOrderItems path (server prices). */}
      <DeliveryAddItemsPicker
        open={addPickerOpen}
        menu={input.menu}
        currency={input.currency}
        rate={input.rate}
        busy={itemEditing.busy}
        onClose={() => setAddPickerOpen(false)}
        onConfirm={(items) => {
          setAddPickerOpen(false);
          // rc.9 — display-only captured menu prices for the OFFLINE projection (the server still
          // resolves every price on replay; online this preview is ignored).
          const preview = items.map((it) => {
            const mi = input.menu.items.find((m) => m.id === it.menu_item_id);
            return {
              menu_item_id: it.menu_item_id,
              name: mi?.name ?? "Item",
              base_price: Number(mi?.price ?? 0) || 0,
              quantity: it.quantity,
              kitchen_note: it.kitchen_note ?? null,
              modifiers: (it.modifiers ?? []).map((m) => {
                const opt = input.menu.options.find((o) => o.id === m.option_id);
                return { group_id: opt?.modifier_group_id ?? null, option_id: m.option_id, name: m.name ?? opt?.name ?? "Extra", price_delta: Number(opt?.extra_price ?? 0) || 0, quantity: m.quantity ?? 1 };
              }),
            };
          });
          void itemEditing.addItems(items, preview);
        }}
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
        subtitle={`${deliveryLines.length} item${deliveryLines.length === 1 ? "" : "s"} are waiting to be sent for ${customerDisplayName(customers.selected?.name, customers.selected?.phone, "this customer")}.`}
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
          These items were added for {customerDisplayName(customers.selected?.name, customers.selected?.phone, "the current customer")}. They cannot be sent for
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

