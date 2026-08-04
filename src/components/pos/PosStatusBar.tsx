// The operational status bar.
//
// This never scrolls and never collapses: at any supported size the cashier can
// see who they are, where they are, whether a shift is open, what is in the
// drawer, and whether the terminal is online. Those five facts are what makes a
// mistake obvious before it becomes a financial one.

import { useEffect, useState } from "react";
import { Badge, Button, StatusDot, cn } from "@/components/ui";
import { formatMoney, type CurrencyCode } from "@/lib/currency";
import { elapsedSince } from "@/lib/pos/shifts";
import type { ActiveShift, CashBox } from "@/types/pos";
import type { LayoutSpec } from "@/lib/layout";

export type PosStatusBarProps = {
  tenantName: string;
  branchName: string;
  operatorName: string;
  roleLabel: string;
  shift: ActiveShift | null;
  cashBox: CashBox | null;
  currency: CurrencyCode;
  online: boolean;
  offlineMode: boolean;
  pendingSync: number;
  layout: LayoutSpec;
  onOpenShift: () => void;
  onEndShift: () => void;
  canOpenShift: boolean;
  openShiftReason: string | null;
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

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-white px-3 sm:px-4">
      {/* Identity - who and where. */}
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-sm font-extrabold text-ink">{props.tenantName}</span>
        <span className="text-slate-300">/</span>
        <span className="truncate text-sm font-semibold text-ink" title={props.branchName}>
          {props.branchName}
        </span>
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
          {props.cashBox && (
            <span className="rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-bold text-ink" title="Expected cash in the drawer">
              Drawer {formatMoney(props.cashBox.expected_cash, props.currency)}
            </span>
          )}
          <Button size="sm" variant="ghost" onClick={props.onEndShift}>
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
            size="sm"
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
        {!compact && (
          <span className="w-14 text-right text-xs font-semibold text-sub">
            {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
        )}
      </div>
    </header>
  );
}
