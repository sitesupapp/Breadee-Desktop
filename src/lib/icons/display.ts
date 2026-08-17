// How assigned icons are DRAWN, for this terminal.
//
// TWO SETTINGS, AND DELIBERATELY NOT MORE. Style and size. There is no per-item
// colour, and there will not be one: a theme owns colour, and an icon that
// carried its own would be the one element on a menu button that ignored the
// theme the operator chose - visible immediately on Black Ember, where a
// hard-coded dark glyph disappears into the card.
//
// WHY "FILLED" IS A TREATMENT AND NOT A SECOND ASSET SET. Every icon in the
// catalogue is an OPEN stroke path; handing one to `fill` does not produce a
// solid version of the drawing, it produces a blob where the counters were. A
// genuinely filled family would be a second path per concept - a second
// catalogue to draw, review and keep in step with the first, which is exactly
// what "one asset per concept" was chosen to avoid. So Filled means the glyph
// sits on a filled tile in the theme's soft brand tint, which reads as a solid
// button at a glance, stays legible in all ten themes, and costs nothing.
//
// STORED BESIDE THE ASSIGNMENTS, for the same reason and with the same cost:
// this is a per-terminal display preference, it needs no migration, and it does
// not travel to another till. See `assignments.ts`.

export const ICON_DISPLAY_KEY = "breadee.desktop.iconDisplay";

export type IconStyle = "outline" | "filled";
export type IconSize = "s" | "m" | "l" | "xl";

export type IconDisplay = {
  style: IconStyle;
  size: IconSize;
};

/** Outline, Medium - the documented defaults. */
export const DEFAULT_ICON_DISPLAY: IconDisplay = { style: "outline", size: "m" };

export const ICON_STYLES: { value: IconStyle; label: string }[] = [
  { value: "outline", label: "Outline" },
  { value: "filled", label: "Filled" },
];

export const ICON_SIZES: { value: IconSize; label: string }[] = [
  { value: "s", label: "S" },
  { value: "m", label: "M" },
  { value: "l", label: "L" },
  { value: "xl", label: "XL" },
];

/**
 * Glyph pixel size per setting.
 *
 * The menu card is a fixed height, so the top of this range is bounded by what
 * fits beside a two-line item name rather than by taste.
 */
export const ICON_PIXELS: Record<IconSize, number> = { s: 16, m: 20, l: 24, xl: 30 };

/** The tile a Filled glyph sits on, sized so the glyph never touches its edge. */
export const ICON_TILE_PIXELS: Record<IconSize, number> = { s: 28, m: 34, l: 40, xl: 48 };

function isStyle(v: unknown): v is IconStyle {
  return v === "outline" || v === "filled";
}

function isSize(v: unknown): v is IconSize {
  return v === "s" || v === "m" || v === "l" || v === "xl";
}

/** Parse whatever is in storage, falling back per FIELD rather than wholesale. */
export function parseIconDisplay(raw: unknown): IconDisplay {
  if (typeof raw !== "string" || raw.trim() === "") return DEFAULT_ICON_DISPLAY;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return DEFAULT_ICON_DISPLAY;
    const rec = parsed as Record<string, unknown>;
    return {
      style: isStyle(rec.style) ? rec.style : DEFAULT_ICON_DISPLAY.style,
      size: isSize(rec.size) ? rec.size : DEFAULT_ICON_DISPLAY.size,
    };
  } catch {
    return DEFAULT_ICON_DISPLAY;
  }
}

export function readIconDisplay(storage?: Pick<Storage, "getItem">): IconDisplay {
  try {
    const store = storage ?? (typeof localStorage === "undefined" ? null : localStorage);
    return parseIconDisplay(store?.getItem(ICON_DISPLAY_KEY));
  } catch {
    return DEFAULT_ICON_DISPLAY;
  }
}

export function writeIconDisplay(
  next: IconDisplay,
  storage?: Pick<Storage, "getItem" | "setItem">,
): IconDisplay {
  const store = storage ?? (typeof localStorage === "undefined" ? null : localStorage);
  try {
    store?.setItem(ICON_DISPLAY_KEY, JSON.stringify(next));
  } catch {
    /* No storage: the choice applies to this session and is forgotten. */
  }
  return next;
}
