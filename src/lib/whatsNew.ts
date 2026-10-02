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
export const WHATS_NEW_VERSION = "1.0.31";

const SEEN_KEY = "whatsNewSeenVersion";

export type WhatsNewPage = { glyph: GlyphName; title: string; body: string };

// One short, business-worded page per shipped POS capability in this release. No
// developer terminology; icons come from the existing Glyph set.
export const WHATS_NEW_PAGES: WhatsNewPage[] = [
  {
    glyph: "kitchen",
    title: "Recorded Reasons for Changes",
    body: "When you reduce or remove an item from a sent dine-in order, note a quick reason. It's kept on the bill's history so every change is accounted for.",
  },
  {
    glyph: "analytics",
    title: "Deletions & Reductions Report",
    body: "A new section in Analytics lists every removal, reduction and modifier change — with who made it, when, and why — so nothing is a mystery at close.",
  },
  {
    glyph: "pos",
    title: "Faster Customer Lookup",
    body: "Open a customer account by name or phone, with clearer names shown across delivery and accounts so the right guest is easy to find.",
  },
  {
    glyph: "pos",
    title: "Merge Tables",
    body: "Combine two or more open dine-in tables into one bill when guests move together — the items and kitchen tickets follow, and the other tables free up.",
  },
  {
    glyph: "pos",
    title: "Merged Tables on the Floor",
    body: "The floor map now marks a table that has others merged into it, so staff can see at a glance which bill is the combined one.",
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
