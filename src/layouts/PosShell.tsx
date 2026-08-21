// The POS workspace shell: rail + status bar + work area + cart + footer.
//
// The layout is driven by MEASURED width (see `lib/layout.ts`) rather than media
// queries, because Windows display scaling changes the CSS viewport - a 1366x768
// panel at 150% reports ~910 CSS px and must get the drawer layout, while the same
// panel at 100% must get the fixed cart. Measuring makes that automatic.
//
// Structural guarantees:
//   * the page NEVER scrolls; only the menu list and the cart list do,
//   * the status bar, the footer and the cart action area are always on screen,
//   * below the fixed-cart threshold the cart becomes a drawer AND a persistent
//     bottom bar keeps the total and Pay reachable in one tap.
//
// COLLAPSE IS AN OVERRIDE, NOT A REPLACEMENT. Width still decides the DEFAULT
// rail state, because that is what keeps a 1024px till usable without anybody
// configuring it. The Collapse control lets an operator overrule that decision
// for this session, in either direction, and a resize that changes the tier
// leaves the override alone - a preference the window silently revoked would be
// worse than no preference at all.

import { useMemo, useState, type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { Button, cn } from "@/components/ui";
import { Drawer } from "@/components/overlays";
import { Glyph, type GlyphName } from "@/components/Glyph";
import { PosFooterBar } from "@/components/pos/PosFooterBar";
import { formatMoney, type CurrencyCode } from "@/lib/currency";
import {
  isTooSmall,
  MIN_SUPPORTED_HEIGHT,
  MIN_SUPPORTED_WIDTH,
  RAIL_COLLAPSED_PX,
  RAIL_EXPANDED_PX,
  resolveLayout,
  type LayoutSpec,
} from "@/lib/layout";
import { useWindowSize } from "@/lib/useElementSize";

export type PosRoute = {
  key: string;
  label: string;
  icon: GlyphName;
  to: string;
  enabled: boolean;
  /** Why the route is unavailable, shown on hover when disabled. */
  reason?: string | null;
  /**
   * In-workspace mode switch. Takeaway, Dine-in and Delivery share one shell,
   * one status bar and one layout resolver, so they switch a MODE rather than
   * navigating - a second router route would mean a second shell instance and a
   * second set of shift/menu subscriptions. When `onSelect` is present the rail
   * renders a button; otherwise it falls back to a NavLink on `to`.
   */
  onSelect?: () => void;
  active?: boolean;
};

export type PosShellProps = {
  routes: PosRoute[];
  statusBar: (layout: LayoutSpec) => ReactNode;
  work: (layout: LayoutSpec) => ReactNode;
  cart: (layout: LayoutSpec) => ReactNode;
  /** Label for the drawer + its bottom bar. Differs by mode (cart vs bill). */
  cartTitle?: string;
  /**
   * Bottom-bar summary used only when the cart is a drawer.
   *
   * OPTIONAL on purpose: a mode with nothing to settle passes nothing, and the
   * bar - Pay button included - is not rendered at all. A disabled Pay would
   * still be a Pay, and that workspace has no payment path behind it.
   */
  cartSummary?: {
    itemCount: number;
    subtotal: number;
    currency: CurrencyCode;
    onPay: () => void;
    payDisabled: boolean;
    payLabel?: string;
    /** Why the action is unavailable. Shown on hover, so a dead control explains itself. */
    payReason?: string | null;
  };
  cartDrawerOpen: boolean;
  onCartDrawerChange: (open: boolean) => void;
  /**
   * Which side the Current Order column sits on. Defaults to `right`.
   *
   * A SWAP OF TWO SIBLINGS AND NOTHING ELSE. The same `cart(layout)` node is
   * rendered either way, so the panel, its state, its buttons and its gates are
   * identical - there is no second Current Order, and nothing downstream can
   * tell which side it is on. Below the fixed-cart threshold the cart is a
   * drawer and this has no effect at all, which is correct: a drawer has no
   * side to be on.
   */
  cartSide?: "left" | "right";
  onExit: () => void;
  onToggleFullscreen: () => void;
  /**
   * The window's ACTUAL fullscreen state, owned by the workspace and refreshed
   * from the platform after every toggle. The shell renders it and never
   * guesses - a label that says "Full Screen" while the window is already
   * fullscreen is the button "doing nothing" all over again, one layer up.
   */
  isFullscreen?: boolean;
  /** Footer facts. The version is read from the build, never passed in. */
  ready: boolean;
  online: boolean;
  pendingSync: number;
  /** Business identity for the rail header. */
  tenantName: string;
};

export function PosShell(props: PosShellProps) {
  const { width, height } = useWindowSize();
  const layout = useMemo(() => resolveLayout(width), [width]);
  /** null = follow the measured width; true/false = the operator overruled it. */
  const [collapseOverride, setCollapseOverride] = useState<boolean | null>(null);

  if (isTooSmall(width, height)) {
    return (
      <div className="flex h-full items-center justify-center bg-canvas p-8">
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

  const expanded = collapseOverride === null ? layout.railExpanded : !collapseOverride;
  const rail = expanded ? RAIL_EXPANDED_PX : RAIL_COLLAPSED_PX;

  return (
    <div className="flex h-full w-full overflow-hidden bg-canvas">
      {/* Navigation rail */}
      <nav
        style={{ width: rail }}
        className="flex shrink-0 flex-col border-r border-line bg-white transition-[width]"
        aria-label="POS navigation"
      >
        <div className={cn("flex items-center gap-2.5 px-3 py-4", !expanded && "justify-center px-0")}>
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand text-lg font-black text-onbrand">
            B
          </div>
          {expanded && (
            <div className="min-w-0">
              <p className="truncate text-base font-extrabold leading-tight text-brand-dark">Breadee</p>
              <p className="truncate text-[11px] font-semibold text-sub" title={props.tenantName}>
                POS
              </p>
            </div>
          )}
        </div>

        <div className="flex-1 space-y-1 px-2 pt-2">
          {props.routes.map((r) => {
            const inner = (
              <>
                <Glyph name={r.icon} size={20} className="shrink-0" />
                {expanded && <span className="truncate">{r.label}</span>}
              </>
            );
            const shape = cn(
              "flex min-h-[48px] w-full items-center gap-3 rounded-xl px-3 text-sm font-semibold transition",
              !expanded && "justify-center px-0",
            );

            if (r.enabled && r.onSelect) {
              return (
                <button
                  key={r.key}
                  type="button"
                  onClick={r.onSelect}
                  title={r.label}
                  aria-current={r.active ? "page" : undefined}
                  className={cn(shape, r.active ? "bg-brand-soft text-brand-dark" : "text-ink hover:bg-slate-50")}
                >
                  {inner}
                </button>
              );
            }
            if (r.enabled) {
              return (
                <NavLink
                  key={r.key}
                  to={r.to}
                  title={r.label}
                  className={({ isActive }) =>
                    cn(shape, isActive ? "bg-brand-soft text-brand-dark" : "text-ink hover:bg-slate-50")
                  }
                >
                  {inner}
                </NavLink>
              );
            }
            return (
              <div
                key={r.key}
                title={r.reason ?? "Not available for this account"}
                aria-disabled
                className={cn(shape, "cursor-not-allowed text-slate-300")}
              >
                {inner}
              </div>
            );
          })}
        </div>

        {/* Window and workspace controls. Deliberately NOT navigation: they sit
            below a divider so the four routes above them read as a set. */}
        <div className="space-y-1 border-t border-line p-2">
          {/* The label is the PLATFORM's state, never a guess - see
              `isFullscreen` above. */}
          <RailAction
            expanded={expanded}
            glyph={props.isFullscreen ? "fullscreen-exit" : "fullscreen"}
            label={props.isFullscreen ? "Exit Full Screen" : "Full Screen"}
            title={props.isFullscreen ? "Exit full screen (F11)" : "Full screen (F11)"}
            onClick={props.onToggleFullscreen}
          />
          <RailAction
            expanded={expanded}
            glyph="close"
            label="Close"
            title="Leave the POS workspace and return to Breadee Desktop"
            onClick={props.onExit}
          />
          <RailAction
            expanded={expanded}
            glyph={expanded ? "collapse" : "expand"}
            label={expanded ? "Collapse" : "Expand"}
            title={expanded ? "Collapse the sidebar" : "Expand the sidebar"}
            onClick={() => setCollapseOverride(expanded)}
          />
        </div>
      </nav>

      {/* Work area */}
      <div className="flex min-w-0 flex-1 flex-col">
        {props.statusBar(layout)}

        <div className="flex min-h-0 flex-1">
          {/* The order column, when it belongs on the left. Same node, same
              props, same component instance shape - only the position differs. */}
          {!layout.cartAsDrawer && props.cartSide === "left" && (
            <aside style={{ width: layout.cartWidth ?? 360 }} className="min-h-0 shrink-0">
              {props.cart(layout)}
            </aside>
          )}

          <main className="flex min-h-0 min-w-0 flex-1 flex-col p-3">{props.work(layout)}</main>

          {!layout.cartAsDrawer && props.cartSide !== "left" && (
            <aside style={{ width: layout.cartWidth ?? 360 }} className="min-h-0 shrink-0">
              {props.cart(layout)}
            </aside>
          )}
        </div>

        {/* Below the fixed-cart threshold: the total and Pay stay on screen -
            but only for a mode that has something to settle. */}
        {layout.cartAsDrawer && props.cartSummary && (
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
            <Button
              size="lg"
              onClick={props.cartSummary.onPay}
              disabled={props.cartSummary.payDisabled}
              title={props.cartSummary.payReason ?? undefined}
            >
              {props.cartSummary.payLabel ?? "Pay"}
            </Button>
          </div>
        )}

        <PosFooterBar ready={props.ready} online={props.online} pendingSync={props.pendingSync} />
      </div>

      <Drawer
        open={layout.cartAsDrawer && props.cartDrawerOpen}
        title={props.cartTitle ?? "Current order"}
        width={380}
        onClose={() => props.onCartDrawerChange(false)}
      >
        {props.cart(layout)}
      </Drawer>
    </div>
  );
}

function RailAction(props: {
  expanded: boolean;
  glyph: GlyphName;
  label: string;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      title={props.title}
      aria-label={props.label}
      className={cn(
        "flex min-h-[44px] w-full items-center gap-3 rounded-xl px-3 text-sm font-semibold text-sub transition hover:bg-slate-50 hover:text-ink",
        !props.expanded && "justify-center px-0",
      )}
    >
      <Glyph name={props.glyph} size={18} className="shrink-0" />
      {props.expanded && <span className="truncate">{props.label}</span>}
    </button>
  );
}
