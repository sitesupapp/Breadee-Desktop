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
export const WHATS_NEW_VERSION = "1.0.32";

const SEEN_KEY = "whatsNewSeenVersion";

export type WhatsNewPage = { glyph: GlyphName; title: string; body: string };

// One short, business-worded page per shipped POS capability in this release. No
// developer terminology; icons come from the existing Glyph set.
export const WHATS_NEW_PAGES: WhatsNewPage[] = [
  {
    glyph: "pos",
    title: "Better Dine-In Table Control",
    body: "Tables can now be selected normally using either a mouse or a touchscreen — a click and a tap behave the same. Dragging still pans the floor, and a drag no longer opens a table by accident.",
  },
  {
    glyph: "pos",
    title: "More Role Controls",
    body: "Merge Tables, Split Bill, Payouts, Payment Methods and Analytics can now be configured for your team in Roles & Permissions. New permissions stay off until an owner or admin turns them on.",
  },
  {
    glyph: "analytics",
    title: "Payout Visibility",
    body: "Cash-drawer payouts now appear with their linked Expense, Purchase Invoice, Supplier Payment or Maintenance job on the website, so the record is easy to find. The document's own paid status is unchanged.",
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
