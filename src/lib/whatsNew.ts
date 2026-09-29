// What's New — a once-per-version, in-app highlight of the release. Shown after an
// update + relaunch, exactly once for the version below; a per-version "seen" flag is
// kept in localStorage (wrapped so a private window / cleared storage never throws and
// simply shows it again). No network, no server state — purely a local courtesy.

import type { GlyphName } from "@/components/Glyph";

/**
 * The version these pages describe. Bump alongside package.json/tauri.conf when the
 * What's New content changes; the flow reappears once when it no longer matches the
 * stored "seen" version. Kept as its own constant so the gate is explicit and testable.
 */
export const WHATS_NEW_VERSION = "1.0.30";

const SEEN_KEY = "whatsNewSeenVersion";

export type WhatsNewPage = { glyph: GlyphName; title: string; body: string };

// One short, business-worded page per major POS capability in this release. No
// developer terminology; icons come from the existing Glyph set.
export const WHATS_NEW_PAGES: WhatsNewPage[] = [
  {
    glyph: "kitchen",
    title: "Faster Dine-In Editing",
    body: "Adjust item quantities and modifiers on an open dine-in order in place — no need to void and start over. Changes flow straight to the kitchen.",
  },
  {
    glyph: "pay",
    title: "Split Bills",
    body: "Let guests pay separately. Choose which items go on each split, take the payment, and the table closes automatically once everything is settled.",
  },
  {
    glyph: "cash-out",
    title: "Flexible Payment Methods",
    body: "Create and rename your own payment methods and choose which show at checkout. Cash stays protected and always available.",
  },
  {
    glyph: "drawer",
    title: "Clearer End of Shift",
    body: "See takings split into cash and non-cash, with any cash payouts subtracted — so the expected drawer is right the first time.",
  },
  {
    glyph: "pos",
    title: "Faster Table Opening",
    body: "Turn on Auto-Seat to jump straight to the order screen when you open a table, saving a tap on every order.",
  },
  {
    glyph: "cash-out",
    title: "Payouts",
    body: "Record cash paid out of the drawer for an expense, purchase, or supplier — linked to the business record, reflected in the drawer, and reversible.",
  },
  {
    glyph: "analytics",
    title: "Analytics + PDF",
    body: "Track sales trends, top items, and payment breakdowns from the new Analytics menu, and export a polished PDF report in one click.",
  },
];

/** True when the current version's What's New has not yet been dismissed on this device. */
export function shouldShowWhatsNew(): boolean {
  try {
    return window.localStorage.getItem(SEEN_KEY) !== WHATS_NEW_VERSION;
  } catch {
    // No storage (private window / blocked): show it; dismissing simply won't persist.
    return true;
  }
}

/** Persist that the current version's What's New has been seen. Never throws. */
export function markWhatsNewSeen(): void {
  try {
    window.localStorage.setItem(SEEN_KEY, WHATS_NEW_VERSION);
  } catch {
    /* storage unavailable — the flow will show again next launch, which is acceptable */
  }
}
