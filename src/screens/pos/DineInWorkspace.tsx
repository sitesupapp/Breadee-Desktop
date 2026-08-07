// Dine-In workspace (Level 2A - table foundation).
//
// This is a HOOK, not a second shell. Takeaway and Dine-in render into the same
// `PosShell` with the same status bar, layout resolver and drawer machinery; all
// this contributes is the work region (table map), the right panel (server bill)
// and its dialogs.
//
// What it deliberately does NOT do: submit an order, add a round, pay, move,
// close or clear. None of those RPCs are reachable from here - `pos_move_table`,
// `pos_close_table`, `pos_clear_table` and `pos_pay_table` are not even in the
// `PosRpcName` union yet.

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
import { selectSubtotal, useCart } from "@/state/cart";
import { isMapStale, selectedTable as pickSelected, useTables } from "@/state/tables";
import type { PosContext } from "@/state/pos";
import type { LayoutSpec } from "@/lib/layout";
import type { Gate } from "@/components/ui";
import type { CurrencyCode } from "@/lib/currency";
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
}): DineInWorkspace {
  const { pos, hasOpenShift, active } = input;
  const toast = useToast();
  const tables = useTables();
  const cart = useCart();

  const [query, setQuery] = useState("");
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [seatOpen, setSeatOpen] = useState(false);
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
    async (seats: number | null) => {
      if (inFlight.current || !selected) return;
      if (!openGate.allowed) return;
      inFlight.current = true;
      setBusy(true);
      setOpenError(null);
      try {
        const result = await openTable({ branchId: ctx.branchId, name: selected.name, seats });
        setSeatOpen(false);
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

      setBillChange(describeBillChange(before, useTables.getState().bill));
      const { message, detail } = roundOutcomeMessage(outcome.result);
      toast.push({ tone: outcome.result.idempotent ? "info" : "success", message, detail });
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
      />
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selected, tables.bill, tables.billLoading, tables.billError, openGate, addItemsGate, hasOpenShift, enterAddItems, opGates, requestOp],
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
        table={selected}
        busy={busy}
        gate={openGate}
        error={openError}
        onCancel={() => setSeatOpen(false)}
        onConfirm={(seats) => void confirmOpen(seats)}
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
    summary: {
      itemCount: tables.bill?.orders.reduce((s, o) => s + o.lines.length, 0) ?? 0,
      subtotal: tables.bill?.total ?? 0,
    },
    selected,
  };
}
