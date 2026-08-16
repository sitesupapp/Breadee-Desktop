// One icon, drawn in the surrounding text colour.
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

import { ICON_BY_KEY } from "@/lib/icons/catalog";

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
