// Dine-In workspace (Levels 2A-2D).
//
// This is a HOOK, not a second shell. Takeaway and Dine-in render into the same
// `PosShell` with the same status bar, layout resolver and drawer machinery; all
// this contributes is the work region (table map or the borrowed menu), the
// right panel (server bill or the round being prepared) and their dialogs.
//
// What it can do: open a table (2A), build and send rounds (2B), move, close or
// clear a table (2C), and settle a table (2D).
//
// PAYMENT, in one paragraph. There is exactly one gate (`payTableGate`) and one
// synchronous latch, and every path that can settle - the bill panel's Pay
// button, the bottom bar's PAY slot, F4 and the dialog's own confirm - goes
// through both. F4 only OPENS the dialog; it never charges. The bill is re-read
// from the server immediately before submitting, because the amount on screen is
// not authority to charge. And because `pos_pay_table` has no idempotency key, a
// lost response is resolved by asking the server what happened
// (`lib/pos/tablePayment.ts`) rather than by retrying - a blind retry is the one
// thing that could take a customer's money twice.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useToast } from "@/components/toast";
import { useShortcuts } from "@/lib/keyboard/provider";
import { TableMap } from "@/components/pos/TableMap";
import { TableBillPanel } from "@/components/pos/TableBillPanel";
import { SeatCountDialog } from "@/components/pos/SeatCountDialog";
import { DineInRoundPanel } from "@/components/pos/DineInRoundPanel";
import { Modal } from "@/components/overlays";
import { Button } from "@/components/ui";
import { filterTables, isOpenable, openTable } from "@/lib/pos/tables";
import { classifyError } from "@/lib/pos/errors";
import { canClearTable, canCloseTable, canMoveTable, canOpenTable } from "@/lib/pos/access";
import { ClearTableDialog, CloseTableDialog, MoveTableDialog } from "@/components/pos/TableOpsDialogs";
import {
  clearOutcomeMessage,
  clearTable,
  closeOutcomeMessage,
  closeTable,
  moveOutcomeMessage,
  moveTable,
  tableOpGate,
  type TableOpKind,
} from "@/lib/pos/tableOps";
import {
  addItemsGate as computeAddItemsGate,
  describeBillChange,
  performRound,
  roundOutcomeMessage,
  submitRoundGate,
  type RoundContext,
  type RoundMenu,
} from "@/lib/pos/tableRounds";
import { submitOrder } from "@/lib/pos/orders";
import type { KitchenSourceLine } from "@/lib/pos/kitchenPrinter";
import type { ResolverOrderSource } from "@/lib/pos/printRouting";
import { PaymentDialog } from "@/components/pos/PaymentDialog";
import {
  buildTablePaymentPayload,
  createPaymentLatch,
  payTable,
  payTableGate,
  performTablePayment,
  validateTableDiscount,
  type TablePaymentResult,
} from "@/lib/pos/tablePayment";
import { billIsCleared, buildTablePaymentReceipt, buildTableOnAccountReceipt } from "@/lib/pos/tablePaymentCompletion";
import {
  completeTableOnAccount,
  createOnAccountLatch,
  performOnAccount,
  type OnAccountVerdict,
} from "@/lib/pos/onAccount";
import { useCustomerPicker } from "@/state/customerPicker";
import { paymentBlockedReason, type PaymentMethod } from "@/lib/pos/payments";
import { selectSubtotal, useCart } from "@/state/cart";
import { isMapStale, selectedTable as pickSelected, useTables } from "@/state/tables";
import type { PosContext } from "@/state/pos";
import type { LayoutSpec } from "@/lib/layout";
import type { Gate } from "@/components/ui";
import { formatMoney, type CurrencyCode } from "@/lib/currency";
import type { DiscountType } from "@/lib/pos/discounts";
import type { ReceiptData } from "@/lib/receipt";
import type { CartLine } from "@/types/pos";
import type { TableBill, TableSummary } from "@/types/tables";

/** Which half of Dine-in is on screen. Add Items borrows the menu from the shell. */
export type DineInView = "map" | "add_items";

export type DineInWorkspace = {
  view: DineInView;
  work: (layout: LayoutSpec) => React.ReactNode;
  bill: (layout: LayoutSpec) => React.ReactNode;
  roundPanel: (layout: LayoutSpec) => React.ReactNode;
  dialogs: React.ReactNode;
  /** Drawer summary for the sub-1024 tier. */
  summary: { itemCount: number; subtotal: number };
  selected: TableSummary | null;
  /** True while an unsent round is buffered for the selected table. */
  hasUnsentRound: boolean;
  /** Ask to leave Add Items; may open a confirmation instead of leaving. */
  requestLeaveAddItems: () => void;
  /**
   * THE payment gate. Exported so the shell's bottom bar renders from the exact
   * same result the bill panel and F4 use - never a second opinion.
   */
  payGate: Gate;
  /** Opens the payment dialog. Never settles anything on its own. */
  requestPay: () => void;
};

