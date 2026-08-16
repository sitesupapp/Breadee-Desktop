// One assigned menu icon, drawn in the surrounding text colour.
//
// `currentColor` IS THE THEME INTEGRATION. There is no theme prop, no palette
// lookup and no per-theme asset: the glyph takes the colour of whatever text it
// sits beside, so Classic Green draws it in ink, Black Ember draws it light on
// charcoal, and Oriental Majlis in its own. One asset, ten themes, nothing
// stored.
//
// `aria-hidden`, always. An icon on a menu button is decoration beside a name
// that is already read out; announcing "burger, Classic Burger" would make the
// button worse for a screen reader, not better.
//
// THE STYLE SETTING IS A TREATMENT, NOT A SECOND DRAWING - see
// `lib/icons/display.ts` for why a stroke path cannot simply be filled. Filled
// puts the same glyph on a soft brand tile, which is a theme token and therefore
// still correct everywhere.

import { ICON_BY_KEY } from "@/lib/icons/catalog";
import {
  DEFAULT_ICON_DISPLAY,
  ICON_PIXELS,
  ICON_TILE_PIXELS,
  type IconDisplay,
} from "@/lib/icons/display";
import { cn } from "@/components/ui";

export function PosIconGlyph({
  iconKey,
  size = 18,
  className,
}: {
  iconKey: string;
  size?: number;
  className?: string;
}) {
  const icon = ICON_BY_KEY[iconKey];
  if (!icon) return null;
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
      focusable="false"
    >
      <path d={icon.path} />
    </svg>
  );
}

/**
 * The glyph as a menu button actually shows it, honouring the display settings.
 *
 * Used by the POS menu card AND by the Icons Gallery preview, so what an
 * operator approves in Settings is what the till renders - a preview drawn by a
 * second component is a preview of something else.
 */
export function PosIconMark({
  iconKey,
  display = DEFAULT_ICON_DISPLAY,
  className,
}: {
  iconKey: string;
  display?: IconDisplay;
  className?: string;
}) {
  if (!ICON_BY_KEY[iconKey]) return null;
  const px = ICON_PIXELS[display.size];

  if (display.style === "filled") {
    const tile = ICON_TILE_PIXELS[display.size];
    return (
      <span
        style={{ width: tile, height: tile }}
        className={cn("flex shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand-dark", className)}
      >
        <PosIconGlyph iconKey={iconKey} size={px} />
      </span>
    );
  }

  return (
    <span
      style={{ width: ICON_TILE_PIXELS[display.size], height: ICON_TILE_PIXELS[display.size] }}
      className={cn("flex shrink-0 items-center justify-center text-sub", className)}
    >
      <PosIconGlyph iconKey={iconKey} size={px} />
    </span>
  );
}
