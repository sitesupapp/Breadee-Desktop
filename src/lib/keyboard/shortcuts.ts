// The POS keyboard model.
//
// Design rules:
//  * Nothing here shadows a destructive or standard Windows/Chromium binding
//    (Alt+F4, Ctrl+W/T/N/R, F5) - those are deliberately absent.
//  * A shortcut never fires while the user is typing in a field, EXCEPT the ones
//    marked `worksInInput` (Escape, F-keys, Ctrl+Enter), so search-as-you-type
//    can never trigger an action.
//  * Every binding is declared once, in this table, so the help sheet (F1) and
//    the runtime handler can never disagree.

export type ShortcutId =
  | "help"
  | "newOrder"
  | "search"
  | "openPayment"
  | "confirmPayment"
  | "ordersList"
  | "holdOrder"
  | "routeTakeaway"
  | "routeDineIn"
  | "routeDelivery"
  | "prevCategory"
  | "nextCategory"
  | "lineUp"
  | "lineDown"
  | "qtyUp"
  | "qtyDown"
  | "removeLine"
  | "openShift"
  | "endShift"
  | "print"
  | "closeModal"
  | "fullscreen"
  // Dine-In (Levels 2A-2C). All of these are LIVE as of Level 2C. Vertical
  // movement reuses the shared `lineUp`/`lineDown` ids, and Ctrl+Enter reuses
  // `confirmPayment` (see its spec below). The three table operations open a
  // confirmation rather than acting, so no chord alone can move or void a bill.
  | "tableMap"
  | "tableSearch"
  | "tableLeft"
  | "tableRight"
  | "tableOpen"
  | "addItems"
  | "moveTable"
  | "closeTable"
  | "clearTable";

export type ShortcutGroup = "Order" | "Navigation" | "Cart" | "Shift" | "Window" | "Dine-in";

export type ShortcutSpec = {
  id: ShortcutId;
  /** `event.key` values that trigger this binding (case-insensitive for letters). */
  keys: string[];
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  label: string;
  group: ShortcutGroup;
  /** Human-readable combo for the help sheet. */
  display: string;
  /** Allowed to fire while focus is inside an input/textarea. */
  worksInInput?: boolean;
};

export const SHORTCUTS: ShortcutSpec[] = [
  { id: "help", keys: ["F1"], label: "Shortcut help", group: "Window", display: "F1", worksInInput: true },
  { id: "newOrder", keys: ["F2"], label: "New order", group: "Order", display: "F2", worksInInput: true },
  // F4 is shared by Takeaway and Dine-in, and in BOTH it only opens the payment
  // dialog - it never charges. Which one it opens is decided by the active mode,
  // the same convention as lineUp/lineDown and Ctrl+Enter.
  { id: "openPayment", keys: ["F4"], label: "Open payment (order or table)", group: "Order", display: "F4", worksInInput: true },
  { id: "ordersList", keys: ["F6"], label: "Orders list", group: "Order", display: "F6", worksInInput: true },
  { id: "holdOrder", keys: ["F7"], label: "Hold order", group: "Order", display: "F7", worksInInput: true },
  {
    // Shared id, same convention as lineUp/lineDown: ONE binding, and the active
    // screen decides what it confirms. The payment dialog registers it while
    // open; Dine-in Add Items registers it to send the round; Delivery Add Items
    // registers it to send the delivery order. They never coexist - no payment
    // dialog is reachable from either Add Items screen, and Delivery has no
    // payment path at all.
    id: "confirmPayment",
    keys: ["Enter"],
    ctrl: true,
    label: "Confirm payment / Submit round / Send delivery order",
    group: "Order",
    display: "Ctrl+Enter",
    worksInInput: true,
  },
  { id: "search", keys: ["k"], ctrl: true, label: "Search the menu", group: "Navigation", display: "Ctrl+K" },
  { id: "search", keys: ["/"], label: "Search the menu", group: "Navigation", display: "/" },
  { id: "routeTakeaway", keys: ["1"], alt: true, label: "Takeaway", group: "Navigation", display: "Alt+1", worksInInput: true },
  { id: "routeDineIn", keys: ["2"], alt: true, label: "Dine-in", group: "Navigation", display: "Alt+2", worksInInput: true },
  { id: "routeDelivery", keys: ["3"], alt: true, label: "Delivery", group: "Navigation", display: "Alt+3", worksInInput: true },
  { id: "prevCategory", keys: ["ArrowLeft"], alt: true, label: "Previous category", group: "Navigation", display: "Alt+Left", worksInInput: true },
  { id: "nextCategory", keys: ["ArrowRight"], alt: true, label: "Next category", group: "Navigation", display: "Alt+Right", worksInInput: true },
  // Vertical selection is shared: cart lines in Takeaway, table rows in Dine-in.
  // One binding per key - the active screen decides what it moves.
  { id: "lineUp", keys: ["ArrowUp"], label: "Move selection up (cart / tables)", group: "Cart", display: "Up" },
  { id: "lineDown", keys: ["ArrowDown"], label: "Move selection down (cart / tables)", group: "Cart", display: "Down" },
  { id: "qtyUp", keys: ["+", "="], label: "Increase quantity", group: "Cart", display: "+" },
  { id: "qtyDown", keys: ["-"], label: "Decrease quantity", group: "Cart", display: "-" },
  { id: "removeLine", keys: ["Delete"], label: "Remove line (undoable)", group: "Cart", display: "Delete" },
  { id: "openShift", keys: ["O"], ctrl: true, shift: true, label: "Open shift", group: "Shift", display: "Ctrl+Shift+O", worksInInput: true },
  { id: "endShift", keys: ["E"], ctrl: true, shift: true, label: "End shift", group: "Shift", display: "Ctrl+Shift+E", worksInInput: true },
  { id: "print", keys: ["p"], ctrl: true, label: "Receipt preview", group: "Order", display: "Ctrl+P", worksInInput: true },
  { id: "closeModal", keys: ["Escape"], label: "Close dialog", group: "Window", display: "Esc", worksInInput: true },
  { id: "fullscreen", keys: ["F11"], label: "Fullscreen", group: "Window", display: "F11", worksInInput: true },

  // --- Dine-in (Level 2A) -----------------------------------------------------
  { id: "tableMap", keys: ["m"], alt: true, label: "Back to the table map", group: "Dine-in", display: "Alt+M", worksInInput: true },
  { id: "tableSearch", keys: ["f"], ctrl: true, label: "Search tables", group: "Dine-in", display: "Ctrl+F" },
  { id: "tableLeft", keys: ["ArrowLeft"], label: "Previous table", group: "Dine-in", display: "Left" },
  { id: "tableRight", keys: ["ArrowRight"], label: "Next table", group: "Dine-in", display: "Right" },
  { id: "tableOpen", keys: ["Enter"], label: "Select / open the focused table", group: "Dine-in", display: "Enter" },

  // Live since Level 2B.
  { id: "addItems", keys: ["a"], label: "Add items to the selected table", group: "Dine-in", display: "A" },

  // Live since Level 2C. Each OPENS a confirmation - none performs the operation
  // directly, so a mistyped chord can never move or void a bill on its own.
  //
  // None of them is `worksInInput`. They carried that flag while they were
  // reserved placeholders, where it was harmless because nothing handled them.
  // Now that they open real dialogs it would be actively wrong: the operator
  // types into the table search box and into the Clear dialog's own reason
  // field, and a chord fired from inside either would stack a second
  // confirmation over the one they are already answering. Alt+M keeps the flag
  // because being the way OUT of a text field is its entire purpose.
  { id: "moveTable", keys: ["M"], ctrl: true, shift: true, label: "Move table", group: "Dine-in", display: "Ctrl+Shift+M" },
  // Close was Ctrl+Shift+C until Level 2C wired a handler to it. That chord is
  // the DevTools inspector in Chromium, which the Tauri webview inherits: the
  // shortcut would have been eaten in development and, with devtools enabled, in
  // the shipped app too. A binding that works on the developer's machine but not
  // the cashier's is worse than no binding, so Close moved to Alt+C.
  { id: "closeTable", keys: ["c"], alt: true, label: "Close table", group: "Dine-in", display: "Alt+C" },
  { id: "clearTable", keys: ["X"], ctrl: true, shift: true, label: "Clear table (voids the bill)", group: "Dine-in", display: "Ctrl+Shift+X" },
];

