// The theme token vocabulary.
//
// WHY TOKENS AND NOT A STYLESHEET PER THEME. The desktop app already had a
// semantic colour layer - `brand`, `ink`, `sub`, `line` - and thirty-odd raw
// Tailwind palette classes on top of it (`bg-white`, `text-red-700`,
// `bg-slate-50`, ...). Ten hand-written stylesheets would have meant ten copies
// of every component's colour decisions, and the tenth copy is where a button
// goes missing. Instead each of those class names is redefined ONCE, in
// `tailwind.config.ts`, as `rgb(var(--c-…) / <alpha-value>)`. A theme is then
// nothing but a set of numbers, and switching one rewrites a few dozen custom
// properties on `<html>`.
//
// THE CONSEQUENCE THAT MATTERS: a theme cannot move, hide, resize or disable
// anything, because a theme has no way to express layout, spacing, display or
// pointer behaviour. There is no selector, no rule and no class in a theme -
// only colour channels. `test/desktop-themes.test.ts` asserts that property
// directly against these definitions rather than trusting the prose.
//
// WHY "R G B" STRINGS. Tailwind's `<alpha-value>` placeholder needs the channels
// unwrapped so `bg-brand/40` and `text-sub/70` keep working. A hex value in the
// variable would break every opacity modifier already in the codebase.

/**
 * Colour roles a theme must supply.
 *
 * Named for what they DO, never for what they look like: `surfaceMuted` is the
 * quiet background behind a panel, and calling it `slate50` would be a lie in
 * nine themes out of ten.
 */
export const CORE_TOKENS = [
  /** The page behind everything. `body` background. */
  "canvas",
  /** Cards, panels, modals, inputs - anything that sits on the canvas. */
  "surface",
  /** A quiet fill on top of a surface (`bg-slate-50`). */
  "surfaceMuted",
  /** A chip or an inset region (`bg-slate-100`). */
  "surfaceSubtle",
  /** A pressed/hover fill, and the skeleton shimmer (`bg-slate-200`). */
  "surfaceStrong",
  /** Faint marks and disabled glyphs (`*-slate-300`). */
  "neutral300",
  /** Secondary dots and de-emphasised text (`*-slate-400`). */
  "neutral400",
  /** Secondary body text (`text-slate-600`). */
  "neutral600",
  /** Strong secondary text (`text-slate-700`). */
  "neutral700",
  /** Hairlines and control borders. */
  "line",
  /** Primary text. */
  "ink",
  /** Secondary text. */
  "sub",
  /** The identity colour: primary buttons, focus rings, active nav. */
  "brand",
  /**
   * The identity colour's high-contrast partner.
   *
   * Used BOTH as a hover fill on a brand button and as TEXT on `brandSoft`, so
   * a dark theme legitimately makes this LIGHTER than `brand` - the role is
   * "the readable one against brandSoft", not "the darker one".
   */
  "brandDark",
  /** The identity colour's quiet tint, always paired with `brandDark` text. */
  "brandSoft",
  /** Text and glyphs drawn on top of a `brand` or `danger` fill. */
  "onBrand",
  /** The modal scrim. Near-black in every theme; it is not a palette choice. */
  "black",
] as const;

export type CoreToken = (typeof CORE_TOKENS)[number];

/**
 * Status roles, which are DELIBERATELY not per-theme.
 *
 * An error must look like an error on every terminal in the estate. A theme
 * that could recolour `danger` would be a theme that could make a refused
 * payment look like a successful one, so themes choose a status SET (light or
 * dark, for legibility) and never the individual values.
 */
export const STATUS_TOKENS = [
  "danger50",
  "danger100",
  "danger200",
  "danger300",
  "danger500",
  "danger600",
  "danger700",
  "danger800",
  "danger900",
  "warning50",
  "warning100",
  "warning200",
  "warning300",
  "warning400",
  "warning500",
  "warning600",
  "warning700",
  "warning800",
  "warning900",
  "info50",
  "info100",
  "info200",
  "info500",
  "info800",
] as const;

export type StatusToken = (typeof STATUS_TOKENS)[number];
export type ThemeToken = CoreToken | StatusToken;

export const ALL_TOKENS: readonly ThemeToken[] = [...CORE_TOKENS, ...STATUS_TOKENS];

/** `canvas` -> `--c-canvas`, `surfaceMuted` -> `--c-surface-muted`. */
export function cssVarName(token: ThemeToken): string {
  return `--c-${token.replace(/([a-z])([A-Z0-9])/g, "$1-$2").toLowerCase()}`;
}

/**
 * Space-separated 8-bit channels, e.g. `"22 163 74"`.
 *
 * A branded string rather than `string` so a hex value cannot be assigned to a
 * token by accident - which would silently disable every `/40` opacity
 * modifier in the app rather than failing loudly.
 */
export type Rgb = string;

/** `#16a34a` -> `"22 163 74"`. Throws on anything that is not a 6-digit hex. */
export function hexToRgb(hex: string): Rgb {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) throw new Error(`Theme colours must be 6-digit hex, got "${hex}"`);
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

/** `"22 163 74"` -> `#16a34a`, for swatches and the preview. */
export function rgbToHex(rgb: Rgb): string {
  const [r, g, b] = rgb.split(/\s+/).map((n) => Number(n));
  const to2 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${to2(r)}${to2(g)}${to2(b)}`;
}

/**
 * Relative luminance, per WCAG 2.x.
 *
 * Present so the readability of every theme is a TEST, not a designer's
 * assurance: `test/desktop-themes.test.ts` walks the ink/surface and
 * brandDark/brandSoft pairs of all ten themes and fails the build on any
 * combination a cashier would have to squint at.
 */
export function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.split(/\s+/).map((n) => Number(n) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two token values, 1..21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}
