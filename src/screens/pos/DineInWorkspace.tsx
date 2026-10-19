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
import { loadAutoSeatDirectOpen, readCachedAutoSeat } from "@/lib/pos/autoSeat";
import { classifyError } from "@/lib/pos/errors";
import { canClearTable, canCloseTable, canEditOrders, canManageFloor, canMergeTables, canMoveTable, canOpenTable, canSplitBill, canViewFloor } from "@/lib/pos/access";
import { buildChangeModifiersPayload, buildSetQuantityPayload, editOrderLine } from "@/lib/pos/orders";
import { modifierChangeRemovesComponents } from "@/lib/pos/editReason";
import { autoPrintReductionReceipt } from "@/lib/pos/autoPrintRun";
import { buildReductionReceipt } from "@/lib/pos/reductionReceipt";
import { SplitBillPanel } from "@/components/pos/SplitBillPanel";
import {
  buildSplitSettlePayload,
  loadSplitState,
  loadSplitPaymentMethods,
  settleSplit,
  type SplitState,
  type SplitPaymentMethod,
  type SplitAllocationInput,
} from "@/lib/pos/split";
import { useActivePaymentMethods } from "@/lib/pos/useActivePaymentMethods";
import { ModifierDialog } from "@/components/pos/ModifierDialog";
import { EditReasonDialog } from "@/components/pos/EditReasonDialog";
import { groupsForItem } from "@/lib/pos/modifiers";
import type { ItemOptionsResult } from "@/lib/pos/itemOptions";
import type { MenuItem, ModifierOption } from "@/types/pos";
import { ServiceFloor } from "@/components/pos/floor/ServiceFloor";
import { FloorDesigner } from "@/components/pos/floor/designer/FloorDesigner";
import { MapListToggle, type DineInFloorView } from "@/components/pos/floor/MapListToggle";
import { Glyph } from "@/components/Glyph";
import { readPosFeatures, writePosFeatures } from "@/lib/pos/posFeatures";
import { ClearTableDialog, CloseTableDialog, MergeTablesDialog, MoveTableDialog } from "@/components/pos/TableOpsDialogs";
import {
  buildMergeExpected,
  clearOutcomeMessage,
  clearTable,
  closeOutcomeMessage,
  closeTable,
  mergeableSources,
  mergeAttemptSignature,
  mergeTables,
  moveOutcomeMessage,
  moveTable,
  stableMergeOpId,
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
import { billIsCleared, buildTablePaymentReceipt, buildTableOnAccountReceipt, buildTableBillReceipt } from "@/lib/pos/tablePaymentCompletion";
import {
  completeTableOnAccount,
  createOnAccountLatch,
  performOnAccount,
  type OnAccountVerdict,
} from "@/lib/pos/onAccount";
import { useCustomerPicker } from "@/state/customerPicker";
import { useShift } from "@/state/shift";
import { CustomerConflictDialog } from "@/components/pos/CustomerConflictDialog";
import { paymentBlockedReason, type PaymentMethod } from "@/lib/pos/payments";
import { selectSubtotal, useCart } from "@/state/cart";
import { isMapStale, selectedTable as pickSelected, useTables } from "@/state/tables";
import { useFloor } from "@/state/floor";
import {
  type DineinScope,
  openTableOffline,
  addDraftLine,
  sendRoundOffline,
  draftLineFromCart,
  getDineDraftForTable,
  setRoundPrintState,
  settleTableOffline,
  tableOnAccountOffline,
  splitOperationalBillOffline,
  type CanonicalTableTarget,
} from "@/lib/offline/dineinOffline";
import {
  editTargetFor,
  getOperationalTableBill,
  getOperationalTableTotals,
  overlayTableTotals,
  type OperationalTableBill,
} from "@/lib/offline/operationalProjection";
import { captureEditOrderLineOffline } from "@/lib/offline/itemEditOffline";
import type { PosContext } from "@/state/pos";
import type { LayoutSpec } from "@/lib/layout";
import type { Gate } from "@/components/ui";
import { formatMoney, type CurrencyCode } from "@/lib/currency";
import type { DiscountType } from "@/lib/pos/discounts";
import type { ReceiptData } from "@/lib/receipt";
import type { CartLine } from "@/types/pos";
import type { BillLine, BillOrder, TableBill, TableSummary } from "@/types/tables";

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
  /** Phase C — backend unreachable AND the device is hydrated for offline Dine-In. When
   *  true (and online is false), open/add/send route into the local Track-C engine. */
  offlineReady?: boolean;
  /** Human-readable list of what is missing when offline and NOT ready (for the UI reason). */
  offlineReadyMissing?: string[];
  /** The ONE immutable offline scope built by PosWorkspace — MUST equal the drain scope
   *  (tenant+branch/OU+cashier+device+terminal) so captured ops replay in this session. */
  offlineScope?: DineinScope;
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
   * MANUAL receipt presentation, for the "print the bill before payment" action.
   *
   * Distinct from `onPresentReceipt` on purpose: that one is the settlement
   * funnel and may auto-print, which is correct for a paid receipt. Printing an
   * UNPAID bill must go to the manual preview layer (the same one takeaway's
   * saved-order Print and the Orders modal use) so it never routes a paid-style
   * document and never touches the automatic path. Wired to `receiptStore.present`.
   */
  onPreviewReceipt: (receipt: ReceiptData) => void;
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

  // Service Floor Map (Phase 2). Gated on `pos.floor_map`; when off, the Map|List
  // control never renders and Dine-in is exactly today's List. The preferred view
  // is a per-terminal switch (like every other `posFeatures` field), defaulting to
  // List. Losing entitlement (a context change) can never strand the operator on
  // a Map they may no longer see.
  const floorGate = useMemo(() => canViewFloor(pos.access), [pos.access]);
  // Floor DESIGNER (Phase 3A). A distinct authority from viewing the Map: editing
  // needs `pos.tables.floor_manage`. The overlay is launched from the Map and owns
  // its own lease/draft; the Dine-In flows behind it are untouched.
  const floorManageGate = useMemo(() => canManageFloor(pos.access), [pos.access]);
  const [editingFloor, setEditingFloor] = useState(false);
  const [floorView, setFloorViewState] = useState<DineInFloorView>(() =>
    canViewFloor(pos.access).allowed && readPosFeatures().preferFloorView ? "floor" : "list",
  );
  const setFloorView = useCallback((next: DineInFloorView) => {
    setFloorViewState(next);
    const current = readPosFeatures();
    writePosFeatures({ ...current, preferFloorView: next === "floor" });
  }, []);
  useEffect(() => {
    if (!floorGate.allowed && floorView === "floor") setFloorViewState("list");
  }, [floorGate.allowed, floorView]);
  // Leave the designer if the operator loses edit permission or Dine-in is no
  // longer the active mode — a full-screen overlay must never sit over a screen it
  // no longer belongs to.
  useEffect(() => {
    if (editingFloor && (!floorManageGate.allowed || !active)) setEditingFloor(false);
  }, [editingFloor, floorManageGate.allowed, active]);
  const [seatOpen, setSeatOpen] = useState(false);
  /**
   * The open dialog is naming a NEW table rather than opening a mapped one.
   *
   * Only reachable when the branch has no configured tables, which is the one
   * case `pos_open_table` accepts free text in.
   */
  const [manualOpen, setManualOpen] = useState(false);
  // Phase F — Auto-Seat. Start from the last synchronized value (offline-safe) so the
  // very first tap is correct, then refresh from the canonical settings row when online.
  const [autoSeat, setAutoSeat] = useState<boolean>(() => readCachedAutoSeat(pos.branch.id));
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
  // Holds the client_op_id for the CURRENT merge attempt (keyed by its target set),
  // so a transport retry of the same merge reuses the id and the server dedupes
  // rather than merging twice. Reset to null once an attempt resolves successfully.
  const mergeOpId = useRef<{ sig: string; id: string } | null>(null);

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
  // Normal full-bill checkout methods: the Phase B catalog Split already uses,
  // Cash-only when offline. Fed to PaymentDialog so Pay Full Bill shows the
  // tenant's active methods instead of Cash-only.
  const activePaymentMethods = useActivePaymentMethods(pos.tenantId, input.online);
  // On-account is reachable online, OR offline when the device is hydrated for Dine-In (the
  // customer picker then uses the offline-aware cached-customer adapters). (offlineCapture is
  // declared below beside the payment gate; its predicate is inlined here as it is input-only.)
  const onAccountReachable =
    payOpen && pos.gates.takeOnAccount.allowed && (input.online || (input.offlineReady === true && input.offlineScope != null));
  const customerPicker = useCustomerPicker({
    access: pos.access,
    branchId: pos.branch.id,
    online: input.online,
    enabled: onAccountReachable,
    offlineReady: input.offlineReady === true && input.offlineScope != null,
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

  // rc.9 — ONE operational projection. Offline, every table row (Map card, List card, sidebar header,
  // payment identity) carries the operational total from lib/offline/operationalProjection, the SAME
  // projection the bill panel / Add Items / payment / split / print read — so the card can never show a
  // different total from the detail (the rc.8 Table-1 1,800,000 vs 5,455,000 split-brain). `projRev`
  // bumps after every local mutation (round / edit / split / settle) so all surfaces re-derive at once.
  const offlineProjOn = !input.online && input.offlineReady === true && input.offlineScope != null;
  const [projRev, setProjRev] = useState(0);
  const bumpProj = useCallback(() => setProjRev((r) => r + 1), []);
  const [opTotals, setOpTotals] = useState<Map<string, { total: number | null; currency: CurrencyCode | null; orders: number; pending: boolean }>>(new Map());
  useEffect(() => {
    let live = true;
    if (!offlineProjOn || !input.offlineScope) {
      setOpTotals(new Map());
      return;
    }
    void getOperationalTableTotals(input.offlineScope, tables.map.tables)
      .then((m) => {
        if (live) setOpTotals(m);
      })
      .catch(() => {
        if (live) setOpTotals(new Map());
      });
    return () => {
      live = false;
    };
  }, [offlineProjOn, input.offlineScope, tables.map.tables, projRev]);
  const displayMap = useMemo(
    () => (offlineProjOn && opTotals.size > 0 ? { ...tables.map, tables: overlayTableTotals(tables.map.tables, opTotals) } : tables.map),
    [offlineProjOn, opTotals, tables.map],
  );

  const selected = pickSelected({ map: displayMap, selectedTableId: tables.selectedTableId });
  const visible = useMemo(() => filterTables(displayMap.tables, query), [displayMap.tables, query]);
  const stale = isMapStale(tables.lastLoadedAt, now);

  const openGate: Gate = useMemo(() => {
    const base = canOpenTable(pos.access, hasOpenShift);
    if (!base.allowed) return base;
    if (!selected) return { allowed: false, reason: "Select a table first." };
    if (!isOpenable(selected)) return { allowed: false, reason: "This table already has an open bill." };
    // Phase C: offline open routes into the local Track-C engine (durable op + dineDraft),
    // but ONLY when the device is hydrated for offline Dine-In. Otherwise block with a clear
    // readiness reason rather than letting a click surface "Failed to fetch".
    if (!input.online) {
      if (input.offlineReady && input.offlineScope) return { allowed: true, reason: null };
      return {
        allowed: false,
        reason: input.offlineReadyMissing && input.offlineReadyMissing.length
          ? `Offline — this device isn't ready for Dine-In (${input.offlineReadyMissing.join(", ")}).`
          : "Opening a table needs a connection.",
      };
    }
    return { allowed: true, reason: null };
  }, [pos.access, hasOpenShift, selected, input.online, input.offlineReady, input.offlineReadyMissing, input.offlineScope]);

  // Level 2C gates. Each combines the permission-map answer with the desktop's
  // own preconditions (shift, connection, an actual bill to act on).
  const opGates = useMemo(() => {
    // rc.12 — Move and Merge are SERVER-COORDINATED (online only), like Close/Clear. The server re-homes
    // the bill (orders, rounds, payments, version) atomically under the shift lock; offline the device
    // cannot predict that result (merged order/item ids, partial-payment re-allocation), so rc.4–rc.11's
    // offline capture showed nothing on the floor and was refused at replay (F3/F4). Offline the gate says
    // so explicitly — never a button that silently does nothing.
    const common = { table: selected, hasOpenShift, online: input.online, offlineCapable: false };
    // Permission first (an unpermitted operator is told that, online or not), then connectivity.
    const serverCoordinated = (permitted: Gate, kind: "move" | "merge", what: string, verb: string): Gate =>
      permitted.allowed && !input.online
        ? { allowed: false, reason: `${what} needs a connection — the server moves the whole bill (rounds, payments, balance) in one step. Reconnect to ${verb}.` }
        : tableOpGate({ kind, permitted, ...common });
    return {
      move: serverCoordinated(canMoveTable(pos.access), "move", "Moving a table", "move it"),
      close: tableOpGate({ kind: "close", permitted: canCloseTable(pos.access), ...common }),
      clear: tableOpGate({ kind: "clear", permitted: canClearTable(pos.access), ...common }),
      merge: serverCoordinated(canMergeTables(pos.access), "merge", "Merging tables", "merge them"),
    };
  }, [pos.access, selected, hasOpenShift, input.online]);

  // Phase C/D — offline capture is live when the backend is unreachable AND the device is
  // hydrated for offline Dine-In. Declared HERE (above the payment gate + the provisional bill)
  // so both can read them; the duplicate lower-down declarations were hoisted to this point.
  const offlineCapture = !input.online && input.offlineReady === true && input.offlineScope != null;
  // The PROVISIONAL offline bill for the selected table (derived from its local draft's sent
  // rounds). Populated by the effect further down; read by the payment gate so an offline table
  // with sent rounds can be settled.
  const [offlineBill, setOfflineBill] = useState<TableBill | null>(null);
  /** rc.9 — the selected table's full operational projection (edit targets, outstanding, settle state). */
  const [offlineProj, setOfflineProj] = useState<OperationalTableBill | null>(null);
  /** The bill the settle path acts on: the local provisional bill when capturing offline, else
   *  the authoritative server bill. */
  const settleBill = offlineCapture ? offlineBill : tables.bill;

  /**
   * THE payment gate. Computed once, here, and handed to every surface that can
   * start a payment. Nothing downstream re-derives "can pay" from its own parts.
   *
   * `pos.apply_discounts` is deliberately NOT part of it: a cashier without that
   * permission may still settle a bill at full price. Discount permission is
   * enforced only when a discount is actually entered.
   *
   * Phase D: offline, connectivity is treated as satisfied for the gate ONLY when offline
   * capture is live AND a local provisional bill (sent rounds) exists; the settle then CAPTURES
   * a pay_table op instead of charging the server. Online behaviour is unchanged.
   */
  const payGate: Gate = useMemo(() => {
    const g = payTableGate({
      takePayments: pos.gates.takePayments,
      table: selected,
      bill: settleBill,
      hasOpenShift,
      online: input.online || (offlineCapture && settleBill != null && settleBill.orders.length > 0),
      settling: paying,
      branchId: pos.branch.id,
    });
    // rc.10 — a bill settled offline is CLOSED locally (it leaves the active projection), so payTableGate
    // already refuses a second settle of it ("no open bill"); a NEW bill on the reused table is payable.
    return g;
  }, [pos.gates.takePayments, pos.branch.id, selected, settleBill, hasOpenShift, input.online, offlineCapture, paying]);

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
    async (kind: TableOpKind, run: () => Promise<string>, options?: { selectAfter?: string | null; offline?: boolean }) => {
      if (opInFlight.current) return;
      opInFlight.current = true;
      setOpBusy(true);
      setOpError(null);
      try {
        const message = await run();
        setOpDialog(null);
        // OFFLINE: the restructure was durably CAPTURED (not applied on a server), so there is no
        // authoritative floor to re-read — it reconciles on sync. Skip the server refresh/select.
        if (options?.offline) {
          toast.push({ tone: "info", message, detail: null });
          return;
        }
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
      // rc.12 — server-coordinated only (the gate refuses offline with the reason); see opGates.
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

  // Phase 4 (1.0.31) + v3 (1.0.36) — fold other occupied tables' bills into this one.
  // The server locks and re-checks every table and order under the transaction and
  // enforces all eligibility. Two client-side guards ride along:
  //   • `expected` — the primary's and every selected source's pos_entity_version
  //     from the loaded map (migration 20261013200551), so a floor that changed since
  //     the dialog opened is refused with VERSION_CONFLICT → the reload-and-retry UX.
  //   • a STABLE client_op_id held across retries of the SAME target set, so a lost
  //     response replays rather than merging twice.
  const confirmMerge = useCallback(
    (sourceTableIds: string[]) => {
      if (!selected || !opGates.merge.allowed || sourceTableIds.length === 0) return;
      const primaryName = selected.name;
      // rc.11 — the SAME projected rows the picker offered (a bill settled locally is not a source).
      const sources = sourceTableIds
        .map((id) => displayMap.tables.find((t) => t.id === id))
        .filter((t): t is TableSummary => t != null);
      const expected = buildMergeExpected(selected, sources);
      const sig = mergeAttemptSignature(selected.id, sourceTableIds);
      // rc.12 — server-coordinated only (the gate refuses offline with the reason). The rc.4–rc.11
      // offline capture sent this signature ("a|b") as client_op_id → 22P02 at replay.
      mergeOpId.current = stableMergeOpId(mergeOpId.current, sig);
      const clientOpId = mergeOpId.current.id;
      void runOp("merge", async () => {
        const r = await mergeTables({
          primaryTableId: selected.id,
          sourceTableIds,
          expected,
          clientOpId,
        });
        // Attempt resolved — a later merge of the same tables mints a fresh id.
        mergeOpId.current = null;
        return `Merged ${r.sources_merged} table${r.sources_merged === 1 ? "" : "s"} into ${primaryName}.`;
      });
    },
    [selected, opGates.merge.allowed, displayMap.tables, runOp],
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
        // PHASE C — OFFLINE branch. When the backend is unreachable and the device is
        // ready, capture the open durably into the local engine (no backend call). The
        // online branch below is unchanged.
        if (!input.online && input.offlineReady && input.offlineScope) {
          const localTableId = selected?.id ?? name; // canonical id for a mapped tap; name for an ad-hoc open
          const existing = await getDineDraftForTable(input.offlineScope, localTableId);
          if (!existing) {
            // rc.10 — reusing a table whose bill was settled offline: the NEW session's open replays
            // after that settle (never joins the paid bill; never trips its own CAS).
            const raw = selected ? (tables.map.tables.find((t) => t.id === selected.id) ?? selected) : null;
            const proj = raw ? await getOperationalTableBill(input.offlineScope, raw) : null;
            await openTableOffline({
              scope: input.offlineScope,
              tableId: localTableId,
              tableName: selected?.name ?? name,
              seats,
              currency: input.currency,
              baseOrderVersion: raw?.pos_entity_version ?? null,
              afterSettleOpId: proj?.settlingOpId ?? null,
            });
          }
          setSeatOpen(false);
          setManualOpen(false);
          await tables.refresh(ctx);
          if (selected?.id) await tables.select(selected.id, ctx);
          setFocusedId(selected?.id ?? null);
          toast.push({ tone: "success", message: `${selected?.name ?? name} opened offline`, detail: "Saved on this device — it will sync when you reconnect." });
          return;
        }
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
    [selected, openGate.allowed, ctx, toast, input.online, input.offlineReady, input.offlineScope, input.currency, tables.map],
  );

  // Phase F — refresh the branch's auto-seat setting from the canonical row when
  // online; offline keeps the last synchronized value already in state. Never blocks.
  useEffect(() => {
    if (!input.online) return;
    let live = true;
    void loadAutoSeatDirectOpen(pos.tenantId, pos.branch.id).then((v) => {
      if (live) setAutoSeat(v);
    });
    return () => {
      live = false;
    };
  }, [input.online, pos.tenantId, pos.branch.id]);

  // Opening the SELECTED free table. Auto-seat SKIPS the seat prompt only when the
  // setting is ON and the table carries a published seat count (pos_tables.seats);
  // otherwise the existing seat modal appears — never a dead end, never an invented count.
  const requestOpenSelected = useCallback(() => {
    if (!openGate.allowed) return;
    setOpenError(null);
    if (autoSeat && selected && (selected.seats ?? 0) > 0) {
      void confirmOpen(selected.seats);
      return;
    }
    setManualOpen(false);
    setSeatOpen(true);
  }, [openGate.allowed, autoSeat, selected, confirmOpen]);

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

  // Phase C — offline capture is live when the backend is unreachable AND the device is
  // hydrated for offline Dine-In. The round GATES then treat connectivity as satisfied
  // (so add/send are allowed), while the HANDLERS below still branch on the real
  // input.online to route into the local engine rather than the server.
  const gateCtx: RoundContext = useMemo(
    () => (offlineCapture ? { ...roundCtx, online: true } : roundCtx),
    [offlineCapture, roundCtx],
  );

  const addItemsGate: Gate = useMemo(() => {
    const base = computeAddItemsGate({ ctx: gateCtx, createOrders: input.createOrders });
    if (!base.allowed) return base;
    // The buffer is shared with Takeaway on purpose (one cart, one round at a
    // time). If someone else's work is in it, say whose rather than merging.
    // rc.10 — a takeaway buffer that is already durably saved (sent offline / submitted) is NOT a lock:
    // claim() releases it (the order stays in the offline queue / shift orders).
    const durablySaved = cart.durable || cart.savedOrder != null;
    if (input.cartLines.length > 0 && cart.owner?.kind === "takeaway" && !durablySaved) {
      return { allowed: false, reason: "Finish or clear the takeaway order first - the cart is in use." };
    }
    if (input.cartLines.length > 0 && cart.owner?.kind === "delivery" && !durablySaved) {
      return { allowed: false, reason: "A delivery basket is still open. Send or clear it in Delivery first." };
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
  }, [gateCtx, input.createOrders, input.cartLines.length, cart.owner, cart.durable, cart.savedOrder, selected]);

  const submitGate: Gate = useMemo(
    () =>
      submitRoundGate({
        ctx: gateCtx,
        lines: roundLines,
        createOrders: input.createOrders,
        menu: input.menu,
      }),
    [gateCtx, roundLines, input.createOrders, input.menu],
  );

  // Phase C — populate the PROVISIONAL offline bill for the selected table, derived from its
  // local draft (sent rounds). Used only when offlineCapture is live; the online store's bill
  // remains authoritative otherwise. Recomputed when the selection or a capture settles.
  // (The `offlineBill` state is declared above, beside the payment gate that reads it.)
  useEffect(() => {
    let live = true;
    if (!offlineCapture || !selected || !input.offlineScope) {
      setOfflineBill(null);
      setOfflineProj(null);
      return;
    }
    // rc.9 — THE operational projection (cached canonical bill → local rounds → item edits → split /
    // settle legs), not the draft alone: the sidebar, Add Items, payment, split and print all read it.
    // The RAW cached map row (never the overlaid one — its total already includes the local delta).
    const raw = tables.map.tables.find((t) => t.id === selected.id) ?? selected;
    void getOperationalTableBill(input.offlineScope, raw)
      .then((p) => {
        if (!live) return;
        setOfflineProj(p);
        setOfflineBill(p.bill.orders.length > 0 ? p.bill : null);
      })
      .catch(() => {
        if (live) {
          setOfflineBill(null);
          setOfflineProj(null);
        }
      });
    return () => {
      live = false;
    };
    // roundBusy/busy toggle false after an offline open/send, projRev after any other local
    // mutation → re-derive the ONE projection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offlineCapture, selected?.id, input.offlineScope, roundBusy, busy, projRev, tables.map]);

  // rc.10 — CART-LOCK LIFECYCLE: once a table's bill is SETTLED locally, any unsent round still
  // buffered for that table belonged to the closed bill's context — release it, so the reused table
  // starts clean and no other context sees "The cart is in use". (Kept out of the payment path itself,
  // which never touches the cart buffer.)
  useEffect(() => {
    if (offlineProj?.settledLocally) useCart.getState().releaseIfOwner({ kind: "table", tableId: offlineProj.tableId });
  }, [offlineProj]);

  /**
   * Enter Add Items. The bill is RE-READ first: the operator is about to build a
   * round against what they can see, so what they see must be current.
   */
  const enterAddItems = useCallback(async () => {
    if (!selected || !addItemsGate.allowed) return;
    if (!cart.claim({ kind: "table", tableId: selected.id })) return;
    setBillChange(null);
    // Offline: no server bill re-read (the local draft is the source); online unchanged.
    if (!offlineCapture) {
      const before = useTables.getState().bill;
      await tables.loadBill(ctx);
      setBillChange(describeBillChange(before, useTables.getState().bill));
    }
    setView("add_items");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, addItemsGate.allowed, ctx, offlineCapture]);

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
      // PHASE C — OFFLINE branch. Freeze the current cart into a local round through the
      // Track-C engine (durable op + draft), print locally, then clear the cart ONLY after
      // the durable capture succeeded. The online branch below is unchanged.
      if (offlineCapture && input.offlineScope) {
        const submitted = useCart.getState().lines;
        let draft = await getDineDraftForTable(input.offlineScope, selected.id);
        if (!draft) {
          // rc.9 — an OCCUPIED table with a cached canonical bill: bind this local session to that open
          // order (round 1 pins expected_order_id; the open op adopts the occupied table), so the rounds
          // append to the SAME bill and the projection merges them — never a second bill.
          // Re-derive the ONE projection at send time (never a stale panel copy).
          const raw = tables.map.tables.find((t) => t.id === selected.id) ?? selected;
          const proj = await getOperationalTableBill(input.offlineScope, raw);
          const canonicalOrderId =
            proj.bill.orders.length > 0 && !proj.summaryOnly
              ? (proj.orders.find((o) => o.orderId && !o.orderLocal)?.orderId ?? null)
              : null;
          draft = await openTableOffline({
            scope: input.offlineScope,
            tableId: selected.id,
            tableName: selected.name,
            seats: selected.seats ?? null,
            currency: proj.currency ?? input.currency,
            baseOrderVersion: raw.pos_entity_version ?? null,
            canonicalOrderId,
            // rc.10 — a table reused after a local settle: the new bill's open replays after it.
            afterSettleOpId: canonicalOrderId ? null : proj.settlingOpId,
          });
        }
        for (const l of submitted) await addDraftLine(draft.local_session_id, draftLineFromCart(l));
        // durable capture (atomic). rc.12 — the CURRENT shift lets a pre-rc.12 session (no shift ref) be
        // attached only when provably its own; otherwise a new order is refused, never sent shift-less.
        const liveShift = useShift.getState().shift;
        const updated = await sendRoundOffline(draft.local_session_id, {
          currentShift: liveShift && input.shiftId === liveShift.id ? { id: liveShift.id, openedAt: liveShift.opened_at ?? null } : null,
        });
        const round = updated.rounds[updated.rounds.length - 1];
        // Local kitchen print — independent of server sync; failure never reverses the round.
        try {
          await input.onKitchenBatch({
            source: "dine_in",
            orderId: updated.canonical_order_id ?? draft.local_session_id,
            orderNumber: round ? `Round ${round.seq}` : "OFFLINE",
            batchNo: round?.seq ?? null,
            tableName: selected.name,
            lines: submitted.map((l) => ({
              name: l.name,
              qty: l.quantity,
              modifiers: l.modifiers.map((m) => ({ name: m.name, quantity: m.quantity })),
              note: l.kitchen_note,
              menuItemId: l.menu_item_id,
            })),
          });
          if (round) await setRoundPrintState(updated.local_session_id, round.round_local_id, "printed");
        } catch {
          if (round) await setRoundPrintState(updated.local_session_id, round.round_local_id, "print_failed");
        }
        useCart.getState().reset(); // clear ONLY after the durable capture succeeded
        bumpProj();
        toast.push({ tone: "success", message: "Round sent (offline)", detail: "Saved on this device — it will sync when you reconnect." });
        return;
      }
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
  }, [selected, submitGate.allowed, roundCtx, ctx, input.menu, toast, offlineCapture, input.offlineScope, input.currency, input.onKitchenBatch, tables.map, bumpProj]);

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
   * rc.9 — the offline settle / on-account TARGET for a table, from the ONE operational projection:
   * the local session (when one exists) and/or the canonical table bill (a table occupied online, now
   * settled offline without any offline round), plus EVERY still-unsynced mutation of the bill as a
   * dependency so the settle replays only after them — the server never charges a pre-edit total.
   * A bill with a captured or server-held part-payment is not full-settled offline (settle the
   * remaining items with Split) — the paid-item wall; the server stays the payment authority.
   */
  const offlineSettleTarget = useCallback(
    async (table: TableSummary): Promise<
      | { ok: true; sessionId: string | null; table: CanonicalTableTarget | undefined; deps: string[]; covers: { orderIds: string[]; summary: boolean } }
      | { ok: false; reason: string }
    > => {
      if (!input.offlineScope) return { ok: false, reason: "This table isn't available offline. Reconnect to settle it." };
      const raw = tables.map.tables.find((t) => t.id === table.id) ?? table;
      const p = await getOperationalTableBill(input.offlineScope, raw);
      // rc.10 — a bill already settled offline is CLOSED locally (absent from the projection), so a
      // second settle of it is impossible here; only the table's CURRENT active bill can be settled.
      if (p.bill.orders.length === 0) return { ok: false, reason: "This table has no open bill to settle." };
      if (p.paidPending > 0 || p.collected > 0) {
        return { ok: false, reason: "Part of this bill is already paid. Settle the remaining items with Split, or reconnect." };
      }
      const draft = await getDineDraftForTable(input.offlineScope, table.id);
      const canonicalIds = p.orders.filter((o) => o.orderLocal == null).map((o) => o.orderId).filter((x): x is string => typeof x === "string" && x !== "");
      const hasCanonical = p.summaryOnly || canonicalIds.length > 0;
      return {
        ok: true,
        // The table's open local session (even one with no round yet) is settled WITH the bill, so a
        // stale empty session can never capture the next order's rounds into the paid bill.
        sessionId: draft && (draft.rounds.length > 0 || hasCanonical) ? draft.local_session_id : null,
        // A canonical bill (cached or summary) with no offline round still settles by its table id.
        table: hasCanonical
          ? { scope: input.offlineScope, tableId: table.id, tableName: table.name, currency: p.currency ?? input.currency, orderIds: canonicalIds }
          : undefined,
        deps: p.mutationOpIds,
        // EXACTLY the bill on screen — the projection closes this and nothing else.
        covers: { orderIds: canonicalIds, summary: p.summaryOnly },
      };
    },
    [input.offlineScope, input.currency, tables.map],
  );

  // --- Phase D: edit an already-SENT bill line (open, unpaid dine-in only) ----
  // The SERVER owns the delta/kitchen/totals/version; the desktop only shapes the
  // request and re-reads the authoritative bill afterwards. Gated on pos.edit_orders.
  const editSentGate = useMemo(() => canEditOrders(pos.access), [pos.access]);
  const [editingLineId, setEditingLineId] = useState<string | null>(null);

  // --- Phase E: Split Bill (item/quantity settlement) ------------------------
  // A split is a SETTLEMENT, never a new sale. The server (pos_split_settle) owns
  // every figure; this screen re-reads pos_split_state after each split. Gated on
  // pos.split_bill. VERSION_CONFLICT and every other error re-read the bill.
  const splitGate = useMemo(() => canSplitBill(pos.access), [pos.access]);
  const [splitOpen, setSplitOpen] = useState(false);
  const [splitState, setSplitState] = useState<SplitState | null>(null);
  const [splitMethods, setSplitMethods] = useState<SplitPaymentMethod[]>([]);
  const [splitLoading, setSplitLoading] = useState(false);
  const [splitBusy, setSplitBusy] = useState(false);
  const [splitError, setSplitError] = useState<string | null>(null);
  const [splitLastPaid, setSplitLastPaid] = useState<{ display_no: string; amount: number; method: string } | null>(null);

  /** rc.9 — Build a SplitState the existing panel renders, from the OPERATIONAL projection (cached
   *  canonical lines + locally-sent round lines, each with its captured price incl. modifiers, minus
   *  quantities already in captured legs). Line ids are the projection's (canonical order_item id or the
   *  local line id); paySplit maps each back to {order_item_id} | {line_local} on capture. Returns a
   *  controlled reason when the bill cannot be split offline (summary-only lines, several bills, a
   *  part-payment already held by the server — the paid-item wall). */
  const projectionSplit = useCallback(
    (p: OperationalTableBill, tableName: string): { ok: true; state: SplitState } | { ok: false; reason: string } => {
      if (p.summaryOnly) return { ok: false, reason: "Part of this bill was sent before this device went offline. Reconnect to split it." };
      const withLines = p.orders.filter((o) => p.bill.orders.some((b) => b.id === o.key && b.lines.length > 0));
      if (withLines.length !== 1) return { ok: false, reason: "This table has more than one open bill. Reconnect to split it." };
      const po = withLines[0];
      if (po.partiallyPaid) return { ok: false, reason: "Part of this bill was already paid online. Reconnect to split it." };
      const order = p.bill.orders.find((b) => b.id === po.key) as BillOrder;
      const lines = order.lines.filter((l) => {
        const m = p.meta.get(l.id);
        return m && (m.ref.kind === "canonical" || m.ref.kind === "local");
      });
      return {
        ok: true,
        state: {
          order_id: po.key,
          order_number: order.order_number || tableName,
          status: "sent_to_kitchen",
          payment_status: "unpaid",
          pos_entity_version: 0,
          total_amount: lines.reduce((s, l) => s + l.line_total, 0),
          paid_amount_usd: 0,
          currency: order.currency,
          lines: lines.map((l) => {
            const paid = p.meta.get(l.id)?.paidQty ?? 0;
            return {
              order_item_id: l.id,
              name: l.name,
              quantity: l.quantity,
              final_unit_price: l.final_unit_price,
              line_total: l.line_total,
              kitchen_note: l.kitchen_note,
              allocated_qty: paid,
              available_qty: Math.max(0, l.quantity - paid),
            };
          }),
          settlements: [],
        },
      };
    },
    [],
  );

  const openSplit = useCallback(async () => {
    if (!splitGate.allowed) return;
    setSplitError(null);
    setSplitLastPaid(null);
    setSplitLoading(true);
    setSplitOpen(true);
    try {
      // OFFLINE: split the local dine-in session (fully-offline bill) from its projection; no server
      // call. The existing panel renders it; selection yields local line ids that paySplit maps.
      if (offlineCapture && input.offlineScope && selected) {
        const raw = tables.map.tables.find((t) => t.id === selected.id) ?? selected;
        const p = await getOperationalTableBill(input.offlineScope, raw);
        if (p.bill.orders.length === 0) {
          setSplitError("This table isn't available offline. Reconnect to split it.");
          return;
        }
        const s = projectionSplit(p, selected.name);
        if (!s.ok) {
          setSplitError(s.reason);
          return;
        }
        setSplitState(s.state);
        setSplitMethods(activePaymentMethods);
        return;
      }
      const bill = useTables.getState().bill;
      const order = bill?.orders.find((o) => o.payment_status !== "paid") ?? bill?.orders[0];
      if (!order) return;
      const [state, methods] = await Promise.all([loadSplitState(order.id), loadSplitPaymentMethods(pos.tenantId)]);
      setSplitState(state);
      setSplitMethods(methods);
    } catch (e) {
      setSplitError(classifyError(e).message);
    } finally {
      setSplitLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [splitGate.allowed, pos.tenantId, offlineCapture, input.offlineScope, input.currency, selected, activePaymentMethods, projectionSplit, tables.map]);

  const paySplit = useCallback(
    async (allocations: SplitAllocationInput[], method: string) => {
      const st = splitState;
      if (!st) return;
      setSplitBusy(true);
      setSplitError(null);

      // OFFLINE: CAPTURE a split leg against the local session (no server call). The panel's
      // order_item_id selections ARE local line ids offline; map them to the capture shape.
      if (offlineCapture) {
        try {
          if (!input.offlineScope || !selected) {
            setSplitError("This table isn't available offline. Reconnect to split it.");
            return;
          }
          // Re-derive the projection at confirm time (never act on a stale panel), then map each
          // selected line back to its server identity and validate against the remaining quantity.
          const raw = tables.map.tables.find((t) => t.id === selected.id) ?? selected;
          const p = await getOperationalTableBill(input.offlineScope, raw);
          const po = p.orders.find((o) => o.key === st.order_id);
          if (!po) {
            setSplitError("This bill changed on this device. Reopen Split.");
            return;
          }
          const allocs: { order_item_id?: string | null; line_local?: string | null; quantity: number }[] = [];
          const creators: string[] = [];
          for (const a of allocations) {
            const m = p.meta.get(a.order_item_id);
            const line = p.bill.orders.flatMap((o) => o.lines).find((l) => l.id === a.order_item_id);
            if (!m || !line || (m.ref.kind !== "canonical" && m.ref.kind !== "local")) {
              setSplitError("A selected item can't be split offline yet. Reconnect to split it.");
              return;
            }
            const remaining = Math.max(0, line.quantity - m.paidQty);
            if (Number(a.quantity) > remaining) {
              setSplitError(`Only ${remaining} of "${line.name}" remain to split.`);
              return;
            }
            allocs.push(m.ref.kind === "canonical" ? { order_item_id: m.ref.order_item_id, quantity: a.quantity } : { line_local: m.ref.line_local, quantity: a.quantity });
            if (m.creatorOpId) creators.push(m.creatorOpId);
          }
          const draft = p.sessionId ? await getDineDraftForTable(input.offlineScope, selected.id) : null;
          const sessionDeps = draft ? [draft.open_operation_id, ...draft.rounds.map((r) => r.operation_id)] : [];
          const cap = await splitOperationalBillOffline({
            scope: input.offlineScope,
            orderId: po.orderId,
            orderLocal: po.orderId ? null : po.orderLocal,
            allocations: allocs,
            method,
            currency: p.currency ?? input.currency,
            tableName: selected.name,
            orderNumber: st.order_number,
            // Replay only after the lines it pays for exist (rounds) and every earlier edit of this bill.
            dependencyIds: [...sessionDeps, ...po.bumpOps, ...creators],
          });
          if (!cap.ok) {
            setSplitError(cap.reason);
            return;
          }
          // Re-derive the ONE projection so the panel, sidebar and card all show the leg as
          // settlement-pending-sync (never falsely canonical-paid).
          bumpProj();
          const after = await getOperationalTableBill(input.offlineScope, raw);
          const s = projectionSplit(after, selected.name);
          if (s.ok) setSplitState(s.state);
          setSplitLastPaid({ display_no: `${st.order_number}-offline`, amount: 0, method });
        } catch (e) {
          setSplitError(classifyError(e).message);
        } finally {
          setSplitBusy(false);
        }
        return;
      }

      try {
        const result = await settleSplit(
          buildSplitSettlePayload({
            orderId: st.order_id,
            expectedVersion: st.pos_entity_version,
            method,
            currencyCode: st.currency,
            clientOpId: crypto.randomUUID(),
            allocations,
          }),
        );
        setSplitLastPaid({ display_no: result.display_no, amount: result.amount, method: result.method });
        setSplitState(await loadSplitState(st.order_id));
        await tables.loadBill(ctx);
      } catch (e) {
        setSplitError(classifyError(e).message);
        try {
          setSplitState(await loadSplitState(st.order_id));
          await tables.loadBill(ctx);
        } catch {
          /* keep the original error visible */
        }
      } finally {
        setSplitBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [splitState, tables, ctx, offlineCapture, input.currency, input.offlineScope, selected, projectionSplit, bumpProj],
  );

  // Phase 2: a persisted REMOVAL or REDUCTION needs an audited reason; a plain
  // increase or additive modifier change does not. The prompt holds the pending
  // edit while the reason dialog is open.
  type ReasonPrompt =
    | { kind: "quantity"; line: BillLine; newQuantity: number }
    | { kind: "modifier"; line: BillLine; result: ItemOptionsResult };
  const [reasonPrompt, setReasonPrompt] = useState<ReasonPrompt | null>(null);

  /**
   * rc.9 — OFFLINE edit of a SENT line (qty / remove / modifiers) through the ONE operational
   * projection: resolve the line to an exact replay target (canonical order_item id, a locally-sent
   * round line, or an earlier offline edit's replacement), the version chain (expected_version =
   * snapshot version + this device's unsynced bumps; at replay the predecessor's returned version) and
   * its dependencies, then CAPTURE the SAME pos_edit_order_line payload the online path sends — the
   * server applies it exactly-once (client_op_id) under its row lock + CAS, with the audited reason.
   * A part-paid bill / unknown version / pre-offline summary line → a controlled reconnect reason
   * (the paid-item wall), never a silent no-op (the rc.8 defect: these handlers read the null
   * server bill offline and did nothing).
   */
  const captureSentEditOffline = useCallback(
    async (line: BillLine, build: (orderId: string, expectedVersion: number, clientOpId: string) => Record<string, unknown>, reduction: { previous: number; next: number } | null, reason: string | null) => {
      if (!input.offlineScope || !selected) return;
      const raw = tables.map.tables.find((t) => t.id === selected.id) ?? selected;
      const p = await getOperationalTableBill(input.offlineScope, raw);
      const t = editTargetFor(p, line.id);
      if (!t.ok) {
        toast.push({ tone: "warning", message: t.reason });
        return;
      }
      setEditingLineId(line.id);
      try {
        const clientOpId = crypto.randomUUID();
        const payload = build(t.target.payloadOrderId, t.target.expectedVersion, clientOpId);
        await captureEditOrderLineOffline({
          scope: input.offlineScope,
          orderId: t.target.orderId,
          orderLocal: t.target.orderLocal,
          payload,
          clientOpId,
          chain: { targetRef: t.target.ref, versionAfterOp: t.target.versionAfterOp, dependencyIds: t.target.dependencyIds },
        });
        bumpProj();
        toast.push({ tone: "info", message: "Change saved offline", detail: "It will apply to the bill when the connection returns." });
        // Same opt-in reduction slip as online, printed locally (best-effort, never undoes the edit).
        if (reduction && reduction.next < reduction.previous) {
          void (async () => {
            try {
              const { receipt, render } = buildReductionReceipt({
                businessName: pos.tenantName,
                branchName: pos.branch.name,
                staffName: pos.userName,
                orderNumber: p.bill.orders.find((o) => o.lines.some((l) => l.id === line.id))?.order_number || selected.name,
                tableName: selected.name,
                currency: p.currency ?? input.currency,
                at: new Date().toLocaleString(),
                itemName: line.name,
                previousQuantity: reduction.previous,
                newQuantity: reduction.next,
                unitPrice: line.final_unit_price,
                reason,
              });
              await autoPrintReductionReceipt({
                branchId: pos.branch.id,
                access: pos.access,
                receipt,
                render,
                event: { orderId: t.target.payloadOrderId, targetItemId: line.id, posEntityVersion: t.target.expectedVersion + 1 },
              });
            } catch {
              /* A record slip is never allowed to disturb the edit it documents. */
            }
          })();
        }
      } catch (e) {
        toast.push({ tone: "warning", message: "The change could not be saved offline.", detail: classifyError(e).message });
      } finally {
        setEditingLineId(null);
      }
    },
    [input.offlineScope, input.currency, selected, tables.map, toast, bumpProj, pos],
  );

  const editSentLine = useCallback(
    async (line: BillLine, newQuantity: number, reason: string | null = null) => {
      if (offlineCapture) {
        await captureSentEditOffline(
          line,
          (orderId, expectedVersion, clientOpId) =>
            buildSetQuantityPayload({ orderId, lineId: line.id, newQuantity, expectedVersion, clientOpId, reason }) as unknown as Record<string, unknown>,
          { previous: line.quantity, next: newQuantity },
          reason,
        );
        return;
      }
      const bill = useTables.getState().bill;
      const order = bill?.orders.find((o) => o.lines.some((l) => l.id === line.id)) ?? bill?.orders[0];
      if (!order) return;
      setEditingLineId(line.id);
      try {
        const result = await editOrderLine(
          buildSetQuantityPayload({
            orderId: order.id,
            lineId: line.id,
            newQuantity,
            expectedVersion: order.pos_entity_version,
            clientOpId: crypto.randomUUID(),
            reason,
          }),
        );
        await tables.loadBill(ctx);
        // Part 2: a REDUCTION or CANCELLATION (never an increase) may print a
        // record slip to the receipt printer, if this terminal opted in. Fired
        // AFTER the edit committed and the bill reloaded; best-effort and keyed by
        // the server's post-edit version so it prints at most once. A print
        // failure is surfaced but never un-does the edit it documents.
        if (newQuantity < line.quantity) {
          void (async () => {
            try {
              const { receipt, render } = buildReductionReceipt({
                businessName: pos.tenantName,
                branchName: pos.branch.name,
                staffName: pos.userName,
                orderNumber: result.order_number,
                tableName: selected?.name ?? null,
                currency: bill?.currency ?? input.currency,
                at: new Date().toLocaleString(),
                itemName: line.name,
                previousQuantity: line.quantity,
                newQuantity,
                unitPrice: line.final_unit_price,
                reason,
              });
              const status = await autoPrintReductionReceipt({
                branchId: pos.branch.id,
                access: pos.access,
                receipt,
                render,
                event: { orderId: order.id, targetItemId: line.id, posEntityVersion: result.pos_entity_version },
              });
              if (status.kind === "failed") {
                toast.push({ tone: "warning", message: "The reduction receipt did not print.", detail: status.message });
              }
            } catch {
              /* A record slip is never allowed to disturb the edit it documents. */
            }
          })();
        }
      } catch (e) {
        await tables.loadBill(ctx);
        toast.push({ tone: "warning", message: "The edit did not apply. The bill was reloaded.", detail: classifyError(e).message });
      } finally {
        setEditingLineId(null);
      }
    },
    [tables, ctx, toast, pos, selected, input, offlineCapture, captureSentEditOffline],
  );

  const onEditSentQty = useCallback(
    (line: BillLine, delta: number) => {
      const next = Math.max(0, line.quantity + delta);
      // A reduction (including down to zero) is audited; an increase is not.
      if (next < line.quantity) setReasonPrompt({ kind: "quantity", line, newQuantity: next });
      else void editSentLine(line, next);
    },
    [editSentLine],
  );
  const onRemoveSentLine = useCallback(
    (line: BillLine) => setReasonPrompt({ kind: "quantity", line, newQuantity: 0 }),
    [],
  );

  // --- Phase D: change a SENT line's modifiers (atomic cancel-old + make-new) ----
  const [editModLine, setEditModLine] = useState<BillLine | null>(null);
  const editModItem = useMemo<MenuItem | null>(
    () => (editModLine?.menu_item_id ? input.menu.items.find((m) => m.id === editModLine.menu_item_id) ?? null : null),
    [editModLine, input.menu.items],
  );
  const editModGroups = useMemo(
    () => (editModItem ? groupsForItem(editModItem.id, input.menu.groupsByItem, input.menu.groups) : []),
    [editModItem, input.menu.groupsByItem, input.menu.groups],
  );
  const editModOptionsByGroup = useMemo(() => {
    const map: Record<string, ModifierOption[]> = {};
    for (const o of input.menu.options) (map[o.modifier_group_id] ??= []).push(o);
    return map;
  }, [input.menu.options]);

  const onEditSentModifiers = useCallback((line: BillLine) => setEditModLine(line), []);
  const itemHasModifiers = useCallback(
    (menuItemId: string) => groupsForItem(menuItemId, input.menu.groupsByItem, input.menu.groups).length > 0,
    [input.menu.groupsByItem, input.menu.groups],
  );
  const commitSentModifiers = useCallback(
    async (line: BillLine, result: ItemOptionsResult, reason: string | null) => {
      if (offlineCapture) {
        await captureSentEditOffline(
          line,
          (orderId, expectedVersion, clientOpId) =>
            buildChangeModifiersPayload({ orderId, lineId: line.id, quantity: result.quantity, modifiers: result.modifiers, expectedVersion, clientOpId, reason }) as unknown as Record<string, unknown>,
          null,
          reason,
        );
        return;
      }
      const bill = useTables.getState().bill;
      const order = bill?.orders.find((o) => o.lines.some((l) => l.id === line.id)) ?? bill?.orders[0];
      if (!order) return;
      setEditingLineId(line.id);
      try {
        await editOrderLine(
          buildChangeModifiersPayload({
            orderId: order.id,
            lineId: line.id,
            quantity: result.quantity,
            modifiers: result.modifiers,
            expectedVersion: order.pos_entity_version,
            clientOpId: crypto.randomUUID(),
            reason,
          }),
        );
        await tables.loadBill(ctx);
      } catch (e) {
        await tables.loadBill(ctx);
        toast.push({ tone: "warning", message: "The option change did not apply. The bill was reloaded.", detail: classifyError(e).message });
      } finally {
        setEditingLineId(null);
      }
    },
    [tables, ctx, toast, offlineCapture, captureSentEditOffline],
  );

  // A modifier change that DROPS or REPLACES a component is audited (the same
  // predicate the server enforces); a pure addition is applied straight away.
  const saveSentModifiers = useCallback(
    (result: ItemOptionsResult) => {
      const line = editModLine;
      if (!line) return;
      setEditModLine(null);
      if (modifierChangeRemovesComponents(line.modifiers, result.modifiers)) {
        setReasonPrompt({ kind: "modifier", line, result });
      } else {
        void commitSentModifiers(line, result, null);
      }
    },
    [editModLine, commitSentModifiers],
  );

  const confirmReason = useCallback(
    (reason: string) => {
      const p = reasonPrompt;
      setReasonPrompt(null);
      if (!p) return;
      if (p.kind === "quantity") void editSentLine(p.line, p.newQuantity, reason);
      else void commitSentModifiers(p.line, p.result, reason);
    },
    [reasonPrompt, editSentLine, commitSentModifiers],
  );

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
      if (!table || !payGate.allowed) return;

      // Phase D — OFFLINE settle: CAPTURE a pay_table op (durable, exactly-once, dependent on
      // the session's open+rounds), never a server charge. The online path below is unchanged.
      if (offlineCapture && input.offlineScope) {
        const target = await offlineSettleTarget(table);
        if (!target.ok) {
          setPayError(target.reason);
          return;
        }
        let offlineDiscount: ReturnType<typeof validateTableDiscount>;
        try {
          offlineDiscount = validateTableDiscount({
            canDiscount: pos.gates.applyDiscounts,
            subtotal: settleBill?.subtotal ?? 0,
            type: dialog.discountType,
            value: dialog.discountValue,
          });
        } catch (e) {
          const c = classifyError(e);
          setPayError(c.hint ? `${c.message} ${c.hint}` : c.message);
          return;
        }
        // Best-effort LOCAL USD amount for the drawer projection only (server derives the real
        // charge). The provisional bill total is in the order's OWN currency.
        const billCcy: CurrencyCode = settleBill?.currency ?? input.currency;
        const billTotal = settleBill?.total ?? 0;
        const cashAmountUsd =
          dialog.method === "cash"
            ? billCcy === "USD"
              ? billTotal
              : billCcy === "LBP" && input.rate && input.rate > 0
                ? billTotal / input.rate
                : null
            : null;
        setPaying(true);
        setPayError(null);
        try {
          await settleTableOffline({
            sessionId: target.sessionId,
            table: target.table,
            method: dialog.method,
            discount: offlineDiscount.fields,
            cashAmountUsd,
            extraDependencyIds: target.deps,
            covers: target.covers,
          });
          setPayOpen(false);
          toast.push({
            tone: "success",
            message: `${table.name} settled offline`,
            detail: "The table is free for a new order. The payment syncs automatically when you reconnect.",
          });
          bumpProj();
        } catch (e) {
          const c = classifyError(e);
          setPayError(c.hint ? `${c.message} ${c.hint}` : c.message);
        } finally {
          setPaying(false);
        }
        return;
      }

      const shownBill = useTables.getState().bill;
      if (!shownBill) return;

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
    [selected, payGate.allowed, pos.gates.applyDiscounts, input.currency, input.rate, ctx, readTableState, runCompletion, toast, offlineCapture, input.offlineScope, settleBill, offlineSettleTarget, bumpProj],
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
      if (!table || !payGate.allowed) return;

      // Phase D — OFFLINE on-account CAPTURE (receivable) against a cached/proven customer. Depends
      // on the session open+rounds; durable before success; no server RPC. Online path unchanged.
      if (offlineCapture && input.offlineScope) {
        if (!dialog.customerId) {
          setPayError("Choose a customer before putting a bill on account.");
          return;
        }
        const target = await offlineSettleTarget(table);
        if (!target.ok) {
          setPayError(target.reason);
          return;
        }
        const offDiscount =
          dialog.discountType !== "none" && dialog.discountValue.trim() !== ""
            ? { discount_type: dialog.discountType, discount_value: Number(dialog.discountValue) }
            : undefined;
        setPaying(true);
        setPayError(null);
        try {
          await tableOnAccountOffline({
            sessionId: target.sessionId,
            table: target.table,
            customerId: dialog.customerId,
            amount: dialog.amountNow,
            method: dialog.method,
            discount: offDiscount,
            extraDependencyIds: target.deps,
            covers: target.covers,
          });
          setPayOpen(false);
          toast.push({
            tone: "success",
            message: `${table.name} put on account offline`,
            detail: "The table is free for a new order. It syncs automatically when you reconnect.",
          });
          bumpProj();
        } catch (e) {
          const c = classifyError(e);
          setPayError(c.hint ? `${c.message} ${c.hint}` : c.message);
        } finally {
          setPaying(false);
        }
        return;
      }

      const shownBill = useTables.getState().bill;
      if (!shownBill || !payGate.allowed) return;
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

        // Classic USD/LBP: the receipt currency is the bill's own selling currency,
        // which `buildTableOnAccountReceipt` uses directly from `primaryCurrency`.
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
    [selected, payGate.allowed, input.online, input.currency, input.shiftId, ctx, readTableState, toast, offlineCapture, input.offlineScope, offlineSettleTarget, bumpProj],
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
      // The table Search Bar is intentionally hidden on Dine-in, so its Ctrl+F
      // shortcut was removed entirely (binding + handler): there is no
      // "tableSearch" id in the keyboard model any more, so nothing focuses the
      // sr-only field and nothing advertises a dead shortcut. Tables are browsed
      // with the arrows / grid.
      tableLeft: () => move(-1),
      tableRight: () => move(1),
      // Shared vertical ids - in the map view they walk a grid row.
      lineUp: () => move(-1),
      lineDown: () => move(1),
      tableOpen: () => {
        if (!focusedId) return;
        if (focusedId !== tables.selectedTableId) return select(focusedId);
        requestOpenSelected();
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
    (layout: LayoutSpec) => {
      const onSelectTable = (id: string) => {
        select(id);
        if (layout.cartAsDrawer) input.onBillDrawerOpen();
      };
      // The List (today's card grid) is always the fallback and stays exactly as
      // it was; the Map is an ADDITIVE view over the same store selection.
      const list = (
        <TableMap
          ref={searchRef}
          map={displayMap}
          visible={visible}
          layout={layout}
          selectedTableId={tables.selectedTableId}
          focusedTableId={focusedId}
          loading={tables.loading}
          refreshing={tables.refreshing}
          stale={stale}
          offline={tables.offline}
          error={tables.error}
          query={query}
          now={now}
          onQueryChange={setQuery}
          onSelect={onSelectTable}
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
      );
      const showFloor = floorGate.allowed && floorView === "floor";
      const renderer = showFloor ? (
        <ServiceFloor
          ctx={ctx}
          tables={displayMap.tables}
          selectedTableId={tables.selectedTableId}
          focusedTableId={focusedId}
          now={now}
          onSelect={onSelectTable}
          onSwitchToList={() => setFloorView("list")}
          onRefreshTables={() => void tables.refresh(ctx)}
        />
      ) : (
        list
      );
      // With the feature off there is no toggle at all — the List fills the work
      // region as it does today.
      if (!floorGate.allowed) return list;
      return (
        <div className="flex h-full min-h-0 flex-col gap-2">
          <div className="flex items-center gap-2">
            <MapListToggle view={floorView} onChange={setFloorView} />
            {/* Edit floor — only on the Map, only for `pos.tables.floor_manage`.
                Never a dead control: it is absent (not disabled) without the
                permission, and the List view never shows it. */}
            {showFloor && floorManageGate.allowed && (
              <button
                type="button"
                onClick={() => setEditingFloor(true)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-white px-3 py-2 text-sm font-bold text-ink hover:bg-canvas"
              >
                <Glyph name="edit" size={16} />
                Edit floor
              </button>
            )}
          </div>
          <div className="min-h-0 flex-1">{renderer}</div>
        </div>
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tables.map, displayMap, visible, tables.selectedTableId, focusedId, tables.loading, tables.refreshing, stale, tables.offline, tables.error, query, now, ctx, select, floorGate.allowed, floorView, setFloorView, floorManageGate.allowed],
  );

  // --- print the current bill BEFORE payment ---------------------------------
  //
  // Read-only: builds a receipt from the server's bill and hands it to the
  // MANUAL preview layer. No payment, no close, no mutation. A bill that spans
  // currencies has no single total, so it is refused rather than printed with an
  // invented one - the same honesty the payment path keeps.
  const [printingBill, setPrintingBill] = useState(false);
  const printBill = useCallback(() => {
    if (printingBill) return;
    // rc.9 — offline, print the check from the SAME operational bill the panel + payment show
    // (cached canonical + local rounds/edits), never the null server bill.
    const { bill: shownBill, table } = offlineCapture ? { bill: offlineBill, table: selected } : readTableState();
    if (!table || !shownBill || shownBill.orders.length === 0) {
      toast.push({ tone: "warning", message: "There is no open bill on this table to print yet." });
      return;
    }
    if (shownBill.currency == null || shownBill.subtotal == null) {
      toast.push({
        tone: "warning",
        message: "This table's bill spans more than one currency and can't be printed as a single receipt.",
      });
      return;
    }
    setPrintingBill(true);
    try {
      // The receipt currency is the bill's OWN selling currency, formatted by the
      // shared `formatMoney` in the preview - the same production-native source the
      // payment and on-account receipts use (no per-order decimal-digits input).
      // The guard above guarantees the bill is single-currency here.
      const primaryCurrency: CurrencyCode = shownBill.currency ?? input.currency;
      input.onPreviewReceipt(
        buildTableBillReceipt({
          bill: shownBill,
          table,
          tenantName: pos.tenantName,
          branchName: pos.branch.name,
          operatorName: pos.userName,
          primaryCurrency,
          shiftId: input.shiftId,
          at: new Date().toLocaleString(),
        }),
      );
    } catch (e) {
      toast.push({ tone: "error", message: "The bill could not be prepared for printing.", detail: classifyError(e).message });
    } finally {
      setPrintingBill(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [printingBill, readTableState, input, pos.tenantName, pos.branch.name, pos.userName, offlineCapture, offlineBill, selected]);

  const bill = useCallback(
    () => (
      <TableBillPanel
        table={selected}
        bill={offlineCapture ? (offlineBill ?? tables.bill) : tables.bill}
        loading={offlineCapture ? false : tables.billLoading}
        error={offlineCapture ? null : tables.billError}
        openGate={openGate}
        addItemsGate={addItemsGate}
        shiftOpen={hasOpenShift}
        onAddItems={() => void enterAddItems()}
        onOpenTable={requestOpenSelected}
        onOpenShift={input.onOpenShift}
        moveGate={opGates.move}
        closeGate={opGates.close}
        clearGate={opGates.clear}
        mergeGate={opGates.merge}
        onMove={() => requestOp("move")}
        onClose={() => requestOp("close")}
        onClear={() => requestOp("clear")}
        onMerge={() => requestOp("merge")}
        payGate={payGate}
        onPay={requestPay}
        splitGate={splitGate}
        onSplit={() => void openSplit()}
        onPrintBill={() => void printBill()}
        printBusy={printingBill}
      />
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selected, tables.bill, tables.billLoading, tables.billError, offlineCapture, offlineBill, openGate, addItemsGate, hasOpenShift, enterAddItems, opGates, requestOp, payGate, requestPay, splitGate, openSplit, requestOpenSelected, printBill, printingBill],
  );

  const roundPanel = useCallback(
    () =>
      selected ? (
        <DineInRoundPanel
          table={selected}
          /* OFFLINE: Add Items must read the SAME operational bill the table panel + payment use
             (the local dineDraft projection), not the server-only tables.bill — otherwise a locally
             known bill shows "could not be loaded" here while the sidebar shows it. Mirror the panel. */
          bill={offlineCapture ? (offlineBill ?? tables.bill) : tables.bill}
          billLoading={offlineCapture ? false : tables.billLoading}
          billError={offlineCapture ? null : tables.billError}
          refreshing={offlineCapture ? false : tables.refreshing || tables.billLoading}
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
          canEditSent={editSentGate.allowed}
          editingLineId={editingLineId}
          onEditSentQty={onEditSentQty}
          onRemoveSentLine={onRemoveSentLine}
          onEditSentModifiers={onEditSentModifiers}
          itemHasModifiers={itemHasModifiers}
        />
      ) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      selected, tables.bill, tables.billLoading, tables.billError, tables.refreshing, offlineCapture, offlineBill, billChange,
      roundLines, input.cartSelectedKey, roundSubtotal, input.currency, roundBusy, submitGate,
      sendRound, discardRound, requestLeaveAddItems,
      editSentGate.allowed, editingLineId, onEditSentQty, onRemoveSentLine, onEditSentModifiers, itemHasModifiers,
    ],
  );

  const dialogs = (
    <>
      {/* Phase D — change a SENT line's options. The SAME shared chooser the add
          flow uses, pre-filled with the line's current modifiers/quantity via the
          backward-compatible seed props (add flow unchanged). Confirm sends
          op=change_modifiers for this exact line id. */}
      <ModifierDialog
        open={Boolean(editModLine && editModItem)}
        item={editModItem}
        basePrice={editModLine?.base_price ?? 0}
        groups={editModGroups}
        optionsByGroup={editModOptionsByGroup}
        currency={input.currency}
        rate={input.rate}
        ingredientCustomization={false}
        seedKey={editModLine ? `edit:${editModLine.id}` : null}
        initialModifiers={editModLine?.modifiers ?? []}
        initialQuantity={editModLine?.quantity ?? 1}
        confirmLabel="Save changes"
        onCancel={() => setEditModLine(null)}
        onConfirm={(result) => void saveSentModifiers(result)}
      />
      {/* Phase 2 — the mandatory reason for a persisted removal/reduction. Opened by
          onRemoveSentLine, a quantity reduction, or a modifier change that drops a
          component; the reason is sent on the SAME edit RPC and audited server-side. */}
      <EditReasonDialog
        open={reasonPrompt !== null}
        busy={editingLineId !== null}
        title={
          reasonPrompt?.kind === "modifier"
            ? "Why change these options?"
            : reasonPrompt?.kind === "quantity" && reasonPrompt.newQuantity === 0
              ? "Why remove this item?"
              : "Why reduce this item?"
        }
        subtitle="A reason is required and recorded in the activity log."
        onConfirm={confirmReason}
        onCancel={() => setReasonPrompt(null)}
      />
      {/* The SAME dialog Takeaway uses. Not a copy: one discount validator, one
          currency conversion, one tender/change calculation, one keypad. Only
          the identity at the top differs, which is the part that should. */}
      <PaymentDialog
        open={payOpen}
        busy={paying}
        /* OFFLINE: the payable total MUST come from the same operational bill the table panel shows
           (settleBill = offline dineDraft projection when offline, else server bill) — NOT the
           server-only tables.bill, which is null offline and rendered the total as 0. */
        subtotal={settleBill?.subtotal ?? 0}
        primaryCurrency={settleBill?.currency ?? input.currency}
        rate={input.rate}
        discountGate={pos.gates.applyDiscounts}
        payGate={payGate}
        paymentMethods={activePaymentMethods}
        orderNumber={settleBill?.orders.map((o) => o.order_number).filter(Boolean).join(", ") || null}
        dineIn={
          selected
            ? { tableName: selected.name, seats: selected.seats, orderCount: settleBill?.orders.length ?? 0 }
            : null
        }
        onAccountDisabledReason={
          !pos.gates.takeOnAccount.allowed
            ? pos.gates.takeOnAccount.reason
            : input.online || offlineCapture
              ? null
              : "On-account sales need the POS to be ready offline."
        }
        onAccount={
          pos.gates.takeOnAccount.allowed && (input.online || offlineCapture)
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

      {/* R6 (1.0.36): on-account customer picker verify-and-link prompt (same-OU phone clash). */}
      <CustomerConflictDialog
        open={customerPicker.conflict.open}
        existingName={customerPicker.conflict.existingName}
        incomingName={customerPicker.conflict.incomingName}
        saving={customerPicker.conflict.saving}
        error={customerPicker.conflict.error}
        onUseExisting={customerPicker.conflict.onUseExisting}
        onClose={customerPicker.conflict.onCancel}
      />

      <MoveTableDialog
        open={opDialog === "move"}
        table={selected}
        tables={displayMap.tables}
        busy={opBusy}
        gate={opGates.move}
        error={opError}
        onCancel={() => setOpDialog(null)}
        onConfirm={confirmMove}
      />

      <MergeTablesDialog
        open={opDialog === "merge"}
        primary={selected}
        sources={mergeableSources(displayMap.tables, selected)}
        busy={opBusy}
        gate={opGates.merge}
        error={opError}
        onCancel={() => setOpDialog(null)}
        onConfirm={confirmMerge}
      />

      {/* Phase E — Split Bill. A settlement/allocation screen; every figure is the
          server's, re-read after each split so PAID vs REMAINING is always the truth. */}
      <SplitBillPanel
        open={splitOpen}
        state={splitState}
        loading={splitLoading}
        error={splitError}
        busy={splitBusy}
        methods={splitMethods}
        currency={(offlineCapture ? offlineBill?.currency : tables.bill?.currency) ?? input.currency}
        lastPaid={splitLastPaid}
        onPaySelected={(allocations, method) => void paySplit(allocations, method)}
        onClose={() => setSplitOpen(false)}
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

      {/* Floor DESIGNER overlay (Phase 3A). A self-contained editing surface that
          owns its own lease and draft; it never touches the Dine-In flows behind
          it. Mounted here (in the always-present dialogs) so the launching button
          lives in the Map header while the overlay is stable across layout ticks.
          Closing simply returns to the Service Map — Phase 3A publishes nothing. */}
      <FloorDesigner
        open={editingFloor}
        ctx={ctx}
        onClose={() => {
          setEditingFloor(false);
          if (ctx.branchId) void useFloor.getState().load(ctx);
        }}
      />
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
