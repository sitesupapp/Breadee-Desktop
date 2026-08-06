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
import { filterTables, isOpenable, openTable } from "@/lib/pos/tables";
import { classifyError } from "@/lib/pos/errors";
import { canOpenTable } from "@/lib/pos/access";
import { isMapStale, selectedTable as pickSelected, useTables } from "@/state/tables";
import type { PosContext } from "@/state/pos";
import type { LayoutSpec } from "@/lib/layout";
import type { Gate } from "@/components/ui";
import type { TableSummary } from "@/types/tables";

export type DineInWorkspace = {
  work: (layout: LayoutSpec) => React.ReactNode;
  bill: (layout: LayoutSpec) => React.ReactNode;
  dialogs: React.ReactNode;
  /** Drawer summary for the sub-1024 tier. */
  summary: { itemCount: number; subtotal: number };
  selected: TableSummary | null;
};

export function useDineInWorkspace(input: {
  pos: PosContext;
  hasOpenShift: boolean;
  active: boolean;
  onOpenShift: () => void;
  onBillDrawerOpen: () => void;
}): DineInWorkspace {
  const { pos, hasOpenShift, active } = input;
  const toast = useToast();
  const tables = useTables();

  const [query, setQuery] = useState("");
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [seatOpen, setSeatOpen] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const searchRef = useRef<HTMLInputElement>(null);
  // Same synchronous latch Takeaway uses: two fast taps must not both fire.
  const inFlight = useRef(false);

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

  const select = useCallback(
    (id: string) => {
      setFocusedId(id);
      void tables.select(id, ctx);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [ctx],
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

  useShortcuts(
    {
      tableSearch: () => searchRef.current?.focus(),
      tableMap: () => {
        tables.clearSelection();
        setFocusedId(null);
      },
      tableLeft: () => move(-1),
      tableRight: () => move(1),
      // Shared vertical ids - in Dine-in they walk a grid row.
      lineUp: () => move(-1),
      lineDown: () => move(1),
      tableOpen: () => {
        if (!focusedId) return;
        if (focusedId !== tables.selectedTableId) return select(focusedId);
        if (openGate.allowed) setSeatOpen(true);
      },
      // addItems / moveTable / closeTable / clearTable are deliberately absent:
      // an unregistered id does nothing at all.
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
        shiftOpen={hasOpenShift}
        onOpenTable={() => {
          setOpenError(null);
          setSeatOpen(true);
        }}
        onOpenShift={input.onOpenShift}
      />
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selected, tables.bill, tables.billLoading, tables.billError, openGate, hasOpenShift],
  );

  const dialogs = (
    <SeatCountDialog
      open={seatOpen}
      table={selected}
      busy={busy}
      gate={openGate}
      error={openError}
      onCancel={() => setSeatOpen(false)}
      onConfirm={(seats) => void confirmOpen(seats)}
    />
  );

  return {
    work,
    bill,
    dialogs,
    summary: {
      itemCount: tables.bill?.orders.reduce((s, o) => s + o.lines.length, 0) ?? 0,
      subtotal: tables.bill?.total ?? 0,
    },
    selected,
  };
}
