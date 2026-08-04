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
import { selectItemCount, selectSubtotal, useCart } from "@/state/cart";
import { filterItems, loadMenu, cacheMenu, readCachedMenu, usableCategories, withSearchIndex, type SearchableItem } from "@/lib/pos/menu";
import { groupsForItem, lineTotals, requiresChoice } from "@/lib/pos/modifiers";
import { buildSubmitPayload, submitOrder } from "@/lib/pos/orders";
import { payOrder, type PaymentMethod } from "@/lib/pos/payments";
import { getShiftExpected } from "@/lib/pos/shifts";
import { classifyError } from "@/lib/pos/errors";
import { buildReceipt, type ReceiptData } from "@/lib/receipt";
import { computeChange } from "@/lib/pos/payments";
import { convertCurrency, hasValidRate, type CurrencyCode } from "@/lib/currency";
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
  // `lastReceipt` survives closing the preview so Ctrl+P can bring it back.
  const [lastReceipt, setLastReceipt] = useState<ReceiptData | null>(null);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [cartDrawerOpen, setCartDrawerOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // Synchronous latch: three fast clicks must not reach the server three times.
  // The server is still the authority (m224); this only avoids the round trips.
  const inFlight = useRef(false);

  // --- actions ---------------------------------------------------------------

  const addItem = useCallback(
    (item: SearchableItem, price: number) => {
      const groups = groupsForItem(item.id, menu.groupsByItem, menu.groups);
      if (groups.length > 0) {
        setPickerItem({ item, price, groups });
        return;
      }
      cart.addLine({ menuItemId: item.id, name: item.name, basePrice: price });
    },
    [cart, menu.groupsByItem, menu.groups],
  );

  const confirmPicker = useCallback(
    (input: { modifiers: SelectedModifier[]; quantity: number; note: string | null }) => {
      if (!pickerItem) return;
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
    [cart, pickerItem],
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
    async (input: { method: PaymentMethod; currency: CurrencyCode; discount: Record<string, unknown> }) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      setPayError(null);
      const lines = useCart.getState().lines;
      try {
        const saved = await ensureOrder();
        if (!saved) return;
        const result = await payOrder({ orderId: saved.order_id, method: input.method, currency: input.currency, discount: input.discount });

        // Everything on the receipt below comes from the server response.
        const tenderTotal =
          input.currency === currency
            ? result.amount
            : hasValidRate(rate)
              ? convertCurrency(result.amount, currency, input.currency, rate)
              : null;
        const change = tenderTotal === null ? null : computeChange(tenderTotal, tenderTotal, input.currency).change;

        setLastReceipt(
          buildReceipt({
            businessName: pos.tenantName,
            branchName: pos.branch.name,
            staffName: pos.userName,
            orderNumber: result.order_number || saved.order_number,
            at: new Date().toLocaleString(),
            paid: true,
            method: result.method,
            currency,
            lines: lines.map((l) => ({
              name: l.name,
              qty: l.quantity,
              unitPrice: lineTotals(l.base_price, l.modifiers, 1).finalUnitPrice,
              lineTotal: lineTotals(l.base_price, l.modifiers, l.quantity).lineTotal,
              modifiers: l.modifiers.map((m) => ({ name: m.name, price_delta: m.price_delta, quantity: m.quantity })),
              note: l.kitchen_note,
            })),
            subtotal: result.subtotal,
            discount: result.discount,
            total: result.amount,
            tenderCurrency: input.currency,
            tenderTotal,
            tendered: tenderTotal,
            change,
            exchangeRate: result.exchange_rate,
            shiftRef: shiftId ? shiftId.slice(0, 8) : null,
          }),
        );

        setPayOpen(false);
        setReceiptOpen(true);
        newOrder();
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
    [currency, ensureOrder, newOrder, pos.branch.name, pos.tenantName, pos.userName, rate, shiftId, shiftStore, toast],
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

  useShortcuts({
    newOrder,
    search: () => searchRef.current?.focus(),
    openPayment,
    prevCategory: () => setCategory((c) => stepCategory(categoryIds, c, -1)),
    nextCategory: () => setCategory((c) => stepCategory(categoryIds, c, 1)),
    lineUp: () => cart.moveSelection(-1),
    lineDown: () => cart.moveSelection(1),
    qtyUp: () => cart.selectedKey && cart.adjustQuantity(cart.selectedKey, 1),
    qtyDown: () => cart.selectedKey && cart.adjustQuantity(cart.selectedKey, -1),
    removeLine: () => cart.selectedKey && removeLine(cart.selectedKey),
    openShift: () => !shiftId && setOpenShiftOpen(true),
    endShift: () => shiftId && void startEndShift(),
    print: () => lastReceipt && setReceiptOpen(true),
    routeTakeaway: () => setCategory(ALL_CATEGORIES),
    fullscreen: () => void toggleFullscreen(),
  });

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
    { key: "takeaway", label: "Takeaway", icon: "T", to: "/pos", enabled: true },
    { key: "dine_in", label: "Dine-in", icon: "D", to: "/pos", enabled: false, reason: "Dine-in arrives in the next phase." },
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
        cartSummary={{
          itemCount,
          subtotal,
          currency,
          onPay: openPayment,
          payDisabled: cart.lines.length === 0 || busy || !shiftId,
        }}
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
        work={(layout) => (
          <>
            <div className="mb-3 flex shrink-0 items-center gap-2">
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
        cart={() => (
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
        )}
      />

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

      {receiptOpen && lastReceipt && <ReceiptModal data={lastReceipt} onClose={() => setReceiptOpen(false)} />}
    </>
  );
}
