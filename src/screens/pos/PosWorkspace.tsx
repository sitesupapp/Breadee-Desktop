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
import { OrdersModal } from "@/components/pos/OrdersModal";
import { DeliveryModal } from "@/components/pos/DeliveryModal";
import { ReverseOrderDialog } from "@/components/pos/ReverseOrderDialog";
import { useShiftOrders, selectedShiftOrder } from "@/state/shiftOrders";
import { canSettleOrder, reversalActionFor } from "@/lib/pos/orderActions";
import { buildShiftReportLines, type ShiftReportDetail } from "@/lib/pos/shiftReport";
import { buildReceipt } from "@/lib/receipt";
import { readOrderReceiptLines } from "@/lib/pos/deliverySettlement";
import { isNativeAvailable, listPrinters, printReport } from "@/lib/nativePrinting";
import { resolvePrintRoute } from "@/lib/pos/printRouteResolver";
import { resolveRouteTarget } from "@/lib/pos/printTarget";
import { formatMoney } from "@/lib/currency";
import type { VoidAction } from "@/lib/pos/deliveryOrderManagement";
import type { ShiftOpenOrder } from "@/lib/pos/shiftOrderSummary";
import { Input, Button } from "@/components/ui";
import { useSession } from "@/state/session";
import { usePosContext } from "@/state/pos";
import { requireOpenShiftId, useShift } from "@/state/shift";
import { selectItemCount, selectSubtotal, useCart, type CartOwner } from "@/state/cart";
import { OrderCarousel } from "@/components/pos/OrderCarousel";
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
import type { CartLine, MenuData, ModifierGroup, ModifierOption, SelectedModifier, ShiftExpected, ShiftReport, SubmitOrderResult } from "@/types/pos";

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
  /**
   * What a confirmed payment will settle. Null while the dialog is closed.
   *
   * ONE dialog, ONE handler, ONE `pos_pay_order` call - the intent only says
   * WHICH order the money is for, and it is captured when the operator presses
   * Pay rather than read again at confirm time. A second payment surface for
   * "existing orders" would be a second place for the amount, the discount rules
   * and the receipt to be decided, and they must be decided once.
   */
  const [payIntent, setPayIntent] = useState<{ kind: "draft" } | { kind: "order"; order: ShiftOpenOrder } | null>(null);
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

  // --- operations surfaces ---------------------------------------------------
  const [ordersOpen, setOrdersOpen] = useState(false);
  const [deliveryOpen, setDeliveryOpen] = useState(false);
  /** The order a reversal was started for, and which reversal it is. */
  const [reversing, setReversing] = useState<{ order: ShiftOpenOrder; action: VoidAction } | null>(null);
  /** The just-closed shift's orders, kept so its report can describe it. */
  const [closedShiftOrders, setClosedShiftOrders] = useState<ShiftOpenOrder[]>([]);

  /** Start a reversal. The dialog owns the reason and the mutation. */
  const startReverse = useCallback((order: ShiftOpenOrder) => {
    const action = reversalActionFor(order);
    if (!action) return;
    setReversing({ order, action });
  }, []);

  /**
   * Print any shift order through the MANUAL receipt preview.
   *
   * Shared by the Current Order panel, the Orders modal and the Delivery modal,
   * so one lifecycle produces one document. Built from the SERVER's rows and
   * the order's own currency snapshot; an unpaid order prints as Unpaid with
   * no method, tendered or change invented.
   */
  const printShiftOrder = useCallback(
    async (order: ShiftOpenOrder) => {
      try {
        const lines = await readOrderReceiptLines(order.id);
        const source = (["takeaway", "dine_in", "delivery"].includes(order.order_type)
          ? order.order_type
          : "takeaway") as "takeaway" | "dine_in" | "delivery";
        receiptStore.present(
          buildReceipt({
            businessName: pos.tenantName,
            branchName: pos.branch.name,
            orderType: source === "dine_in" ? "Dine-In" : source === "delivery" ? "Delivery" : "Takeaway",
            orderSource: source,
            staffName: order.staff_name ?? pos.userName,
            orderNumber: order.order_number ?? order.id.slice(0, 8),
            at: order.created_at ? new Date(order.created_at).toLocaleString() : new Date().toLocaleString(),
            paid: order.payment_status === "paid",
            method: null,
            currency: (order.currency ?? currency) as CurrencyCode,
            lines,
            subtotal: order.subtotal ?? order.total_amount ?? 0,
            discount: order.discount_amount,
            total: order.total_amount ?? 0,
            shiftRef: shiftId ? shiftId.slice(0, 8) : null,
            // Read at call time rather than closed over: the table store is
            // declared below this callback, and a name looked up now is the
            // name the map actually holds when the operator pressed Print.
            tableName: order.table_id ? (useTables.getState().map.tables.find((t) => t.id === order.table_id)?.name ?? null) : null,
            customerName: order.order_type === "delivery" ? order.customer_name : null,
          }),
        );
      } catch (e) {
        toast.push({ tone: "error", message: "The order could not be read for printing.", detail: e instanceof Error ? e.message : null });
      }
    },
    [currency, pos.branch.name, pos.tenantName, pos.userName, receiptStore, shiftId, toast],
  );

  /**
   * Print the end-of-shift report as ONE document.
   *
   * Goes through the same native path as the receipt and the kitchen ticket -
   * one more DOCUMENT, not one more printing system - and is routed by the
   * branch's receipt route. Every figure was already on screen; nothing is
   * recomputed for the paper. A failure is reported and cannot touch the shift,
   * which the server has already closed by this point.
   */
  const printShiftReport = useCallback(
    async (report: ShiftReport, detail: ShiftReportDetail) => {
      if (!isNativeAvailable()) {
        toast.push({ tone: "warning", message: "Printing is available only in the installed Desktop app." });
        return;
      }
      if (!pos.branch.id) {
        toast.push({ tone: "warning", message: "No branch is resolved, so the report cannot be routed." });
        return;
      }
      const [installed, route] = await Promise.all([
        listPrinters(),
        resolvePrintRoute({ branchId: pos.branch.id, purpose: "receipt", orderSource: "takeaway" }).catch(() => null),
      ]);
      const resolution = route
        ? resolveRouteTarget({ route, installed: installed.ok ? installed.value : [] })
        : ({ kind: "blocked", block: { reason: "no_route" } } as const);
      if (resolution.kind !== "single") {
        toast.push({ tone: "warning", message: "No receipt printer route is configured." });
        return;
      }
      const result = await printReport({
        printerName: resolution.target.windowsName,
        paperWidth: resolution.target.paperWidth,
        copies: 1,
        report: {
          title: "END OF SHIFT REPORT",
          lines: buildShiftReportLines({
            businessName: pos.tenantName,
            branchName: pos.branch.name,
            staffName: pos.userName,
            shiftRef: report.shift_id ? report.shift_id.slice(0, 8) : null,
            openedAt: report.opened_at ? new Date(report.opened_at).toLocaleString() : null,
            closedAt: report.closed_at ? new Date(report.closed_at).toLocaleString() : null,
            currency,
            money: {
              orders: report.orders,
              grossSales: report.gross_sales,
              discounts: report.discounts,
              netSales: report.net_sales,
              cashSales: report.cash_sales,
              cashUsd: report.cash_usd,
              cashLbpOriginal: report.cash_lbp_original,
              openingCash: report.opening_cash,
              expectedCash: report.expected_cash,
              actualCash: report.actual_cash,
              difference: report.difference,
            },
            detail,
            note: report.notes,
            fmt: formatMoney,
          }),
        },
      });
      if (result.ok) {
        toast.push({ tone: "success", message: "Print job accepted by Windows.", detail: "Check the printer." });
      } else {
        toast.push({ tone: "warning", message: "The shift is closed. Only the report failed to print.", detail: result.error.message });
      }
    },
    [currency, pos.branch.id, pos.branch.name, pos.tenantName, pos.userName, toast],
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

      // A ticket that printed by itself is already withheld by the store, which
      // is where that rule lives. The change in 1.0.4 is the FAILURE case: it
      // used to raise the full ticket modal, which stops a cashier mid-service
      // to tell them about a printer. The order is committed either way, so it
      // becomes a notice they can read and dismiss without leaving the till.
      if (status.kind === "auto_failed") {
        kitchenStore.stage(ticket, status);
        toast.push({
          tone: "warning",
          message: "Order sent. The kitchen ticket was not printed.",
          detail: status.message,
        });
        return;
      }
      kitchenStore.present(ticket, status);
    },
    [kitchenStore, pos.access, pos.branch.id, pos.branch.name, pos.tenantName, pos.userName, refreshShiftOrders, tenantId, toast],
  );

  /**
   * THE receipt presentation call site, for all three routes.
   *
   * AUTO PRINT ON IS SILENT (1.0.4). Until now the preview was raised for every
   * payment and paper came out behind it, so a busy cashier had to dismiss a
   * window after every sale to get back to the till - on a lunch rush that is
   * hundreds of dismissals for information already printed. The receipt is now
   * STAGED rather than shown, and the preview is raised only when nothing was
   * printed automatically. The data is stored either way, so Ctrl+P reopens it
   * and a failed print still has something to retry from.
   *
   * The decision is the print result, not a settings read of our own: whatever
   * `autoPrintReceipt` decided IS what happened to the paper, and asking a
   * second source would let the screen and the printer disagree.
   */
  const presentReceipt = useCallback(
    (receipt: ReceiptData) => {
      receiptStore.stage(receipt);
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
        if (printed.kind === "sent") return; // Paper is coming; stay on the POS.
        if (printed.kind === "failed") {
          // Never reopen the preview on failure: the sale is done, and a modal
          // in the cashier's way is the thing this release is removing. A toast
          // says what happened and Ctrl+P still opens the receipt.
          toast.push({
            tone: "warning",
            message: "The payment succeeded. Only the receipt failed to print.",
            detail: printed.message,
          });
          return;
        }
        // `manual`: nothing was printed automatically, so the preview IS the
        // path to paper and has to be on screen.
        receiptStore.present(receipt);
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
    // Leaves the POS workspace the same way Close does, landing on the settings
    // page that owns capacity - rather than telling the operator to go and find
    // the web app, which is what 1.0.3 did.
    onConfigureTables: () => navigate("/settings/pos#tables"),
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
  // The shift's orders belong to the shift, and the panel that browses them
  // belongs to this workspace. Dropped on the way out for the same reason the
  // table map and the customer book are: the next person to open this till must
  // not walk up to somebody else's order already selected on screen.
  useEffect(() => () => useShiftOrders.getState().reset(), []);
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
    if (useCart.getState().claim(owner)) {
      // Adding to the takeaway buffer IS starting a new order, so the column
      // goes back to the draft. Without this the operator would add items while
      // a saved order filled the panel - the same class of confusion between a
      // basket and an order that the slot tabs caused.
      if (owner.kind === "takeaway") setViewingSavedOrder(false);
      return true;
    }
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
    setPayIntent(null);
    setPayError(null);
    // Back to the draft panel: "new order" means the thing being built now.
    setViewingSavedOrder(false);
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

  /**
   * Hand a just-created order over to the Current Order carousel.
   *
   * The order becomes the selection and the cart is freed for the next
   * customer - but ONLY once the refreshed list actually contains it. That
   * condition is the whole point of this function. In 1.0.2 the cart was reset
   * unconditionally after a submit, and because the only route back to a payable
   * order was `cart.savedOrder`, a takeaway order that had been sent to the
   * kitchen became uncollectable from this app; order 260814-0001 is the real
   * one that happened to. Here the carousel is the route back, so the reset is
   * safe exactly when the carousel can see the order - and when the refresh
   * failed (offline, RLS, a slow replica) nothing moves and the till keeps the
   * 1.0.3 behaviour, with the order still in the cart and Pay still working.
   *
   * Returns whether the handover happened, for the caller to reason about.
   */
  const adoptCreatedOrder = useCallback(
    async (orderId: string): Promise<boolean> => {
      await useShiftOrders.getState().refresh({ tenantId, shiftId, preferId: orderId });
      const found = useShiftOrders.getState().orders.some((o) => o.id === orderId);
      if (!found) return false;
      setViewingSavedOrder(true);
      useCart.getState().reset();
      return true;
    },
    [shiftId, tenantId],
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
        // THE ORDER STAYS ON SCREEN - as the REAL order it now is.
        //
        // 1.0.2 kept it by leaving it in the cart, because `cart.savedOrder` was
        // the only handle a payment had. The carousel is that handle now, so the
        // order moves to where it belongs: `adoptCreatedOrder` selects it, the
        // panel switches to `CurrentOrderPanel` showing its real number, and Pay
        // there settles THAT order. If the handover could not be confirmed the
        // cart keeps the order and nothing is lost - see `adoptCreatedOrder`.
        await adoptCreatedOrder(saved.order_id);
      }
    } catch (e) {
      const c = classifyError(e);
      toast.push({ tone: c.expected ? "warning" : "error", message: c.message, detail: c.hint });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [adoptCreatedOrder, cart.lines.length, ensureOrder, ticketForOrder, toast]);

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

  // --- the takeaway Current Order (1.0.4) -------------------------------------
  //
  // WHAT THIS REPLACED. The side column used to hold three parked cart snapshots
  // labelled `Order 1`, `Order 2`, `Order 3`. Those numbers were the till's own
  // invention: no order in the business was ever called any of them, so a
  // cashier had one name on the screen, a different one on the paper and a third
  // in the Orders list for the same sale - and the buttons underneath acted on
  // whichever of them the slot happened to hold. In production that is the
  // ingredient of paying the wrong order.
  //
  // THERE IS NOW ONE SOURCE OF ORDERS AND IT IS THE SERVER'S. `useShiftOrders`
  // already held every order this shift produced, already knew which one was
  // selected, and was already what the top bar counts and the Orders modal
  // lists. The carousel walks THAT collection; nothing is cloned into a local
  // slot, and no second order model exists to disagree with it.
  //
  // THE ONE THING THAT IS NOT AN ORDER IS THE DRAFT. A cart being built has no
  // order number because the server has not been told about it yet. So the
  // column shows exactly one of two things, and which one is this single flag:
  //
  //   * `false` - the live cart, via `CartPanel`, destructive action "Clear cart"
  //   * `true`  - the selected REAL order, via `CurrentOrderPanel`, "Delete / Void"
  //
  // Every transition below is an explicit gesture; nothing infers the mode from
  // whether the cart happens to be empty, which is what made the panel disappear
  // underneath cashiers in 1.0.3.
  const [viewingSavedOrder, setViewingSavedOrder] = useState(false);

  /**
   * Show a real order, from wherever it was chosen.
   *
   * The Orders dropdown, the Orders modal and the carousel all land here, so
   * "select an order" means one thing. It is a SELECTION and nothing else: no
   * submit, no payment, no clone, no cart write - `useShiftOrders.select` moves
   * an index over rows that are already loaded.
   */
  const showSavedOrder = useCallback(
    (orderId: string) => {
      useShiftOrders.getState().select(orderId);
      setViewingSavedOrder(true);
      // The Current Order lives in the takeaway column, so an order picked while
      // a table map or the delivery queue is on screen has somewhere to appear.
      setMode("takeaway");
      setOrdersOpen(false);
    },
    [],
  );

  /** The arrows. Stepping is browsing: it selects, and changes nothing else. */
  const stepSavedOrder = useCallback((direction: 1 | -1) => {
    useShiftOrders.getState().step(direction);
    setViewingSavedOrder(true);
  }, []);

  /** Back to the unsaved cart. The saved order is left exactly as it was. */
  const showDraft = useCallback(() => setViewingSavedOrder(false), []);

  /**
   * Manual print of the SELECTED order.
   *
   * Goes to `printShiftOrder` - the EXISTING manual receipt path, shared with
   * the Orders modal and the delivery modal, which presents through the
   * store-owned preview and deliberately does NOT auto-print. It takes no
   * payment and routes nothing to a kitchen.
   *
   * The order is looked up in the shift store by the id the SERVER returned for
   * this slot, so the document is built from the server's rows rather than from
   * the buffer on screen.
   */
  const [printingOrder, setPrintingOrder] = useState(false);
  const printCurrentOrder = useCallback(async () => {
    const saved = useCart.getState().savedOrder;
    if (!saved || printingOrder) return;
    setPrintingOrder(true);
    try {
      const found = useShiftOrders.getState().orders.find((o) => o.id === saved.order_id);
      if (!found) {
        toast.push({
          tone: "warning",
          message: "This order is still being saved.",
          detail: "Try Print again in a moment.",
        });
        refreshShiftOrders(saved.order_id);
        return;
      }
      await printShiftOrder(found);
    } finally {
      setPrintingOrder(false);
    }
  }, [printingOrder, printShiftOrder, refreshShiftOrders, toast]);

  /** Pay the DRAFT: `ensureOrder` creates the order, then settles it. */
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
    setPayIntent({ kind: "draft" });
  }, [cart.lines.length, shiftId, pos.gates.takePayments, toast]);

  /**
   * Pay an order that ALREADY EXISTS, from the Current Order panel.
   *
   * The same dialog and the same handler as the draft; only the target differs.
   * `canSettleOrder` is the shared lifecycle rule the panel already used to
   * decide whether to render the button at all, checked again here because a
   * list can refresh between a render and a press - and the one thing this must
   * never do is take a customer's money for a second time.
   */
  const openPaymentForOrder = useCallback(
    (order: ShiftOpenOrder) => {
      if (!canSettleOrder(order)) {
        toast.push({ tone: "warning", message: `Order ${order.order_number ?? ""} can no longer be paid.`.trim() });
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
      setPayIntent({ kind: "order", order });
    },
    [pos.gates.takePayments, shiftId, toast],
  );

  const confirmPayment = useCallback(
    async (input: {
      method: PaymentMethod;
      currency: CurrencyCode;
      discount: Record<string, unknown>;
      tendered: number | null;
    }) => {
      const intent = payIntent;
      if (!intent) return;
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      setPayError(null);
      const lines = useCart.getState().lines;
      const existing = intent.kind === "order";
      try {
        // ONE settlement, whichever the target was. A draft has its order
        // created first (under the cart's own `client_op_id`, so a retry never
        // makes a second one); an existing order is already identified, and
        // `ensureOrder` is deliberately not reached on that path - it would
        // submit the cart's unrelated draft.
        const draft = intent.kind === "draft" ? await ensureOrder() : null;
        if (intent.kind === "draft" && !draft) return;
        const orderId = intent.kind === "order" ? intent.order.id : (draft as SubmitOrderResult).order_id;
        const orderNumber =
          intent.kind === "order"
            ? (intent.order.order_number ?? intent.order.id.slice(0, 8))
            : (draft as SubmitOrderResult).order_number;

        const result = await payOrder({ orderId, method: input.method, currency: input.currency, discount: input.discount });

        // An existing order's lines come from the SERVER: there is no cart
        // behind it, and a receipt assembled from whatever the buffer happens to
        // hold would describe a different customer's food. Best-effort, because
        // the money has already changed hands by this point - a receipt with no
        // line detail is recoverable, refusing to show one is not.
        const receiptLines = existing ? await readOrderReceiptLines(orderId).catch(() => []) : null;

        // The completion sequence is deterministic and lives in one pure module:
        // present the receipt (data + visibility atomically) BEFORE the dialog
        // closes and the cart resets, so neither can race the receipt.
        const completion = completePayment({
          result,
          lines,
          receiptLines,
          existingOrder: existing,
          fallbackOrderNumber: orderNumber,
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
          else if (step === "close-payment-dialog") setPayIntent(null);
          else if (step === "reset-cart") newOrder();
        }

        void shiftStore.refreshCashBox();
        toast.push({ tone: "success", message: `Paid - order ${result.order_number}` });

        // Paying without having pressed Send is a normal takeaway flow, and the
        // kitchen still has to be told. The latch makes this safe to call
        // unconditionally: if Send already produced this order's ticket, the key
        // is spent and nothing is printed a second time.
        //
        // An EXISTING order is deliberately excluded. It was submitted, routed
        // and ticketed when it was created, minutes or hours ago; re-sending its
        // ticket on settlement would put a second copy of already-cooked food in
        // front of the kitchen. Paying is the only thing that just happened.
        if (draft) void ticketForOrder(draft, lines);

        // The settled order becomes - or stays - the Current Order, so the
        // receipt on screen and the order behind the buttons are the same sale.
        await adoptCreatedOrder(orderId);
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
      adoptCreatedOrder,
      currency,
      ensureOrder,
      newOrder,
      payIntent,
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
      // Snapshotted BEFORE the close. Closing clears the active shift and the
      // order store follows it, so the report would otherwise describe an empty
      // shift - the one thing an end-of-shift report must not do.
      const closing = useShiftOrders.getState().orders;
      try {
        await shiftStore.close({ actualCashCounted: input.actual, notes: input.notes });
        setClosedShiftOrders(closing);
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

  // The FOUR POS routes, and only those four. Settings, Reports and Customers
  // are Desktop surfaces reached by leaving the workspace through Close; putting
  // them in this rail would make the till a place to administer the business
  // from, which is a different job done by a different person.
  const routes: PosRoute[] = [
    {
      key: "takeaway",
      label: "Takeaway",
      icon: "takeaway",
      to: "/pos",
      enabled: true,
      active: mode === "takeaway" && !ordersOpen,
      onSelect: () => setMode("takeaway"),
    },
    {
      key: "dine_in",
      label: "Dine-in",
      icon: "dine-in",
      to: "/pos",
      enabled: tablesGate.allowed,
      reason: tablesGate.reason,
      active: mode === "dine_in" && !ordersOpen,
      onSelect: () => setMode("dine_in"),
    },
    {
      key: "delivery",
      label: "Delivery",
      icon: "delivery",
      to: "/pos",
      enabled: deliveryGate.allowed,
      reason: deliveryGate.reason,
      active: mode === "delivery" && !ordersOpen,
      onSelect: () => setMode("delivery"),
    },
    {
      // The EXISTING orders workspace, given the rail entry the approved design
      // puts it in. It opens the same modal the status bar used to, with the
      // same shift-order collection, the same manual print and the same reversal
      // dialog behind it - one surface, reached from a more obvious place.
      key: "orders",
      label: "Orders",
      icon: "orders",
      to: "/pos",
      enabled: true,
      active: ordersOpen,
      onSelect: () => setOrdersOpen(true),
    },
  ];

  return (
    <>
      <PosShell
        routes={routes}
        /* CLOSE returns to the Desktop main page. It is a route change and
           nothing else: no sign-out, no shift close, no cart reset, no table or
           delivery state discarded beyond the unmount cleanups this component
           already declares. */
        onExit={() => navigate("/dashboard")}
        onToggleFullscreen={doToggleFullscreen}
        isFullscreen={fullscreen}
        tenantName={pos.tenantName}
        /* The footer reads the build's own version; nothing is passed for it. */
        ready={menuState === "ready"}
        online={online}
        pendingSync={pending}
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
            /* Choosing an order here loads it into the Current Order panel and
               nothing more: no submit, no clone, no payment state touched. */
            onSelectOrder={showSavedOrder}
            onOpenOrders={() => setOrdersOpen(true)}
            onOpenDelivery={() => setDeliveryOpen(true)}
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
          ) : (
            /* TAKEAWAY. Exactly two things can occupy this column, and which one
               is an explicit gesture rather than "is the cart empty" - a panel
               that swaps itself out when a cashier clears a line is a panel that
               disappears at the worst moment.

                 * a SAVED order - real number, real state, and actions bound to
                   that order;
                 * the DRAFT - the live cart, with no order number because the
                   server has not been told about it yet.

               There is no third thing, and in particular no invented `Order 1`. */
            viewingSavedOrder ? (
              <section className="flex h-full min-h-0 flex-col border-l border-line bg-white" aria-label="Current order">
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
                  tableName={
                    currentOrder?.table_id
                      ? (tableStore.map.tables.find((t) => t.id === currentOrder.table_id)?.name ?? null)
                      : null
                  }
                  onStep={stepSavedOrder}
                  /* The MANUAL layer - receiptStore.present and never
                     presentReceipt, so reviewing an order cannot auto-print. */
                  onPresentReceipt={(receipt) => receiptStore.present(receipt)}
                  onPay={openPaymentForOrder}
                  payGate={payGate}
                  payBusy={busy}
                  onNewOrder={showDraft}
                  onReverse={startReverse}
                />
              </section>
            ) : (
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
                /* An unsaved draft is scratch, and its destructive action says
                   so. `Delete / Void` belongs to a saved order and appears only
                   on the panel above. */
                clearLabel={cart.savedOrder ? "Clear cart (leaves the order unpaid)" : "Clear cart"}
                orderCarousel={
                  <OrderCarousel
                    orderNumber={null}
                    count={shiftOrders.orders.length}
                    position={shiftOrders.index + 1}
                    draft
                    draftItemCount={itemCount}
                    onStep={stepSavedOrder}
                  />
                }
                onPrint={() => void printCurrentOrder()}
                printBusy={printingOrder}
              />
            )
          )
        }
      />

      {dineInActive && dineIn.dialogs}
      {deliveryActive && delivery.dialogs}

      {/* Operations surfaces. All three read the ONE shift-order store and all
          three reverse through the ONE dialog, so no screen can hold its own
          opinion about what an order's state permits. */}
      <OrdersModal
        open={ordersOpen}
        onClose={() => setOrdersOpen(false)}
        tenantId={tenantId}
        branchId={pos.branch.id}
        shiftId={shiftId}
        currency={currency}
        tableNameFor={(id) => (id ? (tableStore.map.tables.find((t) => t.id === id)?.name ?? null) : null)}
        shiftOrders={shiftOrders.orders}
        selectedOrderId={currentOrder?.id ?? null}
        /* View closes the modal and loads that exact order into the Current
           Order panel behind it - the one place an order is acted on. It is a
           selection: no submit RPC, no clone, no change of payment state. */
        onSelectOrder={showSavedOrder}
        onPrintOrder={(o) => void printShiftOrder(o)}
        onReverseOrder={startReverse}
        /* The same panel, as a read-only preview beside the table. It is
           deliberately given no Pay and no New order here: settlement belongs
           beside the till's Current Order, not inside a browsing surface where
           the operator is comparing rows. */
        detail={
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
            onStep={stepSavedOrder}
            /* The MANUAL layer - deliberately receiptStore.present and not
               presentReceipt, so reviewing an order can never auto-print. */
            onPresentReceipt={(receipt) => receiptStore.present(receipt)}
            onReverse={startReverse}
          />
        }
      />

      <DeliveryModal
        open={deliveryOpen}
        onClose={() => setDeliveryOpen(false)}
        shiftId={shiftId}
        currency={currency}
        shiftOrders={shiftOrders.orders}
        onSelectOrder={showSavedOrder}
        onPrintOrder={(o) => void printShiftOrder(o)}
        onReverseOrder={startReverse}
      />

      <ReverseOrderDialog
        order={reversing?.order ?? null}
        action={reversing?.action ?? null}
        onClose={() => setReversing(null)}
        /* Authoritative re-read: the reversed order's new state, its removal
           from the open counts, and the drawer are all read back rather than
           patched locally. */
        onDone={() => {
          refreshShiftOrders();
          void shiftStore.refreshCashBox();
        }}
      />

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

      {/* ONE payment dialog for both targets. The figure it opens on is the
          target's own subtotal - the cart's while drafting, the SERVER's stored
          subtotal for a saved order - and every figure that reaches the receipt
          afterwards is `pos_pay_order`'s response, never either of these. */}
      <PaymentDialog
        open={payIntent !== null}
        busy={busy}
        subtotal={
          payIntent?.kind === "order"
            ? (payIntent.order.subtotal ?? payIntent.order.total_amount ?? 0)
            : subtotal
        }
        primaryCurrency={currency}
        rate={rate}
        discountGate={pos.gates.applyDiscounts}
        payGate={payGate}
        orderNumber={
          payIntent?.kind === "order"
            ? (payIntent.order.order_number ?? null)
            : (cart.savedOrder?.order_number ?? null)
        }
        error={payError}
        onCancel={() => setPayIntent(null)}
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

      {/* The orders are captured BEFORE the close cleared the active shift, so
          the report's route and reversal detail describes the shift it is
          reporting on rather than the empty one that replaced it. */}
      <ShiftReportDialog
        report={shiftStore.lastReport}
        currency={currency}
        shiftOrders={closedShiftOrders}
        onPrint={
          shiftStore.lastReport
            ? (detail) => void printShiftReport(shiftStore.lastReport as ShiftReport, detail)
            : undefined
        }
        onClose={() => shiftStore.clearReport()}
      />

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
