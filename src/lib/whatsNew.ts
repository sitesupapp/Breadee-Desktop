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
export const WHATS_NEW_VERSION = "1.0.34";

const SEEN_KEY = "whatsNewSeenVersion";

export type WhatsNewPage = { glyph: GlyphName; title: string; body: string };

// One short, business-worded page per shipped POS capability in this release. No
// developer terminology; icons come from the existing Glyph set.
export const WHATS_NEW_PAGES: WhatsNewPage[] = [
  {
    glyph: "pos",
    title: "Transfer Open Orders Between Cashiers",
    body: "A cashier with open orders at the end of a shift can now hand them to another cashier. The receiving cashier approves to take them on, and a manager can re-approve from the website if a transfer was declined — so a shift is never blocked by orders that belong to someone else.",
  },
  {
    glyph: "pos",
    title: "Clearer End-of-Shift Reporting",
    body: "The End Shift report now lists items that were reduced or removed from submitted orders — with the quantity before, after and removed, the reason, and who made the change — shown separately from voided or cancelled orders.",
  },
  {
    glyph: "pos",
    title: "Reduction Receipts & Accurate Reprints",
    body: "Optionally print a receipt whenever a submitted item is reduced or cancelled (a per-terminal setting). Reprints now always show the real payment method used — a non-cash payment never prints as Cash.",
  },
  {
    glyph: "pos",
    title: "Manage Payment Methods & Cashier Layout",
    body: "Add, edit and activate your own POS payment methods from Settings, and the Categorized-menu control now lives with the Cashier Layout options. Everyday behavior and your existing records are unchanged.",
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
