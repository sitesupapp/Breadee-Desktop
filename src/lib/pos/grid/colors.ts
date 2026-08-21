// Button colours for the customized cashier grid.
//
// WHY A TOKEN PAIR AND NOT A HEX. A layout stores `{ hue: "amber", shade: 500 }`
// and never `#f59e0b`. The stored value is therefore a NAME for a colour rather
// than the colour itself, which is what lets a future theme - or a future
// palette revision - resolve it differently without rewriting every layout in
// the field. A stored hex would be a decision frozen at the moment somebody
// clicked a swatch.
//
// WHY THE FILL IS EXPLICIT AND NOT A THEME TOKEN. This is the one deliberate
// exception to "every colour is a theme token", and the reason is what these
// colours are FOR. A cashier's red key is red the way a physical key cap is red:
// it is a landmark they hit without reading it, and a theme that recoloured it
// would move the landmark. So a chosen key colour looks the same on every theme,
// light and dark, and only its INK is computed.
//
// READABILITY IS COMPUTED, NEVER CHOSEN. `inkFor` picks whichever of the two ink
// values contrasts better with the fill, using the SAME `contrastRatio` the
// theme tests use. That is what makes "readable in light and dark" a property
// rather than a hope: the fill does not change with the theme, and its ink is
// derived from the fill. `test/pos-custom-grid.test.ts` walks all sixty
// combinations and fails the build on any that misses WCAG AA.
//
// AN UNCOLOURED BUTTON IS FULLY THEMED. `null` means "use the terminal's theme",
// and such a button renders with `bg-white` / `text-ink` / `border-line` like
// every other surface in the app - so a customer who never picks a colour gets a
// grid that follows their theme exactly.

import { contrastRatio, hexToRgb } from "@/lib/theme/tokens";
import type { GridColorRef } from "@/lib/pos/grid/model";

/** The two inks a fill may be drawn with. Nothing else is offered. */
export const INK_LIGHT = "#ffffff";
export const INK_DARK = "#0b0b0f";

/** WCAG AA for large, bold text. Every combination below clears it. */
export const MIN_BUTTON_CONTRAST = 4.5;

export type GridHue = {
  key: string;
  label: string;
  /** Fill per shade. Five steps from a pale tint to a deep fill. */
  shades: Record<number, string>;
};

export const SHADES = [200, 400, 500, 600, 800] as const;
export type GridShade = (typeof SHADES)[number];

/**
 * Twelve hues, five shades each.
 *
 * Sixty choices rather than "a handful", which was the point: a restaurant
 * grouping twenty counter items needs enough distinct landmarks that two
 * neighbouring buttons never look alike. The values are the familiar Tailwind
 * ramps, so a manager who has seen the web app recognises them.
 */
