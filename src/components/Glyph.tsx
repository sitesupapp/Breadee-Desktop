// Interface glyphs - navigation, actions and status.
//
// SEPARATE FROM `PosIconGlyph`, AND THE SEPARATION IS MEANINGFUL. That component
// draws the FOOD catalogue an operator assigns to a menu item in Settings; this
// one draws the application's own chrome, which nobody configures. Merging them
// would put "Full screen" and "Close" in the Icons Gallery's search results as
// though a cashier could put a padlock on a burger.
//
// SAME DRAWING CONTRACT AS THE FOOD ICONS, on purpose: 24x24, stroke, no fill,
// `currentColor`. That is what makes the whole interface one visual family and
// what makes every glyph correct in all ten themes with no per-theme asset -
// a glyph is the colour of the text it sits beside, and the text colour is a
// theme token. There is no colour literal anywhere in this file.
//
// `aria-hidden`, always. Every glyph here sits beside its own visible label, or
// inside a control that already carries an accessible name; announcing the
// picture as well would make each of them read twice.

export type GlyphName =
  // POS navigation
  | "takeaway"
  | "dine-in"
  | "delivery"
  | "orders"
  // shell controls
  | "fullscreen"
  | "fullscreen-exit"
  | "close"
  | "collapse"
  | "expand"
  // actions
  | "pay"
  | "kitchen"
  | "print"
  | "trash"
  | "search"
  | "user"
  | "user-plus"
  | "drawer"
  | "clock"
  | "sync"
  | "phone"
  | "map-pin"
  | "history"
  | "edit"
  | "note"
  | "move"
  | "check"
  | "info"
  | "chevron-left"
  | "chevron-right"
  | "chevron-down"
  | "seats"
  | "grid"
  | "list"
  | "layers"
  | "bag";

/**
 * 24x24 stroke paths.
 *
 * One entry per name, each a single `d` string so a glyph is one `<path>` and
 * one draw. Kept in the same 1.6px-stroke idiom as the food catalogue.
 */
const GLYPHS: Record<GlyphName, string> = {
  takeaway: "M6 8h12l-1 11.2a2 2 0 0 1-2 1.8H9a2 2 0 0 1-2-1.8L6 8Zm3 0V6a3 3 0 0 1 6 0v2",
  "dine-in": "M4 10h16M5 10V7.5A1.5 1.5 0 0 1 6.5 6h11A1.5 1.5 0 0 1 19 7.5V10M6.5 14v6M17.5 14v6M4.5 14h15",
  delivery:
    "M7 18.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Zm11 0a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM9.5 16h6M6 13.5 8 7h3l3.5 9M13 7h3.5l2 6.5",
  orders: "M5 4.5h14v15H5v-15Zm3.5 4h7m-7 3.5h7m-7 3.5h4",
  fullscreen: "M4 9V4.5h5M20 9V4.5h-5M4 15v4.5h5M20 15v4.5h-5",
  "fullscreen-exit": "M9 4.5V9H4.5M15 4.5V9h4.5M9 19.5V15H4.5M15 19.5V15h4.5",
  close: "M9.5 5.5 4 11l5.5 5.5M4.5 11H16a4 4 0 0 1 0 8h-1.5",
  collapse: "M13.5 7 9.5 11l4 4M19 7l-4 4 4 4M5 5v12",
  expand: "M10.5 7l4 4-4 4M5 7l4 4-4 4M19 5v12",
  pay: "M3.5 7.5h17v10h-17v-10Zm0 3.5h17M6.5 15h3",
  kitchen: "M4 15.5h16M6 15.5a6 6 0 0 1 12 0M12 6.5v3M4.5 19h15",
  print: "M7 9.5V4.5h10v5M7 18.5H5.5A1.5 1.5 0 0 1 4 17v-5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v5a1.5 1.5 0 0 1-1.5 1.5H17M7 14.5h10v5H7v-5Z",
  trash: "M4.5 6.5h15M9.5 6.5V4.5h5v2M6.5 6.5l1 13h9l1-13M10 10v6M14 10v6",
  search: "M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13Zm4.7-1.8L20 20",
  user: "M12 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM5 20a7 7 0 0 1 14 0",
  "user-plus": "M10 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM3.5 20a6.5 6.5 0 0 1 13 0M18 9.5v5M15.5 12h5",
  drawer: "M3.5 11.5h17V18a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18v-6.5Zm1.5 0 1.5-6h11l1.5 6M10 15h4",
  clock: "M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17ZM12 7.5V12l3 2",
  sync: "M19.5 12a7.5 7.5 0 0 1-13 5M4.5 12a7.5 7.5 0 0 1 13-5M17.5 3.5V7h-3.5M6.5 20.5V17h3.5",
  phone: "M7.5 3.5h9v17h-9v-17Zm3.5 14h2",
  "map-pin": "M12 21s6.5-6 6.5-10.5a6.5 6.5 0 1 0-13 0C5.5 15 12 21 12 21Zm0-8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z",
  history: "M4 12a8 8 0 1 0 2.4-5.7M4 4.5V9h4.5M12 8v4.5l3 1.8",
  edit: "M4.5 19.5h4L19 9a2.1 2.1 0 0 0-3-3L5.5 16.5l-1 3ZM14.5 7.5l2 2",
  note: "M6 3.5h8L18.5 8v12.5h-12.5v-17Zm8 0V8h4.5M9 12h6M9 15.5h4",
  move: "M12 3.5v17M3.5 12h17M12 3.5 9.5 6M12 3.5 14.5 6M12 20.5 9.5 18M12 20.5l2.5-2.5M3.5 12 6 9.5M3.5 12 6 14.5M20.5 12 18 9.5M20.5 12 18 14.5",
  check: "M5 12.5l4.5 4.5L19 7",
  info: "M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17ZM12 11v5.5M12 7.75v.01",
  "chevron-left": "M14.5 5.5 8 12l6.5 6.5",
  "chevron-right": "M9.5 5.5 16 12l-6.5 6.5",
  "chevron-down": "M5.5 9.5 12 16l6.5-6.5",
  seats: "M9 10.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM3.5 19.5a5.5 5.5 0 0 1 11 0M16 5.2a3 3 0 0 1 0 5.6M18 14.6a5.5 5.5 0 0 1 2.5 4.9",
  grid: "M4.5 4.5h6v6h-6v-6Zm9 0h6v6h-6v-6Zm-9 9h6v6h-6v-6Zm9 0h6v6h-6v-6Z",
  list: "M4.5 6.5h15M4.5 12h15M4.5 17.5h15",
  layers: "M12 3.5 3.5 8l8.5 4.5L20.5 8 12 3.5ZM3.5 12.5 12 17l8.5-4.5M3.5 16.5 12 21l8.5-4.5",
  bag: "M5 8h14l-1 11.5a2 2 0 0 1-2 1.5H8a2 2 0 0 1-2-1.5L5 8Zm4 0V6.5a3 3 0 0 1 6 0V8",
};

export function Glyph({
  name,
  size = 18,
  className,
  strokeWidth = 1.6,
}: {
  name: GlyphName;
  size?: number;
  className?: string;
  strokeWidth?: number;
}) {
  const d = GLYPHS[name];
  if (!d) return null;
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
      focusable="false"
    >
      <path d={d} />
    </svg>
  );
}

/** Every name, for the test that asserts each one actually draws something. */
export const GLYPH_NAMES = Object.keys(GLYPHS) as GlyphName[];
