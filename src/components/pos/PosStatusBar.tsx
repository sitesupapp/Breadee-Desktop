// The operational status bar.
//
// This never scrolls and never collapses: at any supported size the cashier can
// see who they are, where they are, whether a shift is open, and whether the
// terminal is online. Those facts are what makes a mistake obvious before it
// becomes a financial one.
//
// THE DRAWER AMOUNT IS NOT ONE OF THEM. It used to sit here permanently -
// "Drawer $20,129.50" - which put the till's cash on screen for anyone standing
// behind the cashier, all day, whether or not anybody needed it. The control is
// now a neutral "Drawer" button and the figure exists only while its popover is
// open. Same authoritative value, same permissions, revealed on purpose rather
// than by default.

import { useEffect, useState } from "react";
import { Badge, Button, StatusDot, cn } from "@/components/ui";
import { CASH_CONTRACT_CURRENCY, formatMoney, type CurrencyCode } from "@/lib/currency";
import { elapsedSince } from "@/lib/pos/shifts";
import { TopBarPopover } from "@/components/pos/TopBarPopover";
import { SyncCenter } from "@/components/pos/SyncCenter";
import { orderLifecycleLabel, orderLifecycleTone, orderRouteLabel, type ShiftOpenOrder } from "@/lib/pos/shiftOrderSummary";
import type { ActiveShift, CashBox } from "@/types/pos";
import type { OfflineDrawerView } from "@/lib/pos/offlineDrawer";
import { markStart, recordSince } from "@/lib/perf/timings";
import type { LayoutSpec } from "@/lib/layout";

export type PosStatusBarProps = {
  tenantName: string;
  branchName: string;
  // R5 policy: an all-branches operator (owner/admin) picks which branch this POS session operates in.
  // When set, the branch label becomes a selector; shifts/orders then use the chosen branch.
  allBranches?: boolean;
  /** Active tenant — scopes the Sync Center's history/summary to this tenant. */
  tenantId?: string | null;
  branchId?: string | null;
  branchOptions?: { id: string; name: string }[];
  onSelectBranch?: (branchId: string) => void;
  operatorName: string;
  roleLabel: string;
  shift: ActiveShift | null;
  cashBox: CashBox | null;
  /** Offline-first recovery (Bug 12) — the Drawer control's visibility, decided from durable local state
   *  (own open shift + the cached pos.take_payments grant), never from whether a server read succeeded. */
  drawerVisible: boolean;
  /** The provisional local drawer, read from the operation log (no network) when no server figure is in hand. */
  loadOfflineDrawer: () => Promise<OfflineDrawerView>;
  currency: CurrencyCode;
  online: boolean;
  offlineMode: boolean;
  pendingSync: number;
  layout: LayoutSpec;
  onOpenShift: () => void;
  onEndShift: () => void;
  canOpenShift: boolean;
  openShiftReason: string | null;
  /** The active shift's orders - the SAME collection the right panel shows. */
  shiftOrders: ShiftOpenOrder[];
  selectedOrderId: string | null;
  onSelectOrder: (orderId: string) => void;
  /** Open the full Orders workspace. */
  onOpenOrders: () => void;
  /** Open delivery management for this shift. */
  onOpenDelivery: () => void;
};

function useClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    // Tick on the minute boundary rather than every second: the clock is for
    // orientation, and a 12-hour shift should not pay for 43,200 renders.
    const id = window.setInterval(() => setNow(new Date()), 20_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

export function PosStatusBar(props: PosStatusBarProps) {
  const now = useClock();
  const compact = props.layout.tier === "xs" || props.layout.tier === "sm";
  const shiftOpen = Boolean(props.shift);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [ordersOpen, setOrdersOpen] = useState(false);
  const [offlineDrawer, setOfflineDrawer] = useState<OfflineDrawerView | null>(null);
  const { cashBox, loadOfflineDrawer } = props;

  // Offline-first recovery (Bug 12) — no server figure in hand: show the provisional local drawer.
  useEffect(() => {
    if (!drawerOpen) return;
    const t0 = markStart();
    if (cashBox) {
      recordSince("drawer.open", t0);
      return;
    }
    let live = true;
    setOfflineDrawer(null);
    void loadOfflineDrawer()
      .then((v) => {
        if (!live) return;
        setOfflineDrawer(v);
        recordSince("drawer.open", t0);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [drawerOpen, cashBox, loadOfflineDrawer]);

  // A shift that closes takes both popovers with it - neither should be left
  // hanging over a till that no longer has the state they were describing.
  useEffect(() => {
    if (!shiftOpen) {
      setDrawerOpen(false);
      setOrdersOpen(false);
    }
  }, [shiftOpen]);

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-white px-3 sm:px-4">
      {/* Identity - who and where. */}
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-sm font-extrabold text-ink">{props.tenantName}</span>
        <span className="text-slate-300">/</span>
        {props.allBranches && (props.branchOptions?.length ?? 0) > 0 ? (
          <select
            value={props.branchId ?? ""}
            onChange={(e) => props.onSelectBranch?.(e.target.value)}
            title="Operating unit — the branch this POS session opens shifts and creates orders in"
            className="max-w-[170px] truncate rounded-md border border-line bg-white px-1.5 py-1 text-sm font-semibold text-ink outline-none"
          >
            {props.branchOptions!.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="truncate text-sm font-semibold text-ink" title={props.branchName}>
            {props.branchName}
          </span>
        )}
      </div>

      {!compact && (
        <div className="flex min-w-0 items-center gap-2 border-l border-line pl-3">
          <span className="truncate text-sm text-sub" title={props.operatorName}>
            {props.operatorName}
          </span>
          <Badge tone="slate">{props.roleLabel}</Badge>
        </div>
      )}

      <div className="flex-1" />

      {/* Shift - the single most consequential piece of state on the screen. */}
      {shiftOpen ? (
        <div className="flex items-center gap-2">
          <Badge tone="green">
            <StatusDot tone="green" />
            Shift open
          </Badge>
          {!compact && <span className="text-xs text-sub">{elapsedSince(props.shift?.opened_at ?? null, now.getTime())}</span>}

          {/* DRAWER - neutral label, no amount. The figure exists only inside
              the popover below, so a casual observer sees the word and nothing
              else. No amount in the label, no badge, no title tooltip. */}
          {(props.cashBox || props.drawerVisible) && (
            <TopBarPopover
              open={drawerOpen}
              onOpenChange={setDrawerOpen}
              label="Drawer"
              className="w-[240px]"
              trigger={
                <Button variant="ghost" onClick={() => setDrawerOpen((o) => !o)} title="Show the drawer">
                  Drawer
                </Button>
              }
            >
              <p className="text-[11px] font-semibold uppercase tracking-wide text-sub">Current drawer</p>
              {props.cashBox ? (
                <>
                  {/* USD, not the tenant's primary currency. `expected_cash` is a
                      USD-normalised aggregate; rendering it with the LBP formatter
                      turned 113.56 into "114 LBP" on a shift that had taken
                      10,220,000 LBP. See CASH_CONTRACT_CURRENCY. */}
                  <p className="mt-1 text-xl font-extrabold text-ink">
                    {formatMoney(props.cashBox.expected_cash, CASH_CONTRACT_CURRENCY)}
                  </p>
                  <p className="mt-1 text-[11px] text-sub">
                    Expected cash: opening float plus cash taken this shift. Read from the server, in USD.
                  </p>
                </>
              ) : offlineDrawer === null ? (
                <p className="mt-1 text-[12px] text-sub">Reading this device's records…</p>
              ) : (
                <>
                  <p className="mt-1 text-xl font-extrabold text-ink">
                    {offlineDrawer.projectedUsd == null ? "—" : formatMoney(offlineDrawer.projectedUsd, CASH_CONTRACT_CURRENCY)}
                  </p>
                  <p className="mt-1 text-[11px] font-semibold text-amber-700">Provisional — offline, not yet confirmed by the server.</p>
                  <p className="mt-1 text-[11px] text-sub">
                    {offlineDrawer.baseSource === "server"
                      ? `Last server figure ${formatMoney(offlineDrawer.baseUsd ?? 0, CASH_CONTRACT_CURRENCY)}`
                      : offlineDrawer.baseSource === "opening_float"
                        ? `Opening float ${formatMoney(offlineDrawer.baseUsd ?? 0, CASH_CONTRACT_CURRENCY)}`
                        : "Opening float not known in USD on this device"}
                    {` · cash in ${formatMoney(offlineDrawer.cashInUsd, CASH_CONTRACT_CURRENCY)} · cash out ${formatMoney(offlineDrawer.cashOutUsd, CASH_CONTRACT_CURRENCY)} recorded offline.`}
                  </p>
                  {offlineDrawer.unknownAmountCount > 0 && (
                    <p className="mt-1 text-[11px] text-sub">
                      {offlineDrawer.unknownAmountCount} cash movement{offlineDrawer.unknownAmountCount === 1 ? "" : "s"} will be counted after sync.
                    </p>
                  )}
                </>
              )}
            </TopBarPopover>
          )}

          {/* DELIVERY - management for this shift's delivery orders. */}
          <Button variant="ghost" onClick={props.onOpenDelivery} title="Delivery orders on this shift">
            <span aria-hidden className="mr-1">
              🛵
            </span>
            Delivery
          </Button>

          {/* SHIFT ORDERS - the count and the list are one collection.
              The badge counts the ACTIVE shift, which is what the quick list
              shows; the full workspace behind "See all orders" can widen to the
              whole day, and says so rather than changing what N means. */}
          <TopBarPopover
            open={ordersOpen}
            onOpenChange={setOrdersOpen}
            label="Shift orders"
            className="w-[340px]"
            trigger={
              <Button variant="ghost" onClick={() => setOrdersOpen((o) => !o)} title="Orders taken on this shift">
                Orders {props.shiftOrders.length}
              </Button>
            }
          >
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-sub">This shift</p>
              <Button
                variant="ghost"
                className="px-2 py-1 text-[11px]"
                onClick={() => {
                  setOrdersOpen(false);
                  props.onOpenOrders();
                }}
              >
                See all orders
              </Button>
            </div>
            {props.shiftOrders.length === 0 ? (
              <p className="mt-2 py-3 text-center text-[12px] text-sub">No orders on this shift yet.</p>
            ) : (
              <ul className="mt-2 max-h-72 space-y-1 overflow-y-auto">
                {[...props.shiftOrders]
                  .slice()
                  .reverse()
                  .map((o) => (
                    <li key={o.id}>
                      <button
                        type="button"
                        onClick={() => {
                          props.onSelectOrder(o.id);
                          setOrdersOpen(false);
                        }}
                        className={cn(
                          "w-full rounded-lg border px-2 py-1.5 text-left hover:bg-slate-50",
                          o.id === props.selectedOrderId ? "border-brand bg-brand-soft" : "border-line",
                        )}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[12px] font-bold text-ink">#{o.order_number ?? o.id.slice(0, 8)}</span>
                          <span className="text-[12px] font-bold text-ink">
                            {formatMoney(o.total_amount ?? 0, (o.currency ?? props.currency) as CurrencyCode)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-[11px] text-sub">
                            {orderRouteLabel(o.order_type)} ·{" "}
                            <span
                              className={cn(
                                "font-semibold",
                                orderLifecycleTone(o) === "red"
                                  ? "text-red-700"
                                  : orderLifecycleTone(o) === "green"
                                    ? "text-brand-dark"
                                    : "text-amber-800",
                              )}
                            >
                              {orderLifecycleLabel(o)}
                            </span>
                          </span>
                          <span className="shrink-0 text-[11px] text-sub">
                            {o.created_at ? new Date(o.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}
                          </span>
                        </div>
                      </button>
                    </li>
                  ))}
              </ul>
            )}
          </TopBarPopover>

          <Button variant="ghost" onClick={props.onEndShift}>
            End shift
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Badge tone="amber">
            <StatusDot tone="amber" />
            No open shift
          </Badge>
          <Button
            onClick={props.onOpenShift}
            disabled={!props.canOpenShift}
            title={props.openShiftReason ?? undefined}
          >
            Open shift
          </Button>
        </div>
      )}

      {/* Connectivity + queue - always visible, never a hidden overflow item. */}
      <div className="flex items-center gap-2 border-l border-line pl-3">
        {props.pendingSync > 0 && (
          <Badge tone="amber" className={cn("cursor-default")} title="Records waiting to sync">
            {props.pendingSync} to sync
          </Badge>
        )}
        {props.offlineMode ? (
          <Badge tone="amber">
            <StatusDot tone="amber" />
            Offline mode
          </Badge>
        ) : props.online ? (
          <Badge tone="green">
            <StatusDot tone="green" />
            Online
          </Badge>
        ) : (
          <Badge tone="red">
            <StatusDot tone="red" />
            No internet
          </Badge>
        )}
        {/* Sync Center — opens the durable offline history (what synced, what is
            pending, what needs attention). Additive: the "to sync" badge above is the
            at-a-glance count; this chip is the gateway to the detail. */}
        {!compact && props.tenantId && <SyncCenter tenantId={props.tenantId} branchId={props.branchId ?? null} />}
        {!compact && (
          <span className="w-14 text-right text-xs font-semibold text-sub">
            {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
        )}
      </div>
    </header>
  );
}