/**
 * Shortcut ids that are declared but intentionally have no handler yet.
 *
 * Empty since Level 2C: every declared dine-in binding now has a real handler.
 * The list stays as the seam for the next level's reservations - and the test
 * that reads it stays meaningful, because it asserts the list matches reality
 * rather than asserting a fixed set of names.
 */
export const RESERVED_SHORTCUTS: ShortcutId[] = [];

/** Bindings we must never register, kept explicit so a future edit trips the test. */
export const FORBIDDEN_COMBOS = ["Alt+F4", "Ctrl+W", "Ctrl+T", "Ctrl+N", "Ctrl+R", "F5"];

/**
 * Duck-typed rather than `instanceof HTMLElement` so the matcher stays pure and
 * testable outside a DOM - and so it keeps working for a target from another
 * document/realm, where `instanceof` silently returns false.
 */
export function isTypingTarget(target: EventTarget | null | undefined): boolean {
  if (!target || typeof target !== "object") return false;
  const el = target as { tagName?: unknown; isContentEditable?: unknown };
  const tag = typeof el.tagName === "string" ? el.tagName.toUpperCase() : "";
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable === true;
}

/** Resolve a keyboard event to a shortcut id, or null when nothing matches. */
export function matchShortcut(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  target?: EventTarget | null;
}): ShortcutId | null {
  const typing = isTypingTarget(event.target ?? null);
  const ctrl = event.ctrlKey || event.metaKey;
  for (const s of SHORTCUTS) {
    if (!s.keys.some((k) => k.toLowerCase() === event.key.toLowerCase())) continue;
    if (Boolean(s.ctrl) !== ctrl) continue;
    if (Boolean(s.shift) !== event.shiftKey) continue;
    if (Boolean(s.alt) !== event.altKey) continue;
    if (typing && !s.worksInInput) continue;
    return s.id;
  }
  return null;
}

/** Deduplicated list for the help sheet, grouped for display. */
export function shortcutHelp(): { group: ShortcutGroup; items: { display: string; label: string }[] }[] {
  const groups: ShortcutGroup[] = ["Order", "Cart", "Navigation", "Dine-in", "Shift", "Window"];
  return groups.map((group) => ({
    group,
    items: SHORTCUTS.filter((s) => s.group === group).map((s) => ({ display: s.display, label: s.label })),
  }));
}
