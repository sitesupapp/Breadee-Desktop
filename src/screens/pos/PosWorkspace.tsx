// The POS workspace: access gate, shift lifecycle, and the Takeaway route.
//
// Composition only - the business rules live in `lib/pos/*` and the two stores.
// The order of the guards below is the order the server would refuse in, so what
// the cashier sees always matches what would happen if they pressed on anyway.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, EmptyState, ErrorState, Skeleton, type Gate } from "@/components/ui";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ToastProvider, useToast } from "@/components/toast";
import { KeyboardProvider, useShortcuts } from "@/lib/keyboard/provider";
import { ShortcutHelp } from "@/components/pos/ShortcutHelp";
import { PosShell, type PosRoute } from "@/layouts/PosShell";
import { PosStatusBar } from "@/components/pos/PosStatusBar";
import { CategoryNavigation } from "@/components/pos/CategoryNavigation";
import { ALL_CATEGORIES, stepCategory } from "@/lib/pos/categories";
import { MenuItemGrid } from "@/components/pos/MenuItemGrid";
import { CartPanel } from "@/components/pos/CartPanel";
import { ModifierDialog } from "@/components/pos/ModifierDialog";
import { LineNoteDialog } from "@/components/pos/LineNoteDialog";
import { PaymentDialog } from "@/components/pos/PaymentDialog";
import { EndShiftDialog, OpenShiftDialog, ShiftReportDialog } from "@/components/pos/ShiftDialog";
import { ReceiptModal } from "@/screens/pos/ReceiptPreview";
import { KitchenTicketLayer } from "@/screens/pos/KitchenTicketPreview";
import { Modal } from "@/components/overlays";
import { CurrentOrderPanel } from "@/components/pos/CurrentOrderPanel";
import { useShiftOrders, selectedShiftOrder } from "@/state/shiftOrders";
import { Input, Button } from "@/components/ui";
import { useSession } from "@/state/session";
import { usePosContext } from "@/state/pos";
import { requireOpenShiftId, useShift } from "@/state/shift";
import { selectItemCount, selectSubtotal, useCart, type CartOwner } from "@/state/cart";
import { filterItems, loadMenu, cacheMenu, readCachedMenu, usableCategories, withSearchIndex, type SearchableItem } from "@/lib/pos/menu";
import { groupsForItem, requiresChoice } from "@/lib/pos/modifiers";
import { buildSubmitPayload, submitOrder } from "@/lib/pos/orders";
import { payOrder, type PaymentMethod } from "@/lib/pos/payments";
import { completePayment } from "@/lib/pos/paymentCompletion";
import { getShiftExpected } from "@/lib/pos/shifts";
import { classifyError } from "@/lib/pos/errors";
import type { ReceiptData } from "@/lib/receipt";
import { useReceipt, shouldShowReceipt } from "@/state/receipt";
import { useKitchenTicket } from "@/state/kitchenTicket";
import { buildKitchenTicket, type KitchenSourceLine } from "@/lib/pos/kitchenPrinter";
import { autoPrintKitchenTicket, autoPrintReceipt } from "@/lib/pos/autoPrintRun";
import type { ResolverOrderSource } from "@/lib/pos/printRouting";
import { useDineInWorkspace } from "@/screens/pos/DineInWorkspace";
import { dineInBottomBar } from "@/lib/pos/dineInActions";
import { canViewDelivery, canViewTables } from "@/lib/pos/access";
import { useDeliveryWorkspace } from "@/screens/pos/DeliveryWorkspace";
import { useTables } from "@/state/tables";
import { useCustomers } from "@/state/customers";
import { type CurrencyCode } from "@/lib/currency";
import { pendingCount } from "@/lib/offline/db";
import { getFullscreen, restoreWindowState, toggleFullscreen, trackWindowState } from "@/lib/window/state";
import { roleLabel } from "@/lib/permissions";
import type { CartLine, MenuData, ModifierGroup, ModifierOption, SelectedModifier, ShiftExpected, SubmitOrderResult } from "@/types/pos";

const EMPTY_MENU: MenuData = { categories: [], items: [], groups: [], options: [], groupsByItem: {} };

export function PosWorkspace() {
  return (
    <KeyboardProvider>
      <ToastProvider>
        <ErrorBoundary label="POS">
          <PosWorkspaceInner />
        </ErrorBoundary>
        {/* Outside the boundary and the screen's loading states on purpose.
            Both documents are presented at the moment a server call returns,
            while the workspace is busy refreshing what that call changed - the
            exact condition that lost Level 2D's receipt. */}
        <ReceiptLayer />
        <KitchenTicketLayer />
        <ShortcutHelp />
      </ToastProvider>
    </KeyboardProvider>
  );
}