export const HUES: GridHue[] = [
  { key: "slate", label: "Slate", shades: { 200: "#e2e8f0", 400: "#94a3b8", 500: "#64748b", 600: "#475569", 800: "#1e293b" } },
  { key: "red", label: "Red", shades: { 200: "#fecaca", 400: "#f87171", 500: "#ef4444", 600: "#dc2626", 800: "#991b1b" } },
  { key: "orange", label: "Orange", shades: { 200: "#fed7aa", 400: "#fb923c", 500: "#f97316", 600: "#ea580c", 800: "#9a3412" } },
  { key: "amber", label: "Amber", shades: { 200: "#fde68a", 400: "#fbbf24", 500: "#f59e0b", 600: "#d97706", 800: "#92400e" } },
  { key: "green", label: "Green", shades: { 200: "#bbf7d0", 400: "#4ade80", 500: "#22c55e", 600: "#16a34a", 800: "#166534" } },
  { key: "emerald", label: "Emerald", shades: { 200: "#a7f3d0", 400: "#34d399", 500: "#10b981", 600: "#059669", 800: "#065f46" } },
  { key: "teal", label: "Teal", shades: { 200: "#99f6e4", 400: "#2dd4bf", 500: "#14b8a6", 600: "#0d9488", 800: "#115e59" } },
  { key: "cyan", label: "Cyan", shades: { 200: "#a5f3fc", 400: "#22d3ee", 500: "#06b6d4", 600: "#0891b2", 800: "#155e75" } },
  { key: "blue", label: "Blue", shades: { 200: "#bfdbfe", 400: "#60a5fa", 500: "#3b82f6", 600: "#2563eb", 800: "#1e40af" } },
  // Indigo's mid step is deliberately a shade darker than the familiar ramp.
  // The usual value sits in the dead band where NEITHER ink reaches AA (4.47:1
  // against white, 4.40:1 against near-black); a key nobody can read at arm's
  // length is not a colour choice worth offering. The contrast walk in
  // `pos-custom-grid.test.ts` is what found it and what keeps it fixed.
  { key: "indigo", label: "Indigo", shades: { 200: "#c7d2fe", 400: "#818cf8", 500: "#5b5fe8", 600: "#4f46e5", 800: "#3730a3" } },
  { key: "violet", label: "Violet", shades: { 200: "#ddd6fe", 400: "#a78bfa", 500: "#8b5cf6", 600: "#7c3aed", 800: "#5b21b6" } },
  { key: "pink", label: "Pink", shades: { 200: "#fbcfe8", 400: "#f472b6", 500: "#ec4899", 600: "#db2777", 800: "#9d174d" } },
];

const HUE_BY_KEY = new Map(HUES.map((h) => [h.key, h]));

export function isGridShade(value: unknown): value is GridShade {
  return typeof value === "number" && (SHADES as readonly number[]).includes(value);
}

/**
 * The fill for a stored reference, or null for "use the theme".
 *
 * An unrecognised hue or shade resolves to null rather than to a guessed colour:
 * a button drawn in a colour nobody chose is worse than one drawn in the theme's
 * own, and the reference is left intact so a later build that knows the hue can
 * still honour it.
 */
export function fillFor(ref: GridColorRef): string | null {
  if (!ref) return null;
  const hue = HUE_BY_KEY.get(ref.hue);
  if (!hue) return null;
  return hue.shades[ref.shade] ?? null;
}

/** The readable ink for a fill, by measured contrast. Never a stored choice. */
export function inkFor(fill: string): string {
  const rgb = hexToRgb(fill);
  const onLight = contrastRatio(rgb, hexToRgb(INK_LIGHT));
  const onDark = contrastRatio(rgb, hexToRgb(INK_DARK));
  return onDark >= onLight ? INK_DARK : INK_LIGHT;
}

/** The contrast a fill achieves with the ink that would be chosen for it. */
export function achievedContrast(fill: string): number {
  return contrastRatio(hexToRgb(fill), hexToRgb(inkFor(fill)));
}

/**
 * A quieter version of the ink, for the price line under the name.
 *
 * Not a third colour - the same ink at reduced opacity, so it can never fail
 * contrast independently of the label above it.
 */
export const SECONDARY_INK_OPACITY = 0.82;

export type ResolvedButtonColor = {
  /** Null means "draw with theme classes", which is the uncoloured default. */
  fill: string | null;
  ink: string | null;
};

export function resolveColor(ref: GridColorRef): ResolvedButtonColor {
  const fill = fillFor(ref);
  return fill ? { fill, ink: inkFor(fill) } : { fill: null, ink: null };
}

/** Every offered combination, for the swatch picker and for the test. */
export function allCombinations(): { hue: string; shade: GridShade; fill: string }[] {
  const out: { hue: string; shade: GridShade; fill: string }[] = [];
  for (const hue of HUES) {
    for (const shade of SHADES) {
      const fill = hue.shades[shade];
      if (fill) out.push({ hue: hue.key, shade, fill });
    }
  }
  return out;
}
