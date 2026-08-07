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
import { useDineInWorkspace } from "@/screens/pos/DineInWorkspace";
import { dineInBottomBar } from "@/lib/pos/dineInActions";
import { canViewTables } from "@/lib/pos/access";
import { useTables } from "@/state/tables";
import { type CurrencyCode } from "@/lib/currency";
import { pendingCount } from "@/lib/offline/db";
import { restoreWindowState, toggleFullscreen, trackWindowState } from "@/lib/window/state";
import { roleLabel } from "@/lib/permissions";
import type { MenuData, ModifierGroup, ModifierOption, SelectedModifier, ShiftExpected, SubmitOrderResult } from "@/types/pos";

const EMPTY_MENU: MenuData = { categories: [], items: [], groups: [], options: [], groupsByItem: {} };

export function PosWorkspace() {
  return (
    <KeyboardProvider>
      <ToastProvider>
        <ErrorBoundary label="POS">
          <PosWorkspaceInner />
        </ErrorBoundary>
        {/* Outside the boundary and the screen's loading states on purpose. */}
        <ReceiptLayer />
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
  const [cartDrawerOpen, setCartDrawerOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // Which order type the workspace is showing. Takeaway and Dine-in share one
  // shell instance, so this is a mode rather than a router route.
  const [mode, setMode] = useState<"takeaway" | "dine_in">("takeaway");
  const tablesGate = canViewTables(pos.access);
  const dineInActive = mode === "dine_in" && tablesGate.allowed;
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
    onPresentReceipt: (receipt) => receiptStore.present(receipt),
    // Authoritative cash-box re-read after a table payment. Same call takeaway
    // makes; the desktop never adds the cash to the drawer itself.
    refreshCashBox: () => shiftStore.refreshCashBox(),
  });
  /** Add Items borrows the menu; the cart buffer then belongs to that table. */
  const addingToTable = dineInActive && dineIn.view === "add_items";

  // Table state is tenant/branch scoped; drop it when the operator leaves POS.
  useEffect(() => () => tableStore.reset(), []); // eslint-disable-line react-hooks/exhaustive-deps

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
    const owner: CartOwner =
      addingToTable && dineIn.selected ? { kind: "table", tableId: dineIn.selected.id } : { kind: "takeaway" };
    if (useCart.getState().claim(owner)) return true;
    toast.push({
      tone: "warning",
      message: "The cart is in use",
      detail: "Send or clear the current order before starting another one.",
    });
    return false;
  }, [addingToTable, dineIn.selected, toast]);

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

  const sendToKitchen = useCallback(async () => {
    if (inFlight.current || cart.lines.length === 0) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const saved = await ensureOrder();
      if (saved) {
        toast.push({
          tone: "success",
          message: saved.idempotent ? `Order ${saved.order_number} already sent` : `Order ${saved.order_number} sent to kitchen`,
          detail: saved.idempotent ? "The same submission was replayed - no second order was created." : null,
        });
        newOrder();
      }
    } catch (e) {
      const c = classifyError(e);
      toast.push({ tone: c.expected ? "warning" : "error", message: c.message, detail: c.hint });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [cart.lines.length, ensureOrder, newOrder, toast]);

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
          if (step === "present-receipt") receiptStore.present(completion.receipt);
          else if (step === "close-payment-dialog") setPayOpen(false);
          else if (step === "reset-cart") newOrder();
        }

        void shiftStore.refreshCashBox();
        toast.push({ tone: "success", message: `Paid - order ${result.order_number}` });
      } catch (e) {
        const c = classifyError(e);
        // The saved order is deliberately KEPT so a retry pays this same order.
        setPayError(c.hint ? `${c.message} ${c.hint}` : c.message);
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [currency, ensureOrder, newOrder, pos.branch.name, pos.tenantName, pos.userName, rate, receiptStore, shiftId, shiftStore, toast],
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
    openShift: () => !shiftId && setOpenShiftOpen(true),
    endShift: () => shiftId && void startEndShift(),
    fullscreen: () => void toggleFullscreen(),
  });

  // Menu + buffer bindings. Live whenever the MENU is on screen - Takeaway, or
  // Dine-in Add Items - because in both cases these keys edit the same buffer.
  // Disabled on the table map so the arrows drive the grid instead: one binding,
  // one owner, decided by what the operator can actually see.
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
    !dineInActive || addingToTable,
  );

  // Takeaway-only. New order, payment and the receipt belong to a takeaway
  // order; a dine-in round has none of them in Level 2B.
  useShortcuts(
    {
      newOrder,
      openPayment,
      print: () => receiptStore.reopen(),
    },
    !dineInActive,
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
    { key: "delivery", label: "Delivery", icon: "V", to: "/pos", enabled: false, reason: "Delivery arrives in the next phase." },
  ];

  return (
    <>
      <PosShell
        routes={routes}
        onExit={() => navigate("/dashboard")}
        onToggleFullscreen={() => void toggleFullscreen()}
        cartDrawerOpen={cartDrawerOpen}
        onCartDrawerChange={setCartDrawerOpen}
        cartTitle={dineInActive ? "Table bill" : "Current order"}
        cartSummary={
          dineInActive
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
          />
        )}
        /* One menu implementation, used by Takeaway AND by Dine-in Add Items.
           A second menu would be a second place for prices to drift. */
        work={(layout) =>
          dineInActive && dineIn.view === "map" ? (
            dineIn.work(layout)
          ) : (
            <>
              <div className="mb-3 flex shrink-0 items-center gap-2">
                {addingToTable && (
                  <span className="rounded-lg bg-brand-soft px-3 py-2 text-xs font-extrabold text-brand-dark">
                    Adding to {dineIn.selected?.name}
                  </span>
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
          )
        }
        cart={(layout) =>
          dineInActive ? (
            dineIn.view === "add_items" ? (
              dineIn.roundPanel(layout)
            ) : (
              dineIn.bill(layout)
            )
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
              onNewOrder={newOrder}
            />
          )
        }
      />

      {dineInActive && dineIn.dialogs}

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
