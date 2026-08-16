// The ten themes.
//
// APPEARANCE ONLY, AND STRUCTURALLY SO. Each theme is a record of colour
// channels keyed by the roles declared in `tokens.ts`. There is no field here
// for a font size, a radius, a spacing, a border width, a shadow, a z-index or
// a display mode - so no theme can move a Pay button, shrink a touch target or
// hide a CTA. That is not a promise made in prose; it is the shape of the type.
//
// `mode` selects a STATUS SET, not a look. A dark theme needs `bg-red-50` to be
// a dark red wash and `text-red-700` to be a light red, or an error message
// becomes unreadable. Both sets keep the same MEANING at the same class name:
// low indices are fills, high indices are text.

import { hexToRgb, type CoreToken, type Rgb, type StatusToken } from "@/lib/theme/tokens";

export type ThemeMode = "light" | "dark";

export type ThemeDefinition = {
  id: ThemeId;
  name: string;
  /** One line, shown on the theme card. */
  description: string;
  mode: ThemeMode;
  colors: Record<CoreToken, Rgb>;
};

export const THEME_IDS = [
  "classic-green",
  "coffee-house",
  "snack-bar",
  "oriental-majlis",
  "lebanese-bistro",
  "turkish-kitchen",
  "funky-street",
  "casual-diner",
  "black-ember",
  "fresh-garden",
] as const;

export type ThemeId = (typeof THEME_IDS)[number];

/**
 * The theme an installation has when it has never chosen one.
 *
 * Classic Green reproduces the pre-theme appearance token for token, so an
 * existing terminal that updates sees no visual change at all until somebody
 * deliberately activates something else. `test/desktop-themes.test.ts` pins its
 * values against the palette the app shipped with.
 */
export const DEFAULT_THEME_ID: ThemeId = "classic-green";

type HexCore = Record<CoreToken, string>;

function core(hex: HexCore): Record<CoreToken, Rgb> {
  const out = {} as Record<CoreToken, Rgb>;
  for (const [k, v] of Object.entries(hex)) out[k as CoreToken] = hexToRgb(v);
  return out;
}

/* -------------------------------------------------------------------------- */
/* Status sets                                                                 */
/* -------------------------------------------------------------------------- */

const LIGHT_STATUS: Record<StatusToken, string> = {
  danger50: "#fef2f2",
  danger100: "#fee2e2",
  danger200: "#fecaca",
  danger300: "#fca5a5",
  danger500: "#ef4444",
  danger600: "#dc2626",
  danger700: "#b91c1c",
  danger800: "#991b1b",
  danger900: "#7f1d1d",
  warning50: "#fffbeb",
  warning100: "#fef3c7",
  warning200: "#fde68a",
  warning300: "#fcd34d",
  warning400: "#fbbf24",
  warning500: "#f59e0b",
  warning600: "#d97706",
  warning700: "#b45309",
  warning800: "#92400e",
  warning900: "#78350f",
  info50: "#f0f9ff",
  info100: "#e0f2fe",
  info200: "#bae6fd",
  info500: "#0ea5e9",
  info800: "#075985",
};

/**
 * The dark status set.
 *
 * Read it as a MIRROR of the light one rather than as new colours: the low
 * indices (fills) become dark washes and the high indices (text) become light,
 * so `bg-red-50 text-red-700` - the pairing used throughout the app for a
 * failure notice - stays a red notice with legible red text instead of light
 * red text on a light red field.
 */
const DARK_STATUS: Record<StatusToken, string> = {
  danger50: "#3a1416",
  danger100: "#4a1a1d",
  danger200: "#5e2226",
  danger300: "#7f3033",
  danger500: "#ef4444",
  danger600: "#f87171",
  danger700: "#fca5a5",
  danger800: "#fdb4b4",
  danger900: "#fecaca",
  warning50: "#33260b",
  warning100: "#42320f",
  warning200: "#553f13",
  warning300: "#6f521a",
  warning400: "#a87a22",
  warning500: "#f59e0b",
  warning600: "#fbbf24",
  warning700: "#fcd34d",
  warning800: "#fde68a",
  warning900: "#fef3c7",
  info50: "#0c2b3a",
  info100: "#123a4e",
  info200: "#1b5270",
  info500: "#38bdf8",
  info800: "#bae6fd",
};

export const STATUS_SETS: Record<ThemeMode, Record<StatusToken, Rgb>> = {
  light: Object.fromEntries(Object.entries(LIGHT_STATUS).map(([k, v]) => [k, hexToRgb(v)])) as Record<
    StatusToken,
    Rgb
  >,
  dark: Object.fromEntries(Object.entries(DARK_STATUS).map(([k, v]) => [k, hexToRgb(v)])) as Record<StatusToken, Rgb>,
};

/* -------------------------------------------------------------------------- */
/* The themes                                                                  */
/* -------------------------------------------------------------------------- */