function PosWorkspaceInner() {
  const navigate = useNavigate();
  const toast = useToast();
  const session = useSession();
  const pos = usePosContext();
  const shiftStore = useShift();
  const cart = useCart();

  const currency: CurrencyCode = session.currency.primary;
  const rate = session.currency.rate;
  const online = session.online && !session.offlineMode;

  // --- menu ------------------------------------------------------------------
  const [menu, setMenu] = useState<MenuData>(EMPTY_MENU);
  const [menuState, setMenuState] = useState<"loading" | "ready" | "error">("loading");
  const [menuError, setMenuError] = useState<string | null>(null);
  const [menuStale, setMenuStale] = useState<string | null>(null);
  const [category, setCategory] = useState<string>(ALL_CATEGORIES);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  const tenantId = pos.tenantId;

  const fetchMenu = useCallback(async () => {
    if (!tenantId) return;
    setMenuState("loading");
    setMenuError(null);
    try {
      const data = await loadMenu(tenantId);
      setMenu(data);
      setMenuStale(null);
      setMenuState("ready");
      void cacheMenu(data, tenantId, pos.branch.id);
    } catch (e) {
      // A cached menu is still worth showing - the cashier can see prices even
      // though ordering is blocked while offline.
      const cached = await readCachedMenu(tenantId).catch(() => null);
      if (cached) {
        setMenu(cached.menu);
        setMenuStale(cached.cachedAt);
        setMenuState("ready");
      } else {
        setMenuError(classifyError(e).message);
        setMenuState("error");
      }
    }
  }, [tenantId, pos.branch.id]);

  useEffect(() => {
    if (pos.allowed && tenantId) void fetchMenu();
  }, [pos.allowed, tenantId, fetchMenu]);

  // --- shift -----------------------------------------------------------------
  const userId = pos.userId;
  useEffect(() => {
    if (pos.allowed && tenantId && userId) void shiftStore.refresh(tenantId, userId);
    // The store is a stable zustand reference; re-running on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos.allowed, tenantId, userId]);

  const shiftId = requireOpenShiftId(shiftStore.shift);

  // --- window ----------------------------------------------------------------
  useEffect(() => {
    void restoreWindowState();
    let dispose: (() => void) | undefined;
    void trackWindowState().then((d) => {
      dispose = d;
    });
    return () => dispose?.();
  }, []);

  // Fullscreen label state. Initialised from the PLATFORM and refreshed from
  // the platform after every toggle - toggleFullscreen() returns the re-read
  // native state, so a denied or failed toggle leaves the label truthful
  // rather than flipping a fiction. Toggling is a pure window operation: no
  // cart, shift, order or printer state is anywhere near this path.
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    let live = true;
    void getFullscreen().then((f) => {
      if (live) setFullscreen(f);
    });
    return () => {
      live = false;
    };
  }, []);
  const doToggleFullscreen = useCallback(() => {
    void toggleFullscreen().then(setFullscreen);
  }, []);

  // --- pending sync badge ----------------------------------------------------
  const [pending, setPending] = useState(0);
  useEffect(() => {
    const tick = () => pendingCount().then(setPending).catch(() => {});
    tick();
    const id = window.setInterval(tick, 15_000);
    return () => window.clearInterval(id);
  }, []);

  // --- derived menu views ----------------------------------------------------
  const indexed = useMemo(() => withSearchIndex(menu.items), [menu.items]);
  const categories = useMemo(() => usableCategories(menu), [menu]);
  const visibleItems = useMemo(
    () => filterItems(indexed, category === ALL_CATEGORIES ? null : category, query),
    [indexed, category, query],
  );
  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = { [ALL_CATEGORIES]: menu.items.length };
    for (const item of menu.items) {
      if (item.category_id) counts[item.category_id] = (counts[item.category_id] ?? 0) + 1;
    }
    return counts;
  }, [menu.items]);
  const optionsByGroup = useMemo(() => {
    const map: Record<string, ModifierOption[]> = {};
    for (const o of menu.options) (map[o.modifier_group_id] ??= []).push(o);
    return map;
  }, [menu.options]);
  const itemsNeedingChoice = useMemo(() => {
    const set = new Set<string>();
    for (const item of menu.items) {
      if (requiresChoice(item.id, menu.groupsByItem, menu.groups)) set.add(item.id);
    }
    return set;
  }, [menu.items, menu.groupsByItem, menu.groups]);

  const subtotal = useMemo(() => selectSubtotal(cart.lines), [cart.lines]);
  const itemCount = useMemo(() => selectItemCount(cart.lines), [cart.lines]);

  // --- dialogs ---------------------------------------------------------------
  const [pickerItem, setPickerItem] = useState<{ item: SearchableItem; price: number; groups: ModifierGroup[] } | null>(null);
  const [noteKey, setNoteKey] = useState<string | null>(null);
  const [payOpen, setPayOpen] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  const [openShiftOpen, setOpenShiftOpen] = useState(false);
  const [endShiftOpen, setEndShiftOpen] = useState(false);
  const [shiftError, setShiftError] = useState<string | null>(null);
  const [expected, setExpected] = useState<ShiftExpected | null>(null);
  // Receipt presentation is store-owned and atomic - see `state/receipt.ts`.
  const receiptStore = useReceipt();
  // Same arrangement for the kitchen ticket, and for the same reason.
  const kitchenStore = useKitchenTicket();

  // The active shift's orders, held once and read by three surfaces: the top
  // bar's "Orders N", its dropdown, and the right-hand Current Order panel.
  const shiftOrders = useShiftOrders();
  const currentOrder = selectedShiftOrder(shiftOrders);

  // Reload whenever the shift changes - including closing one, where the store
  // invalidates before the request so the previous shift is never on screen.
  useEffect(() => {
    void useShiftOrders.getState().refresh({ tenantId, shiftId });
  }, [tenantId, shiftId]);

  /**
   * Re-read the shift's orders after something changed one.
   *
   * `preferId` is the "an order was just created" signal: the new order becomes
   * the Current Order with no reload, route switch or manual refresh. Wired to
   * the existing post-transaction call sites rather than a poller - the events
   * that change an order are already the places this app refreshes on.
   */
  const refreshShiftOrders = useCallback(
    (preferId?: string | null) => {
      void useShiftOrders.getState().refresh({ tenantId, shiftId, preferId });
    },
    [tenantId, shiftId],
  );

  /**
   * THE kitchen-ticket call site. All three routes go through it.
   *
   * One implementation rather than three, for the reason every shared POS
   * decision in this app is shared: three copies would agree today and diverge
   * the first time one of them learned something - and the thing they would
   * diverge about is whether a kitchen is told what to cook.
   *
   * SEPARATE FROM THE SUBMISSION, ON PURPOSE. It runs only after the server has
   * accepted, and it cannot fail its caller: `autoPrintKitchenTicket` has no
   * failure channel at all - every outcome, a native throw included, comes back
   * as a status to display. The lines are the ones that were SUBMITTED, passed
   * in by the caller from a snapshot, never re-read from a bill: on a dine-in
   * table a re-read would put round 1 on round 2's ticket.
   *
   * Declared HERE, above the dine-in and delivery hooks, because both take it as
   * an argument. Order of declaration is load-bearing in a component.
   */
  const printKitchenFor = useCallback(
    async (input: {
      source: ResolverOrderSource;
      orderId: string;
      orderNumber: string;
      batchNo?: number | null;
      tableName?: string | null;
      customerName?: string | null;
      orderNote?: string | null;
      lines: KitchenSourceLine[];
    }) => {
      const ticket = buildKitchenTicket({
        businessName: pos.tenantName,
        branchName: pos.branch.name,
        staffName: pos.userName,
        orderNumber: input.orderNumber,
        source: input.source,
        at: new Date().toLocaleString(),
        lines: input.lines,
        tableName: input.tableName,
        batchNo: input.batchNo,
        customerName: input.customerName,
        orderNote: input.orderNote,
      });
      if (ticket.lines.length === 0) return;

      // ONE PRESENTATION PER BATCH, which is a different question from one
      // PRINT per batch. The print latch lives in `autoPrint.ts` and is keyed on
      // the same event, but it is only claimed when a print is actually
      // attempted - so with automatic printing switched off it never fires, and
      // a second call would put the ticket modal back on screen.
      //
      // That is not hypothetical: paying an order that was already sent calls
      // this path again (deliberately - see `confirmPayment`), and in RC
      // acceptance the ticket modal reappeared ON TOP of the receipt at exactly
      // the moment the cashier needed to read the receipt.
      const eventKey = `${input.orderId}:${input.batchNo ?? 1}`;
      if (presentedTickets.current.has(eventKey)) return;
      presentedTickets.current.add(eventKey);

      // A submitted batch is new shift activity, whichever route sent it - and
      // for dine-in and delivery this is the call site the order arrives on.
      refreshShiftOrders(input.orderId);

      const status = await autoPrintKitchenTicket({
        branchId: pos.branch.id,
        tenantId: tenantId ?? "",
        access: pos.access,
        source: input.source,
        orderId: input.orderId,
        batchNo: input.batchNo ?? 1,
        ticket,
      });
      kitchenStore.present(ticket, status);
    },
    [kitchenStore, pos.access, pos.branch.id, pos.branch.name, pos.tenantName, pos.userName, refreshShiftOrders, tenantId],
  );

  /**
   * THE receipt presentation call site, for all three routes.
   *
   * Presentation first, automatic paper second and detached. The preview is on
   * screen with its Print button live whatever the printer does, so a branch
   * with no receipt route, no printer, or a jammed one still has a working till
   * and a cashier who can read the total off the screen.
   */
  const presentReceipt = useCallback(
    (receipt: ReceiptData) => {
      receiptStore.present(receipt);
      // A settlement changes an order's lifecycle, so the shift list and its
      // count follow it. Every route presents its receipt through here, which
      // makes this the one place a payment has to be reflected.
      refreshShiftOrders();
      void autoPrintReceipt({
        branchId: pos.branch.id,
        tenantId: tenantId ?? "",
        access: pos.access,
        receipt,
        paidAt: receipt.at,
      }).then((printed) => {
        if (printed.kind === "failed") {
          toast.push({
            tone: "warning",
            message: "The payment succeeded. Only the receipt failed to print.",
            detail: printed.message,
          });
        }
      });
    },
    [pos.access, pos.branch.id, receiptStore, refreshShiftOrders, tenantId, toast],
  );
  const [cartDrawerOpen, setCartDrawerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Open while confirming that a SENT, unpaid order may be walked away from. */
  const [clearConfirm, setClearConfirm] = useState(false);
  /**
   * Batches whose ticket has already been put on screen this session.
   *
   * A ref rather than state: nothing renders from it, and it must be readable
   * and writable synchronously inside the callback that decides whether to
   * present - a `setState` would be read stale by a second call in the same
   * tick, which is the case it exists to stop.
   */
  const presentedTickets = useRef<Set<string>>(new Set());

  // Which order type the workspace is showing. Takeaway and Dine-in share one
  // shell instance, so this is a mode rather than a router route.
  const [mode, setMode] = useState<"takeaway" | "dine_in" | "delivery">("takeaway");
  const tablesGate = canViewTables(pos.access);
  const dineInActive = mode === "dine_in" && tablesGate.allowed;
  const deliveryGate = canViewDelivery(pos.access);
  const deliveryActive = mode === "delivery" && deliveryGate.allowed;
  const tableStore = useTables();
  const roundMenu = useMemo(
    () => ({ groupsByItem: menu.groupsByItem, groups: menu.groups, options: menu.options }),
    [menu.groupsByItem, menu.groups, menu.options],
  );
  const dineIn = useDineInWorkspace({
    pos,
    hasOpenShift: Boolean(shiftId),
    shiftId,
    active: dineInActive,
    online,
    menu: roundMenu,
    createOrders: pos.gates.createOrders,
    currency,
    cartLines: cart.lines,
    cartSelectedKey: cart.selectedKey,
    onSelectLine: cart.select,
    onAdjustLine: cart.adjustQuantity,
    onRemoveLine: (key) => removeLine(key),
    onEditNote: setNoteKey,
    onOpenShift: () => setOpenShiftOpen(true),
    onBillDrawerOpen: () => setCartDrawerOpen(true),
    rate,
    // The receipt goes to the same store-owned layer takeaway uses, which is
    // mounted outside this component's loading states on purpose.
    onPresentReceipt: presentReceipt,
    // The kitchen ticket goes through the one shared call site, so a dine-in
    // round and a delivery order get the same document, the same routing and
    // the same duplicate protection as a takeaway order.
    onKitchenBatch: printKitchenFor,
    // Authoritative cash-box re-read after a table payment. Same call takeaway
    // makes; the desktop never adds the cash to the drawer itself.
    refreshCashBox: () => shiftStore.refreshCashBox(),
  });
  /** Add Items borrows the menu; the cart buffer then belongs to that table. */
  const addingToTable = dineInActive && dineIn.view === "add_items";

  // Level 3B. Delivery now takes ORDERS, so it needs the same shift, menu and
  // cart wiring Dine-in does - but still no payment argument of any kind.
  const delivery = useDeliveryWorkspace({
    pos,
    active: deliveryActive,
    online,
    shiftId,
    createOrders: pos.gates.createOrders,
    currency,
    cartLines: cart.lines,
    cartSelectedKey: cart.selectedKey,
    onSelectLine: cart.select,
    onAdjustLine: cart.adjustQuantity,
    onRemoveLine: (key) => removeLine(key),
    onEditNote: setNoteKey,
    onOpenShift: () => setOpenShiftOpen(true),
    // Level 3C settlement. The receipt goes to the same store-owned layer
    // takeaway and dine-in use, and the cash box is RE-READ rather than
    // incremented here.
    takePayments: pos.gates.takePayments,
    applyDiscounts: pos.gates.applyDiscounts,
    rate,
    onPresentReceipt: presentReceipt,
    // The kitchen ticket goes through the one shared call site, so a dine-in
    // round and a delivery order get the same document, the same routing and
    // the same duplicate protection as a takeaway order.
    onKitchenBatch: printKitchenFor,
    refreshCashBox: () => shiftStore.refreshCashBox(),
  });
  /** Delivery Add Items borrows the shell's menu, exactly as Dine-in does. */
  const addingToDelivery = deliveryActive && delivery.view === "add_items";

  // Table state is tenant/branch scoped; drop it when the operator leaves POS.
  useEffect(() => () => tableStore.reset(), []); // eslint-disable-line react-hooks/exhaustive-deps
  // Same for the customer book: a delivery customer must not survive the POS.
  useEffect(() => () => useCustomers.getState().reset(), []);

  // Synchronous latch: three fast clicks must not reach the server three times.
  // The server is still the authority (m224); this only avoids the round trips.
  const inFlight = useRef(false);

  // --- actions ---------------------------------------------------------------

  /**
   * Who the shared buffer belongs to right now. Claimed before every add, so a
   * takeaway line can never end up inside a table's round (or the reverse) -
   * there is one cart, and it serves one context at a time.
   */
  const claimBuffer = useCallback((): boolean => {
    // Delivery's owner carries the CUSTOMER, so a basket built for one caller
    // can never be claimed - and therefore never sent - for another.
    const owner: CartOwner =
      addingToDelivery && delivery.cartOwner
        ? delivery.cartOwner
        : addingToTable && dineIn.selected
          ? { kind: "table", tableId: dineIn.selected.id }
          : { kind: "takeaway" };
    if (useCart.getState().claim(owner)) return true;
    toast.push({
      tone: "warning",
      message: "The cart is in use",
      detail: "Send or clear the current order before starting another one.",
    });
    return false;
  }, [addingToDelivery, delivery.cartOwner, addingToTable, dineIn.selected, toast]);

  const addItem = useCallback(
    (item: SearchableItem, price: number) => {
      const groups = groupsForItem(item.id, menu.groupsByItem, menu.groups);
      if (groups.length > 0) {
        setPickerItem({ item, price, groups });
        return;
      }
      if (!claimBuffer()) return;
      cart.addLine({ menuItemId: item.id, name: item.name, basePrice: price });
    },
    [cart, claimBuffer, menu.groupsByItem, menu.groups],
  );

  const confirmPicker = useCallback(
    (input: { modifiers: SelectedModifier[]; quantity: number; note: string | null }) => {
      if (!pickerItem) return;
      if (!claimBuffer()) return;
      cart.addLine({
        menuItemId: pickerItem.item.id,
        name: pickerItem.item.name,
        basePrice: pickerItem.price,
        quantity: input.quantity,
        modifiers: input.modifiers,
        note: input.note,
      });
      setPickerItem(null);
    },
    [cart, claimBuffer, pickerItem],
  );

  const removeLine = useCallback(
    (key: string) => {
      const line = cart.lines.find((l) => l.key === key);
      cart.removeLine(key);
      if (line) {
        toast.push({
          tone: "info",
          message: `${line.name} removed`,
          action: { label: "Undo", run: () => useCart.getState().undoRemove() },
        });
      }
    },
    [cart, toast],
  );

  const newOrder = useCallback(() => {
    cart.reset();
    setPayOpen(false);
    setPayError(null);
  }, [cart]);

  /**
   * Create the order if it does not exist yet, reusing the SAME client_op_id for
   * any retry. Returns the saved order, or null when the server refused.
   */
  const ensureOrder = useCallback(async (): Promise<SubmitOrderResult | null> => {
    const existing = useCart.getState().savedOrder;
    if (existing) return existing;
    if (!shiftId) {
      toast.push({ tone: "warning", message: "Open a shift before sending an order.", detail: "Orders must belong to an open shift." });
      return null;
    }
    const opId = useCart.getState().ensureOpId();
    const payload = buildSubmitPayload({
      branchId: pos.branch.id,
      shiftId,
      orderType: "takeaway",
      clientOpId: opId,
      lines: useCart.getState().lines,
    });
    const saved = await submitOrder(payload);
    useCart.getState().setSavedOrder(saved);
    return saved;
  }, [pos.branch.id, shiftId, toast]);

  /**
   * Takeaway's shape of the shared kitchen-ticket call.
   *
   * The shift-order refresh lives inside `printKitchenFor`, which every route
   * goes through - so a takeaway order is picked up there exactly like a
   * dine-in round or a delivery order, and there is one place that says "a
   * batch was submitted".
   */
  const ticketForOrder = useCallback(
    (saved: SubmitOrderResult, lines: CartLine[]) =>
      printKitchenFor({
        source: "takeaway",
        orderId: saved.order_id,
        orderNumber: saved.order_number,
        batchNo: saved.batch_no ?? 1,
        lines: lines.map((l) => ({
          name: l.name,
          qty: l.quantity,
          modifiers: l.modifiers.map((m) => ({ name: m.name, quantity: m.quantity })),
          note: l.kitchen_note,
        })),
      }),
    [printKitchenFor],
  );

  const sendToKitchen = useCallback(async () => {
    if (inFlight.current || cart.lines.length === 0) return;
    inFlight.current = true;
    setBusy(true);
    // Snapshotted BEFORE the await, so a reset cannot empty the ticket.
    const submitted = useCart.getState().lines;
    try {
      const saved = await ensureOrder();
      if (saved) {
        toast.push({
          tone: "success",
          message: saved.idempotent ? `Order ${saved.order_number} already sent` : `Order ${saved.order_number} sent to kitchen`,
          detail: saved.idempotent
            ? "The same submission was replayed - no second order was created."
            : "Not paid yet - press Pay when the customer settles.",
        });
        await ticketForOrder(saved, submitted);
        // THE ORDER STAYS ON SCREEN, AND THAT IS THE FIX.
        //
        // This used to call `newOrder()`, which resets the cart INCLUDING
        // `savedOrder`. Since `ensureOrder()` finds a payable order only through
        // `savedOrder`, a takeaway order that had been sent to the kitchen could
        // never be paid from this app again: the money was uncollectable and the
        // order then blocked End Shift, because `pos_shift_unresolved_orders`
        // counts it as still open. Found in packaged RC acceptance - order
        // 260814-0001 is the real one this happened to, and it is still open.
        //
        // Keeping the order current makes the documented flow - order, kitchen,
        // pay, receipt - actually work, and costs nothing: `ensureOrder()`
        // already returns the saved order rather than submitting a second one,
        // and a repeat press replays under the same `client_op_id`.
        //
        // The cashier moves on with Clear, which now warns first (see
        // `clearSentOrder`). A takeaway open-orders list is the complete answer
        // and is deliberately NOT built here - it is a new surface, and this fix
        // window is for closing the money-stranding hole.
      }
    } catch (e) {
      const c = classifyError(e);
      toast.push({ tone: c.expected ? "warning" : "error", message: c.message, detail: c.hint });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [cart.lines.length, ensureOrder, ticketForOrder, toast]);

  /**
   * Clearing the cart, with one question when money is at stake.
   *
   * An unsent cart is scratch and is dropped without ceremony. A cart whose
   * order the SERVER has already accepted is different: discarding the reference
   * is what made order 260814-0001 uncollectable, so the operator is told the
   * order number and asked. Refusing outright would be worse - a cashier must
   * always be able to move on to the next customer.
   */
  const sentButUnpaid = cart.savedOrder;
  const clearOrder = useCallback(() => {
    if (useCart.getState().savedOrder) {
      setClearConfirm(true);
      return;
    }
    newOrder();
  }, [newOrder]);

  const openPayment = useCallback(() => {
    if (cart.lines.length === 0) {
      toast.push({ tone: "warning", message: "The order is empty." });
      return;
    }
    if (!shiftId) {
      toast.push({ tone: "warning", message: "Open a shift before taking payment." });
      return;
    }
    if (!pos.gates.takePayments.allowed) {
      toast.push({ tone: "warning", message: pos.gates.takePayments.reason ?? "Payment is not permitted." });
      return;
    }
    setPayError(null);
    setPayOpen(true);
  }, [cart.lines.length, shiftId, pos.gates.takePayments, toast]);

  const confirmPayment = useCallback(
    async (input: {
      method: PaymentMethod;
      currency: CurrencyCode;
      discount: Record<string, unknown>;
      tendered: number | null;
    }) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      setPayError(null);
      const lines = useCart.getState().lines;
      try {
        const saved = await ensureOrder();
        if (!saved) return;
        const result = await payOrder({ orderId: saved.order_id, method: input.method, currency: input.currency, discount: input.discount });

        // The completion sequence is deterministic and lives in one pure module:
        // present the receipt (data + visibility atomically) BEFORE the dialog
        // closes and the cart resets, so neither can race the receipt.
        const completion = completePayment({
          result,
          lines,
          fallbackOrderNumber: saved.order_number,
          tenantName: pos.tenantName,
          branchName: pos.branch.name,
          operatorName: pos.userName,
          primaryCurrency: currency,
          tenderCurrency: input.currency,
          rate,
          tenderedInput: input.tendered,
          shiftId,
          at: new Date().toLocaleString(),
        });

        for (const step of completion.steps) {
          if (step === "present-receipt") presentReceipt(completion.receipt);
          else if (step === "close-payment-dialog") setPayOpen(false);
          else if (step === "reset-cart") newOrder();
        }

        void shiftStore.refreshCashBox();
        toast.push({ tone: "success", message: `Paid - order ${result.order_number}` });

        // Paying without having pressed Send is a normal takeaway flow, and the
        // kitchen still has to be told. The latch makes this safe to call
        // unconditionally: if Send already produced this order's ticket, the key
        // is spent and nothing is printed a second time.
        void ticketForOrder(saved, lines);
      } catch (e) {
        const c = classifyError(e);
        // The saved order is deliberately KEPT so a retry pays this same order.
        setPayError(c.hint ? `${c.message} ${c.hint}` : c.message);
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [
      currency,
      ensureOrder,
      newOrder,
      pos.branch.name,
      pos.tenantName,
      pos.userName,
      presentReceipt,
      rate,
      shiftId,
      shiftStore,
      ticketForOrder,
      toast,
    ],
  );

  const doOpenShift = useCallback(
    async (openingCash: number) => {
      if (!tenantId || !userId) return;
      setBusy(true);
      setShiftError(null);
      try {
        await shiftStore.open({ tenantId, userId, branchId: pos.branch.id, openingCash });
        setOpenShiftOpen(false);
        toast.push({ tone: "success", message: "Shift opened" });
      } catch (e) {
        const c = classifyError(e);
        setShiftError(c.hint ? `${c.message} ${c.hint}` : c.message);
      } finally {
        setBusy(false);
      }
    },
    [pos.branch.id, shiftStore, tenantId, toast, userId],
  );

  const startEndShift = useCallback(async () => {
    if (!shiftId) return;
    setShiftError(null);
    setExpected(null);
    setEndShiftOpen(true);
    try {
      setExpected(await getShiftExpected(shiftId));
    } catch (e) {
      setShiftError(classifyError(e).message);
    }
  }, [shiftId]);

  const doEndShift = useCallback(
    async (input: { actual: number; notes: string | null }) => {
      setBusy(true);
      setShiftError(null);
      try {
        await shiftStore.close({ actualCashCounted: input.actual, notes: input.notes });
        setEndShiftOpen(false);
        newOrder();
      } catch (e) {
        const c = classifyError(e);
        setShiftError(c.hint ? `${c.message} ${c.hint}` : c.message);
      } finally {
        setBusy(false);
      }
    },
    [newOrder, shiftStore],
  );

  // --- keyboard --------------------------------------------------------------
  const categoryIds = useMemo(() => [ALL_CATEGORIES, ...categories.map((c) => c.id)], [categories]);

  // Route switching, shift and window controls stay live in BOTH modes.
  useShortcuts({
    routeTakeaway: () => setMode("takeaway"),
    routeDineIn: () => tablesGate.allowed && setMode("dine_in"),
    routeDelivery: () => deliveryGate.allowed && setMode("delivery"),
    openShift: () => !shiftId && setOpenShiftOpen(true),
    endShift: () => shiftId && void startEndShift(),
    fullscreen: doToggleFullscreen,
  });

  // Menu + buffer bindings. Live whenever the MENU is on screen - Takeaway, or
  // Dine-in Add Items - because in both cases these keys edit the same buffer.
  // Disabled on the table map so the arrows drive the grid instead: one binding,
  // one owner, decided by what the operator can actually see. Delivery excluded
  // outright: it shows no menu and holds no buffer, so a key that edited one
  // would be editing something invisible.
  useShortcuts(
    {
      search: () => searchRef.current?.focus(),
      prevCategory: () => setCategory((c) => stepCategory(categoryIds, c, -1)),
      nextCategory: () => setCategory((c) => stepCategory(categoryIds, c, 1)),
      lineUp: () => cart.moveSelection(-1),
      lineDown: () => cart.moveSelection(1),
      qtyUp: () => cart.selectedKey && cart.adjustQuantity(cart.selectedKey, 1),
      qtyDown: () => cart.selectedKey && cart.adjustQuantity(cart.selectedKey, -1),
      removeLine: () => cart.selectedKey && removeLine(cart.selectedKey),
    },
    // Live wherever the MENU is: Takeaway, Dine-in Add Items, and now Delivery
    // Add Items. Still off on the Delivery customer half, where the arrows and
    // Ctrl+K belong to the customer search rather than a menu that is not shown.
    (!dineInActive || addingToTable) && (!deliveryActive || addingToDelivery),
  );

  // Takeaway-only. New order, payment and the receipt belong to a takeaway
  // order; a dine-in round has none of them in Level 2B, and Delivery has no
  // order at all in Level 3A - F4 must not be able to open a payment there.
  useShortcuts(
    {
      newOrder,
      openPayment,
      print: () => receiptStore.reopen(),
    },
    !dineInActive && !deliveryActive,
  );

  // --- gates -----------------------------------------------------------------
  const noShiftGate: Gate = shiftId
    ? { allowed: true, reason: null }
    : { allowed: false, reason: "Open a shift before sending orders or taking payment." };
  const createGate: Gate = pos.gates.createOrders.allowed ? noShiftGate : pos.gates.createOrders;
  const payGate: Gate = pos.gates.takePayments.allowed ? noShiftGate : pos.gates.takePayments;

  // --- access ----------------------------------------------------------------
  if (!pos.ready || session.loading) {
    return (
      <div className="h-full space-y-3 p-6">
        <Skeleton className="h-14 w-full" />
        <div className="grid h-[70vh] grid-cols-[1fr_360px] gap-3">
          <Skeleton className="h-full" />
          <Skeleton className="h-full" />
        </div>
      </div>
    );
  }

  if (!pos.allowed) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Card className="max-w-md p-8">
          <EmptyState
            title="POS is not available for this account"
            hint={pos.denialReason ?? "You are not allowed to use POS."}
            action={
              <Button variant="ghost" onClick={() => navigate("/dashboard")}>
                Back to dashboard
              </Button>
            }
          />
        </Card>
      </div>
    );
  }

  const routes: PosRoute[] = [
    {
      key: "takeaway",
      label: "Takeaway",
      icon: "T",
      to: "/pos",
      enabled: true,
      active: mode === "takeaway",
      onSelect: () => setMode("takeaway"),
    },
    {
      key: "dine_in",
      label: "Dine-in",
      icon: "D",
      to: "/pos",
      enabled: tablesGate.allowed,
      reason: tablesGate.reason,
      active: mode === "dine_in",
      onSelect: () => setMode("dine_in"),
    },
    {
      key: "delivery",
      label: "Delivery",
      icon: "V",
      to: "/pos",
      enabled: deliveryGate.allowed,
      reason: deliveryGate.reason,
      active: mode === "delivery",
      onSelect: () => setMode("delivery"),
    },
  ];

  return (
    <>
      <PosShell
        routes={routes}
        onExit={() => navigate("/dashboard")}
        onToggleFullscreen={doToggleFullscreen}
        isFullscreen={fullscreen}
        cartDrawerOpen={cartDrawerOpen}
        onCartDrawerChange={setCartDrawerOpen}
        cartTitle={deliveryActive ? "Customer" : dineInActive ? "Table bill" : "Current order"}
        /* Delivery passes NO summary, so the drawer-width bottom bar - Pay
           included - is not rendered at all. Level 3A has no order to settle,
           and a disabled Pay would still suggest there is one. */
        cartSummary={
          deliveryActive
            ? undefined
            : dineInActive
            ? {
                // The disabled state is decided in `lib/pos/dineInActions.ts`,
                // not by a literal here - and it is derived from the SAME
                // `payTableGate` result the bill panel and F4 use, so the bottom
                // bar cannot hold a different opinion about whether this bill may
                // be settled. `onPay` opens the dialog; it never charges.
                ...dineInBottomBar({ summary: dineIn.summary, payGate: dineIn.payGate }),
                currency,
                onPay: dineIn.requestPay,
              }
            : {
                itemCount,
                subtotal,
                currency,
                onPay: openPayment,
                payDisabled: cart.lines.length === 0 || busy || !shiftId,
              }
        }
        statusBar={(layout) => (
          <PosStatusBar
            tenantName={pos.tenantName}
            branchName={pos.branch.name}
            operatorName={pos.userName}
            roleLabel={roleLabel(pos.role)}
            shift={shiftStore.shift}
            cashBox={shiftStore.cashBox}
            currency={currency}
            online={online}
            offlineMode={session.offlineMode}
            pendingSync={pending}
            layout={layout}
            onOpenShift={() => setOpenShiftOpen(true)}
            onEndShift={() => void startEndShift()}
            canOpenShift={pos.gates.openShift.allowed}
            openShiftReason={pos.gates.openShift.reason}
            /* The SAME collection the right panel renders - one array, so the
               count beside End shift cannot disagree with the list. */
            shiftOrders={shiftOrders.orders}
            selectedOrderId={currentOrder?.id ?? null}
            onSelectOrder={shiftOrders.select}
          />
        )}
        /* One menu implementation, used by Takeaway, Dine-in Add Items AND
           Delivery Add Items. A second menu would be a second place for prices
           to drift. */
        work={(layout) => (
          <div className="flex h-full min-h-0 flex-col">
            {deliveryActive && !addingToDelivery ? (
              /* Customer half of Delivery: no menu grid is reachable from here. */
              delivery.work(layout)
            ) : dineInActive && dineIn.view === "map" ? (
              dineIn.work(layout)
            ) : (
            <>
              <div className="mb-3 flex shrink-0 items-center gap-2">
                {addingToTable && (
                  <span className="rounded-lg bg-brand-soft px-3 py-2 text-xs font-extrabold text-brand-dark">
                    Adding to {dineIn.selected?.name}
                  </span>
                )}
                {addingToDelivery && (
                  <>
                    <Button variant="ghost" onClick={delivery.requestLeaveAddItems}>
                      Back to customer
                    </Button>
                    {/* WHO this order is for, pinned above the menu. Without it
                        the one screen where items are chosen is also the one
                        screen that never says whose delivery they are for. */}
                    {delivery.identity}
                  </>
                )}
                <Input
                  ref={searchRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search the menu (Ctrl+K)"
                  className="max-w-md"
                />
                {!online && (
                  <span className="rounded-lg bg-amber-100 px-3 py-2 text-xs font-bold text-amber-900">
                    Offline - ordering needs a connection
                  </span>
                )}
                {menuStale && (
                  <span className="rounded-lg bg-slate-100 px-3 py-2 text-xs font-semibold text-sub">
                    Cached menu from {new Date(menuStale).toLocaleTimeString()}
                  </span>
                )}
              </div>

              <div className="mb-3">
                <CategoryNavigation categories={categories} counts={categoryCounts} selected={category} onSelect={setCategory} />
              </div>

              {menuState === "loading" && (
                <div className="grid flex-1 grid-cols-3 content-start gap-3">
                  {Array.from({ length: 9 }).map((_, i) => (
                    <Skeleton key={i} className="h-[104px]" />
                  ))}
                </div>
              )}

              {menuState === "error" && (
                <ErrorState title="The menu could not be loaded" message={menuError ?? ""} onRetry={() => void fetchMenu()} />
              )}

              {menuState === "ready" &&
                (visibleItems.length === 0 ? (
                  <EmptyState title="No items match" hint="Try a different category, or clear the search." />
                ) : (
                  <MenuItemGrid
                    items={visibleItems}
                    columns={layout.menuColumns}
                    currency={currency}
                    rate={rate}
                    itemsNeedingChoice={itemsNeedingChoice}
                    onPick={addItem}
                  />
                ))}
            </>
            )}
          </div>
        )}
        cart={(layout) =>
          deliveryActive ? (
            /* The side panel is Delivery's own: the customer, then the cart,
               then the order that was sent. It mounts `CartPanel` WITHOUT a
               `payGate`, so Pay is not rendered at all rather than disabled. */
            delivery.panel(layout)
          ) : dineInActive ? (
            dineIn.view === "add_items" ? (
              dineIn.roundPanel(layout)
            ) : (
              dineIn.bill(layout)
            )
          ) : cart.lines.length > 0 ? (
            <CartPanel
              lines={cart.lines}
              selectedKey={cart.selectedKey}
              currency={currency}
              subtotal={subtotal}
              shiftOpen={Boolean(shiftId)}
              busy={busy}
              savedOrderNumber={cart.savedOrder?.order_number ?? null}
              createGate={createGate}
              payGate={payGate}
              onSelect={cart.select}
              onAdjust={cart.adjustQuantity}
              onRemove={removeLine}
              onEditNote={setNoteKey}
              onSendToKitchen={() => void sendToKitchen()}
              onPay={openPayment}
              onOpenShift={() => setOpenShiftOpen(true)}
              onNewOrder={clearOrder}
            />
          ) : (
            /* THE ORDER SUMMARY, in the panel rather than behind a pill.
               An empty cart means the cashier is between orders, which is
               exactly when they want to review what this shift has done - so
               the panel shows the selected shift order in full. Picking any
               menu item puts lines in the cart and the live cart returns, so
               nothing about taking an order changed. */
            <CurrentOrderPanel
              order={currentOrder}
              count={shiftOrders.orders.length}
              position={shiftOrders.index + 1}
              hasShift={Boolean(shiftId)}
              loading={shiftOrders.loading}
              error={shiftOrders.error}
              tenantName={pos.tenantName}
              branchName={pos.branch.name}
              staffName={pos.userName}
              shiftId={shiftId}
              fallbackCurrency={currency}
              tableName={currentOrder?.table_id ? (tableStore.map.tables.find((t) => t.id === currentOrder.table_id)?.name ?? null) : null}
              onStep={shiftOrders.step}
              /* The MANUAL layer - deliberately receiptStore.present and not
                 presentReceipt, so reviewing an order can never auto-print. */
              onPresentReceipt={(receipt) => receiptStore.present(receipt)}
            />
          )
        }
      />

      {dineInActive && dineIn.dialogs}
      {deliveryActive && delivery.dialogs}

      {/* Walking away from an order the kitchen is already cooking.
          The order NUMBER is named, because that is the only thing the cashier
          can use to find the money again - and right now finding it means the
          web app, which this dialog says rather than implying. */}
      <Modal
        open={clearConfirm}
        title="Leave this order unpaid?"
        size="sm"
        onClose={() => setClearConfirm(false)}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setClearConfirm(false)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setClearConfirm(false);
                newOrder();
              }}
            >
              Leave it unpaid
            </Button>
          </div>
        }
      >
        <div className="space-y-2 text-sm">
          <p>
            Order <strong>{sentButUnpaid?.order_number}</strong> has been sent to the kitchen and has not been paid.
          </p>
          <p className="text-sub">
            Clearing here does not cancel it. It stays open on the server, it cannot be paid from this terminal
            afterwards, and it will stop this shift from being closed until someone settles or cancels it in the
            Breadee web app.
          </p>
          <p className="text-sub">Press Pay instead if the customer is settling now.</p>
        </div>
      </Modal>

      <ModifierDialog
        open={Boolean(pickerItem)}
        item={pickerItem?.item ?? null}
        basePrice={pickerItem?.price ?? 0}
        groups={pickerItem?.groups ?? []}
        optionsByGroup={optionsByGroup}
        currency={currency}
        rate={rate}
        onCancel={() => setPickerItem(null)}
        onConfirm={confirmPicker}
      />

      <LineNoteDialog
        open={Boolean(noteKey)}
        lineName={cart.lines.find((l) => l.key === noteKey)?.name ?? ""}
        initialNote={cart.lines.find((l) => l.key === noteKey)?.kitchen_note ?? null}
        onCancel={() => setNoteKey(null)}
        onSave={(note) => {
          if (noteKey) cart.setNote(noteKey, note);
          setNoteKey(null);
        }}
      />

      <PaymentDialog
        open={payOpen}
        busy={busy}
        subtotal={subtotal}
        primaryCurrency={currency}
        rate={rate}
        discountGate={pos.gates.applyDiscounts}
        payGate={payGate}
        orderNumber={cart.savedOrder?.order_number ?? null}
        error={payError}
        onCancel={() => setPayOpen(false)}
        onConfirm={(input) => void confirmPayment(input)}
      />

      <OpenShiftDialog
        open={openShiftOpen}
        busy={busy}
        branchName={pos.branch.name}
        currency={currency}
        gate={pos.gates.openShift}
        error={shiftError}
        onCancel={() => setOpenShiftOpen(false)}
        onConfirm={(cash) => void doOpenShift(cash)}
      />

      <EndShiftDialog
        open={endShiftOpen}
        busy={busy}
        expected={expected}
        currency={currency}
        gate={pos.gates.endOwnShift}
        error={shiftError}
        onCancel={() => setEndShiftOpen(false)}
        onConfirm={(input) => void doEndShift(input)}
      />

      <ShiftReportDialog report={shiftStore.lastReport} currency={currency} onClose={() => shiftStore.clearReport()} />

    </>
  );
}

/**
 * The receipt preview is mounted OUTSIDE PosWorkspaceInner on purpose.
 *
 * PosWorkspaceInner early-returns a loading skeleton whenever the POS context is
 * momentarily not ready; anything rendered inside it disappears for that window.
 * A completed receipt is the one thing that must never be lost to a transient
 * loading state, so it is rendered from the store at the workspace root.
 */
function ReceiptLayer() {
  const receipt = useReceipt((s) => s.receipt);
  const visible = useReceipt((s) => s.visible);
  const hide = useReceipt((s) => s.hide);
  if (!shouldShowReceipt({ receipt, visible })) return null;
  return <ReceiptModal data={receipt as ReceiptData} onClose={hide} />;
}
