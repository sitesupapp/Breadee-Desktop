// The POS workspace shell: rail + status bar + work area + cart.
//
// The layout is driven by MEASURED width (see `lib/layout.ts`) rather than media
// queries, because Windows display scaling changes the CSS viewport - a 1366x768
// panel at 150% reports ~910 CSS px and must get the drawer layout, while the same
// panel at 100% must get the fixed cart. Measuring makes that automatic.
//
// Structural guarantees:
//   * the page NEVER scrolls; only the menu list and the cart list do,
//   * the status bar and the cart action area are always on screen,
//   * below the fixed-cart threshold the cart becomes a drawer AND a persistent
//     bottom bar keeps the total and Pay reachable in one tap.

import { useMemo, type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { Button, cn } from "@/components/ui";
import { Drawer } from "@/components/overlays";
import { formatMoney, type CurrencyCode } from "@/lib/currency";
import { isTooSmall, MIN_SUPPORTED_HEIGHT, MIN_SUPPORTED_WIDTH, railWidth, resolveLayout, type LayoutSpec } from "@/lib/layout";
import { useWindowSize } from "@/lib/useElementSize";

export type PosRoute = {
  key: string;
  label: string;
  icon: string;
  to: string;
  enabled: boolean;
  /** Why the route is unavailable, shown on hover when disabled. */
  reason?: string | null;
};

export type PosShellProps = {
  routes: PosRoute[];
  statusBar: (layout: LayoutSpec) => ReactNode;
  work: (layout: LayoutSpec) => ReactNode;
  cart: (layout: LayoutSpec) => ReactNode;
  /** Bottom-bar summary used only when the cart is a drawer. */
  cartSummary: { itemCount: number; subtotal: number; currency: CurrencyCode; onPay: () => void; payDisabled: boolean };
  cartDrawerOpen: boolean;
  onCartDrawerChange: (open: boolean) => void;
  onExit: () => void;
  onToggleFullscreen: () => void;
};

export function PosShell(props: PosShellProps) {
  const { width, height } = useWindowSize();
  const layout = useMemo(() => resolveLayout(width), [width]);

  if (isTooSmall(width, height)) {
    return (
      <div className="flex h-full items-center justify-center bg-slate-50 p-8">
        <div className="max-w-sm text-center">
          <p className="text-base font-extrabold text-ink">The window is too small for the POS</p>
          <p className="mt-2 text-sm text-sub">
            Resize the window to at least {MIN_SUPPORTED_WIDTH} x {MIN_SUPPORTED_HEIGHT}, or lower the display scaling.
            The current size is {Math.round(width)} x {Math.round(height)}.
          </p>
        </div>
      </div>
    );
  }

  const rail = railWidth(layout);

  return (
    <div className="flex h-full w-full overflow-hidden bg-slate-50">
      {/* Navigation rail */}
      <nav
        style={{ width: rail }}
        className="flex shrink-0 flex-col border-r border-line bg-white"
        aria-label="POS navigation"
      >
        <div className={cn("flex items-center gap-2 px-3 py-3", !layout.railExpanded && "justify-center px-0")}>
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand text-lg font-black text-white">
            B
          </div>
          {layout.railExpanded && (
            <div className="min-w-0">
              <p className="truncate text-sm font-extrabold leading-none text-brand-dark">Breadee</p>
              <p className="text-[10px] font-semibold text-sub">Point of Sale</p>
            </div>
          )}
        </div>

        <div className="flex-1 space-y-1 px-2">
          {props.routes.map((r) =>
            r.enabled ? (
              <NavLink
                key={r.key}
                to={r.to}
                title={r.label}
                className={({ isActive }) =>
                  cn(
                    "flex min-h-[48px] items-center gap-3 rounded-xl px-3 text-sm font-semibold transition",
                    !layout.railExpanded && "justify-center px-0",
                    isActive ? "bg-brand-soft text-brand-dark" : "text-ink hover:bg-slate-50",
                  )
                }
              >
                <span className="text-base">{r.icon}</span>
                {layout.railExpanded && <span className="truncate">{r.label}</span>}
              </NavLink>
            ) : (
              <div
                key={r.key}
                title={r.reason ?? "Coming in a later phase"}
                aria-disabled
                className={cn(
                  "flex min-h-[48px] cursor-not-allowed items-center gap-3 rounded-xl px-3 text-sm font-semibold text-slate-300",
                  !layout.railExpanded && "justify-center px-0",
                )}
              >
                <span className="text-base">{r.icon}</span>
                {layout.railExpanded && <span className="truncate">{r.label}</span>}
              </div>
            ),
          )}
        </div>

        <div className="space-y-1 p-2">
          <Button
            variant="ghost"
            className={cn("w-full", !layout.railExpanded && "px-0")}
            onClick={props.onToggleFullscreen}
            title="Fullscreen (F11)"
          >
            {layout.railExpanded ? "Fullscreen" : "[ ]"}
          </Button>
          <Button
            variant="ghost"
            className={cn("w-full", !layout.railExpanded && "px-0")}
            onClick={props.onExit}
            title="Leave the POS workspace"
          >
            {layout.railExpanded ? "Exit POS" : "X"}
          </Button>
        </div>
      </nav>

      {/* Work area */}
      <div className="flex min-w-0 flex-1 flex-col">
        {props.statusBar(layout)}

        <div className="flex min-h-0 flex-1">
          <main className="flex min-h-0 min-w-0 flex-1 flex-col p-3">{props.work(layout)}</main>

          {!layout.cartAsDrawer && (
            <aside style={{ width: layout.cartWidth ?? 360 }} className="min-h-0 shrink-0">
              {props.cart(layout)}
            </aside>
          )}
        </div>

        {/* Below the fixed-cart threshold: the total and Pay stay on screen. */}
        {layout.cartAsDrawer && (
          <div className="flex shrink-0 items-center gap-3 border-t border-line bg-white px-3 py-2">
            <button
              type="button"
              onClick={() => props.onCartDrawerChange(true)}
              className="flex min-h-[48px] flex-1 items-center justify-between gap-3 rounded-xl border border-line px-3 text-left"
            >
              <span className="text-sm font-semibold text-sub">
                {props.cartSummary.itemCount} item{props.cartSummary.itemCount === 1 ? "" : "s"}
              </span>
              <span className="text-lg font-extrabold tabular-nums text-ink">
                {formatMoney(props.cartSummary.subtotal, props.cartSummary.currency)}
              </span>
            </button>
            <Button size="lg" onClick={props.cartSummary.onPay} disabled={props.cartSummary.payDisabled}>
              Pay
            </Button>
          </div>
        )}
      </div>

      <Drawer
        open={layout.cartAsDrawer && props.cartDrawerOpen}
        title="Current order"
        width={380}
        onClose={() => props.onCartDrawerChange(false)}
      >
        {props.cart(layout)}
      </Drawer>
    </div>
  );
}