export const THEMES: Record<ThemeId, ThemeDefinition> = {
  // The pre-theme appearance, unchanged. Every value below is the literal one
  // the app shipped with (Tailwind slate + the web app's brand green), so an
  // updated installation looks identical until somebody picks something else.
  "classic-green": {
    id: "classic-green",
    name: "Classic Green",
    description: "Clean green and white. The default Breadee identity.",
    mode: "light",
    colors: core({
      canvas: "#f8fafc",
      surface: "#ffffff",
      surfaceMuted: "#f8fafc",
      surfaceSubtle: "#f1f5f9",
      surfaceStrong: "#e2e8f0",
      neutral300: "#cbd5e1",
      neutral400: "#94a3b8",
      neutral600: "#475569",
      neutral700: "#334155",
      line: "#e2e8f0",
      ink: "#0f172a",
      sub: "#64748b",
      brand: "#16a34a",
      brandDark: "#15803d",
      brandSoft: "#dcfce7",
      onBrand: "#ffffff",
      black: "#000000",
    }),
  },

  "coffee-house": {
    id: "coffee-house",
    name: "Coffee House",
    description: "Espresso and mocha on warm cream, with a caramel accent.",
    mode: "light",
    colors: core({
      canvas: "#f5efe6",
      surface: "#fffbf5",
      surfaceMuted: "#f3eadd",
      surfaceSubtle: "#eadcc9",
      surfaceStrong: "#dfcbb0",
      neutral300: "#cdb79c",
      neutral400: "#a98f73",
      neutral600: "#6b5340",
      neutral700: "#4a3625",
      line: "#e0d2be",
      ink: "#2e1c10",
      sub: "#7a6350",
      brand: "#7a5230",
      brandDark: "#4a3324",
      brandSoft: "#f0dec6",
      onBrand: "#fff8ef",
      black: "#000000",
    }),
  },

  "snack-bar": {
    id: "snack-bar",
    name: "Snack Bar",
    description: "Energetic red and warm orange on off-white.",
    mode: "light",
    colors: core({
      canvas: "#fff8f0",
      surface: "#ffffff",
      surfaceMuted: "#fff1e3",
      surfaceSubtle: "#ffe3cc",
      surfaceStrong: "#ffd2ae",
      neutral300: "#e9c7a6",
      neutral400: "#c79a6d",
      neutral600: "#7a4a22",
      neutral700: "#5c3617",
      line: "#f5dcc6",
      ink: "#2b1608",
      sub: "#8a5a35",
      brand: "#e03131",
      brandDark: "#a51f1f",
      brandSoft: "#ffe2d5",
      onBrand: "#ffffff",
      black: "#000000",
    }),
  },

  "oriental-majlis": {
    id: "oriental-majlis",
    name: "Oriental Majlis",
    description: "Burgundy and sand with muted gold. An elegant heritage feel.",
    mode: "light",
    colors: core({
      canvas: "#f3ebd9",
      surface: "#fffcf4",
      surfaceMuted: "#efe4cc",
      surfaceSubtle: "#e6d8ba",
      surfaceStrong: "#d9c79e",
      neutral300: "#cdbb94",
      neutral400: "#a98f63",
      neutral600: "#6b4d36",
      neutral700: "#4e3626",
      line: "#dccba6",
      ink: "#2e1119",
      sub: "#7c5a45",
      brand: "#6d1f32",
      brandDark: "#4a1122",
      brandSoft: "#f0dfd0",
      onBrand: "#fbf3e4",
      black: "#000000",
    }),
  },

  "lebanese-bistro": {
    id: "lebanese-bistro",
    name: "Lebanese Bistro",
    description: "Deep green on warm white, with a subtle red accent.",
    mode: "light",
    colors: core({
      canvas: "#fbf8f1",
      surface: "#ffffff",
      surfaceMuted: "#f3f1e7",
      surfaceSubtle: "#e8e7d9",
      surfaceStrong: "#d9dac8",
      neutral300: "#c4c8b8",
      neutral400: "#97a08f",
      neutral600: "#4c5a4d",
      neutral700: "#35423a",
      line: "#e1e0d0",
      ink: "#14201a",
      sub: "#5c6b5e",
      brand: "#14532d",
      brandDark: "#0c3b20",
      brandSoft: "#dcebdf",
      onBrand: "#ffffff",
      black: "#000000",
    }),
  },

  "turkish-kitchen": {
    id: "turkish-kitchen",
    name: "Turkish Kitchen",
    description: "Deep teal and copper on cream.",
    mode: "light",
    colors: core({
      canvas: "#fbf3e4",
      surface: "#fffdf7",
      surfaceMuted: "#f2e9d6",
      surfaceSubtle: "#e6dbc4",
      surfaceStrong: "#d7c9ac",
      neutral300: "#cbbb9d",
      neutral400: "#a3926f",
      neutral600: "#5d5a44",
      neutral700: "#413f2e",
      line: "#e0d5bc",
      ink: "#102b2b",
      sub: "#5e6e68",
      brand: "#0f4c4c",
      brandDark: "#093636",
      brandSoft: "#d7e7e4",
      onBrand: "#fbf3e4",
      black: "#000000",
    }),
  },

  "funky-street": {
    id: "funky-street",
    name: "Funky Street",
    description: "Deep purple with vivid lime accents. Contemporary street food.",
    mode: "light",
    colors: core({
      canvas: "#f6f3ff",
      surface: "#ffffff",
      surfaceMuted: "#efe9ff",
      surfaceSubtle: "#e3d9ff",
      surfaceStrong: "#d2c4f7",
      neutral300: "#c9bee4",
      neutral400: "#9c8cc4",
      neutral600: "#5a4a7c",
      neutral700: "#40325c",
      line: "#ddd3f5",
      ink: "#1e1033",
      sub: "#6b5a8e",
      brand: "#5b21b6",
      brandDark: "#3d1183",
      // The lime is the accent, and it lands where an accent belongs: the quiet
      // tint behind `brandDark` text, not the fill behind white text - lime is
      // far too light to carry `onBrand` legibly.
      brandSoft: "#e7ffbf",
      onBrand: "#f7f2ff",
      black: "#000000",
    }),
  },

  "casual-diner": {
    id: "casual-diner",
    name: "Casual Diner",
    description: "Modern blue with soft red accents on neutral white.",
    mode: "light",
    colors: core({
      canvas: "#f5f7fb",
      surface: "#ffffff",
      surfaceMuted: "#eef2f9",
      surfaceSubtle: "#e2e9f5",
      surfaceStrong: "#cfdaec",
      neutral300: "#c2cee2",
      neutral400: "#92a2be",
      neutral600: "#43536b",
      neutral700: "#2e3b4f",
      line: "#dce4f0",
      ink: "#101b2d",
      sub: "#5a6b85",
      brand: "#1d4ed8",
      brandDark: "#1739a8",
      brandSoft: "#dde7ff",
      onBrand: "#ffffff",
      black: "#000000",
    }),
  },

  "black-ember": {
    id: "black-ember",
    name: "Black Ember",
    description: "Charcoal and black with an ember orange accent. A premium dark POS.",
    mode: "dark",
    colors: core({
      canvas: "#0e0e10",
      surface: "#1a1a1d",
      surfaceMuted: "#232327",
      surfaceSubtle: "#2c2c31",
      surfaceStrong: "#3a3a41",
      // `neutral300`/`neutral400` are faint TEXT as well as a status dot fill,
      // so on charcoal they go lighter, not darker - a faint grey that reads as
      // "de-emphasised" on white simply disappears here.
      neutral300: "#6f6f79",
      neutral400: "#8a8a94",
      // `neutral600`/`neutral700` are only ever text, so on a dark surface they
      // are the LIGHTEST neutrals. Their names describe a Tailwind index, not a
      // brightness.
      neutral600: "#d4d4d8",
      neutral700: "#e4e4e7",
      line: "#35353b",
      ink: "#f4f4f5",
      sub: "#a1a1aa",
      brand: "#f97316",
      // Lighter than `brand`, deliberately: this token's job is to be readable
      // against `brandSoft`, and it doubles as the "lift on hover" fill that a
      // dark UI expects.
      brandDark: "#fdba74",
      brandSoft: "#3a2410",
      onBrand: "#160c02",
      black: "#000000",
    }),
  },

  "fresh-garden": {
    id: "fresh-garden",
    name: "Fresh Garden",
    description: "Natural greens on ivory with soft neutral tones.",
    mode: "light",
    colors: core({
      canvas: "#faf8ef",
      surface: "#ffffff",
      surfaceMuted: "#f2f5ec",
      surfaceSubtle: "#e7eedf",
      surfaceStrong: "#d6e2cb",
      neutral300: "#c6d2bc",
      neutral400: "#9bab94",
      neutral600: "#4e5d4b",
      neutral700: "#384435",
      line: "#e2e8d8",
      ink: "#17251a",
      sub: "#61705f",
      brand: "#3f7d4e",
      brandDark: "#2e6039",
      brandSoft: "#dff0df",
      onBrand: "#ffffff",
      black: "#000000",
    }),
  },
};

/** The themes in the order the settings screen shows them. */
export const THEME_LIST: ThemeDefinition[] = THEME_IDS.map((id) => THEMES[id]);

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && (THEME_IDS as readonly string[]).includes(value);
}

/** Unknown/absent ids resolve to the default rather than throwing. */
export function themeById(id: unknown): ThemeDefinition {
  return isThemeId(id) ? THEMES[id] : THEMES[DEFAULT_THEME_ID];
}

/**
 * The five colours shown as swatches on a theme card.
 *
 * Chosen to be the ones an operator would actually recognise the theme by, in
 * the order they dominate the screen.
 */
export function swatches(theme: ThemeDefinition): Rgb[] {
  return [
    theme.colors.brand,
    theme.colors.brandSoft,
    theme.colors.canvas,
    theme.colors.surface,
    theme.colors.ink,
  ];
}
