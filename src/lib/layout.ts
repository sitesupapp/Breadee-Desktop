// The POS layout model.
//
// Breakpoints are driven by the OBSERVED window width in CSS pixels, which is
// what Windows display scaling actually changes: a 1366x768 panel at 150% scaling
// reports ~910 CSS px, so a viewport-only media query would silently hand a
// cashier the wrong layout. Measuring means 1366@150% and 910@100% behave the
// same, which is the correct outcome.
//
// The contract every tier must honour: the cart is ALWAYS reachable, the cart
// total and Pay are ALWAYS visible, and the page itself never scrolls
// horizontally.

export type LayoutTier = "xs" | "sm" | "md" | "lg" | "xl" | "xxl";

export type LayoutSpec = {
  tier: LayoutTier;
  /** Navigation rail: full labels or icon-only. */
  railExpanded: boolean;
  /** Menu grid columns. */
  menuColumns: number;
  /** Fixed cart width in px; null when the cart becomes an overlay drawer. */
  cartWidth: number | null;
  /** True below the fixed-cart threshold - cart opens as a right-edge drawer. */
  cartAsDrawer: boolean;
};

/** Below this the layout is guarded rather than rendered broken. */
export const MIN_SUPPORTED_WIDTH = 800;
export const MIN_SUPPORTED_HEIGHT = 560;

/**
 * Resolve the layout for a measured width.
 *
 * 1920+      expanded rail, 6 columns, 420 cart
 * 1600-1919  expanded rail, 5 columns, 400 cart
 * 1440-1599  compact rail,  4 columns, 380 cart
 * 1280-1439  compact rail,  4 columns, 360 cart
 * 1024-1279  compact rail,  3 columns, 340 cart   <- cart must NOT wrap here
 * <1024      compact rail,  2 columns, cart drawer + persistent total/Pay bar
 */
export function resolveLayout(width: number): LayoutSpec {
  const w = Number.isFinite(width) ? width : 0;
  if (w >= 1920) return { tier: "xxl", railExpanded: true, menuColumns: 6, cartWidth: 420, cartAsDrawer: false };
  if (w >= 1600) return { tier: "xl", railExpanded: true, menuColumns: 5, cartWidth: 400, cartAsDrawer: false };
  if (w >= 1440) return { tier: "lg", railExpanded: false, menuColumns: 4, cartWidth: 380, cartAsDrawer: false };
  if (w >= 1280) return { tier: "md", railExpanded: false, menuColumns: 4, cartWidth: 360, cartAsDrawer: false };
  if (w >= 1024) return { tier: "sm", railExpanded: false, menuColumns: 3, cartWidth: 340, cartAsDrawer: false };
  return { tier: "xs", railExpanded: false, menuColumns: 2, cartWidth: null, cartAsDrawer: true };
}

export function isTooSmall(width: number, height: number): boolean {
  return width < MIN_SUPPORTED_WIDTH || height < MIN_SUPPORTED_HEIGHT;
}

/**
 * Rail widths in px.
 *
 * Declared here rather than in the shell because `railWidth` is what the layout
 * test measures the remaining work area against; two copies of these numbers
 * would let the shell get narrower while the test kept checking the old figure.
 * The expanded rail is narrower than it once was: labels now sit beside glyphs
 * rather than beside a letter, so the same text needs less box.
 */
export const RAIL_EXPANDED_PX = 200;
export const RAIL_COLLAPSED_PX = 76;

/** Rail width in px for a tier - used by the shell grid and the status bar offset. */
export function railWidth(spec: LayoutSpec): number {
  return spec.railExpanded ? RAIL_EXPANDED_PX : RAIL_COLLAPSED_PX;
}