export function useDineInWorkspace(input: {
  pos: PosContext;
  hasOpenShift: boolean;
  /** The open shift's id. Required on every round payload - never inferred. */
  shiftId: string | null;
  active: boolean;
  online: boolean;
  menu: RoundMenu;
  createOrders: Gate;
  currency: CurrencyCode;
  cartLines: CartLine[];
  cartSelectedKey: string | null;
  onSelectLine: (key: string) => void;
  onAdjustLine: (key: string, delta: number) => void;
  onRemoveLine: (key: string) => void;
  onEditNote: (key: string) => void;
  onOpenShift: () => void;
  onBillDrawerOpen: () => void;
  /** Take the operator to where this branch's table capacity is set. */
  onConfigureTables: () => void;
  /** Tenant USD->LBP rate. Payment in LBP is refused without one - never guessed. */
  rate: number | null;
  /**
   * Receipt presentation. Routed through the caller so it reaches the SAME
   * store-owned layer takeaway uses, which is mounted outside the workspace's
   * loading states on purpose (see `state/receipt.ts`).
   */
  onPresentReceipt: (receipt: ReceiptData) => void;
  /**
   * Kitchen ticket for ONE submitted batch, routed through the caller for the
   * same reason the receipt is: there is one implementation of "print what was
   * just sent", shared by all three POS routes, and it lives above the
   * workspace's loading states.
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
}): DineInWorkspace {
  const { pos, hasOpenShift, active } = input;
  const toast = useToast();
  const tables = useTables();
  const cart = useCart();

  const [query, setQuery] = useState("");
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [seatOpen, setSeatOpen] = useState(false);
  /**
   * The open dialog is naming a NEW table rather than opening a mapped one.
   *
   * Only reachable when the branch has no configured tables, which is the one
   * case `pos_open_table` accepts free text in.
   */
  const [manualOpen, setManualOpen] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const searchRef = useRef<HTMLInputElement>(null);
  // Same synchronous latch Takeaway uses: two fast taps must not both fire.
  const inFlight = useRef(false);

  // --- Level 2B round state ---------------------------------------------------
  const [view, setView] = useState<DineInView>("map");
  const [leaveConfirm, setLeaveConfirm] = useState(false);
  const [roundBusy, setRoundBusy] = useState(false);
  const [billChange, setBillChange] = useState<string | null>(null);
  // Separate latch from open-table: sending a round and opening a table are
  // different operations and must not block one another.
  const roundInFlight = useRef(false);

  // --- Level 2C table operations ----------------------------------------------
  // Which confirmation is open, if any. One piece of state rather than three
  // booleans, so two dialogs cannot be open at once.
  const [opDialog, setOpDialog] = useState<TableOpKind | null>(null);
  const [opError, setOpError] = useState<string | null>(null);
  const [opBusy, setOpBusy] = useState(false);
  // Its own latch: moving, closing and clearing must not be double-fired, and
  // must not be blocked by an unrelated round submission.
  const opInFlight = useRef(false);

  // --- Level 2D settlement ----------------------------------------------------
  const [payOpen, setPayOpen] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  /**
   * The one latch every submit path shares. A ref, not state: two clicks in the
   * same tick would both read a stale `paying === false`, and `setState` cannot
   * settle that race. `paying` exists only to re-render the gate.
   */
  const payLatch = useRef(createPaymentLatch());
  /**
   * Ensures the completion sequence runs once per payment. Reset when a NEW
   * payment attempt begins, never on a re-render.
   */
  const completionDone = useRef(false);
  // Customer Receivables / On Account. Its own latch, and a customer picker that
  // is live only while the payment dialog is open and on-account is reachable.
  const onAccountLatch = useRef(createOnAccountLatch());
  const onAccountReachable = payOpen && pos.gates.takeOnAccount.allowed && input.online;
  const customerPicker = useCustomerPicker({
    access: pos.access,
    branchId: pos.branch.id,
    online: input.online,
    enabled: onAccountReachable,
    onError: (message) => setPayError(message),
  });

  const ctx = useMemo(
    () => ({ tenantId: pos.tenantId, branchId: pos.branch.id }),
    [pos.tenantId, pos.branch.id],
  );

  // Load the map when Dine-in becomes active, and whenever the context moves.
  useEffect(() => {
    if (!active || !pos.allowed || !ctx.branchId) return;
    void tables.refresh(ctx);
    // The store is a stable zustand reference.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, pos.allowed, ctx.tenantId, ctx.branchId]);

  // Elapsed badges tick slowly - orientation only, not a timer.
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [active]);

  const selected = pickSelected({ map: tables.map, selectedTableId: tables.selectedTableId });
  const visible = useMemo(() => filterTables(tables.map.tables, query), [tables.map.tables, query]);
  const stale = isMapStale(tables.lastLoadedAt, now);

  const openGate: Gate = useMemo(() => {
    const base = canOpenTable(pos.access, hasOpenShift);
    if (!base.allowed) return base;
    if (!selected) return { allowed: false, reason: "Select a table first." };
    if (!isOpenable(selected)) return { allowed: false, reason: "This table already has an open bill." };
    return { allowed: true, reason: null };
  }, [pos.access, hasOpenShift, selected]);

  // Level 2C gates. Each combines the permission-map answer with the desktop's
  // own preconditions (shift, connection, an actual bill to act on).
  const opGates = useMemo(() => {
    const common = { table: selected, hasOpenShift, online: input.online };
    return {
      move: tableOpGate({ kind: "move", permitted: canMoveTable(pos.access), ...common }),
      close: tableOpGate({ kind: "close", permitted: canCloseTable(pos.access), ...common }),
      clear: tableOpGate({ kind: "clear", permitted: canClearTable(pos.access), ...common }),
    };
  }, [pos.access, selected, hasOpenShift, input.online]);

  /**
   * THE payment gate. Computed once, here, and handed to every surface that can
   * start a payment. Nothing downstream re-derives "can pay" from its own parts.
   *
   * `pos.apply_discounts` is deliberately NOT part of it: a cashier without that
   * permission may still settle a bill at full price. Discount permission is
   * enforced only when a discount is actually entered.
   */
  const payGate: Gate = useMemo(
    () =>
      payTableGate({
        takePayments: pos.gates.takePayments,
        table: selected,
        bill: tables.bill,
        hasOpenShift,
        online: input.online,
        settling: paying,
        branchId: pos.branch.id,
      }),
    [pos.gates.takePayments, pos.branch.id, selected, tables.bill, hasOpenShift, input.online, paying],
  );

  const select = useCallback(
    (id: string) => {
      setFocusedId(id);
      void tables.select(id, ctx);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [ctx],
  );

  /**
   * Run one table operation and re-read the server.
   *
   * Every one of these ends with the table in a state only the server knows, so
   * none of them patches the map locally: `runOp` refreshes and then re-reads the
   * selection from the refreshed map. A cleared table that stayed "occupied" on
   * screen would invite a second clear of a bill that is already void.
   */
  const runOp = useCallback(
    async (kind: TableOpKind, run: () => Promise<string>, options?: { selectAfter?: string | null }) => {
      if (opInFlight.current) return;
      opInFlight.current = true;
      setOpBusy(true);
      setOpError(null);
      try {
        const message = await run();
        setOpDialog(null);
        await tables.refresh(ctx);
        // Move follows the bill to its new table; Close and Clear leave the
        // operator on a table that is now free, which is what they just did.
        if (options?.selectAfter) {
          await tables.select(options.selectAfter, ctx);
          setFocusedId(options.selectAfter);
        } else {
          await tables.loadBill(ctx);
        }
        toast.push({ tone: kind === "clear" ? "info" : "success", message, detail: null });
      } catch (e) {
        const c = classifyError(e);
        setOpError(c.hint ? `${c.message} ${c.hint}` : c.message);
      } finally {
        opInFlight.current = false;
        setOpBusy(false);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [ctx, toast],
  );

  const confirmMove = useCallback(
    (destinationId: string) => {
      if (!selected || !opGates.move.allowed) return;
      const from = selected.name;
      const to = tables.map.tables.find((t) => t.id === destinationId)?.name ?? "the new table";
      void runOp(
        "move",
        async () => moveOutcomeMessage(await moveTable({ fromTableId: selected.id, toTableId: destinationId }), from, to),
        // Follow the bill: the operator's attention belongs where the money went.
        { selectAfter: destinationId },
      );
    },
    [selected, opGates.move.allowed, tables.map.tables, runOp],
  );

  const confirmClose = useCallback(() => {
    if (!selected || !opGates.close.allowed) return;
    const name = selected.name;
    void runOp("close", async () => closeOutcomeMessage(await closeTable({ tableId: selected.id }), name));
  }, [selected, opGates.close.allowed, runOp]);

  const confirmClear = useCallback(
    (reason: string) => {
      if (!selected || !opGates.clear.allowed) return;
      const name = selected.name;
      void runOp("clear", async () => clearOutcomeMessage(await clearTable({ tableId: selected.id, reason }), name));
    },
    [selected, opGates.clear.allowed, runOp],
  );

  /** Open a confirmation. The shortcut and the button both come through here. */
  const requestOp = useCallback(
    (kind: TableOpKind) => {
      setOpError(null);
      setOpDialog(kind);
    },
    [],
  );

  const confirmOpen = useCallback(
    async (seats: number | null, typedName?: string) => {
      // A named open has no selected card by definition, so `selected` is only
      // required for the map path.
      const name = typedName?.trim() || selected?.name;
      if (inFlight.current || !name) return;
      if (!openGate.allowed) return;
      inFlight.current = true;
      setBusy(true);
      setOpenError(null);
      try {
        const result = await openTable({ branchId: ctx.branchId, name, seats });
        setSeatOpen(false);
        setManualOpen(false);
        // Re-read the map: the server is the authority on the new state, and the
        // returned STORED name is what the map will now show.
        await tables.refresh(ctx);
        await tables.select(result.table_id, ctx);
        setFocusedId(result.table_id);
        toast.push({
          tone: "success",
          message: `${result.name} opened`,
          detail: result.created ? "New table record created." : null,
        });
      } catch (e) {
        const c = classifyError(e);
        setOpenError(c.hint ? `${c.message} ${c.hint}` : c.message);
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selected, openGate.allowed, ctx, toast],
  );

  // --- Level 2B: rounds -------------------------------------------------------

  const roundCtx: RoundContext = useMemo(
    () => ({ branchId: pos.branch.id, shiftId: input.shiftId, table: selected, online: input.online }),
    [pos.branch.id, input.shiftId, selected, input.online],
  );

  /** Lines currently buffered FOR THIS TABLE. Another owner's lines are not ours. */
  const roundLines = useMemo(
    () =>
      selected && cart.owner?.kind === "table" && cart.owner.tableId === selected.id ? input.cartLines : [],
    [selected, cart.owner, input.cartLines],
  );
  const hasUnsentRound = roundLines.length > 0;
  const roundSubtotal = useMemo(() => selectSubtotal(roundLines), [roundLines]);

  const addItemsGate: Gate = useMemo(() => {
    const base = computeAddItemsGate({ ctx: roundCtx, createOrders: input.createOrders });
    if (!base.allowed) return base;
    // The buffer is shared with Takeaway on purpose (one cart, one round at a
    // time). If someone else's work is in it, say whose rather than merging.
    if (input.cartLines.length > 0 && cart.owner?.kind === "takeaway") {
      return { allowed: false, reason: "Finish or clear the takeaway order first - the cart is in use." };
    }
    if (
      input.cartLines.length > 0 &&
      cart.owner?.kind === "table" &&
      selected &&
      cart.owner.tableId !== selected.id
    ) {
      return { allowed: false, reason: "Another table has an unsent round. Send or discard it first." };
    }
    return base;
  }, [roundCtx, input.createOrders, input.cartLines.length, cart.owner, selected]);

  const submitGate: Gate = useMemo(
    () =>
      submitRoundGate({
        ctx: roundCtx,
        lines: roundLines,
        createOrders: input.createOrders,
        menu: input.menu,
      }),
    [roundCtx, roundLines, input.createOrders, input.menu],
  );

  /**
   * Enter Add Items. The bill is RE-READ first: the operator is about to build a
   * round against what they can see, so what they see must be current.
   */
  const enterAddItems = useCallback(async () => {
    if (!selected || !addItemsGate.allowed) return;
    if (!cart.claim({ kind: "table", tableId: selected.id })) return;
    setBillChange(null);
    const before = useTables.getState().bill;
    await tables.loadBill(ctx);
    setBillChange(describeBillChange(before, useTables.getState().bill));
    setView("add_items");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, addItemsGate.allowed, ctx]);

  /** Leave Add Items. An unsent round is never discarded silently. */
  const requestLeaveAddItems = useCallback(() => {
    if (hasUnsentRound) {
      setLeaveConfirm(true);
      return;
    }
    setBillChange(null);
    setView("map");
  }, [hasUnsentRound]);

  /** Keep the round, just go back to the map. It stays buffered for this table. */
  const leaveKeepingRound = useCallback(() => {
    setLeaveConfirm(false);
    setBillChange(null);
    setView("map");
  }, []);

  const discardRound = useCallback(() => {
    cart.reset();
    setLeaveConfirm(false);
    toast.push({ tone: "info", message: "Round discarded", detail: "Nothing was sent to the kitchen." });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast]);

  /**
   * Send the round.
   *
   * The op id comes from the cart and is NOT cleared on failure, so a retry is
   * the same logical round and m224 replays rather than duplicating. It is
   * cleared only by `cart.reset()` after the server has definitively accepted.
   */
  const sendRound = useCallback(async () => {
    if (roundInFlight.current || !selected) return;
    if (!submitGate.allowed) return;
    roundInFlight.current = true;
    setRoundBusy(true);
    try {
      const before: TableBill | null = useTables.getState().bill;
      const opId = useCart.getState().ensureOpId();
      // The round as it is about to be SENT, snapshotted before the buffer is
      // cleared. This - and not a re-read of the bill - is what the kitchen
      // ticket is built from, because the bill contains every earlier round and
      // reprinting those would have the kitchen cook them again.
      const submitted = useCart.getState().lines;
      // The sequence itself lives in `performRound` so it is testable; this is
      // the same build -> submit -> clear -> refresh order the tests pin.
      const outcome = await performRound({
        ctx: { ...roundCtx, table: selected },
        lines: useCart.getState().lines,
        clientOpId: opId,
        menu: input.menu,
        submit: submitOrder,
        // Accepted. Only now does the buffer go - and with it the operation id,
        // so the NEXT round mints a fresh one.
        clearBuffer: () => useCart.getState().reset(),
        refresh: async () => {
          await tables.refresh(ctx);
          await tables.select(selected.id, ctx);
        },
      });

      if (!outcome.ok) throw outcome.error;

      // Discount the batch WE just added, or every successful submit would
      // report itself as somebody else's concurrent round.
      setBillChange(describeBillChange(before, useTables.getState().bill, outcome.result.idempotent ? 0 : 1));
      const { message, detail } = roundOutcomeMessage(outcome.result);
      toast.push({ tone: outcome.result.idempotent ? "info" : "success", message, detail });

      // ONLY THIS ROUND. `batch_no` is the server's own number for the batch it
      // just appended, so round 2's ticket is labelled round 2 and contains
      // round 2. A replayed submission (`idempotent`) carries the batch it
      // originally created, and the print latch keys on it - so a retry of a
      // round the server already has produces no second ticket.
      await input.onKitchenBatch({
        source: "dine_in",
        orderId: outcome.result.order_id,
        orderNumber: outcome.result.order_number,
        batchNo: outcome.result.batch_no ?? null,
        tableName: selected.name,
        lines: submitted.map((l) => ({
          name: l.name,
          qty: l.quantity,
          modifiers: l.modifiers.map((m) => ({ name: m.name, quantity: m.quantity })),
          note: l.kitchen_note,
          // The canonical item, so this round's lines route to their stations
          // exactly as a takeaway order's do. The category is resolved by the
          // shared call site - see `printKitchenFor`.
          menuItemId: l.menu_item_id,
        })),
      });
    } catch (e) {
      // The round survives, unchanged, with the same operation id.
      const c = classifyError(e);
      toast.push({
        tone: c.expected ? "warning" : "error",
        message: c.message,
        detail: c.hint ? `${c.hint} Your round is still here - press Submit round to retry.` : "Your round is still here.",
      });
    } finally {
      roundInFlight.current = false;
      setRoundBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, submitGate.allowed, roundCtx, ctx, input.menu, toast]);

  // --- Level 2D: settlement ---------------------------------------------------

  /** The store's current view of the selected table, as one authoritative pair. */
  const readTableState = useCallback(() => {
    const s = useTables.getState();
    return { bill: s.bill, table: pickSelected(s) };
  }, []);

  /**
   * Open the payment dialog.
   *
   * This is ALL that the Pay button, the bottom-bar PAY slot and F4 do. None of
   * them charges anything, and all three are disabled by the same `payGate`, so
   * there is no surface from which payment can start under weaker conditions
   * than any other.
   */
  const requestPay = useCallback(() => {
    if (!payGate.allowed) return;
    setPayError(null);
    setPayOpen(true);
  }, [payGate.allowed]);

  /**
   * The locked completion sequence (2D-09).
   *
   * Runs at most once per payment, for BOTH a directly confirmed and a recovered
   * settlement. The order is the one pinned in `tablePaymentCompletion.ts`: the
   * server's view of the table is refreshed and checked BEFORE anything is shown
   * as settled, the cash box is re-read rather than incremented, and the receipt
   * is presented before the dialog closes so the teardown cannot race it.
   */
  const runCompletion = useCallback(
    async (
      result: TablePaymentResult | null,
      snapshot: {
        bill: TableBill;
        table: TableSummary;
        method: PaymentMethod;
        primaryCurrency: CurrencyCode;
        tenderCurrency: CurrencyCode;
        tendered: number | null;
        requestedDiscount: number;
      },
    ) => {
      if (completionDone.current) return;
      completionDone.current = true;

      // 1 + 2. The server's word on the table, then proof the bill is gone.
      //        No local "mark it available" - `pos_pay_table` frees the table
      //        itself, and `pos_close_table` is NOT called after payment.
      await tables.refresh(ctx);
      const after = readTableState();
      const cleared = billIsCleared(after.bill, after.table);

      // 3. Authoritative cash box. Never incremented locally.
      await input.refreshCashBox();

      // 4. Receipt, from the PRE-payment bill (identity) + the server's figures.
      input.onPresentReceipt(
        buildTablePaymentReceipt({
          bill: snapshot.bill,
          table: snapshot.table,
          result,
          requestedDiscount: snapshot.requestedDiscount,
          method: snapshot.method,
          tenantName: pos.tenantName,
          branchName: pos.branch.name,
          operatorName: pos.userName,
          primaryCurrency: snapshot.primaryCurrency,
          tenderCurrency: snapshot.tenderCurrency,
          rate: input.rate,
          tenderedInput: snapshot.tendered,
          shiftId: input.shiftId,
          at: new Date().toLocaleString(),
        }),
      );

      // 5 + 6. Close, and drop the selected payment state.
      setPayOpen(false);
      setPayError(null);

      if (!cleared) {
        // The payment reported success but the table still shows an open bill.
        // Said out loud rather than smoothed over - it is the one shape that
        // could invite a second payment.
        toast.push({
          tone: "warning",
          message: "The payment went through, but this table still shows an open bill",
          detail: "Refresh the table map and check it before taking any further payment.",
        });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ctx, readTableState, pos.tenantName, pos.branch.name, pos.userName, input.rate, input.shiftId, toast],
  );

  /**
   * Settle the table. Exactly one submit, ever.
   *
   * The gate is re-checked here as well as at the button: the dialog can sit open
   * while another terminal adds a round, and the state that made Pay legal may
   * not be the state at confirm time. The re-read inside `performTablePayment`
   * then makes the same point about the AMOUNT.
   */
  const confirmPay = useCallback(
    async (dialog: {
      method: PaymentMethod;
      currency: CurrencyCode;
      discountType: DiscountType;
      discountValue: string;
      tendered: number | null;
    }) => {
      const table = selected;
      const shownBill = useTables.getState().bill;
      if (!table || !shownBill || !payGate.allowed) return;

      // The bill's OWN currency is what the server settles in. The dialog's
      // currency is the TENDER currency at the drawer - a different thing.
      const primaryCurrency: CurrencyCode = shownBill.currency ?? input.currency;
      const subtotal = shownBill.subtotal ?? 0;

      let discount: ReturnType<typeof validateTableDiscount>;
      try {
        discount = validateTableDiscount({
          canDiscount: pos.gates.applyDiscounts,
          subtotal,
          type: dialog.discountType,
          value: dialog.discountValue,
        });
      } catch (e) {
        const c = classifyError(e);
        setPayError(c.hint ? `${c.message} ${c.hint}` : c.message);
        return;
      }

      // LBP with no tenant rate is refused before the request, never guessed.
      const rateBlock = paymentBlockedReason(dialog.currency, input.rate);
      if (rateBlock) {
        setPayError(rateBlock);
        return;
      }

      const payload = buildTablePaymentPayload({
        tableId: table.id,
        method: dialog.method,
        currency: primaryCurrency,
        discount: discount.fields,
      });

      completionDone.current = false;
      setPaying(true);
      setPayError(null);
      try {
        const outcome = await performTablePayment({
          shownBill,
          table,
          payload,
          latch: payLatch.current,
          // 2D-02: the map AND the bill, from the server, immediately before the
          // charge. `refresh` reloads the bill for the surviving selection.
          reReadBill: async () => {
            await tables.refresh(ctx);
            return readTableState();
          },
          submit: payTable,
          // Used ONLY when the response was lost. This is what turns "did it go
          // through?" into a question the server answers.
          recoverRead: async () => {
            await tables.refresh(ctx);
            return readTableState();
          },
          complete: (result) =>
            runCompletion(result, {
              bill: shownBill,
              table,
              method: dialog.method,
              primaryCurrency,
              tenderCurrency: dialog.currency,
              tendered: dialog.tendered,
              requestedDiscount: discount.amount,
            }),
          // Final authoritative bill read, so Pay is no longer reachable.
          refresh: async () => {
            setFocusedId(table.id);
            await tables.loadBill(ctx);
          },
        });

        if (outcome.ok) {
          toast.push({
            tone: "success",
            message: outcome.recovered
              ? `${table.name} was already settled`
              : `${table.name} paid - ${formatMoney(outcome.result.amount, outcome.result.currency_code)}`,
            detail: outcome.recovered
              ? "The response to the earlier payment was lost, but the server shows the bill settled. No second payment was taken."
              : null,
          });
          return;
        }

        const c = classifyError(outcome.error);
        setPayError(c.hint ? `${c.message} ${c.hint}` : c.message);
        if (!outcome.retryable) {
          // Stale bill and ambiguous response are BOTH non-retryable, for
          // opposite reasons: one needs the operator to re-read the bill, the
          // other needs them to not touch anything. Neither offers "try again".
          toast.push({ tone: c.expected ? "warning" : "error", message: c.message, detail: c.hint });
        }
      } finally {
        setPaying(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selected, payGate.allowed, pos.gates.applyDiscounts, input.currency, input.rate, ctx, readTableState, runCompletion, toast],
  );

  /**
   * Put the whole TABLE bill on account. Exactly one submit, ever.
   *
   * The sibling of `confirmPay`: the same re-read-then-once shape and the same
   * completion order (server view, proof the table freed, cash box, receipt),
   * but the money call is `pos_complete_table_on_account` and the receipt is a
   * receivable. ONLINE ONLY and a customer is REQUIRED.
   */
  const confirmTableOnAccount = useCallback(
    async (dialog: {
      mode: "account" | "partial";
      amountNow: number;
      customerId: string;
      method: PaymentMethod;
      discountType: DiscountType;
      discountValue: string;
    }) => {
      const table = selected;
      const shownBill = useTables.getState().bill;
      if (!table || !shownBill || !payGate.allowed) return;
      if (!input.online) {
        setPayError("On-account sales need a connection. Reconnect before putting a bill on account.");
        return;
      }
      if (!dialog.customerId) {
        setPayError("Choose a customer before putting a bill on account.");
        return;
      }

      const primaryCurrency: CurrencyCode = shownBill.currency ?? input.currency;
      const discountFields =
        dialog.discountType !== "none" && dialog.discountValue.trim() !== ""
          ? { discountType: dialog.discountType as "percent" | "amount", discountValue: Number(dialog.discountValue) }
          : {};

      completionDone.current = false;
      setPaying(true);
      setPayError(null);
      try {
        const outcome = await performOnAccount({
          latch: onAccountLatch.current,
          submit: () =>
            completeTableOnAccount({
              tableId: table.id,
              customerId: dialog.customerId,
              amount: dialog.amountNow,
              method: dialog.method,
              ...discountFields,
            }),
          // Lost-response re-read: a table on-account completion frees the table,
          // so a cleared bill is proof it landed.
          reread: async (): Promise<OnAccountVerdict> => {
            await tables.refresh(ctx);
            const after = readTableState();
            return billIsCleared(after.bill, after.table) ? "committed" : "open";
          },
        });

        if (!outcome.ok) {
          const c = classifyError(outcome.error);
          setPayError(c.hint ? `${c.message} ${c.hint}` : c.message);
          if (!outcome.retryable) {
            toast.push({ tone: c.expected ? "warning" : "error", message: c.message, detail: c.hint });
          }
          return;
        }

        if (completionDone.current) return;
        completionDone.current = true;

        // Server view of the table, then proof the bill is gone, then the cash box.
        await tables.refresh(ctx);
        const after = readTableState();
        const cleared = billIsCleared(after.bill, after.table);
        await input.refreshCashBox();

        input.onPresentReceipt(
          buildTableOnAccountReceipt({
            bill: shownBill,
            table,
            result: outcome.result
              ? {
                  bill_total: outcome.result.bill_total,
                  paid_usd: outcome.result.paid_usd,
                  outstanding_primary: outcome.result.outstanding_primary,
                  subtotal: outcome.result.subtotal,
                  discount: outcome.result.discount,
                }
              : null,
            requestedDiscount: 0,
            requestedPaidNow: dialog.amountNow,
            method: dialog.method,
            tenantName: pos.tenantName,
            branchName: pos.branch.name,
            operatorName: pos.userName,
            primaryCurrency,
            shiftId: input.shiftId,
            at: new Date().toLocaleString(),
          }),
        );

        setPayOpen(false);
        setPayError(null);
        // Final authoritative bill read, so Pay is no longer reachable.
        setFocusedId(table.id);
        await tables.loadBill(ctx);

        toast.push({
          tone: "success",
          message: outcome.recovered
            ? `${table.name} was already put on account`
            : outcome.result && outcome.result.paid_usd > 0
              ? `${table.name} partly paid - balance on account`
              : `${table.name} put on account`,
        });

        if (!cleared) {
          toast.push({
            tone: "warning",
            message: "The bill went on account, but this table still shows an open bill",
            detail: "Refresh the table map and check it before taking any further action.",
          });
        }
      } finally {
        setPaying(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selected, payGate.allowed, input.online, input.currency, input.shiftId, ctx, readTableState, toast],
  );

  // A payment dialog left open over a table that is no longer selected would
  // settle nothing and confuse everything.
  useEffect(() => {
    if (payOpen && !selected) setPayOpen(false);
  }, [payOpen, selected]);

  // A selection that moves out from under an unsent round would silently retarget
  // the food. Leaving Add Items is the safe response.
  useEffect(() => {
    if (view !== "add_items") return;
    if (selected) return;
    setView("map");
  }, [view, selected]);

  // Grid-aware movement. Only registered while Dine-in is the active mode, so
  // Takeaway's own arrow/Enter handling is untouched.
  const move = useCallback(
    (delta: number) => {
      if (visible.length === 0) return;
      const index = visible.findIndex((t) => t.id === (focusedId ?? tables.selectedTableId));
      const next = Math.min(visible.length - 1, Math.max(0, (index < 0 ? 0 : index) + delta));
      setFocusedId(visible[next].id);
    },
    [visible, focusedId, tables.selectedTableId],
  );

  // Map view bindings. Unregistered in Add Items so the arrows and Enter belong
  // to the menu instead - one binding, one owner, decided by the visible view.
  useShortcuts(
    {
      tableSearch: () => searchRef.current?.focus(),
      tableLeft: () => move(-1),
      tableRight: () => move(1),
      // Shared vertical ids - in the map view they walk a grid row.
      lineUp: () => move(-1),
      lineDown: () => move(1),
      tableOpen: () => {
        if (!focusedId) return;
        if (focusedId !== tables.selectedTableId) return select(focusedId);
        if (openGate.allowed) setSeatOpen(true);
      },
      addItems: () => void enterAddItems(),
      // Level 2C. Each OPENS its confirmation - a chord never performs the
      // operation, so a mistyped Ctrl+Shift+X cannot void a bill on its own.
      // The gate is re-checked at confirm time, not only here.
      moveTable: () => opGates.move.allowed && requestOp("move"),
      closeTable: () => opGates.close.allowed && requestOp("close"),
      clearTable: () => opGates.clear.allowed && requestOp("clear"),
      // Level 2D. F4 OPENS the dialog and nothing else - it never charges - and
      // it is refused by the same gate that disables the buttons, so the
      // keyboard cannot reach a payment the mouse could not.
      openPayment: () => payGate.allowed && requestPay(),
    },
    active && view === "map",
  );

  // Add Items bindings.
  useShortcuts(
    {
      // Ctrl+Enter. Shared id with the payment dialog, which cannot be open here.
      // The latch inside sendRound is what makes a held key safe, not this.
      confirmPayment: () => void sendRound(),
    },
    active && view === "add_items",
  );

  // Alt+M means "back to the table map" in BOTH views, so it is registered once.
  useShortcuts(
    {
      tableMap: () => {
        // Alt+M is the ONLY dine-in binding marked `worksInInput`, precisely so
        // it can be pressed from inside a search box. That makes releasing DOM
        // focus part of the job: the arrows and Enter are not `worksInInput`, so
        // leaving the caret in the field silently kills every other table
        // binding and the grid can only be reached again with the mouse.
        searchRef.current?.blur();
        if (view === "add_items") return requestLeaveAddItems();
        tables.clearSelection();
        setFocusedId(null);
      },
    },
    active,
  );

  const work = useCallback(
    (layout: LayoutSpec) => (
      <TableMap
        ref={searchRef}
        map={tables.map}
        visible={visible}
        layout={layout}
        selectedTableId={tables.selectedTableId}
        focusedTableId={focusedId}
        loading={tables.loading}
        refreshing={tables.refreshing}
        stale={stale}
        error={tables.error}
        query={query}
        now={now}
        onQueryChange={setQuery}
        onSelect={(id) => {
          select(id);
          if (layout.cartAsDrawer) input.onBillDrawerOpen();
        }}
        onRetry={() => void tables.refresh(ctx)}
        canOpenTable={openGate.allowed}
        onOpenTable={() => {
          // No card to select, so this is the free-text path the server allows
          // only on a branch with no configured tables.
          setManualOpen(true);
          setSeatOpen(true);
        }}
        onConfigureTables={input.onConfigureTables}
      />
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tables.map, visible, tables.selectedTableId, focusedId, tables.loading, tables.refreshing, stale, tables.error, query, now, ctx, select],
  );

  const bill = useCallback(
    () => (
      <TableBillPanel
        table={selected}
        bill={tables.bill}
        loading={tables.billLoading}
        error={tables.billError}
        openGate={openGate}
        addItemsGate={addItemsGate}
        shiftOpen={hasOpenShift}
        onAddItems={() => void enterAddItems()}
        onOpenTable={() => {
          setOpenError(null);
          setSeatOpen(true);
        }}
        onOpenShift={input.onOpenShift}
        moveGate={opGates.move}
        closeGate={opGates.close}
        clearGate={opGates.clear}
        onMove={() => requestOp("move")}
        onClose={() => requestOp("close")}
        onClear={() => requestOp("clear")}
        payGate={payGate}
        onPay={requestPay}
      />
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selected, tables.bill, tables.billLoading, tables.billError, openGate, addItemsGate, hasOpenShift, enterAddItems, opGates, requestOp, payGate, requestPay],
  );

  const roundPanel = useCallback(
    () =>
      selected ? (
        <DineInRoundPanel
          table={selected}
          bill={tables.bill}
          billLoading={tables.billLoading}
          billError={tables.billError}
          refreshing={tables.refreshing || tables.billLoading}
          billChange={billChange}
          lines={roundLines}
          selectedKey={input.cartSelectedKey}
          subtotal={roundSubtotal}
          currency={input.currency}
          busy={roundBusy}
          submitGate={submitGate}
          onSelect={input.onSelectLine}
          onAdjust={input.onAdjustLine}
          onRemove={input.onRemoveLine}
          onEditNote={input.onEditNote}
          onSubmitRound={() => void sendRound()}
          onDiscardRound={discardRound}
          onBackToMap={requestLeaveAddItems}
        />
      ) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      selected, tables.bill, tables.billLoading, tables.billError, tables.refreshing, billChange,
      roundLines, input.cartSelectedKey, roundSubtotal, input.currency, roundBusy, submitGate,
      sendRound, discardRound, requestLeaveAddItems,
    ],
  );

  const dialogs = (
    <>
      {/* The SAME dialog Takeaway uses. Not a copy: one discount validator, one
          currency conversion, one tender/change calculation, one keypad. Only
          the identity at the top differs, which is the part that should. */}
      <PaymentDialog
        open={payOpen}
        busy={paying}
        subtotal={tables.bill?.subtotal ?? 0}
        primaryCurrency={tables.bill?.currency ?? input.currency}
        rate={input.rate}
        discountGate={pos.gates.applyDiscounts}
        payGate={payGate}
        orderNumber={tables.bill?.orders.map((o) => o.order_number).filter(Boolean).join(", ") || null}
        dineIn={
          selected
            ? { tableName: selected.name, seats: selected.seats, orderCount: tables.bill?.orders.length ?? 0 }
            : null
        }
        onAccount={
          pos.gates.takeOnAccount.allowed && input.online
            ? {
                enabled: true,
                customer: customerPicker.selected,
                search: customerPicker.searchProps,
                onClearCustomer: customerPicker.clearSelection,
                onConfirmAccount: (v) => void confirmTableOnAccount(v),
              }
            : undefined
        }
        error={payError}
        onCancel={() => setPayOpen(false)}
        onConfirm={(i) => void confirmPay(i)}
      />

      <MoveTableDialog
        open={opDialog === "move"}
        table={selected}
        tables={tables.map.tables}
        busy={opBusy}
        gate={opGates.move}
        error={opError}
        onCancel={() => setOpDialog(null)}
        onConfirm={confirmMove}
      />

      <CloseTableDialog
        open={opDialog === "close"}
        table={selected}
        busy={opBusy}
        gate={opGates.close}
        error={opError}
        onCancel={() => setOpDialog(null)}
        onConfirm={confirmClose}
      />

      <ClearTableDialog
        open={opDialog === "clear"}
        table={selected}
        currency={input.currency}
        busy={opBusy}
        gate={opGates.clear}
        error={opError}
        onCancel={() => setOpDialog(null)}
        onConfirm={confirmClear}
      />

      <SeatCountDialog
        open={seatOpen}
        table={manualOpen ? null : selected}
        busy={busy}
        gate={openGate}
        error={openError}
        namable={manualOpen}
        // The first table a branch opens is almost always "1"; offering it saves
        // a keystroke without preventing "Terrace".
        defaultName={manualOpen ? String(tables.map.tables.length + 1) : ""}
        onCancel={() => {
          setSeatOpen(false);
          setManualOpen(false);
        }}
        onConfirm={(seats, name) => void confirmOpen(seats, name)}
      />

      {/* An unsent round is never thrown away by a keystroke. Keeping it is the
          default action, because the expensive mistake is losing a round the
          cashier already read out to a table. */}
      <Modal
        open={leaveConfirm}
        title="This round has not been sent"
        subtitle={`${roundLines.length} line${roundLines.length === 1 ? "" : "s"} are still waiting to go to the kitchen.`}
        size="sm"
        onClose={() => setLeaveConfirm(false)}
        footer={
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" size="lg" onClick={() => setLeaveConfirm(false)}>
              Stay here
            </Button>
            <Button variant="ghost" size="lg" onClick={discardRound}>
              Discard round
            </Button>
            <Button size="lg" onClick={leaveKeepingRound}>
              Keep it for later
            </Button>
          </div>
        }
      >
        <p className="text-sm text-sub">
          Keeping the round leaves it buffered for {selected?.name ?? "this table"}; you can come back and send it.
          Discarding removes it - nothing was sent to the kitchen either way.
        </p>
      </Modal>
    </>
  );

  return {
    view,
    work,
    bill,
    roundPanel,
    dialogs,
    hasUnsentRound,
    requestLeaveAddItems,
    payGate,
    requestPay,
    summary: {
      itemCount: tables.bill?.orders.reduce((s, o) => s + o.lines.length, 0) ?? 0,
      subtotal: tables.bill?.total ?? 0,
    },
    selected,
  };
}
